/**
 * =======================================================
 * AIテキストリセット用
 * AppSheetから呼び出され、全件再取得（リセット）のキューを積む
 * =======================================================
 */

function enqueueAIContextResetTask(targetId) {
  if (!targetId) return;

  // 200_AIテキスト生成キュ.gs で定義済みの定数を利用
  const ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);

  // ステータス "RESET_PENDING" で登録する（通常は "PENDING"）
  const queueId = Utilities.getUuid();
  sheet.appendRow([
    targetId,
    "RESET_PENDING", // ★ここがポイント
    new Date(),
    "",
    "手動リセット要求",
    queueId,
  ]);

  return { result: "Reset Queued", id: targetId, queueId: queueId };
}
