/**
 * =======================================================
 * AppSheetから呼び出され、AI用コンテキストTXTを生成する
 *
 * ✅ 要件
 * - ファイル構成:
 * 1. {氏名}_AIコンテキスト_最新.txt  (常にここを読み書き)
 * 2. {氏名}_AIコンテキスト_{YYYY}.txt (過去年のアーカイブ)
 * * ✅ 年次処理
 * - 実行時に「最新.txt」内の年号を確認。
 * - 年が明けていれば、旧ファイルを「_20XX.txt」にリネームして退避し、
 * 新たに「最新.txt」を作成する。
 * =======================================================
 */

function generateAIContextFile(targetId, options) {

  // Optionsのパース
  if (!options) options = {};
  if (typeof options === "string") {
    try { options = JSON.parse(options); } catch (e) { options = {}; }
  }

  // 1) ID判定
  let userId = targetId;
  if (!userId) {
    userId = "a03RB00000srmYsYAI"; // テスト用ID
    Logger.log("⚠️ 注意: 引数 targetId がないため、テスト用IDを使用します: " + userId);
  } else {
    Logger.log("🚀 処理開始: targetId = " + userId);
  }

  let isFirstRun = !!options.isFirstRun;

  try {
    const props = PropertiesService.getScriptProperties();
    const APP_ID = props.getProperty("APPSHEET_APP_ID");
    const API_KEY = props.getProperty("APPSHEET_API_KEY");
    if (!APP_ID || !API_KEY) throw new Error("スクリプトプロパティ未設定");

    // -------------------------------------------------------
    // 2) 利用者基本情報
    // -------------------------------------------------------
    Logger.log("⏳ 基本情報取得中...");
    const userRows = callAppSheetApi(APP_ID, API_KEY, "CustomerStatus__c", `Filter(CustomerStatus__c, [Row ID] = '${userId}')`);
    Utilities.sleep(1500); // ★API制限対策（429エラー削減のため500ms→1500msに拡大）

    if (!userRows || userRows.length === 0) throw new Error(`利用者不在: ${userId}`);

    const user = userRows[0];
    const customerRefId = user["Customer__c"];
    const userName = user["CustomerName__c"];

    // ★重要: ファイル名の定義
    const latestFileName = `${userName}_AIコンテキスト_最新.txt`;

    // -------------------------------------------------------
    // ★ 年次ロールオーバー処理 (年替わり対応)
    // -------------------------------------------------------
    // 「最新.txt」が存在し、かつ中身が去年のものであればアーカイブする
    handleYearRollover_(user, latestFileName);

    // 初回判定（最新ファイルが無ければ初回扱い）
    if (!isFirstRun && !checkFileExists_(user, latestFileName)) {
      isFirstRun = true;
      Logger.log("🆕 最新ファイル不在のため初回(全件)モードで実行");
    }

    // -------------------------------------------------------
    // 3) 既存データの読み込み (最新ファイルから)
    // -------------------------------------------------------
    let historyMap = new Map();

    if (!isFirstRun) {
      const existingText = readTextFileFromChatPDFFolder_(user, latestFileName) || "";
      const existingHistoryBlock = extractBlock_(existingText, "HISTORY_BLOCK");
      historyMap = parseHistoryToMap_(existingHistoryBlock);
      Logger.log(`📂 既存履歴(最新)から ${historyMap.size} 件をロードしました`);
    }

    // -------------------------------------------------------
    // 4) プロフィール層（毎回再生成）
    // -------------------------------------------------------
    let profile = "";
    profile += `# 利用者包括データ: ${userName}\n`;
    // ★生成日時に西暦を入れる（これが年判定の基準になる）
    profile += `生成日時: ${Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm")}\n\n`;

    profile += `## 【基本属性】(CustomerStatus__c)\n`;
    profile += `- 利用者名: ${safe_(user["CustomerName__c"])} (${safe_(user["CustomerNameFurigana__c"])})\n`;
    profile += `- ステータス: ${safe_(user["Status__c"])}\n`;
    profile += `- 年齢/性別: ${safe_(user["Age__c"])} / ${safe_(user["Gender__c"])}\n`;
    profile += `- 事業所: ${safe_(user["OfficeName__c"])} (サービス: ${safe_(user["ServiceType__c"])})\n`;
    profile += `- 利用期間: ${safe_(user["StartDate__c"])} ～ ${safe_(user["EndDate__c"])}\n\n`;

    // 受給者証
    const cardId = user["DisabilityCard__c"];
    if (cardId) {
      const cardRows = callAppSheetApi(APP_ID, API_KEY, "DisabilityCard__c", `Filter(DisabilityCard__c, [Row ID] = '${cardId}')`);
      Utilities.sleep(1500); // ★API制限対策（429エラー削減のため500ms→1500msに拡大）

      if (cardRows.length > 0) {
        profile += `## 【受給者証情報】(DisabilityCard__c)\n`;
        Object.keys(cardRows[0]).forEach(key => profile += `- ${key}: ${safe_(cardRows[0][key])}\n`);
        profile += `\n`;
      }
    }

    // 関係者
    const supporters = callAppSheetApi(APP_ID, API_KEY, "SupportPersonnel__c", `Filter(SupportPersonnel__c, [Customer__c] = '${customerRefId}')`);
    Utilities.sleep(1500); // ★API制限対策（429エラー削減のため500ms→1500msに拡大）

    const legals = callAppSheetApi(APP_ID, API_KEY, "LegalRepresentative__c", `Filter(LegalRepresentative__c, [Customer__c] = '${customerRefId}')`);
    Utilities.sleep(1500); // ★API制限対策（429エラー削減のため500ms→1500msに拡大）

    profile += `## 【関係者情報】\n`;
    if (supporters.length > 0) {
      profile += `### 支援関係者\n`;
      supporters.forEach(s => profile += `- ${JSON.stringify(s)}\n`);
    }
    if (legals.length > 0) {
      profile += `### 法定代理人・親族\n`;
      legals.forEach(l => profile += `- ${JSON.stringify(l)}\n`);
    }
    profile += `\n`;

    // 職員マスタ（キャッシュがあればAPI呼び出しをスキップ）
    const staffList = (options.cachedStaffList && options.cachedStaffList.length > 0)
      ? options.cachedStaffList
      : callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");
    if (!options.cachedStaffList) Utilities.sleep(1500); // キャッシュ未使用時のみ待機

    profile += `## 【職員マスタ】(StaffStatus__c)\n`;
    if (staffList.length > 0) {
      staffList.forEach(st => {
        const sId = st["Row ID"];
        const sName = st["NameKana__c"] || st["Name__c"] || "名称不明";
        profile += `- ID: ${sId}, 氏名: ${sName}\n`;
      });
    } else {
      profile += `- 該当なし\n`;
    }
    profile += `\n`;

    // -------------------------------------------------------
    // 5) 履歴データ取得 & Map更新
    // -------------------------------------------------------
    const { start, end } = getTodayRangeJST_();

    // ★ CloudSQL版: 4テーブルをJDBCで直接取得（AppSheet API不要、sleep不要）
    var _ctxConn;
    try {
      _ctxConn = getCloudSqlConnection_();

      // 5-1) 01相談記録
      const rowsConsult = isFirstRun
        ? selectAsObjects_(_ctxConn, '01相談記録', '"利用者在籍ID" = ?', [userId])
        : selectAsObjects_(_ctxConn, '01相談記録', '"利用者在籍ID" = ? AND "更新日時" >= ? AND "更新日時" < ?', [userId, start, end]);
      Logger.log("01相談記録: " + rowsConsult.length + "件");

      updateHistoryMap_(historyMap, "01相談記録", rowsConsult, "相談記録ID", "更新日時", (r) => {
        return `- [01相談記録] RowID=${safe_(r["相談記録ID"])} 更新=${safe_(r["更新日時"])}\n  記録日=${safe_(r["記録日"])} 種別=${safe_(r["相談種別"])} タイトル=${safe_(r["タイトル"])}\n  報酬/加算=${safe_(r["基本報酬"])} / ${safe_(r["加算"])} 連携先=${safe_(r["連携先の機関"])}`;
      });

      // 5-2) ケース記録
      const rowsCase = isFirstRun
        ? selectAsObjects_(_ctxConn, 'ケース記録', '"利用者在籍ID" = ?', [userId])
        : selectAsObjects_(_ctxConn, 'ケース記録', '"利用者在籍ID" = ? AND "更新日時" >= ? AND "更新日時" < ?', [userId, start, end]);
      Logger.log("ケース記録: " + rowsCase.length + "件");

      updateHistoryMap_(historyMap, "ケース記録", rowsCase, "Row ID", "更新日時", (r) => {
        return `- [ケース記録] RowID=${safe_(r["Row ID"])} 更新=${safe_(r["更新日時"])}\n  記録者=${safe_(r["記録者"])} 種別=${safe_(r["支援記録種別"])}\n  内容=${safe_(r["記録全容"])}`;
      });

      // 5-3) 帳票マスタ
      const rowsForms = isFirstRun
        ? selectAsObjects_(_ctxConn, '帳票マスタ複製登録', '"利用者在籍ID" = ?', [userId])
        : selectAsObjects_(_ctxConn, '帳票マスタ複製登録', '"利用者在籍ID" = ? AND "更新日時" >= ? AND "更新日時" < ?', [userId, start, end]);
      Logger.log("帳票マスタ: " + rowsForms.length + "件");

      updateHistoryMap_(historyMap, "帳票マスタ複製登録", rowsForms, "帳票マスタ複製登録ID", "更新日時", (r) => {
        const ssUrl = safe_(r["スプシURL"]);
        return `- [帳票マスタ] RowID=${safe_(r["帳票マスタ複製登録ID"])} 更新=${safe_(r["更新日時"])}\n` +
               `  帳票名=${safe_(r["帳票名"])} 結果=${safe_(r["帳票作成処理結果"])}\n` +
               `  参照URL=${ssUrl}`;
      });

      // 5-4) 帳票子レコード
      let rowsFormDetails = [];
      if (isFirstRun) {
        const pIds = rowsForms.map(f => f["帳票マスタ複製登録ID"]).filter(Boolean);
        if (pIds.length > 0) {
          const ph = pIds.map(function() { return '?'; }).join(', ');
          rowsFormDetails = selectAsObjects_(_ctxConn, '帳票子レコード複製登録', '"帳票マスタ複製登録ID" IN (' + ph + ')', pIds);
        }
      } else {
        // 当日更新分
        const todayChild = selectAsObjects_(_ctxConn, '帳票子レコード複製登録', '"更新日時" >= ? AND "更新日時" < ?', [start, end]);
        rowsFormDetails = rowsFormDetails.concat(todayChild);
        // 当日更新の帳票マスタに紐づく子レコード
        const pIdsToday = rowsForms.map(f => f["帳票マスタ複製登録ID"]).filter(Boolean);
        if (pIdsToday.length > 0) {
          const ph2 = pIdsToday.map(function() { return '?'; }).join(', ');
          const parentChild = selectAsObjects_(_ctxConn, '帳票子レコード複製登録', '"帳票マスタ複製登録ID" IN (' + ph2 + ')', pIdsToday);
          rowsFormDetails = rowsFormDetails.concat(parentChild);
        }
      }
      Logger.log("帳票子レコード: " + rowsFormDetails.length + "件");

      updateHistoryMap_(historyMap, "帳票子レコード複製登録", rowsFormDetails, "帳票子レコード複製登録ID", "更新日時", (r) => {
        return `- [帳票子] RowID=${safe_(r["帳票子レコード複製登録ID"])} 親ID=${safe_(r["帳票マスタ複製登録ID"])} 更新=${safe_(r["更新日時"])}\n  項目=${safe_(r["&&項目名&&"])} 入力=${safe_(r["入力内容_VC"])}`;
      });

    } finally {
      closeCloudSql_(_ctxConn);
    }

    // 5-5) 音声記録
    const selVoice = isFirstRun
      ? `Filter(音声記録対応, [利用者在籍ID] = '${userId}')`
      : buildDateTimeSelector_("音声記録対応", "[利用者在籍ID]", userId, "[作成日]", start, end);
    const rowsVoice = callAppSheetApi(APP_ID, API_KEY, "音声記録対応", selVoice);
    Utilities.sleep(1500); // ★API制限対策（429エラー削減のため500ms→1500msに拡大）

    updateHistoryMap_(historyMap, "音声記録対応", rowsVoice, "Row ID", "作成日", (r) => {
      return `- [音声] RowID=${safe_(r["Row ID"])} 作成=${safe_(r["作成日"])}\n  ファイル=${safe_(r["音声ファイル名"])} 要約=${safe_(r["文字起oしテキスト"] || r["文字起こしテキスト"])}`;
    });

    // -------------------------------------------------------
    // 6) 保存（最新ファイルへ上書き）
    // -------------------------------------------------------
    const reconstructedHistory = renderHistoryMap_(historyMap);
    const finalHistoryBlock = wrapBlock_("HISTORY_BLOCK", reconstructedHistory);
    const finalText = profile + "\n" + finalHistoryBlock + "\n";

    Logger.log("💾 保存中...");
    
    try {
      saveToDrive_(user, latestFileName, finalText, true); // 最新ファイルに保存
      Logger.log("🎉 完了");
      return { ok: true, items: historyMap.size };
      
    } catch (saveError) {
      // 保存に失敗しても、エラーログを残してこの人の処理だけを終了する（全体をクラッシュさせない）
      Logger.log(`⚠️ 保存スキップ: ${saveError.message}`);
      return { ok: false, error: saveError.message };
    }

  } catch (e) {
    Logger.log(`🚨 エラー: ${e.message}\n${e.stack}`);
    throw e;
  }
}

// =======================================================
// ★新機能: 年次ロールオーバー処理
// =======================================================
function handleYearRollover_(userObj, latestFileName) {
  try {
    const folder = getChatPDFFolder_(userObj);
    if (!folder) return;

    const files = folder.getFilesByName(latestFileName);
    if (!files.hasNext()) return; // 最新ファイルがなければ何もしない

    const file = files.next();
    const content = file.getBlob().getDataAsString("UTF-8");

    // "生成日時: YYYY/MM/dd" を探す
    const match = content.match(/生成日時:\s*(\d{4})\//);
    if (!match) return; // 日時が読めなければスキップ

    const fileYear = parseInt(match[1], 10);
    const currentYear = new Date().getFullYear();

    // ファイルの年が、現在年より古ければアーカイブする
    if (fileYear < currentYear) {
      const archiveName = `${userObj["CustomerName__c"]}_AIコンテキスト_${fileYear}.txt`;
      Logger.log(`🔄 年越し検知: ${fileYear}年のデータをアーカイブします -> ${archiveName}`);

      // すでに同名のアーカイブがある場合は削除（上書き用）
      const oldArchives = folder.getFilesByName(archiveName);
      while(oldArchives.hasNext()) {
        oldArchives.next().setTrashed(true);
      }

      // ファイル名を変更（これで "最新" ファイルはなくなり、次回新規作成される）
      file.setName(archiveName);
    }

  } catch (e) {
    Logger.log("Rollover Error: " + e.message);
    // ロールオーバーに失敗しても、メイン処理は止めない
  }
}

// =======================================================
// マップ構築 & ユーティリティ
// =======================================================
function parseHistoryToMap_(text) {
  const map = new Map();
  if (!text) return map;
  const lines = text.split("\n");
  let buffer = []; let currentKey = ""; let currentDate = "";
  const commit = () => { if (currentKey && buffer.length > 0) map.set(currentKey, { date: currentDate, text: buffer.join("\n").trim() }); buffer = []; currentKey = ""; currentDate = ""; };
  for (const line of lines) {
    const recordMatch = line.match(/^\-\s+\[(.+?)\]\s+RowID=([^\s]+).*?(更新|作成)=(.+)$/);
    if (recordMatch) { commit(); currentKey = `${recordMatch[1].trim()}__${recordMatch[2].trim()}`; currentDate = recordMatch[4].trim(); buffer.push(line); }
    else if (currentKey) buffer.push(line);
  }
  commit();
  return map;
}

function updateHistoryMap_(map, tableName, rows, idCol, dateCol, formatFn) {
  if (!rows || rows.length === 0) return;
  rows.forEach(r => {
    const rowId = r[idCol]; const dt = r[dateCol];
    if (!rowId) return;
    map.set(`${tableName}__${rowId}`, { date: safe_(dt), text: formatFn(r) });
  });
}

function renderHistoryMap_(map) {
  const groups = {};
  ["01相談記録", "ケース記録", "帳票マスタ複製登録", "帳票子レコード複製登録", "音声記録対応"].forEach(t => groups[t] = []);
  for (const [key, val] of map.entries()) {
    const t = key.split("__")[0];
    if (groups[t]) groups[t].push(val);
  }
  let out = "## 履歴データ（最新スナップショット）\n";
  for (const tbl in groups) {
    out += `\n### ${tbl}\n`;
    if (groups[tbl].length > 0) {
      groups[tbl].sort((a, b) => toEpoch_(b.date) - toEpoch_(a.date));
      groups[tbl].forEach(item => out += item.text + "\n");
    } else { out += `- 該当なし\n`; }
  }
  return out.trim();
}

function toEpoch_(s) {
  if (!s) return 0;
  let t = String(s).replace(/\//g, "-").trim();
  if (t.indexOf("T") === -1 && t.indexOf(" ") !== -1) t = t.replace(" ", "T");
  const d = new Date(t);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function safe_(v) { return (v === null || v === undefined) ? "" : String(v); }
function getTodayRangeJST_() {
  const now = new Date();
  const ymd = Utilities.formatDate(now, "JST", "yyyy-MM-dd");
  const next = new Date(now); next.setDate(next.getDate() + 1);
  return { start: `${ymd} 00:00:00`, end: `${Utilities.formatDate(next, "JST", "yyyy-MM-dd")} 00:00:00` };
}
function buildDateTimeSelector_(t, i, u, d, s, e) { return `Filter(${t}, AND(${d} >= DATETIME("${s}"), ${d} < DATETIME("${e}"), ${i} = '${u}'))`; }

function fetchByOrIdsChunked_(appId, apiKey, tableName, parentIdFieldExpr, ids) {
  const CHUNK = 40; const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const orExpr = `OR(${chunk.map(id => `${parentIdFieldExpr} = '${id}'`).join(", ")})`;
    all.push(...callAppSheetApi(appId, apiKey, tableName, `Filter(${tableName}, ${orExpr})`));
    
    // ★API制限対策: チャンクごとに1秒待機
    Utilities.sleep(1000); 
  }
  return all;
}

function checkFileExists_(userObj, fileName) {
  try { return getChatPDFFolder_(userObj).getFilesByName(fileName).hasNext(); } catch (e) { return false; }
}
function getParentFolderIdFromGoogleUrl_(url) {
  if (!url) return "";
  const m = url.match(/id=([a-zA-Z0-9_-]+)/) || url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : "";
}
function getChatPDFFolder_(userObj) {
  const id = getParentFolderIdFromGoogleUrl_(userObj["GoogleURL__c"]);
  if (!id) return null;
  const f = DriveApp.getFolderById(id).getFoldersByName("ChatPDF");
  return f.hasNext() ? f.next() : null;
}

function getOrCreateChatPDFFolder_(userObj) {
  const url = userObj["GoogleURL__c"];
  const id = getParentFolderIdFromGoogleUrl_(url);
  
  if (!id) {
    throw new Error(`【データ不備】GoogleURLが未登録か形式が不正です。URL: ${url}`);
  }
  
  try {
    const p = DriveApp.getFolderById(id);
    const f = p.getFoldersByName("ChatPDF");
    return f.hasNext() ? f.next() : p.createFolder("ChatPDF");
  } catch (e) {
    // 404エラーなどの場合に、具体的な理由を投げて処理を中断させる
    throw new Error(`【Driveアクセス不可】フォルダ(ID:${id})が見つかりません。削除されたか権限がない可能性があります。URL: ${url}`);
  }
}

function readTextFileFromChatPDFFolder_(userObj, fileName) {
  try {
    const f = getChatPDFFolder_(userObj).getFilesByName(fileName);
    return f.hasNext() ? f.next().getBlob().getDataAsString("UTF-8") : null;
  } catch (e) { return null; }
}

function saveToDrive_(userObj, fileName, content, rewrite) {
  const folder = getOrCreateChatPDFFolder_(userObj);
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    const f = files.next();
    f.setContent(content); // 常に全上書き（最新版として）
  } else {
    folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  }
}
function wrapBlock_(n, b) { return `<<<${n}:START>>>\n${b}\n<<<${n}:END>>>`; }
function extractBlock_(t, n) {
  const s = t.indexOf(`<<<${n}:START>>>`); const e = t.indexOf(`<<<${n}:END>>>`);
  return (s === -1 || e === -1) ? "" : t.substring(s + n.length + 13, e).trim();
}

// ==================================================================================
// CloudSQL用ヘルパー: SELECT結果をオブジェクト配列に変換
// callAppSheetApi の戻り値と同じ [{カラム名: 値, ...}, ...] 形式にする
// ==================================================================================
function selectAsObjects_(conn, tableName, whereClause, params) {
  var stmt, rs;
  try {
    var sql = 'SELECT * FROM "' + tableName + '"';
    if (whereClause) sql += ' WHERE ' + whereClause;

    stmt = conn.prepareStatement(sql);
    if (params) {
      for (var i = 0; i < params.length; i++) {
        stmt.setString(i + 1, String(params[i]));
      }
    }
    rs = stmt.executeQuery();

    var meta = rs.getMetaData();
    var colCount = meta.getColumnCount();
    var colNames = [];
    for (var c = 1; c <= colCount; c++) colNames.push(meta.getColumnName(c));

    var results = [];
    while (rs.next()) {
      var obj = {};
      for (var j = 0; j < colNames.length; j++) {
        obj[colNames[j]] = rs.getString(j + 1) || "";
      }
      results.push(obj);
    }
    return results;
  } finally {
    closeCloudSql_(null, stmt, rs);
  }
}