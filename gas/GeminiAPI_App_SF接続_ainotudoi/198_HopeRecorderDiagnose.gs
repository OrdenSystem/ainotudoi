/**
 * HopeRecorder エラー診断ユーティリティ
 *
 * 用途:
 *   - processTranscriptionWorker でエラー停止した行（status="エラー"）の原因切り分け
 *   - GCS Bandwidth quota 等の transient なエラーから手動リカバーするためのリトライ
 *   - 個別 LogID のアップロード経路を独立して再現テスト
 *
 * 設計方針:
 *   - 全関数末尾アンダースコアなし（GAS UI から手動実行可能）
 *   - 副作用が大きい関数（実際にGCSへアップロードする等）は冒頭でログ警告
 *   - 既存の processTranscriptionWorker / uploadLargeFileToGcsByDriveApi_ を流用
 *   - 199_HopeRecorderTest.js（A/B比較用）とは分離
 *
 * 想定される使用シーン:
 *   1. Slack で「Bandwidth quota exceeded」通知が来た
 *   2. → diagnose_listStuckRows() で停止中の行一覧を確認
 *   3. → diagnose_smallDummyGcsUpload() で GCS quota が回復しているか確認
 *   4. → diagnose_retryStuckRow('VACH1215') で対象行のステータスを「受付」に戻す
 *   5. → 次の processTranscriptionWorker トリガー実行で自動再投入
 */

// =====================================================================
// 列インデックス（POST履歴シート）
// 101_HopeRecorder.js#HopeRecorderStartTranscription での appendRow 順に従う
// =====================================================================
//   A=0  LogID
//   B=1  作成日時
//   C=2  jobName
//   D=3  status
//   E=4  詳細メッセージ
//   F=5  audioFileUrl
//   G=6  audioFileName
//   H=7  saleseforceUserID
//   I=8  saleseforceObject
//   J=9  Record_StartTime__c
//   K=10 CreateDate__c
//   L=11 outputUriPrefix
//   M=12 final cleaned text
//   N=13 retry counter

/**
 * 停止中（status="エラー"系 / "FAILED"）の行を一覧表示する。Bandwidth 関連エラーをハイライト。
 *
 * 使用方法: GAS UI で関数 diagnose_listStuckRows を選択 → 実行 → 「ログ」タブで結果確認
 */
function diagnose_listStuckRows() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var stuck = [];
  var bandwidthCount = 0;

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var status = String(row[3] || "");
    if (/^エラー/.test(status) || status === "FAILED") {
      var msg = String(row[4] || "");
      var isBandwidth = /Bandwidth|quota.*exceed|429|rate.?limit/i.test(msg);
      if (isBandwidth) bandwidthCount++;
      stuck.push({
        rowNumber: i + 1,
        logId: row[0],
        status: status,
        retryCount: Number(row[13]) || 0,
        msgSnippet: msg.substring(0, 120).replace(/[\r\n]/g, " "),
        isBandwidth: isBandwidth,
      });
    }
  }

  Logger.log("===== 停止中の行一覧 =====");
  Logger.log(
    "総数: " +
      stuck.length +
      " 件 (うち Bandwidth/quota 関連: " +
      bandwidthCount +
      " 件)",
  );
  stuck.forEach(function (s) {
    Logger.log(
      (s.isBandwidth ? "⚠️ " : "   ") +
        "Row=" +
        s.rowNumber +
        " / LogID=" +
        s.logId +
        " / status=" +
        s.status +
        " / retry=" +
        s.retryCount +
        " / msg=" +
        s.msgSnippet,
    );
  });
  if (bandwidthCount > 0) {
    Logger.log("");
    Logger.log(
      '対応: GCS quota が回復したら diagnose_retryStuckRow("LogID") で個別に再投入できます。',
    );
    Logger.log(
      "     一括リトライは diagnose_retryAllBandwidthErrors() で実行可能です。",
    );
    Logger.log("     手動リトライ時は N列(RetryCount) を 0 にリセットします。");
  }
}

/**
 * 指定 LogID の行情報をダンプする（PII を含む列はマスク）。
 *
 * 確認できる項目:
 *   - status / 詳細メッセージ
 *   - audioFileUrl から取得できる Drive File メタデータ（サイズ・MIME・最終更新）
 *   - 推定音声長（estimateAudioDurationSeconds_ を呼出）
 *
 * 副作用なし（読み取りのみ）。
 *
 * @param {string} logId 例: "VACH1215"
 */
function diagnose_inspectRow(logId) {
  if (!logId) {
    Logger.log("❌ logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var row = values[i];
    var rowNumber = i + 1;
    Logger.log("===== Row " + rowNumber + " (LogID=" + logId + ") =====");
    Logger.log("status        : " + row[3]);
    Logger.log(
      "msg(先頭200文字): " +
        String(row[4] || "")
          .substring(0, 200)
          .replace(/[\r\n]/g, " "),
    );
    Logger.log("audioFileName : " + row[6]);
    Logger.log("audioFileUrl  : " + row[5]);
    Logger.log("jobName       : " + (row[2] || "(未投入)"));
    Logger.log("outputUri     : " + (row[11] || "(未投入)"));

    // Drive File メタデータ
    try {
      var fileId = extractFileIdFromUrl(row[5]);
      if (!fileId) {
        Logger.log("❌ Drive URL から FileID 抽出失敗");
        return;
      }
      var driveFile = DriveApp.getFileById(fileId);
      var fileSize = driveFile.getSize();
      var mimeType = driveFile.getMimeType();
      Logger.log("--- Drive File メタデータ ---");
      Logger.log("fileId   : " + fileId);
      Logger.log(
        "size     : " +
          fileSize +
          " bytes (" +
          (fileSize / 1024 / 1024).toFixed(1) +
          " MB)",
      );
      Logger.log("mimeType : " + mimeType);
      Logger.log("lastUpd  : " + driveFile.getLastUpdated());

      // 推定音声長（101_HopeRecorder.js の関数を流用）
      if (typeof estimateAudioDurationSeconds_ === "function") {
        var sec = estimateAudioDurationSeconds_(fileSize, mimeType);
        Logger.log(
          "推定尺   : " +
            Math.round(sec) +
            " 秒 (" +
            Math.round(sec / 60) +
            " 分)",
        );
      }
    } catch (e) {
      Logger.log("❌ Drive File アクセス失敗: " + e.message);
    }
    return;
  }
  Logger.log("❌ LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * GCS バケットに 1KB のダミーファイルをアップロードして、現在の bandwidth quota が
 * 回復しているかを確認する。
 *
 * 副作用: バケット直下に `diagnose/connectivity_test_<timestamp>.txt` を作成する。
 * （本番処理の inputs/ プレフィックスとは分離するため、Lifecycle Policy の影響を受けない）
 */
function diagnose_smallDummyGcsUpload() {
  var bucket = GCS_BUCKET_NAME;
  var token = getOAuthServiceAccountToken_();
  var fileName =
    "diagnose/connectivity_test_" +
    Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmmss") +
    ".txt";
  var content = "GCS connectivity diagnose " + new Date().toString();

  Logger.log("===== GCS 接続確認（ダミーアップロード） =====");
  Logger.log("bucket   : " + bucket);
  Logger.log("object   : " + fileName);
  Logger.log("size     : " + content.length + " bytes");

  var url =
    "https://storage.googleapis.com/upload/storage/v1/b/" +
    bucket +
    "/o?uploadType=media&name=" +
    encodeURIComponent(fileName);

  var startMs = new Date().getTime();
  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "text/plain",
    payload: content,
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });
  var durMs = new Date().getTime() - startMs;
  var code = resp.getResponseCode();
  var body = resp
    .getContentText()
    .substring(0, 300)
    .replace(/[\r\n]/g, " ");

  Logger.log("HTTP     : " + code);
  Logger.log("duration : " + durMs + " ms");

  if (code === 200) {
    Logger.log("✅ アップロード成功。GCS への帯域は現在利用可能。");
    Logger.log("   実ファイルアップロードに復帰可能と判断できます。");
  } else if (code === 429 || /Bandwidth|quota/i.test(body)) {
    Logger.log("❌ Bandwidth/quota 制限が継続中: " + body);
    Logger.log("   時間をおいて再実行してください（数分〜数時間）。");
    Logger.log(
      "   GCP Console > IAM > Quota で詳細確認: https://console.cloud.google.com/iam-admin/quotas",
    );
  } else {
    Logger.log("❌ 想定外エラー HTTP " + code + ": " + body);
  }
}

/**
 * 指定 LogID の行のステータスを「受付」に戻し、N列（RetryCount）を 0 にリセットして
 * 次回 processTranscriptionWorker 実行で自動再投入させる。
 *
 * 仕様:
 *   - 'エラー'系 と 'FAILED'（自動リトライ上限超過）の両方から復帰可能
 *   - 手動介入は人為的判断のため自動リトライカウンタを 0 リセットする
 *   - 詳細メッセージは「manual retry」付きで残す（前回エラー内容も保存）
 *
 * 注意:
 *   - GCS quota が回復していることを diagnose_smallDummyGcsUpload で確認してから実行すること
 *   - 二重リトライ防止のため、'エラー'系 / 'FAILED' 以外の status では何もしない
 *
 * @param {string} logId 例: "VACH1215"
 */
function diagnose_retryStuckRow(logId) {
  if (!logId) {
    Logger.log("❌ logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var rowNumber = i + 1;
    var status = String(values[i][3] || "");
    if (!/^エラー/.test(status) && status !== "FAILED") {
      Logger.log(
        "⚠️ LogID=" +
          logId +
          ' の status は "' +
          status +
          '" のため、リトライしません。',
      );
      Logger.log(
        "   既に処理が進行中、もしくは正常完了している可能性があります。",
      );
      return;
    }
    var prevRetry = Number(values[i][13]) || 0;
    var prevMsg = String(values[i][4] || "").substring(0, 100);
    sheet.getRange(rowNumber, 4).setValue("受付");
    sheet
      .getRange(rowNumber, 5)
      .setValue(
        "[manual retry @ " +
          Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss") +
          " / N reset from " +
          prevRetry +
          "] prev: " +
          prevMsg,
      );
    sheet.getRange(rowNumber, 14).setValue(0); // N列リセット（人為的介入で再カウント開始）
    Logger.log(
      "✅ LogID=" +
        logId +
        " Row=" +
        rowNumber +
        " を「受付」に戻し、RetryCount を " +
        prevRetry +
        " → 0 にリセットしました。",
    );
    return;
  }
  Logger.log("❌ LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * Bandwidth/quota 関連エラーで停止している全行を一括で「受付」に戻す。
 *
 * 注意:
 *   - GCS quota が回復していない状態で実行すると同じエラーが多発する
 *   - 必ず diagnose_smallDummyGcsUpload で先に確認すること
 *   - 大量のリトライが GCS quota を再度逼迫させる可能性があるため、
 *     ロット数を MAX_RETRY_PER_RUN で制限する
 */
function diagnose_retryAllBandwidthErrors() {
  var MAX_RETRY_PER_RUN = 10;
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var retried = [];

  for (
    var i = 1;
    i < values.length && retried.length < MAX_RETRY_PER_RUN;
    i++
  ) {
    var row = values[i];
    var status = String(row[3] || "");
    // 'エラー'系 と 'FAILED'（自動リトライ上限超過）の両方を対象に
    if (!/^エラー/.test(status) && status !== "FAILED") continue;
    var msg = String(row[4] || "");
    if (!/Bandwidth|quota.*exceed|429|rate.?limit/i.test(msg)) continue;

    var rowNumber = i + 1;
    var logId = row[0];
    var prevRetry = Number(row[13]) || 0;
    var prevMsg = msg.substring(0, 100);
    sheet.getRange(rowNumber, 4).setValue("受付");
    sheet
      .getRange(rowNumber, 5)
      .setValue(
        "[bulk retry @ " +
          Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss") +
          " / N reset from " +
          prevRetry +
          "] prev: " +
          prevMsg,
      );
    sheet.getRange(rowNumber, 14).setValue(0); // N列リセット（人為的介入で再カウント開始）
    retried.push({ rowNumber: rowNumber, logId: logId, prevRetry: prevRetry });
  }

  Logger.log("===== Bandwidth エラー一括リトライ =====");
  Logger.log(
    "リトライ件数: " +
      retried.length +
      (retried.length === MAX_RETRY_PER_RUN ? " (上限到達)" : ""),
  );
  retried.forEach(function (r) {
    Logger.log(
      "  Row=" +
        r.rowNumber +
        " / LogID=" +
        r.logId +
        " / N reset from " +
        r.prevRetry +
        " → 0",
    );
  });
  if (retried.length === MAX_RETRY_PER_RUN) {
    Logger.log(
      "⚠️ 上限 " +
        MAX_RETRY_PER_RUN +
        " 件に到達。残りは次回実行してください。",
    );
  }
}

/**
 * 指定 LogID の音声を、Vertex Batch を投入せず GCS アップロードだけ実行して
 * Bandwidth エラーの再現可否を確認する。
 *
 * 副作用:
 *   - GCS の `inputs/diagnose_<logId>.<ext>` パスにファイルがアップロードされる
 *   - 本番の inputs/<LogID>_... とはパスを分けるため、後続 Vertex Batch には影響しない
 *
 * 用途:
 *   - quota が回復していると思われる時点で、特定の大容量ファイルだけを
 *     試しにアップロードしてみる（Vertex 課金は発生しない）
 *
 * @param {string} logId
 */
function diagnose_retryGcsUploadOnly(logId) {
  if (!logId) {
    Logger.log("❌ logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var row = values[i];
    Logger.log("===== diagnose_retryGcsUploadOnly LogID=" + logId + " =====");
    Logger.log("対象 Vertex Batch は投入しません（GCS アップロードのみ）");

    try {
      var fileId = extractFileIdFromUrl(row[5]);
      if (!fileId) {
        Logger.log("❌ Drive URL から FileID 抽出失敗");
        return;
      }
      var driveFile = DriveApp.getFileById(fileId);
      var fileSize = driveFile.getSize();
      var mimeType = driveFile.getMimeType();
      var safeFileName = String(row[6]).replace(/[\s\/\\?%*:|"<>#&]/g, "_");
      // 本番パス inputs/<LogID>_<filename> と分離するため diagnose_ プレフィックスを使う
      var audioPath = "inputs/diagnose_" + logId + "_" + safeFileName;
      var token = getOAuthServiceAccountToken_();

      Logger.log("size     : " + (fileSize / 1024 / 1024).toFixed(1) + " MB");
      Logger.log("mimeType : " + mimeType);
      Logger.log("GCSpath  : gs://" + GCS_BUCKET_NAME + "/" + audioPath);

      var startMs = new Date().getTime();
      uploadLargeFileToGcsByDriveApi_(
        fileId,
        fileSize,
        mimeType,
        GCS_BUCKET_NAME,
        audioPath,
        token,
      );
      var durMs = new Date().getTime() - startMs;

      Logger.log(
        "✅ アップロード成功 (" +
          durMs +
          " ms, 平均 " +
          (fileSize / 1024 / 1024 / (durMs / 1000)).toFixed(2) +
          " MB/s)",
      );
    } catch (e) {
      Logger.log("❌ アップロード失敗: " + e.message);
      if (/Bandwidth|quota/i.test(e.message)) {
        Logger.log("   → quota が継続中。時間をおいて再実行してください。");
      }
    }
    return;
  }
  Logger.log("❌ LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * 指定 LogID の行を AppSheet に手動送信して詳細な診断情報をログ出力する。
 *
 * 用途:
 *   - status='推論完了(3/3)' の行を即時送信して 400 / 200 を確認
 *   - 通常の processAppSheetSendWorker は cron 待ちだが、この関数は即時実行
 *   - HTTP レスポンス本文を 完全 にログ出力（通常時の console.error は truncate あり）
 *
 * 副作用:
 *   - 成功時: status='AppSheet反映済み' に更新され、AppSheet 側にも本番レコードが生成される
 *   - 失敗時: status は '推論完了(3/3)' のまま据え置き（リトライ可能な状態を維持）
 *   - TEST_ プレフィックス行も送信対象に含める（本番との比較診断用）
 *
 * 文字数事前チェック付き:
 *   - 文字起こしテキスト (M列) が 32,000 文字超なら警告のみで続行
 *
 * @param {string} logId 例: "7ZMD7CHJ"
 */
function diagnose_sendOneRowToAppSheet(logId) {
  if (!logId) {
    Logger.log("❌ logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty("APPSHEET_APP_ID");
  var apiKey = props.getProperty("APPSHEET_API_KEY");
  var tableName = props.getProperty("APPSHEET_TABLE_NAME") || "RecordingData";

  if (!appId || !apiKey) {
    Logger.log("❌ APPSHEET_APP_ID または APPSHEET_API_KEY 未設定");
    return;
  }

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var r = values[i];
    var rowNumber = i + 1;
    var status = String(r[3] || "");

    Logger.log("===== diagnose_sendOneRowToAppSheet LogID=" + logId + " =====");
    Logger.log("Row=" + rowNumber + " / status=" + status);
    Logger.log(
      "対象テーブル: " +
        tableName +
        " (App ID 末尾4: ****" +
        appId.substring(appId.length - 4) +
        ")",
    );

    if (status !== "推論完了(3/3)" && status !== "エラー(4/4)") {
      Logger.log(
        '⚠️ status が "推論完了(3/3)" でも "エラー(4/4)" でもありません。続行しますが想定外の状態です。',
      );
    }

    var transcribedText = String(r[12] || "");
    Logger.log("文字起こしテキスト 長さ: " + transcribedText.length + " 文字");
    if (transcribedText.length > 32000) {
      Logger.log(
        "⚠️ 32,000 文字超: AppSheet Database の LongText 上限に近い、または超過の可能性",
      );
    } else if (transcribedText.length > 5000) {
      Logger.log(
        "ℹ️ 5,000 文字超: AppSheet 列が LongText 型である必要があります（Text 型なら必ず失敗）",
      );
    }

    var formattedStartTime = r[9]
      ? Utilities.formatDate(new Date(r[9]), "Asia/Tokyo", "HH:mm:ss")
      : "";
    var formattedCreateDate = r[10]
      ? Utilities.formatDate(new Date(r[10]), "Asia/Tokyo", "yyyy/MM/dd")
      : "";

    var payload = {
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
          文字起こしテキスト: transcribedText,
          フラグ: false,
          処理フラグ: false,
        },
      ],
    };

    Logger.log("--- 送信ペイロード（PII除く） ---");
    Logger.log("音声ファイル名: " + r[6]);
    Logger.log("職員在籍ID    : " + r[7]);
    Logger.log("オブジェクト名: " + r[8]);
    Logger.log("ケース記録種別: 音声記録");
    Logger.log("開始時間      : " + formattedStartTime);
    Logger.log("作成日        : " + formattedCreateDate);
    Logger.log(
      "文字起こしテキスト先頭100文字: " +
        transcribedText.substring(0, 100).replace(/[\r\n]/g, " "),
    );

    var url =
      "https://api.appsheet.com/api/v2/apps/" +
      appId +
      "/tables/" +
      tableName +
      "/Action";

    var startMs = new Date().getTime();
    var resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { ApplicationAccessKey: apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var durMs = new Date().getTime() - startMs;
    var code = resp.getResponseCode();
    var body = resp.getContentText();

    Logger.log("--- レスポンス ---");
    Logger.log("HTTP     : " + code);
    Logger.log("duration : " + durMs + " ms");
    Logger.log("body     : " + body); // 診断のため全文出力（PII含む可能性あり、テスト時のみ実行）

    if (code === 200) {
      Logger.log("✅ AppSheet 送信成功");
      sheet.getRange(rowNumber, 4).setValue("AppSheet反映済み");
      sheet.getRange(rowNumber, 14).setValue(0); // RetryCount リセット
      Logger.log(
        '   status を "AppSheet反映済み" に更新、N列を 0 にリセットしました',
      );
    } else {
      Logger.log("❌ AppSheet 送信失敗 HTTP " + code);
      Logger.log(
        "   status は据え置き（次回 processAppSheetSendWorker でも再試行対象）",
      );
      // body から detail フィールドを抽出してハイライト
      try {
        var json = JSON.parse(body);
        if (json && json.detail) {
          Logger.log("detail: " + json.detail);
        }
      } catch (_) {
        /* JSON でない場合はそのまま */
      }
    }
    return;
  }
  Logger.log("❌ LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * GAS UI から logId を引数なしで実行できるラッパ。
 * テスト対象の LogID をハードコードして使用する。
 */
function run_diagnose_sendOneRowToAppSheet() {
  // ★ テスト時に手動で書き換える
  var logId = "7ZMD7CHJ";
  diagnose_sendOneRowToAppSheet(logId);
}

// ============================================
// enrichCaseRecord_ 経路の診断
//
// 目的:
//   AppSheet Automation から呼ばれる enrichCaseRecord_ を、GAS UI 上で擬似再現する。
//   実際の Automation 動作確認の前に GAS 側のロジック（PII マスキング・Gemini 呼出・
//   コンテキスト取得・アンマスク）が正しく動くかを単独で検証できる。
// ============================================

/**
 * 利用者選択済みの 音声記録対応 行を一覧表示する（CloudSQL から取得）。
 * 結果として表示された Row ID を diagnose_simulateEnrichFromVoiceRow に渡す。
 */
function diagnose_listVoiceRecordsReady() {
  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement(
      'SELECT "Row ID", "音声ファイル名", "利用者在籍ID", ' +
        'COALESCE(length("文字起こしテキスト"), 0) AS text_len, ' +
        '"登録日時" ' +
        'FROM "音声記録対応" ' +
        'WHERE "利用者在籍ID" IS NOT NULL AND "利用者在籍ID" <> \'\' ' +
        'ORDER BY "登録日時" DESC NULLS LAST ' +
        "LIMIT 20",
    );
    var rs = stmt.executeQuery();
    Logger.log("===== 利用者選択済みの音声記録 (Top 20) =====");
    var n = 0;
    while (rs.next()) {
      n++;
      Logger.log(
        "  RowID=" +
          rs.getString(1) +
          " / file=" +
          rs.getString(2) +
          " / 利用者在籍ID(末尾4)=****" +
          (rs.getString(3) || "").slice(-4) +
          " / 文字数=" +
          rs.getInt(4) +
          " / 登録=" +
          rs.getString(5),
      );
    }
    rs.close();
    stmt.close();
    if (n === 0) {
      Logger.log(
        "  ※ 利用者選択済みの行なし。AppSheet 上で 音声記録対応 行に 利用者在籍ID を設定してください。",
      );
    } else {
      Logger.log(
        '使い方: diagnose_simulateEnrichFromVoiceRow("<RowID>", "<staffPrompt>")',
      );
    }
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * 指定 RowID の 音声記録対応 行から enrichCaseRecord_ を擬似実行する。
 *
 * 実行内容:
 *   1. CloudSQL "音声記録対応" から transcriptText, 利用者在籍ID を取得
 *   2. AppSheet API で 利用者在籍ID → CustomerName__c (利用者氏名) を逆引き
 *   3. enrichCaseRecord_ を呼出（PII マスキング含む完全フロー）
 *   4. 結果をログ出力（PII を含むため先頭 500 文字 + 統計情報）
 *
 * 副作用なし（読み取り + Gemini API 呼出のみ。ケース記録 への INSERT は AppSheet Automation 側の責務）。
 *
 * @param {string} rowId 音声記録対応 の Row ID（22 文字）
 * @param {string} [staffPromptText] スタッフ指示文。省略時は SOAP 要約
 */
function diagnose_simulateEnrichFromVoiceRow(rowId, staffPromptText) {
  if (!rowId) {
    Logger.log("❌ rowId が指定されていません");
    return;
  }
  staffPromptText =
    staffPromptText ||
    "面談記録を SOAP 形式（S:主観 / O:客観 / A:評価 / P:計画）で要約してください。";

  Logger.log("===== diagnose_simulateEnrichFromVoiceRow =====");
  Logger.log("rowId        : " + rowId);
  Logger.log("staffPrompt  : " + staffPromptText.substring(0, 80));

  // 1. CloudSQL から 音声記録対応 行を取得
  var transcriptText = "";
  var userZaisekiId = "";
  var conn = getCloudSqlConnection_();
  try {
    var stmt = conn.prepareStatement(
      'SELECT "文字起こしテキスト", "利用者在籍ID" ' +
        'FROM "音声記録対応" WHERE "Row ID" = ?',
    );
    stmt.setString(1, rowId);
    var rs = stmt.executeQuery();
    if (!rs.next()) {
      Logger.log(
        "❌ Row ID=" + rowId + ' が CloudSQL "音声記録対応" に見つかりません',
      );
      rs.close();
      stmt.close();
      return;
    }
    transcriptText = rs.getString(1) || "";
    userZaisekiId = rs.getString(2) || "";
    rs.close();
    stmt.close();
  } finally {
    closeCloudSql_(conn);
  }

  if (!userZaisekiId) {
    Logger.log(
      "❌ 利用者在籍ID が未設定。AppSheet で 利用者選択 してから再実行してください。",
    );
    return;
  }
  if (!transcriptText) {
    Logger.log(
      "❌ 文字起こしテキスト が空。Cleaning ステップを通っていない可能性。",
    );
    return;
  }
  Logger.log("文字起こし長 : " + transcriptText.length);
  Logger.log("利用者在籍ID(末尾4): ****" + userZaisekiId.slice(-4));

  // 2. 利用者在籍ID → 利用者氏名 を AppSheet API で逆引き
  var props = PropertiesService.getScriptProperties();
  var APP_ID = props.getProperty("APPSHEET_APP_ID");
  var API_KEY = props.getProperty("APPSHEET_API_KEY");
  if (!APP_ID || !API_KEY) {
    Logger.log("❌ APPSHEET_APP_ID または APPSHEET_API_KEY 未設定");
    return;
  }
  var userFullName = "";
  try {
    var userRows = callAppSheetApi(
      APP_ID,
      API_KEY,
      "CustomerStatus__c",
      "Filter(CustomerStatus__c, [Row ID] = '" + userZaisekiId + "')",
    );
    if (!userRows || userRows.length === 0) {
      Logger.log(
        "❌ CustomerStatus__c に 利用者在籍ID=" +
          userZaisekiId +
          " が見つかりません",
      );
      return;
    }
    userFullName = String(userRows[0]["CustomerName__c"] || "").trim();
    Logger.log(
      "利用者氏名（先頭2文字）: " +
        (userFullName || "").substring(0, 2) +
        "***",
    );
  } catch (e) {
    Logger.log("❌ 利用者情報取得失敗: " + e.message);
    return;
  }
  if (!userFullName) {
    Logger.log("❌ CustomerName__c が空。利用者マスタを確認してください。");
    return;
  }

  // 3. enrichCaseRecord_ を呼出（PII マスキング + Gemini + アンマスクの完全フロー）
  Logger.log("--- enrichCaseRecord_ 呼出 ---");
  var startMs = new Date().getTime();
  var result;
  try {
    result = enrichCaseRecord_({
      transcriptText: transcriptText,
      userFullName: userFullName,
      userZaisekiId: userZaisekiId,
      staffPromptText: staffPromptText,
      staffPromptKey: "diagnose_test",
      staffId: Session.getActiveUser().getEmail() || "unknown@diagnose",
    });
  } catch (e) {
    Logger.log("❌ enrichCaseRecord_ 例外: " + e.message);
    return;
  }
  var durMs = new Date().getTime() - startMs;

  // 4. 結果ログ
  Logger.log("--- 結果 ---");
  Logger.log("duration       : " + durMs + " ms");
  Logger.log("success        : " + result.success);
  Logger.log("version        : " + (result.version || ""));
  Logger.log("promptKey      : " + (result.promptKey || ""));
  Logger.log("contextLength  : " + (result.contextLength || 0));
  Logger.log("transcriptLength: " + (result.transcriptLength || 0));
  Logger.log("charCount      : " + (result.charCount || 0));

  if (result.success) {
    Logger.log("✅ enrichCaseRecord_ 成功");
    Logger.log("text 先頭 500 文字:");
    Logger.log((result.text || "").substring(0, 500));
    Logger.log("...");
    Logger.log("text 末尾 200 文字:");
    Logger.log((result.text || "").slice(-200));
  } else {
    Logger.log("❌ enrichCaseRecord_ 失敗");
    Logger.log("error: " + result.error);
    Logger.log("code : " + result.code);
  }
}

/**
 * GAS UI から引数なしで実行できるラッパ。
 * テスト対象の RowID と staffPrompt をハードコードして使用する。
 *
 * 使い方:
 *   1. diagnose_listVoiceRecordsReady() で対象 RowID を確認
 *   2. 下記の rowId を書換
 *   3. run_diagnose_simulateEnrichFromVoiceRow を選択 → 実行
 */
function run_diagnose_simulateEnrichFromVoiceRow() {
  // ★ テスト時に手動で書き換える（diagnose_listVoiceRecordsReady の出力から選ぶ）
  var rowId = "PUT_VOICE_RECORD_ROW_ID_HERE";
  var staffPrompt =
    "面談記録を SOAP 形式（S:主観 / O:客観 / A:評価 / P:計画）で要約してください。";
  diagnose_simulateEnrichFromVoiceRow(rowId, staffPrompt);
}

// =====================================================================
// POST履歴 幽霊行（audioFileUrl 空）の検出・クリーンアップ・テスト
// =====================================================================
//
// 経緯:
//   2026-04-30 に POST履歴 シートで F〜M 列がすべて空のまま 'Drive URLからFileID抽出失敗'
//   エラーで滞留する行が複数発生（BB7RZQTL / Z8091UFO / I50TPLDM）。
//   呼出元 AppSheet 側で全引数空のまま HopeRecorderStartTranscription が叩かれていた。
//   101_HopeRecorder.js の入力ガードで以後の発生を防止し、本診断関数群で既存幽霊行を
//   特定・クリーンアップするとともに、ガード自体の動作テストを行う。
// =====================================================================

/**
 * POST履歴 シートで audioFileUrl (F列) が空の幽霊行を一覧表示する。
 * 行の削除や status 変更は行わない（読取専用）。
 *
 * 使い方: GAS UI で diagnose_listGhostRowsInPostHistory を選択して実行。
 */
function diagnose_listGhostRowsInPostHistory() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  Logger.log("===== POST履歴 幽霊行検出 =====");
  Logger.log("総行数: " + (values.length - 1) + "（ヘッダ除く）");

  var ghosts = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var logId = row[0];
    var status = row[3];
    var audioUrl = row[5];
    if (!audioUrl || !String(audioUrl).trim()) {
      ghosts.push({
        rowNumber: i + 1,
        logId: logId,
        timestamp: row[1],
        status: status,
        log: row[4],
      });
    }
  }

  Logger.log("幽霊行（F列空）: " + ghosts.length + " 件");
  for (var j = 0; j < ghosts.length; j++) {
    var g = ghosts[j];
    Logger.log(
      "  行" +
        g.rowNumber +
        ": LogID=" +
        g.logId +
        " status=" +
        g.status +
        " ts=" +
        g.timestamp +
        " log=" +
        g.log,
    );
  }
  if (ghosts.length === 0) {
    Logger.log("幽霊行なし");
  } else {
    Logger.log(
      "クリーンアップは diagnose_markGhostRowsAsFailed を実行（status=FAILED に固定し processTranscriptionWorker のループから外す）",
    );
  }
}

/**
 * POST履歴 シートで audioFileUrl (F列) が空の幽霊行の status を 'FAILED' に固定する。
 * processTranscriptionWorker は status='受付' の行のみ処理対象にするため、これで処理ループから外れる。
 * 行の物理削除はしない（監査証跡として残す）。
 *
 * 使い方: GAS UI で diagnose_markGhostRowsAsFailed を選択して実行。
 *         事前に diagnose_listGhostRowsInPostHistory で対象を確認してから実行することを推奨。
 */
function diagnose_markGhostRowsAsFailed() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  Logger.log("===== POST履歴 幽霊行クリーンアップ =====");

  var modified = 0;
  var skipped = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rowNumber = i + 1;
    var logId = row[0];
    var currentStatus = row[3];
    var audioUrl = row[5];

    if (audioUrl && String(audioUrl).trim()) continue; // F列に値あり = 正常行
    if (currentStatus === "FAILED") {
      skipped++;
      continue;
    } // 既に FAILED

    sheet.getRange(rowNumber, 4).setValue("FAILED");
    var prevLog = String(row[4] || "");
    sheet
      .getRange(rowNumber, 5)
      .setValue(
        "幽霊行（audioFileUrl 空）として確定エラー化 / 旧log=" +
          prevLog.substring(0, 100),
      );
    modified++;
    Logger.log("  行" + rowNumber + " LogID=" + logId + " を FAILED に変更");
  }

  Logger.log(
    "FAILED 化: " +
      modified +
      " 件 / 既に FAILED でスキップ: " +
      skipped +
      " 件",
  );
}

/**
 * 入力ガード動作確認: HopeRecorderStartTranscription を全引数空で呼出し、行が作られないこと、
 * 戻り値が受付エラー文字列であることを確認する。
 *
 * 副作用: Slack 通知が 1 件飛ぶ（[HopeRecorder] 受付拒否: ...）。事前に運用者に通知済みで実行すること。
 *
 * 使い方: GAS UI で test_HopeRecorderStartTranscription_emptyArgs を選択して実行。
 */
function test_HopeRecorderStartTranscription_emptyArgs() {
  Logger.log(
    "===== test: 全引数空で HopeRecorderStartTranscription 呼出 =====",
  );
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var beforeRowCount = sheet.getLastRow();
  Logger.log("呼出前 lastRow: " + beforeRowCount);

  var result = HopeRecorderStartTranscription("", "", "", "", "", "");
  Logger.log("戻り値: " + result);

  var afterRowCount = sheet.getLastRow();
  Logger.log("呼出後 lastRow: " + afterRowCount);

  if (afterRowCount === beforeRowCount && /受付エラー/.test(String(result))) {
    Logger.log("OK: 行追加なし、受付エラー戻り値を確認");
  } else if (afterRowCount > beforeRowCount) {
    Logger.log("NG: 行が追加されている（ガード未動作）");
  } else {
    Logger.log("NG: 戻り値が想定外: " + result);
  }
}

/**
 * 入力ガード動作確認: 一部引数のみ空（audioFileUrl だけ空）で呼出し、行が作られないことを確認する。
 *
 * 使い方: GAS UI で test_HopeRecorderStartTranscription_audioUrlEmpty を選択して実行。
 */
function test_HopeRecorderStartTranscription_audioUrlEmpty() {
  Logger.log("===== test: audioFileUrl だけ空で呼出 =====");
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var beforeRowCount = sheet.getLastRow();

  var result = HopeRecorderStartTranscription(
    "", // audioFileUrl 空
    "test_audio.m4a",
    "a0FRB00000XXXXXXXX",
    "RecordingData__c",
    "12:34",
    "2026-04-30",
  );
  Logger.log("戻り値: " + result);
  Logger.log(
    "呼出後 lastRow: " + sheet.getLastRow() + " (前: " + beforeRowCount + ")",
  );

  if (
    sheet.getLastRow() === beforeRowCount &&
    /受付エラー/.test(String(result))
  ) {
    Logger.log("OK: 行追加なし、受付エラー戻り値を確認");
  } else {
    Logger.log("NG: ガード未動作、または戻り値が想定外");
  }
}

/**
 * 正常系動作確認: ダミー Drive URL（実在不要）で呼出し、行が追加され受付完了戻り値が返ることを確認する。
 * 受付された行は status='受付' になるが、processTranscriptionWorker が動くと FileID 抽出後に
 * 「DriveApp.getFileById でファイル不在」で別エラーになる可能性がある。
 *
 * テスト後はクリーンアップを忘れずに（行の status を FAILED にするか手動削除）。
 *
 * 使い方:
 *   1. ダミー URL を valid なフォーマットに保つ（FileID 部分は 25 文字以上の英数記号 _ -）
 *   2. GAS UI で test_HopeRecorderStartTranscription_validShape を選択して実行
 *   3. 出てきた LogID を控え、不要なら手動でシートから削除 or status=FAILED に
 */
function test_HopeRecorderStartTranscription_validShape() {
  Logger.log("===== test: 形式正常な引数で呼出 =====");
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var beforeRowCount = sheet.getLastRow();

  // ダミー Drive URL（FileID 部分は 28 文字のダミー、正規表現は通るが Drive 上には存在しない）
  var dummyDriveUrl =
    "https://drive.google.com/file/d/1234567890ABCDEFGHIJKLMNOPQR/view?usp=sharing";

  var result = HopeRecorderStartTranscription(
    dummyDriveUrl,
    "test_dummy.m4a",
    "a0FRB00000DUMMY_USER",
    "RecordingData__c",
    "00:00",
    "2026-04-30",
  );
  Logger.log("戻り値: " + result);
  Logger.log(
    "呼出後 lastRow: " + sheet.getLastRow() + " (前: " + beforeRowCount + ")",
  );

  if (
    sheet.getLastRow() === beforeRowCount + 1 &&
    /受付完了/.test(String(result))
  ) {
    Logger.log("OK: 行が 1 つ追加された、受付完了戻り値を確認");
    Logger.log(
      "★ クリーンアップ推奨: 上記 LogID の行を手動で status=FAILED に変更するか物理削除してください",
    );
  } else {
    Logger.log("NG: 行追加されない、または戻り値が想定外");
  }
}

// =====================================================================
// 滞留行（status='実行中(2/3)'）の手動消化用診断関数
// =====================================================================
//
// 経緯:
//   2026-04-30 に checkJobStatus が cleaning 内で hang し GAS 5 分制限で
//   'Execution cancelled' になり、status='実行中(2/3)' のまま 6 件滞留する事象が発生。
//   Vertex AI Batch ジョブ自体は完了済みで、Cleaning 段で詰まっていた。
//   101_HopeRecorder.js の callGeminiProToCleanText_ に time budget 90 秒 + flash フォールバックを
//   導入したが、既存の滞留行を 1 件ずつ手動で消化するためのユーティリティを提供する。
//
// 使い方:
//   1. diagnose_listStuckRows_inProgress() で滞留行 LogID を確認
//   2. run_diagnose_processOneStuckRow の logId をハードコード書換 → 実行
//   3. 1 行成功すれば status='推論完了(3/3)' になり、processAppSheetSendWorker が
//      次回 trigger で AppSheet へ送信する
//   4. 残り滞留行がある場合は 2 を繰り返す（または cron の checkJobStatus が 1 回ずつ消化）
// =====================================================================

/**
 * status='実行中(2/3)' で滞留している行を一覧表示する。
 * Vertex Batch ジョブ自体は完了済みでも cleaning 段で詰まっているケースを可視化する。
 *
 * 副作用なし（読み取りのみ）。
 *
 * 使い方: GAS UI で diagnose_listStuckRows_inProgress を選択 → 実行 → ログ確認
 */
function diagnose_listStuckRows_inProgress() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var nowMs = Date.now();
  var stuck = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var status = String(row[3] || "");
    if (status !== "実行中(2/3)") continue;

    var createdAt = row[1];
    var elapsedMin = null;
    if (createdAt) {
      try {
        var t =
          createdAt instanceof Date
            ? createdAt.getTime()
            : new Date(createdAt).getTime();
        if (!isNaN(t)) elapsedMin = Math.round((nowMs - t) / 60000);
      } catch (_) {
        /* ignore */
      }
    }

    stuck.push({
      rowNumber: i + 1,
      logId: row[0],
      jobName: row[2] || "(未投入)",
      msgSnippet: String(row[4] || "")
        .substring(0, 120)
        .replace(/[\r\n]/g, " "),
      retryCount: Number(row[13]) || 0,
      elapsedMin: elapsedMin,
    });
  }

  Logger.log("===== 滞留行（status=実行中(2/3)）一覧 =====");
  Logger.log("総数: " + stuck.length + " 件");
  for (var j = 0; j < stuck.length; j++) {
    var s = stuck[j];
    Logger.log(
      "  Row=" +
        s.rowNumber +
        " / LogID=" +
        s.logId +
        " / 経過=" +
        (s.elapsedMin === null ? "不明" : s.elapsedMin + "分") +
        " / retry=" +
        s.retryCount +
        " / job=" +
        (s.jobName.length > 60 ? "..." + s.jobName.slice(-60) : s.jobName) +
        " / msg=" +
        s.msgSnippet,
    );
  }
  if (stuck.length > 0) {
    Logger.log("");
    Logger.log(
      "対応: run_diagnose_processOneStuckRow の logId を上記から選んで書換 → 実行で 1 行ずつ消化",
    );
    Logger.log('または diagnose_processOneStuckRow("LOGID") を直接呼出');
  }
}

/**
 * 指定 LogID の滞留行 1 件のみを checkJobStatus 相当の処理で消化する。
 *
 * 動作:
 *   1. 行の status をチェック（'実行中(2/3)' 以外なら警告して何もしない）
 *   2. Vertex Batch ジョブ状態を取得（JOB_STATE_SUCCEEDED 以外なら警告）
 *   3. GCS から predictions.jsonl を取得し rawDraftText を構築
 *   4. callGeminiProToCleanText_ を呼出（time budget 90 秒の hard cap が効く）
 *   5. 成功時: status='推論完了(3/3)' に更新、M列に finalCleanedText を書込
 *   6. 失敗時: status='エラー(3/3)' に更新、E列にエラー詳細
 *
 * 副作用:
 *   - 成功時 POST履歴 シートの当該行の status / M列 が更新される
 *   - Gemini API への課金が発生する（cleaning 1 回分）
 *
 * @param {string} logId 例: "VACH1215"
 */
function diagnose_processOneStuckRow(logId) {
  if (!logId) {
    Logger.log("❌ logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var token = getOAuthServiceAccountToken_();
  var LOCATION = "us-central1";

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var r = values[i];
    var rowNumber = i + 1;
    var status = String(r[3] || "");
    var jobName = r[2];

    Logger.log(
      "===== diagnose_processOneStuckRow LogID=" +
        logId +
        " Row=" +
        rowNumber +
        " =====",
    );
    Logger.log("現在の status: " + status);

    if (status !== "実行中(2/3)") {
      Logger.log('⚠️ status が "実行中(2/3)" ではないためスキップ。');
      Logger.log(
        "   既に処理が進行している、もしくは別状態（受付/推論完了/エラー等）です。",
      );
      return;
    }
    if (!jobName) {
      Logger.log("❌ jobName (C列) が空。Batch 投入前の状態の可能性。");
      return;
    }
    Logger.log(
      "jobName: " +
        (jobName.length > 80 ? "..." + jobName.slice(-80) : jobName),
    );

    try {
      // 1. Vertex Batch ジョブ状態取得
      var jobResp = UrlFetchApp.fetch(
        "https://" + LOCATION + "-aiplatform.googleapis.com/v1/" + jobName,
        {
          headers: { Authorization: "Bearer " + token },
          muteHttpExceptions: true,
        },
      );
      if (jobResp.getResponseCode() !== 200) {
        Logger.log("❌ ジョブ状態取得失敗 HTTP " + jobResp.getResponseCode());
        return;
      }
      var job = JSON.parse(jobResp.getContentText());
      Logger.log("Vertex job state: " + job.state);

      if (
        job.state === "JOB_STATE_FAILED" ||
        job.state === "JOB_STATE_CANCELLED"
      ) {
        var errMsg = (job.error && job.error.message) || "ジョブ失敗";
        sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
        sheet.getRange(rowNumber, 5).setValue(errMsg.substring(0, 500));
        Logger.log(
          "❌ Vertex Batch ジョブが失敗状態。status を エラー(3/3) に更新: " +
            errMsg,
        );
        return;
      }
      if (job.state !== "JOB_STATE_SUCCEEDED") {
        Logger.log(
          "⚠️ ジョブ未完了 (" +
            job.state +
            ")。完了を待ってから再実行してください。",
        );
        return;
      }

      // 2. predictions.jsonl 取得
      var listResp = UrlFetchApp.fetch(
        "https://storage.googleapis.com/storage/v1/b/" +
          GCS_BUCKET_NAME +
          "/o?prefix=outputs/" +
          logId +
          "/",
        { headers: { Authorization: "Bearer " + token } },
      );
      var list = JSON.parse(listResp.getContentText());
      var rawDraftText = "";
      (list.items || [])
        .filter(function (obj) {
          return obj.name.endsWith("predictions.jsonl");
        })
        .forEach(function (obj) {
          var url =
            "https://storage.googleapis.com/storage/v1/b/" +
            GCS_BUCKET_NAME +
            "/o/" +
            encodeURIComponent(obj.name) +
            "?alt=media";
          var content = UrlFetchApp.fetch(url, {
            headers: { Authorization: "Bearer " + token },
          }).getContentText();
          content
            .trim()
            .split(/\r?\n/)
            .forEach(function (line) {
              try {
                var t =
                  JSON.parse(line)?.response?.candidates?.[0]?.content
                    ?.parts?.[0]?.text;
                if (t) rawDraftText += t + "\n";
              } catch (_) {
                /* ignore */
              }
            });
        });

      Logger.log("rawDraftText 長: " + rawDraftText.length + " 文字");
      if (!rawDraftText.trim()) {
        sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
        sheet.getRange(rowNumber, 5).setValue("Batch成功だが出力テキストが空");
        Logger.log(
          "❌ predictions.jsonl から有効なテキストが取得できませんでした",
        );
        return;
      }

      // 3. cleaning 実行（time budget 90 秒の hard cap 付き）
      Logger.log("--- callGeminiProToCleanText_ 呼出 ---");
      var cleaningStartMs = Date.now();
      var finalCleanedText;
      try {
        finalCleanedText = callGeminiProToCleanText_(rawDraftText.trim());
      } catch (e) {
        var durMs = Date.now() - cleaningStartMs;
        sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
        sheet
          .getRange(rowNumber, 5)
          .setValue(String(e.message || "").substring(0, 500));
        Logger.log("❌ cleaning 失敗 (" + durMs + " ms): " + e.message);
        return;
      }
      var durMs2 = Date.now() - cleaningStartMs;
      Logger.log(
        "✅ cleaning 成功 (" +
          durMs2 +
          " ms, " +
          finalCleanedText.length +
          " 文字)",
      );
      // フォールバックマーカーが先頭に付いているかを表示（PII を含む可能性があるため先頭 80 文字のみ）
      Logger.log(
        "応答先頭: " +
          finalCleanedText.substring(0, 80).replace(/[\r\n]/g, " "),
      );

      // 4. シート反映
      sheet.getRange(rowNumber, 13).setValue(finalCleanedText);
      sheet.getRange(rowNumber, 4).setValue("推論完了(3/3)");
      sheet.getRange(rowNumber, 5).setValue("");
      Logger.log(
        "✅ status を 推論完了(3/3) に更新、M列に finalCleanedText を書込しました",
      );
      Logger.log(
        "   次回 processAppSheetSendWorker トリガーで AppSheet に送信されます",
      );
    } catch (e) {
      sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
      sheet
        .getRange(rowNumber, 5)
        .setValue(String(e.message || "").substring(0, 500));
      Logger.log("❌ 想定外エラー: " + e.message);
    }
    return;
  }
  Logger.log("❌ LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * GAS UI から logId を引数なしで実行できるラッパ。
 * 滞留行の LogID をハードコードして使用する。
 *
 * 使い方:
 *   1. diagnose_listStuckRows_inProgress() で滞留行 LogID を一覧
 *   2. 下記の logId を 1 件選んで書換
 *   3. run_diagnose_processOneStuckRow を選択 → 実行
 *   4. 残り滞留行があれば 2 を繰り返す
 */
function run_diagnose_processOneStuckRow() {
  // ★ 滞留行の LogID をここに書換（diagnose_listStuckRows_inProgress の出力から選ぶ）
  var logId = "YA8STVA9";
  diagnose_processOneStuckRow(logId);
}

// =====================================================================
// 緊急対応: gemini-2.5-pro が hang する場合のバイパス
//
// 経緯:
//   2026-05-01 に YA8STVA9 等の cleaning で gemini-2.5-pro の UrlFetch が 6 分以上応答せず
//   hang する事象が発生。time budget は API レスポンス受信後にしか効かないため、
//   pro 自体を試行しない or cleaning 自体をスキップする緊急回避ルートを用意する。
// =====================================================================

/**
 * 滞留行を pro スキップ + flash のみ で cleaning する緊急バイパス。
 * pro が hang する状況を回避し、flash で短時間に決着させる。
 *
 * 動作:
 *   1. 行検証（status='実行中(2/3)' のみ）
 *   2. Vertex Batch 状態取得（JOB_STATE_SUCCEEDED 確認）
 *   3. predictions.jsonl から rawDraftText 構築
 *   4. PII マスキング
 *   5. **flash 直接呼出**（pro 試行なし、maxAttempts=2）
 *   6. 成功時: 応答先頭に [緊急バイパス: pro スキップ / flash 使用] 付与、status='推論完了(3/3)'
 *   7. 失敗時: status='エラー(3/3)'
 *
 * @param {string} logId
 */
function diagnose_processOneStuckRow_flashOnly(logId) {
  if (!logId) {
    Logger.log("logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var token = getOAuthServiceAccountToken_();
  var LOCATION = "us-central1";

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var rowNumber = i + 1;
    var r = values[i];

    Logger.log(
      "===== diagnose_processOneStuckRow_flashOnly LogID=" +
        logId +
        " Row=" +
        rowNumber +
        " =====",
    );
    if (r[3] !== "実行中(2/3)") {
      Logger.log(
        "現在の status=" + r[3] + "（実行中(2/3) 以外なので何もしない）",
      );
      return;
    }

    var jobName = r[2];
    Logger.log("jobName: ..." + String(jobName).substring(jobName.length - 80));

    try {
      var jobResp = UrlFetchApp.fetch(
        "https://" + LOCATION + "-aiplatform.googleapis.com/v1/" + jobName,
        {
          headers: { Authorization: "Bearer " + token },
          muteHttpExceptions: true,
        },
      );
      if (jobResp.getResponseCode() !== 200) {
        Logger.log("Vertex job 取得失敗 HTTP " + jobResp.getResponseCode());
        return;
      }
      var job = JSON.parse(jobResp.getContentText());
      Logger.log("Vertex job state: " + job.state);
      if (job.state !== "JOB_STATE_SUCCEEDED") {
        Logger.log("JOB_STATE_SUCCEEDED 以外なので処理を中止");
        return;
      }

      // GCS から predictions.jsonl 取得
      var listResp = UrlFetchApp.fetch(
        "https://storage.googleapis.com/storage/v1/b/" +
          GCS_BUCKET_NAME +
          "/o?prefix=outputs/" +
          logId +
          "/",
        { headers: { Authorization: "Bearer " + token } },
      );
      var list = JSON.parse(listResp.getContentText());
      var rawDraftText = "";
      (list.items || [])
        .filter(function (o) {
          return o.name.endsWith("predictions.jsonl");
        })
        .forEach(function (o) {
          var u =
            "https://storage.googleapis.com/storage/v1/b/" +
            GCS_BUCKET_NAME +
            "/o/" +
            encodeURIComponent(o.name) +
            "?alt=media";
          var c = UrlFetchApp.fetch(u, {
            headers: { Authorization: "Bearer " + token },
          }).getContentText();
          c.trim()
            .split(/\r?\n/)
            .forEach(function (line) {
              try {
                var t =
                  JSON.parse(line) &&
                  JSON.parse(line).response &&
                  JSON.parse(line).response.candidates &&
                  JSON.parse(line).response.candidates[0] &&
                  JSON.parse(line).response.candidates[0].content &&
                  JSON.parse(line).response.candidates[0].content.parts &&
                  JSON.parse(line).response.candidates[0].content.parts[0] &&
                  JSON.parse(line).response.candidates[0].content.parts[0].text;
                if (t) rawDraftText += t + "\n";
              } catch (_) {}
            });
        });
      Logger.log("rawDraftText 長: " + rawDraftText.length + " 文字");
      if (!rawDraftText.trim()) {
        Logger.log("rawDraftText 空のため中止");
        return;
      }

      // PII マスキング
      var registry = null;
      try {
        var staffList =
          typeof getStaffListCachedForCleaning_ === "function"
            ? getStaffListCachedForCleaning_()
            : [];
        registry = buildPiiRegistry_({ staffList: staffList });
        Logger.log("piiMasking entityCount=" + registry.count);
      } catch (e) {
        Logger.log("piiMasking 失敗、原文で続行: " + e.message);
      }
      var maskedRaw = registry
        ? maskText_(rawDraftText, registry)
        : rawDraftText;

      // flash 直接呼出（pro スキップ）
      Logger.log("--- flash 直接呼出（pro スキップ） ---");
      var flashStart = Date.now();
      var flashPrompt = HOPE_RECORDER_ACTIVE.cleaning.promptSystem + maskedRaw;
      var flashPayload = {
        contents: [{ role: "user", parts: [{ text: flashPrompt }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
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
          temperature: HOPE_RECORDER_ACTIVE.cleaning.temperature,
        },
      };

      var parsed;
      try {
        parsed = callGeminiWithKeyRotation_("gemini-2.5-flash", flashPayload, {
          apiVersion: "v1beta",
          maxAttempts: 2,
        });
      } catch (e) {
        Logger.log("flash も失敗: " + e.message);
        sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
        sheet
          .getRange(rowNumber, 5)
          .setValue("flash 直行も失敗: " + String(e.message).substring(0, 200));
        return;
      }

      var maskedResultText =
        parsed &&
        parsed.candidates &&
        parsed.candidates[0] &&
        parsed.candidates[0].content &&
        parsed.candidates[0].content.parts &&
        parsed.candidates[0].content.parts[0] &&
        parsed.candidates[0].content.parts[0].text;
      if (!maskedResultText) {
        Logger.log("flash 応答が空");
        sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
        sheet.getRange(rowNumber, 5).setValue("flash 応答空");
        return;
      }

      var finalText = registry
        ? unmaskText_(maskedResultText, registry)
        : maskedResultText;
      var withPrefix =
        "[緊急バイパス: pro スキップ / flash 使用]\n\n" + finalText;
      Logger.log(
        "flash 成功 elapsedMs=" +
          (Date.now() - flashStart) +
          " outputLen=" +
          withPrefix.length,
      );

      sheet.getRange(rowNumber, 13).setValue(withPrefix);
      sheet.getRange(rowNumber, 4).setValue("推論完了(3/3)");
      sheet.getRange(rowNumber, 5).setValue("");
      Logger.log("OK 推論完了(3/3) に更新");
      return;
    } catch (e) {
      Logger.log("処理失敗: " + e.message);
      sheet.getRange(rowNumber, 4).setValue("エラー(3/3)");
      sheet
        .getRange(rowNumber, 5)
        .setValue("flashOnly 処理失敗: " + String(e.message).substring(0, 200));
      return;
    }
  }
  Logger.log("LogID=" + logId + " が POST履歴 シートに見つかりません");
}

/**
 * cleaning を完全スキップして rawDraftText のまま 推論完了(3/3) にする緊急バイパス。
 * pro も flash も hang する場合の最終手段。整形の品質は落ちるが、業務は前進する。
 *
 * 動作:
 *   1. 行検証
 *   2. Vertex Batch 状態取得
 *   3. predictions.jsonl から rawDraftText 構築
 *   4. **cleaning 呼出なし**で M列に rawDraftText 先頭にマーカー付与してそのまま書込
 *   5. status='推論完了(3/3)' に更新
 *
 * @param {string} logId
 */
function diagnose_skipCleaningForStuckRow(logId) {
  if (!logId) {
    Logger.log("logId が指定されていません");
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var token = getOAuthServiceAccountToken_();
  var LOCATION = "us-central1";

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== logId) continue;
    var rowNumber = i + 1;
    var r = values[i];

    Logger.log(
      "===== diagnose_skipCleaningForStuckRow LogID=" +
        logId +
        " Row=" +
        rowNumber +
        " =====",
    );
    if (r[3] !== "実行中(2/3)") {
      Logger.log(
        "現在の status=" + r[3] + "（実行中(2/3) 以外なので何もしない）",
      );
      return;
    }

    var jobName = r[2];
    try {
      var jobResp = UrlFetchApp.fetch(
        "https://" + LOCATION + "-aiplatform.googleapis.com/v1/" + jobName,
        {
          headers: { Authorization: "Bearer " + token },
          muteHttpExceptions: true,
        },
      );
      if (jobResp.getResponseCode() !== 200) {
        Logger.log("Vertex job 取得失敗");
        return;
      }
      var job = JSON.parse(jobResp.getContentText());
      if (job.state !== "JOB_STATE_SUCCEEDED") {
        Logger.log("JOB_STATE_SUCCEEDED 以外: " + job.state);
        return;
      }

      var listResp = UrlFetchApp.fetch(
        "https://storage.googleapis.com/storage/v1/b/" +
          GCS_BUCKET_NAME +
          "/o?prefix=outputs/" +
          logId +
          "/",
        { headers: { Authorization: "Bearer " + token } },
      );
      var list = JSON.parse(listResp.getContentText());
      var rawDraftText = "";
      (list.items || [])
        .filter(function (o) {
          return o.name.endsWith("predictions.jsonl");
        })
        .forEach(function (o) {
          var u =
            "https://storage.googleapis.com/storage/v1/b/" +
            GCS_BUCKET_NAME +
            "/o/" +
            encodeURIComponent(o.name) +
            "?alt=media";
          var c = UrlFetchApp.fetch(u, {
            headers: { Authorization: "Bearer " + token },
          }).getContentText();
          c.trim()
            .split(/\r?\n/)
            .forEach(function (line) {
              try {
                var p = JSON.parse(line);
                var t =
                  p &&
                  p.response &&
                  p.response.candidates &&
                  p.response.candidates[0] &&
                  p.response.candidates[0].content &&
                  p.response.candidates[0].content.parts &&
                  p.response.candidates[0].content.parts[0] &&
                  p.response.candidates[0].content.parts[0].text;
                if (t) rawDraftText += t + "\n";
              } catch (_) {}
            });
        });
      Logger.log("rawDraftText 長: " + rawDraftText.length + " 文字");
      if (!rawDraftText.trim()) {
        Logger.log("rawDraftText 空のため中止");
        return;
      }

      var withPrefix =
        "[緊急バイパス: cleaning スキップ / Vertex Batch 出力をそのまま使用]\n\n" +
        rawDraftText.trim();
      sheet.getRange(rowNumber, 13).setValue(withPrefix);
      sheet.getRange(rowNumber, 4).setValue("推論完了(3/3)");
      sheet.getRange(rowNumber, 5).setValue("");
      Logger.log("OK 推論完了(3/3) に更新（cleaning スキップ）");
      return;
    } catch (e) {
      Logger.log("処理失敗: " + e.message);
      return;
    }
  }
  Logger.log("LogID=" + logId + " が見つかりません");
}

/**
 * GAS UI から引数なしで flash 直行版を実行するラッパ。
 */
function run_diagnose_processOneStuckRow_flashOnly() {
  // ★ 滞留行の LogID をここに書換
  var logId = "YA8STVA9";
  diagnose_processOneStuckRow_flashOnly(logId);
}

/**
 * GAS UI から引数なしで cleaning スキップ版を実行するラッパ。
 */
function run_diagnose_skipCleaningForStuckRow() {
  // ★ 滞留行の LogID をここに書換
  var logId = "YA8STVA9";
  diagnose_skipCleaningForStuckRow(logId);
}

/**
 * 全滞留行（status='実行中(2/3)'）を一括で cleaning スキップ処理する。
 *
 * 動作:
 *   - status='実行中(2/3)' の全行をスキャン
 *   - 各行について diagnose_skipCleaningForStuckRow と同じ処理
 *   - 1 行あたり数秒で済むため、6 分制限内で 50 件以上処理可能
 *   - 失敗行はスキップして次へ進む（途中で止まらない）
 *
 * 想定用途:
 *   gemini-2.5-pro / flash の双方が hang する状況で、業務を即時前進させる最終手段。
 *   M 列には Vertex Batch の生出力が「[緊急バイパス: cleaning スキップ ...]」付きで入る。
 *   後で品質改善したい行は手動で diagnose_processOneStuckRow_flashOnly を試すなど追加対応可。
 */
function diagnose_skipCleaningForAllStuckRows() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var targets = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][3] === "実行中(2/3)") {
      targets.push(values[i][0]);
    }
  }
  Logger.log(
    "===== 一括 cleaning スキップ 対象: " + targets.length + " 件 =====",
  );
  if (targets.length === 0) {
    Logger.log("滞留行なし");
    return;
  }
  var success = 0;
  var fail = 0;
  for (var j = 0; j < targets.length; j++) {
    var logId = targets[j];
    Logger.log(
      "--- (" + (j + 1) + "/" + targets.length + ") LogID=" + logId + " ---",
    );
    try {
      diagnose_skipCleaningForStuckRow(logId);
      success++;
    } catch (e) {
      Logger.log("スキップ: " + e.message);
      fail++;
    }
  }
  Logger.log("===== 完了 success=" + success + " fail=" + fail + " =====");
}
