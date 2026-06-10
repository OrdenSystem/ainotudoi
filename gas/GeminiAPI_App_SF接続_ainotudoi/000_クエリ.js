//クエリを実行する　引数にはクエリ文字列を使用する
function doQuery(q) {
  oauth.runRefresh()
  //SOQLクエリをパラメータで送れるようにスペースを＋に変換
  var query = encodeURIComponent(q).replace(/%20/g, '+');
  var options = {
    "method" : "GET",
    "headers" : {
      "Authorization": "Bearer " + getProp("access_token")
    },
    "muteHttpExceptions" : true
  }
  var url = getProp("instance_url") + "/services/data/v51.0/query?q="+query;// SOQL クエリを実行する
  Logger.log("クエリ発行先URL");
  Logger.log(url);
  var response = UrlFetchApp.fetch(url, options);
  // セキュリティ: レスポンス本体に氏名・住所等の PII が含まれるためログ出力しない
  var responseCode = response.getResponseCode();
  try {
    var recordCount = (JSON.parse(response).records || []).length;
    Logger.log("クエリ実行結果: status=" + responseCode + " / records=" + recordCount);
  } catch (e) {
    Logger.log("クエリ実行結果: status=" + responseCode + " (parse error)");
  }
  return response
}

function assign(record1,record2) {
  if(record1.Id==record2.Id){
      Object.assign(record1,record2)
    }
}