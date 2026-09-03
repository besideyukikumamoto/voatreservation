require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { scrapeVoatReservations } = require('./src/scraper');
const { syncReservationsToCalendar } = require('./src/calendarSync');
const { sendErrorAlert } = require('./src/notifier');

const MONTHS_TO_PROCESS = 3;
const KEY_FILE_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, 'service-account.json');

// 設定のロード（優先度: VOAT_ACCOUNTS_JSON > teachers_config.json > 単一.env）
function loadTeacherAccounts() {
  if (process.env.VOAT_ACCOUNTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.VOAT_ACCOUNTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`📋 環境変数 VOAT_ACCOUNTS_JSON から ${parsed.length} 名の講師設定を読み込みました。`);
        return parsed;
      }
    } catch (e) {
      console.error('⚠️ VOAT_ACCOUNTS_JSON のパースに失敗しました:', e.message);
    }
  }

  const configPath = path.join(__dirname, 'teachers_config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`📋 teachers_config.json から ${parsed.length} 名の講師設定を読み込みました。`);
        return parsed;
      }
    } catch (e) {
      console.error('⚠️ teachers_config.json の読み込みに失敗しました:', e.message);
    }
  }

  // フォールバック: 単一アカウント (.env)
  if (process.env.VOAT_LOGIN_ID && process.env.VOAT_PASSWORD && process.env.GOOGLE_CALENDAR_ID) {
    console.log('📋 単一アカウント環境変数 (.env) から講師設定を読み込みました。');
    return [
      {
        name: process.env.TEACHER_NAME || '隈元',
        loginId: process.env.VOAT_LOGIN_ID,
        password: process.env.VOAT_PASSWORD,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
      },
    ];
  }

  console.error('❌ エラー: 講師アカウント設定が見つかりません。VOAT_ACCOUNTS_JSON、teachers_config.json、または .env を設定してください。');
  process.exit(1);
}

// メイン一括実行
(async () => {
  const startTime = Date.now();
  const teachers = loadTeacherAccounts();

  console.log('========================================================================');
  console.log(`🚀 VOAT予約システム 全講師一括同期（高速5大改善版）開始: 全 ${teachers.length} 名`);
  console.log(`⏰ 実行開始: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('========================================================================\n');

  const summary = [];

  for (let i = 0; i < teachers.length; i++) {
    const teacher = teachers[i];
    const tStart = Date.now();
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`[${i + 1}/${teachers.length}] 講師: ${teacher.name} (${teacher.loginId}) の同期処理を開始`);
    console.log(`------------------------------------------------------------------------`);

    try {
      // 1. 高速スクレイピング（過去日スキップ＆150ms高速待機）
      const allDaysData = await scrapeVoatReservations(teacher.loginId, teacher.password, MONTHS_TO_PROCESS);

      const allReservations = [];
      for (const day of allDaysData) {
        allReservations.push(...day.reservations);
      }

      console.log(`  抽出結果: 走査 ${allDaysData.length} 日分, レッスン ${allReservations.length} 件`);

      // 2. Googleカレンダー差分同期（過去日保護）
      if (teacher.calendarId) {
        await syncReservationsToCalendar(allReservations, teacher.calendarId, KEY_FILE_PATH, MONTHS_TO_PROCESS);
      } else {
        console.warn(`  ⚠️ ${teacher.name} のカレンダーIDが未設定のため、カレンダー同期はスキップされました。`);
      }

      const tSec = ((Date.now() - tStart) / 1000).toFixed(1);
      console.log(`  ✅ ${teacher.name} の同期完了 (所要時間: ${tSec} 秒)`);

      summary.push({
        name: teacher.name,
        status: 'SUCCESS',
        days: allDaysData.length,
        total: allReservations.length,
        duration: `${tSec}s`,
        error: '',
      });

    } catch (err) {
      const tSec = ((Date.now() - tStart) / 1000).toFixed(1);
      console.error(`  ❌ [エラー] ${teacher.name} の同期中に失敗しました (${tSec}s):`, err.message);

      // LINE宛てにエラーアラート送信
      try {
        await sendErrorAlert(`全講師一括同期 (${teacher.name} 講師)`, err);
      } catch (notifyErr) {
        console.error('  ❌ LINE通知の送信に失敗しました:', notifyErr.message);
      }

      summary.push({
        name: teacher.name,
        status: 'ERROR',
        days: 0,
        total: 0,
        duration: `${tSec}s`,
        error: err.message,
      });
    }
  }

  // 最終結果サマリー
  const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n========================================================================');
  console.log('              📊 全講師 VOAT同期 総合レポート');
  console.log(`              (総所要時間: ${totalElapsedSec} 秒)`);
  console.log('========================================================================');
  console.log('| 講師名 | ステータス | 走査日数 | 予定総数 | 所要時間 | 備考 |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :--- |');
  for (const s of summary) {
    const statusIcon = s.status === 'SUCCESS' ? '✅ 成功' : '❌ 失敗';
    console.log(`| ${s.name.padEnd(6, ' ')} | ${statusIcon} | ${s.days.toString().padStart(3, ' ')} 日 | ${s.total.toString().padStart(4, ' ')} 件 | ${s.duration.padStart(6, ' ')} | ${s.error || '正常同期'} |`);
  }
  console.log('========================================================================\n');

  const hasError = summary.some(s => s.status === 'ERROR');
  if (hasError) {
    console.warn('⚠️ 一部の講師でエラーが発生しました。LINE通知および上記レポートをご確認ください。');
    process.exit(1);
  }
})();
