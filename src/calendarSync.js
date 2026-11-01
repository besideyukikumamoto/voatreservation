/**
 * Google Calendar 差分同期モジュール
 * （レッスン予約のみを同期。休みは一切登録しない。当日以降のみを照合して過去日を100%保護）
 */

const { google } = require('googleapis');

const VOAT_SYNC_MARKER = '[VOAT-SYNC]';

/**
 * Google API 一時的エラー（429 / 5xx / 通信瞬断）の自動リトライ補助関数
 */
async function withApiRetry(fn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || err.status || 0;
      const isRetryable = code === 429 || code === 500 || code === 502 || code === 503 || code === 504 ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Rate Limit|Quota exceeded|Backend Error/i.test(err.message || '');
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      const waitMs = 1500 * Math.pow(2, attempt - 1);
      console.warn(`    ⚠️ Google Calendar API 一時エラー (${label}) - ${waitMs}ms 後にリトライします (${attempt}/${maxRetries}): ${err.message}`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

/**
 * レッスン予約リストをGoogleカレンダーに差分同期する
 * @param {Array} reservations 予約オブジェクト配列
 * @param {string} calendarId カレンダーID
 * @param {string} keyFilePath サービスアカウント認証ファイルパス
 * @param {number} monthsToProcess 処理月数
 */
async function syncReservationsToCalendar(reservations, calendarId, keyFilePath, monthsToProcess = 3) {
  if (!calendarId || !keyFilePath) {
    console.log('※ カレンダーIDまたは認証情報がないため、カレンダー連携はスキップされました。');
    return;
  }

  console.log('\n--- Google Calendarへの連携処理（レッスン予約のみ差分同期）を開始します ---');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  // 【過去日保護】同期対象期間の開始日時を日本時間（JST）基準で「当日 00:00:00」にする
  // これにより、過去日スキップ時でも過去日のイベントが削除対象に入るのを100%防止
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const startYear = now.getFullYear();
  const startMonth = now.getMonth(); // 0-indexed
  const startDate = now.getDate();
  const startStr = `${startYear}-${String(startMonth + 1).padStart(2, '0')}-${String(startDate).padStart(2, '0')}T00:00:00+09:00`;

  const endYearMonth = new Date(startYear, startMonth + monthsToProcess, 0);
  const endYear = endYearMonth.getFullYear();
  const endMonth = endYearMonth.getMonth() + 1;
  const endDay = endYearMonth.getDate();
  const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T23:59:59+09:00`;

  console.log(`同期対象期間（過去日は保護）: ${startStr} 〜 ${endStr}`);

  // 1. 期間内の既存イベントを取得
  let existingEvents = [];
  let pageToken = undefined;
  do {
    const res = await withApiRetry(
      () => calendar.events.list({
        calendarId,
        timeMin: startStr,
        timeMax: endStr,
        singleEvents: true,
        maxResults: 2500,
        pageToken,
      }),
      'events.list'
    );
    existingEvents.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`  カレンダー上の既存イベント（当日以降）: ${existingEvents.length} 件`);

  // 2. メモリ上の一意化
  const uniqueReservations = [];
  const seenKey = new Set();
  for (const res of reservations) {
    const key = `${res.fullDate}_${res.startTime}_${res.endTime}_${res.studio}_${res.title}`;
    if (!seenKey.has(key)) {
      seenKey.add(key);
      uniqueReservations.push(res);
    }
  }

  // 3. 差分照合（Reconciliation）アルゴリズム
  const existingMap = new Map();
  const toDeleteEvents = [];

  for (const ev of existingEvents) {
    // 手動登録イベント（[VOAT-SYNC] を含まないもの）は保護
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

  // 【フェイルセーフ保護】既存予定が5件以上あるのに新規取得予定が0件の場合は、サイト異常による全消去を防ぐため削除をスキップ
  if (uniqueReservations.length === 0 && existingMap.size >= 5) {
    console.warn(`  ⚠️ 既存の同期予定が ${existingMap.size} 件あるのに対し今回取得した予約が 0 件のため、安全保護により一括削除をスキップします。`);
    return;
  }

  for (const [key, ev] of existingMap.entries()) {
    toDeleteEvents.push(ev);
  }

  // 4. 不要・変更イベントの削除
  if (toDeleteEvents.length > 0) {
    console.log(`  不要・変更されたイベント ${toDeleteEvents.length} 件を削除中...`);
    for (const ev of toDeleteEvents) {
      try {
        await withApiRetry(() => calendar.events.delete({ calendarId, eventId: ev.id }), 'events.delete');
        console.log(`    [削除] ${ev.start.dateTime || ev.start.date}: ${ev.summary}`);
      } catch (delErr) {
        if (delErr.code !== 410) {
          console.error(`    [削除エラー] ${ev.summary}: ${delErr.message}`);
        }
      }
    }
  }

  // 5. 新規予定の登録
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
        await withApiRetry(() => calendar.events.insert({ calendarId, requestBody: eventBody }), 'events.insert');
      } catch (apiErr) {
        console.error(`    [エラー] ${startDateTime}: ${apiErr.message}`);
      }
    }
  } else {
    console.log('  新規追加が必要なレッスンはありません（すべて最新同期済み）。');
  }

  console.log('Google Calendarへの連携が完了しました。');
}

module.exports = {
  syncReservationsToCalendar,
};
