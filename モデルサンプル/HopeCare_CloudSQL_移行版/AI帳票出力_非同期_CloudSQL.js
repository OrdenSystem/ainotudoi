/**
 * AI帳票出力 非同期処理 CloudSQL版
 *
 * 現行: スプシ「AIジョブリスト」をキューに使用
 * 本版: CloudSQL「AIジョブキュー」テーブルに置換
 *
 * テーブル:
 *   - "AIジョブキュー" : ジョブ管理（スプシキュー代替）
 *   - "出力先ファイル" : AI処理結果の書込先（AppSheet API代替）
 *
 * 依存: 000_CloudSQL接続.js (getCloudSqlConnection_(), closeCloudSql_(), resultSetToArray_())
 */

// ==================================================================================
// 定数
// ==================================================================================
var LOG_MAX_LENGTH_CSQ = 4500;

// ==================================================================================
// AppSheetから呼び出され、ジョブをCloudSQLに登録する関数
// ※現行 startAsyncProcessFileAI_ver4 の CloudSQL版
// ==================================================================================
function startAsyncProcessFileAI_CloudSQL(
  folderURL, googleFolderName, caseNamePDF, reportFiles,
  rowID, ssURL, sheetName, textCategory, prompt,
  temperature, topP, tg_FileName, tg_AddFilUrl, ID, parentid
) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var jobId = Utilities.getUuid();
    var payload = JSON.stringify({
      folderURL: folderURL,
      googleFolderName: googleFolderName,
      caseNamePDF: caseNamePDF,
      reportFiles: reportFiles,
      rowID: rowID,
      ssURL: ssURL,
      sheetName: sheetName,
      textCategory: textCategory,
      prompt: prompt,
      temperature: temperature,
      topP: topP,
      tg_FileName: tg_FileName,
      tg_AddFilUrl: tg_AddFilUrl,
      ID: ID,
      parentid: parentid
    });

    var sql = 'INSERT INTO "AIジョブキュー" ("ジョブID", "登録日時", "ジョブタイプ", "ペイロード", "状態") VALUES (?, NOW(), ?, ?, ?)';
    stmt = conn.prepareStatement(sql);
    stmt.setString(1, jobId);
    stmt.setString(2, 'GeminiFileAI帳票処理');
    stmt.setString(3, payload);
    stmt.setString(4, 'Pending');
    stmt.executeUpdate();

    // 即時実行トリガーを作成
    triggerDispatcherAsync_CloudSQL_();

    return '受付完了：ただちに処理を開始します';

  } catch (e) {
    var errorMessage = '非同期処理の開始に失敗: ' + e.message;
    Logger.log(errorMessage);
    return 'エラー: ' + e.message;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

// ==================================================================================
// 処理を即時開始するための補助関数（使い捨てトリガー作成）
// ==================================================================================
function triggerDispatcherAsync_CloudSQL_() {
  try {
    var trigger = ScriptApp.newTrigger('dispatcher_CloudSQL')
      .timeBased()
      .after(100)
      .create();

    var props = PropertiesService.getScriptProperties();
    props.setProperty('TEMP_TRIG_' + trigger.getUniqueId(), String(Date.now()));

  } catch (e) {
    Logger.log('即時実行トリガーの作成に失敗（定時実行で処理されます）: ' + e.message);
  }
}

// ==================================================================================
// 古い一時トリガーを掃除する関数
// ==================================================================================
function cleanUpOldTriggers_CloudSQL_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();
    var now = Date.now();
    var THRESHOLD = 5 * 60 * 1000;

    var tempTriggerIds = Object.keys(allProps).filter(function(key) {
      return key.startsWith('TEMP_TRIG_');
    });
    if (tempTriggerIds.length === 0) return;

    var allTriggers = ScriptApp.getProjectTriggers();
    var triggerMap = {};
    allTriggers.forEach(function(t) { triggerMap[t.getUniqueId()] = t; });

    tempTriggerIds.forEach(function(key) {
      var timestamp = parseInt(allProps[key], 10);
      var triggerId = key.replace('TEMP_TRIG_', '');
      if (now - timestamp > THRESHOLD) {
        if (triggerMap[triggerId]) {
          try { ScriptApp.deleteTrigger(triggerMap[triggerId]); } catch (e) { /* ignore */ }
        }
        props.deleteProperty(key);
      }
    });
  } catch (e) {
    Logger.log('トリガークリーンアップ中にエラー: ' + e.message);
  }
}

// ==================================================================================
// ディスパッチャー CloudSQL版
// ※スプシの代わりにCloudSQLからPendingジョブを取得・排他制御
// ==================================================================================
function dispatcher_CloudSQL() {
  cleanUpOldTriggers_CloudSQL_();

  var conn, stmt, rs;
  try {
    conn = getCloudSqlConnection_();
    conn.setAutoCommit(false);

    var start = Date.now();

    // 1. タイムアウトリカバリ（10分超のProcessingをPendingに戻す）
    stmt = conn.prepareStatement(
      'UPDATE "AIジョブキュー" SET "状態" = ?, "ログ" = ? WHERE "状態" = ? AND "更新日時" < NOW() - INTERVAL \'10 minutes\''
    );
    stmt.setString(1, 'Pending');
    stmt.setString(2, 'タイムアウト検知のためリトライ');
    stmt.setString(3, 'Processing');
    var recovered = stmt.executeUpdate();
    conn.commit();
    if (recovered > 0) Logger.log('リカバリ: ' + recovered + '件をPendingに戻しました');
    closeCloudSql_(null, stmt);

    // 2. ジョブ実行ループ
    while ((Date.now() - start) < 300000) { // 5分ガード
      // Pendingジョブを1件取得（FOR UPDATE SKIP LOCKEDで排他制御）
      stmt = conn.prepareStatement(
        'SELECT "ジョブID", "ジョブタイプ", "ペイロード" FROM "AIジョブキュー" WHERE "状態" = ? ORDER BY "登録日時" ASC LIMIT 1 FOR UPDATE SKIP LOCKED'
      );
      stmt.setString(1, 'Pending');
      rs = stmt.executeQuery();

      if (!rs.next()) {
        closeCloudSql_(null, stmt, rs);
        break; // Pendingジョブなし
      }

      var jobId = rs.getString('ジョブID');
      var jobType = rs.getString('ジョブタイプ');
      var payload = JSON.parse(rs.getString('ペイロード'));
      closeCloudSql_(null, stmt, rs);

      // Processing に更新
      stmt = conn.prepareStatement(
        'UPDATE "AIジョブキュー" SET "状態" = ?, "更新日時" = NOW() WHERE "ジョブID" = ?'
      );
      stmt.setString(1, 'Processing');
      stmt.setString(2, jobId);
      stmt.executeUpdate();
      conn.commit();
      closeCloudSql_(null, stmt);

      // ジョブ実行
      try {
        var result = runJob_CloudSQL_(jobType, payload);
        markJobComplete_CloudSQL_(conn, jobId, 'Done', result);
      } catch (e) {
        Logger.log('Job failed (JobID: ' + jobId + '): ' + e.message);
        var errMsg = (e.message || String(e)).substring(0, LOG_MAX_LENGTH_CSQ);
        markJobComplete_CloudSQL_(conn, jobId, 'Failed', errMsg);

        // 出力先ファイルにもエラーを書込
        if (payload.ID) {
          try { updateAiResult_CloudSQL(payload.ID, 'エラー: ' + errMsg.substring(0, 200)); } catch (e2) { /* ignore */ }
        }
      }
    }

  } catch (e) {
    Logger.log('dispatcher_CloudSQL エラー: ' + e.message);
    try { conn.rollback(); } catch (e2) { /* ignore */ }
  } finally {
    closeCloudSql_(conn);
  }
}

// ==================================================================================
// ジョブ完了/失敗をCloudSQLに記録
// ==================================================================================
function markJobComplete_CloudSQL_(conn, jobId, status, logMessage) {
  var stmt;
  try {
    var log = logMessage ? logMessage.substring(0, LOG_MAX_LENGTH_CSQ) : '';
    stmt = conn.prepareStatement(
      'UPDATE "AIジョブキュー" SET "状態" = ?, "更新日時" = NOW(), "ログ" = ? WHERE "ジョブID" = ?'
    );
    stmt.setString(1, status);
    stmt.setString(2, log);
    stmt.setString(3, jobId);
    stmt.executeUpdate();
    conn.commit();
  } finally {
    closeCloudSql_(null, stmt);
  }
}

// ==================================================================================
// ジョブ実行（現行 runJob と同じ構造）
// ==================================================================================
function runJob_CloudSQL_(jobType, payload) {
  switch (jobType) {
    case 'GeminiFileAI帳票処理':
      var p = payload;
      var executionResult = AppsheetGeminiFileAI_CloudSQL(
        p.folderURL, p.googleFolderName, p.caseNamePDF, p.reportFiles,
        p.rowID, p.ssURL, p.sheetName, p.textCategory,
        p.prompt, p.temperature, p.topP, p.tg_FileName, p.tg_AddFilUrl, p.parentid
      );

      if (executionResult.indexOf('❌') !== -1 || executionResult.indexOf('🚨') !== -1) {
        throw new Error(executionResult);
      }

      // 結果を出力先ファイルテーブルに直接書込（AppSheet API不要）
      updateAiResult_CloudSQL(p.ID, executionResult);
      return 'AppSheetへ結果送信完了';

    case '帳票スプシ生成':                       
      return runHyohyoSpushiGenerate_(payload);   

    default:
      throw new Error('Unknown job type: ' + jobType);
  }
}

// ==================================================================================
// 出力先ファイル CRUD操作
// ==================================================================================

/**
 * INSERT: 出力先ファイルレコードを登録
 */
function insertShutsuryokusakiFile_CloudSQL(record) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var sql = 'INSERT INTO "出力先ファイル" ('
      + '"出力先ファイルID", "生成帳票種別", "学習ファイル追加", "帳票項目s", '
      + '"利用者ID", "職員ID", "出力フラグ", "フラグ", '
      + '"記録対象期間：始", "記録対象期間：終", "支援記録種別", '
      + '"登録日時", "更新日時", "temperature", "topP", '
      + '"AI帳票出力日時", "AI帳票出力結果", "File"'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

    stmt = conn.prepareStatement(sql);
    stmt.setString(1, record.出力先ファイルID);
    stmt.setString(2, record.生成帳票種別 || null);
    stmt.setString(3, record.学習ファイル追加 || null);
    stmt.setString(4, record.帳票項目s || null);
    stmt.setString(5, record.利用者ID || null);
    stmt.setString(6, record.職員ID || null);
    stmt.setBoolean(7, record.出力フラグ || false);
    stmt.setBoolean(8, record.フラグ || false);

    if (record['記録対象期間：始']) {
      stmt.setDate(9, Jdbc.newDate(new Date(record['記録対象期間：始']).getTime()));
    } else {
      stmt.setNull(9, 0);
    }
    if (record['記録対象期間：終']) {
      stmt.setDate(10, Jdbc.newDate(new Date(record['記録対象期間：終']).getTime()));
    } else {
      stmt.setNull(10, 0);
    }

    stmt.setString(11, record.支援記録種別 || null);

    if (record.登録日時) {
      stmt.setTimestamp(12, Jdbc.newTimestamp(new Date(record.登録日時).getTime()));
    } else {
      stmt.setTimestamp(12, Jdbc.newTimestamp(new Date().getTime()));
    }
    if (record.更新日時) {
      stmt.setTimestamp(13, Jdbc.newTimestamp(new Date(record.更新日時).getTime()));
    } else {
      stmt.setTimestamp(13, Jdbc.newTimestamp(new Date().getTime()));
    }

    if (record.temperature != null) {
      stmt.setDouble(14, parseFloat(record.temperature));
    } else {
      stmt.setNull(14, 0);
    }
    if (record.topP != null) {
      stmt.setDouble(15, parseFloat(record.topP));
    } else {
      stmt.setNull(15, 0);
    }

    if (record.AI帳票出力日時) {
      stmt.setTimestamp(16, Jdbc.newTimestamp(new Date(record.AI帳票出力日時).getTime()));
    } else {
      stmt.setNull(16, 0);
    }
    stmt.setString(17, record.AI帳票出力結果 || null);
    stmt.setString(18, record.File || null);

    stmt.executeUpdate();
    return record.出力先ファイルID;

  } catch (e) {
    Logger.log('insertShutsuryokusakiFile_CloudSQL エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

/**
 * SELECT: 出力先ファイルIDで1件取得
 */
function getShutsuryokusakiFileById_CloudSQL(fileId) {
  var conn, stmt, rs;
  try {
    conn = getCloudSqlConnection_();
    var sql = 'SELECT * FROM "出力先ファイル" WHERE "出力先ファイルID" = ?';
    stmt = conn.prepareStatement(sql);
    stmt.setString(1, fileId);
    rs = stmt.executeQuery();

    if (rs.next()) {
      return {
        出力先ファイルID: rs.getString('出力先ファイルID'),
        生成帳票種別: rs.getString('生成帳票種別'),
        学習ファイル追加: rs.getString('学習ファイル追加'),
        帳票項目s: rs.getString('帳票項目s'),
        利用者ID: rs.getString('利用者ID'),
        職員ID: rs.getString('職員ID'),
        出力フラグ: rs.getBoolean('出力フラグ'),
        フラグ: rs.getBoolean('フラグ'),
        '記録対象期間：始': rs.getString('記録対象期間：始'),
        '記録対象期間：終': rs.getString('記録対象期間：終'),
        支援記録種別: rs.getString('支援記録種別'),
        登録日時: rs.getString('登録日時'),
        更新日時: rs.getString('更新日時'),
        temperature: rs.getString('temperature'),
        topP: rs.getString('topP'),
        AI帳票出力日時: rs.getString('AI帳票出力日時'),
        AI帳票出力結果: rs.getString('AI帳票出力結果'),
        File: rs.getString('File')
      };
    }
    return null;

  } catch (e) {
    Logger.log('getShutsuryokusakiFileById_CloudSQL エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}

/**
 * UPDATE: AI帳票出力結果を更新（GAS非同期処理の結果書込用）
 */
function updateAiResult_CloudSQL(fileId, resultMessage) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var sql = 'UPDATE "出力先ファイル" SET "AI帳票出力結果" = ?, "AI帳票出力日時" = ?, "更新日時" = ? WHERE "出力先ファイルID" = ?';
    stmt = conn.prepareStatement(sql);
    stmt.setString(1, resultMessage);
    stmt.setTimestamp(2, Jdbc.newTimestamp(new Date().getTime()));
    stmt.setTimestamp(3, Jdbc.newTimestamp(new Date().getTime()));
    stmt.setString(4, fileId);
    return stmt.executeUpdate();

  } catch (e) {
    Logger.log('updateAiResult_CloudSQL エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

/**
 * UPDATE: フラグ更新（Automation「フラグを戻す」ステップ相当）
 */
function updateFlag_CloudSQL(fileId, flagValue) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var sql = 'UPDATE "出力先ファイル" SET "フラグ" = ?, "更新日時" = ? WHERE "出力先ファイルID" = ?';
    stmt = conn.prepareStatement(sql);
    stmt.setBoolean(1, flagValue);
    stmt.setTimestamp(2, Jdbc.newTimestamp(new Date().getTime()));
    stmt.setString(3, fileId);
    return stmt.executeUpdate();

  } catch (e) {
    Logger.log('updateFlag_CloudSQL エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

// ==================================================================================
// テスト関数
// ==================================================================================

/**
 * テスト: 出力先ファイル テーブル構造確認
 */
function test_shutsuryokusakiFile_CloudSQL() {
  var conn, stmt, rs;
  try {
    conn = getCloudSqlConnection_();
    stmt = conn.prepareStatement(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '出力先ファイル' ORDER BY ordinal_position"
    );
    rs = stmt.executeQuery();
    var result = resultSetToArray_(rs);
    Logger.log('=== 出力先ファイル テーブル構造 ===');
    result.rows.forEach(function(row) { Logger.log('  ' + row[0] + ': ' + row[1]); });
    Logger.log('カラム数: ' + result.rows.length);

    closeCloudSql_(null, stmt, rs);
    stmt = conn.prepareStatement('SELECT COUNT(*) as cnt FROM "出力先ファイル"');
    rs = stmt.executeQuery();
    if (rs.next()) Logger.log('レコード数: ' + rs.getInt('cnt'));
    Logger.log('✅ テスト完了');
  } catch (e) {
    Logger.log('❌ テストエラー: ' + e.message);
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}

/**
 * テスト: ジョブキューの登録→取得→完了の一連フロー
 */
function test_jobQueue_CloudSQL() {
  var conn, stmt, rs;
  try {
    conn = getCloudSqlConnection_();

    // 1. テストジョブを登録
    var testJobId = 'test-' + Utilities.getUuid();
    stmt = conn.prepareStatement(
      'INSERT INTO "AIジョブキュー" ("ジョブID", "ジョブタイプ", "ペイロード", "状態") VALUES (?, ?, ?, ?)'
    );
    stmt.setString(1, testJobId);
    stmt.setString(2, 'テスト');
    stmt.setString(3, '{"test": true}');
    stmt.setString(4, 'Pending');
    stmt.executeUpdate();
    Logger.log('1. ジョブ登録OK: ' + testJobId);
    closeCloudSql_(null, stmt);

    // 2. Pending取得確認
    stmt = conn.prepareStatement(
      'SELECT "ジョブID", "状態" FROM "AIジョブキュー" WHERE "ジョブID" = ?'
    );
    stmt.setString(1, testJobId);
    rs = stmt.executeQuery();
    if (rs.next()) Logger.log('2. 状態確認: ' + rs.getString('状態'));
    closeCloudSql_(null, stmt, rs);

    // 3. 完了に更新
    stmt = conn.prepareStatement(
      'UPDATE "AIジョブキュー" SET "状態" = ?, "更新日時" = NOW(), "ログ" = ? WHERE "ジョブID" = ?'
    );
    stmt.setString(1, 'Done');
    stmt.setString(2, 'テスト完了');
    stmt.setString(3, testJobId);
    stmt.executeUpdate();
    Logger.log('3. 完了更新OK');
    closeCloudSql_(null, stmt);

    // 4. クリーンアップ
    stmt = conn.prepareStatement('DELETE FROM "AIジョブキュー" WHERE "ジョブID" = ?');
    stmt.setString(1, testJobId);
    stmt.executeUpdate();
    Logger.log('4. クリーンアップOK');

    Logger.log('✅ ジョブキューテスト完了');
  } catch (e) {
    Logger.log('❌ ジョブキューテストエラー: ' + e.message);
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}
