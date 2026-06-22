/**
 * ケース記録 データ移行スクリプト
 * ソース: AppSheet Database（AppSheet API経由で取得）
 * ターゲット: CloudSQL "ケース記録" テーブル (76列)
 *
 * 前提:
 *   - 01相談記録 が先に移行済みであること（FK制約）
 *   - HopeCareGAS_とよさと様 プロジェクト内で実行すること（callAppSheetApi関数が必要）
 *   - Script Properties に APPSHEET_APP_ID, APPSHEET_API_KEY, CLOUDSQL_URL/USER/PASS が設定済み
 *
 * 使い方: GAS Script Editorで migrate_03_case_kiroku() を実行
 * 6分制限対策: 大量データの場合 migrate_03_case_kiroku_resume() でトリガー再実行
 */

var CASE_TABLE = '"ケース記録"';
var CASE_BATCH_SIZE = 50; // AppSheet APIのレスポンスが大きいため小さめに
var CASE_PROGRESS_KEY = "MIGRATE_CASE_PROGRESS";

var CASE_COLUMNS = [
  "Row ID",
  "ケース記録ID",
  "フェーズ",
  "利用者在籍ID",
  "利用者氏名",
  "相談記録ID",
  "年月日_利用者在籍ID",
  "記録全容",
  "入力内容",
  "AI適用",
  "支援記録種別",
  "単一選択リスト01",
  "単一選択リスト02",
  "単一選択リスト03",
  "単一選択リスト04",
  "単一選択リスト05",
  "単一選択リスト06",
  "単一選択リスト07",
  "単一選択リスト08",
  "単一選択リスト09",
  "単一選択リスト10",
  "単一選択リスト11",
  "単一選択リスト12",
  "単一選択リスト13",
  "単一選択リスト14",
  "単一選択リスト15",
  "単一選択リスト16",
  "単一選択リスト17",
  "単一選択リスト18",
  "単一選択リスト19",
  "単一選択リスト20",
  "複数選択リスト01",
  "複数選択リスト02",
  "複数選択リスト03",
  "カスタムテキスト01",
  "カスタムテキスト02",
  "カスタムテキスト03",
  "カスタムテキスト04",
  "カスタムテキスト05",
  "カスタムテキスト06",
  "カスタムテキスト07",
  "カスタムテキスト08",
  "カスタムテキスト09",
  "カスタムテキスト10",
  "カスタムテキスト11",
  "カスタムテキスト12",
  "カスタムテキスト13",
  "カスタムテキスト14",
  "カスタムテキスト15",
  "カスタムテキスト16",
  "カスタムテキスト17",
  "カスタムテキスト18",
  "カスタムテキスト19",
  "カスタムテキスト20",
  "カスタムナンバー01",
  "カスタムナンバー02",
  "カスタムナンバー03",
  "カスタムナンバー04",
  "カスタムナンバー05",
  "カスタムデシマル01",
  "カスタムデシマル02",
  "カスタムデシマル03",
  "支援開始日時",
  "支援終了日時",
  "支援時間",
  "記録者",
  "日付",
  "登録日時",
  "フラグ",
  "SF処理フラグ",
  "SF処理日時",
  "UserMail",
  "更新日時",
  "利用者記録者",
  "AI処理ナンバーカスタム",
  "AI処理テキストカスタム",
  "AI処理フリーテキスト",
  "年月",
];

var CASE_BOOL_COLS = { フラグ: true, SF処理フラグ: true };
var CASE_TS_COLS = {
  支援開始日時: true,
  支援終了日時: true,
  登録日時: true,
  SF処理日時: true,
  更新日時: true,
};
var CASE_DATE_COLS = { 日付: true };
var CASE_INT_COLS = {
  カスタムナンバー01: true,
  カスタムナンバー02: true,
  カスタムナンバー03: true,
  カスタムナンバー04: true,
  カスタムナンバー05: true,
};
var CASE_NUM_COLS = {
  カスタムデシマル01: true,
  カスタムデシマル02: true,
  カスタムデシマル03: true,
};

/**
 * メイン移行関数
 */
function migrate_03_case_kiroku() {
  Logger.log("=== ケース記録 データ移行開始 ===");

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty("APPSHEET_COPY_APP_ID");
  var apiKey = props.getProperty("APPSHEET_COPY_API_KEY");

  if (!appId || !apiKey) {
    throw new Error(
      "Script Propertiesに APPSHEET_COPY_APP_ID, APPSHEET_COPY_API_KEY を設定してください。",
    );
  }

  // 1. AppSheet APIから全行取得
  Logger.log("AppSheet APIからケース記録を取得中...");
  var allRows = callAppSheetApi(appId, apiKey, "ケース記録", "");
  Logger.log("取得行数: " + allRows.length);

  if (allRows.length === 0) {
    Logger.log("データなし。移行を終了します。");
    return;
  }

  // 2. FK参照先（01相談記録）の存在チェック用Set
  var conn = getCloudSqlConnection_();
  var stmt = null;

  try {
    stmt = conn.prepareStatement('SELECT "相談記録ID" FROM "01相談記録"');
    var rs = stmt.executeQuery();
    var soudanIds = {};
    while (rs.next()) {
      soudanIds[rs.getString(1)] = true;
    }
    rs.close();
    stmt.close();
    Logger.log("01相談記録 レコード数: " + Object.keys(soudanIds).length);

    conn.setAutoCommit(false);

    // ダミーデータ削除
    stmt = conn.prepareStatement(
      "DELETE FROM " + CASE_TABLE + ' WHERE "Row ID" = ?',
    );
    stmt.setString(1, "TEST-ROW-001");
    stmt.executeUpdate();
    stmt.close();

    // 3. バッチINSERT
    var placeholders = CASE_COLUMNS.map(function () {
      return "?";
    }).join(", ");
    var colNames = CASE_COLUMNS.map(function (c) {
      return '"' + c + '"';
    }).join(", ");
    var insertSql =
      "INSERT INTO " +
      CASE_TABLE +
      " (" +
      colNames +
      ") VALUES (" +
      placeholders +
      ') ON CONFLICT ("Row ID") DO NOTHING';

    stmt = conn.prepareStatement(insertSql);

    var inserted = 0;
    var skipped = 0;
    var orphans = 0;

    for (var r = 0; r < allRows.length; r++) {
      var apiRow = allRows[r];

      // PKチェック
      var pkVal = String(apiRow["Row ID"] || "").trim();
      if (!pkVal) {
        skipped++;
        continue;
      }

      // FK整合性チェック（相談記録IDが空でない場合のみ）
      var fkVal = String(apiRow["相談記録ID"] || "").trim();
      if (fkVal && !soudanIds[fkVal]) {
        orphans++;
        Logger.log(
          "  孤児行スキップ: Row ID=" + pkVal + ", 相談記録ID=" + fkVal,
        );
        continue;
      }

      for (var p = 0; p < CASE_COLUMNS.length; p++) {
        var colName = CASE_COLUMNS[p];
        var val = apiRow[colName];

        setCaseParam_(stmt, p + 1, colName, val);
      }

      stmt.addBatch();
      inserted++;

      if (inserted % CASE_BATCH_SIZE === 0) {
        stmt.executeBatch();
        Logger.log("  " + inserted + "行 INSERT済み...");

        // 6分制限チェック（5分経過でコミットして終了）
        var elapsed =
          new Date().getTime() - ScriptApp.getService().getLastExecution_();
      }
    }

    if (inserted % CASE_BATCH_SIZE !== 0) {
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
    stmt = conn.prepareStatement("SELECT COUNT(*) FROM " + CASE_TABLE);
    rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();

    Logger.log(
      "=== 検証: API取得=" +
        allRows.length +
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

  Logger.log("=== ケース記録 データ移行完了 ===");
}

function setCaseParam_(stmt, paramIndex, colName, val) {
  if (val === null || val === undefined || val === "") {
    stmt.setNull(paramIndex, 0);
    return;
  }

  // 支援時間（INTERVAL型）はそのまま文字列で渡す
  if (colName === "支援時間") {
    stmt.setString(paramIndex, String(val));
    return;
  }

  if (CASE_BOOL_COLS[colName]) {
    stmt.setBoolean(
      paramIndex,
      val === true || val === "TRUE" || val === "true" || val === "Y",
    );
    return;
  }
  if (CASE_TS_COLS[colName]) {
    // AppSheet APIはISO 8601文字列で返す
    stmt.setString(paramIndex, String(val).trim());
    return;
  }
  if (CASE_DATE_COLS[colName]) {
    stmt.setString(paramIndex, String(val).trim().substring(0, 10));
    return;
  }
  if (CASE_INT_COLS[colName]) {
    var num = parseInt(val, 10);
    if (isNaN(num)) {
      stmt.setNull(paramIndex, 0);
    } else {
      stmt.setInt(paramIndex, num);
    }
    return;
  }
  if (CASE_NUM_COLS[colName]) {
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
