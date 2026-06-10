// ==========================================
// History.gs: 不足関数の補完（履歴取得・最終登録）
// ==========================================

/**
 * 利用者の過去履歴を取得する (プレースホルダー/AppSheetから取得する想定)
 */
function getUserHistory(uid) {
  if (!uid) return "履歴なし";
  try {
    const filter = `Filter(${APPSHEET_TABLE_NAME}, [利用者在籍ID] = '${uid}')`;
    const rows = callAppSheetApi(APPSHEET_APP_ID, APPSHEET_API_KEY, APPSHEET_TABLE_NAME, filter);
    
    if (!rows || rows.length === 0) return "過去の記録はありません。";
    
    // 最新5件を簡易テキスト化して返す例
    return rows.slice(0, 5).map(r => `[${r['登録日時'] || ''}] ${r['入力内容'] || ''}`).join('\n');
  } catch(e) {
    console.error("getUserHistory Error: " + e.toString());
    return "履歴の取得に失敗しました。";
  }
}

/**
 * 音声記録の最終データをAppSheetに登録する (クリーン版)
 */
function registerFinalData(finalFactText, emotionText, startTime, appSheetIds) {
  try {
    // 1. JSON文字列のパース
    let parsedIds = appSheetIds;
    if (typeof appSheetIds === 'string') {
      try {
        parsedIds = JSON.parse(appSheetIds);
      } catch(e) {}
    }
    parsedIds = parsedIds || {};

    // 2. IDの取得
    const targetUserId = parsedIds.userId || parsedIds.riyousya || parsedIds.riyousyaId || parsedIds.uid || "";
    const targetStaffId = parsedIds.staffId || parsedIds.staff || "";
    const targetConsultId = parsedIds.consultId || parsedIds.soudan || parsedIds.soudanId || "";

    const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${APPSHEET_TABLE_NAME}/Action`;
    const now = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");
    
    // 3. 行データの作成（検証テキストを削除）
    const rowData = {
      "利用者在籍ID": targetUserId,
      "記録者": targetStaffId,
      "入力内容": finalFactText,
      "カスタムテキスト20": emotionText, 
      "支援記録種別": "ライブ音声記録",
      "登録日時": now
    };

    // 相談記録IDのセット
    if (targetConsultId) {
      rowData["相談記録ID"] = targetConsultId;
    }

    const payload = {
      "Action": "Add",
      "Properties": { "Locale": "ja-JP", "Timezone": "Tokyo Standard Time" },
      "Rows": [ rowData ]
    };

    const options = {
      method: "post",
      headers: { "ApplicationAccessKey": APPSHEET_API_KEY, "Content-Type": "application/json" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      return { success: false, error: response.getContentText() };
    }
    
    return { success: true, message: "登録完了" };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}