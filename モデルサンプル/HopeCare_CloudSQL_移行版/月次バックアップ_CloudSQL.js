/**
 * 月次データCSVバックアップ
 *
 * 対象テーブル: 01相談記録、ケース記録、帳票マスタ複製登録、帳票子レコード複製登録
 * 出力: CSV（前月差分）をDriveに保存
 *
 * 実行方法:
 *   - 定時トリガー: monthlyBackup_CloudSQL() を毎月1日に設定
 *   - 手動実行: monthlyBackupManual_CloudSQL("202603") で任意の年月を指定
 *
 * 将来拡張:
 *   - サマリーレポートPDF生成
 *   - 前年度比較スプレッドシート（グラフ付き）
 *   ※ 上記は別関数として追加可能な構造にしています
 *
 * 依存: 000_CloudSQL接続.js, Slack通知.js
 */

// ==================================================================================
// 設定（Script Property "BACKUP_PARENT_FOLDER_ID" から取得、000_AppConfig.js 参照）
// ==================================================================================
var BACKUP_PARENT_FOLDER_ID = getConfigId_('BACKUP_PARENT_FOLDER_ID');

var BACKUP_TABLES = [
  { name: '01相談記録', dateCol: '登録日時', updateCol: '更新日時' }
  // 以下は必要に応じて有効化
  // ,{ name: 'ケース記録', dateCol: '登録日時', updateCol: '更新日時' }
  // ,{ name: '帳票マスタ複製登録', dateCol: '登録日時', updateCol: '更新日時' }
  // ,{ name: '帳票子レコード複製登録', dateCol: '登録日時', updateCol: '更新日時' }
];

// ==================================================================================
// メイン: 定時トリガー用（前月分を自動実行）
// ==================================================================================
function monthlyBackup_CloudSQL() {
  var now = new Date();
  var prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var yyyymm = Utilities.formatDate(prevMonth, 'Asia/Tokyo', 'yyyyMM');
  executeMonthlyBackup_(yyyymm);
}

// ==================================================================================
// メイン: 手動実行用（年月指定）
// ==================================================================================
function monthlyBackupManual_CloudSQL(targetYYYYMM) {
  if (!targetYYYYMM || !/^\d{6}$/.test(targetYYYYMM)) {
    Logger.log('年月を YYYYMM 形式で指定してください（例: 202603）');
    return;
  }
  executeMonthlyBackup_(targetYYYYMM);
}

// ==================================================================================
// 共通実行処理
// ==================================================================================
function executeMonthlyBackup_(yyyymm) {
  var startTime = new Date();
  Logger.log('=== 月次CSVバックアップ開始: ' + yyyymm + ' ===');

  try {
    var year = parseInt(yyyymm.substring(0, 4), 10);
    var month = parseInt(yyyymm.substring(4, 6), 10);
    var startDate = Utilities.formatDate(new Date(year, month - 1, 1), 'Asia/Tokyo', 'yyyy-MM-dd');
    var endDate = Utilities.formatDate(new Date(year, month, 1), 'Asia/Tokyo', 'yyyy-MM-dd');

    // 保存先フォルダ作成
    var parentFolder = DriveApp.getFolderById(BACKUP_PARENT_FOLDER_ID);
    var folderIter = parentFolder.getFoldersByName(yyyymm);
    var targetFolder = folderIter.hasNext() ? folderIter.next() : parentFolder.createFolder(yyyymm);

    // 1接続で全テーブルのCSVを出力
    var conn;
    var results = [];
    try {
      conn = getCloudSqlConnection_();

      for (var i = 0; i < BACKUP_TABLES.length; i++) {
        var table = BACKUP_TABLES[i];
        var count = exportTableToCsv_(conn, table.name, table.dateCol, table.updateCol, startDate, endDate, yyyymm, targetFolder);
        results.push(table.name + ': ' + count + '件');
        Logger.log('  ' + table.name + ' → ' + count + '件');
      }
    } finally {
      closeCloudSql_(conn);
    }

    var elapsed = Math.round((new Date() - startTime) / 1000);
    Logger.log('=== 完了 (' + elapsed + '秒) ===');
    sendSlackNotification('✅ 月次CSVバックアップ完了 (' + yyyymm + ')\n' + results.join('\n') + '\n処理時間: ' + elapsed + '秒');

  } catch (e) {
    Logger.log('エラー: ' + e.message);
    sendSlackNotification('❌ 月次CSVバックアップエラー (' + yyyymm + '): ' + e.message);
  }
}

// ==================================================================================
// CSV出力: 1テーブル分（接続を受け取って使い回す）
// ==================================================================================
function exportTableToCsv_(conn, tableName, dateCol, updateCol, startDate, endDate, yyyymm, folder) {
  var stmt, rs;
  try {
    var sql = 'SELECT * FROM "' + tableName + '" WHERE '
      + '("' + dateCol + '" >= ? AND "' + dateCol + '" < ?) '
      + 'OR ("' + updateCol + '" >= ? AND "' + updateCol + '" < ?) '
      + 'ORDER BY "' + dateCol + '"';

    stmt = conn.prepareStatement(sql);
    stmt.setString(1, startDate);
    stmt.setString(2, endDate);
    stmt.setString(3, startDate);
    stmt.setString(4, endDate);
    rs = stmt.executeQuery();

    var meta = rs.getMetaData();
    var colCount = meta.getColumnCount();
    var headers = [];
    for (var i = 1; i <= colCount; i++) headers.push(meta.getColumnName(i));

    var csvLines = [headers.map(function(h) { return '"' + h.replace(/"/g, '""') + '"'; }).join(',')];

    var rowCount = 0;
    while (rs.next()) {
      var cells = [];
      for (var j = 1; j <= colCount; j++) {
        cells.push('"' + String(rs.getString(j) || '').replace(/"/g, '""') + '"');
      }
      csvLines.push(cells.join(','));
      rowCount++;
    }

    var bom = '\uFEFF';
    var blob = Utilities.newBlob(bom + csvLines.join('\r\n'), 'text/csv', tableName + '_' + yyyymm + '.csv');
    folder.createFile(blob);

    return rowCount;
  } finally {
    closeCloudSql_(null, stmt, rs);
  }
}

// ==================================================================================
// テスト: 前月分でCSV出力
// ==================================================================================
function test_monthlyBackup_CloudSQL() {
  var now = new Date();
  var prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var yyyymm = Utilities.formatDate(prevMonth, 'Asia/Tokyo', 'yyyyMM');
  Logger.log('テスト実行: ' + yyyymm);
  executeMonthlyBackup_(yyyymm);
}
