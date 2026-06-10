// Script Property "TASK_SS_ID" から取得（000_AppConfig.js 参照）
const TASK_SS_ID = getConfigId_('TASK_SS_ID');
const TASK_SHEET_NAME = '非同期子項目反映';

/**
 * 1. AppSheetから呼び出される関数
 */
function registerTask_ssToChild_CloudSQL(spreadsheetUrl, reportMasterId) {
  const ss = SpreadsheetApp.openById(TASK_SS_ID);
  let sheet = ss.getSheetByName(TASK_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(TASK_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    const headers = ["タスクID", "受付日時", "ステータス", "対象帳票URL", "帳票マスタ複製登録ID", "処理結果ログ", "完了日時"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  const taskId = Utilities.getUuid();
  sheet.appendRow([taskId, new Date(), "待機中", spreadsheetUrl, reportMasterId, "", ""]);
  return "タスクを待機キューに登録しました。裏側で非同期処理を開始します。";
}

/**
 * 2. トリガーで定期実行される関数
 */
function processPendingTasks_ssToChild_CloudSQL() {
  const ss = SpreadsheetApp.openById(TASK_SS_ID);
  const sheet = ss.getSheetByName(TASK_SHEET_NAME);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idxStatus = headers.indexOf("ステータス");
  const idxUrl = headers.indexOf("対象帳票URL");
  const idxMasterId = headers.indexOf("帳票マスタ複製登録ID");
  const idxLog = headers.indexOf("処理結果ログ");
  const idxFinish = headers.indexOf("完了日時");

  let targetRowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idxStatus] === "待機中") { targetRowIndex = i; break; }
  }
  if (targetRowIndex === -1) return; 

  const rowNum = targetRowIndex + 1;
  const spreadsheetUrl = data[targetRowIndex][idxUrl];
  const reportMasterId = data[targetRowIndex][idxMasterId];

  try {
    sheet.getRange(rowNum, idxStatus + 1).setValue("処理中");
    SpreadsheetApp.flush();
    const logResult = executeHeavyTask_ssToChild_CloudSQL_(spreadsheetUrl, reportMasterId);
    sheet.getRange(rowNum, idxStatus + 1).setValue("完了");
    sheet.getRange(rowNum, idxLog + 1).setValue(logResult);
    sheet.getRange(rowNum, idxFinish + 1).setValue(new Date());
  } catch (e) {
    sheet.getRange(rowNum, idxStatus + 1).setValue("エラー");
    sheet.getRange(rowNum, idxLog + 1).setValue(e.message);
    sheet.getRange(rowNum, idxFinish + 1).setValue(new Date());
  }
}

/**
 * 3. 実際の重い処理本体（数値自動整形 ＆ 書き込みエラースキップ版）
 */
function executeHeavyTask_ssToChild_CloudSQL_(spreadsheetUrl, reportMasterId) {
  const logs = [];
  const start = new Date();
  try {
    const idMatch = String(spreadsheetUrl).match(/[-\w]{25,}/);
    if (!idMatch) return "エラー：URLからIDを取得できません。";
    const spreadsheetId = idMatch[0];

    logs.push("【開始】帳票 → DB 反映処理（非同期・CloudSQL版）");
    const reportSS = SpreadsheetApp.openById(spreadsheetId);
    const db = openDb_ssToChild_CloudSQL_(reportMasterId);
    const idx = db.idx;
    const values = db.allData;

    if (values.length < 2) return "【終了】対象の子レコードがデータベースに0件でした。";

    const typeToColName = { "日付":"日付","日時":"日時","テキスト":"テキスト","ロングテキスト":"ロングテキスト","単一選択肢":"単一選択肢","複数選択肢":"複数選択肢","数値":"数値","数値_小数点":"数値_小数点","パーセント":"パーセント","電話番号":"電話番号","メールアドレス":"メールアドレス","URL":"URL","住所":"住所","画像":"画像","ファイル":"ファイル" };
    
    let 対象行=0, 読取成功=0, 上書き=0, 同一=0, 空値=0, シート無=0, 位置不正=0, DB反映エラー=0;
    const sheetCaches = {};
    const updateList = [];

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const posText = String(row[idx["シート名セル位置"]] ?? "").trim();
      if (!posText) continue;
      
      const typeName = String(row[idx["項目データ型選択"]] ?? "").trim();
      const targetColName = typeToColName[typeName];
      if (!targetColName) continue;

      対象行++;
      const posList = posText.split(/[,、]/).map(s => s.trim()).filter(Boolean);
      let pickedValue = "";
      for (const pos of posList) {
        const parsed = parseSheetA1_ssToChild_(pos);
        if (!parsed) { 位置不正++; continue; }
        const rawValue = getCachedCellValue_ssToChild_(reportSS, parsed.sheetName, parsed.a1, sheetCaches);
        if (rawValue === null) { シート無++; continue; }
        const cleaned = stripAmpPlaceholders_ssToChild_(String(rawValue ?? "")).trim();
        if (cleaned !== "") { pickedValue = cleaned; break; }
      }

      if (pickedValue === "") { 空値++; continue; }
      
      // ★ 数値型の場合は数字以外（歳、円など）を除去する
      if (typeName === "数値" || typeName === "数値_小数点") {
        // 数字、マイナス、ドット以外を削除
        pickedValue = pickedValue.replace(/[^\d.-]/g, '');
      }

      読取成功++;
      const current = String(row[idx[targetColName]] ?? "").trim();
      if (current === pickedValue) { 同一++; continue; }

      const childId = String(row[idx["帳票子レコード複製登録ID"]] ?? "").trim();
      if (childId) {
        updateList.push({ childId, colName: targetColName, newValue: pickedValue });
        上書き++;
      }
    }

    // ★ CloudSQLへの書き込み
    if (updateList.length > 0) {
      var updConn = getCloudSqlConnection_();
      updConn.setAutoCommit(false);
      
      for (const u of updateList) {
        try {
          var stmt = updConn.prepareStatement('UPDATE "帳票子レコード複製登録" SET "' + u.colName + '" = ? WHERE "帳票子レコード複製登録ID" = ?');
          if (u.newValue === "") {
            stmt.setNull(1, Jdbc.Types.VARCHAR);
          } else {
            stmt.setString(1, u.newValue);
          }
          stmt.setString(2, u.childId);
          stmt.executeUpdate();
          stmt.close();
        } catch (rowErr) {
          // ★ 行単位のエラーハンドリング：エラーが起きてもスキップして次に進む
          DB反映エラー++;
          console.error("行更新エラーをスキップしました ID:" + u.childId + " 内容:" + rowErr.message);
        }
      }
      updConn.commit();
      updConn.close();
    }

    logs.push("【結果詳細】");
    logs.push(`・対象行：${対象行} / 成功：${読取成功} / 上書き：${上書き}`);
    logs.push(`・不成立：空欄等${空値} / シート名不一致${シート無} / セル位置不正${位置不正}`);
    if (DB反映エラー > 0) logs.push(`・DB反映エラー：${DB反映エラー} 件（型不一致など）`);
    logs.push(`・処理時間：${new Date() - start} ms`);
    return logs.join("\n");
  } catch (e) { return `【例外】${e.message}`; }
}


// --- 以下、ヘルパー関数 ---
function openDb_ssToChild_CloudSQL_(reportMasterId) {
  var conn = getCloudSqlConnection_();
  var stmt = conn.prepareStatement('SELECT * FROM "帳票子レコード複製登録" WHERE "帳票マスタ複製登録ID" = ?');
  stmt.setString(1, String(reportMasterId).trim());
  var rs = stmt.executeQuery();
  var result = resultSetToArray_(rs);
  conn.close();
  return { idx: result.headers.reduce((a,c,i)=>{a[c]=i; return a;},{}), allData: [result.headers].concat(result.rows) };
}

function parseSheetA1_ssToChild_(text) {
  const m = String(text).match(/^['"]?(.+?)['"]?!([A-Z]+[0-9]+)$/i);
  if (!m) return null;
  return { sheetName: m[1].replace(/^'|'$/g, ""), a1: m[2].toUpperCase() };
}

function stripAmpPlaceholders_ssToChild_(s) {
  return String(s || "").replace(/&&[^&]+&&/g, "");
}

function getCachedCellValue_ssToChild_(ss, sheetName, a1, caches) {
  if (!caches[sheetName]) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return null;
    const maxRow = sheet.getLastRow();
    const maxCol = sheet.getLastColumn();
    caches[sheetName] = (maxRow === 0 || maxCol === 0) ? [] : sheet.getRange(1, 1, maxRow, maxCol).getDisplayValues();
  }
  const data = caches[sheetName];
  if (data.length === 0) return "";
  const pos = a1ToRowCol_ssToChild_(a1);
  if (!pos) return "";
  const r = pos.row - 1, c = pos.col - 1;
  if (r < data.length && c < data[0].length) return data[r][c];
  return "";
}

function a1ToRowCol_ssToChild_(a1) {
  const match = String(a1).match(/^([A-Z]+)([0-9]+)$/i);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const row = parseInt(match[2], 10);
  let col = 0;
  for (let i = 0; i < colStr.length; i++) col = col * 26 + (colStr.charCodeAt(i) - 64);
  return { row, col };
}