/**
 * CloudSQL (PostgreSQL) JDBC接続ヘルパー
 *
 * 必要なスクリプトプロパティ:
 *   CLOUDSQL_URL  = jdbc:postgresql://<IP>:5432/<DB>
 *   CLOUDSQL_USER = <ユーザー名>
 *   CLOUDSQL_PASS = <パスワード>
 */

function getCloudSqlConnection_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('CLOUDSQL_URL');
  var user = props.getProperty('CLOUDSQL_USER');
  var pass = props.getProperty('CLOUDSQL_PASS');
  if (!url || !user || !pass) {
    throw new Error('CloudSQL接続情報がScript Propertiesに設定されていません。CLOUDSQL_URL, CLOUDSQL_USER, CLOUDSQL_PASSを設定してください。');
  }
  try {
    return Jdbc.getConnection(url, user, pass);
  } catch (e) {
    var timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    // 詳細はサーバーログのみ（接続URL等が含まれる可能性があるため）
    Logger.log('CloudSQL接続エラー詳細: ' + e.message);
    // Slackには種別のみ通知（接続情報の露出を防ぐ）
    var msg = '🔴 *CloudSQL接続エラー*\nプロジェクト: HopeAIchat\n時刻: ' + timestamp + '\n（詳細はGAS実行ログを確認してください）';
    try { sendSlackNotification(msg); } catch (se) { Logger.log('Slack通知失敗: ' + se.message); }
    throw e;
  }
}

function closeCloudSql_(conn, stmt, rs) {
  try { if (rs) rs.close(); } catch (e) { /* ignore */ }
  try { if (stmt) stmt.close(); } catch (e) { /* ignore */ }
  try { if (conn) conn.close(); } catch (e) { /* ignore */ }
}
