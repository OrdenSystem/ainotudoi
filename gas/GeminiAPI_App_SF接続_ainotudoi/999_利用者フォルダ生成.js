// ==================================================
// 設定エリア
// ==================================================

// 利用者フォルダのルートID（Script Property "USER_ROOT_FOLDER_ID" から取得、000_AppConfig.js 参照）
const ROOT_FOLDER_ID = getConfigId_('USER_ROOT_FOLDER_ID');

// ==================================================
// メイン処理
// ==================================================

/**
 * Salesforceからレコードを取得し、フォルダ階層を作成後、
 * 利用者フォルダのURLをSalesforceに書き戻すメイン関数
 */
function syncDriveFoldersToSalesforce() {
  // 1. Salesforceから対象データを取得
  // 条件: GoogleURL__c が空、かつフォルダ作成に必要な名称があるもの
  const soql = "SELECT Id, OfficeName__c, GoogleFolderName__c FROM CustomerStatus__c WHERE GoogleURL__c = null AND OfficeName__c != null AND GoogleFolderName__c != null LIMIT 90";
  
  try {
    // 既存の doQuery 関数を利用
    const response = doQuery(soql);
    const responseBody = JSON.parse(response.getContentText());
    
    if (!responseBody.records || responseBody.records.length === 0) {
      console.log("処理対象のレコードがありませんでした。");
      return;
    }

    const records = responseBody.records;
    console.log(`${records.length} 件のレコードを取得しました。フォルダ作成処理を開始します...`);

    const rootFolder = DriveApp.getFolderById(ROOT_FOLDER_ID);

    // 2. レコードごとにフォルダ処理とSalesforce更新を実行
    records.forEach(record => {
      const officeName = record.OfficeName__c;
      const googleFolderName = record.GoogleFolderName__c;

      try {
        // --- Driveフォルダ階層の確認・作成 ---
        // 階層: Root(指定ID) -> OfficeName__c -> GoogleFolderName__c -> 帳票PDF
        
        // 1. 事業所フォルダ
        const officeFolder = ensureFolder(rootFolder, officeName);
        
        // 2. 利用者フォルダ
        const userFolder = ensureFolder(officeFolder, googleFolderName);
        
        // 3. 帳票PDFフォルダ (作成のみ行う)
        ensureFolder(userFolder, "帳票PDF"); 

        // ★要件: 利用者フォルダ(GoogleFolderName__c)のURLを取得
        const targetUrl = userFolder.getUrl();

        // --- Salesforceへの書き戻し ---
        // 既存の fetchSF 関数を利用して更新
        const updateField = {
          "GoogleURL__c": targetUrl
        };

        console.log(`ID: ${record.Id} (利用者: ${googleFolderName}) のURLを更新します。`);
        
        // fetchSF(OBJECT, ID, FIELD)
        fetchSF('CustomerStatus__c', record.Id, updateField);

      } catch (e) {
        console.error(`ID: ${record.Id} の処理中にエラーが発生しました: ${e.message}`);
      }
    });

    console.log("全件の処理が完了しました。");

  } catch (e) {
    console.error("全体処理でエラーが発生しました (SOQLエラー等の可能性): " + e.message);
  }
}

// ==================================================
// ユーティリティ関数
// ==================================================

/**
 * 親フォルダ内に指定した名前のフォルダが存在すれば取得し、
 * なければ新規作成して返す関数
 * * @param {GoogleAppsScript.Drive.Folder} parentFolder - 親フォルダ
 * @param {string} folderName - 対象フォルダ名
 * @return {GoogleAppsScript.Drive.Folder} 取得または作成されたフォルダ
 */
function ensureFolder(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parentFolder.createFolder(folderName);
  }
}


