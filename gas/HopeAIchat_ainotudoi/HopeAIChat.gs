/**
 * =======================================================
 * Hope AI Chat メインロジック (統合・高速版)
 * =======================================================
 */

const CONTEXT_CACHE_TTL_SEC = 5 * 60;

// FIXED: [R2] IDバリデーション - 英数字・ハイフン・アンダースコアのみ許可
function validateId_(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("無効なIDです");
  return id;
}

// FIXED: [R5] ユーザー情報のキャッシュ（個別取得・長期キャッシュ・排他制御）
function getCachedUser_(props, userId) {
  const cacheKey = `USER_${userId}`;
  const cache = CacheService.getScriptCache();

  // 1. まず該当ユーザーの個別キャッシュを確認
  let cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // 2. キャッシュがない場合、APIの同時アクセスを防ぐためロック（順番待ち）を取得
  const lock = LockService.getScriptLock();
  try {
    // 最大15秒間、他の処理が終わるのを待つ
    lock.waitLock(15000);

    // ロック取得後、念のため再度キャッシュを確認
    cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    console.log(`[Lock] AppSheetへ利用者(${userId})の情報を取得しに行きます`);

    // ★修正ポイント：全件取得ではなく、該当ユーザー「1名分」だけをピンポイントで取得する
    const selector = `Filter(CustomerStatus__c, [Row ID] = '${userId}')`;
    const rows = callAppSheetApi(
      props.getProperty("APPSHEET_APP_ID"),
      props.getProperty("APPSHEET_API_KEY"),
      "CustomerStatus__c",
      selector,
    );

    if (rows && rows.length > 0) {
      const user = rows[0];
      // 取得した1名分のデータを1時間（3600秒）キャッシュに保存
      cache.put(cacheKey, JSON.stringify(user), 3600);
      return user;
    }
  } catch (e) {
    console.error("Lock/Fetch Error (Customer Individual): " + e.message);
  } finally {
    // 必ずロックを解放する
    lock.releaseLock();
  }

  return null;
}

// 1. 最優先：利用者名とコンテキスト有無だけを返す
function getBasicUserInfo(targetId) {
  try {
    targetId = validateId_(targetId); // FIXED: [R2] IDバリデーション
    const props = PropertiesService.getScriptProperties();
    const user = getCachedUser_(props, targetId); // FIXED: [R5] キャッシュ利用
    if (!user) return { error: "利用者が存在しません" };

    const folderId = getPDFFolderId_(user);
    const hasContext = !!folderId;

    return {
      userName: user["CustomerName__c"],
      hasContext: hasContext,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// 2. 裏側処理：重い履歴解析（プリセット抽出）を行う
function getHistoryPresets(targetId) {
  try {
    targetId = validateId_(targetId); // FIXED: [R2] IDバリデーション
    const props = PropertiesService.getScriptProperties();
    const user = getCachedUser_(props, targetId); // FIXED: [R5] キャッシュ利用
    const historyText = getChatHistoryContent(user, targetId);
    return { presets: analyzeHistoryForPrompts_(historyText) };
  } catch (e) {
    return { presets: [] };
  }
}

// 3. メインチャット処理 (履歴を知識として結合)
function processUserMessage(
  userId,
  userMessage,
  fileData,
  useContext,
  frontendHistory,
) {
  try {
    userId = validateId_(userId); // FIXED: [R2] IDバリデーション
    const props = PropertiesService.getScriptProperties();
    const user = getCachedUser_(props, userId); // FIXED: [R5] キャッシュ利用
    if (!user)
      return "利用者情報が取得できませんでした。画面を再読み込みしてください。";

    let contextText = "";
    if (useContext !== false) {
      contextText = getContextFileContent(user, userId) || "";
      // チャット履歴ファイルを「知識」として結合！
      const savedHistory = getChatHistoryContent(user, userId);
      if (savedHistory) {
        contextText += "\n\n=== 過去の重要な会話履歴 ===\n" + savedHistory;
      }
    }

    const reply = callGeminiApi(
      props.getProperty("API_KEY"),
      contextText,
      frontendHistory,
      userMessage,
      fileData,
    );
    // FIXED: [R3] エラー応答時は履歴保存をスキップ
    if (!reply.startsWith("申し訳ございません")) {
      saveChatHistoryToDrive(
        user,
        userId,
        fileData ? `[添付あり] ${userMessage}` : userMessage,
        reply,
      );
    }
    return reply;
  } catch (e) {
    // FIXED: [B4] エラー通知をSlackに送信 + 個人情報を含まない汎用メッセージを返却
    console.error("processUserMessage Error: " + e.message);
    try {
      notifyError("processUserMessage", e.message);
    } catch (ne) {}
    return "エラーが発生しました。しばらくしてから再度お試しください。";
  }
}

// --- 以下、補助関数 (空白無視ロジック等をすべて維持) ---

function analyzeHistoryForPrompts_(historyText) {
  if (!historyText) return [];
  const results = [];

  // 1. 指示オプション（# タグ）の使用回数ランキング
  const tagFreq = {};
  const tagMatches = historyText.match(/# .+/g);
  if (tagMatches) {
    tagMatches.forEach((tag) => {
      const t = tag.trim();
      if (t.length > 3 && t.length < 50) tagFreq[t] = (tagFreq[t] || 0) + 1;
    });
  }
  Object.entries(tagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach((e) => results.push(e[0]));

  // 2. ユーザーメッセージのパターン抽出（類似質問をグルーピング）
  const userMessages = [];
  const lines = historyText.split("\n");
  lines.forEach((line) => {
    const m = line.match(/\] User: (.+)/);
    if (m) {
      let msg = m[1].trim();
      // 指示オプション部分を除去
      msg = msg
        .split("=== 指示オプション")[0]
        .split("=== トーン指示")[0]
        .trim();
      // 添付タグ除去
      msg = msg.replace(/^\[添付あり\]\s*/, "");
      if (msg.length >= 5 && msg.length <= 60) userMessages.push(msg);
    }
  });

  // 先頭キーワード（最初の数文字）でグルーピングして頻出パターンを抽出
  const patternFreq = {};
  userMessages.forEach((msg) => {
    // 先頭15文字をキーにして似たメッセージをグルーピング
    const key = msg.substring(0, Math.min(15, msg.length));
    if (!patternFreq[key]) patternFreq[key] = { count: 0, shortest: msg };
    patternFreq[key].count++;
    // 最も短い（簡潔な）バージョンを代表として保持
    if (msg.length < patternFreq[key].shortest.length)
      patternFreq[key].shortest = msg;
  });

  Object.entries(patternFreq)
    .filter((e) => e[1].count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .forEach((e) => {
      let label = e[1].shortest;
      // 30文字超は省略
      if (label.length > 30) label = label.substring(0, 28) + "...";
      if (!results.includes(label)) results.push(label);
    });

  return results.slice(0, 8);
}

function readFileFromChatPDFFolder(userObj, suffix) {
  try {
    const folder = getChatPDFFolder(userObj);
    if (!folder) return null;
    const cleanUserName = (userObj["CustomerName__c"] || "").replace(
      /\s+/g,
      "",
    );
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (
        f.getName().replace(/\s+/g, "").includes(cleanUserName) &&
        f.getName().includes(suffix)
      )
        return f.getBlob().getDataAsString("UTF-8");
    }
    return null;
  } catch (e) {
    return null;
  }
}

function getContextFileContent(userObj, userId) {
  // FIXED: [R6] コンテキストのキャッシュ（5分間）
  const cacheKey = `CTX_${userId}`;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return cached;

  const cleanUserName = (userObj["CustomerName__c"] || "").replace(/\s+/g, "");
  let combinedText = "";
  try {
    const folder = getChatPDFFolder(userObj);
    if (!folder) return null;
    const files = folder.getFiles();
    const fileList = [];
    while (files.hasNext()) {
      const f = files.next();
      if (
        f.getName().replace(/\s+/g, "").includes(cleanUserName) &&
        f.getName().includes("AIコンテキスト")
      ) {
        fileList.push({
          name: f.getName(),
          content: f.getBlob().getDataAsString("UTF-8"),
        });
      }
    }
    fileList
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(
        (f) => (combinedText += `\n\n=== 参照: ${f.name} ===\n\n` + f.content),
      );
  } catch (e) {}

  // FIXED: [R6] キャッシュに保存（CacheServiceの上限100KBに収まるサイズのみ）
  if (combinedText && combinedText.length < 90000) {
    CacheService.getScriptCache().put(cacheKey, combinedText, 300);
  }

  return combinedText || null;
}

function getChatHistoryContent(userObj, userId) {
  const cache = CacheService.getScriptCache().get(`HIST_${userId}`);
  if (cache) return cache;
  return readFileFromChatPDFFolder(userObj, "_チャット履歴.txt") || "";
}

function saveChatHistoryToDrive(userObj, userId, q, a) {
  try {
    const folder = getChatPDFFolder(userObj);
    if (!folder) return;
    const fileName = `${userObj["CustomerName__c"]}_チャット履歴.txt`;
    const files = folder.getFilesByName(fileName);
    let file,
      current = "";
    if (files.hasNext()) {
      file = files.next();
      current = file.getBlob().getDataAsString();
    }
    const entry = `\n---\n[${Utilities.formatDate(new Date(), "Asia/Tokyo", "MM/dd HH:mm")}] User: ${q}\n[AI]: ${a}\n`;
    const news = current + entry;

    // FIXED: [B1] 履歴ファイル肥大化対策 - 80000文字超でアーカイブ分割
    if (news.length > 80000) {
      const half = Math.floor(news.length / 2);
      const splitPoint = news.indexOf("\n---\n", half);
      const archiveContent = news.substring(
        0,
        splitPoint > 0 ? splitPoint : half,
      );
      const keepContent = news.substring(splitPoint > 0 ? splitPoint : half);

      const archiveName = `${userObj["CustomerName__c"]}_チャット履歴_archive_${Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMM")}.txt`;
      const archiveFiles = folder.getFilesByName(archiveName);
      if (archiveFiles.hasNext()) {
        const af = archiveFiles.next();
        af.setContent(af.getBlob().getDataAsString() + archiveContent);
      } else {
        folder.createFile(archiveName, archiveContent, MimeType.PLAIN_TEXT);
      }

      if (file) file.setContent(keepContent);
      else folder.createFile(fileName, keepContent, MimeType.PLAIN_TEXT);
      if (keepContent.length < 90000)
        CacheService.getScriptCache().put(`HIST_${userId}`, keepContent, 3600);
    } else {
      if (file) file.setContent(news);
      else folder.createFile(fileName, entry, MimeType.PLAIN_TEXT);
      if (news.length < 90000)
        CacheService.getScriptCache().put(`HIST_${userId}`, news, 3600);
    }
  } catch (e) {
    console.error("saveChatHistory Error: " + e.message);
  } // FIXED: [R4] catch にログ出力
}

function getChatPDFFolder(userObj) {
  const id = getPDFFolderId_(userObj);
  if (!id) return null;
  const f = DriveApp.getFolderById(id).getFoldersByName("ChatPDF");
  return f.hasNext() ? f.next() : null;
}

function getPDFFolderId_(userObj) {
  const url = userObj["GoogleURL__c"];
  if (!url) return null;
  const m =
    url.match(/id=([a-zA-Z0-9_-]+)/) ||
    url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// FIXED: [R10] callStaffList_ 削除 - callAppSheetApi.js の getStaffList を使用
// FIXED: [R10] callAppSheetApi 削除 - callAppSheetApi.js の同名関数(try-catch付き)を使用

/**
 * エラーメッセージや URL から API キー部分をマスクする（Slack/ログ用）
 * 例: "...?key=AIzaSyAJ0UmzrdZrzz..." → "...?key=***"
 */
function maskSecrets_(text) {
  if (!text) return text;
  return String(text)
    .replace(/key=[A-Za-z0-9_\-]+/g, "key=***")
    .replace(/AIza[A-Za-z0-9_\-]{20,}/g, "AIza***");
}

/**
 * Gemini API 呼び出し（APIキーローテーション + モデルフォールバック対応）
 *
 * APIキーは以下の順で試行：
 *   1. API_KEY        （既存の主キー、引数で渡される）
 *   2. API_KEY_2      （任意、quota切替用）
 *   3. API_KEY_3      （任意、quota切替用）
 *   ...最大 API_KEY_5 まで
 *
 * 各キーで以下のモデル順に試行：
 *   1. GEMINI_MODEL（デフォルト: gemini-2.0-flash）
 *   2. gemini-2.0-flash（fallback）
 *
 * quota/429 エラー時のみ次のAPIキーへ切替。それ以外（5xx等）は
 * 同キー内のモデルfallbackで対処。
 */
function callGeminiApi(apiKey, context, frontendHistory, message, fileData) {
  const props = PropertiesService.getScriptProperties();
  const primaryModel = props.getProperty("GEMINI_MODEL") || "gemini-2.0-flash";
  const fallbackModel = "gemini-2.0-flash";
  const models =
    primaryModel !== fallbackModel
      ? [primaryModel, fallbackModel]
      : [primaryModel];

  // 利用可能なAPIキー一覧を組み立て（重複除外）
  // 命名規則は2種類サポート（既存設定との互換性のため）:
  //   - API_KEY-002, API_KEY-003, ... API_KEY-005 （ハイフン+3桁ゼロ埋め）
  //   - API_KEY_2, API_KEY_3, ... API_KEY_5（アンダースコア）
  const apiKeys = [];
  if (apiKey) apiKeys.push(apiKey);
  for (let i = 2; i <= 5; i++) {
    let k = props.getProperty(`API_KEY-${String(i).padStart(3, "0")}`);
    if (!k) k = props.getProperty(`API_KEY_${i}`);
    if (k && apiKeys.indexOf(k) === -1) apiKeys.push(k);
  }

  // ペイロード組み立て
  const contents = [
    {
      role: "user",
      parts: [
        {
          text:
            "あなたは福祉事業所の支援アシスタントです。最新の会話履歴を優先してください。\n\n【知識】\n" +
            context,
        },
      ],
    },
  ];
  contents.push({ role: "model", parts: [{ text: "了解しました。" }] });
  if (frontendHistory)
    frontendHistory.forEach((m) =>
      contents.push({ role: m.role, parts: [{ text: m.text }] }),
    );
  const userParts = [{ text: message }];
  if (fileData)
    userParts.push({
      inline_data: { mime_type: fileData.type, data: fileData.data },
    });
  contents.push({ role: "user", parts: userParts });
  const payload = JSON.stringify({ contents: contents });

  const allErrors = []; // 全失敗時のSlack通知用ログ
  let blockReason = null; // safety block 検知用

  for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
    const currentKey = apiKeys[keyIdx];
    const keyLabel = keyIdx === 0 ? "API_KEY" : `API_KEY_${keyIdx + 1}`;
    let quotaHitOnThisKey = false;

    for (const model of models) {
      console.log(`[callGeminiApi] ${keyLabel} model=${model}`);
      const res = UrlFetchApp.fetch(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${currentKey}`,
        {
          method: "post",
          contentType: "application/json",
          payload: payload,
          muteHttpExceptions: true,
        },
      );
      const resCode = res.getResponseCode();
      const resText = res.getContentText();

      let resBody;
      try {
        resBody = JSON.parse(resText);
      } catch (parseErr) {
        const msg = `${keyLabel}/${model} parse error (HTTP ${resCode})`;
        console.warn(`[callGeminiApi] ${msg}`);
        allErrors.push(msg);
        continue; // 同じキーの次モデルへ
      }

      if (resCode === 200) {
        if (!resBody.candidates || resBody.candidates.length === 0) {
          const reason = resBody.promptFeedback?.blockReason || "不明";
          console.warn(
            `[callGeminiApi] ${keyLabel}/${model} candidates empty: ${reason}`,
          );
          blockReason = reason;
          allErrors.push(`${keyLabel}/${model} candidates empty: ${reason}`);
          continue;
        }
        // 成功
        if (keyIdx > 0 || model !== primaryModel) {
          console.log(`[callGeminiApi] ${keyLabel}/${model} で成功`);
        }
        return resBody.candidates[0].content.parts[0].text;
      }

      // エラー処理
      const errDetail = maskSecrets_(
        resBody.error?.message || resText.substring(0, 200),
      );
      console.warn(
        `[callGeminiApi] ${keyLabel}/${model} HTTP ${resCode}: ${errDetail}`,
      );
      allErrors.push(`${keyLabel}/${model} HTTP ${resCode}: ${errDetail}`);

      // quota/429/帯域幅 エラー判定 → 次のAPIキーへスキップ
      const isQuota =
        resCode === 429 ||
        /quota|rate.?limit|帯域幅|bandwidth|exceed/i.test(errDetail);
      if (isQuota) {
        quotaHitOnThisKey = true;
        break; // 同キーのモデルfallbackは諦め、次のAPIキーへ
      }
      // それ以外のエラーは同キーの次モデルへ
    }

    // このキーで成功しなかった
    if (quotaHitOnThisKey && keyIdx < apiKeys.length - 1) {
      console.log(`[callGeminiApi] ${keyLabel} quota切れ、次のAPIキーへ切替`);
      continue; // 次のAPIキーへ
    }
  }

  // 全失敗
  try {
    notifyError(
      "callGeminiApi",
      `Gemini API 呼び出し全失敗 (キー${apiKeys.length}本×モデル${models.length}本試行)\n` +
        allErrors.join("\n"),
    );
  } catch (ne) {}

  if (blockReason) {
    return "申し訳ございません。AIが安全上の理由で回答を生成できませんでした。表現を変えてお試しください。";
  }
  return "申し訳ございません。AI応答の取得に失敗しました。しばらくしてから再度お試しください。";
}

// ==========================================================================
// ケース記録登録（JDBC優先 + AppSheet APIフォールバック）
// ==========================================================================
// スクリプトプロパティ USE_JDBC_WRITE:
//   "true"  → JDBC優先、失敗時に AppSheet API にフォールバック
//   "false" (既定) → AppSheet API のみ
//
// エラー時の戻り値:
//   { status: "Error", userMessage: "...", detail: "..." }
//   userMessage はユーザー画面用、detail はシステム管理者向け（ID類はマスク済み）
// ==========================================================================
function registerCaseRecord(userId, content, staffId, consultId) {
  const props = PropertiesService.getScriptProperties();
  const useJdbc = props.getProperty("USE_JDBC_WRITE") === "true";
  const timestamp = Utilities.formatDate(
    new Date(),
    "Asia/Tokyo",
    "yyyy/MM/dd HH:mm:ss",
  );
  const errors = [];

  // 入力バリデーション（多層防御）
  try {
    if (userId) validateId_(userId);
    if (staffId) validateId_(staffId);
    if (consultId) validateId_(consultId);
  } catch (ve) {
    console.error("registerCaseRecord 入力検証エラー: " + ve.message);
    return {
      status: "Error",
      userMessage: "この画面をシステム管理者にお伝えください",
      detail:
        "■ ケース記録登録エラー\n時刻: " +
        timestamp +
        "\n原因: 不正なID形式\n" +
        ve.message,
    };
  }

  // 利用者情報・職員情報を取得（JDBC INSERT の計算フィールド再現に使用）
  // getCachedUser_ / getStaffList はキャッシュ優先のため、通常はAPIを叩かない
  const user = getCachedUser_(props, userId);
  const officeId = user && user["Office__c"] ? String(user["Office__c"]) : "";
  const userName =
    user && user["CustomerName__c"] ? String(user["CustomerName__c"]) : "";

  let staffName = "";
  try {
    const staffList = getStaffList();
    if (staffList && staffList.length) {
      const hit = staffList.find(function (s) {
        return s.id === staffId;
      });
      if (hit) staffName = hit.name || "";
    }
  } catch (se) {
    console.warn("職員リスト取得失敗（氏名無しで継続）: " + se.message);
  }

  let userMail = "";
  try {
    userMail = Session.getActiveUser().getEmail() || "";
  } catch (me) {}

  // ---- Step 1: JDBC直接書き込み ----
  if (useJdbc) {
    try {
      const ids = registerCaseRecordJDBC_(userId, content, staffId, consultId, {
        officeId: officeId,
        userName: userName,
        staffName: staffName,
        userMail: userMail,
      });
      console.log("[registerCaseRecord] JDBC成功 Row ID=" + ids.rowId);
      return { status: "Success", method: "JDBC", rowId: ids.rowId };
    } catch (e) {
      console.warn(
        "[registerCaseRecord] JDBC失敗、AppSheet APIにフォールバック: " +
          e.message,
      );
      errors.push("[JDBC失敗] " + e.message);
    }
  }

  // ---- Step 2: AppSheet API 書き込み ----
  try {
    registerCaseRecordAppSheet_(userId, content, staffId, consultId);
    console.log("[registerCaseRecord] AppSheet API 成功");
    return { status: "Success", method: "AppSheet" };
  } catch (e) {
    errors.push("[AppSheet API失敗] " + e.message);
  }

  // ---- Step 3: 全失敗 → 詳細ログ（マスク済み）とSlack通知 ----
  // サーバーログには生のID（障害調査用）
  const rawDetail = [
    "■ ケース記録登録エラー",
    "時刻: " + timestamp,
    "利用者ID: " + (userId || "(なし)"),
    "記録者ID: " + (staffId || "(なし)"),
    "相談記録ID: " + (consultId || "(なし)"),
    "入力長: " + (content ? content.length : 0) + "文字",
    "USE_JDBC_WRITE: " + useJdbc,
    "",
    "発生エラー:",
    errors
      .map(function (e) {
        return "  " + e;
      })
      .join("\n"),
  ].join("\n");
  console.error(rawDetail);

  // 画面・Slack用にはID類をマスク
  const maskedDetail = [
    "■ ケース記録登録エラー",
    "時刻: " + timestamp,
    "利用者ID: " + maskId_(userId),
    "記録者ID: " + maskId_(staffId),
    "相談記録ID: " + maskId_(consultId),
    "入力長: " + (content ? content.length : 0) + "文字",
    "USE_JDBC_WRITE: " + useJdbc,
    "",
    "発生エラー:",
    errors
      .map(function (e) {
        return "  " + e;
      })
      .join("\n"),
  ].join("\n");

  try {
    notifyError("registerCaseRecord", maskedDetail);
  } catch (ne) {}

  return {
    status: "Error",
    userMessage: "この画面をシステム管理者にお伝えください",
    detail: maskedDetail,
  };
}

/**
 * ID文字列をマスク化（画面・Slack通知用）
 * 例: "a03RB00000tNbEUYA0" → "a03R*********UYA0"
 *     "abc" → "a***"
 *     null/undefined → "(なし)"
 */
function maskId_(id) {
  if (!id) return "(なし)";
  var s = String(id);
  if (s.length <= 4) return s.substring(0, 1) + "***";
  if (s.length <= 8) return s.substring(0, 2) + "****";
  return (
    s.substring(0, 4) +
    "*".repeat(Math.max(4, s.length - 8)) +
    s.substring(s.length - 4)
  );
}

// ---- ID生成ヘルパー ----

/**
 * AppSheet形式のRow ID（22文字の英数字＋ハイフン/アンダースコア）を生成
 * 例: "NNo2I26Ttq42MSoQQGG-fb"
 */
function generateAppSheetRowId_() {
  var chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var id = "";
  for (var i = 0; i < 22; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * ケース記録ID（16文字の16進数）を生成
 * 例: "f4fbf642f46a5bed"
 */
function generateKeshikiRecordId_() {
  return Utilities.getUuid().replace(/-/g, "").substring(0, 16).toLowerCase();
}

// ---- JDBC直接書き込み ----
// options: { officeId, userName, staffName, userMail }
function registerCaseRecordJDBC_(userId, content, staffId, consultId, options) {
  var conn = null;
  var stmt = null;
  try {
    conn = getCloudSqlConnection_();
    var rowId = generateAppSheetRowId_();
    var kirokuId = generateKeshikiRecordId_();

    var opts = options || {};
    var officeId = opts.officeId || "";
    var userName = opts.userName || "";
    var staffName = opts.staffName || "";
    var userMail = opts.userMail || "";

    // 登録日時: AppSheet表示との互換性のため JST wall-clock を UTC時刻として格納
    // (既存の AppSheet API 経由レコードと同じ挙動: DB値 = JST時刻の数字をそのままUTC扱い)
    // 明示的に "+00" を付けて GAS JDBC のセッションTZ (PDT) 変換を回避
    var now = new Date();
    var nowJst =
      Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss") + "+00";
    var todayDate = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");
    var hhmm = Utilities.formatDate(now, "Asia/Tokyo", "HH:mm");
    var yyyymm = Utilities.formatDate(now, "Asia/Tokyo", "yyyy年MM月");
    var yyyymmdd = Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMdd");
    var compoundKey = yyyymmdd + "_" + (userId || "") + "_" + officeId;

    // AppSheet App Formula 再現
    // 職員名はフリガナ付き（"漢字名_ふりがな"）で来ることがあるため漢字名部分のみ使用
    var staffNameShort = String(staffName || "").split("_")[0];
    var userRecordStr = userName
      ? userName + "( 記録者:" + staffNameShort + ")"
      : "";
    var kirokuZenyo = hhmm + "【 チャット記録 】\n" + (content || "");

    // AppSheet の Initial Value / App Formula で自動設定されていた項目を明示的にセット
    var sql =
      'INSERT INTO "ケース記録" ' +
      '("Row ID", "ケース記録ID", "利用者在籍ID", "利用者氏名", "入力内容", "記録全容", ' +
      ' "登録日時", "支援開始日時", "支援終了日時", "更新日時", ' +
      ' "支援時間", "支援記録種別", "フェーズ", "記録者", "利用者記録者", "相談記録ID", ' +
      ' "日付", "年月", "年月日_利用者在籍ID", "UserMail", "フラグ", "SF処理フラグ") ' +
      "VALUES (?, ?, ?, ?, ?, ?, " +
      " ?::timestamptz, ?::timestamptz, ?::timestamptz, ?::timestamptz, " +
      " ?::interval, ?, ?, ?, ?, ?, " +
      " ?::date, ?, ?, ?, ?, ?)";

    stmt = conn.prepareStatement(sql);
    stmt.setString(1, rowId);
    stmt.setString(2, kirokuId);
    stmt.setString(3, String(userId || ""));
    stmt.setString(4, userName); // 利用者氏名
    stmt.setString(5, String(content || ""));
    stmt.setString(6, kirokuZenyo); // 記録全容
    stmt.setString(7, nowJst); // 登録日時
    stmt.setString(8, nowJst); // 支援開始日時
    stmt.setString(9, nowJst); // 支援終了日時
    stmt.setString(10, nowJst); // 更新日時
    stmt.setString(11, "0 seconds"); // 支援時間
    stmt.setString(12, "チャット記録"); // 支援記録種別
    stmt.setString(13, "完了(実施済)"); // フェーズ
    stmt.setString(14, String(staffId || "")); // 記録者
    stmt.setString(15, userRecordStr); // 利用者記録者
    if (consultId) {
      // 相談記録ID
      stmt.setString(16, String(consultId));
    } else {
      stmt.setNull(16, 12);
    }
    stmt.setString(17, todayDate); // 日付
    stmt.setString(18, yyyymm); // 年月
    stmt.setString(19, compoundKey); // 年月日_利用者在籍ID
    stmt.setString(20, userMail); // UserMail
    stmt.setBoolean(21, false); // フラグ
    stmt.setBoolean(22, false); // SF処理フラグ

    var affected = stmt.executeUpdate();
    if (affected !== 1) {
      throw new Error("INSERT affected rows = " + affected + " (期待: 1)");
    }
    return { rowId: rowId, kirokuId: kirokuId };
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

// ---- AppSheet API 書き込み（従来の実装、フォールバック用） ----
function registerCaseRecordAppSheet_(userId, content, staffId, consultId) {
  const props = PropertiesService.getScriptProperties();
  const APP_ID = props.getProperty("APPSHEET_APP_ID");
  const API_KEY = props.getProperty("APPSHEET_API_KEY");

  const url = `https://api.appsheet.com/api/v2/apps/${APP_ID}/tables/ケース記録/Action`;
  const now = Utilities.formatDate(
    new Date(),
    "Asia/Tokyo",
    "yyyy/MM/dd HH:mm:ss",
  );

  const rowData = {
    利用者在籍ID: userId,
    入力内容: content,
    登録日時: now,
    支援記録種別: "チャット記録",
    記録者: staffId,
  };
  if (consultId) rowData["相談記録ID"] = consultId;

  const payload = {
    Action: "Add",
    Properties: { Locale: "ja-JP", Timezone: "Tokyo Standard Time" },
    Rows: [rowData],
  };

  const options = {
    method: "post",
    headers: {
      ApplicationAccessKey: API_KEY,
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) return;

    if (code === 429 && attempt < MAX_RETRIES) {
      Utilities.sleep(5000 * attempt);
      continue;
    }
    if (attempt === MAX_RETRIES) {
      throw new Error(
        `AppSheet API Error (HTTP ${code}): ${response.getContentText().substring(0, 200)}`,
      );
    }
    Utilities.sleep(2000);
  }
}

// ---- テスト関数（GASエディタから手動実行） ----
// USE_JDBC_WRITE の値に関係なく、JDBCパスだけを単体テスト
function testRegisterCaseRecordJDBC() {
  const userId = "a03RB00000tNbEUYA0";
  const staffId = "a0FRB00000LrSba2AF";
  const props = PropertiesService.getScriptProperties();

  // App Formula 再現用のユーザー・職員情報を取得
  const user = getCachedUser_(props, userId);
  const officeId = user && user["Office__c"] ? String(user["Office__c"]) : "";
  const userName =
    user && user["CustomerName__c"] ? String(user["CustomerName__c"]) : "";
  Logger.log("取得: Office__c=" + officeId + ", CustomerName__c=" + userName);

  let staffName = "";
  try {
    const staffList = getStaffList();
    if (staffList && staffList.length) {
      const hit = staffList.find(function (s) {
        return s.id === staffId;
      });
      if (hit) staffName = hit.name || "";
    }
  } catch (e) {}
  Logger.log("取得: staffName=" + staffName);

  let userMail = "";
  try {
    userMail = Session.getActiveUser().getEmail() || "";
  } catch (e) {}

  const result = registerCaseRecordJDBC_(
    userId,
    "【テスト】JDBC書き込み動作確認 - " + new Date().toISOString(),
    staffId,
    null,
    {
      officeId: officeId,
      userName: userName,
      staffName: staffName,
      userMail: userMail,
    },
  );
  Logger.log("JDBC書き込み成功: " + JSON.stringify(result));
}

// USE_JDBC_WRITE の設定に従ってディスパッチャー経由でテスト
// (Step 5 の本番切替テスト用。USE_JDBC_WRITE=true で初めてJDBCが動く)
function testRegisterCaseRecordDispatcher() {
  const result = registerCaseRecord(
    "a03RB00000tNbEUYA0",
    "【テスト】ディスパッチャー経由 - " + new Date().toISOString(),
    "a0FRB00000LrSba2AF",
    null,
  );
  Logger.log("書き込み結果: " + JSON.stringify(result));
}

// =================================================================================
// 基本セット（デフォルトプロンプト）管理 — 全職員共通
// Script Properties に DEFAULT_PRESETS を JSON 配列で保存
// =================================================================================
const DEFAULT_PRESETS_KEY = "DEFAULT_PRESETS";
const DEFAULT_PRESETS_FALLBACK = [
  "# 200文字以内で回答",
  "# SOAP形式で出力",
  "# 箇条書きで要点を3つほど回答",
  "# 挨拶なしで回答のみ出力",
];
const DEFAULT_PRESETS_MAX_COUNT = 50;
const DEFAULT_PRESETS_MAX_LEN = 500;

function getDefaultPresets() {
  try {
    const stored =
      PropertiesService.getScriptProperties().getProperty(DEFAULT_PRESETS_KEY);
    if (!stored) return { presets: DEFAULT_PRESETS_FALLBACK.slice() };
    const arr = JSON.parse(stored);
    if (!Array.isArray(arr))
      return { presets: DEFAULT_PRESETS_FALLBACK.slice() };
    return { presets: arr };
  } catch (e) {
    console.error("getDefaultPresets エラー: " + e.message);
    return { presets: DEFAULT_PRESETS_FALLBACK.slice() };
  }
}

function saveDefaultPresets(presets) {
  try {
    if (!Array.isArray(presets)) {
      return { status: "Error", message: "presets は配列である必要があります" };
    }
    if (presets.length > DEFAULT_PRESETS_MAX_COUNT) {
      return {
        status: "Error",
        message:
          "プリセットは最大 " + DEFAULT_PRESETS_MAX_COUNT + " 個までです",
      };
    }
    const cleaned = [];
    for (let i = 0; i < presets.length; i++) {
      const v = presets[i];
      if (typeof v !== "string") {
        return {
          status: "Error",
          message: "プリセットは文字列である必要があります (index=" + i + ")",
        };
      }
      const trimmed = v.trim();
      if (!trimmed) continue;
      if (trimmed.length > DEFAULT_PRESETS_MAX_LEN) {
        return {
          status: "Error",
          message:
            "プリセットは " +
            DEFAULT_PRESETS_MAX_LEN +
            " 文字以内です (index=" +
            i +
            ")",
        };
      }
      cleaned.push(trimmed);
    }
    PropertiesService.getScriptProperties().setProperty(
      DEFAULT_PRESETS_KEY,
      JSON.stringify(cleaned),
    );
    return { status: "Success", presets: cleaned };
  } catch (e) {
    console.error("saveDefaultPresets エラー: " + e.message);
    try {
      notifyError("saveDefaultPresets", e.message);
    } catch (ne) {}
    return { status: "Error", message: e.message };
  }
}
