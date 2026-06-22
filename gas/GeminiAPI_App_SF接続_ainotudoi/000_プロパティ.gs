// スクリプトプロパティサービスを取得
const scriptProperties = PropertiesService.getScriptProperties();

// プロパティから client_id と client_secret と redirect_uriを読み込む
const client_id = scriptProperties.getProperty("client_id"); //Saleseforceコンシューマー鍵
const client_secret = scriptProperties.getProperty("client_secret"); //Saleseforceコンシューマー秘密の値
const redirect_uri = scriptProperties.getProperty("redirect_uri"); //デプロイ毎に異なる  Webアプリとして公開したURL

// スクリプトのプロパティの値を取得する
//引数はキーを使用する
function getProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

// スクリプトのプロパティに値を保存する
//引数にはJSONをparseしたものを使用する
function setProp(jobj) {
  PropertiesService.getScriptProperties().setProperties(jobj);
}
