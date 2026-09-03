require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { google } = require('googleapis');

const VOAT_SYNC_MARKER = '[VOAT-SYNC]';
const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）

// 稼働日・レッスン情報の抽出（年またぎガード＆時間2桁ゼロ埋め適用済み）
async function extractCurrentDateReservations(page) {
  return await page.evaluate(() => {
    const extractedData = [];
    const openSlots = [];

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

      // 【時間2桁ゼロ埋め】9:00 -> 09:00 に確実に正規化
      startTime = startTime.split(':').map(p => p.trim().padStart(2, '0')).join(':');
      endTime = endTime.split(':').map(p => p.trim().padStart(2, '0')).join(':');

      // 30分刻みの稼働スロット
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

      let rawText = lessonCell.innerText.trim();
      if (!rawText || rawText === '受付中' || rawText === '予約可' || rawText === '空き') return;

      rawText = rawText
        .replace(/欠席フォロー動画を送信する\s*>>/g, '')
        .replace(/動画を送信する\s*>>/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      if (!rawText) return;
      const title = rawText || 'レッスン';

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

// 日付のクリックと描画待機
async function selectDateAndWait(page, selector, dayNumber) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.click(selector);
      await page.waitForFunction((expectedDay) => {
        const pickupEl = document.querySelector('.pickup-date');
        if (!pickupEl) return false;
        const text = pickupEl.innerText.trim();
        const parts = text.split('/');
        if (parts.length !== 2) return false;
        const day = parseInt(parts[1], 10);
        return day === expectedDay;
      }, dayNumber, { timeout: 8000 });

      await page.waitForTimeout(300);
      return true;
    } catch (e) {
      await page.waitForTimeout(800);
    }
  }
  return false;
}

// 1ヶ月分の全日付を巡回してレッスン情報取得
async function processMonth(page) {
  const monthData = [];
  const dates = await getReservableDates(page);
  if (dates.length === 0) return monthData;

  for (const item of dates) {
    const selector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)[aria-label="${item.ariaLabel}"]`;
    const ok = await selectDateAndWait(page, selector, item.dayNumber);
    if (!ok) continue;

    const extractResult = await extractCurrentDateReservations(page);
    if (extractResult && extractResult.success) {
      const extractedDay = parseInt(extractResult.fullDate.split('-')[2], 10);
      if (extractedDay !== item.dayNumber) continue;

      monthData.push(...extractResult.data);
    }
  }
  return monthData;
}

// Google Calendar 差分同期（Reconciliation）
async function syncToGoogleCalendar(calendar, calendarId, allReservations) {
  const now = new Date();
  const startYear = now.getFullYear();
  const startMonth = now.getMonth();
  const startStr = `${startYear}-${String(startMonth + 1).padStart(2, '0')}-01T00:00:00+09:00`;

  const endYearMonth = new Date(startYear, startMonth + MONTHS_TO_PROCESS, 0);
  const endYear = endYearMonth.getFullYear();
  const endMonth = endYearMonth.getMonth() + 1;
  const endDay = endYearMonth.getDate();
  const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T23:59:59+09:00`;

  let existingEvents = [];
  let pageToken = undefined;
  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: startStr,
      timeMax: endStr,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    existingEvents.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // メモリ上の一意化
  const uniqueReservations = [];
  const seenKey = new Set();
  for (const res of allReservations) {
    const key = `${res.fullDate}_${res.startTime}_${res.endTime}_${res.studio}_${res.title}`;
    if (!seenKey.has(key)) {
      seenKey.add(key);
      uniqueReservations.push(res);
    }
  }

  // 差分照合
  const existingMap = new Map();
  const toDeleteEvents = [];

  for (const ev of existingEvents) {
    if (!ev.description || !ev.description.includes(VOAT_SYNC_MARKER)) {
      continue; // 手動予定は保護
    }

    const start = (ev.start.dateTime || ev.start.date || '').substring(0, 16);
    const end = (ev.end.dateTime || ev.end.date || '').substring(0, 16);
    const summary = (ev.summary || '').trim();
    const location = (ev.location || '').trim();
    const key = `${start}_${end}_${summary}_${location}`;

    if (!existingMap.has(key)) {
      existingMap.set(key, ev);
    } else {
      toDeleteEvents.push(ev); // 重複ゴミは削除
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
    toDeleteEvents.push(ev); // VOAT側で消えた古い予定を削除
  }

  // 削除実行
  for (const ev of toDeleteEvents) {
    try {
      await calendar.events.delete({ calendarId, eventId: ev.id });
    } catch (delErr) {
      if (delErr.code !== 410) {
        console.error(`    [削除エラー] ${ev.summary}: ${delErr.message}`);
      }
    }
  }

  // 新規登録実行
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
      await calendar.events.insert({ calendarId, requestBody: eventBody });
    } catch (apiErr) {
      console.error(`    [登録エラー] ${startDateTime}: ${apiErr.message}`);
    }
  }

  return {
    total: uniqueReservations.length,
    inserted: toInsertReservations.length,
    deleted: toDeleteEvents.length,
  };
}

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

// メイン実行関数
(async () => {
  const teachers = loadTeacherAccounts();

  console.log('========================================================================');
  console.log(`🚀 VOAT予約システム 全講師一括同期（シングルマスター）開始: 全 ${teachers.length} 名`);
  console.log('========================================================================\n');

  // Google Calendar Auth 準備
  let calendar = null;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'service-account.json');
  if (fs.existsSync(credPath)) {
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
  } else {
    console.warn('⚠️ service-account.json が見つかりません。カレンダー同期はスキップされます。');
  }

  console.log('ブラウザを起動しています...');
  const browser = await chromium.launch({ headless: true });

  const summary = [];

  for (let i = 0; i < teachers.length; i++) {
    const teacher = teachers[i];
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`[${i + 1}/${teachers.length}] 講師: ${teacher.name} (${teacher.loginId}) の同期処理を開始`);
    console.log(`------------------------------------------------------------------------`);

    // アカウントごとに完全独立した新しいブラウザコンテキストを作成（Cookie・セッション汚染防止）
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // 1. ログイン
      await page.goto('https://www.voat.co.jp/instmypage/login.html', { waitUntil: 'networkidle' });
      await page.fill('input[type="text"]', teacher.loginId);
      await page.fill('input[type="password"]', teacher.password);
      await page.click('input[value="ログイン"]');
      await page.waitForURL('**/instmypage/', { timeout: 15000 });

      // 2. レッスンページへ
      await page.goto('https://www.voat.co.jp/instmypage/lesson.html', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      // 3. 3ヶ月分の全日走査
      const allReservations = [];
      for (let m = 0; m < MONTHS_TO_PROCESS; m++) {
        if (m > 0) {
          const prevMonthText = await page.evaluate(() => document.querySelector('.cur-month')?.textContent?.trim() || '');
          await page.click('.flatpickr-next-month');
          await page.waitForFunction((oldMonth) => {
            const currentMonth = document.querySelector('.cur-month')?.textContent?.trim() || '';
            return currentMonth !== '' && currentMonth !== oldMonth;
          }, prevMonthText, { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }

        const monthRes = await processMonth(page);
        allReservations.push(...monthRes);
      }

      console.log(`  抽出結果: 合計 ${allReservations.length} 件のレッスン`);

      // 4. カレンダー同期
      let syncStats = { total: allReservations.length, inserted: 0, deleted: 0 };
      if (calendar && teacher.calendarId) {
        syncStats = await syncToGoogleCalendar(calendar, teacher.calendarId, allReservations);
        console.log(`  カレンダー同期完了: 全${syncStats.total}件 (新規/更新: +${syncStats.inserted}, 削除: -${syncStats.deleted})`);
      }

      summary.push({
        name: teacher.name,
        status: 'SUCCESS',
        total: syncStats.total,
        inserted: syncStats.inserted,
        deleted: syncStats.deleted,
        error: '',
      });

    } catch (err) {
      console.error(`  ❌ [エラー] ${teacher.name} の同期中に失敗しました:`, err.message);
      summary.push({
        name: teacher.name,
        status: 'ERROR',
        total: 0,
        inserted: 0,
        deleted: 0,
        error: err.message,
      });
    } finally {
      await context.close(); // Cookie・キャッシュを破棄
    }
  }

  await browser.close();

  // 最終結果サマリー
  console.log('\n========================================================================');
  console.log('              📊 全講師 VOAT同期 総合レポート');
  console.log('========================================================================');
  console.log('| 講師名 | ステータス | 予定総数 | 新規/更新 | 削除 | 備考 |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :--- |');
  for (const s of summary) {
    const statusIcon = s.status === 'SUCCESS' ? '✅ 成功' : '❌ 失敗';
    console.log(`| ${s.name.padEnd(6, ' ')} | ${statusIcon} | ${s.total.toString().padStart(4, ' ')} 件 | +${s.inserted.toString().padStart(2, ' ')} | -${s.deleted.toString().padStart(2, ' ')} | ${s.error || '正常同期'} |`);
  }
  console.log('========================================================================\n');

  const hasError = summary.some(s => s.status === 'ERROR');
  if (hasError) {
    console.warn('⚠️ 一部の講師でエラーが発生しました。詳細は上記レポートをご確認ください。');
  }
})();
