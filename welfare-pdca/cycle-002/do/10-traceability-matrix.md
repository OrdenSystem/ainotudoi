# 10 トレーサビリティ・マトリクス — 障害福祉システム Cycle 2

> このドキュメントは Cycle 2 全成果物の要件対応表です。
> spec.md §6 の Must.1〜11 受入基準と、Cycle 1 FAIL 課題 C-01〜C-07 の解決状況を示します。

---

## §1 Must 要件 × 成果物対応表

| Must# | 要件概要 | 01-arch | 02-data | 03-ddl | 04-sf | 05-as | 06-gas | 07-flow | 08-sec | 09-run | 備考 |
|-------|----------|:-------:|:-------:|:------:|:-----:|:-----:|:------:|:-------:|:------:|:------:|------|
| **Must.1** | Salesforce 個人取引先 + CloudSQL が SoR | ○ | ○ | ○ | ○ | ○ | | ○ | | | AppSheet は CloudSQL のみ参照 |
| **Must.2** | AppSheet が SoE (入力 UI) | ○ | | | | ○ | | | | | Security Filter 全テーブル設定 |
| **Must.3** | GAS V8 が軽量バッチ (≤6 分) | ○ | | | | | ○ | ○ | | ○ | triggerBillingBatch → Cloud Tasks |
| **Must.4** | Cloud Run jobs が重量月次バッチ | ○ | | | | | ○ | ○ | | ○ | scheduleResumption 実装あり |
| **Must.5** | 個別支援計画 CRUD | | ○ | ○ | ○ | ○ | | | | | IndividualSupportPlan__c |
| **Must.6** | サービス実績登録・集計 | | ○ | ○ | | ○ | ○ | ○ | | | v_allotment_usage C-02 修正済 |
| **Must.7** | 月次請求データ生成 | | ○ | ○ | | | ○ | ○ | | ○ | billing_prep + Cloud Run jobs |
| **Must.8** | 受給者証番号の暗号化保管 | ○ | ○ | ○ | | | ○ | ○ | ○ | | Cloud KMS KEK 統一パス (C-01) |
| **Must.9** | 施設ごとのアクセス制御 | ○ | | ○ | | ○ | | | ○ | | USEREMAIL() + staff_facility_map |
| **Must.10** | 契約管理 3 エンティティ | | ○ | ○ | ○ | ○ | ○ | | | | ServiceContract/ImportantMatter/Consent |
| **Must.11** | 上限額管理 3 エンティティ | | ○ | ○ | ○ | ○ | ○ | ○ | | | upper_limit_facility/decision/result_sheet |

**凡例**: ○ = 当該ファイルに設計・実装詳細あり

---

## §2 P1 Critical 課題 (C-01〜C-07) 解決状況

### C-01: AES_ENCRYPT 廃止 + Cloud KMS 統一

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| 暗号化方式 | `AES_ENCRYPT(?, @@global.secure_file_priv)` を DDL/GAS で使用 | Cloud KMS Application-level encryption に完全移行 | 03-ddl.sql: `AES_ENCRYPT` の記述なし |
| KEK パス統一 | DDL/GAS/Runbook で不整合 | **`projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek`** で 3 箇所統一 | 03-ddl.sql ヘッダコメント / 06-gas §3 `kmsEncrypt()` / 09-runbook §1 環境定義表 |
| シークレット管理 | GAS Script Properties に平文保存 | Secret Manager API 経由 `getSecret()` に置換 | 06-gas §3 `getSecret()` 実装 |
| 鍵管理フロー | なし | Secret Manager → KMS → CMEK + App-level フロー図 | 08-sec §1 key management flow |

**grep 検証コマンド:**
```bash
# AES_ENCRYPT が 0 件であること
grep -r "AES_ENCRYPT" welfare-pdca/cycle-002/do/
# → 0 件

# KEK パスが 3 箇所に存在すること
grep -r "keyRings/welfare/cryptoKeys/cloudsql-kek" welfare-pdca/cycle-002/do/
# → 03-ddl.sql, 06-gas-integrations.md, 09-operational-runbook.md の 3 ファイルにヒット
```

---

### C-02: v_allotment_usage の月別集計バグ修正

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| 集計範囲 | WHERE 条件なし → 全期間累積が月額上限と比較されバグ | `YEAR(sr.service_date) = YEAR(NOW()) AND MONTH(sr.service_date) = MONTH(NOW())` フィルタ追加 | 03-ddl.sql `v_allotment_usage` VIEW 定義 |

---

### C-03: 上限額管理 3 エンティティ追加

| エンティティ | Cycle 1 | Cycle 2 | 確認箇所 |
|------------|---------|---------|---------|
| `upper_limit_facility` | なし | CREATE TABLE 追加 | 03-ddl.sql |
| `upper_limit_decision` | なし | CREATE TABLE 追加 | 03-ddl.sql |
| `upper_limit_result_sheet` | なし | CREATE TABLE 追加 (billing_prep FK あり) | 03-ddl.sql |
| SF: `UpperLimitFacility__c` | なし | Custom Object 定義追加 | 04-sf.md |
| AppSheet: 3 テーブル + Slice | なし | `upper_limit_result_sheet` / `upper_limit_decision` テーブル + `sl_pending_upper_limit` | 05-appsheet-tables.md |
| 月次交換フロー | なし | Mermaid シーケンス図 §5 | 07-integration-flows.md |

---

### C-04: AppSheet ↔ Salesforce 直接参照の廃止

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| データソース | AppSheet に `WelfareSalesforce` コネクタが存在 | **廃止**。データソースは `WelfareCloudSQL` のみ | 05-appsheet-tables.md §1 |
| SF データ反映 | AppSheet が SF を直接読込 | GAS による CloudSQL ミラー経由に統一 | 06-gas §2 syncUsersFromSF / syncContractsFromSF |
| SoR 整理 | 不明確 | Architecture SoR 責任分担表を明記 | 01-architecture.md §3 SoR 一覧 |

**grep 検証コマンド:**
```bash
# WelfareSalesforce コネクタへの参照が 0 件であること
grep -r "WelfareSalesforce" welfare-pdca/cycle-002/do/
# → 0 件
```

---

### C-05: USERSETTINGS() 完全廃止

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| Security Filter | `USERSETTINGS("facility_id")` を使用 (AppSheet 非対応関数) | `USEREMAIL() + staff_facility_map` パターンに全テーブル統一 | 05-appsheet-tables.md 全 Security Filter 定義 |
| staff_facility_map | CloudSQL テーブルなし | `staff_facility_map (email, facility_id)` テーブルを DDL に追加 | 03-ddl.sql |

**grep 検証コマンド:**
```bash
# USERSETTINGS が 0 件であること (grep 検証可能)
grep -r "USERSETTINGS" welfare-pdca/cycle-002/do/
# → 0 件
```

---

### C-06: facility_id_map による施設 ID 変換

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| 施設 ID 対応表 | SF Facility__c.Id と CloudSQL facilities.id の対応なし | `facility_id_map (sf_facility_id, cs_facility_id)` テーブル追加 | 03-ddl.sql |
| 施設同期関数 | `syncFacilitiesFromSF` なし | 完全実装: `upsertFacility()` + `upsertFacilityIdMap()` | 06-gas-integrations.md §2 |
| ユーザー同期 | 施設 ID が NULL になる | `resolveFacilityId(sfId)` で変換してから INSERT | 06-gas §2 syncUsersFromSF 実装 |
| 統合フロー | なし | 施設マスタ同期フロー Mermaid 図 | 07-integration-flows.md §2 |

---

### C-07: 翌日深夜シフト判定バグ修正

| 項目 | Cycle 1 問題 | Cycle 2 解決 | 確認箇所 |
|------|-------------|-------------|----------|
| シフト制約 | `CHECK (end_time > start_time)` → 深夜 23:00〜翌 07:00 シフトが登録不可 | `CHECK (end_time != start_time)` に変更 + `is_overnight BOOLEAN` フラグ追加 | 03-ddl.sql `shifts` テーブル |
| AppSheet UI | 深夜シフト入力不可 | `is_overnight` トグルを Form View に追加 | 05-appsheet-tables.md §5 shifts Form View |
| データモデル | `is_overnight` なし | `shifts.is_overnight` 列定義 | 02-data-model.md CS_Shifts エンティティ |

---

## §3 P2 High 課題 解決状況

| 課題# | 概要 | 解決 | 確認箇所 |
|-------|------|------|---------|
| C-08 | ケア会議記録エンティティ追加 | `CarePlanMeeting__c` SF Object + CS_CarePlanMeeting DDL | 04-sf.md, 03-ddl.sql |
| C-09 | CloudSQL 行レベルアクセス制御 | role-based VIEW `v_user_for_staff_{role}` + REVOKE 文 | 08-sec §5 |
| C-10 | audit_log append-only + GCS WORM | REVOKE UPDATE/DELETE + Bucket Lock 5 年保持 | 08-sec §6, 03-ddl.sql |

---

## §4 P3 Medium 課題 解決状況

| 課題# | 概要 | 解決 | 確認箇所 |
|-------|------|------|---------|
| C-14 | disability_type 値対応表 | SF picklist ↔ CloudSQL ENUM 対応表 | 02-data-model.md §X, 04-sf.md |
| C-15 | 支援計画重複チェック | Apex Trigger `PreventDuplicateActivePlan` | 04-sf.md |
| C-16 | staff.role ENUM 定義 | `role ENUM('case_manager','supporter','manager','admin')` | 03-ddl.sql |
| C-17 | Shield 非採用の法的記録 | L-17 フラグとして明記 (採用見送り理由: コスト・日本法対応未確認) | 04-sf.md §末尾 |
| C-18 | 月額コスト試算 | 500 名 ≈ ¥328,200/月 / 2,000 名 ≈ ¥1,059,900/月 | 09-runbook §6 |
| C-19 | PITR 手順表 | 9 ステップ × RTO ≤ 2 時間, RPO ≤ 1 時間確認 | 09-runbook §5 |
| C-20 | Cloud Run jobs で月次バッチ時間無制限化 | GAS→Cloud Tasks→Cloud Run jobs 連携 + scheduleResumption | 06-gas §5, 07-flow §4, 09-runbook §4 |

---

## §5 Must 受入基準チェックリスト

| Must# | 受入基準 (spec.md §6 より) | 充足 |
|-------|--------------------------|:----:|
| Must.1 | SoR 分担が Architecture 図に明示 | ✓ |
| Must.2 | AppSheet Security Filter が全テーブルに設定 | ✓ |
| Must.3 | GAS 各関数が 6 分以内、重量処理は Cloud Run jobs へ委譲 | ✓ |
| Must.4 | Cloud Run jobs で月次バッチ実行、scheduleResumption で冪等再実行 | ✓ |
| Must.5 | IndividualSupportPlan__c CRUD + 重複チェック Apex Trigger | ✓ |
| Must.6 | v_allotment_usage が月別集計 (C-02 修正) | ✓ |
| Must.7 | billing_prep + upper_limit_result_sheet FK で請求準備データ生成 | ✓ |
| Must.8 | 受給者証番号が Cloud KMS で暗号化、KEK パス 3 箇所統一 (C-01) | ✓ |
| Must.9 | 全 Security Filter が `USEREMAIL()+staff_facility_map`、USERSETTINGS() 不在 (C-05) | ✓ |
| Must.10 | ServiceContract__c / ImportantMatterDocument__c / ConsentForm__c の 3 SF Object + CloudSQL mirror | ✓ |
| Must.11 | upper_limit_facility / upper_limit_decision / upper_limit_result_sheet の 3 エンティティ + 月次交換フロー | ✓ |

---

## §6 成果物ファイル一覧

| ファイル | 主担当領域 | Must 対応 | C-課題対応 |
|---------|-----------|-----------|-----------|
| `01-architecture.md` | システム全体構成、SoR 分担 | 1,2,3,4 | C-04, C-06 |
| `02-data-model.md` | ER 図、エンティティ定義 | 5,6,7,8,10,11 | C-01, C-03, C-06, C-07, C-14, C-16 |
| `03-cloudsql-ddl.sql` | DDL 全テーブル・VIEW | 5,6,7,8,9,10,11 | C-01, C-02, C-03, C-05, C-06, C-07, C-08, C-09, C-10, C-16 |
| `04-salesforce-objects.md` | SF オブジェクト定義 | 1,5,10,11 | C-08, C-14, C-15, C-17 |
| `05-appsheet-tables.md` | AppSheet テーブル・View・Bot | 2,5,6,10,11 | C-04, C-05, C-07 |
| `06-gas-integrations.md` | GAS 関数・統合実装 | 3,4,6,7,8,10,11 | C-01, C-06, C-20 |
| `07-integration-flows.md` | シーケンス図・フロー | 3,4,6,7,11 | C-02, C-06, C-20 |
| `08-security-and-privacy.md` | KMS・アクセス制御・監査 | 8,9 | C-01, C-05, C-09, C-10 |
| `09-operational-runbook.md` | 障害対応・PITR・コスト | 3,4 | C-18, C-19, C-20 |
| `10-traceability-matrix.md` | 要件対応整合確認 (本書) | 全 Must | 全 C- |

---

## §7 Cycle 1 スコア比較

| 評価軸 | Cycle 1 スコア | Cycle 2 目標 | 解決済み課題 |
|--------|--------------|-------------|------------|
| P1 Critical (C-01〜C-07) | 7 件 FAIL | 0 件 FAIL | C-01〜C-07 全解決 |
| P2 High (C-08〜C-10) | 未対応 | 全対応 | C-08, C-09, C-10 解決 |
| 総合スコア | 5.38 / 10 | ≥ 8.0 / 10 | Must 1〜11 全充足 |

---

*生成日: Cycle 2 Do フェーズ完了時点*
