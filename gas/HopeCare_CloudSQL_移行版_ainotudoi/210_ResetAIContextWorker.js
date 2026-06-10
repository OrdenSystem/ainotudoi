/**
 * =======================================================
 * リセットAIコンテキスト → request_queue 転記 Worker
 *
 * 目的:
 *   AppSheet の「AIリセット」ボタン押下で「リセットAIコンテキスト」シートに
 *   行が追加されるが、現状は誰も読まない孤児シートになっていた。
 *   このシートの新規行を検知し、既存の request_queue に
 *   RESET_PENDING で転記するだけの Worker。
 *
 * 設計方針:
 *   - 既存の generateAIContextFile / processAIContextQueue は一切変更しない
 *   - リセットAIコンテキスト シートの構成（A:AIリセットID, B:利用者在籍ID, C:登録日時）も変更しない
 *   - 進捗管理は Script Property "LAST_RESET_PROCESSED_TS" のみ
 *   - 初回起動時は「今」を基準にして過去全件転記を回避
 *   - 重複防止: 同 userId で未処理の RESET_PENDING / PENDING が既にあればスキップ
 *
 * 連携:
 *   processResetAIContextQueue → request_queue (RESET_PENDING) → 既存 processAIContextQueue
 *   → generateAIContextFile(isFirstRun=true) で全件再生成
 *
 * トリガー設定（ユーザー手動）:
 *   GAS UI > トリガー > processResetAIContextQueue を 5〜10 分おきの時間ベース実行
 * =======================================================
 */

// QUEUE_SPREADSHEET_ID / QUEUE_SHEET_NAME は 200_AIテキスト生成キュ.js のグローバルを参照
var RESET_AI_SHEET_NAME_ = 'リセットAIコンテキスト';
var RESET_LAST_TS_PROP_KEY_ = 'LAST_RESET_PROCESSED_TS';

/**
 * 【トリガー実行用】
 * リセットAIコンテキスト シートをスキャンし、新規リセット要求を request_queue に転記する。
 * 5〜10 分おきの時間ベーストリガーから呼び出す想定。
 */
function processResetAIContextQueue() {
  // 排他制御: processAIContextQueue と request_queue への書き込みが競合しないようにする
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('🔒 別のプロセスが実行中のためスキップ');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
    var resetSheet = ss.getSheetByName(RESET_AI_SHEET_NAME_);
    if (!resetSheet) {
      Logger.log('⚠️ シート不在: ' + RESET_AI_SHEET_NAME_);
      return;
    }
    var queueSheet = ss.getSheetByName(QUEUE_SHEET_NAME);
    if (!queueSheet) {
      Logger.log('⚠️ シート不在: ' + QUEUE_SHEET_NAME);
      return;
    }

    var props = PropertiesService.getScriptProperties();
    var lastTsStr = props.getProperty(RESET_LAST_TS_PROP_KEY_);
    var lastTs;

    if (lastTsStr) {
      var parsed = new Date(lastTsStr);
      lastTs = isNaN(parsed.getTime()) ? new Date().getTime() : parsed.getTime();
    } else {
      // 初回起動: 過去全件転記を防ぐため「今」を基準にする
      lastTs = new Date().getTime();
      props.setProperty(RESET_LAST_TS_PROP_KEY_, new Date(lastTs).toISOString());
      Logger.log('🆕 LAST_RESET_PROCESSED_TS 未設定 → 現在時刻で初期化（過去分は対象外）');
      return; // 初回は転記処理せず終了。次回以降の追加分のみ拾う
    }

    var lastRow = resetSheet.getLastRow();
    if (lastRow < 2) {
      Logger.log('✅ リセットシートにデータなし');
      return;
    }

    // 列構成: A=AIリセットID, B=利用者在籍ID, C=登録日時
    var data = resetSheet.getRange(2, 1, lastRow - 1, 3).getValues();
    var newRows = [];
    for (var i = 0; i < data.length; i++) {
      var ts = data[i][2];
      if (!(ts instanceof Date)) continue;
      if (ts.getTime() > lastTs) {
        newRows.push(data[i]);
      }
    }

    if (newRows.length === 0) {
      Logger.log('✅ 新規リセット要求なし (lastTs=' + new Date(lastTs).toISOString() + ')');
      return;
    }

    Logger.log('🔄 新規リセット要求 ' + newRows.length + ' 件を request_queue に転記');

    // 既存キューから未処理 (RESET_PENDING / PENDING) の userId 集合を取得（重複防止）
    var pendingUserIds = {};
    var queueLastRow = queueSheet.getLastRow();
    if (queueLastRow >= 2) {
      var qData = queueSheet.getRange(2, 1, queueLastRow - 1, 6).getValues();
      for (var q = 0; q < qData.length; q++) {
        var qStatus = qData[q][1];
        var qUserId = qData[q][0];
        if (qUserId && (qStatus === 'RESET_PENDING' || qStatus === 'PENDING' || qStatus === 'RETRY')) {
          pendingUserIds[String(qUserId)] = true;
        }
      }
    }

    var maxTs = lastTs;
    var addedCount = 0;
    var skippedCount = 0;

    for (var j = 0; j < newRows.length; j++) {
      var aiResetId = newRows[j][0];
      var userId = newRows[j][1];
      var registeredAt = newRows[j][2];

      if (!userId) {
        Logger.log('⏭️ userId 空のためスキップ (AIリセットID=' + aiResetId + ')');
        continue;
      }

      var userIdStr = String(userId);
      if (pendingUserIds[userIdStr]) {
        Logger.log('⏭️ 既に未処理キューあり: ' + userIdStr);
        skippedCount++;
      } else {
        var queueId = Utilities.getUuid();
        queueSheet.appendRow([
          userIdStr,
          'RESET_PENDING',
          new Date(),
          '',
          '[Reset転記元 AIリセットID=' + aiResetId + ']',
          queueId
        ]);
        // 直前に追加した userId は以降の重複判定対象
        pendingUserIds[userIdStr] = true;
        addedCount++;
        Logger.log('➕ RESET_PENDING 追加: ' + userIdStr + ' (queueId=' + queueId + ')');
      }

      if (registeredAt.getTime() > maxTs) {
        maxTs = registeredAt.getTime();
      }
    }

    // 進捗保存（最終登録日時まで進める）
    props.setProperty(RESET_LAST_TS_PROP_KEY_, new Date(maxTs).toISOString());
    Logger.log('💾 LAST_RESET_PROCESSED_TS 更新: ' + new Date(maxTs).toISOString());
    Logger.log('📊 結果: 追加=' + addedCount + ', 重複スキップ=' + skippedCount);

  } catch (e) {
    Logger.log('🚨 エラー: ' + e.message + '\n' + e.stack);
    try {
      sendSlackNotification('🚨 processResetAIContextQueue エラー\n' + e.message);
    } catch (_) {}
  } finally {
    lock.releaseLock();
    Logger.log('🏁 リセット転記終了');
  }
}

/**
 * 【手動実行用】
 * 指定 ISO 日時以降のリセット要求を全て転記対象にする（過去分の再処理用）。
 * 例: GAS UI で reprocessResetRequestsFrom('2026-05-01T00:00:00') を実行すれば
 *      その時刻以降の リセットAIコンテキスト 行が次回 processResetAIContextQueue で全て転記される。
 *
 * @param {string} isoStr 例: '2026-05-01T00:00:00' (JST 解釈ではなく ISO/UTC 解釈)
 */
function reprocessResetRequestsFrom(isoStr) {
  var ts = new Date(isoStr);
  if (isNaN(ts.getTime())) {
    throw new Error('無効な日時文字列: ' + isoStr);
  }
  var props = PropertiesService.getScriptProperties();
  // 1ms 前にすることで、isoStr 自身も対象範囲に含める
  var newLastTs = new Date(ts.getTime() - 1);
  props.setProperty(RESET_LAST_TS_PROP_KEY_, newLastTs.toISOString());
  Logger.log('🔄 LAST_RESET_PROCESSED_TS を ' + newLastTs.toISOString() + ' に上書き');
  Logger.log('   次回 processResetAIContextQueue 実行時に ' + isoStr + ' 以降の行が転記されます');
}

/**
 * 【リカバリ用】
 * processAIContextQueue で「PROCESSING のまま固まった行」を RESET_PENDING に戻す。
 * GAS 6 分制限超過などで強制終了した結果、status=PROCESSING で取り残された行が
 * 永久に再処理されない問題への対処。
 *
 * @param {number} [olderThanMinutes=15] PROCESSING に入ってから N 分以上経過した行を対象（既定: 15 分）
 */
function recoverStuckProcessingRows(olderThanMinutes) {
  var threshold = (typeof olderThanMinutes === 'number' && olderThanMinutes > 0) ? olderThanMinutes : 15;
  var now = new Date().getTime();
  var thresholdMs = threshold * 60 * 1000;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('🔒 別のプロセスが実行中のためスキップ');
    return;
  }
  try {
    var ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    var recovered = 0;
    for (var i = 0; i < data.length; i++) {
      var status = data[i][1];
      var updatedAt = data[i][3];
      if (status === 'PROCESSING' && updatedAt instanceof Date) {
        if (now - updatedAt.getTime() > thresholdMs) {
          var rowIdx = i + 2;
          sheet.getRange(rowIdx, 2).setValue('RESET_PENDING');
          var prevMemo = data[i][4] || '';
          sheet.getRange(rowIdx, 5).setValue('[Recover from PROCESSING] ' + prevMemo);
          sheet.getRange(rowIdx, 4).setValue(new Date());
          recovered++;
          Logger.log('♻️ PROCESSING → RESET_PENDING: targetId=' + data[i][0] + ' (経過 '
            + Math.floor((now - updatedAt.getTime()) / 60000) + ' 分)');
        }
      }
    }
    Logger.log('📊 リカバリ件数: ' + recovered);
  } catch (e) {
    Logger.log('🚨 エラー: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 【診断用】
 * 現在の進捗状態とリセットシートの状況をログに出す。
 * GAS UI から手動実行して確認する。
 */
function diagnose_resetWorkerStatus() {
  var props = PropertiesService.getScriptProperties();
  var lastTs = props.getProperty(RESET_LAST_TS_PROP_KEY_);
  Logger.log('===== ResetAIContextWorker Status =====');
  Logger.log('LAST_RESET_PROCESSED_TS: ' + (lastTs || '(未設定 = 次回実行時に現在時刻で初期化)'));

  var ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
  var resetSheet = ss.getSheetByName(RESET_AI_SHEET_NAME_);
  if (!resetSheet) {
    Logger.log('⚠️ リセットAIコンテキスト シート不在');
    return;
  }
  var lastRow = resetSheet.getLastRow();
  Logger.log('リセットAIコンテキスト 総行数: ' + Math.max(0, lastRow - 1));

  if (lastRow >= 2) {
    var lastEntry = resetSheet.getRange(lastRow, 1, 1, 3).getValues()[0];
    Logger.log('最終行: AIリセットID=' + lastEntry[0] + ', userId=' + lastEntry[1] + ', 登録日時=' + lastEntry[2]);

    if (lastTs) {
      var lastTsDate = new Date(lastTs);
      var pendingCount = 0;
      var data = resetSheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        if (data[i][2] instanceof Date && data[i][2].getTime() > lastTsDate.getTime()) {
          pendingCount++;
        }
      }
      Logger.log('未転記の新規リセット要求: ' + pendingCount + ' 件');
    }
  }

  // request_queue 側の RESET_PENDING 状況
  var queueSheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  if (queueSheet) {
    var qLastRow = queueSheet.getLastRow();
    if (qLastRow >= 2) {
      var qData = queueSheet.getRange(2, 1, qLastRow - 1, 6).getValues();
      var resetPending = 0;
      for (var k = 0; k < qData.length; k++) {
        if (qData[k][1] === 'RESET_PENDING') resetPending++;
      }
      Logger.log('request_queue 内 RESET_PENDING: ' + resetPending + ' 件');
    }
  }
}
