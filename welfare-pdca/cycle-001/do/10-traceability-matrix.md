---
cycle: "001"
related_spec_sections: ["§6.Must.1〜9", "§7（受入基準全項目）"]
streams_independent_of: []
---

# 10. トレーサビリティマトリクス

> 対応 spec.md: §6 Must 9 項目すべて × `do/01〜09` の対応を逆引き可能にする。
> spec §7 受入基準「トレーサビリティ: do/10 で 6章 Must 9 項目それぞれが『どの設計ファイルのどの節で扱われたか』を逆引きできる」対応。

---

## 1. Must 機能 ↔ 成果物 対応表

| Must | 機能名 | 主要成果物（ファイル / セクション）| 補完成果物 | 受入基準の充足状況 |
|---|---|---|---|---|
| **Must.1** | 利用者マスタ管理 | `04-salesforce-objects.md` §4〜§7（PersonAccount 拡張 + ServiceAllotment__c）| `02-data-model.md` §2.1, `03-cloudsql-ddl.sql` §2, `05-appsheet-tables.md` §2.2 | SF オブジェクト API 名・型・必須/任意・FLS 方針・PII フラグ 全記載 ✓ |
| **Must.2** | 個別支援計画モデル | `04-salesforce-objects.md` §5〜§6（SupportPlan__c + SupportGoal__c）| `02-data-model.md` §2.1 | PersonAccount Lookup・期間バリデーション（VR-01/VR-02）・必須項目 明示 ✓ |
| **Must.3** | 日次サービス提供記録 | `03-cloudsql-ddl.sql` §8（service_records DDL）| `02-data-model.md` §2.2, `05-appsheet-tables.md` §2.1, `07-integration-flows.md` Flow 3 | FK 制約・`(user_id, service_date)` INDEX・Asia/Tokyo 明示 ✓ |
| **Must.4** | 支給決定残量計算 | `03-cloudsql-ddl.sql` §10（v_allotment_usage ビュー + user_allotment_cache）| `05-appsheet-tables.md` §2.5, §3.3, §4, `07-integration-flows.md` Flow 5, `06-gas-integrations.md` §5 | 集計 SQL・AppSheet Slice/View 設計・超過警告ルール（10% 以下通知・マイナス表示）記載 ✓ |
| **Must.5** | スタッフ・シフトモデル | `03-cloudsql-ddl.sql` §3〜§5（staff + staff_facility + shifts）| `02-data-model.md` §2.2, `05-appsheet-tables.md` §2.3, §2.4, §3.2 | 1スタッフ複数事業所兼務（staff_facility UNIQUE KEY）・シフト衝突検出 Valid_If 式 定義 ✓ |
| **Must.6** | 請求準備データ生成 | `06-gas-integrations.md` §4（runMonthlyBilling 擬似コード・I/O仕様・冪等性）| `03-cloudsql-ddl.sql` §9（billing_prep DDL）, `07-integration-flows.md` Flow 4 | GAS I/O 仕様・冪等性（batch_run_id UNIQUE KEY）・エラー再実行手順 記載 ✓ |
| **Must.7** | Salesforce ⇄ CloudSQL 同期バッチ | `06-gas-integrations.md` §3（syncUsersFromSF 擬似コード）/ §5（syncAllotmentsFromSF）| `07-integration-flows.md` Flow 1〜2, `01-architecture.md` §3, `03-cloudsql-ddl.sql` §12（batch_run_log）| 同期キー（sf_account_id）・競合解決ルール（SF=SoR で上書き）・リトライ方針（3回→メール通知）・ログ保存先（batch_run_log）記載 ✓ |
| **Must.8** | セキュリティ・PII 保護方針 | `08-security-and-privacy.md` 全文 | `04-salesforce-objects.md` §9, §11, `05-appsheet-tables.md` §7, `02-data-model.md` §4 | PII フィールド一覧・保管位置・暗号化方式（CMEK 採否含む）・アクセス制御マトリクス（5ロール×5オブジェクト）・監査ログ 全記載 ✓ |
| **Must.9** | 障害時運用 Runbook | `09-operational-runbook.md` §3（3シナリオ × 3列表）| `09-operational-runbook.md` §1（RPO/RTO）, §2（バックアップ）, §4〜§5（リリース・ロールバック）| 3シナリオ（SF停止/CS停止/GAS失敗）× 検知・暫定対応・復旧、RPO≤1h/RTO≤4h 数値 記載 ✓ |

---

## 2. spec §7 受入基準 充足確認

| 受入基準 | 対応成果物 | 充足 |
|---|---|---|
| **機能完全性**: Must 9 項目すべてが do/01〜10 のいずれかに設計成果物として収まる | 本表（§1 参照）| ✓ |
| **データ整合性**: 主キー・一意制約・外部キーが DDL / オブジェクト定義で明示 | `03-cloudsql-ddl.sql`（全テーブルに PK/FK/UNIQUE）, `04-salesforce-objects.md`（AutoNumber + Lookup）| ✓ |
| **データ整合性**: Salesforce ⇄ CloudSQL の同期キー指定 | `02-data-model.md` §3（同期キー一覧）, `03-cloudsql-ddl.sql` `uq_sf_account_id` UNIQUE KEY | ✓ |
| **セキュリティ**: 要配慮個人情報の保管位置一覧 | `08-security-and-privacy.md` §1（PII フィールド一覧表）| ✓ |
| **セキュリティ**: 保存時暗号化（CMEK 採否含む）・通信時暗号化（TLS 1.2+）が層ごとに明示 | `08-security-and-privacy.md` §2 | ✓ |
| **セキュリティ**: アクセス制御マトリクス（5ロール × 5オブジェクト）| `08-security-and-privacy.md` §4 | ✓ |
| **運用性**: 3シナリオ × （検知・暫定対応・復旧）が表形式で網羅 | `09-operational-runbook.md` §3 | ✓ |
| **運用性**: RPO ≤ 1時間 / RTO ≤ 4時間 の数値と根拠 | `09-operational-runbook.md` §1 | ✓ |
| **法令適合**: 法務レビュー必要箇所が赤フラグとして列挙 | 本表 §3 および各ファイルの法務フラグ（L-01〜L-12）| ✓ |
| **法令適合**: 要配慮個人情報の「保管位置・最小化・アクセス制限」が言及 | `08-security-and-privacy.md` §1, §6 | ✓ |
| **トレーサビリティ**: do/10 で Must 9 項目が逆引き可能 | 本表（§1）| ✓ |

---

## 3. 法務レビューフラグ 全集約

> 各ファイルに分散した法務フラグを一覧化。実装前に全項目の専門家レビューが必要。

| フラグ # | 記載ファイル | 対象 | フラグ理由 |
|---|---|---|---|
| **L-01** | `02-data-model.md` §4, `04-salesforce-objects.md` §12 | 受給者証番号（`RecipientCertNo__c`）| 障害者総合支援法上の識別情報。保管・提供の法的根拠確認要 |
| **L-02** | `02-data-model.md` §4, `04-salesforce-objects.md` §12 | 障害種別（`DisabilityType__c`）| 個人情報保護法 §2-3「要配慮個人情報」。収集時の本人同意取得手続き確認要 |
| **L-03** | `02-data-model.md` §4 | 特記事項（`service_records.notes`）| 支援内容詳細は要配慮個人情報相当。アクセス制御・保持期間の法務確認要 |
| **L-04** | `02-data-model.md` §4, `09-operational-runbook.md` §8 | `audit_log` 保持期間（5年）| 根拠法令（個人情報保護法 / 障害者総合支援法の記録保存義務）確認要 |
| **L-05** | `04-salesforce-objects.md` §12 | Person Account 有効化（不可逆）| 有効化前に法人としての個人データ管理方針確認要（spec §8 R-07）|
| **L-06** | `04-salesforce-objects.md` §12 | 長期目標・短期目標・支援目標詳細 | 支援内容詳細は要配慮個人情報相当。保管・閲覧権限の法務確認要 |
| **L-07** | `09-operational-runbook.md` §8 | バックアップデータ（CloudSQL + SF）| 要配慮個人情報含むバックアップの保管場所・アクセス制御・保持期間の法的根拠確認要 |
| **L-08** | `09-operational-runbook.md` §8 | 紙帳票（障害時の暫定記録）| 紙による個人情報取扱いの管理手順（施錠保管・廃棄方法）の法務確認要 |
| **L-09** | `09-operational-runbook.md` §8 | RPO/RTO 数値 | 障害福祉事業所として法令上の記録保存義務と照合した RPO 設定の確認要 |
| **L-10** | `08-security-and-privacy.md` §8 | CMEK 不採用（Cycle 1）| 安全管理措置としての暗号化水準が個人情報保護法ガイドライン要件を満たすか確認要 |
| **L-11** | `08-security-and-privacy.md` §8 | Claude API 連携（将来）| 要配慮 PII を AI API に送信する場合の法的根拠・委託契約・処理地確認要（spec §8 R-09）|
| **L-12** | `08-security-and-privacy.md` §8 | `audit_log` 削除バッチ | 保持期間終了後の削除手続きと削除前アーカイブの要否確認 |

---

## 4. spec §8 Critical リスク対応確認

> spec §10「Cycle 1 完了定義」— Critical リスク（R-02/R-04/R-05/R-07/R-09）への設計上の予防策

| リスク ID | リスク名 | Cycle 1 で施した設計上の予防策 | 記載成果物 |
|---|---|---|---|
| **R-02** | Salesforce エディション未確定（EE 仮定）| Enterprise Edition + Person Account を仮定として明示。Health Cloud は Cycle 2 Must 化を記録 | `04-salesforce-objects.md` §1, `spec.md §8` |
| **R-04** | 報酬告示改定への追従 | `service_master` / `addition_master` テーブルを設計し、サービスコード・単位数・加算減算をハードコードしない | `03-cloudsql-ddl.sql` §6〜§7, `02-data-model.md` §2.2 |
| **R-05** | 要配慮個人情報の法令不適合 | PII 3分類・保管位置・アクセス制御・法務レビューフラグ（L-01〜L-12）を設計成果物に明示 | `08-security-and-privacy.md` 全文, `10-traceability-matrix.md` §3 |
| **R-07** | Person Account 有効化は不可逆 | 「有効化は Cycle 2 着手前にユーザー承認取得」を設計に明示。法務フラグ L-05 を立てた | `04-salesforce-objects.md` §1, L-05 |
| **R-09** | Claude API への PII 送信リスク | AI 機能を Must から除外（Should 送り）。`claudeAssistSummary` に PII マスキング必須を明記 | `06-gas-integrations.md` §8, `08-security-and-privacy.md` §3 |

---

## 5. 成果物ファイル一覧と担当 Must の逆引き

| ファイル | 担当 Must | 補完 Must |
|---|---|---|
| `01-architecture.md` | Must.7（連携経路全体）| Must.1〜9 の全体観 |
| `02-data-model.md` | Must.1, 2, 3, 5, 6 | Must.4, 7, 8 |
| `03-cloudsql-ddl.sql` | Must.3, 5, 6 | Must.4, 7, 8, 9 |
| `04-salesforce-objects.md` | Must.1, 2 | Must.7, 8 |
| `05-appsheet-tables.md` | Must.3, 4, 5 | Must.8 |
| `06-gas-integrations.md` | Must.4, 6, 7 | Must.9 |
| `07-integration-flows.md` | Must.3, 4, 6, 7 | Must.9 |
| `08-security-and-privacy.md` | Must.8 | Must.1〜7, 9 |
| `09-operational-runbook.md` | Must.9 | Must.6, 7, 8 |
| `10-traceability-matrix.md` | 全 Must の逆引き統合 | — |
