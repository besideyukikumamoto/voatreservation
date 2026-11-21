/**
 * generateScheduleImage.js
 * スプレッドシート「予約状況」（隈元先生専用シート）からセル・結合・背景色を直接取得し、
 * Playwright Chromium で余白ゼロ・文字潰れゼロの超高精細Retina PNG画像を生成、
 * 高速CDNへアップロードして「LINE配信設定」シートの B6:C6 セルへ自動反映するモジュール。
 *
 * Macローカル / GitHub Actions (Ubuntu 24.04) 両対応。
 *
 * CLIオプション:
 *   --dry-run                CDNアップロードおよびシート更新を行わずPNG生成のみ実行
 *   --next-day               基準日を翌日(JST)として生成（日曜の事前点検用）
 *   --base-date=YYYY-MM-DD   任意の基準日を指定して生成（テスト用）
 *   --out=/path/to/out.png   PNG出力先パスを指定
 */

const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const { chromium } = require("playwright");

const DEFAULT_SPREADSHEET_ID = "1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4";
const FREEIMAGE_API_KEY = "6d207e02198a847aa98d0a2a901485a5";

function getJstNow(offsetDays = 0, baseDateStr = null) {
  if (baseDateStr) {
    const m = baseDateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) throw new Error(`不正な --base-date 形式です: ${baseDateStr}`);
    return {
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      day: parseInt(m[3], 10),
      hour: 12,
      minute: 0
    };
  }
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes()
  };
}

function rgbToHex(colorObj, fallback = "#ffffff") {
  if (!colorObj || (colorObj.red === undefined && colorObj.green === undefined && colorObj.blue === undefined)) {
    return fallback;
  }
  const r = Math.round((colorObj.red || 0) * 255);
  const g = Math.round((colorObj.green || 0) * 255);
  const b = Math.round((colorObj.blue || 0) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCellTextHtml(rawText, colCount) {
  const t = String(rawText || "").trim();
  if (!t) return "";
  // 「予約済み」は列が多いときに縦2行で読みやすく改行
  if (t === "予約済み") {
    return colCount >= 18 ? "予約<br>済み" : "予約済み";
  }
  // GROUP テキストの視認性最適化（中途半端な文字切れを防止）
  if (t.includes("GROUP")) {
    const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines
      .map((line, idx) => {
        if (idx === 0 && line.toUpperCase() === "GROUP") {
          return `<span class="grp-tag">GROUP</span>`;
        }
        let formatted = escapeHtml(line);
        if (formatted === "レコーディング講座") {
          formatted = colCount >= 23 ? "レコー<br>ディング<br>講座" : "レコーディング<br>講座";
        } else if (formatted === "基礎発声トレーニング") {
          formatted = colCount >= 23 ? "基礎発声<br>トレー<br>ニング" : "基礎発声<br>トレーニング";
        } else if (formatted === "レコスタ歌唱") {
          formatted = colCount >= 18 ? "レコスタ<br>歌唱" : "レコスタ歌唱";
        }
        return `<span class="grp-name">${formatted}</span>`;
      })
      .join("<br>");
  }
  return escapeHtml(t).replace(/\r?\n/g, "<br>");
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    // ローカルMacでPlaywright専用バイナリが無い場合はシステムChromeを使用
    return await chromium.launch({ headless: true, channel: "chrome" });
  }
}

function buildScheduleHtml({
  targetYear,
  targetMonth,
  startColDate,
  targetLastDay,
  grid,
  merges,
  selectedCols,
  generatedLabel
}) {
  const dayCount = selectedCols.length - 1; // A列を除いた日数

  // 日数に応じて1列の幅・フォントサイズを動的に最適化（余白ゼロ＆文字潰れゼロ）
  let timeColW, dayColW, baseFontSize, grpFontSize, headerFontSize, rowHeight;
  if (dayCount <= 10) {
    timeColW = 92;
    dayColW = 112;
    baseFontSize = 16;
    grpFontSize = 13;
    headerFontSize = 18;
    rowHeight = 40;
  } else if (dayCount <= 15) {
    timeColW = 86;
    dayColW = 94;
    baseFontSize = 14;
    grpFontSize = 11;
    headerFontSize = 16;
    rowHeight = 38;
  } else if (dayCount <= 22) {
    timeColW = 80;
    dayColW = 68;
    baseFontSize = 13;
    grpFontSize = 11;
    headerFontSize = 15;
    rowHeight = 36;
  } else {
    // 翌月全日（28〜31日）
    timeColW = 76;
    dayColW = 56;
    baseFontSize = 12;
    grpFontSize = 10;
    headerFontSize = 14;
    rowHeight = 35;
  }

  const totalTableW = timeColW + dayColW * dayCount;
  const colIndexMap = new Map();
  selectedCols.forEach((origCol, newIdx) => colIndexMap.set(origCol, newIdx));

  // 有効行数（A列に時間が入っている最終行まで、最低でも22行程度）
  let numRows = grid.length;
  while (numRows > 2) {
    const rowVals = grid[numRows - 1]?.values || [];
    const hasContent = selectedCols.some(c => {
      const cell = rowVals[c];
      return cell && (cell.formattedValue || "").trim() !== "";
    });
    if (hasContent) break;
    numRows--;
  }

  // マージ領域マップ構築（抽出後の座標系にマッピング）
  const mergeStart = new Map(); // "r,newC" -> { rowspan, colspan }
  const mergeCovered = new Set(); // "r,newC"

  for (const m of merges) {
    const r1 = m.startRowIndex;
    const r2 = Math.min(m.endRowIndex, numRows);
    const c1 = m.startColumnIndex;
    const c2 = m.endColumnIndex;
    if (r1 >= numRows) continue;

    // 抽出対象列と重なる範囲のみ採用
    const matchedNewCols = [];
    for (let c = c1; c < c2; c++) {
      if (colIndexMap.has(c)) matchedNewCols.push(colIndexMap.get(c));
    }
    if (matchedNewCols.length === 0) continue;

    const newC1 = matchedNewCols[0];
    const colspan = matchedNewCols.length;
    const rowspan = r2 - r1;
    if (rowspan <= 1 && colspan <= 1) continue;

    mergeStart.set(`${r1},${newC1}`, { rowspan, colspan, origR: r1, origC: c1 });
    for (let r = r1; r < r2; r++) {
      for (let nc = newC1; nc < newC1 + colspan; nc++) {
        if (r === r1 && nc === newC1) continue;
        mergeCovered.add(`${r},${nc}`);
      }
    }
  }

  // テーブルHTML組み立て
  const rowsHtml = [];
  for (let r = 0; r < numRows; r++) {
    const rowData = grid[r]?.values || [];
    const cellsHtml = [];

    for (let newC = 0; newC < selectedCols.length; newC++) {
      const key = `${r},${newC}`;
      if (mergeCovered.has(key)) continue;

      const origC = selectedCols[newC];
      const mergeInfo = mergeStart.get(key);
      const cell = mergeInfo
        ? (grid[mergeInfo.origR]?.values?.[mergeInfo.origC] || rowData[origC] || {})
        : (rowData[origC] || {});

      const val = (cell.formattedValue || "").trim();
      const fmt = cell.effectiveFormat || {};
      const bg = rgbToHex(fmt.backgroundColor, "#ffffff");
      const fg = rgbToHex(fmt.textFormat?.foregroundColor, "#111111");

      let attrs = "";
      if (mergeInfo) {
        if (mergeInfo.rowspan > 1) attrs += ` rowspan="${mergeInfo.rowspan}"`;
        if (mergeInfo.colspan > 1) attrs += ` colspan="${mergeInfo.colspan}"`;
      }

      const classes = [];
      let styleBg = bg;
      let styleFg = fg;

      if (r === 0 || r === 1) {
        classes.push("hdr-cell");
        if (newC === 0) classes.push("time-hdr");
        if (r === 0 && val === "土") {
          styleBg = "#e8f0fe";
          styleFg = "#1a56db";
        } else if (r === 0 && val === "日") {
          styleBg = "#fde8e8";
          styleFg = "#c81e1e";
        } else if (r === 1) {
          const wd = (grid[0]?.values?.[origC]?.formattedValue || "").trim();
          if (wd === "土") {
            styleBg = "#e8f0fe";
            styleFg = "#1a56db";
          } else if (wd === "日") {
            styleBg = "#fde8e8";
            styleFg = "#c81e1e";
          }
        }
      } else if (newC === 0) {
        classes.push("time-col");
        styleBg = "#f3f4f6";
        styleFg = "#1f2937";
      } else {
        classes.push("slot-cell");
        if (val === "予約済み") {
          classes.push("booked-cell");
          // 背景色が白または土日の淡色なら維持、文字はクッキリ濃色
          styleFg = "#111827";
        } else if (val.includes("GROUP")) {
          classes.push("group-cell");
          styleBg = "#c9daf8";
          styleFg = "#0f295c";
        } else if (bg.toLowerCase() === "#d9d9d9" || bg.toLowerCase() === "#cccccc" || bg.toLowerCase() === "#efefef") {
          classes.push("off-cell");
          styleBg = "#d4d4d8";
        }
      }

      // 1時間ごとの区切り線を少し強調（11:00, 12:00, ... は偶数行 r=2,4,6... の上または奇数行 r=3,5... の下）
      if (r >= 2 && r % 2 === 1 && !mergeInfo) {
        classes.push("hour-bottom");
      } else if (mergeInfo && (r + mergeInfo.rowspan - 1) % 2 === 1) {
        classes.push("hour-bottom");
      }

      const innerHtml = (r <= 1 || newC === 0)
        ? escapeHtml(val)
        : formatCellTextHtml(val, dayCount);

      cellsHtml.push(
        `<td${attrs} class="${classes.join(" ")}" style="background:${styleBg};color:${styleFg};">${innerHtml}</td>`
      );
    }

    const trClass = r === 0 ? "row-weekday" : r === 1 ? "row-day" : "row-slot";
    rowsHtml.push(`<tr class="${trClass}">${cellsHtml.join("")}</tr>`);
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500;700;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #ffffff;
    font-family: "Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
    display: inline-block;
    padding: 20px 24px 22px 24px;
    -webkit-font-smoothing: antialiased;
  }
  .wrapper {
    width: ${totalTableW}px;
  }
  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 3px solid #1f4e78;
    gap: 12px;
    flex-wrap: wrap;
  }
  .title-block {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title-accent {
    display: inline-block;
    width: 6px;
    height: ${Math.max(22, headerFontSize + 6)}px;
    background: #1f4e78;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .title-main {
    font-size: ${Math.max(20, headerFontSize + 5)}px;
    font-weight: 900;
    color: #111827;
    letter-spacing: 0.02em;
  }
  .title-sub {
    font-size: ${Math.max(13, baseFontSize - 1)}px;
    font-weight: 700;
    color: #4b5563;
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: ${Math.max(12, baseFontSize - 2)}px;
    font-weight: 700;
    color: #374151;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .swatch {
    display: inline-block;
    width: 15px;
    height: 15px;
    border: 1.5px solid #4b5563;
    border-radius: 3px;
  }
  .swatch-open { background: #ffffff; }
  .swatch-off { background: #d4d4d8; }
  .swatch-grp { background: #c9daf8; }

  table {
    width: ${totalTableW}px;
    border-collapse: collapse;
    table-layout: fixed;
    border: 2px solid #1f2937;
  }
  col.col-time { width: ${timeColW}px; }
  col.col-day  { width: ${dayColW}px; }

  td {
    border: 1px solid #9ca3af;
    text-align: center;
    vertical-align: middle;
    padding: 2px 3px;
    overflow: hidden;
  }
  .row-weekday td {
    height: 34px;
    font-size: ${headerFontSize}px;
    font-weight: 900;
    border-bottom: 1px solid #9ca3af;
  }
  .row-day td {
    height: 34px;
    font-size: ${headerFontSize}px;
    font-weight: 900;
    border-bottom: 2px solid #1f2937;
  }
  td.time-hdr {
    font-size: ${Math.max(13, baseFontSize)}px;
    font-weight: 900;
    background: #e5e7eb !important;
    color: #111827 !important;
    white-space: nowrap;
    border-right: 2px solid #1f2937;
    border-bottom: 2px solid #1f2937;
  }
  td.time-col {
    height: ${rowHeight}px;
    font-size: ${baseFontSize}px;
    font-weight: 700;
    white-space: nowrap;
    border-right: 2px solid #1f2937;
  }
  td.slot-cell {
    height: ${rowHeight}px;
    font-size: ${baseFontSize}px;
    line-height: 1.2;
  }
  td.booked-cell {
    font-weight: 700;
    font-size: ${baseFontSize}px;
    letter-spacing: -0.02em;
  }
  td.group-cell {
    font-weight: 700;
    font-size: ${grpFontSize}px;
    line-height: 1.22;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }
  .grp-tag {
    display: inline-block;
    font-size: ${Math.max(9, grpFontSize - 1)}px;
    font-weight: 900;
    letter-spacing: 0.03em;
    color: #1e40af;
  }
  .grp-name {
    font-weight: 700;
  }
  td.hour-bottom {
    border-bottom: 1.5px solid #4b5563;
  }
  .footer-note {
    margin-top: 8px;
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 500;
    color: #6b7280;
  }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="top-bar">
      <div class="title-block">
        <span class="title-accent"></span>
        <span class="title-main">${targetYear}年${targetMonth}月 予約状況（${targetMonth}/${startColDate}〜${targetMonth}/${targetLastDay}）</span>
        <span class="title-sub">VOAT福岡校 隈元</span>
      </div>
      <div class="legend">
        <span class="legend-item"><span class="swatch swatch-open"></span>白枠：予約可能</span>
        <span class="legend-item"><span class="swatch swatch-off"></span>グレー：お休み</span>
        <span class="legend-item"><span class="swatch swatch-grp"></span>青：GROUP</span>
      </div>
    </div>
    <table>
      <colgroup>
        <col class="col-time">
        ${Array.from({ length: dayCount }, () => '<col class="col-day">').join("")}
      </colgroup>
      <tbody>
        ${rowsHtml.join("\n")}
      </tbody>
    </table>
    <div class="footer-note">
      <span>※空欄（白枠）がご予約可能な時間帯です。WEB予約は前日23:59まで受付中</span>
      <span>更新: ${escapeHtml(generatedLabel)}</span>
    </div>
  </div>
</body>
</html>`;
}

async function generateAndUploadScheduleImage(options = {}) {
  const {
    dryRun = false,
    nextDay = false,
    baseDate = null,
    outPath = "/tmp/voat_schedule_retina.png",
    spreadsheetId = process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
    serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(__dirname, "..", "service-account.json")
  } = options;

  console.log("🚀 最新予約状況表の超高精細Retina PNG生成を開始します...");

  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const nowJst = getJstNow(0);
  const baseJst = getJstNow(nextDay ? 1 : 0, baseDate);

  const currentYear = baseJst.year;
  const currentMonth = baseJst.month;
  const todayDate = baseJst.day;

  const lastDayOfCurrentMonth = new Date(currentYear, currentMonth, 0).getDate();
  const tomorrowDate = todayDate + 1;

  let isNextMonth = false;
  let targetYear = currentYear;
  let targetMonth = currentMonth;
  let startColDate = tomorrowDate;

  // 月末（26日以降、または翌日以降の当月枠がない場合）は翌月1日〜末日に切り替え
  if (todayDate >= 26 || tomorrowDate > lastDayOfCurrentMonth) {
    isNextMonth = true;
    targetMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    targetYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    startColDate = 1;
  }

  const targetLastDay = new Date(targetYear, targetMonth, 0).getDate();
  const targetSheetTitle = `${targetYear}年 ${targetMonth}月`;
  const fallbackSheetTitle = `${targetYear}年${targetMonth}月`;

  console.log(`📅 基準日: ${currentYear}/${currentMonth}/${todayDate} → 対象期間: ${targetYear}年${targetMonth}月 (${startColDate}日〜${targetLastDay}日)`);

  // 1. シート一覧を取得して隈元先生専用シートを特定
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = meta.data.sheets.find(s => s.properties.title === targetSheetTitle);
  if (!sheet) {
    sheet = meta.data.sheets.find(s => s.properties.title === (isNextMonth ? "【閲覧用】翌月" : "【閲覧用】今月"));
  }
  if (!sheet) {
    sheet = meta.data.sheets.find(s =>
      s.properties.title === fallbackSheetTitle ||
      s.properties.title === "【閲覧用】当月" ||
      s.properties.title === `${targetMonth}月`
    );
  }
  if (!sheet) throw new Error(`対象シート「${targetSheetTitle}」が見つかりません。`);

  const actualTitle = sheet.properties.title;
  console.log(`📄 参照シート: 「${actualTitle}」`);

  // 2. セル値・書式・結合情報を一括取得（一時シート不要！）
  const gridRes = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${actualTitle}'!A1:AF30`],
    includeGridData: true
  });
  const sheetData = gridRes.data.sheets[0];
  const grid = sheetData.data[0].rowData || [];
  const merges = sheetData.merges || [];

  // 2行目（index=1）から日付列を動的特定
  const row2Vals = grid[1]?.values || [];
  const selectedCols = [0]; // A列（開始時間）
  for (let c = 1; c < row2Vals.length; c++) {
    const num = parseInt((row2Vals[c]?.formattedValue || "").trim(), 10);
    if (!isNaN(num) && num >= startColDate && num <= targetLastDay) {
      selectedCols.push(c);
    }
  }
  if (selectedCols.length <= 1) {
    throw new Error(`対象期間（${startColDate}日〜${targetLastDay}日）の列がシート「${actualTitle}」から見つかりません。`);
  }

  const generatedLabel = `${nowJst.year}/${String(nowJst.month).padStart(2, "0")}/${String(nowJst.day).padStart(2, "0")} ${String(nowJst.hour).padStart(2, "0")}:${String(nowJst.minute).padStart(2, "0")}`;

  const html = buildScheduleHtml({
    targetYear,
    targetMonth,
    startColDate,
    targetLastDay,
    grid,
    merges,
    selectedCols,
    generatedLabel
  });

  // 3. Playwright Chromium で超高精細Retinaレンダリング（出力幅が約2,400〜2,800pxになるようスケール自動調整）
  const dayCount = selectedCols.length - 1;
  const scaleFactor = dayCount <= 10 ? 2.5 : dayCount <= 18 ? 2.0 : 1.5;

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 2400, height: 1600 },
      deviceScaleFactor: scaleFactor
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    // フォントロード完了を待機
    await page.evaluate(() => document.fonts ? document.fonts.ready : Promise.resolve());

    const bodyEl = await page.$("body");
    await bodyEl.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }

  const pngSize = fs.statSync(outPath).size;
  // PNGヘッダーから実解像度を読み取る
  const buf = fs.readFileSync(outPath);
  const pxW = buf.readUInt32BE(16);
  const pxH = buf.readUInt32BE(20);
  console.log(`✅ 超高精細PNG生成完了: ${outPath} (${pxW}x${pxH} px / ${Math.round(pngSize / 1024)} KB)`);

  if (dryRun) {
    console.log("🧪 --dry-run モードのためアップロードとシート更新をスキップしました。");
    return {
      success: true,
      dryRun: true,
      outPath,
      width: pxW,
      height: pxH,
      targetPeriod: `${targetMonth}/${startColDate}〜${targetMonth}/${targetLastDay}`
    };
  }

  // 4. 高速CDN（freeimage.host / iili.io）へアップロード
  console.log("☁️ 高速CDNへ画像をアップロード中...");
  const b64 = buf.toString("base64");
  const uploadData = new URLSearchParams({
    key: FREEIMAGE_API_KEY,
    action: "upload",
    source: b64,
    format: "json"
  }).toString();

  const uploadRes = await fetch("https://freeimage.host/api/1/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0"
    },
    body: uploadData
  });
  const resJson = await uploadRes.json();
  if (!resJson || !resJson.image || !resJson.image.url) {
    throw new Error("CDNアップロードに失敗しました: " + JSON.stringify(resJson));
  }

  const highResUrl = resJson.image.url;

  // アップロードURLの疎通検証
  const verifyRes = await fetch(highResUrl, { method: "HEAD" });
  if (!verifyRes.ok) {
    throw new Error(`アップロード画像の死活確認に失敗: HTTP ${verifyRes.status}`);
  }
  console.log(`🎉 超高精細画像の公開URL取得＆検証完了: ${highResUrl}`);

  // 5. 「LINE配信設定」シートの B6:C6 セルへ自動反映
  const settingSheet = meta.data.sheets.find(s => s.properties.title === "LINE配信設定");
  if (settingSheet) {
    const valRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "LINE配信設定!A1:B15"
    });
    const rows = valRes.data.values || [];
    let targetRowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && String(rows[i][0]).includes("最新高画質予約表画像URL")) {
        targetRowIndex = i + 1;
        break;
      }
    }

    if (targetRowIndex !== -1) {
      const metaText = `${generatedLabel} 生成 (${targetMonth}/${startColDate}〜${targetMonth}/${targetLastDay} / ${pxW}x${pxH}px)`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `LINE配信設定!B${targetRowIndex}:C${targetRowIndex}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[highResUrl, metaText]] }
      });
      console.log(`✅ 「LINE配信設定」シート B${targetRowIndex}:C${targetRowIndex} を更新しました: ${metaText}`);
    }
  }

  return {
    success: true,
    imageUrl: highResUrl,
    width: pxW,
    height: pxH,
    targetPeriod: `${targetMonth}/${startColDate}〜${targetMonth}/${targetLastDay}`
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const nextDay = args.includes("--next-day");
  const baseDateArg = args.find(a => a.startsWith("--base-date="));
  const outArg = args.find(a => a.startsWith("--out="));

  generateAndUploadScheduleImage({
    dryRun,
    nextDay,
    baseDate: baseDateArg ? baseDateArg.split("=")[1] : null,
    outPath: outArg ? outArg.split("=")[1] : "/tmp/voat_schedule_retina.png"
  })
    .then(res => {
      console.log("✨ 完了:", res);
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ エラー:", err);
      process.exit(1);
    });
}

module.exports = { generateAndUploadScheduleImage };
