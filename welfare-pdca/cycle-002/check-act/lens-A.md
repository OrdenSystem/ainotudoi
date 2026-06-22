# Lens A — アーキテクチャ整合性 — サイクル 002

## 観点と評価軸

`01-architecture.md` / `07-integration-flows.md` / `10-traceability-matrix.md` を spec.md §4 と照合し、責務分担と連携経路、SoR / SoE の重複・欠落・循環依存、データソース配置の妥当性、Cycle 2 で新規導入された経路（Cloud Run jobs / Cloud Tasks / KMS / Secret Manager / `facility_id_map` / `staff_facility_map` / 契約ミラー / 上限管理 3 テーブル）が spec / 02-04 で一貫しているか。さらに Cycle 1 Lens A の Critical 4 件が解消されたかを必ず確認。

## 確認した成果物

- `welfare-pdca/cycle-002/plan/spec.md` §4 / §5 / §6.Must.7 / §10 マッピング表
- `welfare-pdca/cycle-002/do/01-architecture.md`（全節）
- `welfare-pdca/cycle-002/do/02-data-model.md` §1, §2
- `welfare-pdca/cycle-002/do/07-integration-flows.md`（全 9 節）
- `welfare-pdca/cycle-002/do/10-traceability-matrix.md` §1〜§7
- `welfare-pdca/cycle-002/do/04-salesforce-objects.md` §2 / §13
- `welfare-pdca/cycle-002/do/05-appsheet-tables.md` §1 / §7
- `welfare-pdca/cycle-002/do/06-gas-integrations.md` §1 / §4 / §6 / §7
- 比較: `welfare-pdca/cycle-001/check-act/lens-A.md`

## Cycle 1 Lens A Critical の解消確認

| Cycle 1 Critical | 解消状況 | 根拠 |
|---|---|---|
| A#1: 支給決定 SoR 二重定義 (AppSheet が SF 直 + CS キャッシュ両方参照) | **解消** | `05-appsheet-tables.md` §1 で `WelfareSalesforce` コネクタ廃止を明記。`01-architecture.md` §2 SoR 表で「AppSheet 接続方針: CloudSQL 経由のみ読取」が全エンティティで統一 |
| A#2: Facility__c ↔ facilities 同期未定義 | **解消** | `01-architecture.md` §4 `syncFacilitiesFromSF` 新設、`06-gas-integrations.md` §4 で関数仕様＋擬似コード完全実装、`07-integration-flows.md` §2 にシーケンス図 |
| A#3: staff の SoR 未確定（SF User vs CS staff） | **部分解消** | `01-architecture.md` §9 責務分担表で「SoR(トランザクション) = CloudSQL staff」と明記。ただし SF User ⇄ `staff.sf_user_id` の同期方針・タイミング・関数名が `06-gas-integrations.md` §1 関数一覧に無い。リスク台帳 R-11 で「同期遅延でアクセス制御が一時的に緩む」と挙げているが、実体は **未実装**（Lens A Critical #1 に格上げ／下記） |
| A#4: audit_log 書込みアクター・経路の不整合 | **部分解消** | `02-data-model.md` §2.2 で `actor_type` enum を `staff/gas_batch/cloud_run_job/system` に正規化、`08-security-and-privacy.md` §6.1 でイベント種別表を整備。ただし **AppSheet 由来の更新が audit_log に記録される仕組み**（DB トリガ? AppSheet Bot? 中間 GAS?）が `01-architecture.md` / `06-gas-integrations.md` のいずれにも実装記述なし。Mermaid §1 では「CS_SR & CS_UM --> 変更ログ CS_AL」と矢印だけ残るが実装は空。下記 Critical #2 に格上げ |

## Critical（必ず次サイクルで直す）

1. **SF User → CloudSQL `staff` の同期関数が実装空欄（Cycle 1 A#3 残存）**: `01-architecture.md` §9 で「CloudSQL staff は SoR (トランザクション)」、`02-data-model.md` §2.2 `CS_Staff` に `sf_user_id` 列、`04-salesforce-objects.md` §3 オブジェクト一覧に SF Staff オブジェクト無し（SF 標準 `User`）。`06-gas-integrations.md` §1 関数一覧表 9 件には `syncStaffFromSF` / `syncUsersToCloudSqlStaff` の類が一つも存在しない。一方 `05-appsheet-tables.md` §2.2 と Security Filter は `staff_facility_map.email = USEREMAIL()` で参照する設計（C-05 の中核）であり、`staff` テーブルが空のままだとセキュリティが全く効かない。
   - Why bad: USERSETTINGS 全廃の代替（spec §6.Must.8 受入基準）の前提テーブル `staff` / `staff_facility_map` を誰が・どう投入するかが空欄。AppSheet からの手入力？事業所管理者の運用？GAS バッチ？経路未定義のままだと、本番投入時に「Security Filter は書いたが staff テーブルが空でみんな弾かれる」or「事業所管理者がスタッフを手で追加し忘れ → 新規入社者がデータ無参照」のオペレーション事故になる。spec.md §8 R-11 で「同期遅延でアクセス制御が一時的に緩む」を挙げているのは、同期前提の話で、**そもそも同期関数が存在しないことに気づいていない**。
   - How to fix: Cycle 3 で `syncStaffFromSF`（SF User → CloudSQL `staff` + `staff_facility_map`）を `06-gas-integrations.md` の関数一覧に追加。SF Profile + Permission Set → CloudSQL `staff.role` の対応表、Public Group → `staff_facility_map` の生成ロジックを明記。`01-architecture.md` §9 と `07-integration-flows.md` にも該当シーケンスを追記。
   - Spec §: §6.Must.5 / §6.Must.8 受入基準（Security Filter の前提）/ §8 R-11

2. **AppSheet 由来の更新が `audit_log` に記録される実装経路が空欄（Cycle 1 A#4 残存）**: `01-architecture.md` §1 Mermaid 図に「CS_SR & CS_UM --> 変更ログ CS_AL」エッジは描かれているが、`06-gas-integrations.md` §3 `syncUsersFromSF` が `gas_batch` actor として INSERT する経路のみ実装あり。`05-appsheet-tables.md` §5 Action 定義の `ApproveServiceRecord` `ConfirmBilling` 等も `audit_log` への INSERT を含まない（Data: set column のみ）。`07-integration-flows.md` §3 では「AS->>CS_AL: INSERT audit_log（event_type='CREATE'）」と書かれているが、AppSheet 標準では JDBC 経由でテーブルへの INSERT を「ついで」に発火させる仕組みは存在しない（複数テーブル同時 INSERT は Bot or Webhook 経由が必要）。
   - Why bad: spec §6.Must.8 受入基準で `audit_log` を append-only + WORM と要求し、`08-security-and-privacy.md` §6.1 のイベント種別表に CREATE/UPDATE/DELETE/APPROVE が列挙されているが、**AppSheet から CloudSQL への CRUD は audit_log を経由しない**ため、利用者情報の閲覧履歴・サービス記録の修正履歴・契約ステータス変更が監査トレールに残らない。法令対応の根拠資料としての価値は Cycle 1 と同水準（実質ゼロ）。Cycle 1 A#4 が「監査ログがアクター・経路で不整合」と書いた指摘は、Cycle 2 でも本質的に解消していない。
   - How to fix: Cycle 3 で「AppSheet Action → AppSheet Bot（"On record updated"）→ Webhook → GAS WebApp → `audit_log` INSERT」のフローを `01-architecture.md` / `06-gas-integrations.md` / `07-integration-flows.md` に追加。または MySQL Trigger（AFTER INSERT/UPDATE/DELETE）で `audit_log` を書き込む方式を `03-cloudsql-ddl.sql` に追加。どちらにせよ実装責務を明文化。
   - Spec §: §6.Must.8 受入基準 / §7 受入基準（監査ログ）

3. **個別支援計画（SF `IndividualSupportPlan__c`）が AppSheet から参照できない経路設計**: `04-salesforce-objects.md` §2 SoR 一覧で `IndividualSupportPlan__c` は SoR=SF、ミラー先 = `support_plan_mirror`（Cycle 3 実装）と記載。一方 `05-appsheet-tables.md` のテーブル定義（§2.1〜§2.8）に `support_plan_mirror` も `IndividualSupportPlan__c` も存在しない。spec §6.Must.2 受入基準で「親子構造 1:N 関係が定義」「実地指導減算リスクに対応する記録欠落検出ルールが明示」を要求しているが、**サビ管が AppSheet で個別支援計画を閲覧・更新できる経路が無い**ため、現場運用が成立しない。
   - Why bad: spec §3 ステークホルダー表で「サビ管: 利用者登録、契約締結、**個別支援計画作成**、月次集計確認」を Must としているが、Cycle 2 の AppSheet 設計には個別支援計画 View が一切ない。サビ管は Salesforce 側で計画を直接編集する想定なら、SF ライセンス費（spec §1 中小規模事業所がペイ）が膨張する。Cycle 1 Lens D Critical #2「アセスメント / モニタリング / 担当者会議の関連エンティティ欠落」を Cycle 2 で SF カスタムオブジェクト追加で解消したと主張するが、UI 経路が空欄では業務が回らない。
   - How to fix: Cycle 3 で `support_plan_mirror` / `assessment_mirror` / `monitoring_record_mirror` / `care_plan_meeting_mirror` を CloudSQL に追加し、`syncSupportPlansFromSF` を `06-gas-integrations.md` に新設。`05-appsheet-tables.md` に対応 View / Slice / Form を追加。
   - Spec §: §6.Must.2 受入基準 / §3 ステークホルダー（サビ管の操作）

## Major（強く推奨）

1. **`10-traceability-matrix.md` の grep 検証コマンド結果が虚偽**: §2 C-05 で `grep -r "USERSETTINGS" welfare-pdca/cycle-002/do/` → 0 件と主張するが、実 grep では 16 件ヒット（うち `05-appsheet-tables.md` §7 タイトル / 注記 / 11 件、`08-security-and-privacy.md` 3 件等）。同様に C-01 で `AES_ENCRYPT` → 0 件と主張するが実 grep は 16 件ヒット、C-04 `WelfareSalesforce` も 5 件ヒット。
   - 注: ヒット文脈はすべて「廃止」「解消」「不在」を説明する解説文であり、実装としては正しく USERSETTINGS / AES_ENCRYPT / WelfareSalesforce を使っていない。が、`10` の主張「0 件」は事実反する。verifier が grep を字面通り検証すると判定が崩れる。
   - 対処案: `10` の検証コマンドを `grep -rE "USERSETTINGS\(" ... | grep -v "廃止\|不在\|解消\|削除"` のように実コード検出に絞り込むか、検証コマンドを差替えてヒット件数で判定する方式に修正。

2. **`01-architecture.md` Mermaid に外部システム連携の認証境界が薄い**: 国保連連携（CS_BP → EXT）が「外部（将来連携）」のラベルで矢印を引いているのみ。Cycle 2 の本体スコープ外ではあるが、現状の `billing_prep` から CSV を出す `exportBillingCSV`（`06-gas-integrations.md` §10）の WebApp 認証が「組織内公開」とだけ書かれ、`01-architecture.md` の認証境界図に表現されていない。

3. **AppSheet → CloudSQL の双方向 CRUD と読取専用の区別が Mermaid 図と §2 表で完全には一致しない**: 図では `AS <--> CS_SR / CS_ST / CS_SH / CS_UL`（双方向）と `AS --> 読取のみ CS_UM / CS_AC / CS_CM / CS_MS / CS_BP` を区別しているが、§2 SoR 表で `billing_prep` は「Cloud Run jobs 書込」「AppSheet 読取」と書きつつ、`05-appsheet-tables.md` §5 `ConfirmBilling` Action は `billing_prep.status` を UPDATE する。AppSheet からの UPDATE 経路の許可を SoR 表で明示すべき。

4. **`07-integration-flows.md` §4 月次バッチフローで Cloud Run jobs 失敗時の通知経路が曖昧**: 「CRJ->>GAS: 失敗通知（Cloud Pub/Sub or webhook）」と OR 表現で 2 候補列挙。spec §6.Must.9「Cloud Run jobs 失敗シナリオの検知」を要求しているのに、どちらの方式かが確定していない。`09-operational-runbook.md` §3 シナリオ S4 検知欄では「Cloud Monitoring アラート」とのみで、Pub/Sub 経由の GAS への通知 vs Cloud Logging 直接アラートかがフロー図と Runbook で食い違う。

5. **`01-architecture.md` §3 KEK パスに `{p}` プレースホルダ、Runbook §1 では実値 `ainotudoi-443914355`**: spec §6.Must.8 受入基準「KEK ID 文字列が DDL / GAS / Runbook の 3 箇所で同一」を満たすかが微妙。設計図フェーズでは `{p}` が妥当だが、`09-operational-runbook.md` §1 環境定義表で実値を埋めると「同一文字列」と言えない。プレースホルダを揃えるか、両方とも実値で揃えるかの方針を spec.md に追記。

6. **Person Account の親子（Account ↔ Contact）整理が `04-salesforce-objects.md` §4 に未掲載**（Cycle 1 Lens B Major #1 と同根）: `FacilityId__c` を Account 側に置くか Contact 側に置くかの整理がない。`syncUsersFromSF` の SOQL は `WHERE IsPersonAccount=true`（Account 側）を取るが、PersonContact 側カスタム項目との二重定義リスクが残存。

7. **`pushDailySummaryToSF` が SF PersonAccount に書き込む `LastServiceDate__c` 等のカスタム項目が `04-salesforce-objects.md` §4 で未定義**（Cycle 1 Lens A Major #4 残存）: `06-gas-integrations.md` §1 関数一覧表で「SF PersonAccount カスタム項目更新」と書きつつ、04 §4.1〜§4.4 のいずれにも `LastServiceDate__c` / `MonthlyServiceMinutes__c` の列定義なし。

## Minor（余裕があれば）

1. `01-architecture.md` §1 Mermaid `subgraph "外部（将来連携）"` の「EXT 国保連」「ULF 他事業所」のラベルが具体性なし。
2. `07-integration-flows.md` §7 鍵管理フロー（C-01）の Mermaid で AppSheet の「末尾 4 桁マスク」表現が `App formula` の文字列リテラルとして書かれているが、`05-appsheet-tables.md` §2.1 の AppFormula 名は `recipient_cert_no_masked` で命名が一致しない（致命的ではないが連携時に混乱しうる）。
3. `01-architecture.md` §6.2 で「AppSheet → Public IP 許可 + SSL」と書かれているが、Public IP 運用は外部スキャンリスク（spec §8 R-13）と整合性に懸念。Cloud SQL Auth Proxy への一本化提案を Should に格上げするか議論。

## スコア（1-10）

- 完全性: 6（SF User→staff 同期 / audit_log 経路 / 個別支援計画 UI の 3 経路が空欄。SoR 表自体は Cycle 1 比で大幅整備）
- 整合性: 7（C-04 / C-06 解消で支給決定と Facility は綺麗になった。一方 10-matrix の grep 検証は虚偽。MermaidとSoR表で一部齟齬残存）
- 妥当性: 7（基本方針 = AppSheet/GAS/Cloud Run jobs/CloudSQL/SF の役割分担は妥当。Cycle 1 比で SoE/SoR 一本化が大きく前進）
- 平均: **6.67**
