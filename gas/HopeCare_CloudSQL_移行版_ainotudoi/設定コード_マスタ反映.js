function test_fillSheetCellPositionsToChildRecordE() {
  // 作成済みの帳票マスタのIDをセット（Script Property "TEMPLATE_SS_ID" から取得）
  const templateSpreadsheetId = getConfigId_('TEMPLATE_SS_ID');
  const masterId = "ZZ1M9ZY0";  //ひな型帳票マスタIDをセット
  Logger.log(fillSheetCellPositionsToChildRecordE(templateSpreadsheetId, masterId));
}



function fillSheetCellPositionsToChildRecordE(templateSpreadsheetId, masterId) {

  const LIST_SPREADSHEET_ID = getConfigId_('MASTER_SS_ID');
  const ITEM_LIST_SHEET_NAME = 'ひな型帳票マスタ子レコード';

  if (!templateSpreadsheetId) throw new Error("templateSpreadsheetId が空です");
  if (!masterId) throw new Error("masterId が空です");

  // --- 1) 既存帳票スプシから &&項目&& の位置を収集 ---
  const ss = SpreadsheetApp.openById(templateSpreadsheetId);
  const sheets = ss.getSheets();

  const keyToPos = new Map();

  sheets.forEach(sh => {
    const ranges = sh.createTextFinder("&&[^&]+&&")
      .useRegularExpression(true)
      .findAll();

    ranges.sort((a, b) => a.getRow() - b.getRow() || a.getColumn() - b.getColumn());

    ranges.forEach(rg => {
      const text = rg.getDisplayValue();
      if (typeof text !== "string") return;

      const matches = text.match(/&&([^&]+)&&/g);
      if (!matches) return;

      const pos = `${sh.getName()}!${rg.getA1Notation()}`;

      matches.forEach(m => {
        const key = m.replace(/^&&/, "").replace(/&&$/, "").trim();
        if (!key) return;

        if (!keyToPos.has(key)) keyToPos.set(key, new Set());
        keyToPos.get(key).add(pos);
      });
    });
  });

  if (keyToPos.size === 0) {
    console.log("[fillSheetCellPositionsToChildRecordE] &&項目&& が見つかりませんでした");
    return "ℹ️ &&項目&& が見つかりませんでした";
  }

  // --- 2) 子レコードシート（E列）へ反映 ---
  const masterSS = SpreadsheetApp.openById(LIST_SPREADSHEET_ID);
  const childSheet = masterSS.getSheetByName(ITEM_LIST_SHEET_NAME);
  if (!childSheet) throw new Error(`シート「${ITEM_LIST_SHEET_NAME}」が見つかりません`);

  const lastRow = childSheet.getLastRow();
  if (lastRow < 2) return "ℹ️ 子レコードが空です";

  const data = childSheet.getRange(2, 1, lastRow - 1, 5).getValues();

  let updatedCount = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    const rowMasterId = String(row[1] ?? "").trim();  // B列
    if (rowMasterId !== String(masterId).trim()) continue;

    const itemName = String(row[3] ?? "").trim();     // D列
    if (!itemName) continue;

    // ★既にE列に値があるなら上書きしない（必要なら外してOK）
    const currentPos = String(row[4] ?? "").trim();   // E列
    if (currentPos) continue;

    const posSet = keyToPos.get(itemName);
    if (!posSet || posSet.size === 0) continue;

    row[4] = Array.from(posSet).join(",");
    updatedCount++;
  }

  childSheet.getRange(2, 1, data.length, 5).setValues(data);
  SpreadsheetApp.flush();

  return `✅ 反映完了：${updatedCount} 件のE列（シート名セル位置）を更新しました`;
}
