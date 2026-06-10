/**
 * [RETIRED] ひな型複製・帳票登録のメンテナンス整理（CloudSQL版）
 *
 * ============================================================
 *  退役日: 2026-04-27
 * ============================================================
 * 旧スプシ版 (`ひな型複製_帳票登録_整理.js`) を CloudSQL 対応に書き換えた
 * バージョン。maintenanceStep1_Enqueue_CloudSQL / maintenanceStep2_ProcessQueue_CloudSQL /
 * createAnalysisReport_CloudSQL の 3 段構成。
 *
 * 退役理由:
 *   - 元々の目的は AppSheet がスプレッドシートを読む際の速度改善のため、
 *     古い完了帳票を Drive に CSV エクスポートして物理的に分離する運用
 *   - CloudSQL 移行後は AppSheet が CloudSQL を読むため、テーブル行数の
 *     増加が AppSheet 速度に直接影響しない（Security Filter / Slice で対応）
 *   - 本機能は CloudSQL からデータを削除する処理を含まず、CSV を Drive に
 *     出力するだけ → CloudSQL データ量は減らない → 機能として実質無意味
 *   - AppSheet Bot / GAS トリガーのいずれからも呼び出されていないことを確認済み
 *     （HopeCare_CloudSQL_移行版 のトリガー一覧で 2026-04-27 確認）
 *
 * 関連リソース（参考、後日整理）:
 *   - QUEUE_SS_ID: 1rOA14Hv-luFth4UexDFugkoFV60OYzzVuCYdAZVZD2E（ユーザーが削除予定）
 *   - PARENT_FOLDER_ID: 10U-Jngn_CQlIlrhHIIJSorxHuaQ35o9N（過去 CSV のアーカイブ）
 *
 * 退役方法:
 *   - clasp の仕様上、ローカル削除＋push では GAS 側からファイル削除されない
 *   - 本ファイルは退役マーク内容で上書き → 機能停止
 *   - 完全削除は GAS UI から手動で実施予定
 *
 * 元のコードは GAS のバージョン履歴から復元可能。
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */
