//環境によって異なる
const token_url = "https://login.salesforce.com/services/oauth2/"; //本番環境用
// const token_url = "https://test.salesforce.com/services/oauth2/"      //sandbox環境用

// 認可コード取得URLを開いたときに動く処理(最初の一回だけ有効にする必要がある)
function doGet(e) {
  var response = oauth.getAccessToken(e);
  setProp(JSON.parse(response));
  return ContentService.createTextOutput(response); // ブラウザに表示する
}

//認証用URL作成
function tejun1() {
  oauth.getMyUrl();
}

var oauth = {
  //
  getMyUrl: function () {
    var url =
      token_url +
      "authorize?" +
      "response_type=code" +
      "&" +
      "client_id=" +
      client_id +
      "&" +
      "redirect_uri=" +
      redirect_uri +
      "&" +
      "state=mystate";
    Logger.log(url);
  },

  getAccessToken: function (e) {
    var code = e["parameter"]["code"];
    var payload = {
      grant_type: "authorization_code",
      client_id: client_id,
      client_secret: client_secret,
      code: code,
      redirect_uri: redirect_uri,
    };

    var options = {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: payload,
    };
    var response = UrlFetchApp.fetch(token_url + "token", options);
    return response;
  },

  runRefresh: function () {
    var payload = {
      grant_type: "refresh_token",
      refresh_token: getProp("refresh_token"),
      client_id: client_id,
      client_secret: client_secret,
    };
    var options = {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: payload,
    };
    var response = UrlFetchApp.fetch(token_url + "token", options);
    // セキュリティ: response 本体には access_token / refresh_token が含まれるためログ出力しない
    Logger.log("OAuth refresh: status=" + response.getResponseCode());
    setProp(JSON.parse(response));
  },

  //"access_token" : access_tokenをrevokeする場合
  //"refresh_token" : refresh_tokenをrevokeする場合
  revokeToken: function () {
    var url = token_url + "revoke";
    var options = {
      method: "get",
      contentType: "application/x-www-form-urlencoded",
      payload: {
        token: getProp("access_token"),
      },
    };
    var response = UrlFetchApp.fetch(url, options);
    // セキュリティ: revoke レスポンス本体は出力しない
    Logger.log("OAuth revoke: status=" + response.getResponseCode());
  },
};
