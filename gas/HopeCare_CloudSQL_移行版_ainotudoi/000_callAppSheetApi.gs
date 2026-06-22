/**
 * AppSheet APIを呼び出す共通関数
 * ★429エラー（Too Many Requests）発生時の自動リトライ機能付き
 */
function callAppSheetApi(appId, apiKey, tableName, selector) {
  const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${encodeURIComponent(tableName)}/Action`;
  const options = {
    method: "post",
    headers: {
      ApplicationAccessKey: apiKey,
      "Content-Type": "application/json",
    },
    payload: JSON.stringify({
      Action: "Find",
      Properties: {
        Locale: "ja-JP",
        Timezone: "Tokyo Standard Time",
        Selector: selector,
      },
      Rows: [],
    }),
    muteHttpExceptions: true, // エラー時もスクリプトを止めずにレスポンスを受け取る
  };

  const MAX_RETRIES = 5; // 最大リトライ回数（3→5に強化）

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();

    if (code === 200) {
      // 成功時: データを返して終了
      return JSON.parse(res.getContentText()) || [];
    } else if (code === 429) {
      // 429エラー (Too Many Requests) の場合
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `API Error (${tableName}): 429エラーが続き、リトライ上限に達しました。`,
        );
      }

      // 待機時間を徐々に長くする (3秒 → 6秒 → 12秒 → 24秒 → 48秒)
      const waitTime = Math.pow(2, attempt) * 3000;
      Logger.log(
        `⚠️ AppSheet API制限(429): ${tableName} への通信を ${waitTime / 1000}秒待機して再試行します (${attempt + 1}/${MAX_RETRIES})`,
      );
      Utilities.sleep(waitTime);
    } else {
      // 429以外のエラー (400や500など、待って解決しない致命的エラー)
      throw new Error(
        `API Error (${tableName}): HTTP ${code} - ${res.getContentText()}`,
      );
    }
  }
}
