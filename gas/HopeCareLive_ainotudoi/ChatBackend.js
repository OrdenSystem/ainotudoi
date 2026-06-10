// =======================================================
// ChatBackend.gs: Chat Webアプリ用コード (完全統合版)
// =======================================================

// =======================================================
// 1. 初期状態取得（履歴分析機能を含む）
// =======================================================
function getInitialChatState(targetId) {
  const result = { userName: "", hasContext: false, history: "", presets: [], error: null };
  if (!targetId) { result.error = "利用者IDが指定されていません。"; return result; }

  try {
    const rows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, "CustomerStatus__c", `Filter(CustomerStatus__c, [Row ID] = '${targetId}')`);
    if (rows.length === 0) { result.error = "利用者が見つかりません。"; return result; }

    const user = rows[0];
    result.userName = user["CustomerName__c"];

    if (getContextFileContent(user, targetId)) {
      result.hasContext = true;
    }

    const historyText = getChatHistoryContent(user);
    if (historyText) result.history = historyText;

    result.presets = analyzeHistoryForPrompts_(historyText);

  } catch (e) {
    result.error = "エラー: " + e.message;
  }
  return result;
}

function analyzeHistoryForPrompts_(historyText) {
  if (!historyText) return [];
  try {
    const lines = historyText.split('\n');
    const frequency = {};

    lines.forEach(line => {
      let content = line.trim();
      if (content.includes("User: ")) {
        content = content.split("User: ")[1].trim();
      }
      
      if (content.startsWith('#') && content.length > 2 && content.length < 40) {
        frequency[content] = (frequency[content] || 0) + 1;
      }
    });

    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0]);

  } catch (e) {
    return [];
  }
}

// =======================================================
// 2. 職員リスト取得
// =======================================================
function getStaffList() {
  try {
    const rows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, "StaffStatus__c", "");
    return rows.map(r => ({
      id: r["Row ID"],
      name: r["NameKana__c"] || "名称不明"
    }));
  } catch (e) {
    return [];
  }
}

// =======================================================
// 3. メインチャット処理
// =======================================================
function processUserMessage(userId, userMessage, fileData) {
  try {
    if (!GEMINI_API_KEY) throw new Error("Gemini APIキー設定エラー");

    const userRows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, "CustomerStatus__c", `Filter(CustomerStatus__c, [Row ID] = '${userId}')`);
    if (!userRows || userRows.length === 0) throw new Error("利用者が特定できません");
    const user = userRows[0];

    const contextText = getContextFileContent(user, userId);
    if (!contextText) return "⚠️ データファイルがありません。AppSheetで生成してください。";
    
    const historyText = getChatHistoryContent(user);
    const reply = callGeminiApi(GEMINI_API_KEY, contextText, historyText, userMessage, fileData);

    const logMsg = fileData ? `[ファイル添付: ${fileData.name}] ${userMessage}` : userMessage;
    saveChatHistoryToDrive(user, logMsg, reply);

    return reply;

  } catch (e) {
    return "エラーが発生しました: " + e.message;
  }
}

// =======================================================
// 4. ケース記録登録 (AppSheet API)
// =======================================================
function registerCaseRecord(userId, content, staffId, consultId) {
  try {
    const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${APPSHEET_TABLE_NAME}/Action`;
    const now = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");
    
    const rowData = {
      "利用者在籍ID": userId,
      "入力内容": content,       
      "登録日時": now,
      "支援記録種別": "チャット記録",
      "記録者": staffId
    };

    if (consultId) rowData["相談記録ID"] = consultId;

    const payload = {
      "Action": "Add",
      "Properties": { "Locale": "ja-JP", "Timezone": "Tokyo Standard Time" },
      "Rows": [ rowData ]
    };

    const options = {
      "method": "post",
      "headers": { "ApplicationAccessKey": APPSHEET_API_KEY, "Content-Type": "application/json" },
      "payload": JSON.stringify(payload)
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) throw new Error(response.getContentText());
    
    return "Success";
  } catch (e) {
    throw e;
  }
}

// =======================================================
// Gemini API 関連（APIキーローテーション対応）
// =======================================================
// 第2引数 apiKey は後方互換のために残しているが、
// 実際は callGeminiWithKeyRotation_ がスクリプトプロパティから複数キーを取得して使う。
function callGeminiApi(apiKey, context, history, message, fileData) {
  const modelId = "gemini-2.5-flash";

  let promptText = "あなたは障害福祉事業所の優秀な支援アシスタントです。\n";
  promptText += "以下の「利用者データ」および「これまでの会話履歴」に基づいて、ユーザーの質問に答えてください。\n";
  promptText += "回答は支援者に向けて、客観的かつ分かりやすく、Markdown形式で見やすく整形してください。\n";
  if (fileData) promptText += "※ユーザーから画像またはPDFファイルが添付されました。その内容も踏まえて回答してください。\n";

  const contents = [];
  contents.push({
    role: "user",
    parts: [{ text: promptText }, { text: "【利用者コンテキストデータ】\n" + (context || "なし") }]
  });

  if (history) {
    contents.push({ role: "user", parts: [{ text: "【これまでの会話履歴】\n" + history }] });
  }

  const userParts = [];
  if (message) userParts.push({ text: "【今回の質問・指示】\n" + message });

  if (fileData) {
    userParts.push({
      inline_data: { mime_type: fileData.type, data: fileData.data }
    });
  }

  contents.push({ role: "user", parts: userParts });

  const payload = {
    contents: contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  };

  const result = callGeminiWithKeyRotation_(modelId, payload, { apiVersion: 'v1beta' });
  if (result && result.error) {
    return "エラー: " + result.error;
  }
  return extractGeminiText(result);
}

function extractGeminiText(json) {
  if (!json.candidates || json.candidates.length === 0) return "回答生成エラー";
  const cand = json.candidates[0];
  if (!cand.content || !cand.content.parts) return "回答生成エラー(partsなし)";
  return cand.content.parts.map(p => p.text).join("\n").trim();
}

// =======================================================
// ファイル操作・API共通系
// =======================================================
function getContextFileContent(userObj, userId) {
  const userName = userObj["CustomerName__c"] || "";
  const key = `HOPECHAT_CTX_${userId}_${userName}`;
  
  const cache = CacheService.getScriptCache();
  const cached = cache.get(key);
  if (cached) return cached;

  let combinedText = "";
  try {
    const folder = getChatPDFFolder(userObj);
    if (folder) {
      const files = folder.getFiles();
      const fileList = [];
      
      // ★修正箇所: userNameとの完全一致をやめ、「AIコンテキスト」が含まれるかだけで判定
      while (files.hasNext()) {
        const f = files.next();
        if (f.getMimeType() === MimeType.PLAIN_TEXT && f.getName().includes("AIコンテキスト")) {
          fileList.push({ name: f.getName(), content: f.getBlob().getDataAsString("UTF-8") });
        }
      }
      fileList.sort((a, b) => a.name.localeCompare(b.name));
      fileList.forEach(f => combinedText += `\n\n=== 参照: ${f.name} ===\n\n` + f.content);
    }
  } catch (e) { return null; }

  if (combinedText && combinedText.length < 90000) {
    cache.put(key, combinedText, CONTEXT_CACHE_TTL_SEC);
  }
  return combinedText || null;
}

function getChatHistoryContent(userObj) {
  return readFileFromChatPDFFolder(userObj, "_チャット履歴.txt") || "";
}

function saveChatHistoryToDrive(userObj, question, answer) {
  try {
    const folder = getChatPDFFolder(userObj);
    if (!folder) return;
    
    let file = null;
    let currentContent = "";
    const files = folder.getFiles();
    
    // 既存の履歴ファイルを探す
    while (files.hasNext()) {
      const f = files.next();
      if (f.getName().includes("チャット履歴") && f.getMimeType() === MimeType.PLAIN_TEXT) {
        file = f;
        currentContent = f.getBlob().getDataAsString("UTF-8");
        break;
      }
    }
    
    const timestamp = Utilities.formatDate(new Date(), "JST", "MM/dd HH:mm");
    const newEntry = `\n---\n[${timestamp}] User: ${question}\n[${timestamp}] AI: ${answer}\n`;
    
    if (file) {
      // 既存のファイルに追記
      file.setContent(currentContent + newEntry);
    } else {
      // なければ新規作成（ファイル名にはAppSheetの氏名を使う）
      const newFileName = `${userObj["CustomerName__c"]}_チャット履歴.txt`;
      folder.createFile(newFileName, newEntry, MimeType.PLAIN_TEXT);
    }
  } catch (e) {
    console.error("履歴保存エラー: " + e.toString());
  }
}

// =======================================================
// ChatBackend.gs の下部に上書きする関数
// =======================================================
function getChatPDFFolder(userObj) {
  let urlData = userObj["GoogleURL__c"];
  if (!urlData) return null;

  // AppSheetのHyperlink型（JSON形式）対策
  let url = "";
  try {
    if (typeof urlData === 'string' && urlData.startsWith("{")) {
      const parsed = JSON.parse(urlData);
      url = parsed.Url || urlData;
    } else {
      url = urlData;
    }
  } catch(e) {
    url = urlData;
  }

  let id = "";
  if (url) {
    const m = url.match(/id=([a-zA-Z0-9_-]+)/) || url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (m) id = m[1];
  }
  
  if (!id) return null;
  const f = DriveApp.getFolderById(id).getFoldersByName("ChatPDF");
  return f.hasNext() ? f.next() : null;
}

function readFileFromChatPDFFolder(userObj, suffix) {
  try {
    const folder = getChatPDFFolder(userObj);
    if (!folder) return null;
    
    // 完全一致ではなく「チャット履歴」という文字が含まれるテキストファイルを探す
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (file.getName().includes("チャット履歴") && file.getMimeType() === MimeType.PLAIN_TEXT) {
        return file.getBlob().getDataAsString("UTF-8");
      }
    }
    return null;
  } catch (e) { return null; }
}