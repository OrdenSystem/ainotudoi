/**
 * =================================================================================
 * Hope AI Chat 専用 Web API (受信側)
 * ファイル名: POST.gs
 * 機能: 段階的ロード（UX向上） & 統合アクション対応版
 * =================================================================================
 */

function doPost(e) {
  console.log("----- [doPost] リクエスト受信開始 -----");
  
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("POSTデータが空、または不正なアクセスです。");
    }

    const requestData = JSON.parse(e.postData.contents);
    const action = requestData.action;
    console.log(`[AIチャットルート] アクション: ${action}`);
    
    let result = {};

    // =======================================================
    // 1. 段階的ロード用（高速化の肝）
    // =======================================================
    if (action === "getBasicUserInfo") {
      // ページを開いた瞬間に呼ばれる：名前だけを最速で返す
      result = getBasicUserInfo(requestData.targetId);
    } 
    else if (action === "getHistoryPresets") {
      // 挨拶の裏で呼ばれる：重い履歴分析を行う
      result = getHistoryPresets(requestData.targetId);
    } 

    // =======================================================
    // 2. 従来のアクション（互換性維持）
    // =======================================================
    else if (action === "getInitialChatState") {
      result = getInitialChatState(requestData.targetId);
    } 
    else if (action === "getStaffList") {
      result = { staffList: getStaffList() };
    } 
    else if (action === "processUserMessage") {
      const aiReply = processUserMessage(
        requestData.userId, 
        requestData.userMessage, 
        requestData.fileData, 
        requestData.useContext, 
        requestData.frontendHistory
      );
      result = { reply: aiReply };
    } 
    else if (action === "registerCaseRecord") {
      // registerCaseRecord は直接オブジェクトを返す
      // 成功: { status: "Success", method: "JDBC"|"AppSheet", rowId?: "..." }
      // 失敗: { status: "Error", userMessage: "...", detail: "..." }
      result = registerCaseRecord(
        requestData.userId,
        requestData.content,
        requestData.staffId,
        requestData.consultId
      );
    }
    else if (action === "ping") {
      result = { status: "ok" };
    }
    else if (action === "saveDefaultPresets") {
      result = saveDefaultPresets(requestData.presets);
    }
    else if (action === "getDefaultPresets") {
      result = getDefaultPresets();
    }
    else {
      console.warn("未知のアクション:", action);
      result = { error: "Unknown action: " + action };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    // 内部詳細はサーバーログのみ。クライアントには固定文言（情報漏洩防止）
    console.error(`doPost Error: ${error.message}\nStack: ${error.stack || '(stackなし)'}`);
    try { notifyError("doPost", error.message); } catch (ne) {}
    return ContentService.createTextOutput(JSON.stringify({
      error: "サーバーエラーが発生しました。時間をおいて再度お試しください。"
    })).setMimeType(ContentService.MimeType.JSON);
  }
}