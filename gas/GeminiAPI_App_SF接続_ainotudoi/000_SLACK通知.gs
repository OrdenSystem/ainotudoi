// エラー通知 本番
// FIXED: Webhook URLをスクリプトプロパティから取得

// SLACKに通知する関数
function sendSlackNotification(message) {
  const webhookUrl =
    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL");
  if (!webhookUrl) {
    Logger.log("SLACK_WEBHOOK_URL が設定されていません");
    return;
  }

  const payload = {
    text: message + " HAHAHA__GeminiAPI_App_SF接続",
    channel: "slack通知",
  };

  const options = {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(payload),
  };

  try {
    UrlFetchApp.fetch(webhookUrl, options);
  } catch (error) {
    Logger.log("SLACK通知の送信に失敗しました: " + error);
  }
}

function testSlackNotify() {
  sendSlackNotification("✅ テスト通知：Slackへの送信は成功しています！");
}
