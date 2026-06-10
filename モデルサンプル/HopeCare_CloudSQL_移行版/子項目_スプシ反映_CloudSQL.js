/**
 * 生成済みスプレッドシートURLに textPaste を反映（一括キャッシュ・超高速版）
 * 追加仕様：
 * - 既存値がある場合は「|追記」ではなく、セルをプルダウン化して候補に追加し、新規値をセルに反映
 * - 既にプルダウンが付いている場合は、その候補に追記（重複除外）
 *
 * @param {string} spreadsheetUrl
 * @param {string} textPaste   "&&KEY&&VALUE,&&KEY2&&VALUE2, ..."
 * @param {string} reportMasterId（任意・推奨）
 * @return {string} 1行目URL + 日本語ログ（LongText）
 */
function applyTextPasteToSpreadsheetUrl_CloudSQL(spreadsheetUrl, textPaste, reportMasterId) {
  const logs = [];
  const start = new Date();

  try {
    // --- 入力チェック ---
    if (!spreadsheetUrl) return "エラー：spreadsheetUrl が空です。";
    const idMatch = String(spreadsheetUrl).match(/[-\w]{25,}/);
    if (!idMatch) return "エラー：spreadsheetUrl からIDを取得できません。";
    const spreadsheetId = idMatch[0];

    if (!textPaste || String(textPaste).trim() === "") {
      return `${spreadsheetUrl}\nエラー：textPaste が空です。`;
    }

    const pasteMap = parseTextPasteToMap_applyToSs_(String(textPaste));
    if (pasteMap.size === 0) {
      return `${spreadsheetUrl}\nエラー：textPaste の形式が不正です。`;
    }

    logs.push("【開始】帳票項目反映処理（プルダウン追記版・高速化）");
    logs.push(`・対象URL：${spreadsheetUrl}`);
    logs.push(`・受信項目数：${pasteMap.size}`);
    if (reportMasterId) logs.push(`・帳票マスタ複製登録ID：${reportMasterId}`);

    const ss = SpreadsheetApp.openById(spreadsheetId);

    // --- DBから「項目 → セル位置」を取得 ---
    const keyToPositions = getKeyToPositionsFromDb_applyToSs_CloudSQL_(spreadsheetUrl, reportMasterId);
    if (keyToPositions.size === 0) {
      return `${spreadsheetUrl}\nエラー：DBにセル位置が登録されていません。`;
    }
    logs.push(`・DBセル位置取得件数：${keyToPositions.size}`);

    let 書込 = 0;
    let プルダウン化 = 0;
    let 候補追記 = 0;
    let 同一 = 0;
    let 空値 = 0;
    let 位置不明 = 0;
    let 初期アンパサンド削除 = 0;
    const 未登録キー = new Set();

    // =====================================================
    // 高速化：全対象セルを「シートごと」に整理する
    // =====================================================
    const sheetActions = new Map(); // sheetName -> Map<A1, actionData>

    keyToPositions.forEach((posList, key) => {
      const isPasteTarget = pasteMap.has(key);
      const pasteValue = isPasteTarget ? String(pasteMap.get(key) ?? "").trim() : "";

      if (isPasteTarget && !pasteValue) {
        空値++;
      }

      posList.forEach(pos => {
        const parsed = parseSheetA1_applyToSs_(pos);
        if (!parsed) {
          位置不明++;
          return;
        }

        if (!sheetActions.has(parsed.sheetName)) {
          sheetActions.set(parsed.sheetName, new Map());
        }

        // 整理（同じセルに複数キーがある場合は後勝ち）
        sheetActions.get(parsed.sheetName).set(parsed.a1, {
          key: key,
          isPasteTarget: isPasteTarget,
          pasteValue: pasteValue
        });
      });
    });

    // DB未登録のキーをチェック
    pasteMap.forEach((_, key) => {
      if (!keyToPositions.has(key) || keyToPositions.get(key).length === 0) {
        未登録キー.add(key);
      }
    });

    // =====================================================
    // シートごとに一括処理（キャッシュ利用で通信激減）
    // =====================================================
    sheetActions.forEach((actionsMap, sheetName) => {
      const sh = ss.getSheetByName(sheetName);
      if (!sh) {
        位置不明 += actionsMap.size;
        return;
      }

      // シート全体のデータを一括キャッシュ
      const maxRow = sh.getLastRow();
      const maxCol = sh.getLastColumn();
      let cacheData = [];
      if (maxRow > 0 && maxCol > 0) {
        cacheData = sh.getRange(1, 1, maxRow, maxCol).getDisplayValues();
      }

      actionsMap.forEach((action, a1) => {
        const { isPasteTarget, pasteValue } = action;

        // キャッシュから現在値を取得
        const posIdx = a1ToRowCol_applyToSs_(a1);
        let currentRaw = "";
        if (posIdx && posIdx.row - 1 < cacheData.length && posIdx.col - 1 < cacheData[0].length) {
          currentRaw = String(cacheData[posIdx.row - 1][posIdx.col - 1] ?? "").trim();
        }

        // 現在値に含まれる &&...&& をきれいにした文字列
        const currentCleaned = currentRaw.replace(/&&[^&]+&&/g, "").trim();
        const hasAmp = (currentRaw !== currentCleaned);
        const rg = sh.getRange(a1);

        // ▼ パターンA：上書き＆プルダウン化する対象
        if (isPasteTarget && pasteValue) {
          if (currentCleaned === pasteValue) {
            同一++;
            // 値は同じでも、&&が残っていれば消す処理だけしておく
            if (hasAmp) {
               rg.setValue(currentCleaned);
               初期アンパサンド削除++;
            }
            return;
          }

          if (hasAmp) 初期アンパサンド削除++;

          // 空ならそのまま上書き
          if (currentCleaned === "") {
            rg.setValue(pasteValue);
            書込++;
            return;
          }

          // プルダウン候補へ追加して、セル値は pasteValue にする
          const beforeList = getDropdownCandidates_applyToSs_(rg);
          const set = new Set(beforeList.map(x => String(x).trim()));
          set.add(currentCleaned); // 既存値も候補に残す
          set.add(pasteValue);     // 新規値を追加

          const candidates = Array.from(set).filter(Boolean);
          const hadDropdown = beforeList.length > 0;

          setDropdown_applyToSs_(rg, candidates);

          if (!hadDropdown) プルダウン化++;
          else 候補追記++;

          rg.setValue(pasteValue);
          書込++;

        } 
        // ▼ パターンB：上書き対象ではないが、&&...&& が残っているなら消す
        else if (hasAmp) {
          rg.setValue(currentCleaned);
          初期アンパサンド削除++;
        }
      });
    });

    SpreadsheetApp.flush();

    // --- ログまとめ ---
    logs.push("【結果】");
    logs.push(`・書き込み：${書込}`);
    logs.push(`・プルダウン新規作成セル数：${プルダウン化}`);
    logs.push(`・プルダウン候補追記セル数：${候補追記}`);
    logs.push(`・初期 &&...&& 削除セル数：${初期アンパサンド削除}`);
    logs.push(`・同一スキップ：${同一}`);
    logs.push(`・空値スキップ：${空値}`);
    logs.push(`・位置不明：${位置不明}`);
    if (未登録キー.size > 0) {
      logs.push(`・DB未登録キー：${Array.from(未登録キー).join("、")}`);
    }
    logs.push(`・処理時間：${new Date() - start} ms`);
    logs.push("【終了】");

    return `${spreadsheetUrl}\n${logs.join("\n")}`;

  } catch (e) {
    logs.push(`【例外】${e.message}`);
    return `${spreadsheetUrl}\n${logs.join("\n")}`;
  }
}

// =================================================================
// ヘルパー関数群
// 旧版「子項目_スプシ反映.js」が 2026-04-23 に退役（空ファイル化）された際に
// グローバルから消えた 5 関数を本ファイルに移植して復旧したもの。
// - parseTextPasteToMap_applyToSs_
// - parseSheetA1_applyToSs_
// - a1ToRowCol_applyToSs_
// - getDropdownCandidates_applyToSs_
// - setDropdown_applyToSs_
// （getKeyToPositionsFromDb_applyToSs_ は CloudSQL 版 _CloudSQL_ に置換済みのため移植不要）
// =================================================================

function parseTextPasteToMap_applyToSs_(textPaste) {
  const map = new Map();
  const items = String(textPaste).trim().split(/,\s*(?=&&)/);

  items.forEach(item => {
    const m = item.trim().match(/^&&(.+?)&&([\s\S]*)$/);
    if (!m) return;
    map.set(String(m[1]).trim(), String(m[2] ?? "").trim());
  });

  return map;
}

function parseSheetA1_applyToSs_(text) {
  const m = String(text).match(/^(.+?)!([A-Z]+[0-9]+)$/i);
  if (!m) return null;
  return { sheetName: m[1], a1: m[2].toUpperCase() };
}

function a1ToRowCol_applyToSs_(a1) {
  const match = String(a1).match(/^([A-Z]+)([0-9]+)$/i);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const row = parseInt(match[2], 10);
  let col = 0;
  for (let i = 0; i < colStr.length; i++) col = col * 26 + (colStr.charCodeAt(i) - 64);
  return { row, col };
}

function getDropdownCandidates_applyToSs_(range) {
  const rule = range.getDataValidation();
  if (!rule) return [];
  const crit = rule.getCriteriaType();
  const args = rule.getCriteriaValues();
  if (crit === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && args && args[0]) {
    return Array.isArray(args[0]) ? args[0] : [];
  }
  return [];
}

function setDropdown_applyToSs_(range, candidates) {
  const MAX = 200;
  const list = (candidates || []).slice(0, MAX);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .setAllowInvalid(true)
    .build();
  range.setDataValidation(rule);
}

/**
 * ★ CloudSQL移行版: スプレッドシート → JDBC
 */
function getKeyToPositionsFromDb_applyToSs_CloudSQL_(spreadsheetUrl, reportMasterId) {
  var conn, stmt, rs;
  const map = new Map();

  try {
    conn = getCloudSqlConnection_();

    var sql, param;
    if (reportMasterId) {
      sql = 'SELECT "&&項目名&&", "シート名セル位置" FROM "帳票子レコード複製登録" WHERE "帳票マスタ複製登録ID" = ?';
      param = String(reportMasterId).trim();
    } else if (spreadsheetUrl) {
      sql = 'SELECT "&&項目名&&", "シート名セル位置" FROM "帳票子レコード複製登録" WHERE "URL" = ?';
      param = String(spreadsheetUrl).trim();
    } else {
      return map;
    }

    stmt = conn.prepareStatement(sql);
    stmt.setString(1, param);
    rs = stmt.executeQuery();

    while (rs.next()) {
      var key = String(rs.getString("&&項目名&&") || "").trim();
      var pos = String(rs.getString("シート名セル位置") || "").trim();
      if (!key || !pos) continue;

      if (!map.has(key)) map.set(key, []);
      pos.split(",").forEach(function(p) { map.get(key).push(String(p).trim()); });
    }

    map.forEach(function(v, k) { map.set(k, Array.from(new Set(v))); });

  } finally {
    closeCloudSql_(conn, stmt, rs);
  }

  return map;
}

// ヘルパー関数は「子項目_スプシ反映.js」から共有利用