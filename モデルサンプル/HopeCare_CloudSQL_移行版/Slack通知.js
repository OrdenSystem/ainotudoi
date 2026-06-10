/**
 * Slack通知
 *
 * 必要なスクリプトプロパティ:
 *   SLACK_WEBHOOK_URL : Slack Incoming Webhook URL
 */

// SLACKに通知する関数
function sendSlackNotification(message) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    Logger.log('SLACK_WEBHOOK_URL が設定されていません');
    return;
  }

  var payload = {
    text: message + ' toyosato__HopeCareCloudSQL',
    channel: 'slack通知'
  };

  var options = {
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
