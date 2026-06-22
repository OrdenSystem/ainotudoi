/**
 * 001_レセプト生成_入所系.gs
 *
 * 入所系3サービス（児童入所施設 / 短期入所 / 日中一時支援）の月次レセプト生成。
 *
 * 既存 001_レセプト生成_CloudSQL.gs (相談2サービス用) は温存。
 * 本ファイルは新規実装で以下の特徴を持つ：
 *   1. CloudSQL クエリで暦日 LEFT JOIN
 *   2. 加算集計を反映条件別に分岐（同月最新日のみ反映 / 同月全件反映_カウント）
 *   3. 入所系3テーブル（児童入所登録/短期入所登録/日中一時登録）からデータ取得
 *
 * AppSheet Bot 呼出経路:
 *   Bot:レセBOT → makeRecept() (既存) → 内部でルーティング → makeReceptInsho()
 *
 * 設計準拠:
 *   - welfare-pdca/plans/2026-06-23-GAS新ファイル設計.md
 *   - welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md
 */

const INSHO_CATEGORIES = new Set(["児童入所施設", "短期入所", "日中一時支援"]);

const CATEGORY_TO_TABLE = {
  "児童入所施設": "児童入所登録",
  "短期入所":     "短期入所登録",
  "日中一時支援": "日中一時登録",
};

// =============================================================================
// エントリポイント: AppSheet Bot から呼ばれる makeRecept のルーティング
// =============================================================================
// 既存 makeRecept() の冒頭に以下を追加（最小改修）：
//   if (INSHO_CATEGORIES.has(category)) {
//     return makeReceptInsho.apply(null, arguments);
//   }
// =============================================================================

/**
 * 入所系3サービス用レセプト生成エントリ（19 引数、makeRecept と互換）
 */
function makeReceptInsho(seikyuID, appSSdbURL, category, fileName, SSsourceURL,
                         ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
                         TargetKanaList, TargetGuardianNameList, TargetGuardianKanaList,
                         TargetCustomerStatusList, TargetCertNumList, TargetCityList,
                         ReSeikyu, ymList, OutputFileNamePostfix, dateString) {

  console.log(`[makeReceptInsho] start: category=${category}, seikyuID=${seikyuID}`);

  // 「請求処理タスク」シートに待機中追記
  appendToSeikyuTask_(seikyuID, category, "待機中", dateString);

  // 1秒後にバックグラウンド実行
  ScriptApp.newTrigger("makeReceptInshoBackground")
    .timeBased()
    .after(1000)
    .create();

  return { url: "", log: "入所系非同期処理中…" };
}

/**
 * バックグラウンド実行（トリガ起動）
 */
function makeReceptInshoBackground() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log("[makeReceptInshoBackground] lock acquisition failed");
    return;
  }
  try {
    // 「請求処理タスク」シートから待機中行を取得 → 実行中化
    const task = pickWaitingInshoTask_();
    if (!task) {
      console.log("[makeReceptInshoBackground] no waiting task");
      return;
    }
    markTaskAsRunning_(task.row);
    lock.releaseLock();  // 早期解放（実処理は I/O 集約のため）

    // 実処理
    const result = executeMakeReceptInsho_(task);

    // 結果を AppSheet 請求情報DB に書戻し
    updateAppSheetRecord_(task.seikyuID, result.url, result.log);
    markTaskAsCompleted_(task.row);

    // 次の待機タスク起動（連鎖）
    if (hasMoreWaitingTasks_()) {
      ScriptApp.newTrigger("makeReceptInshoBackground")
        .timeBased().after(2000).create();
    }
  } catch (e) {
    console.error("[makeReceptInshoBackground] error:", e);
    sendSlackNotification(`入所系レセプト生成エラー: ${e.message}`);
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

// =============================================================================
// 実処理本体
// =============================================================================

function executeMakeReceptInsho_(task) {
  const {
    seikyuID, appSSdbURL, category, fileName, SSsourceURL,
    ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
    TargetCertNumList, TargetCityList, ReSeikyu, ymList,
    OutputFileNamePostfix
  } = task;

  // 1. 引数 parse
  const targetIDs = TargetIDs.split(",").map(s => s.trim()).filter(Boolean);
  const ym = String(ymList[0]).replace(/年|月/g, "");  // "202606" 形式
  const ymCat = `${ym}_${category}`;

  // 2. appDB スプシ取得
  const appDB = SpreadsheetApp.openByUrl(appSSdbURL);

  // 3. ★ 暦日 LEFT JOIN クエリで CloudSQL から取得
  const tableName = CATEGORY_TO_TABLE[category];
  if (!tableName) throw new Error(`Unknown category: ${category}`);
  const dailyRows = fetchDailyRecordsWithCalendar_(tableName, targetIDs, ym);

  // 4. ★ 加算マスタを Application API v2 で取得 + メモ化
  const kasanMaster = loadKasanMaster_(category);

  // 5. 集計（反映条件別に分岐）
  const userMap = aggregateInshoData_(dailyRows, kasanMaster);

  // 6. リタリコ Excel テンプレを Drive コピー
  const parentFolder = DriveApp.getFolderById(ToFolderID);
  const officeFolder = parentFolder.createFolder(
    `${category}_${ym}_${OutputFileNamePostfix}`
  );
  const sourceFile = DriveApp.getFileById(extractFileId_(SSsourceURL));
  const newFile = sourceFile.makeCopy(`${fileName}_${ym}.xlsx`, officeFolder);
  const newSS = SpreadsheetApp.openById(newFile.getId());
  SpreadsheetApp.flush();
  Utilities.sleep(3000);

  // 7. category 名のシートだけ残し他削除
  newSS.getSheets().forEach(s => {
    if (s.getName() !== category) newSS.deleteSheet(s);
  });
  const targetSheet = newSS.getSheetByName(category);

  // 8. 請求情報DB（事業所情報）転記（既存ロジック流用可能）
  fillJigyoshoInfo_(targetSheet, appDB, seikyuID);

  // 9. 事業所加算項目DB（請求アプリのスプシ）からの加算転記
  fillJigyoshoKasan_(targetSheet, appDB, seikyuID);

  // 10. 市町村ブロック動的増殖（decisions §6-2 厳守）
  expandShichosonBlocks_(targetSheet, appDB, seikyuID);

  // 11. ★ 利用者ブロック動的増殖（暦日 28〜31 固定行）
  expandUserBlocksWithCalendar_(targetSheet, userMap, ym, category);

  // 12. 「日報Excel置換」シートの置換ルール適用（decisions §6-3 厳守）
  SpreadsheetApp.flush();
  Utilities.sleep(2000);
  applyFinalReplacementsInsho_(newSS, appDB);

  // 13. ログまとめて返却
  return {
    url: newFile.getUrl(),
    log: `[入所系] ${category} ${ym} 生成完了 (${Object.keys(userMap).length}名)`
  };
}

// =============================================================================
// §3 CloudSQL 暦日 LEFT JOIN クエリ
// =============================================================================

/**
 * 暦日 × 利用者の matrix で CloudSQL から取得。
 * 利用がない日も行を返す（疎データ補完）。
 */
function fetchDailyRecordsWithCalendar_(tableName, userIDs, ym) {
  const conn = getCloudSqlConnection_();
  try {
    const startDate = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
    const endDate = `(DATE '${startDate}' + INTERVAL '1 month' - INTERVAL '1 day')::DATE`;

    const userPlaceholders = userIDs.map((_, i) => `?`).join(",");
    const sql = `
      WITH calendar AS (
        SELECT generate_series(
          DATE '${startDate}',
          ${endDate},
          INTERVAL '1 day'
        )::DATE AS "記録日"
      ),
      target_users AS (
        SELECT unnest(ARRAY[${userPlaceholders}]) AS "利用者在籍ID"
      ),
      matrix AS (
        SELECT u."利用者在籍ID", c."記録日"
        FROM target_users u CROSS JOIN calendar c
      )
      SELECT
        m."利用者在籍ID",
        m."記録日",
        TO_CHAR(m."記録日", 'DD')  AS "日",
        r."基本報酬",
        r."加算",
        r."区分選択肢",
        r."実費1", r."実費2", r."実費3", r."実費4", r."実費5",
        r."フラグ"
      FROM matrix m
      LEFT JOIN public."${tableName}" r
        ON r."利用者在籍ID" = m."利用者在籍ID"
        AND r."記録日" = m."記録日"
        AND r."フラグ" IS DISTINCT FROM TRUE
      ORDER BY m."利用者在籍ID", m."記録日";
    `;

    const stmt = conn.prepareStatement(sql);
    userIDs.forEach((uid, i) => stmt.setString(i + 1, uid));
    const rs = stmt.executeQuery();

    const rows = [];
    const meta = rs.getMetaData();
    const cols = [];
    for (let i = 1; i <= meta.getColumnCount(); i++) cols.push(meta.getColumnLabel(i));
    while (rs.next()) {
      const row = {};
      cols.forEach(c => row[c] = rs.getObject(c));
      rows.push(row);
    }
    rs.close();
    stmt.close();
    return rows;
  } finally {
    conn.close();
  }
}

// =============================================================================
// §4 加算マスタ取得 (Application API v2)
// =============================================================================

/**
 * 利用者加算マスタを取得して category でフィルタ + 加算名 → メタ情報マップ化
 */
function loadKasanMaster_(category) {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty("APPSHEET_APP_ID_主app");
  const apiKey = props.getProperty("APPSHEET_API_KEY_主app");
  if (!appId || !apiKey) {
    throw new Error("APPSHEET_APP_ID_主app / APPSHEET_API_KEY_主app が未設定");
  }

  const url = `https://www.appsheet.com/api/v2/apps/${appId}/tables/${encodeURIComponent("001_利用者加算マスタ")}/Action`;
  const body = {
    Action: "Find",
    Properties: { Locale: "ja-JP" },
    Rows: [{}]
  };
  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { ApplicationAccessKey: apiKey },
    payload: JSON.stringify(body)
  });
  const all = JSON.parse(resp.getContentText());

  // category と一致するもの + フラグ=Y のみ
  const filtered = all.filter(r =>
    r["事業所REF"] === category && (r["フラグ"] === "Y" || r["フラグ"] === true)
  );
  const map = {};
  filtered.forEach(r => {
    map[r["利用者加算一覧"]] = {
      kubun: r["区分_選択肢"] || "",
      kind: r["加算種別"] || "",
      reflect_cond: r["反映条件"] || "同月最新日のみ反映",
      reflect_where: r["反映箇所"] || "1つ右のセル"
    };
  });
  return map;
}

// =============================================================================
// §5 集計ロジック (反映条件別)
// =============================================================================

/**
 * 暦日 LEFT JOIN 結果を利用者単位に集計。
 * 反映条件で日数カウント or 最新値上書きを分岐。
 */
function aggregateInshoData_(rows, kasanMaster) {
  const userMap = {};

  rows.forEach(row => {
    const uID = String(row["利用者在籍ID"] || "");
    if (!uID) return;

    if (!userMap[uID]) {
      userMap[uID] = {
        dailies: [],         // 暦日全行
        kasanMap: {},        // 同月最新日のみ反映
        kasanCountMap: {},   // 同月全件反映_カウント
        kihonHoshu: ""
      };
    }
    const u = userMap[uID];

    // 日次行（暦日固定）
    u.dailies.push({
      day:    String(row["日"] || ""),
      kihon:  String(row["基本報酬"] || ""),
      kasan:  String(row["加算"] || ""),
      kubun:  String(row["区分選択肢"] || ""),
      cost1:  row["実費1"], cost2: row["実費2"], cost3: row["実費3"],
      cost4:  row["実費4"], cost5: row["実費5"]
    });

    // 基本報酬は最新値
    if (row["基本報酬"]) u.kihonHoshu = String(row["基本報酬"]);

    // 加算をカンマ区切りで分解して集計
    const kasanStr = String(row["加算"] || "");
    const kubun = String(row["区分選択肢"] || "");
    kasanStr.split(",").forEach(k => {
      const kasan = k.trim();
      if (!kasan) return;
      const meta = kasanMaster[kasan];
      if (!meta) {
        console.warn(`[aggregateInshoData_] 加算マスタ未定義: ${kasan}`);
        // フォールバック: 同月最新日のみ反映
        u.kasanMap[kasan] = kubun;
        return;
      }
      if (meta.reflect_cond === "同月全件反映_カウント") {
        if (!u.kasanCountMap[kasan]) {
          u.kasanCountMap[kasan] = { count: 0, kubun: kubun };
        }
        u.kasanCountMap[kasan].count++;
      } else {
        // 同月最新日のみ反映
        u.kasanMap[kasan] = kubun;
      }
    });
  });

  return userMap;
}

// =============================================================================
// §6 Excel テンプレ展開（暦日固定 28〜31 行）
// =============================================================================

function expandUserBlocksWithCalendar_(targetSheet, userMap, ym, category) {
  const users = Object.entries(userMap);
  if (users.length === 0) return;

  // テンプレ上の利用者ブロック構造を解析
  const aColumn = targetSheet.getRange("A:A").getValues();
  const uBaseRow = aColumn.findIndex(r => String(r[0]).trim() === "氏名") + 1;
  const dHeaderRow = aColumn.findIndex(
    (r, idx) => idx > uBaseRow && String(r[0]).trim() === "日"
  ) + 1;
  if (uBaseRow < 1 || dHeaderRow < 1) {
    throw new Error("テンプレに「氏名」または「日」ラベルが見つかりません");
  }

  // ブロックサイズ算出
  const contentSize = dHeaderRow - uBaseRow + 2;
  const dailyAreaRow = dHeaderRow + 1;
  const gapSize = 4;
  const blockSize = contentSize + 32 + gapSize;  // 暦日 31 + 余白 1

  // 利用者数分の行を増殖
  if (users.length > 1) {
    targetSheet.insertRowsAfter(uBaseRow, blockSize * (users.length - 1));
    SpreadsheetApp.flush();
    // 各ブロックの内容を 1 番目からコピー
    for (let i = 1; i < users.length; i++) {
      const dstRow = uBaseRow + blockSize * i;
      targetSheet.getRange(uBaseRow, 1, blockSize, targetSheet.getMaxColumns())
        .copyTo(targetSheet.getRange(dstRow, 1));
    }
  }

  // 各利用者ブロックに値を書込
  users.forEach(([uID, user], idx) => {
    const baseRow = uBaseRow + blockSize * idx;
    const dailyRow = baseRow + (dailyAreaRow - uBaseRow);

    // 暦日 28〜31 行を出力（GAS の generate_series で取得済みデータ）
    const daysInMonth = user.dailies.length;
    const arrA = [], arrB = [], arrC = [], arrE = [], arrF = [], arrG = [], arrH = [], arrI = [];
    for (let i = 0; i < daysInMonth; i++) {
      const d = user.dailies[i];
      const rowNum = dailyRow + i;
      arrA.push([d.day]);
      arrB.push([`=IF(A${rowNum}<>"",TEXT(DATE(LEFT($B$3,4),RIGHT($B$3,2),A${rowNum}),"aaa"),"")`]);
      arrC.push([d.kihon || ""]);
      arrE.push([d.cost1 || ""]);
      arrF.push([d.cost2 || ""]);
      arrG.push([d.cost3 || ""]);
      arrH.push([d.cost4 || ""]);
      arrI.push([d.cost5 || ""]);
    }
    targetSheet.getRange(dailyRow, 1, daysInMonth, 1).setValues(arrA);
    targetSheet.getRange(dailyRow, 2, daysInMonth, 1).setFormulas(arrB);  // ★ 曜日数式
    targetSheet.getRange(dailyRow, 3, daysInMonth, 1).setValues(arrC);
    targetSheet.getRange(dailyRow, 5, daysInMonth, 1).setValues(arrE);
    targetSheet.getRange(dailyRow, 6, daysInMonth, 1).setValues(arrF);
    if (category === "短期入所" || category === "児童入所施設") {
      // 実費 3〜5 列があるテンプレのみ
      targetSheet.getRange(dailyRow, 7, daysInMonth, 1).setValues(arrG);
      targetSheet.getRange(dailyRow, 8, daysInMonth, 1).setValues(arrH);
      targetSheet.getRange(dailyRow, 9, daysInMonth, 1).setValues(arrI);
    }

    // 加算サマリ転記
    writeKasanSummaryInsho_(targetSheet, baseRow, user, category, uID);
  });
}

/**
 * 加算サマリを A 列ラベル検索で B 列に転記
 */
function writeKasanSummaryInsho_(targetSheet, blockStartRow, user, category, uID) {
  // ブロック範囲の A 列を取得
  const blockSize = 100;  // 充分大きく
  const aColumn = targetSheet.getRange(blockStartRow, 1, blockSize, 1).getValues();

  // 同月最新日のみ反映の加算
  Object.entries(user.kasanMap).forEach(([kasan, kubun]) => {
    const idx = aColumn.findIndex(r => String(r[0]).trim() === kasan);
    if (idx >= 0) {
      targetSheet.getRange(blockStartRow + idx, 2).setValue(kubun || "○");
    }
  });

  // 同月全件反映_カウントの加算（日数を書く）
  Object.entries(user.kasanCountMap).forEach(([kasan, info]) => {
    const idx = aColumn.findIndex(r => String(r[0]).trim() === kasan);
    if (idx >= 0) {
      // 日数 + 区分の組合せ表示（要件次第で調整）
      const value = info.kubun ? `${info.count} (${info.kubun})` : info.count;
      targetSheet.getRange(blockStartRow + idx, 2).setValue(value);
    }
  });

  // 利用者基本マスタ的なラベル転記（氏名・受給者証番号 等）
  // ※ 別途 fetchCustomerInfo_(uID, category) で SF から取得して書込
}

// =============================================================================
// 既存ロジック流用部分（既存 001_レセプト生成_CloudSQL.gs から取り出し）
// =============================================================================

function appendToSeikyuTask_(seikyuID, category, status, dateString) {
  // TODO: 既存 makeRecept() の同等処理を移植
}

function pickWaitingInshoTask_() {
  // TODO: 「請求処理タスク」シートから入所系 category の待機中行を取得
  return null;
}

function markTaskAsRunning_(row) { /* TODO */ }
function markTaskAsCompleted_(row) { /* TODO */ }
function hasMoreWaitingTasks_() { return false; /* TODO */ }
function updateAppSheetRecord_(seikyuID, url, log) { /* TODO: 既存ロジック流用 */ }
function extractFileId_(url) {
  const m = url.match(/[-\w]{25,}/);
  return m ? m[0] : null;
}
function fillJigyoshoInfo_(targetSheet, appDB, seikyuID) { /* TODO: 既存ロジック流用 */ }
function fillJigyoshoKasan_(targetSheet, appDB, seikyuID) { /* TODO: 既存ロジック流用 §6-1 */ }
function expandShichosonBlocks_(targetSheet, appDB, seikyuID) { /* TODO: 既存ロジック流用 §6-2 */ }
function applyFinalReplacementsInsho_(newSS, appDB) { /* TODO: 既存 applyFinalReplacements の流用 §6-3 */ }
