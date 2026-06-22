/**
 * 01相談記録 データ移行スクリプト
 * ソース: スプレッドシート 1J4j78mX0nB41QWJY8i_ibwh2VVA8tAlu8NEihVdfHTs / シート「01相談記録」
 * ターゲット: CloudSQL "01相談記録" テーブル (55列)
 *
 * 使い方: GAS Script Editorで migrate_01_soudan() を実行
 * 前提: Script Properties に CLOUDSQL_URL, CLOUDSQL_USER, CLOUDSQL_PASS が設定済み
 */

var SOUDAN_SOURCE_SS_ID = "1J4j78mX0nB41QWJY8i_ibwh2VVA8tAlu8NEihVdfHTs";
var SOUDAN_SOURCE_SHEET = "01相談記録";
var SOUDAN_TABLE = '"01相談記録"';
var SOUDAN_BATCH_SIZE = 100;

// PostgreSQL DDL に合わせたカラム定義
var SOUDAN_COLUMNS = [
  "相談記録ID",
  "表示フラグ",
  "自動化フラグ",
  "フラグ日時",
  "年月日_利用者在籍ID",
  "PDF",
  "年齢_登録時点",
  "相談No",
  "タイトル",
  "事業区分",
  "利用者ID",
  "利用者在籍ID",
  "利用者氏名",
  "職員在籍ID",
  "相談事業所",
  "相談種別",
  "相談者_本人との関係",
  "連携先の機関",
  "相談者_親族等",
  "相談者_支援機関等",
  "登録日時",
  "更新日時",
  "記録日",
  "年月",
  "日",
  "フラグ",
  "UserMail",
  "相談方法",
  "基幹​相談​支援事業_種別",
  "基幹​相談​支援_基礎的事業_取組項目",
  "基幹​相談​支援_機能強化事業_取組項目",
  "委託相談_支援種別",
  "地域活動支援センターⅠ型_種別",
  "地域活動支援Ⅰ型_基礎的事業_取組項目",
  "地域活動支援Ⅰ型_機能強化事業_取組項目",
  "地域移行_請求対象",
  "認証ケアマネ_業務区別",
  "認証ケアマネ_支援種別",
  "基本報酬",
  "加算",
  "区分選択肢",
  "市町村",
  "市町村番号",
  "再請求フラグ",
  "実費1",
  "実費2",
  "ピアカウンセラー",
  "障害種別",
  "外国ルーツ",
  "関係",
  "担当者",
  "区分",
  "集",
  "項目",
  "本人状況",
  "世帯状況",
];

// BOOLEAN型カラム名のSet
var SOUDAN_BOOL_COLS = {
  表示フラグ: true,
  自動化フラグ: true,
  フラグ: true,
  再請求フラグ: true,
  ピアカウンセラー: true,
};

// TIMESTAMP型カラム名のSet
var SOUDAN_TS_COLS = {
  フラグ日時: true,
  登録日時: true,
  更新日時: true,
};

// DATE型カラム名のSet
var SOUDAN_DATE_COLS = {
  記録日: true,
};

// INTEGER型カラム名のSet
var SOUDAN_INT_COLS = {
  年齢_登録時点: true,
  相談No: true,
};

/**
 * メイン移行関数
 */
function migrate_01_soudan() {
  Logger.log("=== 01相談記録 データ移行開始 ===");

  // 1. スプレッドシートからデータ読み取り
  var ss = SpreadsheetApp.openById(SOUDAN_SOURCE_SS_ID);
  var sheet = ss.getSheetByName(SOUDAN_SOURCE_SHEET);
  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var dataRows = allData.slice(1);

  Logger.log("ソース行数: " + dataRows.length);
  Logger.log("ヘッダー数: " + headers.length);

  // 2. ヘッダーからカラムインデックスを構築
  var headerIdx = {};
  for (var i = 0; i < headers.length; i++) {
    headerIdx[String(headers[i]).trim()] = i;
  }

  // スプレッドシート→DB カラム名マッピング（カッコ→アンダースコア変換等）
  var SS_TO_DB_MAP = {
    "相談者(親族等)": "相談者_親族等",
    "相談者(支援機関等)": "相談者_支援機関等",
  };
  for (var key in SS_TO_DB_MAP) {
    if (
      headerIdx[key] !== undefined &&
      headerIdx[SS_TO_DB_MAP[key]] === undefined
    ) {
      headerIdx[SS_TO_DB_MAP[key]] = headerIdx[key];
    }
  }

  // 移行対象カラムのインデックス確認
  var missingCols = [];
  for (var c = 0; c < SOUDAN_COLUMNS.length; c++) {
    if (headerIdx[SOUDAN_COLUMNS[c]] === undefined) {
      missingCols.push(SOUDAN_COLUMNS[c]);
    }
  }
  if (missingCols.length > 0) {
    Logger.log(
      "WARNING: スプレッドシートに見つからないカラム: " +
        missingCols.join(", "),
    );
  }

  // 3. CloudSQL接続
  var conn = getCloudSqlConnection_();
  var stmt = null;

  try {
    conn.setAutoCommit(false);

    // ダミーデータ削除（FK依存: ケース記録 → 01相談記録 の順で削除）
    stmt = conn.prepareStatement(
      'DELETE FROM "ケース記録" WHERE "相談記録ID" = ?',
    );
    stmt.setString(1, "TEST-SOUDAN-001");
    stmt.executeUpdate();
    stmt.close();
    Logger.log("ケース記録ダミーデータ削除完了");

    stmt = conn.prepareStatement(
      "DELETE FROM " + SOUDAN_TABLE + ' WHERE "相談記録ID" = ?',
    );
    stmt.setString(1, "TEST-SOUDAN-001");
    stmt.executeUpdate();
    stmt.close();
    Logger.log("01相談記録ダミーデータ削除完了");

    // 4. バッチINSERT
    var placeholders = SOUDAN_COLUMNS.map(function () {
      return "?";
    }).join(", ");
    var colNames = SOUDAN_COLUMNS.map(function (c) {
      return '"' + c + '"';
    }).join(", ");
    var insertSql =
      "INSERT INTO " +
      SOUDAN_TABLE +
      " (" +
      colNames +
      ") VALUES (" +
      placeholders +
      ') ON CONFLICT ("相談記録ID") DO NOTHING';

    stmt = conn.prepareStatement(insertSql);

    var inserted = 0;
    var skipped = 0;

    for (var r = 0; r < dataRows.length; r++) {
      var row = dataRows[r];

      // PKが空の行はスキップ
      var pkIdx = headerIdx["相談記録ID"];
      var pkVal = pkIdx !== undefined ? String(row[pkIdx]).trim() : "";
      if (!pkVal) {
        skipped++;
        continue;
      }

      for (var p = 0; p < SOUDAN_COLUMNS.length; p++) {
        var colName = SOUDAN_COLUMNS[p];
        var srcIdx = headerIdx[colName];
        var val = srcIdx !== undefined ? row[srcIdx] : null;

        setParameterByType_(stmt, p + 1, colName, val);
      }

      stmt.addBatch();
      inserted++;

      if (inserted % SOUDAN_BATCH_SIZE === 0) {
        stmt.executeBatch();
        Logger.log("  " + inserted + "行 INSERT済み...");
      }
    }

    // 残りを実行
    if (inserted % SOUDAN_BATCH_SIZE !== 0) {
      stmt.executeBatch();
    }

    conn.commit();
    Logger.log("INSERT完了: " + inserted + "行 (スキップ: " + skipped + "行)");

    // 5. 検証
    stmt.close();
    stmt = conn.prepareStatement("SELECT COUNT(*) FROM " + SOUDAN_TABLE);
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();

    Logger.log("=== 検証結果 ===");
    Logger.log("ソース行数: " + dataRows.length);
    Logger.log("CloudSQL行数: " + dbCount);
    Logger.log("一致: " + (dbCount === inserted ? "OK" : "NG - 要確認"));
  } catch (e) {
    Logger.log("ERROR: " + e.message);
    try {
      conn.rollback();
    } catch (re) {}
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }

  Logger.log("=== 01相談記録 データ移行完了 ===");
}

/**
 * カラム型に応じてprepareStatementにパラメータをセットする
 */
function setParameterByType_(stmt, paramIndex, colName, val) {
  // null/undefined/空文字列 → NULL
  if (val === null || val === undefined || val === "") {
    stmt.setNull(paramIndex, 0);
    return;
  }

  // BOOLEAN
  if (SOUDAN_BOOL_COLS[colName]) {
    var boolVal = val === true || val === "TRUE" || val === "true" || val === 1;
    stmt.setBoolean(paramIndex, boolVal);
    return;
  }

  // TIMESTAMP
  if (SOUDAN_TS_COLS[colName]) {
    if (val instanceof Date) {
      stmt.setString(
        paramIndex,
        Utilities.formatDate(val, "Asia/Tokyo", "yyyy-MM-dd'T'HH:mm:ssXXX"),
      );
    } else {
      var s = String(val).trim();
      stmt.setString(paramIndex, s || null);
    }
    return;
  }

  // DATE
  if (SOUDAN_DATE_COLS[colName]) {
    if (val instanceof Date) {
      stmt.setString(
        paramIndex,
        Utilities.formatDate(val, "Asia/Tokyo", "yyyy-MM-dd"),
      );
    } else {
      var ds = String(val).trim();
      stmt.setString(paramIndex, ds || null);
    }
    return;
  }

  // INTEGER
  if (SOUDAN_INT_COLS[colName]) {
    var num = parseInt(val, 10);
    if (isNaN(num)) {
      stmt.setNull(paramIndex, 0);
    } else {
      stmt.setInt(paramIndex, num);
    }
    return;
  }

  // その他 TEXT/VARCHAR
  stmt.setString(paramIndex, String(val));
}
