# Lens D — 福祉業界要件 — サイクル 001

## 観点と評価軸

spec.md §3 法令前提・§6 受入基準と照合。障害福祉サービス特有の概念（受給者証、サービス等級、支給決定、加算/減算、モニタリング、個別支援計画、サービス管理責任者、利用契約、利用者負担、上限管理、実地指導 等）の取り扱いに穴がないかを精査。一般 IT 観点だけでは気付きにくい論点を洗い出す。

## 確認した成果物

- `welfare-pdca/cycle-001/plan/spec.md` §3 法令前提 / §6 Must / §8 リスク台帳
- `welfare-pdca/cycle-001/do/02-data-model.md`
- `welfare-pdca/cycle-001/do/04-salesforce-objects.md`
- `welfare-pdca/cycle-001/do/03-cloudsql-ddl.sql`
- `welfare-pdca/cycle-001/do/08-security-and-privacy.md`
- `welfare-pdca/cycle-001/do/10-traceability-matrix.md` §3, §4

## Critical（必ず次サイクルで直す）

1. **「上限管理事業所」「利用者負担上限月額」「上限管理結果票」の概念が一切モデル化されていない**: 障害福祉サービスでは複数事業所利用時に「利用者負担上限月額」を超えないよう「上限管理事業所」が管理結果票を作成して国保連請求に添付する。`02-data-model.md` / `04-salesforce-objects.md` / `03-cloudsql-ddl.sql` のいずれにも上限管理関連の項目（負担上限月額、上限管理事業所フラグ、管理結果区分等）が見当たらない。
   - Why bad: spec §6.Must.6 で「国保連請求準備データ」を Must 化しているのに、上限管理結果票の入出力が無いと国保連請求 CSV を作っても受理されない（=Cycle 1 の請求モデルが現実の請求業務に直結しない）。`02 Out of Scope`「国保連 CSV の完全仕様」と書かれてはいるが、上限管理は完全仕様以前の構造的論点であり Cycle 1 構造設計に含めるべきだった。
   - How to fix: Cycle 2 の Must に「上限管理事業所モデル」「負担上限月額」を昇格。`PersonAccount` 拡張 / `user_mirror` 拡張で `monthly_burden_cap`, `cap_management_facility_id` を追加。
   - Spec §: §3 法令前提（報酬告示）/ §6.Must.6

2. **「個別支援計画作成」「アセスメント」「サービス担当者会議」「モニタリング実施記録」の関連エンティティが欠落**: `SupportPlan__c`（`04-salesforce-objects.md` §5）は「計画期間 / 長期目標 / 短期目標 / モニタリング周期」のみで、計画作成までの**アセスメント記録**、計画原案、サービス担当者会議の議事録、モニタリング実施記録（周期どおりに実施したかの履歴）が無い。
   - Why bad: 個別支援計画の妥当性は **アセスメント → 原案 → 会議 → 同意署名 → 実施 → モニタリング** の一連の手続きで担保される。実地指導（行政監査）では各段階の記録が求められる。Cycle 1 で「計画レコード 1 行」だけで Must.2 受入基準（spec §6.Must.2）を満たしたと評価しているが、実地指導で減算対象になる構造。
   - How to fix: Cycle 2 で `Assessment__c`, `MonitoringRecord__c`, `ServiceMeetingRecord__c` のカスタムオブジェクトを追加。または最小でも `SupportPlan__c` に「同意取得日」「同意者署名」「次回モニタリング予定日」を追加し、`MonitoringRecord__c` を別オブジェクトで作成。
   - Spec §: §6.Must.2 受入基準

3. **「サービス提供責任者」（居宅介護等）と「サービス管理責任者」（生活介護 / 就 B / GH 等）の区別が混在**: spec §3 では「サービス管理責任者」のみ言及、`04-salesforce-objects.md` §5.2 で `SupportPlan__c.ServiceManager__c` も「サービス管理責任者（SF User）」。spec §2 のスコープに居宅介護は含まれないが、§2 In Scope に「生活介護・就労継続支援 B 型・グループホーム等」と「等」を含む。
   - Why bad: 役職名が固定されると、提供サービス種別を増やす時に再設計が必要。また `ServiceManager__c` を `Lookup(User)` で取っているが、サ管は事業所単位で 1 人指定（または兼任）が原則で「事業所のサ管」「計画のサ管」の重複定義になる可能性。
   - How to fix: Cycle 2 で「役職を `Staff.role` で持つ」「`SupportPlan__c.ServiceManager__c` は計画担当の Staff へ Lookup」「事業所側に `responsible_manager` を持つかは別議論」と分離。spec §3 / 04 §5.2 を改訂。

4. **受給者証の「給付の支給決定期間（サービス決定期間）」と「自己負担上限額の決定期間」が混在 or 単一フィールドで表現できると誤認**: `ServiceAllotment__c`（`04-salesforce-objects.md` §7）に `ValidFrom__c` / `ValidTo__c` があるが、これは「支給量の有効期間」を意味する。受給者証には「自己負担上限額の決定期間」も同居しており、両者は更新タイミングが異なる場合がある。
   - Why bad: 1 件の `ServiceAllotment__c` で 2 種類の期間を表せず、現実の受給者証の写しを Salesforce で再現できない可能性。後の請求エラーや実地指導で「上限管理開始日のずれ」が露見しやすい。
   - How to fix: Cycle 2 で「支給期間」「自己負担上限額決定期間」を別フィールド or 別オブジェクトに分離。

5. **「契約書 / 重要事項説明書」のドキュメント管理エンティティが Cycle 1 に無い**: 障害福祉サービスでは利用契約締結が法的に必要で、契約書 PDF / 重要事項説明書 PDF / 同意書を利用者ごとに保持する義務がある。`02-data-model.md` / `04-salesforce-objects.md` のいずれにも `Contract__c` / `ConsentForm__c` 系オブジェクトが存在しない。
   - Why bad: spec §2 In Scope に「利用者マスタ」「個別支援計画」「サービス記録」と並べているが、契約締結記録なしでは「個別支援計画作成」の前段が成立しない。実地指導の指摘事項頻出領域。
   - How to fix: Cycle 2 で `Contract__c` を `Salesforce Files` 連動の最小オブジェクトとして追加。契約期間と更新サイクルを管理。

## Major（強く推奨）

1. **「支援区分」「障害支援区分の認定有効期間」が `DisabilityCategory__c`（`04-salesforce-objects.md` §4.2）のみで表現され、認定の有効期間（通常 3 年）の管理が無い**: 障害支援区分は更新管理が必要。Cycle 2 で `DisabilityCategoryValidFrom__c`, `DisabilityCategoryValidTo__c` を追加。
2. **「医療的ケア」「行動援護」「重度訪問介護」等のサービス特性が `ServiceAllotment__c.ServiceType__c` Picklist だけでは表現不足**: 加算条件（医療連携体制加算等）と紐付ける属性として `medical_care_needed`, `severe_behavior_support` のフラグが必要。
3. **「サービス提供記録」の承認フロー（`service_records.is_approved`）に「サービス管理責任者承認」と「請求担当者確認」の二段階区別がない**: 実務では「現場記録 → サ管承認 → 月次確定」の流れだが、Cycle 1 設計では 1 ステップ承認のみ。
4. **受給者証番号の「市町村番号 + 受給者番号」の構造が `VARCHAR(20)` の単一カラムに押し込まれている**: 市町村別の集計や、利用者の引越し時に対応する市町村が変わるシナリオで分解が必要になる。Cycle 2 で `municipality_code` + `recipient_no` に分割を検討。
5. **「請求準備」と「請求実績」の区別が無い**: `billing_prep` は「準備データ」とあるが、国保連請求送信後の返戻・再請求のサイクルを表すテーブルがない。Cycle 2 で `billing_submission` / `billing_return` を最小でも構造定義。
6. **「事業所種別の指定有効期限」「指定取消事象」等の事業所監査属性が `Facility__c` に無い**: 指定有効期限切れで請求が拒否されるが、Cycle 1 設計で気付かない構造。
7. **「特記事項（`service_records.notes`）」が要配慮 PII 扱いだが、「ヒヤリハット」「事故報告」「身体拘束記録」等の業務種別タグが無い**: 法令上、これらは別系統で記録 5 年保管が義務。`event_type` 列を追加すべき。
8. **「サービス担当者会議」「事業所内研修」「虐待防止委員会」等の業務記録系がスコープ外で扱われていない**: spec §2 Out of Scope に明示されていないにも関わらず、設計成果物から欠落している。Cycle 2 で In/Out スコープを再定義。
9. **「サービス提供時間」と「個別支援時間」「集団支援時間」の区別が `service_records.duration_minutes` のみで吸収されている**: 就労継続支援 B 型の工賃計算や生活介護の個別 / 集団区別に必要。
10. **「保護者 / 後見人」エンティティが Person Account の「緊急連絡先」フィールドだけ**: 18 歳未満 / 成年後見の利用者では契約署名者 / 同意者が利用者本人ではない。`Guardian__c` / `LegalRepresentative__c` カスタムオブジェクトが Cycle 1 に無い。

## Minor（余裕があれば）

1. `DisabilityType__c` の picklist に「難病等対象者」が含まれない（障害者総合支援法対象に難病等あり）。
2. `staff.qualification` が `VARCHAR(50)` の自由記述で、サ管要件（実務経験年数 / 研修受講）の証跡が無い。
3. 「指導 / 助言」記録（外部支援機関との連携記録）が無い。
4. AppSheet HomeView（`05-appsheet-tables.md` §4）に「個別支援計画の更新期限近接アラート」が無い。
5. `addition_master.unit_diff SMALLINT` で減算を負数で表現しているが、報酬告示で「○% 減算」表現の項目もあり、率 vs 単位差の表現が混在しないか不明。

## スコア（1-10）

- 完全性: 4（上限管理 / アセスメント / モニタリング記録 / 契約書管理 / 業務記録系の主要概念が欠落）
- 整合性: 6（業界用語の使い方は概ね正しいが、サ管/サ責の混在、支給期間と上限管理期間の分離が甘い）
- 妥当性: 5（一般 IT 観点では妥当だが、福祉業界要件として実用は厳しい）
- 平均: **5.0**
