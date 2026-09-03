/**
 * LINE Messaging API を使用したエラー・アラート通知モジュール
 */

const DEFAULT_LINE_TOKEN = 'Nmla7Cogq/6jILUzytIw8KmrB54KaXUzOvmroMZcg0ns4K/jToWVJjmVNe+Nu2weHCrgsXvbvQiboHCP7FLGEgAyjLnvWTDRCjAAtaQoH5ynVxuJ6vnfskVKsuPf2laSW71yIEuuY9hHzNAJLZEKvQdB04t89/1O/w1cDnyilFU=';
const DEFAULT_USER_ID = 'U1c94008254a2d065c85b9eed253ccf12';

/**
 * LINE宛てにプッシュメッセージを送信する
 * @param {string} text 送信テキスト
 * @returns {Promise<boolean>} 送信成功可否
 */
async function sendLineMessage(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || DEFAULT_LINE_TOKEN;
  const userId = process.env.LINE_ADMIN_USER_ID || DEFAULT_USER_ID;

  if (!token || !userId) {
    console.warn('⚠️ LINE設定（トークンまたはユーザーID）が見つからないため、通知をスキップします。');
    return false;
  }

  try {
    const url = 'https://api.line.me/v2/bot/message/push';
    const payload = {
      to: userId,
      messages: [
        {
          type: 'text',
          text: text,
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('📱 LINE宛てに通知を送信しました。');
      return true;
    } else {
      const errText = await response.text();
      console.error(`❌ LINE通知送信エラー: ${response.status} ${response.statusText} - ${errText}`);
      return false;
    }
  } catch (err) {
    console.error('❌ LINE通知送信処理中に例外が発生しました:', err.message);
    return false;
  }
}

/**
 * エラー発生時にアラート通知を送信する
 * @param {string} step エラー発生ステップ名
 * @param {Error|string} error エラーオブジェクトまたはメッセージ
 */
async function sendErrorAlert(step, error) {
  const now = new Date();
  const jstString = new Date(now.getTime() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
  const errMsg = error && error.message ? error.message : String(error);

  const text = `⚠️ 【VOATスクレイパー 異常検知】\n\n` +
    `発生日時: ${jstString} JST\n` +
    `発生箇所: ${step}\n\n` +
    `エラー内容:\n${errMsg}\n\n` +
    `※GitHub Actionsのログをご確認ください。`;

  return await sendLineMessage(text);
}

module.exports = {
  sendLineMessage,
  sendErrorAlert,
};
