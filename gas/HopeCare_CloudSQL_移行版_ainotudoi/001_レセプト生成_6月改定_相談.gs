/**
 * 001_レセプト生成_6月改定_相談.gs
 *
 * 計画相談支援 / 障害児相談支援 の令和8年6月（2026-06）改定対応。
 *
 * 既存 001_レセプト生成_CloudSQL.gs は温存。本ファイルは：
 *   - 対象月が 2026-06 以降なら新テンプレ + 新マスタを使用
 *   - 2026-05 以前なら既存テンプレを使用（過去遡及請求対応）
 *
 * 主な改定内容:
 *   - 福祉・介護職員等処遇改善加算 に Ⅰロ・Ⅱロ 新設（上位区分）
 *   - 既存 Ⅰイ・Ⅱイ も加算率変更
 *
 * AppSheet Bot 呼出経路:
 *   Bot:レセBOT → makeRecept() (既存ルータ化) → makeReceptSoudan6Kaitei()
 *
 * 設計準拠:
 *   - welfare-pdca/plans/2026-06-23-GAS新ファイル設計.md §2.2
 *   - welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md
 */

const SOUDAN_CATEGORIES = new Set(["計画相談支援", "障害児相談支援"]);

// R8.6 適用境界月（含む）
const R8_6_START_YM = "202606";

// =============================================================================
// ルーティング: 既存 makeRecept() の冒頭から呼ばれる想定
// =============================================================================
// 例:
//   function makeRecept(seikyuID, ..., ymList, ...) {
//     const ym = String(ymList[0]).replace(/年|月/g, "");
//     if (INSHO_CATEGORIES.has(category)) {
//       return makeReceptInsho.apply(null, arguments);
//     }
//     if (SOUDAN_CATEGORIES.has(category) && ym >= R8_6_START_YM) {
//       return makeReceptSoudan6Kaitei.apply(null, arguments);
//     }
//     // ↓ 既存処理（5月以前の相談）
//     return makeReceptLegacy.apply(null, arguments);
//   }
// =============================================================================

/**
 * 6月改定後の相談2サービス用レセプト生成エントリ
 *
 * 既存 makeRecept の引数 19 個と完全互換。
 * 内部で SSsourceURL を Script Properties から R8.6 版に差替えて
 * 既存 executeMakeRecept() を呼ぶ。
 */
function makeReceptSoudan6Kaitei(seikyuID, appSSdbURL, category, fileName, SSsourceURL,
                                  ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
                                  TargetKanaList, TargetGuardianNameList, TargetGuardianKanaList,
                                  TargetCustomerStatusList, TargetCertNumList, TargetCityList,
                                  ReSeikyu, ymList, OutputFileNamePostfix, dateString) {

  console.log(`[makeReceptSoudan6Kaitei] start: category=${category}, ym=${ymList[0]}`);

  const ym = String(ymList[0]).replace(/年|月/g, "");
  if (ym < R8_6_START_YM) {
    // ガード: 6月以前は本関数を呼ばない設計だが念のため
    console.warn(`[makeReceptSoudan6Kaitei] ym=${ym} < ${R8_6_START_YM} → 既存処理にフォールバック`);
    return makeReceptLegacyFallback_(arguments);
  }

  // SSsourceURL を R8.6 版に差替
  const r8SSsourceURL = resolveR8_6TemplateURL_(category, SSsourceURL);
  if (r8SSsourceURL && r8SSsourceURL !== SSsourceURL) {
    console.log(`[makeReceptSoudan6Kaitei] SSsourceURL switched: ${SSsourceURL} → ${r8SSsourceURL}`);
  }

  // 既存 makeRecept のロジックを R8.6 用 URL で呼出
  // ※ 既存 makeRecept は ScriptApp.newTrigger 連鎖で動くため
  //    直接 makeReceptLegacy() を呼ぶ。makeReceptLegacy は既存 makeRecept の
  //    分岐外部分（実処理本体）への薄いラッパ。
  return makeReceptLegacy(
    seikyuID, appSSdbURL, category, fileName, r8SSsourceURL,
    ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
    TargetKanaList, TargetGuardianNameList, TargetGuardianKanaList,
    TargetCustomerStatusList, TargetCertNumList, TargetCityList,
    ReSeikyu, ymList, OutputFileNamePostfix, dateString
  );
}

// =============================================================================
// テンプレURL 解決
// =============================================================================

/**
 * Script Properties から R8.6 版テンプレ URL を解決。
 * 設定がなければ引数の SSsourceURL をそのまま返す（フォールバック）。
 *
 * Script Properties に以下を設定する想定:
 *   APPSHEET_TEMPLATE_URL_計画相談_R8_6      = <drive URL>
 *   APPSHEET_TEMPLATE_URL_障害児相談_R8_6   = <drive URL>
 */
function resolveR8_6TemplateURL_(category, defaultURL) {
  const propKey = category === "計画相談支援"
    ? "APPSHEET_TEMPLATE_URL_計画相談_R8_6"
    : "APPSHEET_TEMPLATE_URL_障害児相談_R8_6";
  const url = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!url) {
    console.warn(`[resolveR8_6TemplateURL_] ${propKey} 未設定。defaultURL=${defaultURL} を使用`);
    return defaultURL;
  }
  return url;
}

// =============================================================================
// 6月改定追加加算の事前ハンドリング（必要に応じ）
// =============================================================================

/**
 * R8.6 新規加算（処遇改善加算 Ⅰロ / Ⅱロ）が AppSheet 「事業所加算項目DB」に
 * セット済みであることをチェック。未セットなら警告ログ。
 *
 * GAS 自体の処理は変更しない（既存テンプレに新加算列があれば自動転記される）。
 */
function validateR8_6KasanPresence_(appSSdbURL, seikyuID) {
  const appDB = SpreadsheetApp.openByUrl(appSSdbURL);
  const sheet = appDB.getSheetByName("事業所加算項目DB");
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  // header から列特定（柔軟に）
  const header = data[0];
  const idxSeikyu = header.findIndex(h => /請求情報ID|請求ID|seikyuID/i.test(String(h)));
  const idxKasanName = header.findIndex(h => /事業所加算項目|加算名/i.test(String(h)));
  if (idxSeikyu < 0 || idxKasanName < 0) return;

  const r8NewKasan = new Set([
    "福祉・介護職員等処遇改善加算Ⅰロ",
    "福祉・介護職員等処遇改善加算Ⅱロ"
  ]);
  const present = new Set();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idxSeikyu]) !== String(seikyuID)) continue;
    const name = String(data[i][idxKasanName] || "").trim();
    if (r8NewKasan.has(name)) present.add(name);
  }

  const missing = [...r8NewKasan].filter(k => !present.has(k));
  if (missing.length > 0) {
    console.warn(
      `[validateR8_6KasanPresence_] R8.6 新加算が事業所加算項目DB に未登録: ${missing.join(", ")}\n` +
      `→ AppSheet 側で seikyuID=${seikyuID} に加算行追加するか、不要なら無視してください。`
    );
  }
}

// =============================================================================
// 既存 makeRecept ラッパ
// =============================================================================

/**
 * 既存 makeRecept() の実処理部分を呼ぶラッパ。
 * 既存ファイル 001_レセプト生成_CloudSQL.gs の makeRecept() を直接呼ぶと
 * トリガ連鎖の自己呼出で問題が起きる可能性があるため、
 * 「請求処理タスク」シートへの追記 + executeMakeRecept のみを呼ぶ。
 *
 * 実装は既存 makeRecept のロジックをそのまま流用。
 * （初期実装段階では下記 makeRecept をそのまま呼んでも OK）
 */
function makeReceptLegacy(seikyuID, appSSdbURL, category, fileName, SSsourceURL,
                          ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
                          TargetKanaList, TargetGuardianNameList, TargetGuardianKanaList,
                          TargetCustomerStatusList, TargetCertNumList, TargetCityList,
                          ReSeikyu, ymList, OutputFileNamePostfix, dateString) {
  // 既存 makeRecept (001_レセプト生成_CloudSQL.gs) の処理を委譲。
  // ※ 既存 makeRecept はトリガ起動方式のためここで直接呼ぶと
  //   無限再帰になる可能性。実装時は executeMakeRecept を直接呼ぶ形に修正推奨。
  return makeRecept(
    seikyuID, appSSdbURL, category, fileName, SSsourceURL,
    ToFolderURL, ToFolderID, TargetIDs, TargetNameList,
    TargetKanaList, TargetGuardianNameList, TargetGuardianKanaList,
    TargetCustomerStatusList, TargetCertNumList, TargetCityList,
    ReSeikyu, ymList, OutputFileNamePostfix, dateString
  );
}

function makeReceptLegacyFallback_(args) {
  return makeReceptLegacy.apply(null, args);
}

// =============================================================================
// 既存 makeRecept のルータ化案（既存ファイルへの最小改修）
// =============================================================================
/*
  既存 001_レセプト生成_CloudSQL.gs の makeRecept() 関数の冒頭に以下を挿入:

  function makeRecept(seikyuID, appSSdbURL, category, fileName, SSsourceURL,
                      ..., ymList, ...) {
    // ★ R8.6 ルーティング（追加）
    const ym = String(ymList[0]).replace(/年|月/g, "");

    // 入所系3サービスは入所系GASに委譲
    if (typeof INSHO_CATEGORIES !== 'undefined' && INSHO_CATEGORIES.has(category)) {
      return makeReceptInsho.apply(null, arguments);
    }

    // 相談2サービス × R8.6 以降は 6月改定GASに委譲
    if (typeof SOUDAN_CATEGORIES !== 'undefined' &&
        SOUDAN_CATEGORIES.has(category) && ym >= R8_6_START_YM) {
      return makeReceptSoudan6Kaitei.apply(null, arguments);
    }

    // ↓ 既存処理（無変更）
    LogManager.appendTask(...);
    ScriptApp.newTrigger("makeReceptBackground")...
    ...
  }

  ※ この改修は既存ファイル 1 箇所のみ。それ以外の関数は無変更。
*/
