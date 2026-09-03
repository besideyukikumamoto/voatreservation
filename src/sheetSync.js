/**
 * Googleスプレッドシート 直接マトリックス同期モジュール
 * （休みグレー、予約済み8pt固定、空き枠白、過去日保護、API軽量化対応）
 */

const { google } = require('googleapis');

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

/**
 * 1つの月シートまたは閲覧用シートにマトリックスを同期
 */
async function syncMonthToSpreadsheet(sheets, spreadsheetId, targetSheetTitle, year, month, daysDataMap, metaSheets, isCurrentMonth = false, todayDate = 1) {
  let targetSheet = metaSheets.find(s => s.properties.title === targetSheetTitle);
  let sheetId;
  const isNewSheet = !targetSheet;

  const daysInMonth = new Date(year, month, 0).getDate();
  const reqCols = daysInMonth + 1; // A列(時間) + 1〜daysInMonth
  const reqRows = TIME_SLOTS.length + 2; // 1行目:曜日, 2行目:日付, 3〜24行目:データ (計24行)

  if (isNewSheet) {
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

  // 当月で過去日をスキップした場合、既存の過去日セルのデータを読み取って保護
  let existingPastCells = null;
  if (isCurrentMonth && todayDate > 1 && !isNewSheet) {
    try {
      const pastEndColLetter = String.fromCharCode(65 + todayDate - 1); // A=時間, B=1日, C=2日...
      const pastRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`${targetSheetTitle}!B3:${pastEndColLetter}24`],
        includeGridData: true,
      });
      if (pastRes.data.sheets && pastRes.data.sheets[0].data && pastRes.data.sheets[0].data[0].rowData) {
        existingPastCells = pastRes.data.sheets[0].data[0].rowData;
      }
    } catch (readErr) {
      console.warn(`    ⚠️ 過去日セル読み取りスキップ (${targetSheetTitle}): ${readErr.message}`);
    }
  }

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
      const dayData = daysDataMap[dateKey];

      // 【過去日保護】当月かつ今日より前でスキップされ、既存セルデータがある場合
      if (isCurrentMonth && d < todayDate && existingPastCells && existingPastCells[rIdx]) {
        const pastRow = existingPastCells[rIdx];
        const pastCellIdx = d - 1;
        if (pastRow.values && pastRow.values[pastCellIdx]) {
          const oldCell = pastRow.values[pastCellIdx];
          rowCells.push({
            userEnteredValue: oldCell.userEnteredValue || (oldCell.formattedValue ? { stringValue: oldCell.formattedValue } : { stringValue: '' }),
            userEnteredFormat: oldCell.userEnteredFormat || {
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
              textFormat: { bold: true, fontSize: 8 },
              backgroundColor: defaultBg,
            },
          });
          continue;
        }
      }

      // 新規データまたは未来日のデータ構築
      const dayInfo = dayData || { openSlots: [], reservations: [] };

      // 該当スロットのレッスン予約を探す
      const resList = dayInfo.reservations.filter(res => {
        const [sh, sm] = res.startTime.split(':').map(Number);
        const [eh, em] = res.endTime.split(':').map(Number);
        const [th, tm] = timeStr.split(':').map(Number);
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        const curM = th * 60 + tm;
        return curM >= startM && curM < endM;
      });

      const isOpen = dayInfo.openSlots.includes(timeStr);

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

  // batchUpdate リクエストの組み立て（既存シート時は枠線・列幅等の再描画を省略して高速化）
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
  ];

  // 【API軽量化】新規作成シートの場合のみ枠線・列幅・行高さを適用（既存シートはスキップしてAPI消費を削減）
  if (isNewSheet) {
    updateRequests.push(
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
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 40 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: reqCols },
          properties: { pixelSize: 35 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: reqRows },
          properties: { pixelSize: 30 },
          fields: 'pixelSize',
        },
      }
    );
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: updateRequests },
  });

  console.log(`  ✅ シート「${targetSheetTitle}」の同期完了！`);
}

/**
 * 全月および閲覧用シートへのマトリックス同期を一括実行
 */
async function syncAllMonthsToSpreadsheet(daysDataMap, spreadsheetId, keyFilePath, monthsToProcess = 3) {
  if (!keyFilePath) {
    console.log('\n※ Google認証情報がないため、スプレッドシートへの直接同期はスキップされました。');
    return;
  }

  console.log('\n--- Googleスプレッドシートへの直接マトリックス同期を開始します ---');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const metaRes = await sheets.spreadsheets.get({ spreadsheetId });
  const metaSheets = metaRes.data.sheets;

  const now = new Date();
  const todayDate = now.getDate();

  for (let m = 0; m < monthsToProcess; m++) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const y = targetDate.getFullYear();
    const mon = targetDate.getMonth() + 1;
    const sheetTitle = `${y}年${mon}月`;
    const isCurrentMonth = (m === 0);

    await syncMonthToSpreadsheet(sheets, spreadsheetId, sheetTitle, y, mon, daysDataMap, metaSheets, isCurrentMonth, todayDate);

    // 【閲覧用】当月
    if (m === 0) {
      const viewCur = metaSheets.find(s => s.properties.title === '【閲覧用】当月');
      if (viewCur) {
        await syncMonthToSpreadsheet(sheets, spreadsheetId, '【閲覧用】当月', y, mon, daysDataMap, metaSheets, isCurrentMonth, todayDate);
      }
    }
    // 【閲覧用】来月
    if (m === 1) {
      const viewNext = metaSheets.find(s => s.properties.title === '【閲覧用】来月');
      if (viewNext) {
        await syncMonthToSpreadsheet(sheets, spreadsheetId, '【閲覧用】来月', y, mon, daysDataMap, metaSheets, false, 1);
      }
    }
  }

  console.log('Googleスプレッドシートへの直接マトリックス同期がすべて完了しました！');
}

module.exports = {
  syncAllMonthsToSpreadsheet,
};
