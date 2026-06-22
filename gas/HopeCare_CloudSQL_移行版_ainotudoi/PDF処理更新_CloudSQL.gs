/**
 * AI帳票処理 メイン関数 + ヘルパー CloudSQL版
 *
 * 元: GeminiAPI_Appsheet_AI帳票処理_とよさと様/PDF処理更新.js
 * 変更点:
 * - MASTER_SS_ID をスクリプトプロパティから取得
 * - updateAppSheetRecord_ver2 → updateAiResult_CloudSQL に置換済み（呼出元で処理）
 * - GLOBAL_SETTINGS / JOB_* 定数は不要（CloudSQLキューに移行済み）
 * - [NEW] 日付・数値型のデータクレンジング処理追加
 * - [NEW] ファイルが存在しない場合、エラー停止せずスキップ結果を返すよう変更
 *
 * 必要なスクリプトプロパティ:
 * API_KEY       : Gemini APIキー（メイン）
 * API_KEY_2     : Gemini APIキー（フォールバック、任意）
 * MASTER_SS_ID  : ひな型帳票マスタ子レコード選択肢のスプレッドシートID
 *
 * 依存: 000_CloudSQL接続.js, Slack通知.js
 */

// ==================================================================================
// 補助関数: Drive API呼び出しリトライラッパー
// ==================================================================================
function callWithRetry_CloudSQL_(func, maxRetries) {
  maxRetries = maxRetries || 3;
  for (var i = 0; i < maxRetries; i++) {
    try {
      return func();
    } catch (e) {
      var isRetryable =
        e.message.indexOf("Service error") > -1 ||
        e.message.indexOf("Rate limit") > -1 ||
        e.message.indexOf("Internal Error") > -1 ||
        e.message.indexOf("Exceeded memory") > -1;
      if (isRetryable && i < maxRetries - 1) {
        Logger.log(
          "Drive API一時エラー (回数: " +
            (i + 1) +
            "/" +
            maxRetries +
            "): " +
            e.message,
        );
        Utilities.sleep(3000 + i * 1000);
        continue;
      }
      throw e;
    }
  }
}

// ==================================================================================
// 補助関数: Gemini File APIアップロード
// ==================================================================================
function uploadFileToGemini_CloudSQL_(fileBlob, apiKey) {
  return callWithRetry_CloudSQL_(function () {
    var uploadUrl =
      "https://generativelanguage.googleapis.com/upload/v1beta/files?key=" +
      apiKey;
    var options = {
      method: "post",
      contentType: fileBlob.getContentType(),
      payload: fileBlob,
      headers: { "x-goog-upload-protocol": "raw" },
      muteHttpExceptions: true,
    };

    var response = UrlFetchApp.fetch(uploadUrl, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode !== 200) {
      if (responseCode >= 500) throw new Error("Server Error: " + responseCode);
      throw new Error(
        "Geminiへのファイルアップロード失敗: " +
          responseCode +
          " - " +
          responseText,
      );
    }

    var uploadedFile = JSON.parse(responseText).file;
    return {
      fileData: {
        mimeType: uploadedFile.mimeType,
        fileUri: uploadedFile.uri,
      },
    };
  });
}

// ==================================================================================
// 補助関数: AIレスポンスからJSON抽出
// ==================================================================================
function extractJsonFromAIResponse_CloudSQL_(aiResponseText) {
  var codeBlockMatch = aiResponseText.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  var first = aiResponseText.indexOf("{");
  var last = aiResponseText.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return aiResponseText.slice(first, last + 1);
  }
  return null;
}

// ==================================================================================
// 補助関数: 日付文字列を CloudSQL 用 (YYYY-MM-DD) にフォーマット
// ==================================================================================
function formatToSqlDate_CloudSQL_(dateVal) {
  if (!dateVal || dateVal === "該当なし") return "";
  var s = String(dateVal).trim();

  // すでに YYYY-MM-DD や YYYY/MM/DD の場合
  var standardMatch = s.match(
    /^(\d{4})[-/年]\s*(\d{1,2})[-/月]\s*(\d{1,2})[日]?$/,
  );
  if (standardMatch) {
    return (
      standardMatch[1] +
      "-" +
      ("0" + standardMatch[2]).slice(-2) +
      "-" +
      ("0" + standardMatch[3]).slice(-2)
    );
  }

  // 和暦の場合（令和、平成、昭和）
  var jpMatch = s.match(
    /(令和|平成|昭和)\s*([0-9０-９元]+)\s*年\s*([0-9０-９]+)\s*月\s*([0-9０-９]+)\s*日/,
  );
  if (jpMatch) {
    var era = jpMatch[1];
    var yearStr = jpMatch[2];
    var year =
      yearStr === "元"
        ? 1
        : parseInt(
            yearStr.replace(/[０-９]/g, function (c) {
              return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
            }),
            10,
          );
    var month = parseInt(
      jpMatch[3].replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      }),
      10,
    );
    var day = parseInt(
      jpMatch[4].replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      }),
      10,
    );

    var gregYear = 0;
    if (era === "令和") gregYear = year + 2018;
    else if (era === "平成") gregYear = year + 1988;
    else if (era === "昭和") gregYear = year + 1925;

    return (
      gregYear + "-" + ("0" + month).slice(-2) + "-" + ("0" + day).slice(-2)
    );
  }

  return s; // 変換できない場合はそのまま返す
}

// ==================================================================================
// 補助関数: 選択肢マスタ取得（プロパティからスプシID取得）
// ==================================================================================
function splitMasterKey_CloudSQL_(cKey) {
  var s = String(cKey || "").trim();
  var idx = s.indexOf("_");
  if (idx === -1) return null;
  return {
    parentid: s.substring(0, idx).trim(),
    itemName: s.substring(idx + 1).trim(),
  };
}

function getAllowedOptionsByParent_CloudSQL_(parentid) {
  var masterSsId =
    PropertiesService.getScriptProperties().getProperty("MASTER_SS_ID");
  if (!masterSsId)
    throw new Error("スクリプトプロパティ MASTER_SS_ID が設定されていません");

  var SHEET_NAME = "ひな型帳票マスタ子レコード選択肢";
  var sh = SpreadsheetApp.openById(masterSsId).getSheetByName(SHEET_NAME);
  if (!sh)
    throw new Error("選択肢マスタシート「" + SHEET_NAME + "」が見つかりません");

  var values = sh.getDataRange().getValues();
  var out = new Map();

  for (var i = 1; i < values.length; i++) {
    var cKey = values[i][2]; // C列
    var option = values[i][3]; // D列
    if (!cKey || !option) continue;

    var parsed = splitMasterKey_CloudSQL_(cKey);
    if (!parsed) continue;
    if (parsed.parentid !== String(parentid).trim()) continue;

    var item = parsed.itemName;
    var opt = String(option).trim();
    if (!item || !opt) continue;

    if (!out.has(item)) out.set(item, []);
    out.get(item).push(opt);
  }

  out.forEach(function (v, k) {
    out.set(k, Array.from(new Set(v)));
  });
  return out;
}

// ==================================================================================
// 補助関数: 選択肢バリデーション
// ==================================================================================
function normalizeSingleSelect_CloudSQL_(aiValue, options) {
  var raw = String(aiValue == null ? "" : aiValue).trim();
  if (!raw) return { value: "該当なし", hit: false, reason: "空" };
  var hit = options.find(function (o) {
    return o === raw;
  });
  if (hit) return { value: hit, hit: true, reason: "一致" };
  return { value: "該当なし", hit: false, reason: "不一致:" + raw };
}

function normalizeMultiSelect_CloudSQL_(aiValue, options) {
  var src = Array.isArray(aiValue)
    ? aiValue
    : String(aiValue == null ? "" : aiValue).split(/[,\n]/);

  var set = new Set();
  var hitCount = 0;
  var missCount = 0;

  src
    .map(function (v) {
      return String(v == null ? "" : v).trim();
    })
    .filter(Boolean)
    .forEach(function (v) {
      var hit = options.find(function (o) {
        return o === v;
      });
      if (hit) {
        if (!set.has(hit)) hitCount++;
        set.add(hit);
      } else {
        missCount++;
      }
    });

  var arr = Array.from(set);
  if (arr.length === 0) {
    return {
      values: ["該当なし"],
      hitCount: hitCount,
      missCount: Math.max(missCount, 1),
      reason: "全ミス/空",
    };
  }
  return {
    values: arr,
    hitCount: hitCount,
    missCount: missCount,
    reason: "一部/全部ヒット",
  };
}

// ==================================================================================
// メイン関数: AppsheetGeminiFileAI CloudSQL版
// ==================================================================================
function AppsheetGeminiFileAI_CloudSQL(
  folderURL,
  googleFolderName,
  caseNamePDF,
  reportFiles,
  rowID,
  ssURL,
  sheetName,
  textCategory,
  prompt,
  temperature,
  topP,
  tg_FileName,
  tg_AddFilUrl,
  parentid,
) {
  var executionLog = [];
  var clientLog = [];

  executionLog.push("AI処理を開始します...(ID: " + rowID + ")");

  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
    if (!apiKey) throw new Error("APIキーが設定されていません。");

    // --- マスタ取得 ---
    var optionMap = new Map();
    var optionCount = 0;
    if (parentid && String(parentid).trim() !== "") {
      optionMap = getAllowedOptionsByParent_CloudSQL_(String(parentid).trim());
      optionCount = optionMap.size;
      executionLog.push(
        "選択肢マスタ取得: parentid=" + parentid + " / 項目数=" + optionCount,
      );
    }

    // --- フォルダ特定（URLからID抽出） ---
    var userFolder;
    try {
      var targetId = folderURL;
      if (folderURL.indexOf("id=") > -1) {
        targetId = folderURL.split("id=")[1].split("&")[0];
      } else if (folderURL.indexOf("/folders/") > -1) {
        targetId = folderURL.split("/folders/")[1].split(/[/?]/)[0];
      }
      userFolder = DriveApp.getFolderById(targetId);
      executionLog.push("対象フォルダをURLから特定: " + userFolder.getName());
    } catch (e) {
      throw new Error(
        "対象フォルダのURLが無効か、アクセス権限がありません。\nURL: " +
          folderURL,
      );
    }

    clientLog.push(
      "✅ 選択肢：項目数=" +
        optionCount +
        " ➣ 対象フォルダ発見(" +
        userFolder.getName() +
        ")",
    );

    // --- ファイル収集 ---
    var filesToProcess = [];

    // (A) AppSheet直接添付
    executionLog.push(
      "[DEBUG] tg_FileName=" + tg_FileName + ", tg_AddFilUrl=" + tg_AddFilUrl,
    );
    if (tg_FileName && tg_AddFilUrl) {
      try {
        var directFolderId = tg_AddFilUrl;
        if (tg_AddFilUrl.indexOf("id=") > -1)
          directFolderId = tg_AddFilUrl.split("id=")[1].split("&")[0];
        else if (tg_AddFilUrl.indexOf("/folders/") > -1)
          directFolderId = tg_AddFilUrl.split("/folders/")[1].split(/[/?]/)[0];

        executionLog.push("[DEBUG] directFolderId=" + directFolderId);
        var directFolder = DriveApp.getFolderById(directFolderId);
        var directFiles = directFolder.getFilesByName(tg_FileName);

        if (directFiles.hasNext()) {
          var file = directFiles.next();
          filesToProcess.push({
            name: "[直接添付] " + file.getName(),
            blob: file.getBlob(),
          });
          executionLog.push("直接添付ファイルを発見: " + file.getName());
          clientLog.push("✅ 直接添付ファイルを発見 ➣ 処理開始");
        } else {
          executionLog.push("[DEBUG] 直接添付: ファイルが見つかりません");
        }
      } catch (e) {
        executionLog.push("直接添付ファイル検索エラー: " + e.message);
      }
    }

    // (B) 記録PDF（直下の1フォルダのみ検索）
    executionLog.push("[DEBUG] caseNamePDF=" + caseNamePDF);
    if (caseNamePDF) {
      var recordPdfFolders = callWithRetry_CloudSQL_(function () {
        return userFolder.getFoldersByName("記録PDF");
      });
      if (recordPdfFolders.hasNext()) {
        var recordPdfFolder = recordPdfFolders.next(); // 最初の1つだけを取得
        executionLog.push(
          "[DEBUG] 記録PDFフォルダ確認: " + recordPdfFolder.getName(),
        );

        var caseFiles = recordPdfFolder.getFilesByName(caseNamePDF);
        if (caseFiles.hasNext()) {
          var caseFile = caseFiles.next();
          filesToProcess.push({
            name: "[記録] " + caseFile.getName(),
            blob: caseFile.getBlob(),
          });
          executionLog.push("ケース記録PDFを発見: " + caseFile.getName());
          clientLog.push("✅ ケース記録PDFを発見 ➣ 処理開始");
        } else {
          executionLog.push(
            "[DEBUG] 記録PDF内に該当ファイルがありませんでした",
          );
        }
      } else {
        executionLog.push("[DEBUG] 直下に「記録PDF」フォルダが存在しません");
      }
    }

    // (C) 過去帳票PDF
    var reportFileNameList = (reportFiles || "")
      .split(",")
      .map(function (name) {
        return name.trim();
      })
      .filter(function (name) {
        return name;
      });
    if (reportFileNameList.length > 0) {
      var reportPdfFolders = callWithRetry_CloudSQL_(function () {
        return userFolder.getFoldersByName("帳票PDF");
      });
      if (reportPdfFolders.hasNext()) {
        var reportPdfFolder = reportPdfFolders.next();
        var foundCount = 0;
        reportFileNameList.forEach(function (fileName) {
          var reportFileIterator = reportPdfFolder.getFilesByName(fileName);
          if (reportFileIterator.hasNext()) {
            var rFile = reportFileIterator.next();
            filesToProcess.push({
              name: "[過去帳票] " + rFile.getName(),
              blob: rFile.getBlob(),
            });
            foundCount++;
          }
        });
        if (foundCount > 0) {
          executionLog.push("過去帳票PDFを発見: " + foundCount + "件");
          clientLog.push("✅ 過去帳票PDFを発見 ➣ 処理開始");
        }
      }
    }

    // ▼変更点: ファイルが見つからない場合、エラーを投げずにスキップとして処理を正常終了させる
    if (filesToProcess.length === 0) {
      var skipMsg =
        "⚠️ 対象ファイルが見つかりませんでした（処理をスキップします）";
      executionLog.push(skipMsg);
      clientLog.push(skipMsg);
      Logger.log(
        "[DEBUG] ファイル検索失敗。デバッグログ:\n" + executionLog.join("\n"),
      );

      var timeStr = new Date().toLocaleTimeString("ja-JP");
      return skipMsg + " (" + timeStr + ")\n" + clientLog.join("\n");
    }

    // --- アップロード & プロンプト作成 ---
    executionLog.push("ファイルをGeminiへアップロード中...");
    clientLog.push(
      "📤 ファイルをHopeCareAIで解析中 (" + filesToProcess.length + "件)...",
    );

    var promptParts = [];
    var instructionPrompt =
      "あなたはプロの介護または福祉の記録分析アシスタントです。\n" +
      "添付資料を分析し、以下の項目についてJSON形式で回答してください。\n" +
      "項目リスト:\n" +
      textCategory
        .split(",")
        .map(function (item) {
          return "- " + item.replace("||", " (データ型: ").trim() + ")";
        })
        .join("\n") +
      "\n\n# 回答ルール\n" +
      '- JSON形式のみ。該当なしは "" (空文字)。\n' +
      (prompt ? "- 追加指示: " + prompt : "");

    promptParts.push({ text: instructionPrompt });

    for (var fi = 0; fi < filesToProcess.length; fi++) {
      var fileObj = filesToProcess[fi];
      var uploadResult = uploadFileToGemini_CloudSQL_(fileObj.blob, apiKey);
      promptParts.push(uploadResult);
      executionLog.push("アップロード完了: " + fileObj.name);

      var simpleName = fileObj.name.startsWith("[")
        ? fileObj.name.split("]")[0] + "]"
        : "[ファイル]";
      clientLog.push("🆗 解析完了: " + simpleName);
    }

    // --- AIリクエスト（リトライ + APIキーローテーション） ---
    executionLog.push("AIへ分析リクエスト送信中...");
    clientLog.push("🤖 AIリクエスト...📝データ書き込み...");

    var modelId = "gemini-2.5-flash";
    // APIキーローテーション: API_KEY (主) + API_KEY_2..5 (任意、quota切替用)
    var apiKeys = [apiKey];
    for (var ki = 2; ki <= 5; ki++) {
      var k = PropertiesService.getScriptProperties().getProperty(
        "API_KEY_" + ki,
      );
      if (k && apiKeys.indexOf(k) === -1) apiKeys.push(k);
    }

    var aiPayload = {
      contents: [{ parts: promptParts }],
      safetySettings: [
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: parseFloat(temperature),
        topP: parseFloat(topP),
      },
    };
    var aiPayloadStr = JSON.stringify(aiPayload);

    var response = null;
    // 全キーが試せるように最低3回、キー数が増えればそれに合わせる
    var MAX_RETRIES = Math.max(3, apiKeys.length);
    var lastError = "";

    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      var currentKey = apiKeys[attempt % apiKeys.length];
      var keyLabel = "KEY_" + ((attempt % apiKeys.length) + 1);
      var url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        modelId +
        ":generateContent?key=" +
        currentKey;

      var aiOptions = {
        method: "post",
        contentType: "application/json",
        payload: aiPayloadStr,
        muteHttpExceptions: true,
      };

      response = UrlFetchApp.fetch(url, aiOptions);
      var code = response.getResponseCode();

      if (code === 200) {
        if (attempt > 0)
          executionLog.push(
            "リトライ成功 (" + keyLabel + ", 試行" + (attempt + 1) + "回目)",
          );
        break;
      }

      // リトライ可能なエラー (503, 429, 500)
      if (code === 503 || code === 429 || code === 500) {
        lastError = code + " " + response.getContentText().substring(0, 200);
        executionLog.push(
          "AI一時エラー (" +
            keyLabel +
            ", " +
            code +
            ") 試行" +
            (attempt + 1) +
            "/" +
            MAX_RETRIES +
            " → リトライ...",
        );

        if (attempt < MAX_RETRIES - 1) {
          Utilities.sleep(5000 * (attempt + 1)); // 5秒, 10秒, 15秒
        }
        continue;
      }

      // リトライ不可のエラー (400, 401, 403等)
      throw new Error(
        "AIリクエスト失敗: " + code + " " + response.getContentText(),
      );
    }

    if (response.getResponseCode() !== 200) {
      throw new Error(
        "AIリクエスト失敗 (全" + MAX_RETRIES + "回リトライ後): " + lastError,
      );
    }

    var responseText = response.getContentText();
    var aiResponseObject;
    try {
      var jsonResp = JSON.parse(responseText);
      var aiContent =
        jsonResp.candidates &&
        jsonResp.candidates[0] &&
        jsonResp.candidates[0].content &&
        jsonResp.candidates[0].content.parts &&
        jsonResp.candidates[0].content.parts[0] &&
        jsonResp.candidates[0].content.parts[0].text;
      if (!aiContent) throw new Error("AI応答が空です");
      var jsonStr = extractJsonFromAIResponse_CloudSQL_(aiContent);
      aiResponseObject = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error("JSON解析エラー: " + e.message);
    }

    // --- CloudSQL書き込み（スプシ版から置換） ---
    // textCategory → カテゴリマップ構築
    var categoryMap = new Map();
    (textCategory || "").split(",").forEach(function (item) {
      var parts = item.split("||");
      if (parts.length === 2) categoryMap.set(parts[0].trim(), parts[1].trim());
    });

    // 帳票子レコード複製登録の有効なデータ型カラム
    var VALID_DATA_COLS = {
      テキスト: true,
      ロングテキスト: true,
      単一選択肢: true,
      複数選択肢: true,
      数値: true,
      数値_小数点: true,
      パーセント: true,
      電話番号: true,
      メールアドレス: true,
      URL: true,
      住所: true,
      画像: true,
      ファイル: true,
      日付: true,
      日時: true,
    };

    var writeCount = 0;
    var appendCount = 0;
    var skipCount = 0;
    var noMatch = 0;

    var dbConn, dbStmt;
    try {
      dbConn = getCloudSqlConnection_();
      dbConn.setAutoCommit(false);

      for (var key in aiResponseObject) {
        if (!aiResponseObject.hasOwnProperty(key)) continue;
        var value = aiResponseObject[key];
        var dataType = categoryMap.get(key);
        if (!dataType || !VALID_DATA_COLS[dataType]) {
          noMatch++;
          continue;
        }

        // --- 値の正規化（選択肢バリデーション・型クレンジング等） ---
        var writeValue;
        if (dataType === "単一選択肢") {
          var sOpts = optionMap.get(key);
          if (sOpts && sOpts.length > 0) {
            var sResult = normalizeSingleSelect_CloudSQL_(value, sOpts);
            writeValue = sResult.value === "該当なし" ? "" : sResult.value;
          } else {
            writeValue =
              value == null ||
              String(value).trim() === "" ||
              String(value) === "該当なし"
                ? ""
                : String(value);
          }
        } else if (dataType === "複数選択肢") {
          var mOpts = optionMap.get(key);
          if (mOpts && mOpts.length > 0) {
            var mResult = normalizeMultiSelect_CloudSQL_(value, mOpts);
            var filteredValues = Array.isArray(mResult.values)
              ? mResult.values.filter(function (v) {
                  return v !== "該当なし";
                })
              : [];
            writeValue = filteredValues.join("\n");
          } else {
            if (!value || (Array.isArray(value) && value.length === 0))
              writeValue = "";
            else {
              var valArray = Array.isArray(value) ? value : [value];
              writeValue = valArray
                .filter(function (v) {
                  return v != null && String(v) !== "該当なし";
                })
                .join("\n");
            }
          }
        } else if (
          dataType === "数値" ||
          dataType === "数値_小数点" ||
          dataType === "パーセント"
        ) {
          // 数値のクレンジング
          var numStr = String(value == null ? "" : value)
            .replace(/[０-９]/g, function (s) {
              return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
            })
            .replace(/[^0-9.-]/g, "");
          writeValue = numStr === "" ? "" : numStr;
        } else if (dataType === "日付") {
          // 日付のクレンジング
          writeValue = formatToSqlDate_CloudSQL_(value);
        } else {
          if (
            value == null ||
            String(value).trim() === "" ||
            String(value) === "該当なし"
          )
            writeValue = "";
          else writeValue = Array.isArray(value) ? value.join("\n") : value;
        }

        if (writeValue === "") {
          skipCount++;
          continue;
        }

        // --- CloudSQL UPDATE ---
        var NON_TEXT_COLS = {
          日付: true,
          日時: true,
          数値: true,
          数値_小数点: true,
          パーセント: true,
        };
        var updateSql;
        var isNonText = NON_TEXT_COLS[dataType];

        if (isNonText) {
          updateSql =
            'UPDATE "帳票子レコード複製登録" SET "' +
            dataType +
            '" = ?, ' +
            '"更新日時" = NOW() ' +
            'WHERE "帳票マスタ複製登録ID" = ? AND "&&項目名&&" = ? AND "項目データ型選択" = ?';
        } else {
          updateSql =
            'UPDATE "帳票子レコード複製登録" SET "' +
            dataType +
            '" = ' +
            'CASE WHEN "' +
            dataType +
            '" IS NULL OR "' +
            dataType +
            "\" = '' " +
            "THEN ? " +
            'ELSE "' +
            dataType +
            "\" || E'\\n\\n:\\n' || ? " +
            "END, " +
            '"更新日時" = NOW() ' +
            'WHERE "帳票マスタ複製登録ID" = ? AND "&&項目名&&" = ? AND "項目データ型選択" = ?';
        }

        dbStmt = dbConn.prepareStatement(updateSql);

        if (isNonText) {
          dbStmt.setString(1, String(writeValue));
          dbStmt.setString(2, rowID);
          dbStmt.setString(3, key);
          dbStmt.setString(4, dataType);
        } else {
          dbStmt.setString(1, String(writeValue));
          dbStmt.setString(2, String(writeValue));
          dbStmt.setString(3, rowID);
          dbStmt.setString(4, key);
          dbStmt.setString(5, dataType);
        }

        var updated = dbStmt.executeUpdate();
        dbStmt.close();

        if (updated > 0) {
          writeCount++;
        } else {
          noMatch++;
        }
      }

      dbConn.commit();
      executionLog.push(
        "CloudSQL書込完了: 更新 " +
          writeCount +
          "件 (スキップ " +
          skipCount +
          ", 対象外 " +
          noMatch +
          ")",
      );
    } catch (dbErr) {
      try {
        dbConn.rollback();
      } catch (rbErr) {
        /* ignore */
      }
      throw new Error("CloudSQL書込エラー: " + dbErr.message);
    } finally {
      closeCloudSql_(dbConn);
    }

    var resultMessage =
      "✅ データ反映完了: 更新 " +
      writeCount +
      "件 (空欄スキップ " +
      skipCount +
      "件)";
    executionLog.push(resultMessage);
    clientLog.push(resultMessage);

    Logger.log(executionLog.join("\n"));

    var timeStr = new Date().toLocaleTimeString("ja-JP");
    return "✅ 正常完了 (" + timeStr + ")\n" + clientLog.join("\n");
  } catch (e) {
    Logger.log(e.stack || e.message);
    return "❌ エラー: " + e.message;
  }
}

// ==================================================================================
// テスト: APIキーの疎通確認
// ==================================================================================
function test_GeminiApiKeys() {
  var props = PropertiesService.getScriptProperties();
  var keyNames = [
    "API_KEY",
    "API_KEY_2",
    "API_KEY_3",
    "API_KEY_4",
    "API_KEY_5",
  ];

  keyNames.forEach(function (keyName) {
    var key = props.getProperty(keyName);
    if (!key) {
      Logger.log(keyName + ": 未設定 → スキップ");
      return;
    }

    var modelId = "gemini-2.5-flash";
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      modelId +
      ":generateContent?key=" +
      key;
    var payload = {
      contents: [{ parts: [{ text: "テスト。1+1=?" }] }],
    };
    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    try {
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();

      if (code === 200) {
        var body = JSON.parse(response.getContentText());
        var answer =
          body.candidates &&
          body.candidates[0] &&
          body.candidates[0].content &&
          body.candidates[0].content.parts &&
          body.candidates[0].content.parts[0] &&
          body.candidates[0].content.parts[0].text;
        Logger.log(
          "✅ " +
            keyName +
            ": 正常 (応答: " +
            (answer || "").substring(0, 50) +
            ")",
        );
      } else {
        Logger.log(
          "❌ " +
            keyName +
            ": エラー " +
            code +
            " - " +
            response.getContentText().substring(0, 100),
        );
      }
    } catch (e) {
      Logger.log("❌ " + keyName + ": 通信エラー - " + e.message);
    }
  });
}
