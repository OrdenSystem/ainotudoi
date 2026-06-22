/**
 * 新規作成されたフォルダのURLと在籍IDを外部GAS（Salesforce連携用）へPOST送信する関数
 * @param {string} newFolderUrl - 新規作成されたフォルダのURL
 * @param {string} zaisekiID - Salesforceの対象レコードID (StaffStatus__cのID)
 */
function postFolderUrlToExternalApp(newFolderUrl, zaisekiID) {
  // 送信先 WebApp URL と共有トークンを Script Properties から取得
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("SF_WEBAPP_URL");
  const token = props.getProperty("WEBAPP_SHARED_TOKEN");
  if (!endpoint || !token) {
    console.error(
      "postFolderUrlToExternalApp: SF_WEBAPP_URL または WEBAPP_SHARED_TOKEN が未設定です",
    );
    return;
  }

  // 受信側のdoPostが期待する形式に合わせる
  const payload = {
    function: "UpdateGoogleUrl", // 受信側で分岐させるための関数名
    token: token, // 受信側の認証用共有トークン
    parameters: {
      zaisekiID: zaisekiID,
      folderUrl: newFolderUrl,
    },
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const responseBody = response.getContentText(); // 中身を取得
    console.log(
      `外部連携結果: ${response.getResponseCode()} / 内容: ${responseBody}`,
    ); // 中身もログに出す
  } catch (e) {
    console.error(
      `外部連携エラー: Salesforceへの連携に失敗しました。詳細: ${e.toString()}`,
    );
  }
}

/**
 * doPost セキュリティ動作確認用テスト関数（手動実行）
 * 受信側 (GeminiAPI_App_SF接続) の共有トークン検証を 3 パターンで検証する。
 *   ① 正規トークン        → success:true, message:'pong' を期待
 *   ② 不正トークン        → error:'Unauthorized' を期待
 *   ③ トークンなし        → error:'Unauthorized' を期待
 *
 * 注意: GAS の WebApp は認証失敗でも HTTP 200 で返ってくる
 *       （ContentService 経由のため）。判定はレスポンス本文の success/error で行う。
 */
function test_doPostSecurity_Ping() {
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("SF_WEBAPP_URL");
  const token = props.getProperty("WEBAPP_SHARED_TOKEN");

  if (!endpoint || !token) {
    Logger.log("❌ SF_WEBAPP_URL または WEBAPP_SHARED_TOKEN が未設定");
    return;
  }

  Logger.log("===== doPost ping テスト開始 =====");
  Logger.log("endpoint: " + endpoint);
  Logger.log("token (先頭8字): " + token.substring(0, 8) + "...");

  var pings = [
    {
      label: "① 正規トークン (success 期待)",
      payload: { function: "ping", token: token },
      expectSuccess: true,
    },
    {
      label: "② 不正トークン (Unauthorized 期待)",
      payload: { function: "ping", token: "invalid-token-xxx-xxx" },
      expectSuccess: false,
    },
    {
      label: "③ トークンなし (Unauthorized 期待)",
      payload: { function: "ping" },
      expectSuccess: false,
    },
  ];

  var passed = 0,
    failed = 0;
  pings.forEach(function (t) {
    var res = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(t.payload),
      muteHttpExceptions: true,
    });
    var body = res.getContentText();
    var parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      parsed = { _raw: body };
    }
    var ok = t.expectSuccess
      ? !!parsed.success
      : !!parsed.error && parsed.error === "Unauthorized";
    Logger.log((ok ? "✅" : "❌") + " " + t.label);
    Logger.log("   status=" + res.getResponseCode() + " / body=" + body);
    if (ok) passed++;
    else failed++;
  });

  Logger.log("===== 結果: ✅ " + passed + " / ❌ " + failed + " =====");
  if (failed > 0) {
    Logger.log(
      "⚠️ 期待通りに動作していません。受信側のデプロイが最新版か確認してください（バージョンを「新しいバージョン」で再デプロイ）。",
    );
  } else {
    Logger.log("✨ 全パターンが期待通りに動作しています");
  }
}
