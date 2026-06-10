/**
 * HopeRecorder A/B 比較・検証テストユーティリティ
 *
 * 目的:
 *   - 既存処理済みの音声を再投入し、HOPE_RECORDER_ACTIVE の現行版で出力を取り直して比較する
 *   - 任意の Drive URL を 1 件だけテスト投入する
 *   - 音声ファイルのメタ情報（サイズ・mimeType・推定尺）をログ出力する
 *
 * 重要な分離設計:
 *   - すべてのテスト投入行は LogID 先頭に `TEST_` プレフィックスを付与する
 *   - processAppSheetSendWorker は TEST_ プレフィックスを検知して AppSheet/SF への送信をスキップする
 *   - これにより本番経路（AppSheet → Salesforce）と完全に分離した状態で比較が行える
 *
 * V1 / V2 の比較運用:
 *   - 100_HopeRecorderPrompts.js の最終行 HOPE_RECORDER_ACTIVE を V1/V2 に切り替えて 2 回走らせる
 *   - displayName に version 接尾子（hope_recorder_v1_xxx / hope_recorder_v2_xxx）が入るので
 *     Vertex AI Console 上でも版管理できる
 */

/**
 * 既存 LogID の音声 URL を再投入する。シート上の元行はそのまま、新規行に TEST_ プレフィックスで追加。
 *
 * @param {string} sourceLogId POST履歴シートの A 列 LogID
 * @returns {string|undefined} 完了メッセージ（呼び出し元で Logger.log 済み）
 */
function test_compare_v1_v2(sourceLogId) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const values = sheet.getDataRange().getValues();

  let sourceRow = null;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === sourceLogId) {
      sourceRow = values[i];
      break;
    }
  }

  if (!sourceRow) {
    Logger.log('❌ source LogID が見つかりません: ' + sourceLogId);
    throw new Error('source LogID が見つかりません: ' + sourceLogId);
  }

  // 列マッピング:
  //   A=0 LogID, F=5 audioFileUrl, G=6 audioFileName, H=7 saleseforceUserID,
  //   I=8 saleseforceObject, J=9 Record_StartTime__c, K=10 CreateDate__c
  const audioFileUrl = sourceRow[5];
  const audioFileName = sourceRow[6];
  const saleseforceUserID = sourceRow[7];
  const saleseforceObject = sourceRow[8];
  const recordStartTime = sourceRow[9];
  const createDate = sourceRow[10];

  // 受付（appendRow）→ 最終行特定 → A 列上書きまでを排他制御で囲む。
  // AppSheet からの並列 doPost で行が増えると lastRow が想定外行を指す競合が起こりうるため、
  // この区間だけは LockService で逐次化する。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let testLogId;
  try {
    const message = HopeRecorderStartTranscription(
      audioFileUrl, audioFileName, saleseforceUserID, saleseforceObject, recordStartTime, createDate
    );

    // 戻り値 "✅ 受付完了 LogID: XXXX" から LogID 抽出
    const match = message.match(/LogID:\s*([A-Z0-9]+)/);
    if (!match) {
      Logger.log('⚠️ 戻り値から LogID を抽出できませんでした: ' + message);
      throw new Error('戻り値から LogID を抽出できませんでした');
    }
    const newLogId = match[1];
    testLogId = 'TEST_' + newLogId;

    // A 列を上書きして TEST_ プレフィックスにする（最終行を対象）
    const lastRow = sheet.getLastRow();
    const tailLogId = sheet.getRange(lastRow, 1).getValue();
    if (tailLogId !== newLogId) {
      Logger.log('⚠️ 最終行 LogID と受付返却 LogID が一致しません: tail=' + tailLogId + ' / received=' + newLogId);
      throw new Error('最終行の LogID 不一致');
    }
    sheet.getRange(lastRow, 1).setValue(testLogId);
  } finally {
    lock.releaseLock();
  }

  Logger.log('===== test_compare_v1_v2_ 投入完了 =====');
  Logger.log('比較対象: source LogID=' + sourceLogId + ' / new LogID=' + testLogId);
  Logger.log('現行アクティブ版: ' + HOPE_RECORDER_ACTIVE.version);
  Logger.log('完了後に M 列（文字起こしテキスト）同士を比較してください');
  Logger.log('V1/V2 比較したい場合は 100_HopeRecorderPrompts.js の HOPE_RECORDER_ACTIVE を切り替えて再度 test_compare_v1_v2 を実行');

  return '投入完了: ' + testLogId;
}

/**
 * 任意の Drive URL を 1 件、現行アクティブ版で投入する。新規音声の検証用。
 *
 * @param {string} driveUrl  Google Drive 共有 URL
 * @returns {string} 投入結果メッセージ
 */
function test_run_v2_only(driveUrl) {
  const fileId = extractFileIdFromUrl(driveUrl);
  if (!fileId) {
    Logger.log('❌ Drive URL から FileID 抽出失敗: ' + driveUrl);
    throw new Error('Drive URL から FileID 抽出失敗');
  }

  const fileInfo = Drive.Files.get(fileId, { supportsAllDrives: true });
  const audioFileName = fileInfo.name || ('test_' + fileId);

  // テスト用ダミーメタ
  const saleseforceUserID = 'TEST_USER_ID';
  const saleseforceObject = 'TestObject';
  const recordStartTime = '';
  const createDate = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);

  // 受付（appendRow）→ 最終行特定 → A 列上書きまでを排他制御で囲む。
  // AppSheet からの並列 doPost で行が増えると lastRow が想定外行を指す競合が起こりうるため、
  // この区間だけは LockService で逐次化する。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let testLogId;
  try {
    const message = HopeRecorderStartTranscription(
      driveUrl, audioFileName, saleseforceUserID, saleseforceObject, recordStartTime, createDate
    );

    const match = message.match(/LogID:\s*([A-Z0-9]+)/);
    if (!match) {
      Logger.log('⚠️ 戻り値から LogID を抽出できませんでした: ' + message);
      throw new Error('戻り値から LogID を抽出できませんでした');
    }
    const newLogId = match[1];
    testLogId = 'TEST_' + newLogId;

    const lastRow = sheet.getLastRow();
    const tailLogId = sheet.getRange(lastRow, 1).getValue();
    if (tailLogId !== newLogId) {
      Logger.log('⚠️ 最終行 LogID と受付返却 LogID が一致しません: tail=' + tailLogId + ' / received=' + newLogId);
      throw new Error('最終行の LogID 不一致');
    }
    sheet.getRange(lastRow, 1).setValue(testLogId);
  } finally {
    lock.releaseLock();
  }

  Logger.log('===== test_run_v2_only_ 投入完了 =====');
  Logger.log('LogID: ' + testLogId);
  Logger.log('現行アクティブ版: ' + HOPE_RECORDER_ACTIVE.version);
  Logger.log('audioFileName: ' + audioFileName);

  return '投入完了: ' + testLogId;
}

/**
 * Drive 上の音声メタを確認する。Phase C の閾値判定の妥当性確認に使う。
 *
 * @param {string} driveUrl Google Drive 共有 URL
 */
function test_audioMetadata(driveUrl) {
  const fileId = extractFileIdFromUrl(driveUrl);
  if (!fileId) {
    Logger.log('❌ Drive URL から FileID 抽出失敗: ' + driveUrl);
    throw new Error('Drive URL から FileID 抽出失敗');
  }

  const driveFile = DriveApp.getFileById(fileId);
  const name = driveFile.getName();
  const mimeType = driveFile.getMimeType();
  const fileSize = driveFile.getSize();
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
  const durationSec = estimateAudioDurationSeconds_(fileSize, mimeType);
  const durationMin = (durationSec / 60).toFixed(1);
  const isLong = durationSec > 3600;

  Logger.log('===== test_audioMetadata_ =====');
  Logger.log('fileId: ' + fileId);
  Logger.log('name: ' + name);
  Logger.log('mimeType: ' + mimeType);
  Logger.log('size: ' + fileSize + ' bytes (' + sizeMB + ' MB)');
  Logger.log('estimated duration: ' + durationSec.toFixed(0) + ' sec (' + durationMin + ' min)');
  Logger.log('長尺（60分超）判定: ' + (isLong ? 'YES（Slack 警告対象）' : 'NO'));
}

// =====================================================================
// GAS UI から引数なしで実行できるラッパ関数群
//   GAS の関数ピッカーは引数渡しに対応しないため、検証対象 URL や LogID を
//   ハードコードしたラッパを置く。検証ごとに URL や LogID を書き換えて使う。
// =====================================================================

/**
 * 検証用 Drive URL（50 分音声、2026-04-27 ユーザー提供）
 */
const TEST_AUDIO_URL_2026_04_27 = 'https://drive.google.com/file/d/1li9NxKjoQXNjDagl0NiyzQ9PAPXA9TVE/view?usp=sharing';

/**
 * 検証音声のメタ情報を確認するラッパ。
 * 推定尺・mimeType・サイズをログ出力するだけで、Batch 投入はしない。
 */
function run_test_audioMetadata() {
  test_audioMetadata(TEST_AUDIO_URL_2026_04_27);
}

/**
 * 検証音声を現行アクティブ版（V2）で 1 件投入するラッパ。
 * POST履歴シートに TEST_xxxx LogID で行が追加され、本番 AppSheet/SF へは流れない。
 * 投入後は時間トリガの processTranscriptionWorker / checkJobStatus を待つ
 * （手動で動かす場合は対応するファイルの関数を実行）。
 */
function run_test_run_v2_only() {
  test_run_v2_only(TEST_AUDIO_URL_2026_04_27);
}
