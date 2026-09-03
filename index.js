require('dotenv').config();
const path = require('path');
const { scrapeVoatReservations } = require('./src/scraper');
const { syncReservationsToCalendar } = require('./src/calendarSync');
const { syncAllMonthsToSpreadsheet } = require('./src/sheetSync');
const { sendErrorAlert } = require('./src/notifier');

const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4';
const KEY_FILE_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, 'service-account.json');

(async () => {
  const startTime = Date.now();
  console.log('==============================================');
  console.log('🚀 VOAT予約スクレイパー＆直接同期システム 起動');
  console.log(`⏰ 実行開始: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('==============================================');

  const loginId = process.env.VOAT_LOGIN_ID;
  const password = process.env.VOAT_PASSWORD;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!loginId || !password) {
    const err = new Error('環境変数 VOAT_LOGIN_ID または VOAT_PASSWORD が設定されていません。');
    console.error(err.message);
    await sendErrorAlert('初期化（環境変数チェック）', err);
    process.exit(1);
  }

  try {
    // ----------------------------------------------------
    // Step 1: VOATマイページ高速スクレイピング
    // ----------------------------------------------------
    console.log('\n【Step 1】VOATマイページのスクレイピングを開始します...');
    const allDaysData = await scrapeVoatReservations(loginId, password, MONTHS_TO_PROCESS);

    // 全予約のフラットリストおよび日付マップを作成
    const allReservations = [];
    const daysDataMap = {};
    for (const day of allDaysData) {
      daysDataMap[day.fullDate] = {
        openSlots: day.openSlots,
        reservations: day.reservations,
      };
      allReservations.push(...day.reservations);
    }

    console.log(`\n=== 抽出結果: 走査 ${allDaysData.length} 日分, 予約レッスン ${allReservations.length} 件 ===`);

    // ----------------------------------------------------
    // Step 2: Google Calendar 差分同期（レッスン予約のみ）
    // ----------------------------------------------------
    console.log('\n【Step 2】Google Calendarへの差分同期を開始します...');
    await syncReservationsToCalendar(allReservations, calendarId, KEY_FILE_PATH, MONTHS_TO_PROCESS);

    // ----------------------------------------------------
    // Step 3: Google Sheets 直接マトリックス同期（休みグレー＆8pt固定）
    // ----------------------------------------------------
    console.log('\n【Step 3】Googleスプレッドシートへの直接同期を開始します...');
    await syncAllMonthsToSpreadsheet(daysDataMap, SPREADSHEET_ID, KEY_FILE_PATH, MONTHS_TO_PROCESS);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n==============================================');
    console.log(`🎉 すべての同期処理が正常に完了しました！ (所要時間: ${elapsedSec} 秒)`);
    console.log('==============================================');

  } catch (error) {
    console.error('\n❌ 処理中に重大なエラーが発生しました:', error);

    // LINE宛てにエラーアラートを送信
    try {
      await sendErrorAlert('VOATスクレイパー実行処理', error);
    } catch (notifyErr) {
      console.error('❌ エラーアラートの送信自体に失敗しました:', notifyErr.message);
    }

    process.exit(1);
  }
})();
