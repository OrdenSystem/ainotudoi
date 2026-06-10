/**
 * =================================================================================
 * 関数: originalFileMake_Sync_Ontime (A案: 待機・検索特化版)
 * 役割：同期的な帳票生成
 * 特徴：フォルダの新規作成は行わず、AppSheetが作成するのを待機して検索します。
 * =================================================================================
 */
function originalFileMake_Sync_Ontime(surceFileUrl, driveURL, textPaste, zaisekiID, fileRecordID, fileName, googleFolderName, customerDriveURL, office) {

  console.log(`[Start] originalFileMake_Sync_Ontime (待機モード) 開始: ${fileName}`);

  // #１：変数の空チェック
  const missingParams = [];
  if (!surceFileUrl) missingParams.push("ひな型帳票URL (surceFileUrl)");
  if (!textPaste) missingParams.push("セル内テキスト (textPaste)");
  if (!zaisekiID) missingParams.push("在籍ID (zaisekiID)");
  if (!fileRecordID) missingParams.push("帳票マスタID (fileRecordID)");
  if (!fileName) missingParams.push("帳票名 (fileName)");
  if (!googleFolderName) missingParams.push("Googleフォルダ名 (googleFolderName)");
  if (!office) missingParams.push("事業所名 (office)");

  if (missingParams.length > 0) {
    const errorMessage = `${fileName} HopeCareGAS_エラー：パラメータ不足: [${missingParams.join(", ")}]`;
    console.error(errorMessage);
    return errorMessage;
  }

  let finalFileName = fileName; 

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
        const errorMessage = `エラー：保存先特定不可。driveURLもcustomerDriveURLも無効です。`;
        console.error(errorMessage);
        return errorMessage;
      }

      let customerFolder;
      try {
        customerFolder = DriveApp.getFolderById(customerDriveURL.match(/[-\w]{25,}/)[0]);
      } catch (e) {
        const errorMessage = `エラー：顧客フォルダURLが無効。`;
        console.error(errorMessage);
        return errorMessage;
      }

      // -----------------------------------------------------------
      // ★変更点: AppSheetがフォルダを作るのを待つリトライロジック
      // -----------------------------------------------------------
      const maxRetries = 10; // 最大10回試行
      const waitTime = 3000; // 3秒待機

      // Step 1: Officeフォルダ (事業所名) の検索
      let officeFolder;
      console.log(`[Folder] 事業所フォルダ「${office}」を検索中...`);
      
      // 事業所フォルダは「既にあるはず」前提で検索（なければエラー）
      const officeFolders = customerFolder.getFoldersByName(office);
      if (officeFolders.hasNext()) {
        officeFolder = officeFolders.next();
      } else {
        // 事業所フォルダすらない場合は、さすがにエラーまたは待機
        // ここでは即エラーとせず、事業所フォルダの作成もAppSheet待ちならここでも待機が必要ですが
        // 通常事業所フォルダは既存と思われるため、なければエラーにします。
        // もし事業所フォルダもAppSheetが作るなら、ここのロジックもリトライにする必要があります。
        // 今回は「利用者フォルダ」が作成待ち対象と想定します。
        return `エラー：事業所フォルダ「${office}」が見つかりませんでした。`;
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

      // ループ終了後、まだ見つからない場合
      if (!targetFolder) {
        const errorMessage = `エラー：タイムアウト。${maxRetries * waitTime / 1000}秒待機しましたが、フォルダ「${googleFolderName}」が見つかりませんでした。AppSheet側の作成が失敗しているか、フォルダ名が一致していません。`;
        console.error(errorMessage);
        return errorMessage;
      }

      // ★重要: 見つかったフォルダのURLをSalesforceへ通知（念のため同期）
      // 「AppSheetが作ったフォルダ」のURLをSalesforceに正しく登録するため実行します
      const foundUrl = targetFolder.getUrl();
      console.log(`[External] 発見したフォルダURLをSalesforceへ通知します (ID: ${zaisekiID})`);
      postFolderUrlToExternalApp(foundUrl, zaisekiID);

      // -----------------------------------------------------------
    }

    // #３：テンプレートファイルをコピー
    let sourceFile;
    try {
      sourceFile = DriveApp.getFileById(surceFileUrl.match(/[-\w]{25,}/)[0]);
    } catch (e) {
      return `エラー：テンプレートファイルURLが無効: ${surceFileUrl}`;
    }

    const now = new Date();
    const timeStamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmm');
    const newFileName = `${fileName}_${timeStamp}`;
    finalFileName = newFileName;

    // 特定した（待機して見つけた）フォルダに保存
    const newFile = sourceFile.makeCopy(newFileName, targetFolder);
    SpreadsheetApp.flush();
    console.log(`[File] ファイルをコピーしました: ${newFileName}`);

    // #４：テキストの置換処理
    const newFileUrl = newFile.getUrl();
    const spreadsheet = SpreadsheetApp.openById(newFile.getId());
    const allSheets = spreadsheet.getSheets();
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
    console.log(`[Replace] 置換開始 (キーワード数: ${pasteMap.size})`);

    allSheets.forEach(sheet => {
      const range = sheet.getDataRange();
      let values = range.getValues();
      let changed = false;

      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < values[r].length; c++) {
          let cell = values[r][c];
          if (typeof cell === "string" && cell.includes("&&")) {
            pasteMap.forEach((value, key) => {
              const placeholder = `&&${key}&&`;
              if (cell.includes(placeholder)) {
                cell = cell.split(placeholder).join(value);
                changed = true;
                totalFoundCells++;
              }
            });
            values[r][c] = cell;
          }
        }
      }
      if (changed) range.setValues(values);
    });

    SpreadsheetApp.flush();
    console.log(`[Replace] 置換完了 (更新数: ${totalFoundCells})`);

    if (totalFoundCells === 0) {
      console.warn(`${finalFileName} 注意：置換対象なし`);
    }

    console.log(`[Success] 完了。URL: ${newFileUrl}`);
    return newFileUrl;

  } catch (e) {
    const errorMessage = `${finalFileName} エラー発生：${e.toString()}`;
    console.error(errorMessage);
    return errorMessage;
  }
}