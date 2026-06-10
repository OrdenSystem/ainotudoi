//環境によって異なる
// 外部クライアントアプリ(ローカル配信)はクロス組織を避けるため My Domain を使う
const token_url = 'https://ainotsudoi-gakuen.my.salesforce.com/services/oauth2/'   //本番(My Domain)
// const token_url = 'https://login.salesforce.com/services/oauth2/'   //汎用ログイン(クロス組織で OAUTH_AUTHORIZATION_BLOCKED になるため不可)
// const token_url = "https://test.salesforce.com/services/oauth2/"      //sandbox環境用

// 認可コード取得URLを開いたときに動く処理(最初の一回だけ有効にする必要がある)
// function doGet(e) {
//   // authorize 段階で弾かれた場合、code ではなく error がクエリで返る（例: OAUTH_AUTHORIZATION_BLOCKED）
//   if (e && e.parameter && e.parameter.error) {
//     var msg = "認証エラー: " + e.parameter.error +
//               " / " + (e.parameter.error_description || "");
//     Logger.log(msg);
//     return ContentService.createTextOutput(msg);
//   }
//   if (!e || !e.parameter || !e.parameter.code) {
//     return ContentService.createTextOutput("認可コードがありません（authorize が完了していません）。");
//   }
//   var response = oauth.getAccessToken(e);
//   var status = response.getResponseCode();
//   var body = response.getContentText();
//   if (status >= 200 && status < 300) {
//     setProp(JSON.parse(body));  // 成功時のみトークンを保存
//     return ContentService.createTextOutput("認証成功: トークンを保存しました。");
//   }
//   // 失敗時: エラー JSON をプロパティに保存しない。原因切り分け用に本文を表示
//   return ContentService.createTextOutput("認証失敗 (status=" + status + "): " + body);
// }


//認証用URL作成
function tejun1(){
  oauth.getMyUrl()
}

var oauth= {
  //
  getMyUrl : function(){
    // クエリ値は encodeURIComponent でエンコード（authorize と token で redirect_uri の表現を一致させる）
    var url = token_url + "authorize?" +
    "response_type=code" + "&" +
    "client_id=" + encodeURIComponent(client_id) + "&" +
    "redirect_uri=" + encodeURIComponent(redirect_uri) + "&" +
    "state=mystate";
    Logger.log(url);
    return url;
  },

  getAccessToken : function(e){
    var code = e['parameter']['code'];
    var payload = {
      'grant_type': 'authorization_code',
      'client_id': client_id,
      'client_secret': client_secret,
      'code': code,
      'redirect_uri': redirect_uri
    }
  
    var options = {
      'method': 'post',
      'contentType': 'application/x-www-form-urlencoded',
      'payload': payload,
      'muteHttpExceptions': true  // 例外を投げず、ステータス/本文を自分で扱う
    };
    var response = UrlFetchApp.fetch(token_url + "token", options);
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      // エラー応答には access_token が含まれないため全文ログ出力して安全
      Logger.log("OAuth token 取得失敗: status=" + status + " body=" + response.getContentText());
    } else {
      // 成功時はトークンを含むためステータスのみ
      Logger.log("OAuth token 取得成功: status=" + status);
    }
    return response;
  },

  runRefresh : function(){
    var payload = {
      'grant_type': 'refresh_token',
      'refresh_token': getProp("refresh_token"),
      'client_id': client_id,
      'client_secret': client_secret
    }
    var options = {
      'method': 'post',
      'contentType': 'application/x-www-form-urlencoded',
      'payload': payload
    }
    var response = UrlFetchApp.fetch(token_url + "token", options);
    // セキュリティ: response 本体には access_token / refresh_token が含まれるためログ出力しない
    Logger.log("OAuth refresh: status=" + response.getResponseCode());
    setProp(JSON.parse(response));
  },

  //"access_token" : access_tokenをrevokeする場合
  //"refresh_token" : refresh_tokenをrevokeする場合
  revokeToken : function(){
    var url = token_url + "revoke";
    var options = {
      'method': 'get',
      'contentType': 'application/x-www-form-urlencoded',
      'payload': {
        token: getProp("access_token")
      }
    }
    var response = UrlFetchApp.fetch(url, options);
    // セキュリティ: revoke レスポンス本体は出力しない
    Logger.log("OAuth revoke: status=" + response.getResponseCode());
  }
}