/**
 * データ移行検証スクリプト
 * 全4テーブルのレコード数・FK整合性・サンプルデータを検証する
 *
 * 使い方: GAS Script Editorで verifyAllTables() を実行
 */

/**
 * 全テーブル一括検証
 */
function verifyAllTables() {
  Logger.log("========================================");
  Logger.log("  データ移行 検証レポート");
  Logger.log("  実行日時: " + new Date().toLocaleString("ja-JP"));
  Logger.log("========================================\n");

  verifySoudanKiroku_();
  verifyHyohyoMaster_();
  verifyHyohyoChild_();
  verifyCaseKiroku_();
  verifyOnseiKirokuTaio_();
  verifyForeignKeys_();

  Logger.log("\n========================================");
  Logger.log("  検証完了");
  Logger.log("========================================");
}

/**
 * 01相談記録 検証
 */
function verifySoudanKiroku_() {
  Logger.log("--- 01相談記録 ---");

  // ソース件数
  var ss = SpreadsheetApp.openById(
    "1J4j78mX0nB41QWJY8i_ibwh2VVA8tAlu8NEihVdfHTs",
  );
  var sheet = ss.getSheetByName("01相談記録");
  var sourceCount = sheet.getLastRow() - 1; // ヘッダー除外

  // DB件数
  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement('SELECT COUNT(*) FROM "01相談記録"');
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log("  ソース: " + sourceCount + "行");
    Logger.log("  CloudSQL: " + dbCount + "行");
    Logger.log("  結果: " + (sourceCount === dbCount ? "OK" : "NG - 差分あり"));

    // サンプル5件
    stmt = conn.prepareStatement(
      'SELECT "相談記録ID", "利用者氏名", "記録日" FROM "01相談記録" ORDER BY "登録日時" DESC LIMIT 5',
    );
    rs = stmt.executeQuery();
    Logger.log("  最新5件サンプル:");
    while (rs.next()) {
      Logger.log(
        "    " +
          rs.getString(1) +
          " / " +
          rs.getString(2) +
          " / " +
          rs.getString(3),
      );
    }
    rs.close();
    stmt.close();
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * 帳票マスタ複製登録 検証
 */
function verifyHyohyoMaster_() {
  Logger.log("--- 帳票マスタ複製登録 ---");

  var ss = SpreadsheetApp.openById(
    "1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4",
  );
  var sheet = ss.getSheetByName("帳票マスタ複製登録");
  var sourceCount = sheet.getLastRow() - 1;

  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement(
      'SELECT COUNT(*) FROM "帳票マスタ複製登録"',
    );
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log("  ソース: " + sourceCount + "行");
    Logger.log("  CloudSQL: " + dbCount + "行");
    Logger.log("  結果: " + (sourceCount === dbCount ? "OK" : "NG - 差分あり"));
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * 帳票子レコード複製登録 検証
 */
function verifyHyohyoChild_() {
  Logger.log("--- 帳票子レコード複製登録 ---");

  var ss = SpreadsheetApp.openById(
    "1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4",
  );
  var sheet = ss.getSheetByName("帳票子レコード複製登録");
  var sourceCount = sheet.getLastRow() - 1;

  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement(
      'SELECT COUNT(*) FROM "帳票子レコード複製登録"',
    );
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log("  ソース: " + sourceCount + "行");
    Logger.log("  CloudSQL: " + dbCount + "行");
    Logger.log(
      "  結果: " +
        (sourceCount <= dbCount ? "OK" : "NG - 差分あり (孤児行を除く)"),
    );
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * ケース記録 検証
 */
function verifyCaseKiroku_() {
  Logger.log("--- ケース記録 ---");

  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement('SELECT COUNT(*) FROM "ケース記録"');
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log("  CloudSQL: " + dbCount + "行");
    Logger.log("  ※ ソース(AppSheet DB)の件数はAPI経由で別途確認してください");

    // サンプル5件
    stmt = conn.prepareStatement(
      'SELECT "Row ID", "利用者氏名", "日付" FROM "ケース記録" ORDER BY "更新日時" DESC LIMIT 5',
    );
    rs = stmt.executeQuery();
    Logger.log("  最新5件サンプル:");
    while (rs.next()) {
      Logger.log(
        "    " +
          rs.getString(1) +
          " / " +
          rs.getString(2) +
          " / " +
          rs.getString(3),
      );
    }
    rs.close();
    stmt.close();
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * 音声記録対応 検証（CloudSQL 移行 6 番目、2026-04-29 追加）
 *
 * チェック項目:
 *   - 行数（AppSheet API vs CloudSQL）
 *   - 文字起こしテキスト 最大長（5000 超のレコードがあれば AppSheet Database では保存できなかったもの = 移行の意義）
 *   - 必須列の NULL 件数
 */
function verifyOnseiKirokuTaio_() {
  Logger.log("--- 音声記録対応 ---");

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty("APPSHEET_APP_ID");
  var apiKey = props.getProperty("APPSHEET_API_KEY");

  // ソース件数（AppSheet API 経由）
  var apiCount = -1;
  if (appId && apiKey) {
    try {
      var apiRows = callAppSheetApi(appId, apiKey, "音声記録対応", "");
      apiCount = apiRows.length;
    } catch (e) {
      Logger.log(
        "  AppSheet API 取得失敗（CloudSQL 切替後はこれで正常）: " + e.message,
      );
    }
  } else {
    Logger.log(
      "  Script Properties 未設定のため AppSheet API カウントスキップ",
    );
  }

  var conn = getCloudSqlConnection_();
  try {
    // 行数
    var stmt = conn.prepareStatement('SELECT COUNT(*) FROM "音声記録対応"');
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();
    stmt.close();

    if (apiCount >= 0) {
      Logger.log("  AppSheet API: " + apiCount + "行");
    }
    Logger.log("  CloudSQL  : " + dbCount + "行");
    if (apiCount >= 0) {
      Logger.log(
        "  結果      : " + (apiCount === dbCount ? "OK" : "NG - 差分あり"),
      );
    }

    // 文字起こしテキスト最大長
    stmt = conn.prepareStatement(
      'SELECT MAX(length("文字起こしテキスト")) FROM "音声記録対応" WHERE "文字起こしテキスト" IS NOT NULL',
    );
    rs = stmt.executeQuery();
    if (rs.next()) {
      var maxLen = rs.getInt(1);
      Logger.log("  文字起こしテキスト最大長: " + maxLen + " 文字");
      if (maxLen > 5000) {
        Logger.log(
          "  ✅ 5,000 文字超のレコードあり → CloudSQL 移行で初めて保存可能になった",
        );
      }
    }
    rs.close();
    stmt.close();

    // 5000超レコード件数
    stmt = conn.prepareStatement(
      'SELECT COUNT(*) FROM "音声記録対応" WHERE length("文字起こしテキスト") > 5000',
    );
    rs = stmt.executeQuery();
    rs.next();
    var over5kCount = rs.getInt(1);
    rs.close();
    stmt.close();
    Logger.log("  5000文字超のレコード: " + over5kCount + "件");

    // 必須列 NULL 件数（Row ID は PK で NULL 不可なのでチェック対象外）
    stmt = conn.prepareStatement(
      "SELECT " +
        'COUNT(*) FILTER (WHERE "音声ファイル名" IS NULL OR "音声ファイル名" = \'\') AS null_filename, ' +
        'COUNT(*) FILTER (WHERE "作成日" IS NULL) AS null_sakusei, ' +
        'COUNT(*) FILTER (WHERE "登録日時" IS NULL) AS null_toroku ' +
        'FROM "音声記録対応"',
    );
    rs = stmt.executeQuery();
    if (rs.next()) {
      Logger.log("  音声ファイル名 NULL: " + rs.getInt(1) + "件");
      Logger.log("  作成日       NULL: " + rs.getInt(2) + "件");
      Logger.log("  登録日時     NULL: " + rs.getInt(3) + "件");
    }
    rs.close();
    stmt.close();

    // サンプル5件
    stmt = conn.prepareStatement(
      'SELECT "Row ID", "音声ファイル名", "作成日", length("文字起こしテキスト") ' +
        'FROM "音声記録対応" ' +
        'ORDER BY "登録日時" DESC NULLS LAST LIMIT 5',
    );
    rs = stmt.executeQuery();
    Logger.log("  最新5件サンプル (RowID / ファイル名 / 作成日 / 文字数):");
    while (rs.next()) {
      Logger.log(
        "    " +
          rs.getString(1) +
          " / " +
          rs.getString(2) +
          " / " +
          rs.getString(3) +
          " / " +
          rs.getInt(4),
      );
    }
    rs.close();
    stmt.close();
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * FK整合性検証
 */
function verifyForeignKeys_() {
  Logger.log("--- FK整合性チェック ---");

  var conn = getCloudSqlConnection_();
  try {
    // ケース記録 → 01相談記録
    var stmt = conn.prepareStatement(
      'SELECT COUNT(*) FROM "ケース記録" WHERE "相談記録ID" IS NOT NULL AND "相談記録ID" NOT IN (SELECT "相談記録ID" FROM "01相談記録")',
    );
    var rs = stmt.executeQuery();
    rs.next();
    var caseOrphans = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log(
      "  ケース記録 → 01相談記録: 孤児行 " +
        caseOrphans +
        "件 " +
        (caseOrphans === 0 ? "OK" : "NG"),
    );

    // 帳票子レコード → 帳票マスタ
    stmt = conn.prepareStatement(
      'SELECT COUNT(*) FROM "帳票子レコード複製登録" WHERE "帳票マスタ複製登録ID" NOT IN (SELECT "帳票マスタ複製登録ID" FROM "帳票マスタ複製登録")',
    );
    rs = stmt.executeQuery();
    rs.next();
    var childOrphans = rs.getInt(1);
    rs.close();
    stmt.close();

    Logger.log(
      "  帳票子レコード → 帳票マスタ: 孤児行 " +
        childOrphans +
        "件 " +
        (childOrphans === 0 ? "OK" : "NG"),
    );
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * ダミーデータ全削除
 */
function deleteAllDummyData() {
  Logger.log("=== ダミーデータ削除 ===");

  var conn = getCloudSqlConnection_();
  try {
    conn.setAutoCommit(false);

    // 子テーブルから先に削除（FK制約のため）
    var stmts = [
      'DELETE FROM "ケース記録" WHERE "Row ID" = \'TEST-ROW-001\'',
      'DELETE FROM "帳票子レコード複製登録" WHERE "帳票子レコード複製登録ID" = \'TEST-CHILD-001\'',
      'DELETE FROM "01相談記録" WHERE "相談記録ID" = \'TEST-SOUDAN-001\'',
      'DELETE FROM "帳票マスタ複製登録" WHERE "帳票マスタ複製登録ID" = \'TEST-001\'',
    ];

    for (var i = 0; i < stmts.length; i++) {
      var stmt = conn.prepareStatement(stmts[i]);
      var deleted = stmt.executeUpdate();
      Logger.log(
        "  " + stmts[i].substring(0, 50) + "... → " + deleted + "行削除",
      );
      stmt.close();
    }

    conn.commit();
    Logger.log("ダミーデータ削除完了");
  } catch (e) {
    Logger.log("ERROR: " + e.message);
    try {
      conn.rollback();
    } catch (re) {}
    throw e;
  } finally {
    closeCloudSql_(conn);
  }
}
