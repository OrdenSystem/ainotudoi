/**
 * 帳票マスタ複製登録 データ移行スクリプト
 * ソース: スプレッドシート 1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4 / シート「帳票マスタ複製登録」
 * ターゲット: CloudSQL "帳票マスタ複製登録" テーブル (33列)
 *
 * 使い方: GAS Script Editorで migrate_02_hyohyo_master() を実行
 */

var MASTER_SOURCE_SS_ID = "1fctnRiWXxTacGKfbfk-UhVO0FTrdK-uI5usm_HDTgv4";
var MASTER_SOURCE_SHEET = "帳票マスタ複製登録";
var MASTER_TABLE = '"帳票マスタ複製登録"';
var MASTER_BATCH_SIZE = 100;

var MASTER_COLUMNS = [
  "帳票マスタ複製登録ID",
  "利用者在籍ID",
  "利用者氏名",
  "職員在籍ID",
  "職員氏名",
  "事業所名",
  "事業所名称",
  "ひな型帳票マスタID",
  "帳票名",
  "&&項目名&&_カンマリスト",
  "スプシURL",
  "登録日時",
  "更新日時",
  "UserMail",
  "展開フラグ",
  "展開日時",
  "展開UserMail",
  "展開処理結果",
  "サイン",
  "サイン日時",
  "帳票完了フラグ",
  "帳票作成日時",
  "帳票作成UserMail",
  "帳票作成処理結果",
  "自動フラグ",
  "File",
  "表示非表示",
  "登録年月",
  "提供年月_事業所_利用者在籍",
  "引用項目_帳票ID",
  "引用項目_子リストID",
  "引用フラグ",
  "引用日時",
];

var MASTER_BOOL_COLS = {
  展開フラグ: true,
  帳票完了フラグ: true,
  自動フラグ: true,
  表示非表示: true,
};

var MASTER_TS_COLS = {
  登録日時: true,
  更新日時: true,
  展開日時: true,
  サイン日時: true,
  帳票作成日時: true,
};

function migrate_02_hyohyo_master() {
  Logger.log("=== 帳票マスタ複製登録 データ移行開始 ===");

  var ss = SpreadsheetApp.openById(MASTER_SOURCE_SS_ID);
  var sheet = ss.getSheetByName(MASTER_SOURCE_SHEET);
  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var dataRows = allData.slice(1);

  Logger.log("ソース行数: " + dataRows.length);

  var headerIdx = {};
  for (var i = 0; i < headers.length; i++) {
    headerIdx[String(headers[i]).trim()] = i;
  }

  var missingCols = [];
  for (var c = 0; c < MASTER_COLUMNS.length; c++) {
    if (headerIdx[MASTER_COLUMNS[c]] === undefined) {
      missingCols.push(MASTER_COLUMNS[c]);
    }
  }
  if (missingCols.length > 0) {
    Logger.log("WARNING: 見つからないカラム: " + missingCols.join(", "));
  }

  var conn = getCloudSqlConnection_();
  var stmt = null;

  try {
    conn.setAutoCommit(false);

    // ダミーデータ削除
    stmt = conn.prepareStatement(
      "DELETE FROM " + MASTER_TABLE + ' WHERE "帳票マスタ複製登録ID" = ?',
    );
    stmt.setString(1, "TEST-001");
    stmt.executeUpdate();
    stmt.close();

    var placeholders = MASTER_COLUMNS.map(function () {
      return "?";
    }).join(", ");
    var colNames = MASTER_COLUMNS.map(function (c) {
      return '"' + c + '"';
    }).join(", ");
    var insertSql =
      "INSERT INTO " +
      MASTER_TABLE +
      " (" +
      colNames +
      ") VALUES (" +
      placeholders +
      ') ON CONFLICT ("帳票マスタ複製登録ID") DO NOTHING';

    stmt = conn.prepareStatement(insertSql);

    var inserted = 0;
    var skipped = 0;

    for (var r = 0; r < dataRows.length; r++) {
      var row = dataRows[r];
      var pkIdx = headerIdx["帳票マスタ複製登録ID"];
      var pkVal = pkIdx !== undefined ? String(row[pkIdx]).trim() : "";
      if (!pkVal) {
        skipped++;
        continue;
      }

      for (var p = 0; p < MASTER_COLUMNS.length; p++) {
        var colName = MASTER_COLUMNS[p];
        var srcIdx = headerIdx[colName];
        var val = srcIdx !== undefined ? row[srcIdx] : null;

        setMasterParam_(stmt, p + 1, colName, val);
      }

      stmt.addBatch();
      inserted++;

      if (inserted % MASTER_BATCH_SIZE === 0) {
        stmt.executeBatch();
        Logger.log("  " + inserted + "行 INSERT済み...");
      }
    }

    if (inserted % MASTER_BATCH_SIZE !== 0) {
      stmt.executeBatch();
    }

    conn.commit();
    Logger.log("INSERT完了: " + inserted + "行 (スキップ: " + skipped + "行)");

    // 検証
    stmt.close();
    stmt = conn.prepareStatement("SELECT COUNT(*) FROM " + MASTER_TABLE);
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();

    Logger.log(
      "=== 検証: ソース=" + dataRows.length + ", DB=" + dbCount + " ===",
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

  Logger.log("=== 帳票マスタ複製登録 データ移行完了 ===");
}

function setMasterParam_(stmt, paramIndex, colName, val) {
  if (val === null || val === undefined || val === "") {
    stmt.setNull(paramIndex, 0);
    return;
  }
  if (MASTER_BOOL_COLS[colName]) {
    stmt.setBoolean(
      paramIndex,
      val === true || val === "TRUE" || val === "true" || val === 1,
    );
    return;
  }
  if (MASTER_TS_COLS[colName]) {
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
  stmt.setString(paramIndex, String(val));
}
