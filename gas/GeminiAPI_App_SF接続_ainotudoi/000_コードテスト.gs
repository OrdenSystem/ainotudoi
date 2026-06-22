// 過去の testAppSheetConnection_Final はシークレット（AppSheet Access Key）混入のため削除。
// 必要時は git history から復元可能。AppSheet 側で Access Key のローテーションを推奨。

// 単発で関数を実行しテストするためのファイル
function queryTest() {
  let query =
    "SELECT FIELDS(ALL) FROM StaffStatus__c WHERE todayDATE__c = true LIMIT 200 OFFSET 400";
  let response = JSON.parse(doQuery(query));
  const res = response.records;
  console.log("res", res);
}

// 単発で関数を実行しテストするためのファイル
function queryTest002() {
  const Id = "a0FRB00000LDFUz2AP";

  const query = `
    SELECT FIELDS(ALL)
    FROM StaffStatus__c
    WHERE Id = '${Id}' 
    LIMIT 1
  `;

  let response = JSON.parse(doQuery(query));
  const res = response.records;
  console.log("res", res);
}

function TEXTqueryTest() {
  const Id = "a0QfB0000030ZbxUAE";
  // const DATE = '2025-05-10';  AND StartDate__c <= ${DATE}

  const query = `
    SELECT Method__c
    FROM Diary__c
    WHERE Id = '${Id}' 
    ORDER BY Date__c DESC
    LIMIT 1
  `;

  console.log("実行クエリ:", query); // クエリ文字列確認用

  try {
    const response = JSON.parse(doQuery(query));
    const res = response.records[0];
    console.log("固定情報////", res);
  } catch (e) {
    console.error("エラー:", e);
  }
}

// 単発で関数を実行しテストするためのファイル
function queryTest99() {
  const Id = "a0eGC00000pA6ZrYAK";

  const query =
    "SELECT Name, (SELECT Name, Number__c, Period__c, ProgressRecord__c FROM On1__r ORDER BY Number__c ASC) FROM FixedInformation__c WHERE Id='" +
    Id +
    "' LIMIT 1";
  const response = JSON.parse(doQuery(query));
  const res = response.records[0];
  console.log("res", res);

  // ここで最初のPeriod__cを取り出す
  let period = null;
  let period2 = null;
  if (res?.On1__r?.records?.length > 0) {
    period = res.On1__r.records[0].Number__c;
    period2 = res.On1__r.records[1].Number__c;
  }
  console.log("period : ", period);
  console.log("period2 : ", period2);
}
