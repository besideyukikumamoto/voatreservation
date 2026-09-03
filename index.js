require('dotenv').config();
const { chromium } = require('playwright');
const { google } = require('googleapis');

const VOAT_SYNC_MARKER = '[VOAT-SYNC]';
const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4';

// 時間スロットの定義 (11:00 〜 21:30, 22スロット)
const START_H = 11;
const END_H = 21;
const TIME_SLOTS = [];
for (let h = START_H; h <= END_H; h++) {
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:00`);
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:30`);
}

// 色の定義 (RGB 0.0〜1.0)
const COLOR_WHITE = { red: 1.0, green: 1.0, blue: 1.0 };
const COLOR_SAT = { red: 0.93333334, green: 0.95686275, blue: 1.0 };      // #eef4ff
const COLOR_SUN = { red: 1.0, green: 0.9490196, blue: 0.9490196 };        // #fff2f2
const COLOR_GROUP = { red: 0.7882353, green: 0.85490197, blue: 0.972549 }; // #c9daf8
const COLOR_OFF = { red: 0.8509804, green: 0.8509804, blue: 0.8509804 };    // #d9d9d9 (休み)

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// 現在選択されている日付の稼働枠およびレッスン情報を抽出
async function extractCurrentDateReservations(page, expectedAriaLabel) {
  return await page.evaluate(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    let year = currentYear;
    const yearInput = document.querySelector('input.cur-year');
    if (yearInput && yearInput.value) {
      const parsed = parseInt(yearInput.value.trim(), 10);
      if (!isNaN(parsed) && parsed >= 2020 && parsed <= 2099) {
        year = parsed;
      }
    }

    const dateElement = document.querySelector('.pickup-date');
    const monthDay = dateElement ? dateElement.innerText.trim() : '';
    if (!monthDay) return { success: false, fullDate: '', openSlots: [], data: [] };

    // MM/DD または M/D を YYYY-MM-DD に正規化
    const parts = monthDay.split('/');
    if (parts.length !== 2) return { success: false, fullDate: '', openSlots: [], data: [] };
    const mNum = parseInt(parts[0].trim(), 10);
    const dNum = parseInt(parts[1].trim(), 10);
    if (isNaN(mNum) || isNaN(dNum)) return { success: false, fullDate: '', openSlots: [], data: [] };

    // 【年またぎガード】年末（11月・12月）に翌年（1月〜3月）のデータを処理している場合、
    // input.cur-year が前年のままでも確実に翌年（currentYear + 1）として扱う
    if (currentMonth >= 11 && mNum <= 3 && year <= currentYear) {
      year = currentYear + 1;
    }
    // 逆に年始（1月・2月）に前年（11月・12月）のデータを処理している場合
    if (currentMonth <= 2 && mNum >= 11 && year >= currentYear) {
      year = currentYear - 1;
    }

    const m = String(mNum).padStart(2, '0');
    const d = String(dNum).padStart(2, '0');
    const fullDate = `${year}-${m}-${d}`;

    const rows = document.querySelectorAll('table.sec tbody tr');
    rows.forEach(row => {
      const timeText = row.querySelector('.td-date')?.innerText.trim() || '';
      let startTime = '', endTime = '';
      
      // 様々な波ダッシュ・ハイフンに対応（~, 〜, ～, -）
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})\s*[-~〜～]\s*(\d{1,2}:\d{2})/);
      if (timeMatch) {
        startTime = timeMatch[1].trim();
        endTime = timeMatch[2].trim();
      } else if (timeText.includes('~')) {
        const timeParts = timeText.split('~');
        startTime = timeParts[0].trim();
        endTime = timeParts[1].trim();
      }
      if (!startTime || !endTime) return;

      // 【時間2桁ゼロ埋め】9:00 -> 09:00 に確実に正規化 (Calendar API 400エラー防止)
      startTime = startTime.split(':').map(p => p.trim().padStart(2, '0')).join(':');
      endTime = endTime.split(':').map(p => p.trim().padStart(2, '0')).join(':');

      // 30分刻みの稼働スロットを展開して openSlots に登録
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      let cur = sh * 60 + sm;
      const endMin = eh * 60 + em;
      while (cur < endMin) {
        const slotH = String(Math.floor(cur / 60)).padStart(2, '0');
        const slotM = String(cur % 60).padStart(2, '0');
        openSlots.push(`${slotH}:${slotM}`);
        cur += 30;
      }

      const studio = row.querySelector('.td-studio')?.innerText.trim().replace(/\n/g, ' ') || '';
      const lessonCell = row.querySelector('.td-lesson');
      if (!lessonCell) return;

      const typeEl = lessonCell.querySelector('.td-lesson-cat');
      const type = typeEl ? typeEl.innerText.trim() : '';
      
      // レッスン欄の全テキストを取得（PERSONAL/GROUP/EVENT も含む）
      let rawText = lessonCell.innerText.trim();
      if (!rawText || rawText === '受付中' || rawText === '予約可' || rawText === '空き') return; // 空き枠は予約データとしてはスキップ

      // 不要なボタンUIテキストを除去
      rawText = rawText
        .replace(/欠席フォロー動画を送信する\s*>>/g, '')
        .replace(/動画を送信する\s*>>/g, '')
        .replace(/\n+/g, ' ')       // 改行をスペースに
        .replace(/\s{2,}/g, ' ')     // 連続スペースを1つに
        .trim();

      if (!rawText) return;

      const title = rawText || 'レッスン';

      // 個別データも保持（description用）
      const bikouEls = lessonCell.querySelectorAll('.td-lesson-bikou');
      const content = bikouEls.length > 0 ? bikouEls[0].innerText.trim() : '';
      const studentEls = lessonCell.querySelectorAll('.td-lesson-student');
      const students = Array.from(studentEls).map(el => el.innerText.trim()).filter(Boolean);

      extractedData.push({ fullDate, startTime, endTime, studio, type, content, students, title });
    });
    return { success: true, fullDate, openSlots: Array.from(new Set(openSlots)), data: extractedData };
  });
}

// 現在表示中の月のすべての日付を取得（1日も漏らさず全走査）
async function getReservableDates(page) {
  return await page.evaluate(() => {
    const days = document.querySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)');
    return Array.from(days)
      .map(el => {
        const ariaLabel = el.getAttribute('aria-label') || '';
        const dayNumber = parseInt(el.textContent.trim(), 10);
        return { ariaLabel, dayNumber };
      })
      .filter(item => item.ariaLabel && !isNaN(item.dayNumber));
  });
}

// 日付のクリックとAjax/DOM描画完了の確実な待機
async function selectDateAndWait(page, selector, dayNumber) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.click(selector);

      // .pickup-date の日付（日番号）がクリック対象と一致するまで待機
      await page.waitForFunction((expectedDay) => {
        const pickupEl = document.querySelector('.pickup-date');
        if (!pickupEl) return false;
        const text = pickupEl.innerText.trim();
        const parts = text.split('/');
        if (parts.length !== 2) return false;
        const day = parseInt(parts[1], 10);
        return day === expectedDay;
      }, dayNumber, { timeout: 8000 });

      // テーブル描画の安定化のため少し待機
      await page.waitForTimeout(400);
      return true;
    } catch (e) {
      console.warn(`    ⚠️ 日付選択待機リトライ (${attempt}/3): day=${dayNumber}`);
      await page.waitForTimeout(1000);
    }
  }
  return false;
}

// 1ヶ月分の全日付を巡回してレッスン情報・稼働枠を取得
async function processMonth(page) {
  const monthData = [];
  const dates = await getReservableDates(page);
  if (dates.length === 0) return monthData;

  console.log(`  当月全 ${dates.length} 日を完全走査中...`);
  for (const item of dates) {
    const selector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)[aria-label="${item.ariaLabel}"]`;
    const ok = await selectDateAndWait(page, selector, item.dayNumber);
    if (!ok) {
      console.error(`  ❌ 日付の選択・描画待機に失敗しました: ${item.ariaLabel}`);
      continue;
    }

    const extractResult = await extractCurrentDateReservations(page, item.ariaLabel);
    if (extractResult && extractResult.success) {
      // 抽出された日付とクリックした日番号の整合性チェック（別日の誤抽出を100%遮断）
      const extractedDay = parseInt(extractResult.fullDate.split('-')[2], 10);
      if (extractedDay !== item.dayNumber) {
        console.warn(`  ⚠️ 日付不一致を検知 (期待: ${item.dayNumber}日, 取得: ${extractedDay}日) - スキップします`);
        continue;
      }

      monthData.push({
        fullDate: extractResult.fullDate,
        openSlots: extractResult.openSlots,
        reservations: extractResult.data,
      });

      if (extractResult.data.length > 0) {
        console.log(`    ✅ ${extractResult.fullDate} (${item.ariaLabel}): ${extractResult.data.length} 件のレッスン抽出 (稼働: ${extractResult.openSlots.length} 枠)`);
      } else {
        console.log(`    ℹ️ ${extractResult.fullDate} (${item.ariaLabel}): 予約0件 (稼働: ${extractResult.openSlots.length} 枠)`);
      }
    }
  }
  return monthData;
}

// スプレッドシートの指定シートにマトリックスデータを同期
async function syncMonthToSpreadsheet(sheets, spreadsheetId, targetSheetTitle, year, month, daysDataMap, metaSheets) {
  let targetSheet = metaSheets.find(s => s.properties.title === targetSheetTitle);
  let sheetId;

  const daysInMonth = new Date(year, month, 0).getDate();
  const reqCols = daysInMonth + 1; // A列(時間) + 1〜daysInMonth
  const reqRows = TIME_SLOTS.length + 2; // 1行目:曜日, 2行目:日付, 3〜24行目:データ (計24行)

  if (!targetSheet) {
    console.log(`  ➕ シート「${targetSheetTitle}」を新規作成します...`);
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: targetSheetTitle,
                gridProperties: {
                  rowCount: reqRows,
                  columnCount: reqCols,
                  frozenRowCount: 2,
                  frozenColumnCount: 1,
                },
              },
            },
          },
        ],
      },
    });
    sheetId = addRes.data.replies[0].addSheet.properties.sheetId;
  } else {
    sheetId = targetSheet.properties.sheetId;
  }

  console.log(`  📊 シート「${targetSheetTitle}」(ID: ${sheetId}) のマトリックス同期中...`);

  // ヘッダー行と時間列の準備
  const headerRow1 = [{ userEnteredValue: { stringValue: '開始時間' }, userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, fontSize: 8 }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }];
  const headerRow2 = [{ userEnteredValue: { stringValue: '' }, userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, fontSize: 8 }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }];

  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    const dayName = DAY_NAMES[dayOfWeek];
    const isSat = dayOfWeek === 6;
    const isSun = dayOfWeek === 0;
    const bg = isSat ? COLOR_SAT : isSun ? COLOR_SUN : COLOR_WHITE;

    headerRow1.push({
      userEnteredValue: { stringValue: dayName },
      userEnteredFormat: {
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
        textFormat: { bold: true, fontSize: 10 },
        backgroundColor: bg,
      },
    });

    headerRow2.push({
      userEnteredValue: { numberValue: d },
      userEnteredFormat: {
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
        textFormat: { bold: true, fontSize: 11 },
        backgroundColor: bg,
      },
    });
  }

  // 22行のデータ行を構築
  const dataRows = [];
  const mergeRequests = [];

  for (let rIdx = 0; rIdx < TIME_SLOTS.length; rIdx++) {
    const timeStr = TIME_SLOTS[rIdx];
    const rowCells = [
      {
        userEnteredValue: { stringValue: timeStr },
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: { bold: true, fontSize: 8 },
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        },
      },
    ];

    for (let d = 1; d <= daysInMonth; d++) {
      const colIdx = d; // 1-based column in sheet (1 = B列)
      const dayOfWeek = new Date(year, month - 1, d).getDay();
      const isSat = dayOfWeek === 6;
      const isSun = dayOfWeek === 0;
      const defaultBg = isSat ? COLOR_SAT : isSun ? COLOR_SUN : COLOR_WHITE;

      const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayData = daysDataMap[dateKey] || { openSlots: [], reservations: [] };

      // 該当スロットのレッスン予約を探す
      const resList = dayData.reservations.filter(res => {
        const [sh, sm] = res.startTime.split(':').map(Number);
        const [eh, em] = res.endTime.split(':').map(Number);
        const [th, tm] = timeStr.split(':').map(Number);
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        const curM = th * 60 + tm;
        return curM >= startM && curM < endM;
      });

      const isOpen = dayData.openSlots.includes(timeStr);

      let cellValue = '';
      let cellBg = defaultBg;
      let cellFontSize = 8;

      if (resList.length > 0) {
        const ev = resList[0];
        const upper = (ev.title || '').toUpperCase().replace(/[Ａ-Ｚ]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
        const isGroup = upper.includes('GROUP');

        if (isGroup) {
          let cleanTitle = ev.title.replace(/\s*[\(（].*$/, '');
          cellValue = cleanTitle.replace(/GROUP\s*/i, 'GROUP\n');
          cellBg = COLOR_GROUP;
          cellFontSize = 5;
        } else {
          cellValue = '予約済み';
          cellBg = defaultBg;
          cellFontSize = 8;
        }

        // 予約の開始行であれば連続セル結合を計画
        const [sh, sm] = ev.startTime.split(':').map(Number);
        const [eh, em] = ev.endTime.split(':').map(Number);
        const [th, tm] = timeStr.split(':').map(Number);
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        const curM = th * 60 + tm;

        if (curM === startM) {
          const numBlocks = Math.max(1, Math.round((endM - startM) / 30));
          if (numBlocks > 1) {
            mergeRequests.push({
              mergeCells: {
                range: {
                  sheetId,
                  startRowIndex: 2 + rIdx,
                  endRowIndex: Math.min(2 + rIdx + numBlocks, reqRows),
                  startColumnIndex: colIdx,
                  endColumnIndex: colIdx + 1,
                },
                mergeType: 'MERGE_ALL',
              },
            });
          }
        }
      } else if (isOpen) {
        // 稼働中（予約なし・受付中） -> 白 / 土日色
        cellValue = '';
        cellBg = defaultBg;
        cellFontSize = 8;
      } else {
        // 休みに設定（非稼働枠・休日） -> グレー
        cellValue = '';
        cellBg = COLOR_OFF;
        cellFontSize = 8;
      }

      rowCells.push({
        userEnteredValue: cellValue ? { stringValue: cellValue } : { stringValue: '' },
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: { bold: true, fontSize: cellFontSize },
          backgroundColor: cellBg,
          wrapStrategy: 'WRAP',
        },
      });
    }

    dataRows.push({ values: rowCells });
  }

  // batchUpdate リクエストの組み立て
  const updateRequests = [
    // 1. データ領域の結合を一旦全解除
    {
      unmergeCells: {
        range: {
          sheetId,
          startRowIndex: 2,
          endRowIndex: reqRows,
          startColumnIndex: 1,
          endColumnIndex: reqCols,
        },
      },
    },
    // 2. ヘッダーと時間軸、全データセルを一括更新
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: reqRows,
          startColumnIndex: 0,
          endColumnIndex: reqCols,
        },
        rows: [
          { values: headerRow1 },
          { values: headerRow2 },
          ...dataRows,
        ],
        fields: 'userEnteredValue,userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,backgroundColor,wrapStrategy)',
      },
    },
    // 3. 予約ブロックの結合
    ...mergeRequests,
    // 4. 外枠・境界線の設定
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: reqRows,
          startColumnIndex: 0,
          endColumnIndex: reqCols,
        },
        top: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        bottom: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        left: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        right: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        innerHorizontal: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        innerVertical: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
      },
    },
    // 5. 列幅・行高さの設定
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 40 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 1,
          endIndex: reqCols,
        },
        properties: { pixelSize: 35 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: 0,
          endIndex: reqRows,
        },
        properties: { pixelSize: 30 },
        fields: 'pixelSize',
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: updateRequests },
  });

  console.log(`  ✅ シート「${targetSheetTitle}」の同期完了！`);
}

(async () => {
  const loginId = process.env.VOAT_LOGIN_ID;
  const password = process.env.VOAT_PASSWORD;
  if (!loginId || !password) {
    console.error('エラー: .env ファイルに VOAT_LOGIN_ID と VOAT_PASSWORD を設定してください。');
    process.exit(1);
  }

  console.log('ブラウザを起動しています...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ===== ログイン =====
    console.log('ログインページにアクセスしています...');
    await page.goto('https://www.voat.co.jp/instmypage/login.html', { waitUntil: 'networkidle' });
    console.log('ログイン情報を入力しています...');
    await page.fill('input[type="text"]', loginId);
    await page.fill('input[type="password"]', password);
    console.log('ログインを実行しています...');
    await page.click('input[value="ログイン"]');
    console.log('ログイン完了を待機しています...');
    try {
      await page.waitForURL('**/instmypage/', { timeout: 15000 });
      console.log('ログインに成功しました。');
    } catch (urlErr) {
      console.error('エラー: ログイン後にマイページに遷移できませんでした。VOAT_LOGIN_ID や VOAT_PASSWORD が間違っている可能性があります。');
      await page.screenshot({ path: 'login_error.png' }).catch(() => {});
      process.exit(1);
    }
    await page.waitForTimeout(2000);

    // ===== レッスン情報ページへ移動 =====
    console.log('レッスン情報ページに移動しています...');
    await page.goto('https://www.voat.co.jp/instmypage/lesson.html', { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // ===== すべての月を巡回してデータ取得 =====
    const allDaysData = [];

    for (let m = 0; m < MONTHS_TO_PROCESS; m++) {
      if (m > 0) {
        const prevMonthText = await page.evaluate(() => document.querySelector('.cur-month')?.textContent?.trim() || '');
        await page.click('.flatpickr-next-month');

        // 月表示が切り替わるまで待機
        await page.waitForFunction((oldMonth) => {
          const currentMonth = document.querySelector('.cur-month')?.textContent?.trim() || '';
          return currentMonth !== '' && currentMonth !== oldMonth;
        }, prevMonthText, { timeout: 10000 }).catch(() => {});

        await page.waitForTimeout(1500);
      }
      const monthLabel = await page.evaluate(() => {
        const month = document.querySelector('.cur-month')?.textContent?.trim() || '';
        const year = document.querySelector('input.cur-year')?.value || '';
        return `${year}年 ${month}`;
      });
      console.log(`\n📅 ${monthLabel} を処理中...`);
      const monthRes = await processMonth(page);
      allDaysData.push(...monthRes);
    }

    // 全予約のフラットリストを作成
    const allReservations = [];
    const daysDataMap = {};
    for (const day of allDaysData) {
      daysDataMap[day.fullDate] = {
        openSlots: day.openSlots,
        reservations: day.reservations,
      };
      allReservations.push(...day.reservations);
    }

    console.log(`\n=== 全抽出結果: 走査 ${allDaysData.length} 日分, 予約レッスン ${allReservations.length} 件 ===`);

    // ===== 1. Google Calendar 連携（レッスン予約のみ差分同期・休みは一切登録しない） =====
    if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('※ .env にGoogleカレンダーの設定がないため、カレンダー連携はスキップされました。');
    } else {
      console.log('\n--- Google Calendarへの連携処理（レッスン予約のみ差分同期）を開始します ---');
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      const calendar = google.calendar({ version: 'v3', auth });
      const calendarId = process.env.GOOGLE_CALENDAR_ID;

      const now = new Date();
      const startYear = now.getFullYear();
      const startMonth = now.getMonth(); // 0-indexed
      const startStr = `${startYear}-${String(startMonth + 1).padStart(2, '0')}-01T00:00:00+09:00`;

      const endYearMonth = new Date(startYear, startMonth + MONTHS_TO_PROCESS, 0);
      const endYear = endYearMonth.getFullYear();
      const endMonth = endYearMonth.getMonth() + 1;
      const endDay = endYearMonth.getDate();
      const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T23:59:59+09:00`;

      const rangeStart = startStr;
      const rangeEnd = endStr;
      console.log(`同期対象期間: ${rangeStart} 〜 ${rangeEnd}`);

      let existingEvents = [];
      let pageToken = undefined;
      do {
        const res = await calendar.events.list({
          calendarId,
          timeMin: rangeStart,
          timeMax: rangeEnd,
          singleEvents: true,
          maxResults: 2500,
          pageToken,
        });
        existingEvents.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      console.log(`  カレンダー上の既存イベント: ${existingEvents.length} 件`);

      const uniqueReservations = [];
      const seenKey = new Set();
      for (const res of allReservations) {
        const key = `${res.fullDate}_${res.startTime}_${res.endTime}_${res.studio}_${res.title}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          uniqueReservations.push(res);
        }
      }

      const existingMap = new Map();
      const toDeleteEvents = [];

      for (const ev of existingEvents) {
        if (!ev.description || !ev.description.includes(VOAT_SYNC_MARKER)) {
          continue;
        }

        const start = (ev.start.dateTime || ev.start.date || '').substring(0, 16);
        const end = (ev.end.dateTime || ev.end.date || '').substring(0, 16);
        const summary = (ev.summary || '').trim();
        const location = (ev.location || '').trim();
        const key = `${start}_${end}_${summary}_${location}`;

        if (!existingMap.has(key)) {
          existingMap.set(key, ev);
        } else {
          toDeleteEvents.push(ev);
        }
      }

      const toInsertReservations = [];
      for (const res of uniqueReservations) {
        const startISO = `${res.fullDate}T${res.startTime}`;
        const endISO = `${res.fullDate}T${res.endTime}`;
        const summary = res.title.trim();
        const location = res.studio.trim();
        const key = `${startISO}_${endISO}_${summary}_${location}`;

        if (existingMap.has(key)) {
          existingMap.delete(key);
        } else {
          toInsertReservations.push(res);
        }
      }

      for (const [key, ev] of existingMap.entries()) {
        toDeleteEvents.push(ev);
      }

      if (toDeleteEvents.length > 0) {
        console.log(`  不要・変更されたイベント ${toDeleteEvents.length} 件を削除中...`);
        for (const ev of toDeleteEvents) {
          try {
            await calendar.events.delete({ calendarId, eventId: ev.id });
            console.log(`    [削除] ${ev.start.dateTime || ev.start.date}: ${ev.summary}`);
          } catch (delErr) {
            if (delErr.code !== 410) {
              console.error(`    [削除エラー] ${ev.summary}: ${delErr.message}`);
            }
          }
        }
      }

      if (toInsertReservations.length > 0) {
        console.log(`  新規・変更イベント ${toInsertReservations.length} 件を登録中...`);
        for (const res of toInsertReservations) {
          const startDateTime = `${res.fullDate}T${res.startTime}:00+09:00`;
          const endDateTime = `${res.fullDate}T${res.endTime}:00+09:00`;
          const description = `${VOAT_SYNC_MARKER}\n種別: ${res.type}\n内容: ${res.content}\n生徒: ${res.students.join(', ')}`;

          const eventBody = {
            summary: res.title,
            location: res.studio,
            description,
            start: { dateTime: startDateTime, timeZone: 'Asia/Tokyo' },
            end: { dateTime: endDateTime, timeZone: 'Asia/Tokyo' },
          };

          try {
            console.log(`    [登録] ${startDateTime} : ${res.title}`);
            await calendar.events.insert({ calendarId, requestBody: eventBody });
          } catch (apiErr) {
            console.error(`    [エラー] ${startDateTime}: ${apiErr.message}`);
          }
        }
      } else {
        console.log('  新規追加が必要なレッスンはありません（すべて最新同期済み）。');
      }

      console.log('Google Calendarへの連携が完了しました。');
    }

    // ===== 2. Google Sheets 直接同期（予約済み8pt + 休みグレー + 空き枠白） =====
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.SERVICE_ACCOUNT_PATH) {
      console.log('\n※ Google認証情報がないため、スプレッドシートへの直接同期はスキップされました。');
    } else {
      console.log('\n--- Googleスプレッドシートへの直接マトリックス同期を開始します ---');
      const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SERVICE_ACCOUNT_PATH;
      const sheetsAuth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

      const metaRes = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const metaSheets = metaRes.data.sheets;

      const now = new Date();
      for (let m = 0; m < MONTHS_TO_PROCESS; m++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
        const y = targetDate.getFullYear();
        const mon = targetDate.getMonth() + 1;
        const sheetTitle = `${y}年${mon}月`;

        await syncMonthToSpreadsheet(sheets, SPREADSHEET_ID, sheetTitle, y, mon, daysDataMap, metaSheets);

        // 【閲覧用】当月
        if (m === 0) {
          const viewCur = metaSheets.find(s => s.properties.title === '【閲覧用】当月');
          if (viewCur) {
            await syncMonthToSpreadsheet(sheets, SPREADSHEET_ID, '【閲覧用】当月', y, mon, daysDataMap, metaSheets);
          }
        }
        // 【閲覧用】来月
        if (m === 1) {
          const viewNext = metaSheets.find(s => s.properties.title === '【閲覧用】来月');
          if (viewNext) {
            await syncMonthToSpreadsheet(sheets, SPREADSHEET_ID, '【閲覧用】来月', y, mon, daysDataMap, metaSheets);
          }
        }
      }

      console.log('Googleスプレッドシートへの直接マトリックス同期がすべて完了しました！');
    }

  } catch (error) {
    console.error('スクレイピング中にエラーが発生しました:', error);
    process.exit(1);
  } finally {
    console.log('ブラウザを終了しています...');
    await browser.close();
  }
})();
