/**
 * [RETIRED] 子項目のスプシ反映（textPaste をスプレッドシートに一括反映）
 *
 * ============================================================
 *  退役日: 2026-04-23
 * ============================================================
 * 生成済みスプレッドシート URL に対して textPaste ("&&KEY&&VALUE,...") を一括反映する
 * 処理。既存値がある場合はプルダウン化して候補に追加、既にプルダウン付きなら候補に
 * 追記（重複除外）する仕様。
 *
 * 退役理由:
 *   - 運用は CloudSQL 版 `子項目_スプシ反映_CloudSQL.js` に完全移行済み
 *   - AppSheet Bot「子項目_スプシ反映」から新版 applyTextPasteToSpreadsheetUrl_CloudSQL
 *     を呼び出すよう切替済み
 *   - 旧版関数 applyTextPasteToSpreadsheetUrl はどこからも呼ばれていないことを確認済み
 *
 * 元のコードは GAS のバージョン履歴から復元可能です。
 *   Version 2: "Before stage2 cleanup - retire legacy non-CloudSQL scripts"
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */
