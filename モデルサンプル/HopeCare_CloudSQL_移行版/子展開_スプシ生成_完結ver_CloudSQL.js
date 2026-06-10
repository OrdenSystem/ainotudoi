/**
 * STEP01：子レコード展開 → （通常）テンプレから帳票生成 or （コピー時）既存帳票を複製
 * - コピー時(existingSpreadsheetUrlあり)：複製したURLを返して終了（textPasteは不要）
 * - 通常時(existingSpreadsheetUrlなし)：originalFileMake_Sync_Ontime で生成しURL返却（textPaste使用）
 */

function STEP01_ChildAndMakeSpreadsheet_CloudSQL(
  parentid, refId, parentName, surceFileUrl, driveURL, textPaste, zaisekiID, fileRecordID, fileName,
  googleFolderName, customerDriveURL, office, existingSpreadsheetUrl
) {
  try {
    // ② 子レコード展開（先に・必ず実行／フォルダ非依存）
    const childResult = STEP01_Add_Childrescords_CloudSQL(parentid, refId, parentName);
    if (typeof childResult === "string" && childResult.startsWith("❌")) return childResult;

    const hasExisting = existingSpreadsheetUrl && String(existingSpreadsheetUrl).trim() !== "";
    const payload = {
      parentid: parentid, refId: refId, parentName: parentName,
      surceFileUrl: surceFileUrl, driveURL: driveURL, textPaste: textPaste,
      zaisekiID: zaisekiID, fileRecordID: fileRecordID, fileName: fileName,
      googleFolderName: googleFolderName, customerDriveURL: customerDriveURL,
      office: office, existingSpreadsheetUrl: existingSpreadsheetUrl, _attempt: 0
    };

    // ① コピー時：まず同期で複製を試す
    if (hasExisting) {
      const copiedUrl = copyExistingSpreadsheetIfNeeded_step01_(
        existingSpreadsheetUrl, driveURL, fileName, googleFolderName, customerDriveURL, office, zaisekiID
      );
      if (String(copiedUrl).indexOf("エラー：") === 0) {
        enqueueHyohyoSpushiJob_(payload);                 // 失敗 → 後追い非同期
        return "受付完了：フォルダ準備待ちのため後追い生成します";
      }
      recordPlaceholderPositionsToMaster_step01_(parentid, copiedUrl);
      return copiedUrl;                                    // 成功 → 即URL（従来どおり）
    }

    // ⑤ 通常時：まず同期でテンプレ生成を試す
    recordPlaceholderPositionsToMaster_step01_(parentid, surceFileUrl);
    var tp = (textPaste == null || String(textPaste).trim() === "") ? "&&DUMMY&&" : textPaste;
    const result = originalFileMake_Sync_Ontime(
      surceFileUrl, driveURL, tp, zaisekiID, fileRecordID, fileName, googleFolderName, customerDriveURL, office
    );
    if (typeof result === "string" && result.indexOf("http") === 0) {
      return result;                                       // 成功 → 即URL（従来どおりの速さ）
    }
    enqueueHyohyoSpushiJob_(payload);                      // 失敗 → 後追い非同期
    return "受付完了：フォルダ準備待ちのため後追い生成します";

  } catch (e) {
    return `❌ STEP01でエラー：${e.message}`;
  }
}

/**
 * 子展開：マスタ（ひな型帳票マスタ子レコード）から該当親ID分の行を取り出し
 * DB（帳票子レコード複製登録）へ重複除外して追記する
 */
function STEP01_Add_Childrescords_CloudSQL(parentid, refId, parentName) {
  let returnValue = "";

  try {
    const Parentid = parentid;
    const Reftid = refId;

    const originalFileId = getConfigId_('MASTER_SS_ID');
    const original = SpreadsheetApp.openById(originalFileId);
    const sheet_original = original.getSheetByName("ひな型帳票マスタ子レコード");

    // ★ CloudSQL移行版: 重複チェック用データをJDBCから取得（対象の帳票マスタIDで絞り込み）
    var dbConn = getCloudSqlConnection_();
    var dbStmt, dbRs;
    const existingKeys = new Set();
    try {
      dbStmt = dbConn.prepareStatement(
        'SELECT "帳票マスタ複製登録ID", "帳票名", "&&項目名&&", "シート名セル位置", "項目データ型選択", "表示用順位付け" ' +
        'FROM "帳票子レコード複製登録" WHERE "帳票マスタ複製登録ID" = ?'
      );
      dbStmt.setString(1, refId);
      dbRs = dbStmt.executeQuery();
      while (dbRs.next()) {
        var key = [
          dbRs.getString("帳票マスタ複製登録ID") || "",
          dbRs.getString("帳票名") || "",
          dbRs.getString("&&項目名&&") || "",
          dbRs.getString("シート名セル位置") || "",
          dbRs.getString("項目データ型選択") || "",
          dbRs.getString("表示用順位付け") || ""
        ].join('|');
        existingKeys.add(key);
      }
    } finally {
      closeCloudSql_(null, dbStmt, dbRs);
      // dbConnはINSERTで再利用するのでまだ閉じない
    }

    const originalData = sheet_original.getDataRange().getValues().slice(1);
    const rowsToAdd = [];

    originalData.forEach(row => {
      if (row[1] == Parentid) {
        const newKey = [Reftid, ...row.slice(2, 7)].join('|'); // B～G相当のキー

        if (!existingKeys.has(newKey)) {
          const uniqueId = generateUniqueId_step01_(16);
          const valuesFromCToG = row.slice(2, 7);
          const newRow = [uniqueId, Reftid, ...valuesFromCToG];
          rowsToAdd.push(newRow);
          existingKeys.add(newKey);
        }
      }
    });

    // ★ CloudSQL移行版: JDBC INSERTで子レコードを追加
    if (rowsToAdd.length > 0) {
      try {
        dbConn.setAutoCommit(false);
        var insertStmt = dbConn.prepareStatement(
          'INSERT INTO "帳票子レコード複製登録" ' +
          '("帳票子レコード複製登録ID", "帳票マスタ複製登録ID", "帳票名", "&&項目名&&", "シート名セル位置", "項目データ型選択", "表示用順位付け") ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT ("帳票子レコード複製登録ID") DO NOTHING'
        );

        for (var ri = 0; ri < rowsToAdd.length; ri++) {
          var nr = rowsToAdd[ri];
          insertStmt.setString(1, nr[0]); // 帳票子レコード複製登録ID
          insertStmt.setString(2, nr[1]); // 帳票マスタ複製登録ID
          for (var pi = 2; pi < nr.length; pi++) {
            var v = nr[pi];
            if (v === null || v === undefined || v === '') {
              insertStmt.setNull(pi + 1, 0);
            } else if (typeof v === 'number' && pi === 6) {
              insertStmt.setInt(pi + 1, v); // 表示用順位付け
            } else {
              insertStmt.setString(pi + 1, String(v));
            }
          }
          insertStmt.addBatch();
        }
        insertStmt.executeBatch();
        dbConn.commit();
        insertStmt.close();
      } catch (insErr) {
        try { dbConn.rollback(); } catch (re) {}
        throw insErr;
      } finally {
        closeCloudSql_(dbConn);
      }

      returnValue = `✅ 子レコード追加完了：${rowsToAdd.length} 件`;
    } else {
      closeCloudSql_(dbConn);
      returnValue = "ℹ️ 子レコード追加：追加対象なし";
    }

  } catch (e) {
    const errorMessage = `
--------------------------------------
🚨 GASエラー通知（帳票子レコード追加）
--------------------------------------
${e.message}

${e.stack}
--------------------------------------
`;
    // sendSlackNotification(errorMessage); // 必要に応じて有効化
    returnValue = `❌ 子レコード追加でエラー：${e.message}`;
  }

  return returnValue;
}


// =====================================================
// ヘルパー関数群
// =====================================================
// 旧版「子展開_スプシ生成_完結ver.js」が 2026-04-23 に退役（空ファイル化）された際に
// グローバルから消えた 4 関数を本ファイルに移植して復旧したもの。
// - generateUniqueId_step01_
// - mergeCsvUnique_step01_
// - recordPlaceholderPositionsToMaster_step01_
// - copyExistingSpreadsheetIfNeeded_step01_
// 将来 helpers 用ファイルに再分離する場合は、本ブロックを丸ごと移動すれば良い。


/**
 * テンプレ/複製スプシの中にある &&KEY&& の「セル位置」を
 * 「ひな型帳票マスタ子レコード」シートの H～V（型別）に記録する。
 * （高速化：配列メモリ一括更新版）
 *
 * @param {string} parentid    ひな型帳票マスタID（B列と一致する想定）
 * @param {string} surceFileUrl テンプレスプシURL or 複製スプシURL
 */
function recordPlaceholderPositionsToMaster_step01_(parentid, surceFileUrl) {
  const masterSpreadsheetId = getConfigId_('MASTER_SS_ID');
  const masterSheetName = 'ひな型帳票マスタ子レコード';

  if (!parentid) throw new Error("recordPlaceholderPositionsToMaster_: parentid が空です");
  if (!surceFileUrl) throw new Error("recordPlaceholderPositionsToMaster_: surceFileUrl が空です");

  const idMatch = String(surceFileUrl).match(/[-\w]{25,}/);
  if (!idMatch) throw new Error("recordPlaceholderPositionsToMaster_: surceFileUrl からID抽出できません");
  const scanSpreadsheetId = idMatch[0];

  // 型 → マスタ列（H=8 ... V=22）対応 ※配列インデックス用
  const typeToCol = {
    "日付": 8, "日時": 9, "テキスト": 10, "ロングテキスト": 11,
    "単一選択肢": 12, "複数選択肢": 13, "数値": 14, "数値_小数点": 15,
    "パーセント": 16, "電話番号": 17, "メールアドレス": 18, "住所": 19,
    "画像": 20, "ファイル": 21, "URL": 22,
  };

  // ===== 1) 対象スプシを走査して &&KEY&& の位置を集める =====
  const scanSS = SpreadsheetApp.openById(scanSpreadsheetId);
  const scanSheets = scanSS.getSheets();
  const keyToPositions = new Map(); // key -> Set("Sheet!A1")

  scanSheets.forEach(sh => {
    // 高速検索
    const ranges = sh.createTextFinder("&&[^&]+&&")
      .useRegularExpression(true)
      .findAll();

    ranges.forEach(rg => {
      const v = rg.getDisplayValue();
      if (typeof v !== "string" || v.indexOf("&&") === -1) return;

      const matches = v.match(/&&([^&]+)&&/g);
      if (!matches) return;

      const pos = `${sh.getName()}!${rg.getA1Notation()}`;

      matches.forEach(m => {
        const key = m.replace(/^&&/, "").replace(/&&$/, "").trim();
        if (!key) return;

        if (!keyToPositions.has(key)) keyToPositions.set(key, new Set());
        keyToPositions.get(key).add(pos);
      });
    });
  });

  if (keyToPositions.size === 0) {
    console.log("[recordPlaceholderPositionsToMaster_] &&...&& が見つかりませんでした");
    return;
  }

  // ===== 2) マスタへ一括書き込み（高速化部分） =====
  const masterSS = SpreadsheetApp.openById(masterSpreadsheetId);
  const masterSheet = masterSS.getSheetByName(masterSheetName);
  if (!masterSheet) throw new Error(`recordPlaceholderPositionsToMaster_: シート「${masterSheetName}」が見つかりません`);

  const lastRow = masterSheet.getLastRow();
  if (lastRow < 2) return;

  // A～V（22列）を一括取得
  const range = masterSheet.getRange(1, 1, lastRow, 22);
  const values = range.getValues();
  let isUpdated = false;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    const rowParentId = String(row[1] ?? "").trim(); // B列 (index:1)
    if (rowParentId !== String(parentid).trim()) continue;

    const itemName = String(row[3] ?? "").trim(); // D列 (index:3)
    if (!itemName) continue;

    const type = String(row[5] ?? "").trim(); // F列 (index:5)
    const targetCol = typeToCol[type];
    if (!targetCol) continue;

    const posSet = keyToPositions.get(itemName);
    if (!posSet || posSet.size === 0) continue;

    const newPos = Array.from(posSet).join(",");
    const colIndex = targetCol - 1; // 配列は0始まりなので -1

    const current = String(row[colIndex] ?? "").trim();
    const merged = mergeCsvUnique_step01_(current, newPos);

    // 値に変化があれば配列を更新
    if (current !== merged) {
      values[r][colIndex] = merged;
      isUpdated = true;
    }
  }

  // メモリ上で書き換えた配列を、スプシへ1回で流し込む
  if (isUpdated) {
    range.setValues(values);
    SpreadsheetApp.flush();
    console.log(`[recordPlaceholderPositionsToMaster_] 一括記録完了: keys=${keyToPositions.size}`);
  }
}


/**
 * 既存スプシURLがある場合、そのスプシを指定フォルダへ複製して新URLを返す
 */
function copyExistingSpreadsheetIfNeeded_step01_(
  existingSpreadsheetUrl,
  driveURL,
  fileName,
  googleFolderName,
  customerDriveURL,
  office,
  zaisekiID
) {
  if (!existingSpreadsheetUrl || String(existingSpreadsheetUrl).trim() === "") return "";

  const idMatch = String(existingSpreadsheetUrl).match(/[-\w]{25,}/);
  if (!idMatch) return "エラー：既存スプシURLからIDを抽出できません。";

  let targetFolder = null;

  // A) driveURL優先
  if (driveURL) {
    try {
      const folderId = String(driveURL).match(/[-\w]{25,}/)[0];
      targetFolder = DriveApp.getFolderById(folderId);
    } catch (e) {}
  }

  // B) 階層検索（待機）
  if (!targetFolder) {
    if (!customerDriveURL) return "エラー：保存先が特定できません（customerDriveURL が空）。";

    const customerFolder = DriveApp.getFolderById(String(customerDriveURL).match(/[-\w]{25,}/)[0]);

    const officeFolders = customerFolder.getFoldersByName(office);
    if (!officeFolders.hasNext()) return `エラー：事業所フォルダ「${office}」が見つかりません。`;
    const officeFolder = officeFolders.next();

    const maxRetries = 10;
    const waitTime = 3000;

    for (let i = 0; i < maxRetries; i++) {
      const t = officeFolder.getFoldersByName(googleFolderName);
      if (t.hasNext()) {
        targetFolder = t.next();
        break;
      }
      Utilities.sleep(waitTime);
    }
    if (!targetFolder) return `エラー：フォルダ「${googleFolderName}」が見つかりません（待機タイムアウト）。`;

    if (zaisekiID) {
      try { postFolderUrlToExternalApp(targetFolder.getUrl(), zaisekiID); } catch (e) {}
    }
  }

  const srcFile = DriveApp.getFileById(idMatch[0]);

  const now = new Date();
  const ts = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMddHHmm");
  const newName = `${fileName}_複製_${ts}`;

  const copied = srcFile.makeCopy(newName, targetFolder);
  SpreadsheetApp.flush();

  return copied.getUrl();
}


/**
 * "a,b" + "b,c" を重複なしで "a,b,c" にする
 */
function mergeCsvUnique_step01_(a, b) {
  const set = new Set();
  String(a || "").split(",").map(s => s.trim()).filter(Boolean).forEach(x => set.add(x));
  String(b || "").split(",").map(s => s.trim()).filter(Boolean).forEach(x => set.add(x));
  return Array.from(set).join(",");
}


/**
 * 英数字のランダムIDを生成する
 * @param {number} length 生成する文字数（例：16）
 * @return {string}
 */
function generateUniqueId_step01_(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 帳票マスタ複製登録の「スプシURL」を書き戻す（非同期生成の結果反映用）
 * @param {string} refId 帳票マスタ複製登録ID（キー）
 * @param {string} url   生成したスプレッドシートURL（プレーン文字列）
 * @return {number} 更新件数
 */
function updateSpushiUrl_CloudSQL(refId, url) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var sql = 'UPDATE "帳票マスタ複製登録" SET "スプシURL" = ? WHERE "帳票マスタ複製登録ID" = ?';
    stmt = conn.prepareStatement(sql);
    stmt.setString(1, url);
    stmt.setString(2, refId);
    return stmt.executeUpdate();
  } catch (e) {
    Logger.log('updateSpushiUrl_CloudSQL エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

/**
 * 「帳票スプシ生成」ジョブをキュー(AIジョブキュー)へ登録し、即ディスパッチャを起動する
 * @param {Object} payload ファイル生成に必要な引数一式
 * @return {string} ジョブID
 */
function enqueueHyohyoSpushiJob_(payload) {
  var conn, stmt;
  try {
    conn = getCloudSqlConnection_();
    var jobId = Utilities.getUuid();
    var sql = 'INSERT INTO "AIジョブキュー" ("ジョブID","登録日時","ジョブタイプ","ペイロード","状態") VALUES (?, NOW(), ?, ?, ?)';
    stmt = conn.prepareStatement(sql);
    stmt.setString(1, jobId);
    stmt.setString(2, '帳票スプシ生成');
    stmt.setString(3, JSON.stringify(payload));
    stmt.setString(4, 'Pending');
    stmt.executeUpdate();
    triggerDispatcherAsync_CloudSQL_();   // 既存の即時ディスパッチ起動を流用
    return jobId;
  } catch (e) {
    Logger.log('enqueueHyohyoSpushiJob_ エラー: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn, stmt);
  }
}

/**
 * 【非同期ワーカー】キューから呼ばれ、ファイル複製/生成→スプシURL書き戻しを行う
 */
function runHyohyoSpushiGenerate_(p) {
  var MAX_ATTEMPTS = 5;
  var attempt = (p._attempt || 0);
  var surceFileUrl = p.surceFileUrl;
  var hasExisting = p.existingSpreadsheetUrl && String(p.existingSpreadsheetUrl).trim() !== "";

  // ① コピー時：既存スプシを複製
  if (hasExisting) {
    var copiedUrl = copyExistingSpreadsheetIfNeeded_step01_(
      p.existingSpreadsheetUrl, p.driveURL, p.fileName, p.googleFolderName, p.customerDriveURL, p.office, p.zaisekiID
    );
    if (String(copiedUrl).indexOf("エラー：") === 0) {
      return retryOrGiveUp_hyohyo_(p, attempt, MAX_ATTEMPTS, copiedUrl);
    }
    surceFileUrl = copiedUrl;
  }

  // ③ プレースホルダ位置の記録
  recordPlaceholderPositionsToMaster_step01_(p.parentid, surceFileUrl);

  // ④/⑤ URL確定（通常はテンプレ生成、コピー時は複製URL）
  var finalUrl;
  if (hasExisting) {
    finalUrl = surceFileUrl;
  } else {
    var textPaste = (p.textPaste == null || String(p.textPaste).trim() === "") ? "&&DUMMY&&" : p.textPaste;
    finalUrl = originalFileMake_Sync_Ontime(
      surceFileUrl, p.driveURL, textPaste, p.zaisekiID, p.fileRecordID, p.fileName, p.googleFolderName, p.customerDriveURL, p.office
    );
  }

  // 失敗（フォルダ未準備・パラメータ不足等）→ 再キュー or 上限で諦め
  if (typeof finalUrl !== "string" || finalUrl.indexOf("http") !== 0) {
    return retryOrGiveUp_hyohyo_(p, attempt, MAX_ATTEMPTS, finalUrl);
  }

  // ★ URLをDBへ書き戻し（AppSheetに反映＝Open(スプシ)ボタンが出る）
  updateSpushiUrl_CloudSQL(p.fileRecordID, finalUrl);
  return "スプシ生成・書き戻し完了: " + finalUrl;
}

/**
 * 失敗時：上限内なら再キュー、上限超で例外（Failedとして記録）
 */
function retryOrGiveUp_hyohyo_(p, attempt, max, reason) {
  if (attempt + 1 < max) {
    var next = JSON.parse(JSON.stringify(p));
    next._attempt = attempt + 1;
    enqueueHyohyoSpushiJob_(next);
    return "フォルダ未準備のため再キュー (" + (attempt + 1) + "/" + max + "): " + reason;
  }
  throw new Error("リトライ上限到達。生成失敗: " + reason);
}
