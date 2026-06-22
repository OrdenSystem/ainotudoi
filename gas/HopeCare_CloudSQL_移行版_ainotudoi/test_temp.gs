/**
 * [TEMP] CloudSQL 接続疎通確認
 *
 * 2026-04-25 hahaha 環境への接続確認用。
 * 確認後は削除 or 退役コメント付きで残す。
 */
function test_CloudSQL_quickPing() {
  var conn = null;
  var stmt = null;
  var rs = null;
  try {
    conn = getCloudSqlConnection_();
    stmt = conn.createStatement();

    // 1. バージョン確認
    rs = stmt.executeQuery("SELECT version()");
    if (rs.next()) {
      Logger.log("✅ CloudSQL 接続 OK");
      Logger.log("   version: " + rs.getString(1));
    }
    rs.close();

    // 2. hopecare DB を見ているか確認
    rs = stmt.executeQuery(
      "SELECT current_database(), current_user, inet_server_addr()",
    );
    if (rs.next()) {
      Logger.log("   database: " + rs.getString(1));
      Logger.log("   user: " + rs.getString(2));
      Logger.log("   server_ip: " + rs.getString(3));
    }
    rs.close();

    // 3. スキーマが存在するか（hahaha は空のはずなので 0 行が期待値）
    rs = stmt.executeQuery('SELECT COUNT(*) FROM public."ケース記録"');
    if (rs.next()) {
      Logger.log(
        "   ケース記録 行数: " + rs.getString(1) + " (hahaha なら 0 が期待値)",
      );
    }
  } catch (e) {
    Logger.log("❌ CloudSQL 接続 NG: " + e.message);
    Logger.log("   stack: " + (e.stack || "(なし)"));
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}

/**
 * [TEMP] AppSheet API 疎通確認
 * callAppSheetApi (000_callAppSheetApi.js) 経由で StaffStatus__c を 1 件取得
 */
function test_AppSheet_quickPing() {
  var props = PropertiesService.getScriptProperties();
  var APP_ID = props.getProperty("APPSHEET_APP_ID");
  var API_KEY = props.getProperty("APPSHEET_API_KEY");

  if (!APP_ID || !API_KEY) {
    Logger.log("❌ APPSHEET_APP_ID / APPSHEET_API_KEY 未設定");
    return;
  }

  Logger.log("APP_ID 先頭: " + String(APP_ID).substring(0, 8) + "...");

  try {
    var rows = callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");
    Logger.log("✅ AppSheet API 接続 OK");
    Logger.log("   StaffStatus__c 件数: " + (rows ? rows.length : 0));
    if (rows && rows.length > 0) {
      Logger.log(
        "   1件目のキー(先頭5列): " +
          Object.keys(rows[0]).slice(0, 5).join(", "),
      );
    }
  } catch (e) {
    Logger.log("❌ AppSheet API 接続 NG: " + e.message);
    Logger.log("   stack: " + (e.stack || "(なし)"));
  }
}

function testGeminiApiKey() {
  // 1. スクリプトプロパティからAPI_KEYを取得
  const apiKey = PropertiesService.getScriptProperties().getProperty("API_KEY");

  // キーがセットされていない場合のチェック
  if (!apiKey) {
    Logger.log(
      "❌ エラー: スクリプトプロパティに「API_KEY」が見つかりません。設定を確認してください。",
    );
    return;
  }

  // 2. テスト用のAPIエンドポイントとパラメータ（高速な gemini-1.5-flash モデルを使用）
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: "これはAPIキーのテスト通信です。「テスト成功」とだけ返事をしてください。",
          },
        ],
      },
    ],
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    // muteHttpExceptionsをtrueにすると、エラー時もスクリプトを強制終了せず詳細なエラーメッセージを取得できます
    muteHttpExceptions: true,
  };

  // 3. APIリクエストの実行と結果の検証
  try {
    Logger.log("通信テストを開始します...");
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseBody = JSON.parse(response.getContentText());

    if (responseCode === 200) {
      // HTTPステータスが200(成功)の場合
      Logger.log("✅ テスト成功！ APIキーは有効です。");
      Logger.log(
        "Geminiからの返答: " + responseBody.candidates[0].content.parts[0].text,
      );
    } else {
      // 認証エラーなどの場合
      Logger.log("❌ テスト失敗: API通信でエラーが発生しました。");
      Logger.log("HTTPステータスコード: " + responseCode);

      // エラーの詳細な理由を出力（APIキーが無効、権限がない等）
      if (responseBody.error && responseBody.error.message) {
        Logger.log("エラー詳細: " + responseBody.error.message);
      }
    }
  } catch (e) {
    // ネットワークエラーなどの予期せぬエラー
    Logger.log("⚠️ システムエラーが発生しました: " + e.message);
  }
}

function listAvailableGeminiModels() {
  const apiKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  const options = {
    method: "get",
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());

    if (data.models) {
      Logger.log("✅ 利用可能なモデル一覧:");
      data.models.forEach((model) => {
        // テキスト生成(generateContent)をサポートしているモデルのみを抽出
        if (
          model.supportedGenerationMethods &&
          model.supportedGenerationMethods.includes("generateContent")
        ) {
          Logger.log(model.name);
        }
      });
    } else {
      Logger.log("❌ 取得エラー: " + response.getContentText());
    }
  } catch (e) {
    Logger.log("⚠️ システムエラー: " + e.message);
  }
}
