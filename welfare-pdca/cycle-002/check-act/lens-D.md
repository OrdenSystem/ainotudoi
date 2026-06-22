# Lens D — 福祉業界要件 — サイクル 002

## 観点と評価軸

spec.md §3 法令前提・§6 受入基準と照合し、障害福祉サービス特有の概念（受給者証、サービス等級、支給決定、加算/減算、モニタリング、個別支援計画、サ管/サ提責、利用契約、上限管理、実地指導減算リスク、サービス担当者会議、虐待防止、保護者・後見人、夜勤シフト等）の取り扱いに穴がないかを精査。Cycle 1 Lens D Critical 5 件の解消も確認。

## 確認した成果物

- `welfare-pdca/cycle-002/plan/spec.md` §3 / §6 Must.1〜11 / §8 R-10〜R-15
- `welfare-pdca/cycle-002/do/02-data-model.md`
- `welfare-pdca/cycle-002/do/03-cloudsql-ddl.sql`
- `welfare-pdca/cycle-002/do/04-salesforce-objects.md`
- `welfare-pdca/cycle-002/do/05-appsheet-tables.md`
- `welfare-pdca/cycle-002/do/07-integration-flows.md` §5 上限管理月次授受フロー
- `welfare-pdca/cycle-002/do/08-security-and-privacy.md` §11 法務レビュー一覧
- `welfare-pdca/cycle-002/do/10-traceability-matrix.md` §3, §4
- 比較: `welfare-pdca/cycle-001/check-act/lens-D.md`

## Cycle 1 Lens D Critical の解消確認

| Cycle 1 Critical | 解消状況 | 根拠 |
|---|---|---|
| D#1: 上限管理事業所 / 利用者負担上限月額 / 上限管理結果票が一切欠落 | **大半解消** | `03-cloudsql-ddl.sql` §12-14 で 3 テーブル `upper_limit_facility` / `upper_limit_decision` / `upper_limit_result_sheet` を新設、`05-appsheet-tables.md` §2.8 で対応 View/Slice。一方 `04-salesforce-objects.md` には対応 SF オブジェクト未定義（Lens B Critical #2 と同根。Must.11 受入基準「3 ファイル 3 箇所に存在」を満たさない） |
| D#2: アセスメント / モニタリング / サービス担当者会議のエンティティ欠落 | **SF 側のみ解消** | `04-salesforce-objects.md` §6-§8 で 3 子オブジェクト追加。一方 CloudSQL ミラー無し（Lens B Critical #1）、AppSheet View 無し（Lens A Critical #3）で、サビ管の UI 経路は SF Lightning に依存 |
| D#3: サービス管理責任者とサービス提供責任者の区別が混在 | **解消** | `02-data-model.md` §2.2 `CS_Staff.role` enum に `service_manager` / `service_provider_lead` / `support_worker` / `billing_officer` / `facility_admin` を定義（C-16 解消）。`03-cloudsql-ddl.sql` §4 で DDL レベル enum 化 |
| D#4: 支給期間と自己負担上限額決定期間が単一フィールドで混在 | **部分解消** | `04-salesforce-objects.md` §9 `ServiceAllotment__c` に `CopaymentLimitPeriodFrom__c` / `CopaymentLimitPeriodTo__c` を追加（C-17 先行対応）。ただし spec.md §6 では Should 降格扱いで、Cycle 2 Must 受入基準には未明示 |
| D#5: 契約書 / 重要事項説明書 / 同意書のドキュメント管理エンティティ欠落 | **解消（SF 側）** | `04-salesforce-objects.md` §10-§12 で 3 オブジェクト追加、`03-cloudsql-ddl.sql` §11 で `contract_mirror`、`05-appsheet-tables.md` §2.7 で View 設計 |

> 5 件中 3 件は実質解消、2 件は部分解消（SF 側のみ）。

## Critical（必ず次サイクルで直す）

1. **「身体拘束 / 行動制限の記録」専用エンティティが欠落（Cycle 1 Lens D Major #7 が Cycle 2 で Critical 化）**: 障害福祉サービス事業所（特に GH・生活介護）では身体拘束等の禁止 + 例外時の 3 要件記録（切迫性・非代替性・一時性）が法定義務（障害者総合支援法 第 42 条、指定基準）。違反すると **「身体拘束廃止未実施減算」（基本報酬の 5/100 減算）** という具体的金銭ペナルティが発生する。`service_records.notes TEXT` で書く想定だとしても、`event_type` 列も `record_type` 列も無いため、月次集計・実地指導時の抽出ができない。
   - Why bad: spec §3「実地指導減算リスク」と明記しているのに、身体拘束 / 緊急対応 / 虐待通報の業務記録が表現できない。Cycle 2 で個別支援計画の子オブジェクトを追加したのに、こちらは Cycle 1 Major 扱いのまま放置。
   - How to fix: Cycle 3 で `BehaviorRestraintRecord__c`（SF）/ `restraint_record`（CS）を追加。`service_records` に `event_type ENUM('normal','near_miss','accident','restraint','abuse_report')` を追加し、`event_type != 'normal'` の場合は別表で追跡。`02-data-model.md` / `03` / `04` / `05` に反映。
   - Spec §: §3 法令前提（実地指導減算リスク）/ §2 In Scope（GH 等）

2. **「保護者 / 法定代理人 / 成年後見人」エンティティが Cycle 2 で未対応（Cycle 1 Lens D Major #10 残存、Must.10 契約と密結合）**: `04-salesforce-objects.md` §10 `ServiceContract__c.SignedBy` 相当が `ConsentForm__c.SignedBy__c Text(80)`（§12）で「署名者氏名（本人 or 後見人）」とテキストで吸収。18 歳未満 / 成年被後見人の利用者では契約署名者 / 同意者が利用者本人ではないため、独立エンティティ `Guardian__c` / `LegalRepresentative__c` が必要。`PersonAccount.EmergencyContact*` は緊急連絡先として独立で、契約署名者とは法的役割が異なる。
   - Why bad: spec §6.Must.10 受入基準「Person Account との Lookup、契約期間バリデーション、契約満了前 30 日アラート」は契約者の指定が必要だが、Cycle 2 設計では「署名者は文字列」のため、保護者 1 名 → 利用者 2 名のような家族構造で「同じ保護者の契約」を検索できない。実地指導で「契約者の本人確認書類」と「サービス利用者の本人確認書類」を分けて求められる場面に対応できない。
   - How to fix: Cycle 3 で SF `Guardian__c` カスタムオブジェクト追加、`ServiceContract__c.SignedBy` を `Lookup(Guardian__c)` に変更。CloudSQL `guardian` テーブルと `contract_mirror.guardian_id` 追加。`04` / `02` / `03` を更新。
   - Spec §: §6.Must.10 受入基準 / §3 法令前提

3. **「個別支援計画の同意取得日 / 同意者署名 / 計画原案」が `IndividualSupportPlan__c` で表現できない（Cycle 1 Lens D Critical #2 子要素の取り残し）**: `04-salesforce-objects.md` §5 で `PlanStartDate__c` / `PlanEndDate__c` / `Status__c` / `LongTermGoal__c` / `ShortTermGoal__c` 等は定義済み。一方、計画作成プロセスの法定手順「アセスメント → 原案 → サービス担当者会議 → 同意取得 → 実施 → モニタリング」のうち、原案（DraftPlan）の概念が無く、同意取得日（ConsentDate）、利用者本人 or 保護者の同意者識別、計画書 PDF の保管先などが空。Cycle 2 で `Assessment__c` 等を追加したものの、計画本体の同意手続きが従来通り。
   - Why bad: 実地指導の必須記録（個別支援計画の同意書類）が表現できないため、減算リスクが残る。`MonitoringRecord__c.PlanRevisionNeeded__c` が ON になった時の「再同意プロセス」が無いため、計画更新がエビデンスなく行われる事故が想定される。
   - How to fix: Cycle 3 で `IndividualSupportPlan__c` に `DraftCreatedDate__c` / `ConsentObtainedDate__c` / `ConsentSignedBy__c (Lookup Guardian__c)` / `DocumentUrl__c` を追加。
   - Spec §: §6.Must.2 受入基準

## Major（強く推奨）

1. **「障害支援区分の認定有効期間」が `DisabilityCategory__c`（`04-salesforce-objects.md` §4.2）のみで管理されておらず期限管理が空欄（Cycle 1 Lens D Major #1 残存）**: 障害支援区分は通常 3 年で更新が必要。`DisabilityCategoryValidFrom__c` / `DisabilityCategoryValidTo__c` の追加が Cycle 1 で提案されたが Cycle 2 未対応。期限切れで請求拒否されるリスク。

2. **「請求準備」と「請求実績」「返戻・再請求」のサイクルが未表現（Cycle 1 Lens D Major #5 残存）**: `03-cloudsql-ddl.sql` §15 `billing_prep.status ENUM('draft','confirmed','submitted')` のみ。国保連送信後の「返戻（rejection）」「再請求」サイクルが無いため、月次の返戻対応業務が AppSheet で見えない。`billing_submission` / `billing_return` テーブルが Cycle 2 で追加されていない。

3. **「指定事業所の指定有効期限・指定取消事象」が `Facility__c`（`04-salesforce-objects.md` §13）と `facilities` テーブル（`03` §1）に欠落（Cycle 1 Lens D Major #6 残存）**: 指定有効期限切れで請求拒否されるが、Cycle 2 でも `Facility__c` は `FacilityCode / Name / ServiceType / Prefecture / IsActive` のみで `DesignationValidFrom__c` / `DesignationValidTo__c` がない。

4. **「サービス提供時間」と「個別支援時間」「集団支援時間」「機能訓練時間」の区別が `service_records.duration_minutes` のみで吸収されている（Cycle 1 Lens D Major #9 残存）**: 就労継続支援 B 型の工賃計算、生活介護の個別/集団区別、機能訓練加算の対象時間判定で必要だが Cycle 2 未対応。

5. **「特記事項（`service_records.notes`）」の業務種別タグが無い（Cycle 1 Lens D Major #7 と関連、上記 Critical #1 と同根の Major 部分）**: ヒヤリハット・事故報告は別系統で 5 年保管が義務だが、`notes` 自由記述に混在で検索不能。Critical 化を提案。

6. **「サービス担当者会議」「事業所内研修」「虐待防止委員会」「苦情処理」等の業務記録系が依然スコープ外（Cycle 1 Lens D Major #8 残存）**: spec §2 Out of Scope に明示されておらず、Cycle 2 Must.10/Must.11 で契約・上限管理は追加されたが、これらの業務記録系は Cycle 3 以降送り。next-cycle-proposals.md に「次プロジェクト引き継ぎ」として明記すべき。

7. **「医療的ケア」「行動援護」「重度訪問介護」のサービス特性フラグが ServiceAllotment / PersonAccount に追加されていない（Cycle 1 Lens D Major #2 残存）**: 医療連携体制加算、行動援護加算等の判定に必要だが、`PersonAccount` と `ServiceAllotment__c` のいずれにも `MedicalCareNeeded__c` / `SevereBehaviorSupport__c` フラグなし。

8. **`SupportPlan__c` → `IndividualSupportPlan__c` への改名（C-08 解消）に伴うデータ移行手順が空欄**: Cycle 1 で `SupportPlan__c` を使用想定だったが、Cycle 2 で `IndividualSupportPlan__c` に改名（`02-data-model.md` §2.1 ヘッダ「Cycle 1 の SupportPlan__c を IndividualSupportPlan__c に改名し、子エンティティ 3 種を追加」）。実装フェーズ（Cycle 3）でのオブジェクト改名と既存データの移行手順が未記載。Cycle 2 は設計段階だが、Cycle 1 で SupportPlan__c を作って Cycle 2 で改名するパスは混乱の元。

9. **`service_records` の承認フローが 1 段階のまま（Cycle 1 Lens D Major #3 残存）**: 実務では「現場記録 → サ管承認 → 月次確定（請求担当）」の 3 段階だが、`is_approved` の 1 bit のみ。`ApprovalStatus ENUM('pending','approved_by_manager','confirmed_for_billing')` への展開が Cycle 2 未対応。

10. **受給者証番号「市町村番号 + 受給者番号」の構造分解（Cycle 1 Lens D Major #4 残存）**: `recipient_cert_no VARBINARY(256)`（KMS 暗号化）に単一カラム集約。市町村別集計や引越し時対応で困難。Cycle 2 では暗号化対応に集中し、構造分解は手付かず。

11. **「サービス利用計画」（市町村が作成する計画相談支援）と「個別支援計画」（事業所が作成）の区別が無い**: 障害福祉サービスでは利用者ごとに「計画相談支援事業所が作るサービス利用計画」と「事業所が作る個別支援計画」の 2 種が並存する。本システムは事業所側設計のため後者中心は妥当だが、計画相談支援事業所からの「サービス利用計画」コピー保管枠が無い。

12. **上限管理結果票の `direction='sent'`（当事業所が管理）の場合に、他事業所への「送信」業務フローが `07-integration-flows.md` §5 で空欄**: 受信フローは詳細だが、送信フローが「Note over BillingStaff,CS_BP: 月初: 請求担当が billing_prep を確認して confirmed へ」止まり。電子授受方式（FAX/メール/専用システム）も L-13 で法務レビュー待ちのまま空欄。

## Minor（余裕があれば）

1. `DisabilityType__c` の picklist に「難病等対象者」が含まれない（Cycle 1 Lens D Minor #1 残存）。
2. `staff.qualification VARCHAR(50)` 自由記述で、サ管要件（実務経験年数 / 研修受講）の証跡なし（Cycle 1 Lens D Minor #2 残存）。
3. 「指導 / 助言」記録（外部支援機関連携）なし（Cycle 1 Lens D Minor #3 残存）。
4. `addition_master.unit_diff SMALLINT` で減算を負数表現するが、報酬告示の「○% 減算」表現と混在しないか不明（Cycle 1 Lens D Minor #5 残存）。
5. AppSheet HomeView（`05-appsheet-tables.md` §4）に「個別支援計画の更新期限近接アラート」が無い（Cycle 1 Lens D Minor #4 残存）。

## スコア（1-10）

- 完全性: 5（Cycle 1 D#1-5 は大半解消したが、身体拘束・保護者・原案/同意・指定期限・複数支援時間など実地指導の必須項目が Cycle 2 で未対応のまま残存）
- 整合性: 6（用語の整理は進んだ。サ管/サ提責区分、契約 3 点セットの構造は適切。一方 SupportPlan → IndividualSupportPlan 改名のデータ移行が空欄）
- 妥当性: 6（業界要件として骨格は整ったが、実地指導・減算ペナルティ回避の構造的論点が不足）
- 平均: **5.67**
