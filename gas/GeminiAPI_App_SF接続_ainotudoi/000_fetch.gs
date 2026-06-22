// ▼▼▼ 既存の関数 (fetchSF) 修正：自動更新機能付き ▼▼▼
function fetchSF(OBJECT, ID, FIELD) {
  const url =
    getProp("instance_url") +
    "/services/data/v51.0/sobjects/" +
    OBJECT +
    "/" +
    ID;
  console.log(`[fetchSF] Request URL: ${url}`);

  // リクエストオプションを準備
  let options = {
    method: "PATCH",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + getProp("access_token"),
    },
    payload: JSON.stringify(FIELD),
    muteHttpExceptions: true,
  };

  try {
    // 1回目の実行
    let response = UrlFetchApp.fetch(url, options);
    let statusCode = response.getResponseCode();
    let content = response.getContentText();

    // ★追加: 401エラー（期限切れ）ならトークンを更新して再試行
    if (statusCode === 401) {
      console.warn(
        "アクセストークンの期限切れ(401)を検知。更新して再試行します...",
      );

      const newToken = refreshAccessToken(); // トークン再取得
      if (newToken) {
        options.headers["Authorization"] = "Bearer " + newToken; // 新しいトークンセット
        response = UrlFetchApp.fetch(url, options); // 再実行
        statusCode = response.getResponseCode();
        content = response.getContentText();
      } else {
        throw new Error(
          "トークンの更新に失敗しました。OAuth設定を確認してください。",
        );
      }
    }

    console.log(`[fetchSF] Status: ${statusCode}`);

    if (statusCode >= 200 && statusCode < 300) {
      console.log("Salesforce Update Success");
    } else {
      console.error(`Salesforce Error: ${statusCode} ${content}`);
      // エラーを握りつぶさず、呼び出し元に伝える
      throw new Error(`Salesforce Error: ${statusCode} ${content}`);
    }
  } catch (error) {
    console.error("fetchSF Exception:", error);
    // 親関数でエラー判定できるように必ず throw する
    throw error;
  }
}

/**
 * トークン再取得用関数（ここも追記してください）
 */
function refreshAccessToken() {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty("client_id");
  const clientSecret = props.getProperty("client_secret");
  const refreshToken = props.getProperty("refresh_token");

  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      "エラー: OAuth設定(client_id, client_secret, refresh_token)が不足しています。",
    );
    return null;
  }

  const payload = {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  };

  const options = {
    method: "post",
    payload: payload,
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(
      "https://login.salesforce.com/services/oauth2/token",
      options,
    );
    const code = response.getResponseCode();

    if (code === 200) {
      const result = JSON.parse(response.getContentText());
      props.setProperty("access_token", result.access_token); // 新しいトークンを保存
      console.log("アクセストークンを更新しました。");
      return result.access_token;
    } else {
      console.error("トークン更新リクエスト失敗: " + response.getContentText());
      return null;
    }
  } catch (e) {
    console.error("トークン更新中に例外発生: " + e.toString());
    return null;
  }
}
