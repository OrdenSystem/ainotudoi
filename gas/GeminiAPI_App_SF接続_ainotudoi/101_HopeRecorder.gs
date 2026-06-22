// ============================================
// リトライ管理（N列 = RetryCount）
// ============================================
/**
 * 自動リトライの上限。これを超えると status を 'FAILED' に固定し Slack 通知。
 * 手動介入（198_HopeRecorderDiagnose.js#diagnose_retryStuckRow）で N を 0 にリセットすれば再実行可能。
 */
const MAX_RETRY_COUNT = 5;

/**
 * 指定行の RetryCount (N列) を +1 する。上限超過時は status='FAILED' に固定して Slack 通知。
 *
 * @param {Sheet}  sheet     POST履歴 シート
 * @param {number} rowNumber 1-based 行番号
 * @param {string} logId
 * @param {string} reason    リトライ原因の短文（先頭100文字程度）
 * @returns {boolean} true: 上限超過（呼出側はリトライを諦める）/ false: まだリトライ可能
 */
function _incrementAndCheckRetryLimit_(sheet, rowNumber, logId, reason) {
  var currentCount = Number(sheet.getRange(rowNumber, 14).getValue()) || 0;
  var newCount = currentCount + 1;
  sheet.getRange(rowNumber, 14).setValue(newCount);

  if (newCount > MAX_RETRY_COUNT) {
    sheet.getRange(rowNumber, 4).setValue("FAILED");
    sheet
      .getRange(rowNumber, 5)
      .setValue(
        "リトライ上限(" +
          MAX_RETRY_COUNT +
          ")超過: " +
          String(reason || "").substring(0, 200),
      );
    sendSlackNotification(
      "🚨 [HopeRecorder] LogID:" +
        logId +
        " リトライ上限(" +
        MAX_RETRY_COUNT +
        ")超過。手動介入を要請。",
    );
    console.error("[" + logId + "] retry limit exceeded N=" + newCount);
    return true;
  }
  console.warn(
    "[" + logId + "] retry count: " + newCount + "/" + MAX_RETRY_COUNT,
  );
  return false;
}

// ============================================
// 受付➀：AppSheet → GAS
// ============================================
function HopeRecorderStartTranscription(
  audioFileUrl,
  audioFileName,
  saleseforceUserID,
  saleseforceObject,
  Record_StartTime__c,
  CreateDate__c,
) {
  // 入力ガード: 必須引数が空のまま叩かれた場合は POST履歴 に行を作らずに弾く。
  //
  // Why: AppSheet 側の何らかの経路（モバイル HopeRecorder の race / 別 Bot 誤起動 / プレビュー時のテスト
  //      起動など）から全引数空でこの関数が呼ばれ、POST履歴 に F〜M 列空の幽霊行が作られて
  //      processTranscriptionWorker が "Drive URLからFileID抽出失敗" でループするケースが本番で発生した
  //      （2026-04-30 BB7RZQTL / Z8091UFO / I50TPLDM）。GAS 側で先にバリデーションして弾くことで、
  //      呼出元の設定不備を Slack に即時通報しつつ、シートを汚さない。
  //
  // 受け入れ基準: audioFileUrl が空文字・null・undefined のいずれかなら受付拒否（行追加せず）。
  //              他列の空は許容（必須でない情報も多いため）。
  if (!audioFileUrl || !String(audioFileUrl).trim()) {
    var rejectMsg =
      "[HopeRecorder] 受付拒否: audioFileUrl 空。" +
      " 呼出元 AppSheet の設定（音声ファイル経路 / モバイル HopeRecorder / 別 Bot のいずれか）を要確認。" +
      " params={audioFileName:" +
      (audioFileName ? "set" : "empty") +
      ", saleseforceUserID:" +
      (saleseforceUserID ? "set" : "empty") +
      ", saleseforceObject:" +
      (saleseforceObject ? "set" : "empty") +
      ", Record_StartTime__c:" +
      (Record_StartTime__c ? "set" : "empty") +
      ", CreateDate__c:" +
      (CreateDate__c ? "set" : "empty") +
      "}";
    console.warn(rejectMsg);
    try {
      sendSlackNotification(rejectMsg);
    } catch (_) {}
    return "⚠️ 受付エラー: audioFileUrl が空です。AppSheet 側の引数設定を確認してください。";
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const logId = Math.random().toString(36).substring(2, 10).toUpperCase();

  // 列の意味:
  //   A=LogID  B=作成日時  C=jobName  D=status  E=詳細メッセージ
  //   F=audioFileUrl  G=audioFileName  H=saleseforceUserID  I=saleseforceObject
  //   J=Record_StartTime__c  K=CreateDate__c
  //   L=outputUriPrefix  M=clean済テキスト  N=RetryCount（自動リトライ回数、MAX_RETRY_COUNT 超過で FAILED）
  sheet.appendRow([
    logId,
    new Date(),
    "",
    "受付",
    "", // A-E
    audioFileUrl,
    audioFileName,
    saleseforceUserID,
    saleseforceObject,
    Record_StartTime__c,
    CreateDate__c, // F-K
    "",
    "",
    0, // L,M,N
  ]);
  return `✅ 受付完了 LogID: ${logId}`;
}

// ============================================
// Worker➁: 高速化＆超大容量対応版 (Drive API使用)
// ============================================
function processTranscriptionWorker() {
  // 環境固有値ガード: GCS バケット / GCP プロジェクトが未設定の環境では誤発火を防ぐために停止
  if (!GCS_BUCKET_NAME || !PROJECT_ID) {
    console.warn(
      "[HopeRecorder] GCS_BUCKET_NAME または PROJECT_ID が未設定のため processTranscriptionWorker を停止します",
    );
    return "未設定のため処理しません";
  }
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const LOCATION = "us-central1";

  let successCount = 0;
  let errorCount = 0;
  let errorMessages = []; // Slack通知用エラーリスト

  for (let i = 1; i < values.length; i++) {
    if (values[i][3] !== "受付") continue;

    const rowNumber = i + 1;
    const row = values[i];
    const logId = row[0];

    try {
      // 1. ステータスロック
      sheet.getRange(rowNumber, 4).setValue("処理中(1/3)");
      sheet.getRange(rowNumber, 5).setValue("GCSアップロード中...");
      SpreadsheetApp.flush();

      const accessToken = getOAuthServiceAccountToken_();

      // 2. 音声ファイル準備
      const fileId = extractFileIdFromUrl(row[5]);
      if (!fileId) throw new Error("Drive URLからFileID抽出失敗");

      const driveFile = DriveApp.getFileById(fileId);
      const mimeType = driveFile.getMimeType();
      const fileSize = driveFile.getSize();

      // 長尺（60 分超）検知：警告のみで処理は継続。
      // pro モデル + maxOutputTokens 65536 を前提に単一ファイル投入を維持し、
      // 末尾切れ等が発生した場合に手動でステータス確認できるよう Slack に通知する。
      const estimatedDurationSec = estimateAudioDurationSeconds_(
        fileSize,
        mimeType,
      );
      if (estimatedDurationSec > 3600) {
        const minutes = Math.round(estimatedDurationSec / 60);
        const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
        sendSlackNotification(
          `⏰ 長時間音声検出 LogID:${logId} 推定 ${minutes} 分 / ${mimeType} / ${sizeMB} MB。\n` +
            `pro モデル＋maxOutputTokens 65536 で単一ファイル投入を継続します。末尾切れ・コンテキスト溢れが発生した場合は手動でステータス確認してください。`,
        );
      }

      const safeFileName = row[6].replace(/[\s\/\\?%*:|"<>#&]/g, "_");
      const audioPath = `inputs/${logId}_${safeFileName}`;

      // 大容量アップロード
      uploadLargeFileToGcsByDriveApi_(
        fileId,
        fileSize,
        mimeType,
        GCS_BUCKET_NAME,
        audioPath,
        accessToken,
      );

      sheet.getRange(rowNumber, 5).setValue("Batch投入中...");

      // 3. プロンプト作成（HOPE_RECORDER_ACTIVE 経由で参照、100_HopeRecorderPrompts.js を参照）
      const prompt = HOPE_RECORDER_ACTIVE.batch.prompt;

      const gcsUri = `gs://${GCS_BUCKET_NAME}/${audioPath}`;
      const requestJsonl =
        JSON.stringify({
          request: {
            contents: [
              {
                role: "user",
                parts: [
                  { fileData: { mimeType: mimeType, fileUri: gcsUri } },
                  { text: prompt },
                ],
              },
            ],
            safetySettings: [
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE",
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE",
              },
              {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_NONE",
              },
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            ],
            generationConfig: {
              temperature: HOPE_RECORDER_ACTIVE.batch.temperature,
              maxOutputTokens: HOPE_RECORDER_ACTIVE.batch.maxOutputTokens,
            },
          },
        }) + "\n";

      const jsonlPath = `inputs/${logId}_request.jsonl`;
      const jsonlUploadResponse = UrlFetchApp.fetch(
        `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(jsonlPath)}`,
        {
          method: "post",
          contentType: "application/json",
          payload: requestJsonl,
          headers: { Authorization: `Bearer ${accessToken}` },
          muteHttpExceptions: true,
        },
      );
      if (jsonlUploadResponse.getResponseCode() !== 200)
        throw new Error("JSONLアップロード失敗");

      // 4. Batchジョブ投入
      const batch = UrlFetchApp.fetch(
        `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/batchPredictionJobs`,
        {
          method: "post",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${accessToken}` },
          payload: JSON.stringify({
            displayName: `hope_recorder_${HOPE_RECORDER_ACTIVE.version}_${logId}`,
            inputConfig: {
              instancesFormat: "jsonl",
              gcsSource: { uris: [`gs://${GCS_BUCKET_NAME}/${jsonlPath}`] },
            },
            outputConfig: {
              predictionsFormat: "jsonl",
              gcsDestination: {
                outputUriPrefix: `gs://${GCS_BUCKET_NAME}/outputs/${logId}/`,
              },
            },
            model: `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${HOPE_RECORDER_ACTIVE.batch.model}`,
            modelParameters: {
              speechConfig: HOPE_RECORDER_ACTIVE.batch.speechConfig,
            },
          }),
          muteHttpExceptions: true,
        },
      );

      if (batch.getResponseCode() !== 200) {
        const code = batch.getResponseCode();
        // レスポンス本文には認証情報・パス・PII を含む可能性があるため、Slack 通知用の
        // throw メッセージには載せず、詳細は console.error のみに記録する。
        console.error(
          "[" +
            logId +
            "] Batch投入失敗 HTTP " +
            code +
            ": " +
            batch.getContentText(),
        );
        throw new Error("Batch投入失敗 HTTP " + code);
      }

      const jobName = JSON.parse(batch.getContentText()).name;
      sheet.getRange(rowNumber, 3).setValue(jobName);
      sheet.getRange(rowNumber, 4).setValue("実行中(2/3)");
      sheet
        .getRange(rowNumber, 12)
        .setValue(`gs://${GCS_BUCKET_NAME}/outputs/${logId}/`);

      successCount++;
    } catch (e) {
      const errMsg = e.message;
      // 一時的なサービスエラー: status を「受付」に戻して次回再投入。
      // 同じ行が無限にリトライされないよう N列をインクリメントし MAX_RETRY_COUNT で打ち切る。
      if (errMsg.includes("Service error")) {
        console.warn(`[${logId}] サービスエラーにつきスキップ: ${errMsg}`);
        if (
          _incrementAndCheckRetryLimit_(
            sheet,
            rowNumber,
            logId,
            "Service error: " + errMsg,
          )
        ) {
          continue; // 上限超過: FAILED 固定済み、Slack 通知済み
        }
        sheet.getRange(rowNumber, 4).setValue("受付");
        continue;
      }

      // それ以外のエラーはSlack通知用リストへ
      console.error(`[${logId}] 失敗: ${errMsg}`);
      sheet.getRange(rowNumber, 4).setValue("エラー");
      sheet.getRange(rowNumber, 5).setValue(errMsg);
      errorCount++;
      errorMessages.push(`【投入失敗】ID:${logId} / 内容:${errMsg}`);
    }
  }

  // 純粋なエラーがある時だけ通知
  if (errorMessages.length > 0) {
    sendSlackNotification(
      `🚨 **Batch投入エラー発生**\n${errorMessages.join("\n")}`,
    );
  }

  return `投入完了: 成功${successCount} / 失敗${errorCount}`;
}

// ============================================
// 大容量アップローダー (内部関数)
// ============================================
function uploadLargeFileToGcsByDriveApi_(
  fileId,
  fileSize,
  mimeType,
  bucket,
  path,
  gcsAccessToken,
) {
  const initResp = UrlFetchApp.fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=resumable&name=${encodeURIComponent(path)}`,
    {
      method: "post",
      headers: {
        Authorization: `Bearer ${gcsAccessToken}`,
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": fileSize.toString(),
      },
      muteHttpExceptions: true,
    },
  );

  if (initResp.getResponseCode() !== 200)
    throw new Error(`GCS初期化失敗: ${initResp.getContentText()}`);
  const uploadUrl = initResp.getHeaders()["Location"];

  const driveFile = Drive.Files.get(fileId, { supportsAllDrives: true });
  const downloadUrl = driveFile.downloadUrl;
  const driveAccessToken = ScriptApp.getOAuthToken();

  const CHUNK_SIZE = 20 * 1024 * 1024;
  let offset = 0;

  while (offset < fileSize) {
    const end = Math.min(offset + CHUNK_SIZE, fileSize);
    const downloadHeaders = {
      Authorization: `Bearer ${driveAccessToken}`,
      Range: `bytes=${offset}-${end - 1}`,
    };
    const downloadResp = UrlFetchApp.fetch(downloadUrl, {
      headers: downloadHeaders,
      muteHttpExceptions: true,
    });

    if (
      downloadResp.getResponseCode() !== 200 &&
      downloadResp.getResponseCode() !== 206
    )
      throw new Error(`Driveダウンロード失敗`);

    const partialBlob = downloadResp.getBlob();
    const rangeHeader = `bytes ${offset}-${end - 1}/${fileSize}`;
    const uploadResp = UrlFetchApp.fetch(uploadUrl, {
      method: "put",
      payload: partialBlob,
      headers: { "Content-Range": rangeHeader },
      muteHttpExceptions: true,
    });

    const code = uploadResp.getResponseCode();
    if (code !== 308 && code !== 200 && code !== 201)
      throw new Error(`アップロード中断: ${code}`);
    offset = end;
  }
}

// ============================================
// Worker➂: 高速化版 (全件一括 確認 & 整形)
// ============================================
//
// 時間予算設計（GAS 6 分実行制限への安全マージン）:
//   - GAS の最大実行時間は 6 分（360 秒）。実測 5 分（300 秒）程度で
//     'Execution cancelled' になる事例があるため、関数全体の time budget は 270 秒に設定。
//   - 1 行あたりの cleaning は callGeminiProToCleanText_ 内で 90 秒で打切（後述）。
//     これにより 270 秒予算で 4〜5 行を確実に処理可能。
//   - 残時間 60 秒未満になったら以降の行はスキップ → 次回 trigger に持ち越し。
//
// 過去事例: 21:18:26 開始 → 21:23:25 で Execution cancelled（約 5 分）。
// cleaning hang により後続行も含めて誰も推論完了(3/3)に進めなくなり、
// 同一行が毎回先頭で 5 分消費 → 全行が滞留する症状が発生した。
const CHECK_JOB_STATUS_TIME_BUDGET_MS_ = 270 * 1000; // 全体 270 秒
const CHECK_JOB_STATUS_REMAINING_THRESHOLD_MS_ = 60 * 1000; // 残 60 秒未満で打切

function checkJobStatus() {
  // 環境固有値ガード: GCS バケット / GCP プロジェクトが未設定の環境では誤発火を防ぐために停止
  if (!GCS_BUCKET_NAME || !PROJECT_ID) {
    console.warn(
      "[HopeRecorder] GCS_BUCKET_NAME または PROJECT_ID が未設定のため checkJobStatus を停止します",
    );
    return;
  }
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const token = getOAuthServiceAccountToken_();
  const LOCATION = "us-central1";

  // 全体時間予算ガード: 関数冒頭で計測開始。各行処理前に残時間チェックを行う。
  var startMs = Date.now();

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0; // 時間切れで次回持ち越しになった行数
  let errorMessages = [];

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r[3] !== "実行中(2/3)") continue;

    const rowNumber = i + 1;
    const logId = r[0];
    const jobName = r[2];

    // 残時間チェック: 1 行処理に最悪 90 秒（cleaning 打切時間）を要するため、
    // 残 60 秒未満なら以降の行はスキップして次回 trigger に持ち越す。
    // これにより GAS 6 分制限による 'Execution cancelled' を回避する。
    var elapsedMs = Date.now() - startMs;
    var remainingMs = CHECK_JOB_STATUS_TIME_BUDGET_MS_ - elapsedMs;
    if (remainingMs < CHECK_JOB_STATUS_REMAINING_THRESHOLD_MS_) {
      skippedCount++;
      console.info(
        "[checkJobStatus] 残時間 " +
          remainingMs +
          "ms < " +
          CHECK_JOB_STATUS_REMAINING_THRESHOLD_MS_ +
          "ms。LogID=" +
          logId +
          " を次回持ち越し（経過 " +
          elapsedMs +
          "ms）",
      );
      continue;
    }

    try {
      const jobResp = UrlFetchApp.fetch(
        `https://${LOCATION}-aiplatform.googleapis.com/v1/${jobName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          muteHttpExceptions: true,
        },
      );

      if (jobResp.getResponseCode() !== 200) continue;
      const job = JSON.parse(jobResp.getContentText());

      if (job.state === "JOB_STATE_SUCCEEDED") {
        const listResp = UrlFetchApp.fetch(
          `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET_NAME}/o?prefix=outputs/${logId}/`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const list = JSON.parse(listResp.getContentText());
        let rawDraftText = "";

        (list.items || [])
          .filter((obj) => obj.name.endsWith("predictions.jsonl"))
          .forEach((obj) => {
            const url = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET_NAME}/o/${encodeURIComponent(obj.name)}?alt=media`;
            const content = UrlFetchApp.fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            }).getContentText();
            content
              .trim()
              .split(/\r?\n/)
              .forEach((line) => {
                try {
                  const t =
                    JSON.parse(line)?.response?.candidates?.[0]?.content
                      ?.parts?.[0]?.text;
                  if (t) rawDraftText += t + "\n";
                } catch (_) {}
              });
          });

        if (rawDraftText.trim()) {
          // callGeminiProToCleanText_ は内部 time budget(90秒) + maxAttempts:2 + flash フォールバックで
          // hang しない設計。それでも例外が出た場合は下の catch に落ちて当該行のみエラー化し、
          // 次行へ進む（無限 hang による全行滞留を防ぐ）。
          const finalCleanedText = callGeminiProToCleanText_(
            rawDraftText.trim(),
          );
          sheet.getRange(rowNumber, 13).setValue(finalCleanedText);
          sheet.getRange(rowNumber, 4).setValue("推論完了(3/3)");
          sheet.getRange(rowNumber, 5).setValue("");
          successCount++;
        } else {
          // Batch は成功したが predictions.jsonl が空。
          // 再ポーリングしても結果は変わらないため確定エラーへ移行。
          sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
          sheet
            .getRange(rowNumber, 5)
            .setValue("Batch成功だが出力テキストが空");
          errorMessages.push("【出力空】ID:" + logId);
        }
      } else if (
        job.state === "JOB_STATE_FAILED" ||
        job.state === "JOB_STATE_CANCELLED"
      ) {
        throw new Error(job.error?.message || "ジョブ失敗");
      }
    } catch (e) {
      // Service error は次回ポーリングでリトライ可能なため status 据え置きで次行へ。
      if (e.message.includes("Service error")) continue;
      // cleaning time budget 超過・全試行失敗・その他例外は当該行を確定エラー化し、
      // 次行の処理を継続する（行単位の前進保証）。
      sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
      sheet
        .getRange(rowNumber, 5)
        .setValue(String(e.message || "").substring(0, 500));
      errorCount++;
      errorMessages.push(`【整形失敗】ID:${logId} / 内容:${e.message}`);
    }
  }

  if (errorMessages.length > 0) {
    sendSlackNotification(
      `🚨 **整形・確認エラー発生**\n${errorMessages.join("\n")}`,
    );
  }
  if (skippedCount > 0) {
    console.info(
      "[checkJobStatus] 時間切れ持ち越し: " +
        skippedCount +
        " 件（次回 trigger で再処理）",
    );
  }
}

// ============================================
// 精密整形・仕上げ関数
// ============================================

/**
 * cleaning 1 行あたりの hard cap（time budget）。
 *
 * 設計値の根拠:
 *   - GAS 全体実行制限 6 分（360 秒）の中で checkJobStatus 全体予算 270 秒。
 *     1 行あたり最大 90 秒で打切れば 3 行は確実、軽い行も含めれば 4〜5 行処理可能。
 *   - pro 試行（maxAttempts:2、内部 5xx バックオフ 1s/3s/7s 含む） + flash フォールバック 1 試行を
 *     合算して 90 秒以内で「成功 or throw」を保証する目標値。
 *   - 90 秒を超えた場合は throw → checkJobStatus 側で catch → status='エラー(3/3)' で次行へ進む。
 *
 * 過去事例: cleaning が 5 分間応答せず GAS 全体が 'Execution cancelled' になり、
 * 後続行も含めて誰も推論完了(3/3)に進めなくなった（2026-04 滞留 6 件）。
 */
const CLEANING_TIME_BUDGET_MS_ = 90 * 1000;

/**
 * pro 試行打切のソフトリミット（time budget の半分）。
 *
 * pro 試行で経過時間がこの値を超えた場合、後続の flash フォールバックに余裕を残すため
 * pro 全試行失敗とみなして flash に切替える。pro 自体は内部で maxAttempts:2 のため
 * 通常はソフトリミット到達前に終わるが、5xx バックオフが重なると到達することがある。
 */
const CLEANING_PRO_SOFT_LIMIT_MS_ = 60 * 1000;

/**
 * flash フォールバックモデル。pro 全試行失敗時の最後の砦。
 *
 * モデル選定理由:
 *   - 同じ Gemini 2.5 系で API 互換性が高く、応答速度が pro より速い（cleaning hang 回避に有効）
 *   - safetySettings / temperature 等のパラメータをそのまま流用可能
 *   - 整形品質は pro より落ちるが、滞留させて手動介入させるよりは flash で前進させる方が運用上有利
 *
 * 応答先頭にフォールバック表示を付けることで、運用者が品質劣化に気付けるようにする。
 */
const CLEANING_FALLBACK_MODEL_ = "gemini-2.5-flash";

/**
 * Gemini Pro でクリーニング・整形する。
 *
 * 堅牢化（2026-04-30 改修）:
 *   - time budget 90 秒の hard cap。pro 試行 → 残時間チェック → flash フォールバック → throw。
 *   - pro 試行は maxAttempts:2 に短縮（既定 4 だと 5xx バックオフ込で長時間 hang する）。
 *   - flash フォールバック成功時は応答先頭に [フォールバック: gemini-2.5-flash 使用] を付与。
 *   - 全試行失敗時は throw → 呼出元（checkJobStatus）が catch して status='エラー(3/3)' へ。
 *
 * PII マスキング（040_PiiMasker.js）:
 *   - cleaning フェーズは AppSheet 側 利用者選択 前 に走るため、利用者氏名は不明。
 *     職員リスト（StaffStatus__c, 1 時間キャッシュ）のみで registry を構築する。
 *   - 利用者氏名・支援者・家族名のマスキングは利用者選択後の enrichCaseRecord_ で行う
 *     （Site C, 102_HopeContextRecorder.js）。
 *   - 残存リスクは docs/pii-masking-residual-risks.md 参照。
 *
 * 後方互換性:
 *   - シグネチャ (rawText) のみ。既存呼出元の変更不要。
 *   - PII_MASKING_ENABLED = false の時は registry が no-op となり、既存挙動と一致。
 *   - 040_PiiMasker.js が未デプロイ環境では呼出に失敗するため、try/catch で fall through。
 *
 * @param {string} rawText Vertex Batch の出力テキスト
 * @returns {string} クリーニング済テキスト（フォールバック時は先頭にマーカー付）
 */
function callGeminiProToCleanText_(rawText) {
  // 関数全体の time budget 計測開始
  var cleaningStartMs = Date.now();

  // PII マスキング（職員名のみ）。失敗時は素通しで原文渡し（既存挙動を維持するが運用者へ通知）。
  //
  // **不変条件への明示的トレードオフ**:
  //   「LLM ペイロードに PII を含めない」を完全保証するなら、ここで throw して
  //   Cleaning 全体を停止すべき。しかし HopeRecorder の Cleaning は cron 駆動の
  //   後段処理のため、停止すると無音で文字起こしが滞留する。運用上の検知性を優先し、
  //   フォールバック許容 + Slack 通知 で「マスキングが効いていない時間帯」を把握できる
  //   設計とする。Slack 通知が来た場合は即座に StaffStatus__c API / CacheService の
  //   状態を確認すること。
  var registry = null;
  try {
    var staffList = getStaffListCachedForCleaning_();
    registry = buildPiiRegistry_({ staffList: staffList });
    console.info(
      "[callGeminiProToCleanText_] piiMasking entityCount=" + registry.count,
    );
  } catch (e) {
    console.error(
      "[callGeminiProToCleanText_] PII マスキング初期化失敗、原文で続行: " +
        e.message,
    );
    sendSlackNotification(
      "🚨 [PiiMasker] HopeRecorder Cleaning マスキング初期化失敗。職員名が平文で Gemini に送信されている可能性があります。詳細は GAS Cloud Logging を確認してください。",
    );
    registry = null;
  }
  var maskedRawText = registry ? maskText_(rawText, registry) : rawText;

  var cleaningPrompt =
    HOPE_RECORDER_ACTIVE.cleaning.promptSystem + maskedRawText;

  // 介護面談の文字起こしには、自殺念慮・虐待・身体接触・暴力的言動などの話題が
  // 含まれうる。これらが安全フィルタで弾かれると整形が成立しないため、Batch 側と
  // 同じ 4 カテゴリで BLOCK_NONE を明示する。
  var payload = {
    contents: [{ role: "user", parts: [{ text: cleaningPrompt }] }],
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    ],
    generationConfig: {
      temperature: HOPE_RECORDER_ACTIVE.cleaning.temperature,
    },
  };

  var primaryModel = HOPE_RECORDER_ACTIVE.cleaning.model;
  var usedFallback = false;
  var parsed = null;
  var primaryError = null;

  // ===== Phase 1: pro 試行 =====
  // maxAttempts:2 に短縮（既定 4 だと 5xx バックオフ込で長時間 hang する）。
  // 内部の callGeminiWithKeyRotation_ は全キーを順次試行するため、
  // 1 キーあたり 2 試行 × N キー で実質 2N 回の呼出となる。
  try {
    parsed = callGeminiWithKeyRotation_(primaryModel, payload, {
      apiVersion: "v1beta",
      maxAttempts: 2,
    });
  } catch (e) {
    primaryError = e;
    console.warn(
      "[callGeminiProToCleanText_] pro (" +
        primaryModel +
        ") 全試行失敗: " +
        e.message,
    );
  }

  // ===== Phase 2: time budget チェック → flash フォールバック =====
  var elapsedAfterPrimary = Date.now() - cleaningStartMs;

  // pro が成功したが応答が空（finishReason 異常等）の場合も flash フォールバックの対象にする。
  if (parsed) {
    var primaryText = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!primaryText) {
      var primaryFinishReason = parsed?.candidates?.[0]?.finishReason || "不明";
      console.warn(
        "[callGeminiProToCleanText_] pro 応答が空 finishReason=" +
          primaryFinishReason +
          "、flash フォールバックを試行",
      );
      primaryError = new Error(
        "Gemini クリーニング応答が空 (finishReason: " +
          primaryFinishReason +
          ")",
      );
      parsed = null;
    }
  }

  // pro 失敗または空応答 → 残時間が flash 1 試行分（30 秒以上）あればフォールバック実行。
  if (!parsed && elapsedAfterPrimary < CLEANING_TIME_BUDGET_MS_ - 30 * 1000) {
    console.info(
      "[callGeminiProToCleanText_] flash フォールバック開始（経過 " +
        elapsedAfterPrimary +
        "ms / 予算 " +
        CLEANING_TIME_BUDGET_MS_ +
        "ms）",
    );
    try {
      // flash 単独試行も maxAttempts:2 に短縮（残時間内で確実に終わらせる）
      parsed = callGeminiWithKeyRotation_(CLEANING_FALLBACK_MODEL_, payload, {
        apiVersion: "v1beta",
        maxAttempts: 2,
      });
      usedFallback = true;
      console.info("[callGeminiProToCleanText_] flash フォールバック成功");
    } catch (e2) {
      console.error(
        "[callGeminiProToCleanText_] flash フォールバックも失敗: " + e2.message,
      );
      // 両方失敗 → throw（呼出元で catch して当該行のみエラー化）
      var combinedMsg =
        "cleaning 全試行失敗: pro=" +
        (primaryError ? primaryError.message : "unknown") +
        " / flash=" +
        e2.message;
      throw new Error(combinedMsg);
    }
  }

  // ===== Phase 3: time budget 超過チェック =====
  // pro 試行のみで time budget 超過（flash フォールバックする余裕すら無かった場合）。
  if (!parsed) {
    var hardElapsed = Date.now() - cleaningStartMs;
    var msg =
      "cleaning time budget 超過 (" +
      hardElapsed +
      "ms / " +
      CLEANING_TIME_BUDGET_MS_ +
      "ms): " +
      (primaryError ? primaryError.message : "unknown");
    console.error("[callGeminiProToCleanText_] " + msg);
    throw new Error(msg);
  }

  // ===== Phase 4: 最終応答取得 =====
  var text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    var reason = parsed?.candidates?.[0]?.finishReason || "不明";
    console.error("Gemini クリーニング応答が空 finishReason=" + reason);
    throw new Error(
      "Gemini クリーニング応答が空 (finishReason: " + reason + ")",
    );
  }

  // 最終的に hard cap 超過していた場合は警告ログのみ（応答自体は使う）
  var totalElapsed = Date.now() - cleaningStartMs;
  if (totalElapsed > CLEANING_TIME_BUDGET_MS_) {
    console.warn(
      "[callGeminiProToCleanText_] time budget 超過後に応答取得 " +
        totalElapsed +
        "ms（次回以降の改善検討対象）",
    );
  }

  // PII アンマスク + 監査ログ。registry が null なら no-op。
  var finalText;
  if (registry) {
    detectUnknownTokens_(text, registry);
    finalText = unmaskText_(text, registry);
  } else {
    finalText = text;
  }

  // フォールバック使用時は応答先頭にマーカーを付与（運用者が品質劣化に気付けるようにする）。
  // enrich 経路（102_HopeContextRecorder.js）と同じパターン。
  if (usedFallback) {
    finalText =
      "[フォールバック: " + CLEANING_FALLBACK_MODEL_ + " 使用]\n\n" + finalText;
  }
  return finalText;
}

/**
 * cleaning フェーズ用の StaffStatus__c キャッシュ取得。
 *
 * 102_HopeContextRecorder.js#getStaffListCached_ と同じキー（PII_MASKER_STAFF_LIST）を共有し
 * AppSheet API 負荷を最小化する。GAS の単一プロジェクト内で CacheService は共通スコープのため
 * 関数を分けても同じキャッシュエントリを参照する。
 *
 * 失敗時は空配列で fall through（マスキングは継続するが registry は空 = no-op）。
 *
 * @returns {Array<Object>}
 */
function getStaffListCachedForCleaning_() {
  // 102 側の実装をそのまま流用。同名関数があれば衝突するため、別名で定義し内部で 102 側を呼ぶ。
  // 102 がデプロイされていない環境（孤立した HopeRecorder のみ動作させる場合）でも動くよう
  // 見つからない時は AppSheet API を直接叩くフォールバックを置く。
  if (typeof getStaffListCached_ === "function") {
    return getStaffListCached_();
  }
  // フォールバック: 102 が無い場合の最小実装
  try {
    var props = PropertiesService.getScriptProperties();
    var APP_ID = props.getProperty("APPSHEET_APP_ID");
    var API_KEY = props.getProperty("APPSHEET_API_KEY");
    if (!APP_ID || !API_KEY) return [];
    var rows = callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn(
      "[getStaffListCachedForCleaning_] フォールバック取得失敗: " + e.message,
    );
    return [];
  }
}

// ============================================
// Worker④: 高速化版 (全件一括 AppSheet送信)
// ============================================
function processAppSheetSendWorker() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const values = sheet.getDataRange().getValues();

  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty("APPSHEET_APP_ID");
  const apiKey = props.getProperty("APPSHEET_API_KEY");
  const tableName = props.getProperty("APPSHEET_TABLE_NAME") || "RecordingData";

  if (!appId || !apiKey) return;

  const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${tableName}/Action`;
  let successCount = 0;
  let errorMessages = [];

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const rowNumber = i + 1;
    if (r[3] !== "推論完了(3/3)") continue;

    const logId = r[0];

    // 199_HopeRecorderTest.js から投入された TEST_ プレフィックス行は AppSheet/SF へ流さない。
    // Batch 投入・checkJobStatus による文字起こし結果の M 列書き込みは TEST_ 行も実施される（比較目的）。
    // AppSheet 送信スキップのみがテスト分離の役割。
    if (typeof logId === "string" && logId.indexOf("TEST_") === 0) {
      sheet.getRange(rowNumber, 4).setValue("TEST完了（AppSheet送信スキップ）");
      continue;
    }

    try {
      sheet.getRange(rowNumber, 4).setValue("送信中...");
      SpreadsheetApp.flush();

      let formattedStartTime = r[9]
        ? Utilities.formatDate(new Date(r[9]), "Asia/Tokyo", "HH:mm:ss")
        : "";
      let formattedCreateDate = r[10]
        ? Utilities.formatDate(new Date(r[10]), "Asia/Tokyo", "yyyy/MM/dd")
        : "";

      const payload = {
        Action: "Add",
        Properties: { Locale: "ja-JP", Timezone: "Tokyo Standard Time" },
        Rows: [
          {
            音声URL: r[5],
            音声ファイル名: r[6],
            職員在籍ID: r[7],
            オブジェクト名: r[8],
            ケース記録種別: "音声記録",
            開始時間: formattedStartTime,
            作成日: formattedCreateDate,
            文字起こしテキスト: r[12],
            フラグ: false,
            処理フラグ: false,
          },
        ],
      };

      const resp = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { ApplicationAccessKey: apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      if (resp.getResponseCode() === 200) {
        sheet.getRange(rowNumber, 4).setValue("AppSheet反映済み");
        sheet.getRange(rowNumber, 14).setValue(0);
        successCount++;
      } else {
        // AppSheet 返却本文には行データ（PII を含む文字起こしテキスト等）が
        // エコーバックされうるため、Slack 通知用の throw メッセージには HTTP コードのみ。
        console.error(
          "[" +
            logId +
            "] AppSheet 返却エラー HTTP " +
            resp.getResponseCode() +
            ": " +
            resp.getContentText(),
        );
        throw new Error("AppSheet返却エラー HTTP " + resp.getResponseCode());
      }
    } catch (e) {
      // 一時的なサービスエラー: status を「推論完了(3/3)」に戻して次回送信を試みる。
      // N 列をインクリメントし MAX_RETRY_COUNT で打ち切る（無限リトライ防止）。
      if (e.message.includes("Service error")) {
        if (
          _incrementAndCheckRetryLimit_(
            sheet,
            rowNumber,
            logId,
            "AppSheet Service error: " + e.message,
          )
        ) {
          continue; // 上限超過: FAILED 固定、Slack 通知済み
        }
        sheet.getRange(rowNumber, 4).setValue("推論完了(3/3)");
        continue;
      }
      sheet.getRange(rowNumber, 4).setValue("エラー(4/4)");
      sheet.getRange(rowNumber, 5).setValue(e.message);
      errorMessages.push(`【AppSheet失敗】ID:${logId} / 内容:${e.message}`);
    }
  }

  if (errorMessages.length > 0) {
    sendSlackNotification(
      `🚨 **AppSheet送信エラー発生**\n${errorMessages.join("\n")}`,
    );
  }
}

// ============================================
// 音声尺の近似推定（ファイルサイズベース）
// ============================================
/**
 * mimeType とファイルサイズから音声尺（秒）を近似推定する。
 *
 * 設計方針:
 *   - GAS では FFprobe 等が動かないため、コーデック別の典型ビットレートで近似する。
 *   - 60 分（3600 秒）超かどうかの粗判定が目的。誤差は 30〜50% 程度許容する。
 *
 * 換算根拠:
 *   - WAV (PCM 16bit 44.1kHz stereo): 約 600 KB/秒（CD品質）
 *   - 圧縮系（mp3 / m4a / aac / ogg / その他）: 128kbps 換算で約 16 KB/秒
 *
 * @param {number} fileSize  バイト数
 * @param {string} mimeType  Drive から取得した MIME タイプ
 * @returns {number} 推定尺（秒）
 */
function estimateAudioDurationSeconds_(fileSize, mimeType) {
  if (!fileSize || fileSize <= 0) {
    console.warn(
      "[estimateAudioDuration] fileSize が 0 以下。破損ファイルの可能性: " +
        fileSize,
    );
    return 0;
  }
  if (!mimeType) {
    console.warn(
      "[estimateAudioDuration] mimeType 未定義のため圧縮系ビットレートで近似します",
    );
  }
  const isWav = mimeType === "audio/wav" || mimeType === "audio/x-wav";
  // 業務用レコーダーは 8kHz モノラル PCM 16bit ≒ 16 KB/秒の場合あり、
  // CD 品質 44.1kHz ステレオは約 600 KB/秒。判定は ±50% 誤差を許容する前提。
  // 介護面談のスマホ録音は CD 品質に近いケースが多く、業務端末の場合は要再調整。
  const bytesPerSecond = isWav ? 600 * 1024 : 16 * 1024;
  return fileSize / bytesPerSecond;
}
