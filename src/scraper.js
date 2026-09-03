/**
 * VOAT講師マイページ 高速スクレイピングモジュール
 */

const { chromium } = require('playwright');

// 現在選択されている日付の稼働枠およびレッスン情報を抽出
async function extractCurrentDateReservations(page) {
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

    // 【年またぎガード】年末（11月・12月）に翌年（1月〜3月）のデータを処理している場合
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
    const openSlots = [];
    const extractedData = [];

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

      // 【時間2桁ゼロ埋め】9:00 -> 09:00 に確実に正規化
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

    return {
      success: true,
      fullDate,
      openSlots: Array.from(new Set(openSlots)),
      data: extractedData,
    };
  });
}

// 現在表示中の月のすべての日付を取得
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

// 日付のクリックとAjax/DOM描画完了の高速待機
async function selectDateAndWait(page, selector, dayNumber) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.click(selector);

      // .pickup-date の日付（日番号）がクリック対象と一致するまで待機
      await page.waitForFunction((expectedDay) => {
        const pickupEl = document.querySelector('.pickup-date');
        if (!pickupEl) return false;
        const parts = pickupEl.innerText.trim().split('/');
        if (parts.length !== 2) return false;
        return parseInt(parts[1], 10) === expectedDay;
      }, dayNumber, { timeout: 6000 });

      // 最適化された最小待機 (400ms -> 150ms)
      await page.waitForTimeout(150);
      return true;
    } catch (e) {
      console.warn(`    ⚠️ 日付選択待機リトライ (${attempt}/3): day=${dayNumber}`);
      await page.waitForTimeout(600);
    }
  }
  return false;
}

// 1ヶ月分の全日付を巡回してレッスン情報・稼働枠を取得（当月の過去日は高速スキップ）
async function processMonth(page, isCurrentMonth, todayDate) {
  const monthData = [];
  const dates = await getReservableDates(page);
  if (dates.length === 0) return monthData;

  let skippedCount = 0;
  for (const item of dates) {
    // 【高速化】当月の場合、今日より前の過去日はスキップ（予約変更がないため）
    if (isCurrentMonth && item.dayNumber < todayDate) {
      skippedCount++;
      continue;
    }

    const selector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)[aria-label="${item.ariaLabel}"]`;
    const ok = await selectDateAndWait(page, selector, item.dayNumber);
    if (!ok) {
      console.error(`  ❌ 日付の選択・描画待機に失敗しました: ${item.ariaLabel}`);
      continue;
    }

    const extractResult = await extractCurrentDateReservations(page);
    if (extractResult && extractResult.success) {
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

  if (skippedCount > 0) {
    console.log(`  ⚡ 当月の過去日 ${skippedCount} 日分をスキップして高速化しました。`);
  }

  return monthData;
}

/**
 * VOATマイページから指定月数分のデータをスクレイピングする
 * @param {string} loginId ログインID
 * @param {string} password パスワード
 * @param {number} monthsToProcess 処理月数（デフォルト3）
 * @returns {Promise<Array>} 取得データ配列
 */
async function scrapeVoatReservations(loginId, password, monthsToProcess = 3) {
  console.log('ブラウザを起動しています...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('ログインページにアクセスしています...');
    await page.goto('https://www.voat.co.jp/instmypage/login.html', { waitUntil: 'networkidle' });

    console.log('ログイン情報を入力しています...');
    await page.fill('input[type="text"]', loginId);
    await page.fill('input[type="password"]', password);
    await page.click('input[value="ログイン"]');

    console.log('ログイン完了を待機しています...');
    try {
      await page.waitForURL('**/instmypage/', { timeout: 15000 });
      console.log('ログインに成功しました。');
    } catch (urlErr) {
      await page.screenshot({ path: 'login_error.png' }).catch(() => {});
      throw new Error('マイページに遷移できませんでした。IDまたはパスワードが誤っている可能性があります。');
    }
    await page.waitForTimeout(1000);

    console.log('レッスン情報ページに移動しています...');
    await page.goto('https://www.voat.co.jp/instmypage/lesson.html', { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const allDaysData = [];
    const now = new Date();
    const todayDate = now.getDate();

    for (let m = 0; m < monthsToProcess; m++) {
      if (m > 0) {
        const prevMonthText = await page.evaluate(() => document.querySelector('.cur-month')?.textContent?.trim() || '');
        await page.click('.flatpickr-next-month');

        await page.waitForFunction((oldMonth) => {
          const currentMonth = document.querySelector('.cur-month')?.textContent?.trim() || '';
          return currentMonth !== '' && currentMonth !== oldMonth;
        }, prevMonthText, { timeout: 10000 }).catch(() => {});

        await page.waitForTimeout(800);
      }

      const monthLabel = await page.evaluate(() => {
        const month = document.querySelector('.cur-month')?.textContent?.trim() || '';
        const year = document.querySelector('input.cur-year')?.value || '';
        return `${year}年 ${month}`;
      });

      console.log(`\n📅 ${monthLabel} を処理中...`);
      const isCurrentMonth = (m === 0);
      const monthRes = await processMonth(page, isCurrentMonth, todayDate);
      allDaysData.push(...monthRes);
    }

    return allDaysData;
  } finally {
    console.log('ブラウザを終了しています...');
    await browser.close();
  }
}

module.exports = {
  scrapeVoatReservations,
};
