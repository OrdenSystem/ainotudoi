// ==========================================
// Common.gs: 共通処理・汎用関数
// ==========================================

/**
 * AppSheet API 汎用呼び出し (Find Action用)
 */
function callAppSheetApi(appId, accessKey, tableName, filter) {
  const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${tableName}/Action`;
  const options = {
    method: 'post',
    headers: { 'ApplicationAccessKey': accessKey },
    contentType: 'application/json',
    payload: JSON.stringify({
      Action: "Find",
      Properties: { Locale: "ja-JP", Selector: filter },
      Rows: []
    }),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  return JSON.parse(res.getContentText());
}