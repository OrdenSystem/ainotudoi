// エラー通知 本番（録音データレコードエラー通知）
// FIXED: [B5] Webhook URLのハードコードを除去し、スクリプトプロパティから取得するように変更

// SLACKに通知する関数
function sendSlackNotification(message) {
  // FIXED: [B5] スクリプトプロパティから取得（フォールバックは廃止、未設定なら通知スキップ）
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL");
  if (!webhookUrl) {
    Logger.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ');
    return;
  }

  const payload = {
    text: message + "HopeAIchat_とよさと様",
    channel: "slack通知"
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  };

  try {
    UrlFetchApp.fetch(webhookUrl, options);
  } catch (error) {
    Logger.log('SLACK通知の送信に失敗しました: ' + error);
  }
}

function testSlackNotify() {
  sendSlackNotification("✅ テスト通知：Slackへの送信は成功しています！");
}

// FIXED: [B6] エラー通知関数を追加（HopeAIChat.jsから呼び出される）
/**
 * エラー発生時にSlackへ通知する関数
 * @param {string} context - エラー発生箇所（例: "processUserMessage", "registerCaseRecord"）
 * @param {string} errorMsg - エラーメッセージ（個人情報を含めないこと）
 */
function notifyError(context, errorMsg) {
  const timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
  const message = `⚠️ HopeAIChat エラー\n発生箇所: ${context}\nエラー: ${errorMsg}\n時刻: ${timestamp}\n`;
  sendSlackNotification(message);
}
