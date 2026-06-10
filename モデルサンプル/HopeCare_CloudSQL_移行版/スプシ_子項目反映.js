/**
 * [RETIRED] スプシ子項目反映（非同期タスクキュー版）
 *
 * ============================================================
 *  退役日: 2026-04-23
 * ============================================================
 * AppSheet Bot から呼び出され、タスク管理シートに登録 → 時間ベースのトリガーで
 * 順次処理する非同期キュー方式のスプシ子項目反映処理。
 *
 * 退役理由:
 *   - 運用は CloudSQL 版 `スプシ_子項目反映_CloudSQL.js` に完全移行済み
 *   - 新版の `processPendingTasks_ssToChild_CloudSQL` が時間ベーストリガーで稼働中
 *   - 旧版関数 (registerTask_ssToChild / processPendingTasks_ssToChild) は
 *     AppSheet Automation・GAS トリガーのいずれからも呼び出されていないことを確認済み
 *   - 本ファイルは既に全関数がコメントアウト済みだったが、方針統一のため退役メッセージに置換
 *
 * 元のコードは GAS のバージョン履歴から復元可能です。
 *   Version 2: "Before stage2 cleanup - retire legacy non-CloudSQL scripts"
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */
