function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;
    let result = {};

    // ----------------------------------------
    // ▼ 録音アプリ (Hope Care Live Pro) 用 ▼
    // ----------------------------------------
    if (action === "getUserContext") {
      result = { text: getUserContext(postData.uid) };

    } else if (action === "getUserHistory") {
      result = { history: getUserHistory(postData.uid) };

    } else if (action === "getDeepgramToken") {
      result = getDeepgramToken(postData.payload || "");

    } else if (action === "processAudioDebug") {
      result = processAudioDebug(postData.base64Data, postData.payload);

    } else if (action === "previewSummary") {
      result = { jsonString: previewSummary(postData.rawText, postData.contextInfo, postData.staffId) };

    } else if (action === "registerFinalData") {
      result = registerFinalData(postData.finalFactText, postData.emotionText, postData.startTime, postData.appSheetIds);
    } 

    // ----------------------------------------
    // ▼ チャットアプリ (Hope AI Chat) 用 ▼
    // ----------------------------------------
    else if (action === "getInitialChatState") {
      result = getInitialChatState(postData.targetId);

    } else if (action === "getStaffList") {
      result = { staffList: getStaffList() };

    } else if (action === "processUserMessage") {
      result = { reply: processUserMessage(postData.userId, postData.userMessage, postData.fileData) };

    } else if (action === "registerCaseRecord") {
      result = { status: registerCaseRecord(postData.userId, postData.content, postData.staffId, postData.consultId) };

    } else {
      result = { error: "Unknown action: " + action };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.TEXT);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ error: error.toString() }))
      .setMimeType(ContentService.MimeType.TEXT);
  }
}