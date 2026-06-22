# Lens E — 運用・コスト・拡張性 — サイクル 002

## 観点と評価軸

`09-operational-runbook.md` を中心に、RPO/RTO、バックアップ、PITR、リリース手順、ロールバック、6 シナリオ × 3 列の障害対応表、Cloud Run jobs `scheduleResumption` 実コードスケッチ、月額コスト試算（C-18）、PITR 手順表（C-19）、KMS / Secret Manager 障害対応（R-14）、AppSheet ライセンス、Salesforce ライセンス、Claude API 試算（Cycle 3 送り）を審査。Cycle 1 Lens E Critical 3 件の解消も確認。

## 確認した成果物

- `welfare-pdca/cycle-002/do/09-operational-runbook.md`（全節）
- `welfare-pdca/cycle-002/do/01-architecture.md` §6 / §7
- `welfare-pdca/cycle-002/do/06-gas-integrations.md` §6 / §7
- `welfare-pdca/cycle-002/do/08-security-and-privacy.md` §1.3 / §6
- `welfare-pdca/cycle-002/plan/spec.md` §6.Must.9 / §7 受入基準（運用性）/ §8 リスク台帳
- 比較: `welfare-pdca/cycle-001/check-act/lens-E.md`

## Cycle 1 Lens E Critical の解消確認

| Cycle 1 Critical | 解消状況 | 根拠 |
|---|---|---|
| E#1: 月額コスト試算ゼロ | **解消** | `09-operational-runbook.md` §6 で 500 名 ≈ ¥328,200/月、2,000 名 ≈ ¥1,059,900/月 の試算。AppSheet / SF EE / CloudSQL / Cloud Run / KMS / Secret Manager / Cloud Tasks / GCS / GAS の内訳 |
| E#2: PITR の AppSheet DSN 切替・GAS Script Properties 更新が手順化されない | **部分解消** | `09` §5 で 9 ステップ PITR 手順表（RTO ≤ 2 時間）。AppSheet データソース更新を Studio 操作 + 10 分と明記。Public IP 運用での DNS 切替不可問題は `09` §5 表中の「インスタンス名正規化」で言及。Secret Manager 経由の GAS 接続更新も §5 ステップ 5 で記載 |
| E#3: GAS 6 分上限と scheduleResumption 実装空欄 | **解消** | `06-gas-integrations.md` §7.3 / `09-operational-runbook.md` §4 で Python 実装スケッチ、Cloud Tasks `AlreadyExists` 例外で重複防止、`status='error'` のみ再エンキューする冪等性ロジック |

> 3 件すべて解消。Cycle 1 E 平均 5.3 から大幅改善見込み。

## Critical（必ず次サイクルで直す）

1. **月額コスト試算の Salesforce 内訳の前提誤り（C-18 解消が部分的）**: `09-operational-runbook.md` §6 で「Salesforce Enterprise Edition 10 ライセンス（$150/user/月）→ $1,500」と試算。一方 spec §3 ステークホルダー 6 ロール × 中小事業所複数 = 想定 50 名（同 §6 AppSheet 50 ユーザー）に対し、SF を「サビ管 + 管理者 + 請求担当」だけ 10 名に絞ると、現場入力スタッフ（生活支援員 / シフト管理者）は AppSheet 専用ユーザーになる前提。しかし `01-architecture.md` §2 SoR 表で個別支援計画 / 契約 3 点セット / 上限管理（一部）の SoR が SF で、Cycle 2 設計では AppSheet からこれらを編集する経路が無い（Lens A Critical #3）。サビ管が SF Lightning で計画作成するなら 10 名で良いが、SF ライセンス費 ¥225,000 / 月（試算の 65%）が圧倒的支配的で、ペイ可否の判断にクリティカル。
   - Why bad: spec §1「中小規模事業所がペイ」を判定する材料として、SF ライセンス数 = 10 名の根拠が薄く、`09` §6 で「全体の 60〜65% を占める」とだけ書かれて、削減策が「AppSheet ユーザーの Creator → User ダウングレード」のみ。SF 側を最小化する設計選択肢（Health Cloud 等の再評価、SF Platform License で済ますことの可否、Lite ユーザー枠等）の検討が空。
   - How to fix: Cycle 3 で SF ライセンス内訳を「Full License（サビ管 + 管理者）= 3 名」「SF Platform License（請求担当 + サ提責）= 7 名」「Customer Community for 利用者家族（将来 Cycle 4）」の 3 段構成を試算。spec §1 の「ペイ可否」判定値（事業所月予算 ≤ ¥200,000 / 月など）を明文化。
   - Spec §: §1 Vision / §7 運用受入基準（コスト試算）

2. **Cloud Run jobs `scheduleResumption` の実コードスケッチが GAS 側のキック関数 `triggerBillingBatch`（`06` §6）と Python 側（§7.3）で連携が一貫しない**: GAS `triggerBillingBatch` は Cloud Tasks 経由で `cloudRunUrl + '/run'` に POST、ボディが `{ billing_year_month, run_id }`。一方 `06` §7.3 / `09` §4 の Python `scheduleResumption` は `failed_records: list[dict]` を引数に取り、レコード単位で `billing-{record['id']}` を task_id にする「行単位」再実行。一方 §7.4 冪等性メカニズムは「新しい `batch_run_id` を生成して再 INSERT」と全体単位の再実行を想定。GAS / Python / Runbook §3 シナリオ S4 で「再エンキュー粒度」が一致していない。
   - Why bad: 月次バッチが中盤で失敗した時に、「失敗 user_id のみリトライ」か「全 user_id 新 batch_run_id でリトライ」かが定まらないと、`billing_prep` に「前回 batch_run_id」と「新 batch_run_id」の混在行が残り、請求担当が confirm すべき行を選択できない混乱。spec §6.Must.6 受入基準「冪等性」が形式合格にとどまる。
   - How to fix: Cycle 3 で「再実行粒度 = 月全体 1 batch_run_id」に統一し、`scheduleResumption` を「失敗時に新 batch_run_id で月全体を再実行」に書き直す。または「行単位リトライ」に統一し、`billing_prep` に `retry_of_batch_run_id` カラムを追加。`06` § / `09` §3 / §4 を統一。
   - Spec §: §6.Must.6 受入基準（冪等性）

3. **`audit_log` の年次削除バッチが運用責任表に挙がっていない（Cycle 1 Lens E Major #2 残存）**: `08-security-and-privacy.md` §9.2 で「監査ログ 5 年保持」「Cloud Storage WORM Retention Policy 5 年」と書かれるが、`09-operational-runbook.md` §7 定期メンテナンスには「audit_log GCS エクスポート実行」のみで、保持期間経過後の削除実行手順がない。Cycle 1 Lens E Major #2 で指摘したが Cycle 2 で進展なし。
   - Why bad: WORM Bucket Lock + Retention Policy 5 年は GCP 側で自動削除可能だが、CloudSQL `audit_log` テーブル本体は手動削除が必要。`audit_log` の `welfare_admin_user` 以外への UPDATE/DELETE 剥奪（`03-cloudsql-ddl.sql` §18）と組み合わせると、削除作業の手順と承認フローが必須だが空欄。データベース肥大化（5 年 × 利用者 50 × 1 日 5 操作 × 10KB ≒ 4.5GB）で初期 50GB ストレージが圧迫される。
   - How to fix: Cycle 3 で `09` §7 に年次削除手順を追加。`welfare_admin_user` での DELETE + バックアップ取得 + 監査ログ自身への削除イベント記録の 3 ステップ化。
   - Spec §: §6.Must.9 受入基準

## Major（強く推奨）

1. **CloudSQL HA 構成が `01-architecture.md` §6.1 で「Single-zone（SLA 強化要件発生時に Regional へ移行）」のまま（Cycle 1 Lens E Major #1 残存）**: Single-zone はゾーン全体障害時に RTO 数時間〜半日。`09` §2 SLA 目標 RTO ≤ 4 時間と整合性懸念。`09` §5 PITR 手順表で「合計 RTO 目安 ≤ 2 時間」と謳うが、これは「PITR 復旧時間」のみで、ゾーン障害検知 → 別ゾーンクローン作成 → DNS 切替の全体時間ではない。Regional HA への移行優先度を Cycle 3 で明示するか、RTO を 8 時間に緩めるか合意必要。

2. **`09-operational-runbook.md` §6 のコスト試算で「GAS 無料枠内」と書かれているが、Workspace Business Standard 以上の組織で運用する前提（Script Properties / OAuth / UrlFetchApp の組織利用上限）が空欄**: Cycle 1 Lens E Major #5 で指摘した SF API コール試算と同根。GAS が無料枠内であっても、Workspace ライセンス費（事業所メンバ全員に Business Standard 以上が必要、$12/user/月 × 50 = $600/月 ≈ ¥90,000/月）が試算に未計上。

3. **AppSheet ライセンス区分（Core / Enterprise Standard / Enterprise Plus）の選択根拠が `09` §6 で「Enterprise 50 ユーザー ($10/user/月)」と単価のみ提示（Cycle 1 Lens E Minor #4 残存・Major 化）**: Cycle 2 Security Filter で `staff_facility_map` を CloudSQL から SELECT する `SELECT(table[col], [cond])` 式は AppSheet Standard 以上で利用可能だが、Enterprise Plus でしか使えない式（Webhook / Custom Auth / SSO）も混在する設計。`05-appsheet-tables.md` §6 Bot で「Notify」を使うが、これは Enterprise Standard で動作する範囲か Plus か未確認。$10/user/月 が Enterprise Plus 単価より低いため Standard 想定だが、Bot の Scheduled トリガが Standard に含まれるかライセンス精査必要。

4. **Cloud SQL Auth Proxy + 公開 IP の併存設計の説明が不足（spec §8 R-13「AppSheet App ID 既知化に伴う API スキャンリスク」関連）**: `01-architecture.md` §6.2 で「AppSheet → Public IP 許可 + SSL」と「GAS/Cloud Run jobs → Cloud SQL Auth Proxy」が並存。AppSheet が IP allowlist の制約上 Cloud SQL Auth Proxy 必須化しにくいが、Public IP 経由のアクセスは外部スキャンリスクと裏腹。Cycle 3 で「AppSheet 専用静的 IP」「VPC Service Controls」等の検討が必要。

5. **Salesforce Data Export の保管先が空欄（Cycle 1 Lens E Major #7 残存）**: `09` §7 月次/四半期メンテナンスで「Salesforce API バージョン確認・更新」「CloudSQL メンテナンスウィンドウ確認」はあるが、SF 側自動エクスポート（週次）のダウンロード保管先（GCS バケット / 外部 NAS）と保持期間が空。SF 障害時の BCP に役立たない。

6. **Cycle 1 Lens E Major #4「AppSheet バージョン履歴からのロールバックと CloudSQL DDL を同時にロールバックする調整」が Cycle 2 未対応**: `09` §7 月次メンテナンス「AppSheet デプロイバージョン確認 (AppSheet Studio → Deploy → History)」のみ。AppSheet 設定と DDL の同時ロールバック手順がない。

7. **Cycle 1 Lens E Major #5「SF API コール試算」が Cycle 2 で進展なし**: `syncUsersFromSF` × 24/日 + `syncAllotmentsFromSF` × 24/日 + `syncFacilitiesFromSF` × 1/日 + `syncContractsFromSF` × 1/日 + `pushDailySummaryToSF` × 1/日 + `checkContractExpiry` × 1/日 + `checkRecordCompleteness` × 1/日 で 1 日 51+ 回。`triggerBillingBatch` 月次 = 1。Composite API での `pushDailySummaryToSF` 利用者 100 名 / 4 件 / 月で 12,000 calls/month。SF EE の Daily API Request 上限（10 ライセンス前提で約 100,000 + 250 = 100,250）に対し、定常 51 + 月次 12,000 = 12,051 で余裕あるが、フル同期実行や継続トリガ（`triggerSyncContinuation`）発火時に上限張り付くリスクが試算なし。

8. **`09` §6 コスト試算に「Cloud Logging / Cloud Monitoring」が未計上**: `09` §11 監視設定で 4 アラートポリシーを列挙、ログ書込み量と通知（PagerDuty / Slack）の月額が空。PagerDuty は有償サービスで $20/user/月以上、Slack は無料枠あるが組織規模次第。

9. **`09` §5 PITR 手順表のステップ 6「AppSheet データソース更新」で 10 分」とあるが、AppSheet の「接続文字列更新 → Save → 再認証」+「全 Slice / View / Action の再検証」の所要時間が含まれていない**: Cycle 1 Lens E Critical #2 で「実際は半日かかる」と指摘したが、Cycle 2 で 10 分と過小見積りのまま。

10. **`09` §3 シナリオ S5 「KMS 手動 fallback 手順」で「ローカル生成した緊急用 DEK で再暗号化」というオフライン手順が示されるが、`08-security-and-privacy.md` §1.3 のローテーション手順 / §6.2 audit_log WORM 書出しと整合性が空欄**: 緊急 DEK で再暗号化したデータは KMS 復旧後に「通常 KEK で再ラップ」と書かれるが、誰がいつ実行するか、再ラップ中の二重暗号化状態をどう管理するかが空。

## Minor（余裕があれば）

1. PITR 保持 7 日間（`01-architecture.md` §6.1）とランサムウェア対応の論点（Cycle 1 Lens E Minor #1）。
2. CloudSQL Enterprise → Enterprise Plus 移行手順 not described。
3. `staff` 退職時のアカウント無効化バッチ（Cycle 1 Lens E Minor #3）。
4. `09` §10 連絡先表の L3「GCP サポート」目標応答時間 4 時間（P2）は GCP Standard Support 想定。Cycle 2 コスト試算（§6）では GCP サポート費が未計上。
5. `09` §8 紙運用切替で「受給者証コピー」をセキュリティキャビネット保管とあるが、KMS 障害時に AppSheet 表示が `***-****` マスクになると、現場スタッフが受給者証番号を確認する手段が紙コピー頼みになる。代替手段の事前準備（電話確認 + 復号権限者のホットライン）が空。

## スコア（1-10）

- 完全性: 6（コスト試算 / PITR 手順 / scheduleResumption は埋まった。一方 audit_log 削除 / SF Data Export 保管 / AppSheet ライセンス区分 / 各種クラウドサービス費が空欄）
- 整合性: 6（6 シナリオ × 3 列は揃った。一方 scheduleResumption の粒度が GAS と Python と Runbook で不一致、Cycle 1 残課題の進展薄）
- 妥当性: 7（Single-zone + RTO 4h の妥当性に依然懸念だが、Cycle 1 比で運用記述の具体性は大幅向上）
- 平均: **6.33**
