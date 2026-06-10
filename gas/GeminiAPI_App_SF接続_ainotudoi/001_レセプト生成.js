// ==========================================
// 共通設定：タスク管理用スプレッドシート情報
// Script Property "SEIKYU_TASK_SS_ID" から取得（000_AppConfig.js 参照）
// ==========================================
const TASK_SS_ID = getConfigId_('SEIKYU_TASK_SS_ID');
const TASK_SHEET_NAME = "請求処理タスク";

function initTaskSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    const headers = ["タスクID", "ステータス", "受付日時", "完了日時", "請求情報ID", "引数データ", "結果URL", "ログ"];
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange("1:1").setBackground("#e0e0e0").setFontWeight("bold");
  }
}

// ==========================================
// 1. AppSheetから直接呼ばれる「受付用関数」
// AppSheetの設定は「makeRecept」のままでOKです。
// ==========================================
function makeRecept(seikyuID, appSSdbURL, category, fileName, SSsourceURL, SSdbURL, SSdbSheetName, ToFolderURL, officeFolderName, TargetRows, ReSeikyu, TargetCustomerList, TargetNameList, TargetNameKanaList, TargetNumberList, TargetCityNameList, TargetKeyNameList, TargetKeyNameKanaList, TargetUpperPriceList) {
  const args = {
    seikyuID, appSSdbURL, category, fileName, SSsourceURL, SSdbURL, SSdbSheetName, ToFolderURL, officeFolderName, TargetRows, ReSeikyu, TargetCustomerList, TargetNameList, TargetNameKanaList, TargetNumberList, TargetCityNameList, TargetKeyNameList, TargetKeyNameKanaList, TargetUpperPriceList
  };
  
  const executionId = Utilities.getUuid();
  const timestamp = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");

  const ss = SpreadsheetApp.openById(TASK_SS_ID);
  let sheet = ss.getSheetByName(TASK_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(TASK_SHEET_NAME);
  initTaskSheet(sheet);

  // キューに待機中として追加
  sheet.appendRow([executionId, "待機中", timestamp, "", seikyuID, JSON.stringify(args), "", ""]);

  // 1秒後にバックグラウンド処理を起動
  ScriptApp.newTrigger("makeReceptBackground").timeBased().after(1000).create();

  // ★AppSheetには即座に以下の一次結果を返す（これでAppSheetの処理結果に追記されます）
  return {
    url: "", 
    log: "\n/非同期処理中・・・"
  };
}

// ==========================================
// 2. バックグラウンド処理（ロック極小化・シート判定版）
// ==========================================
function makeReceptBackground() {
  console.log("1. バックグラウンド処理開始");
  cleanUpTriggers();

  const ss = SpreadsheetApp.openById(TASK_SS_ID);
  const sheet = ss.getSheetByName(TASK_SHEET_NAME);
  if (!sheet) return;

  // ★変更1: ロックの取得は「タスクを探す数秒間」だけに限定する
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) { 
    console.warn("⚠️システムの一時ロックが取得できませんでした。1分後に再試行します。");
    ScriptApp.newTrigger("makeReceptBackground").timeBased().after(60000).create();
    return;
  }

  let targetRowIndex = -1;
  let taskData = null;

  try {
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      console.log("処理対象なし。終了します。");
      return;
    }

    // ★変更2: 目に見える「スプレッドシートの文字」で他の処理が実行中か判断する
    const isRunning = data.some(row => row[1] === "実行中");
    if (isRunning) {
      console.log("⏳ 現在、別のタスクが『実行中』です。順番待ちのため1分後に再チェックします。");
      ScriptApp.newTrigger("makeReceptBackground").timeBased().after(60000).create();
      return; // ※ここで終わっても、下のfinallyで必ずロックは解除される
    }

    // 「待機中」を探す
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === "待機中") {
        targetRowIndex = i + 1;
        taskData = data[i];
        console.log(`💡対象タスク発見: 行番号 ${targetRowIndex}, 請求情報ID: ${taskData[4]}`);
        break;
      }
    }

    if (targetRowIndex === -1) {
      console.log("待機中のタスクなし。終了します。");
      return;
    }

    // 他の処理が触れないように即「実行中」へ変更
    sheet.getRange(targetRowIndex, 2).setValue("実行中");

  } finally {
    // ★超重要: タスクを確保したら、メイン処理に入る前に絶対にロックを手放す！
    lock.releaseLock(); 
  }

  // ===== ここから下はロックから解放されて伸び伸び処理します =====
  const p = JSON.parse(taskData[5]);

  console.log("⏳ メイン処理（executeMakeRecept）実行中...");
  let result;
  try {
    result = executeMakeRecept(p.seikyuID, p.appSSdbURL, p.category, p.fileName, p.SSsourceURL, p.SSdbURL, p.SSdbSheetName, p.ToFolderURL, p.officeFolderName, p.TargetRows, p.ReSeikyu, p.TargetCustomerList, p.TargetNameList, p.TargetNameKanaList, p.TargetNumberList, p.TargetCityNameList, p.TargetKeyNameList, p.TargetKeyNameKanaList, p.TargetUpperPriceList);
    
    if (result.url === "ERROR") {
      sendSlackNotification(`【レセプト生成エラー】請求情報ID: ${p.seikyuID}\n${result.log}`);
    }
  } catch(e) {
    result = { url: "ERROR", log: "システムエラー: " + e.message };
    sendSlackNotification(`【レセプト生成システム致命的エラー】請求情報ID: ${p.seikyuID}\n詳細: ${e.message}`);
  }

  console.log("✅ メイン処理完了。ステータスを『完遂』に更新します。");
  const endTime = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");
  sheet.getRange(targetRowIndex, 2).setValue("完遂");
  sheet.getRange(targetRowIndex, 4).setValue(endTime);
  sheet.getRange(targetRowIndex, 7).setValue(result.url);
  sheet.getRange(targetRowIndex, 8).setValue(result.log);

  console.log("🔄 AppSheetへAPI書き戻し実行...");
  // エラー時はAppSheetのFile列がエラーにならないようURLを空にする
  const safeUrl = result.url === "ERROR" ? "" : result.url;
  updateAppSheetRecord(p.seikyuID, safeUrl, result.log);

  // 残りの「待機中」タスクのために連鎖トリガーをセット
  ScriptApp.newTrigger("makeReceptBackground").timeBased().after(1000).create();
}


// ==========================================
// トリガーのお掃除関数
// ==========================================
function cleanUpTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === "makeReceptBackground") {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ==========================================
// 3. AppSheet API 書き戻し関数（Slack通知追加版）
// ==========================================
function updateAppSheetRecord(seikyuID, fileUrl, logText) {
  const props = PropertiesService.getScriptProperties();
  const APP_ID = props.getProperty("APPSHEET_APP_ID_請求app"); 
  const ACCESS_KEY = props.getProperty("APPSHEET_API_KEY_請求app");
  const TABLE_NAME = props.getProperty("APPSHEET_TABLE_NAME_請求app");
  
  if (!APP_ID || !ACCESS_KEY || !TABLE_NAME) {
    const errMsg = "AppSheet APIの設定値がプロパティストアに見つかりません。";
    console.error(`【エラー】${errMsg}`);
    sendSlackNotification(`【AppSheet API設定エラー】請求情報ID: ${seikyuID}\n詳細: ${errMsg}`);
    return;
  }
  
  const url = `https://www.appsheet.com/api/v2/apps/${APP_ID}/tables/${encodeURIComponent(TABLE_NAME)}/Action`;

  const payload = {
    "Action": "Edit",
    "Properties": { "Locale": "ja-JP", "Timezone": "Tokyo Standard Time" },
    "Rows": [
      {
        "請求情報ID": seikyuID, 
        "File": fileUrl,
        "処理結果": logText
      }
    ]
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "headers": { "ApplicationAccessKey": ACCESS_KEY },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode >= 200 && responseCode < 300) {
      console.log("AppSheet API書き戻し成功");
    } else {
      const errMsg = response.getContentText();
      console.error("AppSheet API失敗: " + errMsg);
      // ★追加: APIからエラーレスポンスが返ってきた場合のSlack通知
      sendSlackNotification(`【AppSheet API書き戻し失敗】請求情報ID: ${seikyuID}\nStatus: ${responseCode}\n詳細: ${errMsg}`);
    }
  } catch (e) {
    console.error("AppSheet API通信エラー: " + e.message);
    // ★追加: API通信自体が失敗した場合のSlack通知
    sendSlackNotification(`【AppSheet API通信致命的エラー】請求情報ID: ${seikyuID}\n詳細: ${e.message}`);
  }
}


// =========================================================================
// 4. メイン処理（元のmakeReceptロジックを100%そのまま使用し、名前だけ変更）
// =========================================================================
function executeMakeRecept( 
  seikyuID, appSSdbURL, category, fileName, 
  SSsourceURL, SSdbURL, SSdbSheetName, ToFolderURL, officeFolderName, TargetRows, ReSeikyu, 
  TargetCustomerList, TargetNameList, 
  TargetNameKanaList, TargetNumberList, TargetCityNameList, 
  TargetKeyNameList, TargetKeyNameKanaList, TargetUpperPriceList
  ) {

  let executionLogs = [];
  const log = (msg) => {
    const timestamp = Utilities.formatDate(new Date(), "JST", "HH:mm:ss");
    executionLogs.push(`[${timestamp}] ${msg}`);
    console.log(`[${timestamp}] ${msg}`);
  };

  const toHalfWidth = (str) => {
    return String(str).replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).trim();
  };

  log("--- 処理開始（未登録検知・曜日関数注入版） ---");
  
  let countKihon = 0;
  let countKasan = 0;
  
  try {
    const parse = (v) => v ? String(v).split(",").map(s => s.trim()) : [];
    const names = parse(TargetNameList);       
    const kanas = parse(TargetNameKanaList);   
    const nums = parse(TargetNumberList);
    const cities = parse(TargetCityNameList);
    const ups = parse(TargetUpperPriceList);
    const knms = parse(TargetKeyNameList);     
    const kkns = parse(TargetKeyNameKanaList); 
    const userIDs = parse(TargetCustomerList);

    let unregisteredWarnings = [];

    const users = names.map((name, i) => {
      let missingItems = [];
      if (nums[i] === "未登録") missingItems.push("受給者証番号");
      if (cities[i] === "未登録") missingItems.push("市町村");
      
      if (category === "障害児相談支援") {
        if (knms[i] === "未登録") missingItems.push("保護者氏名");
        if (kkns[i] === "未登録") missingItems.push("保護者カナ");
      }
      
      if (missingItems.length > 0) {
        unregisteredWarnings.push(`${name || "氏名不明"} (${missingItems.join(", ")})`);
      }

      return {
        id: userIDs[i],
        name: name,
        kana: kanas[i] || "",
        num: nums[i] || "",
        city: cities[i] || "",
        up: ups[i] || "",
        kName: knms[i] || "", 
        kKana: kkns[i] || "", 
        kasanMap: {},
        dailies: [],    
        limits: []      
      };
    });

    const appDB = SpreadsheetApp.openByUrl(appSSdbURL);
    const ssDbSheet = SpreadsheetApp.openByUrl(SSdbURL).getSheetByName(SSdbSheetName);
    const ssDbData = ssDbSheet.getDataRange().getValues();
    const ssDbHeader = ssDbData[0];
    const targetIds = Array.isArray(TargetRows) ? TargetRows.map(String) : String(TargetRows).split(",").map(s => s.trim());

    const cityDbSheet = appDB.getSheetByName("市町村情報DB");
    const dbExistingCities = new Set();
    cityDbSheet.getDataRange().getValues().slice(1).forEach(r => {
      if (String(r[1]) === String(seikyuID)) dbExistingCities.add(String(r[4]).trim());
    });

    const userBaseDbSheet = appDB.getSheetByName("利用者情報基本項目DB");
    const dbExistingUsers = new Set();
    userBaseDbSheet.getDataRange().getValues().slice(1).forEach(r => {
      if (String(r[1]) === String(seikyuID)) {
        const uKubun = String(r[8] || "").trim(); 
        dbExistingUsers.add(String(r[2]).trim() + "_" + String(r[6]).trim() + "_" + String(r[7]).trim() + "_" + uKubun);
      }
    });

    const limitDbSheet = appDB.getSheetByName("上限額管理状況DB");
    const limitMap = {};
    if (limitDbSheet) {
      const limitData = limitDbSheet.getDataRange().getValues();
      limitData.slice(1).forEach(r => {
        if (String(r[1]) === String(seikyuID)) {
          const uID = String(r[2]).trim();
          if (!limitMap[uID]) limitMap[uID] = [];
          limitMap[uID].push({ name: r[5], num: r[6], cost: r[7], burden: r[8] });
        }
      });
    }

    const cityWriteRows = [];
    const userWriteRows = [];
    const cityDataMap = new Map(); 
    const processedInLoop = new Set();

    const hIdx = {
      id: 0, city: ssDbHeader.indexOf("市町村"), cityNum: ssDbHeader.indexOf("市町村番号"),
      ym: ssDbHeader.indexOf("年月"), cat: ssDbHeader.indexOf("事業区分"),
      uid: ssDbHeader.indexOf("利用者在籍ID"), day: ssDbHeader.indexOf("日"),
      kihon: ssDbHeader.indexOf("基本報酬"), kasan: ssDbHeader.indexOf("加算"),
      kubun: ssDbHeader.indexOf("区分選択肢"),
      cost1: ssDbHeader.indexOf("実費1"), 
      cost2: ssDbHeader.indexOf("実費2")
    };

    ssDbData.slice(1).forEach(row => {
      if (targetIds.indexOf(String(row[hIdx.id])) !== -1) {
        const cName = String(row[hIdx.city] || "").trim();
        const cNum = String(row[hIdx.cityNum] || "").trim();
        const uID = String(row[hIdx.uid] || "").trim();
        const day = String(row[hIdx.day] || "").trim();
        const kihon = toHalfWidth(row[hIdx.kihon] || "");
        const kasan = String(row[hIdx.kasan] || "").trim();
        const kubun = String(row[hIdx.kubun] || "").trim();
        const ymCat = String(row[hIdx.ym]).replace(/年|月/g, "") + "_" + row[hIdx.cat];

        if (kihon !== "") countKihon++;
        if (kasan !== "") countKasan++;

        const cost1 = hIdx.cost1 !== -1 ? String(row[hIdx.cost1] || "").trim() : "";
        const cost2 = hIdx.cost2 !== -1 ? String(row[hIdx.cost2] || "").trim() : "";

        if (cName !== "" && cName !== "未登録") {
          if (!cityDataMap.has(cName)) cityDataMap.set(cName, { name: cName, num: cNum });
          if (!dbExistingCities.has(cName) && !processedInLoop.has(cName)) {
            cityWriteRows.push([generateRandomId(16), seikyuID, category, ymCat, cName, cNum]);
            processedInLoop.add(cName);
          }
        }

        if (uID !== "") {
          const targetUser = users.find(u => u.id === uID);
          if (targetUser) {
            if ((kihon !== "" || kasan !== "")) {
              const key = uID + "_" + kihon + "_" + kasan + "_" + kubun;
              if (!dbExistingUsers.has(key)) {
                userWriteRows.push([generateRandomId(16), seikyuID, uID, category, ymCat, day, kihon, kasan, kubun]);
                dbExistingUsers.add(key);
              }
            }
            if (kasan !== "") {
              targetUser.kasanMap[kasan] = kubun; 
            }
            
            if (kihon !== "") {
              let emptyIdx = targetUser.dailies.findIndex(d => d.day === day && d.kihon === "");
              if (emptyIdx !== -1) {
                targetUser.dailies[emptyIdx].kihon = kihon;
                if (cost1 !== "" && targetUser.dailies[emptyIdx].cost1 === "") targetUser.dailies[emptyIdx].cost1 = cost1;
                if (cost2 !== "" && targetUser.dailies[emptyIdx].cost2 === "") targetUser.dailies[emptyIdx].cost2 = cost2;
              } else {
                if (!targetUser.dailies.some(d => d.day === day && d.kihon === kihon)) {
                  targetUser.dailies.push({ day: day, kihon: kihon, cost1: cost1, cost2: cost2 });
                }
              }
            } else if (kasan !== "") {
              let existing = targetUser.dailies.find(d => d.day === day);
              if (!existing) {
                targetUser.dailies.push({ day: day, kihon: "", cost1: cost1, cost2: cost2 });
              } else {
                if (cost1 !== "" && existing.cost1 === "") existing.cost1 = cost1;
                if (cost2 !== "" && existing.cost2 === "") existing.cost2 = cost2;
              }
            }

            if (targetUser.limits.length === 0 && limitMap[uID]) {
              targetUser.limits = limitMap[uID];
            }
          }
        }
      }
    });

    users.forEach(user => {
      const hasKihon = user.dailies.some(d => d.kihon !== "");
      if (hasKihon) {
        user.dailies = user.dailies.filter(d => d.kihon !== "");
      }
    });

    if (cityWriteRows.length > 0) cityDbSheet.getRange(cityDbSheet.getLastRow() + 1, 1, cityWriteRows.length, cityWriteRows[0].length).setValues(cityWriteRows);
    if (userWriteRows.length > 0) userBaseDbSheet.getRange(userBaseDbSheet.getLastRow() + 1, 1, userWriteRows.length, userWriteRows[0].length).setValues(userWriteRows);
    
    const cityDataList = Array.from(cityDataMap.values());
    log("データ準備完了");

    const parentFolder = DriveApp.getFolderById(extractIdFromUrl(ToFolderURL));
    const officeFolder = getOrCreateFolder(parentFolder, officeFolderName);
    const sourceFile = DriveApp.getFileById(extractIdFromUrl(SSsourceURL));
    
    const newFile = sourceFile.makeCopy(fileName, officeFolder);
    SpreadsheetApp.flush(); // ★追加: Googleサーバーにファイル作成を確約させる
    Utilities.sleep(3000);  // ★追加: 3秒待機してファイルを安定させる
    const newSS = SpreadsheetApp.openById(newFile.getId());
    
    const targetSheet = newSS.getSheetByName(category);

    if (!targetSheet) throw new Error("シート「" + category + "」無し");
    newSS.getSheets().forEach(s => { if (s.getName() !== category && newSS.getSheets().length > 1) newSS.deleteSheet(s); });

    const allValues = targetSheet.getDataRange().getValues(); 
    const billingDbSheet = appDB.getSheetByName("請求情報DB");
    if (billingDbSheet) {
      const bData = billingDbSheet.getDataRange().getValues();
      const bRow = bData.find(r => String(r[0]) === String(seikyuID));
      if (bRow) {
        allValues.forEach((r, i) => {
          const idx = bData[0].indexOf(String(r[0]).trim());
          if (idx !== -1) targetSheet.getRange(i + 1, 2).setValue(bRow[idx]);
        });
      }
    }
    const kasanDbSheet = appDB.getSheetByName("事業所加算項目DB");
    if (kasanDbSheet) {
      const kData = kasanDbSheet.getDataRange().getValues();
      kData.filter(r => String(r[1]) === String(seikyuID)).forEach(kr => {
        const rIdx = allValues.findIndex(r => String(r[0]).trim() === String(kr[4]).trim());
        if (rIdx !== -1) targetSheet.getRange(rIdx + 1, 2).setValue(kr[5]);
      });
    }

    let currentA = targetSheet.getRange("A:A").getValues(); 
    let cityRowIdx = currentA.findIndex(r => String(r[0]).trim() === "市町村") + 1;

    if (cityRowIdx > 0 && cityDataList.length > 0) {
      const cityBlockSize = 4;
      if (cityDataList.length > 1) {
        const insertPosition = cityRowIdx + cityBlockSize - 1; 
        targetSheet.insertRowsAfter(insertPosition, (cityDataList.length - 1) * cityBlockSize);
        const source = targetSheet.getRange(cityRowIdx, 1, cityBlockSize, targetSheet.getLastColumn());
        for (let i = 1; i < cityDataList.length; i++) {
          source.copyTo(targetSheet.getRange(cityRowIdx + (i * cityBlockSize), 1));
        }
      }
      
      cityDataList.forEach((data, i) => {
        const base = i * cityBlockSize;
        targetSheet.getRange(cityRowIdx + base, 2).setValue(data.name);
        targetSheet.getRange(cityRowIdx + base + 1, 2).setValue(data.num);
      });

      const cleanRange = targetSheet.getRange(cityRowIdx, 1, targetSheet.getLastRow() - cityRowIdx + 1, 2);
      const cleanValues = cleanRange.getValues();
      for (let i = cleanValues.length - 1; i >= 0; i--) {
        const header = String(cleanValues[i][0]).trim();
        const val = String(cleanValues[i][1]).trim();
        if ((header === "市町村" || header === "市町村番号") && val === "") {
          targetSheet.deleteRow(cityRowIdx + i);
        }
      }
    }

    if (users.length > 0) {
      currentA = targetSheet.getRange("A:A").getValues();
      const uBase = currentA.findIndex(r => String(r[0]).trim() === "氏名") + 1;
      
      let dRow = -1;
      for (let i = uBase - 1; i < currentA.length; i++) {
        if (String(currentA[i][0]).trim() === "日") {
          dRow = i + 1;
          break;
        }
      }

      if (uBase > 0 && dRow > 0) {
        const contentSize = (dRow - uBase) + 2; 
        const gapSize = 4; 
        const blockSize = contentSize + gapSize;

        if (users.length > 1) {
          targetSheet.insertRowsAfter(targetSheet.getLastRow(), (users.length - 1) * blockSize);
          const source = targetSheet.getRange(uBase, 1, blockSize, targetSheet.getLastColumn());
          for (let i = 1; i < users.length; i++) {
            source.copyTo(targetSheet.getRange(uBase + (i * blockSize), 1));
          }
        }

        let totalOffset = 0;

        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          const currentStartRow = uBase + (i * blockSize) + totalOffset;
          
          const limitRowsNeeded = Math.max(0, user.limits.length - 3);
          const dailyRowsNeeded = Math.max(0, user.dailies.length - 1);
          
          const scanRange = targetSheet.getRange(currentStartRow, 1, blockSize + 10, 1);
          const scanVals = scanRange.getValues();
          
          let limitHeaderRelIdx = -1;
          let dayRelIdx = -1;
          
          for(let r=0; r<scanVals.length; r++) {
            const txt = String(scanVals[r][0]).trim();
            if(txt === "事業所名") limitHeaderRelIdx = r;
            if(txt === "日") dayRelIdx = r;
            if(limitHeaderRelIdx !== -1 && dayRelIdx !== -1) break;
          }

          let addedForLimit = 0;

          if (limitRowsNeeded > 0 && limitHeaderRelIdx !== -1) {
            const insertPos = currentStartRow + limitHeaderRelIdx + 1 + 2; 
            targetSheet.insertRowsAfter(insertPos, limitRowsNeeded);
            SpreadsheetApp.flush(); // ★追加: 行の挿入をサーバーに確定させる
            Utilities.sleep(300);   // ★追加: 0.3秒の息継ぎ
            targetSheet.getRange(insertPos, 1, 1, targetSheet.getLastColumn())
              .copyTo(targetSheet.getRange(insertPos + 1, 1, limitRowsNeeded, targetSheet.getLastColumn()));
            addedForLimit = limitRowsNeeded;
          }

          let addedForDaily = 0;
          if (dailyRowsNeeded > 0 && dayRelIdx !== -1) {
            const actualDayRow = currentStartRow + dayRelIdx + addedForLimit;
            const insertPos = actualDayRow + 1; 
            targetSheet.insertRowsAfter(insertPos, dailyRowsNeeded);
            SpreadsheetApp.flush(); // ★追加: 行の挿入をサーバーに確定させる
            Utilities.sleep(300);   // ★追加: 0.3秒の息継ぎ
            targetSheet.getRange(insertPos, 1, 1, targetSheet.getLastColumn())
              .copyTo(targetSheet.getRange(insertPos + 1, 1, dailyRowsNeeded, targetSheet.getLastColumn()));
            addedForDaily = dailyRowsNeeded;
          }
          
          let memLimitIdx = -1;
          let memDayIdx = -1;
          
          for(let r=0; r<scanVals.length; r++) {
            const txt = String(scanVals[r][0]).trim();
            
            let rowIdx = currentStartRow + r;
            if (limitHeaderRelIdx !== -1 && r > limitHeaderRelIdx + 3) {
              rowIdx += addedForLimit;
            }
            if (dayRelIdx !== -1 && r > dayRelIdx + 1) {
              rowIdx += addedForDaily;
            }
            
            if (category === "障害児相談支援") {
              if(txt === "氏名") targetSheet.getRange(rowIdx, 2).setValue(user.kName);            
              else if(txt === "氏名カナ") targetSheet.getRange(rowIdx, 2).setValue(user.kKana);  
              else if(txt === "児童氏名") targetSheet.getRange(rowIdx, 2).setValue(user.name);       
              else if(txt === "児童氏名カナ") targetSheet.getRange(rowIdx, 2).setValue(user.kana);   
            } else {
              if(txt === "氏名") targetSheet.getRange(rowIdx, 2).setValue(user.name);
              else if(txt === "氏名カナ") targetSheet.getRange(rowIdx, 2).setValue(user.kana);
            }

            if(txt === "受給者証番号") targetSheet.getRange(rowIdx, 2).setValue(user.num);
            else if(txt === "支給市町村") targetSheet.getRange(rowIdx, 2).setValue(user.city);
            else if(txt === "利用者負担上限額") targetSheet.getRange(rowIdx, 2).setValue(user.up);
            
            else if(txt === "事業所名") memLimitIdx = r;
            else if(txt === "日") memDayIdx = r;
            
            if(txt === "再請求対象") {
              if(String(ReSeikyu).toLowerCase() === "true") {
                targetSheet.getRange(rowIdx, 2).setValue("○");
              }
            }
            
            if(user.kasanMap.hasOwnProperty(txt)) {
              targetSheet.getRange(rowIdx, 2).setValue(user.kasanMap[txt]);
            }
          }

          if (memLimitIdx !== -1 && user.limits.length > 0) {
            const startL = currentStartRow + memLimitIdx + 1;
            const numRows = user.limits.length;
            const arrA = [], arrB = [], arrD = [], arrF = [];
            
            user.limits.forEach(lim => {
              arrA.push([lim.name]);
              arrB.push([lim.num]);
              arrD.push([lim.cost]);
              arrF.push([lim.burden]);
            });

            targetSheet.getRange(startL, 1, numRows, 1).setValues(arrA);
            targetSheet.getRange(startL, 2, numRows, 1).setValues(arrB);
            targetSheet.getRange(startL, 4, numRows, 1).setValues(arrD);
            targetSheet.getRange(startL, 6, numRows, 1).setValues(arrF);
          }

          if (memDayIdx !== -1 && user.dailies.length > 0) {
            const startD = currentStartRow + memDayIdx + 1 + addedForLimit;
            const numRows = user.dailies.length;
            const arrA = [], arrB = [], arrC = [], arrE = [], arrF = [];
            
            user.dailies.forEach((d, idx) => {
              const rowNum = startD + idx; 
              arrA.push([d.day]);
              
              const formula = `=IF(A${rowNum}<>"",TEXT(DATE(LEFT($B$3,4),RIGHT($B$3,2),A${rowNum}),"aaa"),"")`;
              arrB.push([formula]);
              
              arrC.push([d.kihon]);
              arrE.push([d.cost1]);
              arrF.push([d.cost2]);
            });

            targetSheet.getRange(startD, 1, numRows, 1).setValues(arrA); 
            targetSheet.getRange(startD, 2, numRows, 1).setFormulas(arrB); 
            targetSheet.getRange(startD, 3, numRows, 1).setValues(arrC); 
            targetSheet.getRange(startD, 5, numRows, 1).setValues(arrE); 
            targetSheet.getRange(startD, 6, numRows, 1).setValues(arrF); 
          }

          totalOffset += (addedForLimit + addedForDaily);
        }
        log("全ユーザー反映完了");
      }
    }

    log("データ反映待ち(2秒)...");
    SpreadsheetApp.flush(); 
    Utilities.sleep(2000);  

    log("テキスト置換処理を開始");
    applyFinalReplacements(newSS.getId(), extractIdFromUrl(appSSdbURL));
    
    SpreadsheetApp.flush();
    Utilities.sleep(1000);

    log("相談支援種別統合処理を開始(詳細ログ付)");
    executeRowMerge(targetSheet, log);
    
    log("--- 処理結果集計 ---");
    log(`・処理利用者数: ${users.length}名`);
    log(`・対象請求ID数: ${targetIds.length}件`);
    log(`・基本報酬データ件数: ${countKihon}件`);
    log(`・加算データ件数: ${countKasan}件`);
    log(`・市町村DB新規登録: ${cityWriteRows.length}件`);
    log(`・利用者DB新規登録: ${userWriteRows.length}件`);

    if (unregisteredWarnings.length > 0) {
      log("【確認事項】以下の利用者に「未登録」のデータが含まれています。スプレッドシートを確認してください：");
      unregisteredWarnings.forEach(warn => {
        log(`・${warn}`);
      });
    }
    
    log("処理完了");

    return {
      url: newFile.getUrl(),
      log: executionLogs.join("\n")
    };

  } catch (e) {
    const errorMsg = "Error: " + e.message + " (Line: " + e.stack + ")";
    console.error(errorMsg);
    return {
      url: "ERROR",
      log: errorMsg
    };
  }
}

// -------------------------------------------------------------------------
// 補助関数群（こちらも元々提供いただいたコードに完全に戻しています）
// -------------------------------------------------------------------------
function executeRowMerge(sheet, logger) {
  const data = sheet.getDataRange().getValues();
  let deletedCount = 0; 
  const toHalf = (v) => String(v).replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).trim();

  logger(`【詳細ログ】総行数: ${data.length}行 をスキャンします`);

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    const cellA = String(row[0]).trim();
    const cellC = String(row[2]).trim();

    if (cellA === "日" && cellC === "種類") {
      logger(`【詳細ログ】ヘッダー検出: ${i + 1}行目`);
      
      let rowsInBlock = [];
      let r = i + 1; 
      
      while (r < data.length) {
        const dVal = String(data[r][0]).trim();
        const tVal = toHalf(data[r][2]); 
        
        if (dVal === "" && tVal === "") break;
        if (dVal === "日") break;

        rowsInBlock.push({
          originalIndex: r,
          sheetRow: r + 1 - deletedCount, 
          day: parseInt(toHalf(dVal), 10) || 0,
          type: tVal,
          cost1: data[r][4], 
          cost2: data[r][5]  
        });
        r++;
      }

      if (rowsInBlock.length > 0) {
        const blockSummary = rowsInBlock.map(x => `[行${x.sheetRow}:日${x.day}/種${x.type}]`).join(", ");
        logger(`  -> データブロック取得: ${blockSummary}`);
      } else {
        logger(`  -> データブロックなし`);
      }

      const mergePair = (typeA, typeB, mergedType) => {
        const itemA = rowsInBlock.find(x => x.type === typeA);
        const itemB = rowsInBlock.find(x => x.type === typeB);

        if (itemA && itemB) {
          logger(`  ★統合対象発見: ${typeA}(行${itemA.sheetRow}) & ${typeB}(行${itemB.sheetRow}) -> ${mergedType}`);
          
          let keeper, remover;
          if (itemA.day >= itemB.day) {
            keeper = itemA;
            remover = itemB;
          } else {
            keeper = itemB;
            remover = itemA;
          }

          const sumCost = (c1, c2) => {
             const v1 = parseFloat(c1) || 0;
             const v2 = parseFloat(c2) || 0;
             return (v1 + v2) > 0 ? (v1 + v2) : ""; 
          };
          const newCost1 = sumCost(keeper.cost1, remover.cost1);
          const newCost2 = sumCost(keeper.cost2, remover.cost2);

          // C、E、F列のみ更新（B列の関数は触らない）
          sheet.getRange(keeper.sheetRow, 3).setValue(mergedType);
          sheet.getRange(keeper.sheetRow, 5).setValue(newCost1);
          sheet.getRange(keeper.sheetRow, 6).setValue(newCost2);
          
          sheet.deleteRow(remover.sheetRow);
          logger(`    -> 行削除実行: 行${remover.sheetRow}`);
          
          deletedCount++;

          rowsInBlock.forEach(x => {
            if (x.sheetRow > remover.sheetRow) {
              x.sheetRow--;
            }
          });
          
          const idx = rowsInBlock.indexOf(remover);
          if (idx > -1) rowsInBlock.splice(idx, 1);
        }
      };

      mergePair("11", "12", "13");
      mergePair("21", "22", "23");

      i = r - 1;
    }
  }
}

function applyFinalReplacements(targetSpreadsheetId, configSpreadsheetId) {
  const dbSs = SpreadsheetApp.openById(configSpreadsheetId);
  const configSheet = dbSs.getSheetByName("日報Excel置換");
  if (!configSheet) return;
  const lastConfigRow = configSheet.getLastRow();
  if (lastConfigRow < 2) return; 
  const configValues = configSheet.getRange(2, 1, lastConfigRow - 1, 8).getValues();
  
  const targetSs = SpreadsheetApp.openById(targetSpreadsheetId);
  const targetSheet = targetSs.getSheets()[0]; 
  const targetLastRow = targetSheet.getLastRow();
  if (targetLastRow < 1) return; 
  const searchRange = targetSheet.getRange(1, 1, targetLastRow, 4);

  configValues.forEach(row => {
    const searchText = row[1];      
    const replaceValue = row[2];    
    const locationRule = row[3];
    const flag = row[7];
    if (String(flag).toUpperCase() !== "TRUE") return;
    if (searchText === "" || searchText == null) return;

    const textFinder = searchRange.createTextFinder(searchText).useRegularExpression(false).matchEntireCell(true);
    const foundCells = textFinder.findAll();
    foundCells.forEach(cell => {
      try {
        if (locationRule === "該当箇所") cell.setValue(replaceValue);
        else if (locationRule === "1つ右のセル") cell.offset(0, 1).setValue(replaceValue);
        else if (locationRule === "1つ下のセル") cell.offset(1, 0).setValue(replaceValue);
      } catch (e) {
        console.warn(`置換処理エラー: ${cell.getA1Notation()}`);
      }
    });
  });
}

// getOrCreateFolder と generateRandomId は 回帰検索.js に共通定義あり（重複削除済み）
function extractIdFromUrl(u){if(!u)return "";const m=u.match(/[-\w]{25,}/);return m?m[0]:u}

