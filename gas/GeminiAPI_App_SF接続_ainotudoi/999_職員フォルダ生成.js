// ==================================================
// 職員用 設定エリア
// ==================================================

// 職員フォルダのルートID（Script Property "STAFF_ROOT_FOLDER_ID" から取得、000_AppConfig.js 参照）
const STAFF_ROOT_ID = getConfigId_('STAFF_ROOT_FOLDER_ID');

// ==================================================
// 職員用 メイン処理
// ==================================================

/**
 * 【職員用】
 * 階層: 職員ルート -> サービス種別(ServiceType__c) -> 職員名(GoogleFolderName__c)
 * 作成後、職員名フォルダのURLをSalesforceに書き戻す
 */
function syncStaffFoldersToSalesforce() {
  // 1. Salesforceから対象データを取得
  // 必要な項目: Id, GoogleFolderName__c, ServiceType__c
  const soql = "SELECT Id, GoogleFolderName__c, ServiceType__c FROM StaffStatus__c WHERE GoogleURL__c = null AND GoogleFolderName__c != null AND ServiceType__c != null LIMIT 90";
  
  try {
    const response = doQuery(soql);
    const responseBody = JSON.parse(response.getContentText());
    
    if (!responseBody.records || responseBody.records.length === 0) {
      console.log("【職員用】処理対象のレコードがありませんでした。");
      return;
    }

    const records = responseBody.records;
    console.log(`【職員用】${records.length} 件のレコードを取得しました。処理を開始します...`);

    const rootFolder = DriveApp.getFolderById(STAFF_ROOT_ID);

    // 2. レコードごとにフォルダ処理
    records.forEach(record => {
      const googleFolderName = record.GoogleFolderName__c;
      const serviceType = record.ServiceType__c;

      // 念のため必須項目の再チェック
      if (!googleFolderName || !serviceType) {
         console.warn(`ID: ${record.Id} はフォルダ名またはサービス種別が空のためスキップします。`);
         return;
      }

      try {
        // --- Driveフォルダ階層の確認・作成 ---
        // 階層1: サービス種別フォルダ
        const serviceFolder = ensureFolder(rootFolder, serviceType);

        // 階層2: 職員名フォルダ
        const staffFolder = ensureFolder(serviceFolder, googleFolderName);
        
        // URLを取得 (職員名フォルダのURL)
        const targetUrl = staffFolder.getUrl();

        // --- Salesforceへの書き戻し ---
        const updateField = {
          "GoogleURL__c": targetUrl
        };

        console.log(`ID: ${record.Id} (種別:${serviceType} / 氏名:${googleFolderName}) のURLを更新します。`);
        
        fetchSF('StaffStatus__c', record.Id, updateField);

      } catch (e) {
        console.error(`ID: ${record.Id} の処理中にエラーが発生しました: ${e.message}`);
      }
    });

    console.log("【職員用】全件の処理が完了しました。");

  } catch (e) {
    console.error("【職員用】全体処理でエラーが発生しました: " + e.message);
  }
}
