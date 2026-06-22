// ==========================================
// 001_レセプト生成_入所系.gs
//
// 入所系3サービス（児童入所施設 / 短期入所 / 日中一時支援）の月次レセプト生成。
// 既存 001_レセプト生成_CloudSQL.gs (相談2サービス用) は温存。
//
// 統合方法（既存ファイルへの最小改修）:
//   makeReceptBackground() の executeMakeRecept(...) 呼出を以下に置換:
//
//     const fn = pickExecuteMakeReceptFunction_(p.category);
//     result = fn(p.seikyuID, p.appSSdbURL, p.category, p.fileName, p.SSsourceURL,
//                 p.SSdbURL, p.SSdbSheetName, p.ToFolderURL, p.officeFolderName,
//                 p.TargetRows, p.ReSeikyu, p.TargetCustomerList, p.TargetNameList,
//                 p.TargetNameKanaList, p.TargetNumberList, p.TargetCityNameList,
//                 p.TargetKeyNameList, p.TargetKeyNameKanaList, p.TargetUpperPriceList);
//
// `pickExecuteMakeReceptFunction_()` は本ファイルで定義。
//
// 設計準拠:
//   - welfare-pdca/plans/2026-06-23-GAS新ファイル設計.md
//   - welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md
// ==========================================

const INSHO_CATEGORIES = new Set(["児童入所施設", "短期入所", "日中一時支援"]);

const INSHO_CATEGORY_TO_TABLE = {
  "児童入所施設": "児童入所登録",
  "短期入所":     "短期入所登録",
  "日中一時支援": "日中一時登録",
};

// ==========================================
// ディスパッチ関数（既存 makeReceptBackground から呼ばれる想定）
// ==========================================

/**
 * category に応じて適切な executeMakeRecept* を返す。
 * 既存 makeReceptBackground の executeMakeRecept(...) 呼出を
 * pickExecuteMakeReceptFunction_(p.category)(...) に差替えるだけで連携完成。
 */
function pickExecuteMakeReceptFunction_(category) {
  if (INSHO_CATEGORIES.has(category)) {
    return executeMakeReceptInsho;
  }
  // R8.6 改定対応の相談2サービス分岐は 001_レセプト生成_6月改定_相談.gs 側で
  // executeMakeReceptSoudan6Kaitei を定義（テンプレ URL 差替のみ）。
  // 既存 makeReceptBackground 側の dispatch で年月判定を行う想定。
  return executeMakeRecept;
}

// =========================================================================
// 入所系メイン処理
// =========================================================================
/**
 * 入所系3サービス用 executeMakeRecept。
 * 引数は既存 executeMakeRecept と完全互換（19 引数）。
 *
 * 主な相違点（既存版との差分）:
 *   1. CloudSQL クエリで暦日 LEFT JOIN（generate_series + CROSS JOIN）
 *   2. 加算マスタ取得 + 反映条件別集計（同月最新日 / 同月全件カウント）
 *   3. 利用者ブロック展開時に暦日 28〜31 行を固定で出力
 *
 * 既存ロジック流用:
 *   - 事業所情報/事業所加算項目DB 転記
 *   - 市町村ブロック動的増殖 (decisions §6-2)
 *   - 「日報Excel置換」シート (decisions §6-3)
 *   - 曜日数式保持 setFormulas (decisions §6-4)
 *   - 出力後の applyFinalReplacements / executeRowMerge は category 依存で要判定
 */
function executeMakeReceptInsho(
  seikyuID,
  appSSdbURL,
  category,
  fileName,
  SSsourceURL,
  SSdbURL,
  SSdbSheetName,
  ToFolderURL,
  officeFolderName,
  TargetRows,
  ReSeikyu,
  TargetCustomerList,
  TargetNameList,
  TargetNameKanaList,
  TargetNumberList,
  TargetCityNameList,
  TargetKeyNameList,
  TargetKeyNameKanaList,
  TargetUpperPriceList,
) {
  const executionLogs = [];
  const log = (msg) => {
    const t = Utilities.formatDate(new Date(), "JST", "HH:mm:ss");
    executionLogs.push(`[${t}] ${msg}`);
    console.log(`[${t}] ${msg}`);
  };

  log(`--- 入所系処理開始: category=${category}, seikyuID=${seikyuID} ---`);

  try {
    // 1. 引数 parse（既存と同パターン）
    const parse = (v) => (v ? String(v).split(",").map((s) => s.trim()) : []);
    const names = parse(TargetNameList);
    const kanas = parse(TargetNameKanaList);
    const nums = parse(TargetNumberList);
    const cities = parse(TargetCityNameList);
    const ups = parse(TargetUpperPriceList);
    const knms = parse(TargetKeyNameList);
    const kkns = parse(TargetKeyNameKanaList);
    const userIDs = parse(TargetCustomerList);

    // 2. 対象年月の決定（入所系では TargetRows 引数の代わりに当該レコードから抽出）
    //    TargetRows = 入所系登録テーブルの ID リスト（カンマ区切り）
    const targetRecordIds = parse(TargetRows);
    if (targetRecordIds.length === 0) {
      throw new Error("TargetRows が空です（入所系登録レコードIDが必要）");
    }

    // 3. appDB スプシ取得
    const appDB = SpreadsheetApp.openByUrl(appSSdbURL);
    log("appDB スプシ取得完了");

    // 4. ★ CloudSQL から日次データを暦日 LEFT JOIN で取得
    const tableName = INSHO_CATEGORY_TO_TABLE[category];
    if (!tableName) throw new Error(`不明な category: ${category}`);

    const dailyRows = fetchDailyRecordsWithCalendar_(
      tableName,
      userIDs,
      targetRecordIds,
      log,
    );
    log(`CloudSQL 取得: ${dailyRows.length}行（暦日×利用者の matrix）`);

    if (dailyRows.length === 0) {
      log("⚠️ 対象データなし");
      return { url: "", log: executionLogs.join("\n") };
    }

    // 対象年月（暦日行から抽出）
    const ym = String(dailyRows[0]["年月"] || "").trim();
    if (!ym) throw new Error("年月の取得に失敗");
    log(`対象年月: ${ym}`);

    // 5. ★ 加算マスタを取得（メモ化）
    const kasanMaster = loadKasanMaster_(category, log);
    log(`加算マスタ取得: ${Object.keys(kasanMaster).length}件`);

    // 6. ★ 反映条件別に集計
    const userMap = aggregateInshoData_(dailyRows, kasanMaster, userIDs, log);
    log(`利用者集計完了: ${Object.keys(userMap).length}名`);

    // 7. リタリコ Excel テンプレを Drive コピー（既存ロジック流用）
    const parentFolder = DriveApp.getFolderByUrl(ToFolderURL);
    const officeFolder = getOrCreateFolder(parentFolder, officeFolderName);
    const sourceFile = DriveApp.getFileById(extractIdFromUrl(SSsourceURL));
    const newFile = sourceFile.makeCopy(`${fileName}_${ym}.xlsx`, officeFolder);
    const newSS = SpreadsheetApp.openById(newFile.getId());
    SpreadsheetApp.flush();
    Utilities.sleep(3000);
    log(`テンプレ複製: ${newFile.getUrl()}`);

    // 8. category 名のシートだけ残し他削除
    newSS.getSheets().forEach((s) => {
      if (s.getName() !== category) newSS.deleteSheet(s);
    });
    const targetSheet = newSS.getSheetByName(category);
    if (!targetSheet) throw new Error(`シート '${category}' が見つかりません`);

    // 9. 事業所情報セクション転記（既存ロジック流用）
    fillJigyoshoSection_(targetSheet, appDB, seikyuID, log);

    // 10. 事業所加算項目DB 転記（既存ロジック流用 / decisions §6-1）
    fillJigyoshoKasanFromAppDB_(targetSheet, appDB, seikyuID, log);

    // 11. 市町村ブロック動的増殖（既存ロジック流用 / decisions §6-2）
    const cityDataList = collectCityData_(appDB, seikyuID, ym);
    expandShichosonBlocks_(targetSheet, cityDataList, log);

    // 12. ★ 利用者ブロック動的増殖（暦日固定 28〜31 行）
    expandUserBlocksWithCalendar_(
      targetSheet,
      userMap,
      userIDs,
      names,
      kanas,
      nums,
      cities,
      ups,
      knms,
      kkns,
      ym,
      category,
      ReSeikyu,
      log,
    );

    // 13. 「日報Excel置換」シート適用（既存関数流用 / decisions §6-3）
    SpreadsheetApp.flush();
    Utilities.sleep(2000);
    const appDBId = extractIdFromUrl(appSSdbURL);
    applyFinalReplacements(newFile.getId(), appDBId);
    log("日報Excel置換 適用完了");

    log("--- 入所系処理完了 ---");
    return { url: newFile.getUrl(), log: executionLogs.join("\n") };
  } catch (e) {
    log(`【ERROR】${e.message}\n${e.stack}`);
    return { url: "ERROR", log: executionLogs.join("\n") };
  }
}

// =========================================================================
// CloudSQL 暦日 LEFT JOIN クエリ
// =========================================================================

/**
 * 暦日 × 利用者の matrix で CloudSQL から取得。
 * 利用がない日も行が返るため、Excel 出力時に暦日 1〜31 を保証。
 *
 * 注: getCloudSqlConnection_() は 000_CloudSQL接続.gs に既存定義。
 */
function fetchDailyRecordsWithCalendar_(tableName, userIDs, recordIds, log) {
  const conn = getCloudSqlConnection_();
  try {
    // recordIds から対象年月を取得（最初の 1 件から判定）
    const stmtYM = conn.prepareStatement(
      `SELECT "年月" FROM public."${tableName}" WHERE "${tableName}ID" = ? LIMIT 1`,
    );
    stmtYM.setString(1, recordIds[0]);
    const rsYM = stmtYM.executeQuery();
    if (!rsYM.next()) {
      throw new Error(`recordId=${recordIds[0]} が${tableName}に存在しません`);
    }
    const ym = rsYM.getString("年月"); // "YYYY-MM" 形式
    rsYM.close();
    stmtYM.close();

    const startDate = `${ym}-01`;
    log && log(`暦日範囲: ${ym} 月初〜月末`);

    const userPlaceholders = userIDs.map(() => "?").join(",");
    const sql = `
      WITH calendar AS (
        SELECT generate_series(
          DATE '${startDate}',
          (DATE '${startDate}' + INTERVAL '1 month' - INTERVAL '1 day')::DATE,
          INTERVAL '1 day'
        )::DATE AS "記録日"
      ),
      target_users AS (
        SELECT unnest(ARRAY[${userPlaceholders}]::VARCHAR[]) AS "利用者在籍ID"
      ),
      matrix AS (
        SELECT u."利用者在籍ID", c."記録日"
        FROM target_users u CROSS JOIN calendar c
      )
      SELECT
        m."利用者在籍ID",
        m."記録日",
        TO_CHAR(m."記録日", 'DD')  AS "日",
        TO_CHAR(m."記録日", 'YYYY-MM') AS "年月",
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

    const meta = rs.getMetaData();
    const cols = [];
    for (let i = 1; i <= meta.getColumnCount(); i++) {
      cols.push(meta.getColumnLabel(i));
    }
    const rows = [];
    while (rs.next()) {
      const r = {};
      cols.forEach((c) => (r[c] = rs.getObject(c)));
      rows.push(r);
    }
    rs.close();
    stmt.close();
    return rows;
  } finally {
    conn.close();
  }
}

// =========================================================================
// 加算マスタ取得 (Application API v2)
// =========================================================================

/**
 * 「001_利用者加算マスタ」を取得して category でフィルタ + マップ化。
 * Script Properties:
 *   APPSHEET_APP_ID_主app
 *   APPSHEET_API_KEY_主app
 */
function loadKasanMaster_(category, log) {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty("APPSHEET_APP_ID_主app");
  const apiKey = props.getProperty("APPSHEET_API_KEY_主app");
  if (!appId || !apiKey) {
    throw new Error(
      "APPSHEET_APP_ID_主app / APPSHEET_API_KEY_主app が未設定。Script Properties に追加してください。",
    );
  }

  const url = `https://www.appsheet.com/api/v2/apps/${appId}/tables/${encodeURIComponent("001_利用者加算マスタ")}/Action`;
  const body = {
    Action: "Find",
    Properties: { Locale: "ja-JP" },
    Rows: [{}],
  };
  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { ApplicationAccessKey: apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error(`加算マスタ取得失敗: ${resp.getResponseCode()} ${resp.getContentText().slice(0, 200)}`);
  }
  const all = JSON.parse(resp.getContentText());

  const map = {};
  let filtered = 0;
  all.forEach((r) => {
    if (r["事業所REF"] !== category) return;
    const flag = r["フラグ"];
    if (flag !== "Y" && flag !== true && flag !== "TRUE") return;
    map[r["利用者加算一覧"]] = {
      kubun: r["区分_選択肢"] || "",
      kind: r["加算種別"] || "",
      reflect_cond: r["反映条件"] || "同月最新日のみ反映",
      reflect_where: r["反映箇所"] || "1つ右のセル",
    };
    filtered++;
  });
  log && log(`加算マスタ: 全${all.length}件中 ${filtered}件をフィルタ`);
  return map;
}

// =========================================================================
// 集計ロジック (反映条件別)
// =========================================================================

function aggregateInshoData_(rows, kasanMaster, userIDs, log) {
  const userMap = {};
  userIDs.forEach((uid) => {
    userMap[uid] = {
      dailies: [],
      kasanMap: {}, // 同月最新日のみ反映
      kasanCountMap: {}, // 同月全件反映_カウント: { 加算名: {count, kubun} }
      kihonHoshu: "",
    };
  });

  rows.forEach((row) => {
    const uID = String(row["利用者在籍ID"] || "");
    if (!userMap[uID]) return;
    const u = userMap[uID];

    u.dailies.push({
      day: String(row["日"] || ""),
      kihon: row["基本報酬"] != null ? String(row["基本報酬"]) : "",
      kasan: row["加算"] != null ? String(row["加算"]) : "",
      kubun: row["区分選択肢"] != null ? String(row["区分選択肢"]) : "",
      cost1: row["実費1"],
      cost2: row["実費2"],
      cost3: row["実費3"],
      cost4: row["実費4"],
      cost5: row["実費5"],
    });

    if (row["基本報酬"]) u.kihonHoshu = String(row["基本報酬"]);

    const kasanStr = row["加算"] != null ? String(row["加算"]) : "";
    const kubunStr = row["区分選択肢"] != null ? String(row["区分選択肢"]) : "";
    kasanStr
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .forEach((kasan) => {
        const meta = kasanMaster[kasan];
        if (!meta) {
          log && log(`⚠️ 加算マスタ未定義: ${kasan} (uID=${uID})`);
          u.kasanMap[kasan] = kubunStr || "○";
          return;
        }
        if (meta.reflect_cond === "同月全件反映_カウント") {
          if (!u.kasanCountMap[kasan]) {
            u.kasanCountMap[kasan] = { count: 0, kubun: kubunStr };
          }
          u.kasanCountMap[kasan].count++;
        } else {
          u.kasanMap[kasan] = kubunStr || "○";
        }
      });
  });

  return userMap;
}

// =========================================================================
// Excel テンプレ展開（暦日固定 28〜31 行）
// =========================================================================

function expandUserBlocksWithCalendar_(
  targetSheet,
  userMap,
  userIDs,
  names,
  kanas,
  nums,
  cities,
  ups,
  knms,
  kkns,
  ym,
  category,
  ReSeikyu,
  log,
) {
  const users = userIDs.map((uid, i) => ({
    uID: uid,
    name: names[i] || "",
    kana: kanas[i] || "",
    num: nums[i] || "",
    city: cities[i] || "",
    up: ups[i] || "",
    kName: knms[i] || "",
    kKana: kkns[i] || "",
    data: userMap[uid] || { dailies: [], kasanMap: {}, kasanCountMap: {}, kihonHoshu: "" },
  }));
  if (users.length === 0) return;

  // 暦日行数（28〜31）を最初の利用者から取得
  const daysInMonth = users[0].data.dailies.length;

  // テンプレ上の利用者ブロック構造を解析
  const aColumn = targetSheet.getRange("A:A").getValues();
  const uBaseRow = aColumn.findIndex((r) => String(r[0]).trim() === "氏名") + 1;
  if (uBaseRow < 1) throw new Error("テンプレに「氏名」ラベルが見つかりません");

  // 「日」ヘッダー行
  let dHeaderRow = -1;
  for (let i = uBaseRow; i < aColumn.length; i++) {
    if (String(aColumn[i][0]).trim() === "日") {
      dHeaderRow = i + 1;
      break;
    }
  }
  if (dHeaderRow < 1) throw new Error("テンプレに「日」ヘッダー行が見つかりません");

  const dailyAreaStart = dHeaderRow + 1;
  // 元テンプレでは日次行が 1 行のみ。日数分に増殖する
  // ブロックサイズ = 氏名行 から 日次データ末尾 + 余白
  const baseDailyRowCount = 1;
  const gapSize = 4;
  const blockTotalSize = (dHeaderRow - uBaseRow + 1) + daysInMonth + gapSize;

  // 1. 利用者数 - 1 個分ブロック増殖
  if (users.length > 1) {
    targetSheet.insertRowsAfter(uBaseRow, blockTotalSize * (users.length - 1));
    SpreadsheetApp.flush();
    // 各ブロックの内容を 1 番目からコピー
    for (let i = 1; i < users.length; i++) {
      const dstRow = uBaseRow + blockTotalSize * i;
      targetSheet
        .getRange(uBaseRow, 1, blockTotalSize, targetSheet.getMaxColumns())
        .copyTo(targetSheet.getRange(dstRow, 1));
    }
  }

  // 2. 各利用者ブロックの日次行を必要数まで増殖
  for (let i = 0; i < users.length; i++) {
    const blockStart = uBaseRow + blockTotalSize * i;
    const blockDailyHeader = blockStart + (dHeaderRow - uBaseRow);
    const blockDailyStart = blockDailyHeader + 1;
    // 暦日数 - 1 行だけ追加（元テンプレに 1 行あるので）
    if (daysInMonth > baseDailyRowCount) {
      targetSheet.insertRowsAfter(
        blockDailyStart,
        daysInMonth - baseDailyRowCount,
      );
      // 元の 1 行を新規行にコピー
      targetSheet
        .getRange(blockDailyStart, 1, 1, targetSheet.getMaxColumns())
        .copyTo(
          targetSheet.getRange(
            blockDailyStart + 1,
            1,
            daysInMonth - baseDailyRowCount,
            targetSheet.getMaxColumns(),
          ),
        );
    }
  }
  SpreadsheetApp.flush();

  // 3. 各利用者ブロックの値設定
  users.forEach((user, i) => {
    const blockStart = uBaseRow + blockTotalSize * i;
    const blockDailyHeader = blockStart + (dHeaderRow - uBaseRow);
    const blockDailyStart = blockDailyHeader + 1;

    // ラベルスキャン → B 列に値書込
    const blockRange = targetSheet.getRange(blockStart, 1, blockTotalSize, 1).getValues();
    for (let j = 0; j < blockRange.length; j++) {
      const labelRow = blockStart + j;
      const label = String(blockRange[j][0] || "").trim();
      if (!label) continue;

      // 共通ラベル
      if (label === "氏名") {
        targetSheet.getRange(labelRow, 2).setValue(user.name);
        continue;
      }
      if (label === "氏名カナ") {
        targetSheet.getRange(labelRow, 2).setValue(user.kana);
        continue;
      }
      if (label === "受給者証番号") {
        targetSheet.getRange(labelRow, 2).setValue(user.num);
        continue;
      }
      if (label === "支給市町村") {
        targetSheet.getRange(labelRow, 2).setValue(user.city);
        continue;
      }
      if (label === "利用者負担上限額") {
        targetSheet.getRange(labelRow, 2).setValue(user.up);
        continue;
      }
      if (label === "再請求対象") {
        if (String(ReSeikyu) === "true" || ReSeikyu === true) {
          targetSheet.getRange(labelRow, 2).setValue("○");
        }
        continue;
      }
      // 児童入所施設のみ 児童氏名/カナ を別途使用
      if (category === "児童入所施設") {
        if (label === "児童氏名") {
          targetSheet.getRange(labelRow, 2).setValue(user.kName || user.name);
          continue;
        }
        if (label === "児童氏名カナ") {
          targetSheet.getRange(labelRow, 2).setValue(user.kKana || user.kana);
          continue;
        }
      }
      // 加算サマリ
      if (user.data.kasanMap[label] !== undefined) {
        const v = user.data.kasanMap[label];
        targetSheet.getRange(labelRow, 2).setValue(v || "○");
        continue;
      }
      if (user.data.kasanCountMap[label] !== undefined) {
        const info = user.data.kasanCountMap[label];
        // count を反映（区分があれば併記）
        const value = info.kubun ? `${info.count} (${info.kubun})` : info.count;
        targetSheet.getRange(labelRow, 2).setValue(value);
        continue;
      }
    }

    // 暦日行の書込（A=日数字、B=曜日数式★、C=基本報酬、E〜I=実費1-5）
    if (daysInMonth > 0) {
      const arrA = [], arrB = [], arrC = [], arrE = [], arrF = [], arrG = [], arrH = [], arrI = [];
      for (let j = 0; j < daysInMonth; j++) {
        const d = user.data.dailies[j] || { day: String(j + 1).padStart(2, "0") };
        const rowNum = blockDailyStart + j;
        arrA.push([d.day]);
        arrB.push([
          `=IF(A${rowNum}<>"",TEXT(DATE(LEFT($B$3,4),RIGHT($B$3,2),A${rowNum}),"aaa"),"")`,
        ]);
        arrC.push([d.kihon || ""]);
        arrE.push([d.cost1 != null ? d.cost1 : ""]);
        arrF.push([d.cost2 != null ? d.cost2 : ""]);
        arrG.push([d.cost3 != null ? d.cost3 : ""]);
        arrH.push([d.cost4 != null ? d.cost4 : ""]);
        arrI.push([d.cost5 != null ? d.cost5 : ""]);
      }
      targetSheet.getRange(blockDailyStart, 1, daysInMonth, 1).setValues(arrA);
      targetSheet.getRange(blockDailyStart, 2, daysInMonth, 1).setFormulas(arrB); // ★ 曜日数式
      targetSheet.getRange(blockDailyStart, 3, daysInMonth, 1).setValues(arrC);
      targetSheet.getRange(blockDailyStart, 5, daysInMonth, 1).setValues(arrE);
      targetSheet.getRange(blockDailyStart, 6, daysInMonth, 1).setValues(arrF);
      // 実費 3〜5（テンプレに該当列があるなら）
      const maxCols = targetSheet.getMaxColumns();
      if (maxCols >= 7) targetSheet.getRange(blockDailyStart, 7, daysInMonth, 1).setValues(arrG);
      if (maxCols >= 8) targetSheet.getRange(blockDailyStart, 8, daysInMonth, 1).setValues(arrH);
      if (maxCols >= 9) targetSheet.getRange(blockDailyStart, 9, daysInMonth, 1).setValues(arrI);
    }
  });
}

// =========================================================================
// 事業所情報セクション転記（既存ロジック流用ヘルパ）
// =========================================================================

function fillJigyoshoSection_(targetSheet, appDB, seikyuID, log) {
  const sheet = appDB.getSheetByName("請求情報DB");
  if (!sheet) {
    log && log("⚠️ 請求情報DB シート不在");
    return;
  }
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  const seikyuCol = headers.findIndex((h) => /請求情報ID/.test(String(h)));
  if (seikyuCol < 0) return;
  const targetRow = data.find(
    (r, i) => i > 0 && String(r[seikyuCol]) === String(seikyuID),
  );
  if (!targetRow) {
    log && log(`⚠️ 請求情報DB に seikyuID=${seikyuID} 見つからず`);
    return;
  }

  // テンプレ A 列ラベル × ヘッダー名一致 → B 列に転記
  const aColumn = targetSheet.getRange("A:A").getValues();
  headers.forEach((h, idx) => {
    const headerStr = String(h || "").trim();
    if (!headerStr) return;
    const labelIdx = aColumn.findIndex((r) => String(r[0]).trim() === headerStr);
    if (labelIdx < 0) return;
    const value = targetRow[idx];
    if (value !== undefined && value !== null && value !== "") {
      targetSheet.getRange(labelIdx + 1, 2).setValue(value);
    }
  });
}

// =========================================================================
// 事業所加算項目DB 転記（decisions §6-1）
// =========================================================================

function fillJigyoshoKasanFromAppDB_(targetSheet, appDB, seikyuID, log) {
  const sheet = appDB.getSheetByName("事業所加算項目DB");
  if (!sheet) {
    log && log("⚠️ 事業所加算項目DB シート不在");
    return;
  }
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  const seikyuCol = headers.findIndex((h) => /請求情報ID/.test(String(h)));
  const nameCol = headers.findIndex((h) => /事業所加算項目|加算名/.test(String(h)));
  const valueCol = headers.findIndex((h) => /事業所加算_値|値/.test(String(h)));
  if (seikyuCol < 0 || nameCol < 0 || valueCol < 0) {
    log && log("⚠️ 事業所加算項目DB の列が見つからず");
    return;
  }

  const aColumn = targetSheet.getRange("A:A").getValues();
  let cnt = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][seikyuCol]) !== String(seikyuID)) continue;
    const name = String(data[i][nameCol] || "").trim();
    const value = data[i][valueCol];
    if (!name) continue;
    const labelIdx = aColumn.findIndex((r) => String(r[0]).trim() === name);
    if (labelIdx >= 0 && value !== "" && value !== null && value !== undefined) {
      targetSheet.getRange(labelIdx + 1, 2).setValue(value);
      cnt++;
    }
  }
  log && log(`事業所加算項目DB から ${cnt}件転記`);
}

// =========================================================================
// 市町村ブロック動的増殖（decisions §6-2）
// =========================================================================

function collectCityData_(appDB, seikyuID, ym) {
  const sheet = appDB.getSheetByName("市町村情報DB");
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const seikyuCol = headers.findIndex((h) => /請求情報ID/.test(String(h)));
  const nameCol = headers.findIndex((h) => /市町村名|市町村$/.test(String(h)));
  const numCol = headers.findIndex((h) => /市町村番号|番号/.test(String(h)));
  if (seikyuCol < 0 || nameCol < 0 || numCol < 0) return [];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][seikyuCol]) !== String(seikyuID)) continue;
    out.push({
      name: String(data[i][nameCol] || ""),
      num: String(data[i][numCol] || ""),
    });
  }
  return out;
}

function expandShichosonBlocks_(targetSheet, cityDataList, log) {
  if (cityDataList.length === 0) return;

  const aColumn = targetSheet.getRange("A:A").getValues();
  const cityRowIdx = aColumn.findIndex((r) => String(r[0]).trim() === "市町村") + 1;
  if (cityRowIdx < 1) {
    log && log("⚠️ 「市町村」行が見つからず");
    return;
  }

  const cityBlockSize = 4;
  if (cityDataList.length > 1) {
    targetSheet.insertRowsAfter(
      cityRowIdx,
      cityBlockSize * (cityDataList.length - 1),
    );
    SpreadsheetApp.flush();
    for (let i = 1; i < cityDataList.length; i++) {
      const dstRow = cityRowIdx + cityBlockSize * i;
      targetSheet
        .getRange(cityRowIdx, 1, cityBlockSize, targetSheet.getMaxColumns())
        .copyTo(targetSheet.getRange(dstRow, 1));
    }
  }

  cityDataList.forEach((city, i) => {
    const baseRow = cityRowIdx + cityBlockSize * i;
    targetSheet.getRange(baseRow, 2).setValue(city.name);
    targetSheet.getRange(baseRow + 1, 2).setValue(city.num);
  });

  log && log(`市町村ブロック展開: ${cityDataList.length}個`);
}
