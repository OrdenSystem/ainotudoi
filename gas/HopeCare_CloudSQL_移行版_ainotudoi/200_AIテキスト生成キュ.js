/**
 * =======================================================
 * 非同期キュー処理システム
 * スプレッドシートをDB代わりにして、AppSheet API制限を回避しながら順次処理する
 * =======================================================
 */

// Script Property "QUEUE_SS_ID" から取得（000_AppConfig.js 参照）
const QUEUE_SPREADSHEET_ID = getConfigId_('QUEUE_SS_ID');
const QUEUE_SHEET_NAME = "request_queue";

/**
 * 【初期設定用】
 * 初回のみ実行してください。キュー用のシートとヘッダーを作成します。
 * シートが存在しても、中身が空ならヘッダーを自動追加します。
 */
function setupQueueSheet() {
  // ★ここに画像のスプレッドシートIDを入れてください
  // (URLの /d/ と /edit の間の文字列です)
  const ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID); 
  let sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  
  // シートがなければ作る
  if (!sheet) {
    sheet = ss.insertSheet(QUEUE_SHEET_NAME);
    Logger.log(`✅ 新規シート '${QUEUE_SHEET_NAME}' を作成しました。`);
  }
  
  // データがあるか確認（最終行が0なら空っぽ）
  if (sheet.getLastRow() === 0) {
    // 指定のヘッダーを追加
    // targetId: ID, status: ステータス, createdAt: 作成日時, updatedAt: 処理日時, memo: 処理結果ログ
    const headers = ["targetId", "status", "createdAt", "updatedAt", "memo", "queueId"];
    
    sheet.appendRow(headers);
    sheet.setFrozenRows(1); // 1行目を固定して見やすくする
    
    // 見た目を整える（太字にするなど）
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f3f3f3");
    
    Logger.log(`✅ ヘッダーを設定しました: ${headers.join(", ")}`);
  } else {
    Logger.log(`ℹ️ シート '${QUEUE_SHEET_NAME}' には既にデータがあるため、ヘッダー追加をスキップしました。`);
  }
}

/**
 * 【AppSheet連携用】
 * AppSheetのAutomationからこの関数を呼び出します。
 * 重い処理はせず、シートに行を追加して即終了します。
 * * @param {string} targetId - 利用者ID
 */
function enqueueAIContextTask(targetId) {
  if (!targetId) return;
  
  const ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  
  // ステータス "PENDING" で登録（F列にユニークID付与）
  const queueId = Utilities.getUuid();
  sheet.appendRow([
    targetId,
    "PENDING",
    new Date(),
    "",
    "",
    queueId
  ]);

  return { result: "Queued", id: targetId, queueId: queueId };
}

/**
 * 【トリガー実行用】
 * 時間主導型トリガー（例: 5分〜10分おき）でこの関数を実行します。
 * PENDINGのタスクを順次処理します。
 */
function processAIContextQueue() {
  // 排他制御: 重複実行を防ぐ（30秒待ってロック取れなければ終了）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("🔒 別のプロセスが実行中のためスキップします");
    return;
  }

  try {
    const ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
    
    // データ取得（ヘッダー除く）
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return; // データなし
    
    const dataRange = sheet.getRange(2, 1, lastRow - 1, 6);
    const data = dataRange.getValues();
    
    // 実行開始時刻（タイムアウト判定用）
    const startTime = new Date().getTime();
    
    Logger.log(`🔄 キュー処理開始: 全${data.length}行`);

    // ★職員マスタを事前キャッシュ（全ユーザー共通データなので1回だけ取得）
    let cachedStaffList = null;
    try {
      const props = PropertiesService.getScriptProperties();
      const APP_ID = props.getProperty("APPSHEET_APP_ID");
      const API_KEY = props.getProperty("APPSHEET_API_KEY");
      if (APP_ID && API_KEY) {
        cachedStaffList = callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");
        Logger.log(`📋 職員マスタキャッシュ完了: ${cachedStaffList.length}件`);
      }
    } catch (e) {
      Logger.log(`⚠️ 職員マスタキャッシュ失敗（各ユーザー処理内で個別取得します）: ${e.message}`);
    }

    for (let i = 0; i < data.length; i++) {
      const rowIndex = i + 2; // スプレッドシート上の行番号
      const row = data[i];
      const targetId = row[0];
      const status = row[1];
      const queueId = row[5] || "";
      
      // 6分の壁対策: 4分30秒経過していたら中断
      if (new Date().getTime() - startTime > 4.5 * 60 * 1000) {
        Logger.log("⏳ タイムリミット接近のため中断。残りは次回実行。");
        break;
      }

// 未処理(PENDING)、リセット要求(RESET_PENDING)、または エラーリトライ待ち(RETRY) を対象
      if (status === "PENDING" || status === "RETRY" || status === "RESET_PENDING") {
        
        try {
          // 1. ステータスを「処理中」に更新
          sheet.getRange(rowIndex, 2).setValue("PROCESSING");
          sheet.getRange(rowIndex, 4).setValue(new Date());
          SpreadsheetApp.flush(); // 即時反映

          Logger.log(`▶️ 処理開始: ID=${targetId} (Row=${rowIndex}, Status=${status}, QueueID=${queueId})`);

          // ===============================================
          // 2. メイン処理の実行
          // ===============================================
          // ★ステータスが RESET_PENDING なら isFirstRun を true にする
          const isReset = (status === "RESET_PENDING");
          generateAIContextFile(targetId, { isFirstRun: isReset, cachedStaffList: cachedStaffList });


          // 3. 成功時: ステータスを「完了」に更新
          sheet.getRange(rowIndex, 2).setValue("COMPLETED");
          sheet.getRange(rowIndex, 4).setValue(new Date());
          sheet.getRange(rowIndex, 5).setValue("Success");
          
          Logger.log(`✅ 完了: ID=${targetId} (QueueID=${queueId})`);

          // ★重要: APIレート制限対策 (3秒待機)
          // AppSheet APIへの連続アクセスを防ぎます
          Utilities.sleep(3000); 

        } catch (e) {
          // 4. エラー時: ステータスを「エラー」にし、通知を送る
          const errorMsg = `エラー: ${e.message}`;
          Logger.log(`🚨 ${errorMsg}`);
          
          sheet.getRange(rowIndex, 2).setValue("ERROR");
          sheet.getRange(rowIndex, 4).setValue(new Date());
          sheet.getRange(rowIndex, 5).setValue(errorMsg); // memo欄に詳細

          // Slack通知
          // sendSlackNotification(`🚨【自動処理失敗】ID: ${targetId}\n理由: ${e.message}`);
        }
      }
    }

    // ===============================================
    // ★ ERROR行の自動リトライ（1回限り）
    // ===============================================
    try {
      const freshLastRow = sheet.getLastRow();
      if (freshLastRow >= 2) {
        const allData = sheet.getRange(2, 1, freshLastRow - 1, 6).getValues();
        let retryCount = 0;
        for (let i = 0; i < allData.length; i++) {
          const r = allData[i];
          const rStatus = r[1];
          const rMemo = r[4] || "";
          if (rStatus === "ERROR" && !rMemo.startsWith("[RETRIED]")) {
            // 初回ERRORのみRETRYに変更（2回目以降はFAILEDにする）
            sheet.getRange(i + 2, 2).setValue("RETRY");
            sheet.getRange(i + 2, 5).setValue("[RETRIED] " + rMemo);
            retryCount++;
          } else if (rStatus === "ERROR" && rMemo.startsWith("[RETRIED]")) {
            // 2回目のERROR → FAILED（これ以上リトライしない）
            sheet.getRange(i + 2, 2).setValue("FAILED");
          }
        }
        if (retryCount > 0) Logger.log(`🔁 ERROR→RETRY変更: ${retryCount}件（次回トリガーで再処理）`);
      }
    } catch (retryErr) {
      Logger.log(`⚠️ 自動リトライ処理でエラー: ${retryErr.message}`);
    }

    // ===============================================
    // ★ COMPLETED行の自動クリーンアップ（7日以上前）
    //   削除前にCSVバックアップをGoogle Driveに保存
    // ===============================================
    try {
      const cleanLastRow = sheet.getLastRow();
      if (cleanLastRow >= 2) {
        const cleanData = sheet.getRange(2, 1, cleanLastRow - 1, 6).getValues();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // 削除対象の行を収集
        const rowsToDelete = [];
        for (let i = 0; i < cleanData.length; i++) {
          const cStatus = cleanData[i][1];
          const cCreatedAt = cleanData[i][2];
          if (cStatus === "COMPLETED" && cCreatedAt instanceof Date && cCreatedAt < sevenDaysAgo) {
            rowsToDelete.push({ index: i, data: cleanData[i] });
          }
        }

        if (rowsToDelete.length > 0) {
          // CSVバックアップを作成
          const csvHeader = "targetId,status,createdAt,updatedAt,memo,queueId";
          const csvRows = rowsToDelete.map(r => {
            return r.data.map(cell => {
              const val = (cell instanceof Date)
                ? Utilities.formatDate(cell, "JST", "yyyy-MM-dd HH:mm:ss")
                : String(cell || "");
              // CSVエスケープ（カンマ・改行・ダブルクォートを含む場合）
              return val.includes(",") || val.includes('"') || val.includes("\n")
                ? '"' + val.replace(/"/g, '""') + '"'
                : val;
            }).join(",");
          });
          const csvContent = csvHeader + "\n" + csvRows.join("\n");

          // バックアップフォルダを取得or作成（スプシと同じ階層）
          const ssFile = DriveApp.getFileById(QUEUE_SPREADSHEET_ID);
          const parentFolder = ssFile.getParents().next();
          const backupFolderName = "AI情報完了バックアップ";
          const existingFolders = parentFolder.getFoldersByName(backupFolderName);
          const backupFolder = existingFolders.hasNext()
            ? existingFolders.next()
            : parentFolder.createFolder(backupFolderName);

          // CSV保存（ファイル名: completed_backup_YYYYMMDD_HHmmss.csv）
          const now = new Date();
          const timestamp = Utilities.formatDate(now, "JST", "yyyyMMdd_HHmmss");
          const fileName = `completed_backup_${timestamp}.csv`;
          backupFolder.createFile(fileName, csvContent, MimeType.CSV);
          Logger.log(`💾 CSVバックアップ保存: ${fileName} (${rowsToDelete.length}件)`);

          // 下から削除していく（行番号がずれないように）
          for (let i = rowsToDelete.length - 1; i >= 0; i--) {
            sheet.deleteRow(rowsToDelete[i].index + 2);
          }
          Logger.log(`🧹 古いCOMPLETED行を削除: ${rowsToDelete.length}件`);
        }
      }
    } catch (cleanErr) {
      Logger.log(`⚠️ クリーンアップ処理でエラー: ${cleanErr.message}`);
    }

  } catch (e) {
    // スクリプト自体の重大なエラー（シートが見つからない等）
    Logger.log(`🔥 システムエラー: ${e.message}`);
    sendSlackNotification(`🔥【システム致命的エラー】Queue処理が停止しました\n${e.message}`);
  } finally {
    lock.releaseLock();
    Logger.log("🏁 キュー処理終了");
  }
}