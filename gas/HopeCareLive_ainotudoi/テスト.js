function testGetContextFlow() {
  const testUserId = "a03RB00000srmYsYAI"; // ★再度IDを入れてください
  
  console.log("=== テスト開始 ===");
  
  const filter = `Filter(CustomerStatus__c, [Row ID] = '${testUserId}')`;
  const rows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, "CustomerStatus__c", filter);
  
  if (!rows || rows.length === 0) {
    console.log("❌ 利用者データが見つかりません。");
    return;
  }
  const userObj = rows[0];
  console.log("✅ 利用者データ取得成功: " + userObj["CustomerName__c"]);
  
  let urlData = userObj["GoogleURL__c"];
  let url = "";
  try {
    if (typeof urlData === 'string' && urlData.startsWith("{")) {
      url = JSON.parse(urlData).Url || urlData;
    } else {
      url = urlData;
    }
  } catch(e) { url = urlData; }
  
  let folderId = "";
  const m = url.match(/id=([a-zA-Z0-9_-]+)/) || url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) folderId = m[1];
  
  if (!folderId) {
    console.log("❌ フォルダIDが抽出できませんでした。");
    return;
  }
  
  try {
    const chatPdfFolders = DriveApp.getFolderById(folderId).getFoldersByName("ChatPDF");
    if (!chatPdfFolders.hasNext()) {
      console.log("❌ ChatPDFフォルダが見つかりません。");
      return;
    }
    
    const chatPdfFolder = chatPdfFolders.next();
    const files = chatPdfFolder.getFiles();
    let foundContext = false;
    
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      
      if (fileName.includes("AIコンテキスト")) {
        foundContext = true;
        console.log(`👉 対象ファイル発見: ${fileName} (ID: ${file.getId()})`);
        
        // --- 読み込みトライアル ---
        try {
          // パターンA: 標準の読み込み
          const content = file.getBlob().getDataAsString("UTF-8");
          console.log(`✅ [パターンA] 標準ルートで読み込み成功！文字数: ${content.length}`);
        } catch (e) {
          console.log(`⚠️ [パターンA] 失敗: ${e.toString()}`);
          console.log(`🔄 [パターンB] Drive API (UrlFetchApp)での強制読み込みを試します...`);
          
          // パターンB: APIを使った強制読み込みルート
          const fetchUrl = `https://www.googleapis.com/drive/v3/files/${file.getId()}?alt=media`;
          const res = UrlFetchApp.fetch(fetchUrl, {
            headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
            muteHttpExceptions: true
          });
          
          if (res.getResponseCode() === 200) {
            const contentB = res.getContentText("UTF-8");
            console.log(`✅ [パターンB] 強制ルートで読み込み成功！！文字数: ${contentB.length}`);
          } else {
            console.log(`❌ [パターンB] も失敗しました... 原因: ${res.getContentText()}`);
          }
        }
      }
    }
    
    if (!foundContext) console.log("❌ ファイルが一つも見つかりませんでした。");
    
  } catch (e) {
    console.log("❌ 全体エラー: " + e.toString());
  }
  console.log("=== テスト終了 ===");
}



// 権限を強制的に要求するためのダミー関数
function forceAuth() {
  DriveApp.getFiles();
  console.log("✅ Googleドライブへのアクセス権限が許可されました！");
}