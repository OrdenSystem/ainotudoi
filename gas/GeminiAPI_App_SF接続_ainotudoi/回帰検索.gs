/**
 * メイン関数: 一時的なサービスエラーを無視する版
 */
function listAndMoveAudioFiles() {
  // --- 設定項目 (変更なし) ---
  const CONFIG_SHEET_NAME = "基本情報";
  const URL_HEADER_NAME = "指定フォルダURL";
  const TARGET_SHEET_NAME = "音声ファイル";
  const DEST_FOLDER_NAME = "リストアップ済";
  const MAX_FILES_PER_RUN = 50;
  // ----------------

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const targetItems = getTargetFoldersFromSheet(
      ss,
      CONFIG_SHEET_NAME,
      URL_HEADER_NAME,
    );
    if (targetItems.length === 0) return;

    const outputSheet = prepareOutputSheet(ss, TARGET_SHEET_NAME);
    const existingUrls = getExistingFileUrls(outputSheet);

    const now = new Date();
    const allResultRows = [];
    let totalFilesProcessed = 0;
    let errorMessages = [];
    let isLimitReached = false;

    for (const item of targetItems) {
      if (isLimitReached) break;

      const folder = item.folder;
      const basicInfoId = item.id;
      let targetFolderName = "不明なフォルダ";

      try {
        targetFolderName = folder.getName();
        const listedFolder = getOrCreateFolder(folder, DEST_FOLDER_NAME);
        const files = folder.getFiles();

        while (files.hasNext()) {
          if (totalFilesProcessed >= MAX_FILES_PER_RUN) {
            isLimitReached = true;
            break;
          }
          const file = files.next();
          if (file.getMimeType().startsWith("audio/")) {
            const fileUrl = file.getUrl();
            if (existingUrls.has(fileUrl)) continue;

            allResultRows.push([
              generateRandomId(8),
              basicInfoId,
              targetFolderName,
              now,
              file.getName(),
              fileUrl,
              "未処理",
              false,
              file.getLastUpdated(),
            ]);
            existingUrls.add(fileUrl);

            try {
              Drive.Files.update({}, file.getId(), null, {
                addParents: listedFolder.getId(),
                removeParents: folder.getId(),
                supportsAllDrives: true,
              });
              Utilities.sleep(100);
            } catch (moveError) {
              // 移動失敗は「要対応」の可能性が高いので通知に含める
              errorMessages.push(
                `【移動失敗】${targetFolderName}: ${moveError.message}`,
              );
            }
            totalFilesProcessed++;
          }
        }
      } catch (e) {
        const errMsg = e.message;

        // --- ここがポイント：無視するエラーの判定 ---
        if (errMsg.includes("Service error: Drive")) {
          // Google側の一時的なエラーなので、ログに残すだけでSlackには送らない
          Logger.log(
            `一時的なサービスエラーを無視しました（フォルダ: ${targetFolderName}）`,
          );
          continue;
        }

        if (
          errMsg.includes("A shared drive item must have exactly one parent") ||
          errMsg.includes("Insufficient permissions")
        ) {
          errorMessages.push(
            `【権限不足】「${targetFolderName}」を確認してください。`,
          );
        } else {
          // それ以外の予期せぬエラーは通知に含める
          errorMessages.push(
            `【フォルダエラー】「${targetFolderName}」: ${errMsg}`,
          );
        }
      }
    }

    if (allResultRows.length > 0) {
      outputSheet
        .getRange(
          outputSheet.getLastRow() + 1,
          1,
          allResultRows.length,
          allResultRows[0].length,
        )
        .setValues(allResultRows);
    }

    // エラーがある場合のみSlack通知
    if (errorMessages.length > 0) {
      sendSlackNotification(`🚨 **エラー通知**\n${errorMessages.join("\n")}`);
    }
  } catch (e) {
    // スクリプト自体のエラーは通知する
    sendSlackNotification(`⛔ **致命的エラー**\n${e.message}`);
  }
}

// --- ヘルパー関数群 ---

function getExistingFileUrls(sheet) {
  const existingUrls = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return existingUrls;
  const values = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const url = values[i][0];
    if (url) existingUrls.add(String(url));
  }
  return existingUrls;
}

function getTargetFoldersFromSheet(ss, sheetName, headerName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`シート「${sheetName}」が見つかりません。`);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const colIndex = headers.indexOf(headerName);
  if (colIndex === -1)
    throw new Error(
      `シート「${sheetName}」に「${headerName}」が見つかりません。`,
    );

  const items = [];
  for (let i = 1; i < data.length; i++) {
    const folderUrl = data[i][colIndex];
    const basicInfoId = data[i][0];
    if (!folderUrl || !basicInfoId) continue;
    const match = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (!match) continue;
    try {
      const folder = DriveApp.getFolderById(match[1]);
      items.push({ folder: folder, id: basicInfoId });
    } catch (e) {
      Logger.log(`フォルダアクセスエラー: ${match[1]}`);
    }
  }
  return items;
}

function getOrCreateFolder(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  else return parentFolder.createFolder(folderName);
}

function prepareOutputSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    const headers = [
      "音声ファイルID",
      "基本情報ID",
      "検索したフォルダ名",
      "GAS検索した日時",
      "音声ファイル名",
      "音声ファイルURL",
      "ステータス",
      "フラグ",
      "ファイルの最新更新日時",
    ];
    sheet.appendRow(headers);
  }
  return sheet;
}

function generateRandomId(length) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++)
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
