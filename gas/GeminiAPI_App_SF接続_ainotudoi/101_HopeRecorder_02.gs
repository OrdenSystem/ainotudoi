// ===========設定（SHEET_ID は Script Property "RECORDER_SHEET_ID" から取得、000_AppConfig.js 参照）
//
// hahaha 環境: GCS_BUCKET_NAME / PROJECT_ID は **意図的に空** にしている。
// hahaha 専用の GCP プロジェクト・GCS バケットを整備してから値を入れて使用する。
// 値が空のまま processTranscriptionWorker / checkJobStatus が呼ばれた場合は
// 各 Worker 冒頭のガードで停止する（本番 GCP への誤発火を防ぐ）。
//
// 本番側（GeminiAPI_App_SF接続_とよさと様）はハードコード値を維持。
// 次スプリントで AppConfig 化（Script Properties 化）する予定。
const GCS_BUCKET_NAME = "";
const SHEET_ID = getConfigId_("RECORDER_SHEET_ID");
const SHEET_NAME = "POST履歴";
// const SALESFORCE_WEBAPP_URL = PropertiesService.getScriptProperties().getProperty('SALESFORCE_WEBAPP_URL');
const PROJECT_ID = "";

// ============================================
// 共通ヘルパー
// ============================================

function extractFileIdFromUrl(url) {
  let fileId = null;
  let match = url.match(/\/d\/([a-zA-Z0-9_-]{25,})\//);
  if (match && match[1]) {
    fileId = match[1];
  } else {
    match = url.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
    if (match && match[1]) {
      fileId = match[1];
    } else {
      match = url.match(/file\/([a-zA-Z0-9_-]{25,})/);
      if (match && match[1]) {
        fileId = match[1];
      }
    }
  }
  // もし上記全てで見つからなければ、最後のフォールバック
  if (!fileId) {
    let m = url.match(/[-\w]{25,}/);
    if (m) fileId = m[0];
  }
  return fileId;
}

// ============================================
// 【修正版】実行ユーザー（あなた）のトークンをそのまま使う関数
// ============================================
function getOAuthServiceAccountToken_() {
  // サービスアカウントキーは使わず、スクリプトを実行しているユーザー（あなた）の権限を使用します
  return ScriptApp.getOAuthToken();
}

// ============================================
// ★接続テスト用：GCSへの単純アップロード
// ============================================
function test_SimpleGcsUpload() {
  // 設定（以前のチャットの内容に合わせています）
  const BUCKET_NAME = "kibou-hopecare-recorder";
  const TEST_FILE_NAME = "connection_test.txt";
  const CONTENT =
    "これはGASからGCSへの接続テストです。\n" + new Date().toString();

  console.log("----- テスト開始 -----");

  // 1. 実行ユーザーの確認（これがIAMに追加したメアドと一致しているか重要）
  const email = Session.getActiveUser().getEmail();
  console.log("実行ユーザー: " + email);

  // 2. トークン取得
  const token = ScriptApp.getOAuthToken();
  if (!token) {
    console.error("❌ トークンが取得できませんでした。");
    return;
  }

  // 3. アップロード実行
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(TEST_FILE_NAME)}`;

  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "text/plain",
      payload: CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 200) {
      console.log("✅ 【成功】GCSへのアップロードに成功しました！");
      console.log("バケット: " + BUCKET_NAME);
      console.log("ファイル名: " + TEST_FILE_NAME);
      console.log("レスポンス: " + body);
      console.log("→ 権限設定は完璧です。本番コードを実行してください。");
    } else {
      console.error("❌ 【失敗】エラーが発生しました。");
      console.error("ステータスコード: " + code);
      console.error("エラー詳細: " + body);

      if (code === 403) {
        console.error("--------------------------------------------------");
        console.error("★原因ヒント: 権限不足です。");
        console.error(
          "1. GASの「プロジェクト設定」でGCPプロジェクト番号が設定されているか？",
        );
        console.error(
          `2. GCPのIAM設定で、ユーザー「${email}」に「Storage オブジェクト管理者」権限があるか？`,
        );
        console.error("--------------------------------------------------");
      }
    }
  } catch (e) {
    console.error("❌ 例外エラー: " + e.message);
  }
  console.log("----- テスト終了 -----");
}

// =========================================================
// 【★トラブルシューティング用】
// この関数を手動で実行して、GASのトークンキャッシュを強制的にクリアします。
// =========================================================
function test_clearAccessTokenCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove("service_account_token"); // getOAuthServiceAccountToken_() で使われているキー
    console.log(
      "アクセストークンのキャッシュ ('service_account_token') を正常に削除しました。",
    );
    SpreadsheetApp.getUi().alert(
      "キャッシュを削除しました。再度Appsheetから処理を実行してください。",
    );
  } catch (e) {
    console.error("キャッシュの削除に失敗しました: " + e.message);
    SpreadsheetApp.getUi().alert(
      "エラー: キャッシュの削除に失敗しました。 " + e.message,
    );
  }
}
