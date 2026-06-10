/**
 * CloudSQL (PostgreSQL) JDBC接続ヘルパー
 *
 * Script Propertiesに以下を設定してください:
 *   CLOUDSQL_URL  = jdbc:postgresql://<IP>:5432/<DB>
 *   CLOUDSQL_USER = <ユーザー名>
 *   CLOUDSQL_PASS = <パスワード>
 */

/**
 * CloudSQLへのJDBC接続を取得する
 * @returns {JdbcConnection}
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
    var msg = '🔴 *CloudSQL接続エラー*\nプロジェクト: GeminiAPI_App_SF接続_とよさと様\nエラー: ' + e.message + '\n時刻: ' + timestamp;
    try { sendSlackNotification(msg); } catch (se) { Logger.log('Slack通知失敗: ' + se.message); }
    throw e;
  }
}

/**
 * JDBC リソースを安全にクローズする
 * @param {JdbcConnection} [conn]
 * @param {JdbcStatement} [stmt]
 * @param {JdbcResultSet} [rs]
 */
function closeCloudSql_(conn, stmt, rs) {
  try { if (rs) rs.close(); } catch (e) { /* ignore */ }
  try { if (stmt) stmt.close(); } catch (e) { /* ignore */ }
  try { if (conn) conn.close(); } catch (e) { /* ignore */ }
}

/**
 * JDBC ResultSetを2次元配列に変換する（ヘッダー付き）
 * @param {JdbcResultSet} rs
 * @returns {{headers: string[], rows: Array[]}}
 */
function resultSetToArray_(rs) {
  var meta = rs.getMetaData();
  var colCount = meta.getColumnCount();
  var headers = [];
  for (var i = 1; i <= colCount; i++) {
    headers.push(meta.getColumnName(i));
  }
  var rows = [];
  while (rs.next()) {
    var row = [];
    for (var j = 1; j <= colCount; j++) {
      row.push(rs.getString(j));
    }
    rows.push(row);
  }
  return { headers: headers, rows: rows };
}
