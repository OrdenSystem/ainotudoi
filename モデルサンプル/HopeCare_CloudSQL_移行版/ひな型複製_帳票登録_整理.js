/**
 * [RETIRED] ひな型複製・帳票登録のメンテナンス整理（旧スプシ版）
 *
 * ============================================================
 *  退役日: 2026-04-23（再退役: 2026-04-27）
 * ============================================================
 * 旧版関数 (maintenanceStep1_Enqueue / maintenanceStep2_ProcessQueue /
 * createAnalysisReport) は CloudSQL 版に完全移行済み。
 *
 * 2026-04-27 追加退役理由:
 *   - 本機能は元々 AppSheet がスプレッドシートを読む際の速度改善目的で
 *     古い完了帳票を CSV にエクスポートして物理的に分離する設計だった
 *   - CloudSQL 移行後は AppSheet が CloudSQL を読むため、テーブル行数の
 *     増加が AppSheet 速度に直接影響しなくなった
 *   - さらに本機能のコードは CloudSQL からデータを削除する処理を含まず、
 *     CSV を Drive に出力するだけ → CloudSQL データ量は減らない
 *   - つまり CloudSQL 移行と同時に本機能は実質的に意味を失った
 *   - AppSheet 速度改善は Security Filter / Slice / マテリアライズドビュー
 *     などで対応する方針
 *
 * 関連リソース（参考、後日整理）:
 *   - QUEUE_SS_ID: 1rOA14Hv-luFth4UexDFugkoFV60OYzzVuCYdAZVZD2E（ユーザーが削除予定）
 *   - PARENT_FOLDER_ID: 10U-Jngn_CQlIlrhHIIJSorxHuaQ35o9N（過去 CSV のアーカイブ）
 *
 * 元のコードは GAS のバージョン履歴から復元可能。
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */
