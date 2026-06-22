/**
 * 音声記録対応 データ移行スクリプト
 *
 * ソース  : AppSheet Database（AppSheet API経由で取得）
 * ターゲット: CloudSQL "音声記録対応" テーブル (18列, _RowNumberはAppSheet側自動付与)
 *
 * 背景:
 *   AppSheet Database のバックエンド層に 5,000 文字のハード制限があり、
 *   gemini-2.5-pro V2 プロンプト（maxOutputTokens=65536）の出力が保存できないため、
 *   CloudSQL（text 型 = 実質無制限）に移行する。
 *
 * 前提:
 *   - migrate_06_onsei_kiroku_taio.sql で DDL 適用済み
 *   - Script Properties: APPSHEET_APP_ID, APPSHEET_API_KEY, CLOUDSQL_URL/USER/PASS
 *   - GAS UI から手動実行
 *
 * 設計参考:
 *   - migrate_03_case_kiroku.js (AppSheet API → JDBC INSERT、同パターン)
 *
 * 使い方:
 *   GAS Script Editor で migrate_06_onsei_kiroku_taio() を選択して実行
 *   完了後 verify_migration.js#verifyOnseiKirokuTaio_ でデータ整合性確認
 */

var ONSEI_TABLE = '"音声記録対応"';
var ONSEI_BATCH_SIZE = 50;

// AppSheet テーブル名と CloudSQL 列名の 1:1 対応（19列のうち _RowNumber を除く 18列）
var ONSEI_COLUMNS = [
  "Row ID",
  "音声記録対応ID",
  "音声URL",
  "音声ファイル名",
  "職員在籍ID",
  "オブジェクト名",
  "開始時間",
  "作成日",
  "文字起こしテキスト",
  "利用者在籍ID",
  "利用者ID",
  "ケース記録種別",
  "AI整理_要約",
  "音声入力",
  "登録日時",
  "更新日時",
  "フラグ",
  "処理フラグ",
];

// 型別マッピング
var ONSEI_BOOL_COLS = { フラグ: true, 処理フラグ: true };
var ONSEI_TS_COLS = { 登録日時: true, 更新日時: true };
var ONSEI_DATE_COLS = { 作成日: true };
var ONSEI_TIME_COLS = { 開始時間: true };

/**
 * メイン移行関数。
 * AppSheet API から音声記録対応 全件取得し、CloudSQL に INSERT する。
 */
function migrate_06_onsei_kiroku_taio() {
  Logger.log("=== 音声記録対応 データ移行開始 ===");

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty("APPSHEET_APP_ID");
  var apiKey = props.getProperty("APPSHEET_API_KEY");

  if (!appId || !apiKey) {
    throw new Error(
      "Script Propertiesに APPSHEET_APP_ID, APPSHEET_API_KEY を設定してください。",
    );
  }

  // 1. AppSheet API から全行取得
  Logger.log("AppSheet API から音声記録対応 を取得中...");
  var allRows = callAppSheetApi(appId, apiKey, "音声記録対応", "");
  Logger.log("取得行数: " + allRows.length);

  if (allRows.length === 0) {
    Logger.log("データなし。移行を終了します。");
    return;
  }

  // 文字起こしテキストの最大長を事前ログ（移行できることの確認用）
  var maxTextLen = 0;
  for (var k = 0; k < allRows.length; k++) {
    var t = String(allRows[k]["文字起こしテキスト"] || "");
    if (t.length > maxTextLen) maxTextLen = t.length;
  }
  Logger.log(
    "文字起こしテキスト最大長: " +
      maxTextLen +
      " 文字（CloudSQL text型なので制限なし）",
  );

  // 2. CloudSQL 接続 + バッチ INSERT
  var conn = getCloudSqlConnection_();
  var stmt = null;

  try {
    conn.setAutoCommit(false);

    var placeholders = ONSEI_COLUMNS.map(function () {
      return "?";
    }).join(", ");
    var colNames = ONSEI_COLUMNS.map(function (c) {
      return '"' + c + '"';
    }).join(", ");
    var insertSql =
      "INSERT INTO " +
      ONSEI_TABLE +
      " (" +
      colNames +
      ") VALUES (" +
      placeholders +
      ') ON CONFLICT ("Row ID") DO NOTHING';

    stmt = conn.prepareStatement(insertSql);

    var inserted = 0;
    var skipped = 0;

    for (var r = 0; r < allRows.length; r++) {
      var apiRow = allRows[r];

      // PK チェック
      var pkVal = String(apiRow["Row ID"] || "").trim();
      if (!pkVal) {
        skipped++;
        continue;
      }

      for (var p = 0; p < ONSEI_COLUMNS.length; p++) {
        var colName = ONSEI_COLUMNS[p];
        setOnseiParam_(stmt, p + 1, colName, apiRow[colName]);
      }

      stmt.addBatch();
      inserted++;

      if (inserted % ONSEI_BATCH_SIZE === 0) {
        stmt.executeBatch();
        Logger.log("  " + inserted + "行 INSERT 済み...");
      }
    }

    if (inserted % ONSEI_BATCH_SIZE !== 0) {
      stmt.executeBatch();
    }

    conn.commit();
    Logger.log(
      "INSERT 完了: " + inserted + "行 (PK欠損スキップ: " + skipped + ")",
    );

    // 3. 件数検証
    stmt.close();
    stmt = conn.prepareStatement("SELECT COUNT(*) FROM " + ONSEI_TABLE);
    var rs = stmt.executeQuery();
    rs.next();
    var dbCount = rs.getInt(1);
    rs.close();

    Logger.log(
      "=== 検証: API取得=" +
        allRows.length +
        ", DB=" +
        dbCount +
        ", スキップ=" +
        skipped +
        " ===",
    );
    if (dbCount === allRows.length - skipped) {
      Logger.log("✅ 件数一致（idempotent INSERT のため再実行時も同じ結果）");
    } else {
      Logger.log(
        "⚠️ 件数不一致: 期待=" +
          (allRows.length - skipped) +
          ", 実DB=" +
          dbCount,
      );
    }
  } catch (e) {
    Logger.log("ERROR: " + e.message);
    try {
      conn.rollback();
    } catch (re) {
      /* ignore */
    }
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }

  Logger.log("=== 音声記録対応 データ移行完了 ===");
}

/**
 * 列タイプ別の prepareStatement パラメータ setter。
 * migrate_03_case_kiroku.js#setCaseParam_ と同パターン。
 *
 * @param {JdbcPreparedStatement} stmt
 * @param {number} paramIndex 1-based
 * @param {string} colName
 * @param {*} val
 */
function setOnseiParam_(stmt, paramIndex, colName, val) {
  if (val === null || val === undefined || val === "") {
    stmt.setNull(paramIndex, 0); // SQL.NULL は driver により異なるが 0 (UNKNOWN) で許容される
    return;
  }

  if (ONSEI_BOOL_COLS[colName]) {
    stmt.setBoolean(
      paramIndex,
      val === true || val === "TRUE" || val === "true" || val === "Y",
    );
    return;
  }
  if (ONSEI_TS_COLS[colName]) {
    // AppSheet API は ISO 8601 形式の文字列で返す（PostgreSQL timestamptz が解釈）
    stmt.setString(paramIndex, String(val).trim());
    return;
  }
  if (ONSEI_DATE_COLS[colName]) {
    // 日付部のみ（先頭10文字）
    stmt.setString(paramIndex, String(val).trim().substring(0, 10));
    return;
  }
  if (ONSEI_TIME_COLS[colName]) {
    // 時刻部のみ。AppSheet が "HH:MM:SS" or "HH:MM" 形式で返す前提
    var t = String(val).trim();
    // "20:06" → "20:06:00" のように 8 文字に正規化（PostgreSQL time が解釈）
    if (/^\d{1,2}:\d{2}$/.test(t)) t = t + ":00";
    stmt.setString(paramIndex, t);
    return;
  }

  // text 型: 文字起こしテキスト・AI整理_要約・音声入力 を含む全 string 列
  // PostgreSQL text 型は実質無制限のため、長文（36k超）もそのまま渡す
  stmt.setString(paramIndex, String(val));
}
