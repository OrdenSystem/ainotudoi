/**
 * [RETIRED] STEP01：子レコード展開 → 帳票生成（完結ver）
 *
 * ============================================================
 *  退役日: 2026-04-23
 * ============================================================
 * 帳票子レコードを展開し、ひな型テンプレから帳票を生成する STEP01 処理。
 * existingSpreadsheetUrl がある場合はコピー、無ければ新規生成（帳票生成_ひな型_同期ver の
 * originalFileMake_Sync_Ontime を呼び出し）するモード切替式。
 *
 * 退役理由:
 *   - 運用は CloudSQL 版 `子展開_スプシ生成_完結ver_CloudSQL.js` に完全移行済み
 *   - AppSheet Bot「帳票_子展開_自動化」から新版 STEP01_ChildAndMakeSpreadsheet_CloudSQL
 *     を呼び出すよう切替済み
 *   - 旧版ヘルパー (recordPlaceholderPositionsToMaster_step01_ 等) が新版と重複定義
 *     されており、グローバルスコープでの後勝ち衝突リスクがあった。退役により解消される
 *   - 共有関数 originalFileMake_Sync_Ontime は `帳票生成_ひな型_同期ver.js` に
 *     存在し、新版からも引き続き呼ばれるため影響なし
 *
 * 元のコードは GAS のバージョン履歴から復元可能です。
 *   Version 2: "Before stage2 cleanup - retire legacy non-CloudSQL scripts"
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */
