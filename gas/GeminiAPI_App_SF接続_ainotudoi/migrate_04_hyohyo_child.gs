/**
 * 帳票子レコード複製登録 データ移行スクリプト
 * ソース: スプレッドシート 1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4 / シート「帳票子レコード複製登録」
 * ターゲット: CloudSQL "帳票子レコード複製登録" テーブル (25列)
 *
 * 前提: 帳票マスタ複製登録 が先に移行済みであること（FK制約）
 * 使い方: GAS Script Editorで migrate_04_hyohyo_child() を実行
 */

var CHILD_SOURCE_SS_ID = "1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4";
var CHILD_SOURCE_SHEET = "帳票子レコード複製登録";
var CHILD_TABLE = '"帳票子レコード複製登録"';
var CHILD_BATCH_SIZE = 100;

var CHILD_COLUMNS = [
  "帳票子レコード複製登録ID",
  "帳票マスタ複製登録ID",
  "帳票名",
  "&&項目名&&",
  "シート名セル位置",
  "項目データ型選択",
  "表示用順位付け",
  "日付",
  "日時",
  "テキスト",
  "ロングテキスト",
  "単一選択肢",
  "複数選択肢",
  "数値",
  "数値_小数点",
  "パーセント",
  "電話番号",
  "メールアドレス",
  "URL",
  "住所",
  "画像",
  "ファイル",
  "登録日時",
  "更新日時",
  "UserMail",
];

var CHILD_TS_COLS = { 日時: true, 登録日時: true, 更新日時: true };
var CHILD_DATE_COLS = { 日付: true };
var CHILD_INT_COLS = { 表示用順位付け: true, 数値: true };
var CHILD_NUM_COLS = { 数値_小数点: true, パーセント: true };

function migrate_04_hyohyo_child() {
  Logger.log("=== 帳票子レコード複製登録 データ移行開始 ===");

  var ss = SpreadsheetApp.openById(CHILD_SOURCE_SS_ID);
  var sheet = ss.getSheetByName(CHILD_SOURCE_SHEET);
  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var dataRows = allData.slice(1);

  Logger.log("ソース行数: " + dataRows.length);

  var headerIdx = {};
  for (var i = 0; i < headers.length; i++) {
    headerIdx[String(headers[i]).trim()] = i;
  }

  var conn = getCloudSqlConnection_();
  var stmt = null;

  try {
    conn.setAutoCommit(false);

    // ダミーデータ削除
    stmt = conn.prepareStatement(
      "DELETE FROM " + CHILD_TABLE + ' WHERE "帳票子レコード複製登録ID" = ?',
    );
    stmt.setString(1, "TEST-CHILD-001");
    stmt.executeUpdate();
    stmt.close();

    // FK参照先（帳票マスタ）の存在チェック用Setを構築
    stmt = conn.prepareStatement(
      'SELECT "帳票マスタ複製登録ID" FROM "帳票マスタ複製登録"',
    );
    var rs = stmt.executeQuery();
    var masterIds = {};
    while (rs.next()) {
      masterIds[rs.getString(1)] = true;
    }
    rs.close();
    stmt.close();
    Logger.log("帳票マスタ レコード数: " + Object.keys(masterIds).length);

    var placeholders = CHILD_COLUMNS.map(function () {
      return "?";
    }).join(", ");
    var colNames = CHILD_COLUMNS.map(function (c) {
      return '"' + c + '"';
    }).join(", ");
    var insertSql =
      "INSERT INTO " +
      CHILD_TABLE +
      " (" +
      colNames +
      ") VALUES (" +
      placeholders +
      ') ON CONFLICT ("帳票子レコード複製登録ID") DO NOTHING';

    stmt = conn.prepareStatement(insertSql);

    var inserted = 0;
    var skipped = 0;
    var orphans = 0;

    for (var r = 0; r < dataRows.length; r++) {
      var row = dataRows[r];
      var pkIdx = headerIdx["帳票子レコード複製登録ID"];
      var pkVal = pkIdx !== undefined ? String(row[pkIdx]).trim() : "";
      if (!pkVal) {
        skipped++;
        continue;
      }

      // FK整合性チェック
      var fkIdx = headerIdx["帳票マスタ複製登録ID"];
      var fkVal = fkIdx !== undefined ? String(row[fkIdx]).trim() : "";
      if (!fkVal || !masterIds[fkVal]) {
        orphans++;
        Logger.log("  孤児行スキップ: PK=" + pkVal + ", FK=" + fkVal);
        continue;
      }

      for (var p = 0; p < CHILD_COLUMNS.length; p++) {
        var colName = CHILD_COLUMNS[p];
        var srcIdx = headerIdx[colName];
        var val = srcIdx !== undefined ? row[srcIdx] : null;

        setChildParam_(stmt, p + 1, colName, val);
      }

      stmt.addBatch();
      inserted++;

      if (inserted % CHILD_BATCH_SIZE === 0) {
        stmt.executeBatch();
        Logger.log("  " + inserted + "行 INSERT済み...");
      }
    }

    if (inserted % CHILD_BATCH_SIZE !== 0) {
      stmt.executeBatch();
    }

    conn.commit();
    Logger.log(
      "INSERT完了: " +
        inserted +
        "行 (スキップ: " +
        skipped +
        ", 孤児: " +
        orphans +
        ")",
    );

    // 検証
    stmt.close();
    stmt = conn.prepareStatement("SELECT COUNT(*) FROM " + CHILD_TABLE);
    rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();

    Logger.log(
      "=== 検証: ソース=" +
        dataRows.length +
        ", DB=" +
        dbCount +
        ", 孤児=" +
        orphans +
        " ===",
    );
  } catch (e) {
    Logger.log("ERROR: " + e.message);
    try {
      conn.rollback();
    } catch (re) {}
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }

  Logger.log("=== 帳票子レコード複製登録 データ移行完了 ===");
}

function setChildParam_(stmt, paramIndex, colName, val) {
  if (val === null || val === undefined || val === "") {
    stmt.setNull(paramIndex, 0);
    return;
  }
  if (CHILD_TS_COLS[colName]) {
    if (val instanceof Date) {
      stmt.setString(
        paramIndex,
        Utilities.formatDate(val, "Asia/Tokyo", "yyyy-MM-dd'T'HH:mm:ssXXX"),
      );
    } else {
      stmt.setString(paramIndex, String(val).trim() || null);
    }
    return;
  }
  if (CHILD_DATE_COLS[colName]) {
    if (val instanceof Date) {
      stmt.setString(
        paramIndex,
        Utilities.formatDate(val, "Asia/Tokyo", "yyyy-MM-dd"),
      );
    } else {
      stmt.setString(paramIndex, String(val).trim() || null);
    }
    return;
  }
  if (CHILD_INT_COLS[colName]) {
    var num = parseInt(val, 10);
    if (isNaN(num)) {
      stmt.setNull(paramIndex, 0);
    } else {
      stmt.setInt(paramIndex, num);
    }
    return;
  }
  if (CHILD_NUM_COLS[colName]) {
    var flt = parseFloat(val);
    if (isNaN(flt)) {
      stmt.setNull(paramIndex, 0);
    } else {
      stmt.setDouble(paramIndex, flt);
    }
    return;
  }
  stmt.setString(paramIndex, String(val));
}
