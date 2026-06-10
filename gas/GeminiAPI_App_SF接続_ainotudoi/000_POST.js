/**
 * =================================================================================
 * Salesforce連携用 Web API (受信側)
 * 機能: UpdateGoogleUrl (GASからのGoogleフォルダURL更新)
 * 対象オブジェクト: CustomerStatus__c
 * =================================================================================
 */

function doPost(e) {
  console.log("----- [doPost] Salesforceリクエスト受信開始 -----");

  try {
    const rawContent = e.postData.contents;
    const requestData = JSON.parse(rawContent);

    // セキュリティ: 共有トークン検証（不一致なら 401）
    const expectedToken = PropertiesService.getScriptProperties().getProperty('WEBAPP_SHARED_TOKEN');
    if (!expectedToken) {
      console.error("[doPost] WEBAPP_SHARED_TOKEN が未設定（受信側の構成不備）");
      return ContentService.createTextOutput(JSON.stringify({ error: 'Server misconfigured' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (requestData.token !== expectedToken) {
      console.warn("[doPost] 認証失敗: トークン不一致");
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // =======================================================
    // 処理ルート: Salesforce連携 (functionプロパティがある場合)
    // =======================================================
    if (requestData.function) {
      const funcName = requestData.function;
      const parameters = requestData.parameters || {};

      console.log(`[Salesforceルート] 指定機能: ${funcName}`);

      if (funcName === 'UpdateGoogleUrl') {
        const result = processUpdateGoogleUrl(parameters);
        return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
      } else if (funcName === 'enrichCaseRecord') {
        // 機能②: 利用者コンテキスト連動の追記処理（102_HopeContextRecorder.js）
        // AppSheet Automation が同期呼出し、戻り値の text を後続 Edit ステップで列に書き戻す前提。
        const result = enrichCaseRecord_(parameters);
        return ContentService.createTextOutput(JSON.stringify(result))
          .setMimeType(ContentService.MimeType.JSON);
      } else if (funcName === 'ping') {
        // 認証テスト用: トークン検証を通過したら pong を返す（実処理なし）
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          message: 'pong',
          timestamp: new Date().toISOString()
        })).setMimeType(ContentService.MimeType.JSON);
      } else {
        console.warn("未知のSalesforce機能:", funcName);
        return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown function' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // functionプロパティがない場合
    console.warn("不正なリクエストフォーマット");
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid request format' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    // クライアント返却は固定文言。詳細は console.error / GCP Cloud Logging で確認する。
    console.error('doPost uncaught: ' + (error && error.message ? error.message : String(error)));
    return ContentService.createTextOutput(JSON.stringify({ error: 'Internal server error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * UpdateGoogleUrl 処理本体
 */
function processUpdateGoogleUrl(parameters) {
  const zaisekiID = parameters.zaisekiID;
  const folderUrl = parameters.folderUrl;

  // 在籍ID と Drive フォルダ URL の組み合わせは個人特定可能。
  // 末尾4文字のみのマスク表記でログ出力する（102_HopeContextRecorder.js#maskId_ と同方針）。
  const maskedId = (typeof maskId_ === 'function') ? maskId_(zaisekiID) : '****';
  console.log(`[UpdateGoogleUrl] ID: ${maskedId}, URL: (omitted)`);

  if (!zaisekiID || !folderUrl) {
    console.error("必須パラメータ不足"); 
    return JSON.stringify({ error: '必須パラメータ不足 (zaisekiID または folderUrl)' });
  }

  const fieldData = { "GoogleURL__c": folderUrl };

  try {
    // ※ fetchSF関数が同じプロジェクト内にある前提です
    fetchSF('CustomerStatus__c', zaisekiID, fieldData);
    return JSON.stringify({ success: true, message: 'Update process executed' });
  } catch (e) {
    console.error("SF更新処理失敗:", e.toString()); 
    return JSON.stringify({ error: 'Update process failed: ' + e.toString() });
  }
}