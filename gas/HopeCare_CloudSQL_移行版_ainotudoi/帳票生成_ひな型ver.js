/**
 * =================================================================================
 * HopeCareGAS 帳票生成 非同期処理スクリプト (完全版 - 待機ロジック適用)
 * ---------------------------------------------------------------------------------
 * 1. スプレッドシートによるジョブキュー管理
 * 2. 単一の定時トリガーによる安定したジョブ実行
 * 3. LockServiceによる同時実行の完全な防止
 * 4. 実行時間監視によるタイムアウトの事前回避
 * 5. スタックしたジョブの自動再試行
 * =================================================================================
 */

// ▼▼▼【設定】Script Property "MASTER_SS_ID" から取得（000_AppConfig.js 参照） ▼▼▼
/** ジョブキューとして使用するスプレッドシートのID */
const SPREADSHEET_ID = getConfigId_('MASTER_SS_ID');

/** ジョブ一覧が記載されているシート名 */
const SHEET_NAME = '非同期帳票出力リスト';

/** 実行時間の上限（GASのタイムアウト6分より短い5分に設定） */
const TIME_LIMIT_MS = 5 * 60 * 1000; 



/**
 * =================================================================================
 * 関数 1: originalFileMake_async (修正版)
 * 役割：ジョブの登録
 * 特徴：AppSheetによるフォルダ作成を待機し、ファイルを配置してキューに登録する
 * =================================================================================
 */
function originalFileMake_async(surceFileUrl, driveURL, textPaste, zaisekiID, fileRecordID, fileName, googleFolderName, customerDriveURL, office) {
  
  console.log(`[Start] originalFileMake_async (待機モード) 開始: ${fileName}`);

  // #１：変数の空チェック
  const missingParams = [];
  if (!surceFileUrl) missingParams.push("ひな型帳票URL (surceFileUrl)");
  if (!textPaste) missingParams.push("セル内テキスト (textPaste)");
  if (!zaisekiID) missingParams.push("在籍ID (zaisekiID)");
  if (!fileRecordID) missingParams.push("帳票マスタID (fileRecordID)");
  if (!fileName) missingParams.push("帳票名 (fileName)");
  if (!googleFolderName) missingParams.push("Googleフォルダ名 (googleFolderName)");
  if (!office) missingParams.push("事業所名 (office)"); // ★追加

  if (missingParams.length > 0) {
    const errorMessage = `${fileName} HopeCareGAS_帳票生成_エラー：必須パラメータ不足: [${missingParams.join(", ")}]`;
    console.error(errorMessage);
    // sendSlackNotification(errorMessage); 
    return errorMessage;
  }

  try {
    // #２：保存先フォルダの特定（作成はしない）
    let targetFolder;

    // A. driveURL (直接指定) がある場合
    if (driveURL) {
      try {
        const folderId = driveURL.match(/[-\w]{25,}/)[0];
        targetFolder = DriveApp.getFolderById(folderId);
        console.log(`[Folder] driveURLから特定: ${folderId}`);
      } catch (e) {
        console.warn(`[Folder] driveURL無効。検索へ移行。`);
      }
    }

    // B. 階層検索（待機ロジック入り）
    if (!targetFolder) {
      if (!customerDriveURL) {
        return `${fileName} HopeCareGAS_帳票生成_エラー：保存先を特定できません。driveURLとcustomerDriveURLの両方が無効です。`;
      }

      let customerFolder;
      try {
        customerFolder = DriveApp.getFolderById(customerDriveURL.match(/[-\w]{25,}/)[0]);
      } catch (e) {
        return `${fileName} HopeCareGAS_帳票生成_エラー：顧客フォルダURLが無効かアクセス権がありません。 URL: ${customerDriveURL}`;
      }

      // -----------------------------------------------------------
      // ★変更点: AppSheetがフォルダを作るのを待つリトライロジック
      // -----------------------------------------------------------
      const maxRetries = 10; // 最大10回試行
      const waitTime = 3000; // 3秒待機

      // Step 1: Officeフォルダ (事業所名) の検索
      let officeFolder;
      console.log(`[Folder] 事業所フォルダ「${office}」を検索中...`);
      
      const officeFolders = customerFolder.getFoldersByName(office);
      if (officeFolders.hasNext()) {
        officeFolder = officeFolders.next();
      } else {
        // 事業所フォルダが見つからない場合はエラー
        return `${fileName} エラー：事業所フォルダ「${office}」が見つかりませんでした。`;
      }

      // Step 2: GoogleFolderName (利用者フォルダ) の待機・検索
      console.log(`[Folder] 利用者フォルダ「${googleFolderName}」の作成を待機・検索します...`);
      
      for (let i = 0; i < maxRetries; i++) {
        const targetFolders = officeFolder.getFoldersByName(googleFolderName);
        if (targetFolders.hasNext()) {
          targetFolder = targetFolders.next();
          console.log(`[Folder] 発見しました！ (試行回数: ${i + 1}回目)`);
          break; // ループを抜ける
        } else {
          console.log(`[Wait] まだ見つかりません... AppSheetの作成を待ちます (${i + 1}/${maxRetries})`);
          Utilities.sleep(waitTime); // 3秒待機
        }
      }

      if (!targetFolder) {
        const errorMessage = `${fileName} エラー：タイムアウト。フォルダ「${googleFolderName}」が見つかりませんでした。AppSheet側の作成状況を確認してください。`;
        console.error(errorMessage);
        return errorMessage;
      }
      
      // ★発見したフォルダURLをSalesforceへ通知
      const foundUrl = targetFolder.getUrl();
      console.log(`[External] 発見したフォルダURLをSalesforceへ通知します (ID: ${zaisekiID})`);
      postFolderUrlToExternalApp(foundUrl, zaisekiID);
      
      // -----------------------------------------------------------
    }

    // #３：テンプレートファイルをコピーし、指定フォルダへ移動
    const sourceFile = DriveApp.getFileById(surceFileUrl.match(/[-\w]{25,}/)[0]);

    const now = new Date();
    const timeStamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmm');
    const newFileName = `${fileName}_${timeStamp}`;

    const newFile = sourceFile.makeCopy(newFileName, targetFolder);
    SpreadsheetApp.flush();
    console.log(`[File] ファイルをコピーしました: ${newFileName}`);

    // #４：ジョブをスプレッドシートキューに追加
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error(`シート「${SHEET_NAME}」が見つかりません。`);
    
    const jobId = Utilities.getUuid();
    const createdAt = new Date();

    sheet.appendRow([
      jobId, 
      'PENDING', 
      createdAt, 
      newFile.getId(),
      textPaste, 
      newFile.getUrl(),
      newFileName, 
      '', 
      '' 
    ]);
    
    console.log(`[Queue] ジョブを登録しました: ${jobId}`);

    // #５：新しいスプレッドシートのURLを返す
    return newFile.getUrl();

  } catch (e) {
    const errorMessage = `${fileName || '不明なファイル'} HopeCareGAS_帳票生成_全体的なエラー：${e.toString()}`;
    console.error(errorMessage);
    // sendSlackNotification(errorMessage);
    return errorMessage;
  }
}


/**
 * =================================================================================
 * 関数 2: executeTextReplacement
 * 役割：ジョブの処理
 * =================================================================================
 */
function executeTextReplacement() {
  console.log("[Trigger] executeTextReplacement 実行開始");
  
  // --- 1. 同時実行防止 ---
  const lock = LockService.getScriptLock();
  if (lock.tryLock(30000)) {
    const startTime = Date.now();
    let sheet;
    try {
      sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
      if (!sheet) throw new Error(`シート「${SHEET_NAME}」が見つかりません。`);

      const range = sheet.getDataRange();
      const values = range.getValues();
      const header = values.shift() || [];
      
      const colIdx = {
        status: header.indexOf('status'),
        fileId: header.indexOf('fileId'), textPaste: header.indexOf('textPaste'),
        fileUrl: header.indexOf('fileUrl'), fileName: header.indexOf('fileName'),
        updatedAt: header.indexOf('updatedAt'), errorMessage: header.indexOf('errorMessage'),
        jobId: header.indexOf('jobId')
      };
      if (colIdx.status === -1) throw new Error("必須ヘッダー「status」列が見つかりません。");

      // --- 2. 処理対象ジョブの選定 ---
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const jobsToProcess = values.map((row, index) => ({ rowData: row, rowIndex: index + 2 }))
                                .filter(job => {
                                    const status = job.rowData[colIdx.status];
                                    const updatedAt = new Date(job.rowData[colIdx.updatedAt]);
                                    return status === 'PENDING' || (status === 'PROCESSING' && updatedAt < fifteenMinutesAgo);
                                });

      if (jobsToProcess.length === 0) {
        console.log("処理対象のジョブはありませんでした。");
        lock.releaseLock();
        return;
      }
      console.log(`処理対象のジョブが ${jobsToProcess.length}件見つかりました。`);

      // --- 3. ジョブのループ処理 ---
      for (const job of jobsToProcess) {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          console.log("実行時間が上限に近づいたため処理を中断します。残りのジョブは次回に処理されます。");
          break;
        }

        const { rowIndex } = job;
        const jobId = job.rowData[colIdx.jobId];
        const fileName = job.rowData[colIdx.fileName];

        try {
          sheet.getRange(rowIndex, colIdx.status + 1).setValue('PROCESSING');
          sheet.getRange(rowIndex, colIdx.updatedAt + 1).setValue(new Date());
          SpreadsheetApp.flush();

          performTextReplacement(job.rowData, colIdx);

          sheet.getRange(rowIndex, colIdx.status + 1).setValue('DONE');
          console.log(`[Job Done] ジョブ ${jobId} (${fileName}) の処理が正常に完了しました。`);

        } catch (e) {
          const errorMsg = e.toString();
          sheet.getRange(rowIndex, colIdx.status + 1).setValue('ERROR');
          sheet.getRange(rowIndex, colIdx.errorMessage + 1).setValue(errorMsg);
          console.error(`[Job Error] ジョブID: ${jobId} (${fileName}) エラー: ${errorMsg}`);
          // sendSlackNotification(...)
        } finally {
          sheet.getRange(rowIndex, colIdx.updatedAt + 1).setValue(new Date());
        }
      }
    } catch (e) {
      console.error(`[Fatal Error] ジョブ処理中に致命的なエラー: ${e.toString()}`);
      // sendSlackNotification(...)
    } finally {
      lock.releaseLock();
      console.log("[Trigger] 処理終了 (ロック解放)");
    }
  } else {
    console.log("ロック取得失敗 (他プロセスが実行中)");
  }
}


/**
 * =================================================================================
 * 関数 3: performTextReplacement
 * 役割：テキスト置換の実行
 * =================================================================================
 */
function performTextReplacement(rowData, colIdx) {
    const fileId = rowData[colIdx.fileId];
    const textPaste = rowData[colIdx.textPaste];
    const fileUrl = rowData[colIdx.fileUrl];
    const fileName = rowData[colIdx.fileName];

    console.log(`[Replace] 置換処理開始: ${fileName}`);
    const spreadsheet = SpreadsheetApp.openById(fileId);
    const pasteMap = new Map();
    textPaste.split(/\s*,\s*/).forEach(item => {
      const keyMatch = item.match(/^&&.*&&/);
      if (keyMatch) {
        const key = keyMatch[0].replace(/&&/g, "");
        const value = item.substring(keyMatch[0].length);
        pasteMap.set(key, value);
      }
    });
    
    let totalFoundCells = 0;
    spreadsheet.getSheets().forEach(s => {
      const dataRange = s.getDataRange();
      const sheetValues = dataRange.getValues();
      let changed = false;
      for (let r = 0; r < sheetValues.length; r++) {
        for (let c = 0; c < sheetValues[r].length; c++) {
          let cell = sheetValues[r][c];
          if (typeof cell === "string" && cell.includes("&&")) {
            const originalCell = cell;
            pasteMap.forEach((value, key) => {
              const placeholder = `&&${key}&&`;
              if (cell.includes(placeholder)) cell = cell.split(placeholder).join(value);
            });
            if(originalCell !== cell){
              sheetValues[r][c] = cell;
              changed = true;
              totalFoundCells++;
            }
          }
        }
      }
      if (changed) dataRange.setValues(sheetValues);
    });
    SpreadsheetApp.flush();

    console.log(`[Replace] 置換完了 (更新セル数: ${totalFoundCells})`);
    if (totalFoundCells === 0) {
      console.warn(`${fileName} 注意：置換対
      
      象が見つかりませんでした。URL: ${fileUrl}`);
    }
}
