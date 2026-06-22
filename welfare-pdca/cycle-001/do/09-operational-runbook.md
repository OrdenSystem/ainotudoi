---
cycle: "001"
related_spec_sections: ["§6.Must.9", "§7（受入基準: 運用性）"]
streams_independent_of: ["02", "03", "04", "06", "07"]
---

# 09. 障害時運用 Runbook（最小）

> 対応 spec.md: §6.Must.9（障害時 Runbook）/ §7 受入基準「3シナリオ × （検知・暫定対応・復旧）表形式・RPO/RTO 数値」
>
> **RPO ≤ 1時間 / RTO ≤ 4時間**（仮置き数値 — spec §7 受入基準。実際の SLA は事業所サイドで確認・合意が必要）
> **法務レビュー要フラグ**: 個人情報を含むバックアップデータの取扱いは法務確認要（L-07）

---

## 1. RPO / RTO 方針

| 指標 | 数値（仮置き）| 根拠 |
|---|---|---|
| **RPO**（Recovery Point Objective）| ≤ 1 時間 | CloudSQL 自動バックアップ（毎日 1:00 JST）+ PITR（1分粒度）。最悪ケースでも 1 時間以内のデータ損失に抑制可能。GAS バッチ差分同期も 1 時間ごとのためデータ差分は最大 1 時間分。 |
| **RTO**（Recovery Time Objective）| ≤ 4 時間 | CloudSQL PITR リストア（東京リージョン内）の実測目安が 1〜2 時間。確認・切替・動作検証を含め 4 時間以内を目標とする。 |

---

## 2. バックアップ設定

| 対象 | バックアップ方式 | 保持世代/期間 | 復旧操作 |
|---|---|---|---|
| CloudSQL | 自動バックアップ（毎日 1:00 JST）| 7 世代（7 日間）| GCP コンソール / `gcloud sql backups restore` |
| CloudSQL | PITR（Point-in-Time Recovery）| 7 日間（1分粒度）| `gcloud sql instances restore-backup --restore-instance` |
| Salesforce | Salesforce Data Export（毎週自動）| 3 ヶ月保持 | Setup > Data Export からダウンロード・インポート |
| GAS スクリプト | Google Drive + Git 管理（推奨）| 無制限（Revision History）| Drive から復元 / git checkout |

---

## 3. 障害シナリオ × 3 列表

### シナリオ A: Salesforce 停止

| 項目 | 内容 |
|---|---|
| **検知方法** | 1. GAS バッチ `syncUsersFromSF` が連続 3 回失敗 → GAS 失敗通知メール（事業所管理者）<br/>2. AppSheet の Salesforce 読取テーブル（`sf_person_accounts` 等）が空または HTTP 503 エラー表示<br/>3. Salesforce Trust サイト（https://trust.salesforce.com）でインスタント通知を購読（推奨）|
| **暫定対応** | 1. AppSheet の Salesforce 参照テーブル（利用者マスタ表示）は**直前の CloudSQL `user_mirror` データで継続表示可能**（SoE は CloudSQL を主データソースのため）<br/>2. 新規利用者登録・支給決定更新は**停止**（SF が SoR のため。紙帳票で一時記録）<br/>3. サービス提供記録・シフト入力は CloudSQL 直接のため **AppSheet で通常通り継続可能**<br/>4. GAS バッチを一時停止し、再開時にフル同期を実施（管理者操作）|
| **復旧手順** | 1. Salesforce Trust サイトで復旧を確認<br/>2. `syncUsersFullFromSF()` を手動実行（全件フル同期）<br/>3. GAS トリガを再有効化<br/>4. AppSheet で利用者データの整合性を目視確認<br/>5. 停止中に紙帳票に記録したデータを Salesforce に手動入力<br/>6. `batch_run_log` で `failed` 状態のバッチを `voided` に更新|

---

### シナリオ B: CloudSQL 停止

| 項目 | 内容 |
|---|---|
| **検知方法** | 1. AppSheet の MySQL コネクタ接続エラー → AppSheet 画面に「データソース接続失敗」表示<br/>2. GAS バッチが JDBC 接続失敗で `batch_run_log` への書込も失敗 → GAS 失敗メール通知<br/>3. GCP コンソール > Cloud SQL > インスタンス詳細でステータス確認<br/>4. GCP Cloud Monitoring アラート（CPU/Memory/接続数スパイク）で事前検知|
| **暫定対応** | 1. AppSheet でのサービス記録入力・シフト管理が**停止**（CloudSQL が主データソース）<br/>2. 利用者情報は Salesforce 側で直接参照可能（SF コンソール / SF モバイル）<br/>3. **紙帳票でサービス記録を継続**（後で CloudSQL 復旧後に入力）<br/>4. GAS バッチを一時停止<br/>5. GCP コンソールで障害状況を確認（計画メンテナンスか障害か）|
| **復旧手順** | 1. CloudSQL が自動復旧しない場合: PITR リストアを実行<br/>&emsp;`gcloud sql instances clone welfare-db-instance welfare-db-restore --point-in-time YYYY-MM-DDThh:mm:ssZ`<br/>2. リストアインスタンスで動作確認（データ整合性チェック SQL 実行）<br/>3. AppSheet のデータソース接続をリストアインスタンスに切替（または DNS 変更）<br/>4. GAS の JDBC URL を新インスタンスに更新（Script Properties）<br/>5. GAS バッチを再起動し `syncUsersFromSF` + `syncAllotmentsFromSF` をフル実行<br/>6. 紙帳票から溜まったサービス記録を AppSheet で入力<br/>7. 月次バッチが中断していた場合は手動再実行<br/>8. 復旧後 24 時間以内に `audit_log` でデータ整合性を確認|

---

### シナリオ C: GAS 連携バッチ失敗

| 項目 | 内容 |
|---|---|
| **検知方法** | 1. GAS スクリプトエディタ → 実行 → 実行ログで失敗を確認<br/>2. `batch_run_log.status = 'failed'` を AppSheet AuditLogView で確認<br/>3. GAS 失敗メール通知（GAS デフォルトの失敗通知 + スクリプト内の明示的 `throw`）<br/>4. CloudSQL `user_mirror.sf_synced_at` が 2 時間以上更新されない場合の監視アラート（Cycle 2 実装推奨）|
| **暫定対応** | 1. **バッチ失敗は AppSheet の現場業務には直接影響しない**（AppSheet は CloudSQL と直接接続）<br/>2. 利用者マスタの新規追加・変更が CloudSQL に反映されない可能性がある（最大バッチ失敗期間分）<br/>3. 事業所管理者が `batch_run_log` を確認し、影響範囲（何件の更新が未反映か）を確認<br/>4. 重要な利用者変更（受給者証更新等）は Salesforce から手動で `user_mirror` を更新（管理者操作）|
| **復旧手順** | 1. GAS スクリプトエディタで失敗ログを確認し原因特定<br/>&emsp;- SF 認証失敗 → `getSalesforceAccessToken()` を手動実行してトークン確認<br/>&emsp;- CloudSQL 接続失敗 → `getCloudSqlConnection()` テスト実行<br/>&emsp;- SOQL エラー → SF API バージョン確認・SOQL 構文確認<br/>&emsp;- データ変換エラー → 問題レコードの SF データを確認・修正<br/>2. 原因修正後、`syncUsersFromSF()` を手動実行（`since` は最終成功時刻から再開）<br/>3. 複数バッチ分の差分が蓄積している場合は `syncUsersFullFromSF()` でフル同期<br/>4. 月次バッチ（`runMonthlyBilling`）が失敗した場合: エラー再実行手順は `06-gas-integrations.md` §4.4 参照<br/>5. `batch_run_log` の `failed` 行を確認し、再実行後に結果を確認|

---

## 4. リリース手順

### 4.1 通常リリース（設計変更を伴わない GAS 更新）

1. GAS スクリプトエディタでコードを更新
2. 変更内容をコメントに記録
3. `verifyConnection()` でテスト実行
4. 時間ベーストリガが自動的に新バージョンを実行

### 4.2 CloudSQL DDL 変更（スキーマ変更）

1. 変更 DDL を `welfare-pdca/cycle-XXX/do/03-cloudsql-ddl.sql` に記録
2. **バックアップ取得**（手動バックアップ: GCP コンソール）
3. DDL 変更をメンテナンスウィンドウ（深夜 2:00〜4:00 JST）で実施
4. GAS バッチ・AppSheet 接続の動作確認
5. 問題があれば PITR でロールバック

### 4.3 AppSheet 設定変更

1. AppSheet エディタでコピー版アプリを作成してテスト
2. テスト合格後、本番アプリに変更を適用
3. 変更内容を `batch_run_log`（イベント種別 = APP_UPDATE）として記録

### 4.4 Salesforce メタデータ変更

1. Salesforce Sandbox でテスト
2. Change Set または Deployment Tool で本番 Org へデプロイ
3. GAS の SOQL に影響する変更の場合は GAS も同時更新

---

## 5. ロールバック手順

| 対象 | ロールバック方法 | 所要時間目安 |
|---|---|---|
| CloudSQL DDL 変更 | PITR でメンテナンス前の時点に復元 | 1〜2 時間 |
| GAS スクリプト変更 | Google Drive の Revision History から旧バージョンを復元 | 15 分 |
| AppSheet 設定変更 | AppSheet エディタの「バージョン履歴」から旧バージョンに戻す | 30 分 |
| Salesforce メタデータ | Metadata API / Sandbox から旧 Change Set を再デプロイ | 1 時間 |

---

## 6. 定期保守タスク

| タスク | 頻度 | 担当 | 手順 |
|---|---|---|---|
| `audit_log` 保持期間チェック | 月次 | 事業所管理者 | 5年超のレコードを確認し定期バッチで削除（詳細は `08-security-and-privacy.md` §6 参照）|
| GAS トリガ実行状況確認 | 週次 | 事業所管理者 | `batch_run_log` で `failed` を確認 → 0件であることを確認 |
| CloudSQL ディスク使用量確認 | 月次 | 事業所管理者 | GCP コンソールで自動拡張が適切に機能しているか確認 |
| Salesforce 認証トークン確認 | 月次 | 事業所管理者 | `verifyConnection()` 手動実行でアクセストークン取得成功を確認 |
| バックアップ復旧テスト | 年次 | 事業所管理者 + 担当者 | CloudSQL リストアを検証環境で実施し RPO/RTO 目標を確認 |

---

## 7. 連絡先・エスカレーション

| レベル | 状況 | 対応者 | 方法 |
|---|---|---|---|
| L1 | GAS バッチ失敗（一時的）| 事業所管理者 | GAS ログ確認・手動再実行 |
| L2 | CloudSQL / SF 長期停止（1時間超）| 事業所管理者 + 担当開発者 | GCP サポート / Salesforce サポートへ問合せ |
| L3 | データ漏洩疑い・不正アクセス | 事業所管理者 + 法務担当 | `08-security-and-privacy.md` §7「インシデント対応」参照 |

---

## 8. 法務レビュー要フラグ（運用層）

| # | 対象 | フラグ理由 |
|---|---|---|
| L-07 | バックアップデータ（CloudSQL + SF）| 要配慮個人情報を含むバックアップの保管場所・アクセス制御・保持期間の法的根拠確認要 |
| L-08 | 紙帳票（障害時の暫定記録）| 紙による個人情報取扱いの管理手順（施錠保管・廃棄方法）の法務確認要 |
| L-09 | RPO/RTO 数値 | 障害福祉事業所として法令上の記録保存義務と照合した RPO 設定の確認要 |
