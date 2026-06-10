// ==========================================
// Code.gs: Gemini 2.5 併用 + Deepgram Hybrid (録音アプリ用)
// ==========================================

/**
 * 1. 利用者のGoogleドライブから「AIコンテキスト_最新」を取得
 */
// =======================================================
// Code.gs の一番上にある関数を上書き
// =======================================================
function getUserContext(riyousyaId) {
  try {
    if (!riyousyaId) return "";
    
    const filter = `Filter(CustomerStatus__c, [Row ID] = '${riyousyaId}')`;
    const rows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, "CustomerStatus__c", filter);
    
    if (!rows || rows.length === 0 || !rows[0]["GoogleURL__c"]) return "";
    
    // AppSheetのHyperlink型（JSON形式）対策
    let urlData = rows[0]["GoogleURL__c"];
    let url = "";
    try {
      if (typeof urlData === 'string' && urlData.startsWith("{")) {
        url = JSON.parse(urlData).Url || urlData;
      } else {
        url = urlData;
      }
    } catch(e) { url = urlData; }
    
    const match = url.match(/[-\w]{25,}/);
    if (!match) return "";
    
    const parentFolder = DriveApp.getFolderById(match[0]);
    const chatPdfFolders = parentFolder.getFoldersByName("ChatPDF");
    if (!chatPdfFolders.hasNext()) return "";
    
    const targetFolder = chatPdfFolders.next();
    const files = targetFolder.getFiles();
    let targetContent = "";
    
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      
      // 氏名のスペース問題対策：「AIコンテキスト」と「最新」が含まれていればOKとする
      if (fileName.includes("AIコンテキスト") && fileName.includes("最新") && file.getMimeType() === MimeType.PLAIN_TEXT) {
        targetContent = file.getBlob().getDataAsString("UTF-8");
        break; 
      }
    }
    return targetContent;

  } catch (e) {
    console.error("getUserContext Error: " + e.toString());
    return "背景情報の読み込みに失敗しました。";
  }
}

/**
 * Deepgramによる高速文字起こし
 */
/**
 * Deepgramによる高速文字起こし（氏名・固有名詞ピンポイント抽出＆URL長エラー対策版）
 */
function processAudioDebug(base64Data, contextPayload) {
  const props = PropertiesService.getScriptProperties();
  const DEEPGRAM_API_KEY = props.getProperty('DEEPGRAM_API_KEY');
  if (!DEEPGRAM_API_KEY) return { httpCode: 500, error: "DEEPGRAM_API_KEY未設定" };

  // Payload: "利用者名|コンテキスト全文"
  const parts = contextPayload ? contextPayload.split('|') : [];
  const userName = parts[0] || "";
  const rawContext = parts[1] || "";

  let keywordsArray = [];
  
  // 1. 利用者名は最優先で追加
  if (userName) {
    // 例: "湖東  地域" -> スペースを消して "湖東地域" にして追加
    keywordsArray.push(`${userName.replace(/\s+/g, '')}:3`); 
  }

  // 2. コンテキストから職員名などの固有名詞を抽出
  if (rawContext) {
    // ★ポイント1：履歴ブロック以降の長文は全てカットし、前半のマスタ部分だけを対象にする
    let headerContext = rawContext;
    const historyIndex = rawContext.indexOf("<<<HISTORY_BLOCK:START>>>");
    if (historyIndex !== -1) {
      headerContext = rawContext.substring(0, historyIndex);
    }

    // ★ポイント2：氏名部分（"氏名: 〇〇 〇〇_よみ" の形）から名前だけを綺麗に抜き出す
    // 例："氏名: 吉川 知則_よしかわ とものり" -> "吉川知則" と "よしかわとものり" を抽出
    const nameRegex = /氏名:\s*([^_,\n]+)(?:_([^\n,]+))?/g;
    let match;
    while ((match = nameRegex.exec(headerContext)) !== null) {
      if (match[1]) {
        // 漢字の名前（スペースを詰める）
        const kanjiName = match[1].replace(/\s+/g, '').trim();
        if (kanjiName && kanjiName.length >= 2) keywordsArray.push(`${kanjiName}:2`);
      }
      if (match[2]) {
        // フリガナ（スペースを詰める）
        const kanaName = match[2].replace(/\s+/g, '').trim();
        if (kanaName && kanaName.length >= 2) keywordsArray.push(`${kanaName}:2`);
      }
    }
    
    // 事業所名なども拾いたい場合は、必要に応じて正規表現を追加できます
  }

  // 重複を削除
  keywordsArray = [...new Set(keywordsArray)];

  // ★ポイント3：安全装置（URL長エラー防止）
  // 抽出したキーワードをカンマ区切りにしてエンコードし、長すぎる場合は切り詰める
  let keywordsStr = keywordsArray.join(",");
  let encodedKeywords = encodeURIComponent(keywordsStr);
  
  // URLの上限（通常約2000文字）を考慮し、エンコード後の文字列が1000文字を超えたら
  // 強制的に利用者名だけに絞る（クラッシュ防止の最終防波堤）
  if (encodedKeywords.length > 1000) {
    encodedKeywords = encodeURIComponent(userName ? `${userName.replace(/\s+/g, '')}:3` : "");
  }

  let dgUrl = 'https://api.deepgram.com/v1/listen?model=nova-3&language=ja&smart_format=true&punctuate=true&filler_words=false';
  if (encodedKeywords) {
    dgUrl += `&keywords=${encodedKeywords}`;
  }

  try {
    const audioData = Utilities.base64Decode(base64Data);
    const options = {
      method: 'post',
      headers: { 
        'Authorization': 'Token ' + DEEPGRAM_API_KEY, 
        'Content-Type': 'audio/webm' 
      },
      payload: audioData,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(dgUrl, options);
    const resCode = response.getResponseCode();
    const json = JSON.parse(response.getContentText());

    if (resCode !== 200) {
      console.error("Deepgram Error:", json);
      return { httpCode: resCode, text: "", error: json };
    }

    const transcript = json.results?.channels[0]?.alternatives[0]?.transcript || "";

    return {
      httpCode: 200,
      text: transcript,
      error: null
    };
  } catch (e) {
    console.error("Audio Processing Exception:", e.toString());
    return { httpCode: 500, text: "", error: e.toString() };
  }
}



/**
 * フロントエンドからの要約リクエスト（プレビュー用）
 */
function previewSummary(rawText, contextInfo, staffId) {
  if (!rawText || rawText.length < 10) return rawText;
  return summarizeTextWithGemini(rawText, contextInfo, staffId);
}

/**
 * Gemini 2.5 (Pro/Flash) 要約処理
 */
function summarizeTextWithGemini(rawText, contextInfo, staffId) {
  if (!rawText || rawText.trim() === "") {
    return JSON.stringify({
      fact: "（音声テキストが空のため、記録できませんでした）",
      emotion: "（なし）"
    });
  }

  let staffName = "担当職員";
  if (staffId && contextInfo) {
    const regex = new RegExp(`- ID: ${staffId}, 氏名: ([^_\\n,]+)`);
    const match = contextInfo.match(regex);
    if (match && match[1]) {
      staffName = match[1].trim();
    }
  }

  const useProModel = rawText.length > 3500;
  const MODEL_NAME = useProModel ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `あなたは介護記録の作成支援AIです。
以下の【対象テキスト】を分析し、**「客観的な事実記録」**と**「情意・温度感の補足」**の2つに分けて整理してください。

【使用モデル】
${useProModel ? 'Proモデル使用中。深い文脈理解を行ってください。' : 'Flashモデル使用中。'}

【前提情報】
・担当職員名: ${staffName}
・利用者コンテキスト: ${contextInfo ? 'あり' : 'なし'}
--------------------------------------------------
${contextInfo || '(コンテキスト情報なし)'}
--------------------------------------------------

【対象テキスト】
${rawText}

【出力フォーマット】
以下のJSON形式のみを出力してください。Markdown記法は不要です。
{
  "fact": "事実に即した支援記録（会話形式または記述形式）。4500文字以内。創作厳禁。",
  "emotion": "利用者の感情の揺れ、声のトーン、支援員（職員や家族、関係者など）の関わり方のニュアンス、変化の兆しなどの補足。3000文字以内。"
}

【作成ルール】
1. **fact（事実）への指示**:
   - **役割: 冷徹な記録係**
   - 誰が何をしたか、客観的事実のみを淡々と記述してください。
   - 主語には「${staffName}」を使用してください。絶対に「${staffId}」というID文字列は出力しないでください。
   - 感情的な修飾語は極力排除し、公的な記録として通用する文体にしてください。
   - 創作（ハルシネーション）は厳禁です。

2. **emotion（情意・補足）への指示**:
   - **役割: 共感力の高い心理分析官**
   - 事実記録ではこぼれ落ちてしまう**「心の機微」「行間」「非言語情報」**を言語化してください。
   - 単に「〜という様子」だけでなく、「〜という発言には、〇〇への不安が滲んでいた」「${staffName}の励ましに対し、安堵したように声色が明るくなった」など、文脈から読み取れる温度感を具体的に描写してください。
   - 3000文字以内に収めてください。

3. **共通**:
   - 整理されたテキストのみを出力してください。
   - テキストにない事実は書かない（ハルシネーション厳禁）。`;

  try {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { 
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    };
    
    const response = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    
    const json = JSON.parse(response.getContentText());
    
    if (json.candidates && json.candidates[0].content) {
      let resultText = json.candidates[0].content.parts[0].text.trim();
      const firstBrace = resultText.indexOf('{');
      const lastBrace = resultText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        resultText = resultText.substring(firstBrace, lastBrace + 1);
      }
      
      try {
        JSON.parse(resultText); 
        return resultText;      
      } catch (e) {
        throw new Error("AIの応答が正しいJSON形式ではありませんでした");
      }
    } else {
      return JSON.stringify({ fact: rawText, emotion: "（AIモデルエラー）" });
    }
  } catch (e) {
    return JSON.stringify({ fact: rawText, emotion: "（処理エラー: " + e.message + "）" });
  }
}

function debugAppSheetHistory() {
  const filter = `Filter(${APPSHEET_TABLE_NAME}, [支援記録種別] = 'ライブ音声記録')`;
  const result = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, APPSHEET_TABLE_NAME, filter);

  if (result && result.length > 0) {
    console.log("=== 取得データ(1件目)のキー一覧 ===");
    console.log(Object.keys(result[0]));
    console.log("=== データの中身 ===");
    console.log(result[0]);
  } else {
    console.log("データが見つかりませんでした。");
  }
}

/**
 * Deepgramトークン発行（WebSocket接続用）
 * ブラウザから直接Deepgramに接続するための短期トークンとキーワードを返す
 */
function getDeepgramToken(contextPayload) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('DEEPGRAM_API_KEY');
  if (!apiKey) return { error: "DEEPGRAM_API_KEY未設定" };

  // キーワード抽出（既存のprocessAudioDebugと同じロジック）
  let keywords = [];
  if (contextPayload) {
    const parts = contextPayload.split('|');
    const userName = parts[0] || "";
    const rawContext = parts[1] || "";
    if (userName) keywords.push(userName.replace(/\s+/g, '') + ':3');
    if (rawContext) {
      let headerContext = rawContext;
      const historyIndex = rawContext.indexOf("<<<HISTORY_BLOCK:START>>>");
      if (historyIndex !== -1) headerContext = rawContext.substring(0, historyIndex);
      const nameRegex = /氏名:\s*([^_,\n]+)(?:_([^\n,]+))?/g;
      let match;
      while ((match = nameRegex.exec(headerContext)) !== null) {
        if (match[1]) { const n = match[1].replace(/\s+/g, '').trim(); if (n.length >= 2) keywords.push(n + ':2'); }
        if (match[2]) { const n = match[2].replace(/\s+/g, '').trim(); if (n.length >= 2) keywords.push(n + ':2'); }
      }
    }
    keywords = [...new Set(keywords)];
  }

  // APIキーをそのまま返す（Sec-WebSocket-Protocol でブラウザ認証に使用）
  return { token: apiKey, keywords: keywords };
}