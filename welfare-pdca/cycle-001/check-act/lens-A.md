# Lens A — アーキテクチャ整合性 — サイクル 001

## 観点と評価軸

`01-architecture.md` / `07-integration-flows.md` / `10-traceability-matrix.md` を spec.md §4 と照合し、責務分担と連携経路の整合性、SoR / SoE の重複・欠落・循環依存、データソース配置の妥当性、Cycle 1 で導入された新規エンティティ（Facility__c、staff、staff_facility、addition_master、user_allotment_cache、batch_run_log 等）が spec.md / `02-data-model.md` で一貫して扱われているかを審査。

## 確認した成果物

- `welfare-pdca/cycle-001/plan/spec.md` §4, §5, §6.Must.7
- `welfare-pdca/cycle-001/do/01-architecture.md`（全節）
- `welfare-pdca/cycle-001/do/02-data-model.md` §1, §2, §3
- `welfare-pdca/cycle-001/do/07-integration-flows.md` Flow 1〜6
- `welfare-pdca/cycle-001/do/10-traceability-matrix.md` §1, §5
- `welfare-pdca/cycle-001/do/04-salesforce-objects.md` §3, §8
- `welfare-pdca/cycle-001/do/05-appsheet-tables.md` §1, §2.7
- `welfare-pdca/cycle-001/do/06-gas-integrations.md` §1

## Critical（必ず次サイクルで直す）

1. **支給決定情報の SoR が二重定義され、AppSheet が同時に SF 直参照 + CloudSQL キャッシュを参照する設計**: `01-architecture.md` §2 の責務分担表では `ServiceAllotment__c` は「Salesforce 側でのみ書込」「GAS で CloudSQL にキャッシュ」と記載され、`05-appsheet-tables.md` §2.5 では AppSheet が `user_allotment_cache`（CloudSQL ビュー `v_allotment_usage`）を参照、§2.7 では `sf_service_allotments`（SF Object 直参照）も AppSheet 接続として宣言。一方 `02-data-model.md` §3 では「Cycle 1 は AppSheet が SF を直参照」と明記し、CloudSQL 同期は「※」付きで未記載扱い。3 ファイル間で支給決定の参照経路が一致していない。
   - Why bad: 残量計算ビュー `v_allotment_usage` は `user_allotment_cache` を参照するため、CloudSQL 同期が止まれば AppSheet の超過警告（spec §6.Must.4 受入基準）が古いデータで動く。AppSheet 側が SF 直参照と CS キャッシュのどちらを「正」として表示するかも未定義で、利用者・支給量の二重表示や乖離が発生する。
   - How to fix: Cycle 2 で「AppSheet → 支給決定は CloudSQL `user_allotment_cache` を**唯一の参照経路**とし、SF 直参照（`sf_service_allotments`）は廃止」または逆に統一する。spec.md §4 連携経路表、`01-architecture.md` §2 / §3、`02-data-model.md` §3、`05-appsheet-tables.md` §2.7 / §3.3 を一貫させる。
   - Spec §: §4 連携経路と頻度 / §6.Must.4 受入基準

2. **`Facility__c`（Salesforce 事業所オブジェクト）と `facilities`（CloudSQL）の同期方針が未定義**: `04-salesforce-objects.md` §8 で `Facility__c` を定義し `CloudSqlFacilityId__c` 列で CloudSQL ID を保持するとあるが、誰がいつ・どの方向で同期するかが `01-architecture.md` / `06-gas-integrations.md` / `07-integration-flows.md` のいずれにも記載されない。一方 `user_mirror.facility_id` は CloudSQL の `facilities.id`（BIGINT）を FK 参照（`03-cloudsql-ddl.sql` §2）。
   - Why bad: PersonAccount.FacilityId__c は Salesforce 側の Lookup（SF Id）だが、`syncUsersFromSF` の SOQL（`06-gas-integrations.md` §3）は `FacilityId__c` を SELECT するだけで、SF Id → CloudSQL `facilities.id` の解決ロジックが書かれていない。同期実行時にマッピングが解決できず NULL or 不整合になり、`user_mirror` の INSERT が FK 制約 `fk_um_facility` で失敗する。
   - How to fix: `Facility__c.CloudSqlFacilityId__c` を maintained とする運用、または GAS 側に SF Id → CloudSQL ID の lookup テーブル / 関数を追加。事業所マスタ同期バッチ（`syncFacilities`）を新設して 02/03/04/06/07 に明記。
   - Spec §: §4 / §6.Must.1 / §6.Must.7

3. **`01-architecture.md` の Mermaid 図と責務分担表が、`shifts` テーブルの SoE 経路を明記しない**: 図では「AS <--> CS_ST」（staff/shifts 双方向 CRUD）と描かれているが、責務分担表 §2 では「CloudSQL staff/shifts → AppSheet 経由で書込」と書きつつ、Salesforce 側に対応する `Staff` オブジェクトの有無が `04-salesforce-objects.md` §9 で「シフト管理者は Salesforce 外で管理」とのみ記載され、CloudSQL `staff.sf_user_id` で Salesforce User とは紐付ける設計（`02-data-model.md` §2.2 / `03-cloudsql-ddl.sql` §3）と矛盾。
   - Why bad: スタッフ作成は AppSheet 経由（CloudSQL 直）なのか、SF User 作成後に GAS 同期で `staff` に流すのかが Cycle 1 で確定していない。`04-salesforce-objects.md` §9 の `WF_*` プロファイルは SF にスタッフが存在する前提なので、二重管理 or 不整合になる。
   - How to fix: Cycle 2 で「スタッフは Salesforce User + CloudSQL `staff` のどちらが SoR か」を確定し、`sf_user_id` のセット手順（手動 or GAS バッチ）を 01/04/06/07 で統一。

4. **`audit_log` 書込みのアクター・経路がアーキ図と DDL で不整合**: `01-architecture.md` Mermaid では「CS_SR & CS_UM --> 変更ログ CS_AL」と表現されているが、`03-cloudsql-ddl.sql` §11 の DDL には CDC トリガーや MySQL Audit Plugin の利用が記載されず、`06-gas-integrations.md` §3 の `upsertUserMirror` でも `audit_log` INSERT は呼ばれない。Flow 3（`07-integration-flows.md`）の「DB ->> DB: audit_log INSERT」もアプリ層からのトリガなのか DB トリガなのか不明。
   - Why bad: spec §6.Must.8「監査ログ要件」が「書き込まれる前提」だけで、実装責務が誰にあるかが空欄。AppSheet 経由の更新は監査されず、GAS バッチ経由の更新だけ部分的に記録される穴ができる。
   - How to fix: Cycle 2 で「AppSheet 編集も audit_log に残す手段」（AppSheet Bot か MySQL Trigger か GAS 経由か）を確定し、03 と 06、08 §5.1 を一貫させる。

## Major（強く推奨）

1. **`01-architecture.md` の Mermaid 図に Salesforce ⇄ CloudSQL 間の事業所同期エッジが欠落**: `Facility__c` から `facilities` への矢印が描かれていない。Critical #2 と同根。
2. **GAS Web App `exportBillingCSV` の認証経路が `01-architecture.md` §5 に未掲載**: §5 は Connected App（SF 連携用）だけ。AppSheet → GAS WebApp の OAuth / API Key の認証方式が `01-architecture.md` で抜けており、`05-appsheet-tables.md` §5「External: open URL」+ `06-gas-integrations.md` §7「組織内のユーザーのみ」だけが情報源。クロスファイルで一貫しない。
3. **`v_allotment_usage` ビューが `service_records.is_approved=1` 行のみ集計するが、未承認分の扱いが Flow 5 / spec §6.Must.4 受入基準（「超過時の警告」）と整合するか不明**: 未承認の入力中レコードが残量に反映されないため、「現場で未承認状態だが実消費している時間」が見えない。要件として承認前消費を含めるか除外するかの方針が不在。
4. **`pushDailySummaryToSF`（`06-gas-integrations.md` §6 / Flow 2）が PersonAccount に書き込むカスタム項目 `LastServiceDate__c`, `MonthlyServiceMinutes__c`, `MonthlyServiceCount__c` が `04-salesforce-objects.md` で定義されていない**: 連携先カスタム項目が SF オブジェクト定義に不在。
5. **`01-architecture.md` §4.1 で HA 構成「Single-zone で開始」とあるが、§4.1 の RPO/RTO（`09-operational-runbook.md` §1）と整合性に懸念**: Single-zone のままで RPO ≤ 1h / RTO ≤ 4h は PITR 前提だが、ゾーン障害時には PITR 復元先ゾーンの選定とリードレプリカ昇格手順が必要で、Runbook §3 シナリオ B に未記載。
6. **AppSheet `sf_person_accounts` / `sf_service_allotments` / `sf_support_plans`（`05-appsheet-tables.md` §2.7）と CloudSQL `user_mirror` の役割境界がアーキ図と齟齬**: アーキ図（`01-architecture.md` §1）では AppSheet → CloudSQL `user_mirror` は「読取のみ」だが、AppSheet が同時に SF 側も読取として参照する場合、現場 UI で「どちらの利用者リスト」を表示するかが Cycle 1 で決まっていない。

## Minor（余裕があれば）

1. `01-architecture.md` §3 表で AppSheet → Salesforce 行が「— 冪等性」になっているが、AppSheet キャッシュ整合性の方針（同期間隔）を 1 行追加するとよい。
2. `02-data-model.md` §1 の ER 図に `audit_log` / `batch_run_log` が記載されておらず、`shifts` も省略されている（凡例には現れない）。クロスチェック時に視覚的整合性が低い。
3. `07-integration-flows.md` Flow 1 のシーケンスで `sf_synced_at` 比較ロジック（Critical #1 で言及した競合解決）が文章のみ。Mermaid 内に明示するとよい。

## スコア（1-10）

- 完全性: 6（Facility 同期・staff SoR 決定・audit_log 書込み経路が空欄）
- 整合性: 5（支給決定の参照経路が 3 ファイル間で矛盾。Critical #1）
- 妥当性: 7（基本方針 SoR/SoE は妥当。連携頻度も実用的範囲）
- 平均: **6.0**
