# Lens B — データモデル健全性 — サイクル 002

## 観点と評価軸

`02-data-model.md` / `03-cloudsql-ddl.sql` / `04-salesforce-objects.md` を相互照合し、同一エンティティの型・PK・必須性・参照整合性・命名規則・UNIQUE 制約・冪等性、`v_allotment_usage` の修正（C-02）、`shifts.chk_shift_time` 緩和（C-07）、`recipient_cert_no` の暗号化方式（C-01）、上限管理 3 テーブル（C-03 / Must.11）、契約 3 点セット（Must.10）、`facility_id_map`（C-06）、`disability_type` の型整合性（C-14）、楽観ロック実装、`audit_log` JSON 列の PII 取扱を審査。Cycle 1 Lens B Critical 5 件の解消も確認。

## 確認した成果物

- `welfare-pdca/cycle-002/do/02-data-model.md`（全節）
- `welfare-pdca/cycle-002/do/03-cloudsql-ddl.sql`（全テーブル＋ビュー）
- `welfare-pdca/cycle-002/do/04-salesforce-objects.md`（全節）
- `welfare-pdca/cycle-002/do/05-appsheet-tables.md` §2
- `welfare-pdca/cycle-002/do/06-gas-integrations.md` §3 / §7
- `welfare-pdca/cycle-002/plan/spec.md` §6.Must.1〜6 / Must.10 / Must.11 / §7 データ整合性
- 比較: `welfare-pdca/cycle-001/check-act/lens-B.md`

## Cycle 1 Lens B Critical の解消確認

| Cycle 1 Critical | 解消状況 | 根拠 |
|---|---|---|
| B#1: AES_ENCRYPT(?, @@global.secure_file_priv) の暗号鍵誤り | **完全解消** | `03-cloudsql-ddl.sql` §3 で `recipient_cert_no VARBINARY(256)` に変更、コメントで「Cloud KMS Application-level 暗号化済み」明記。`06-gas-integrations.md` §2.3 `kmsEncrypt()`/`kmsDecrypt()` 実装あり。`syncUsersFromSF` §3 で `kmsEncrypt(rec.RecipientCertNo__c)` → `FROM_BASE64(?)` で格納する流れが完成 |
| B#2: v_allotment_usage が受給期間全体集計 | **解消** | `03-cloudsql-ddl.sql` `v_allotment_usage` の `consumed_hours/times/days` に `YEAR(NOW()) AND MONTH(NOW())` フィルタ追加。`remaining_qty` も当月分のみで計算 |
| B#3: disability_type の SF Picklist と CS VARCHAR(20) の値域不一致 | **解消** | `03-cloudsql-ddl.sql` §3 で `ENUM('physical','intellectual','mental','developmental','other')` に変更、`04-salesforce-objects.md` §4.2 と `02-data-model.md` §2.1 で値対応表を 3 ファイル一致 |
| B#4: shifts.chk_shift_time CHECK(end_time > start_time) で夜勤拒否 | **解消** | `03-cloudsql-ddl.sql` §6 で `CHECK (end_time != start_time)` に緩和、`is_overnight TINYINT(1)` 追加、コメントで夜勤例（22:00→08:00）明記 |
| B#5: SupportPlan VR-02 が VLOOKUP で実装不可 | **解消** | `04-salesforce-objects.md` §5.3 で Apex Trigger ベース疑似コードを明記（SOQL `WHERE Status__c='active' AND PlanStartDate <= NewEnd AND PlanEndDate >= NewStart`）。実装方針が現実的になった |

> 5 件すべて解消。これだけで Cycle 1 比で B 平均は 5.3 から大幅改善。

## Critical（必ず次サイクルで直す）

1. **`Assessment__c` / `MonitoringRecord__c` / `CarePlanMeeting__c`（SF 子オブジェクト）に対応する CloudSQL ミラーが DDL に存在しない**: `04-salesforce-objects.md` §6〜§8 で 3 オブジェクト定義されているが、`03-cloudsql-ddl.sql` には対応するミラーテーブル（`assessment_mirror` / `monitoring_record_mirror` / `care_plan_meeting_mirror`）が存在しない。`02-data-model.md` §1 ER 図に SF_Assessment / SF_MonitoringRecord / SF_CarePlanMeeting は描かれているが、CS 側の対応エンティティが空。`10-traceability-matrix.md` §3 P2 で「C-08: ケア会議記録エンティティ追加 → `CarePlanMeeting__c` SF Object + CS_CarePlanMeeting DDL」と虚偽記述。
   - Why bad: `01-architecture.md` §2 SoR 表で個別支援計画は「CloudSQL ミラー `support_plan_mirror`（Cycle 3 実装）」と明示的に先送り。これは Lens A Critical #3 にも書いたが、データモデル観点でも DDL 不在で AppSheet からの参照経路が成立しない。spec §6.Must.2 受入基準は「親子構造 1:N 関係が定義」を求め、Cycle 2 で SF 側は定義したが、CloudSQL 側で読取不能。`10-matrix` §3 の記述は虚偽（DDL `CS_CarePlanMeeting` は存在しない）。
   - How to fix: Cycle 3 で `support_plan_mirror` / `assessment_mirror` / `monitoring_record_mirror` / `care_plan_meeting_mirror` の DDL を `03-cloudsql-ddl.sql` に追加。同期キー = SF Id。`02-data-model.md` §2.2 にも対応エンティティを追加。
   - Spec §: §6.Must.2 受入基準

2. **`UpperLimitFacility__c`（SF カスタムオブジェクト）が `04-salesforce-objects.md` に未定義**: spec §6.Must.11 受入基準で「`do/03-cloudsql-ddl.sql` と `do/04-salesforce-objects.md` と `do/05-appsheet-tables.md` の 3 箇所に以下 3 エンティティが存在: `upper_limit_facility` / `upper_limit_decision` / `upper_limit_result_sheet`」を明示要求。CloudSQL 側（`03-cloudsql-ddl.sql` §12-14）と AppSheet 側（`05-appsheet-tables.md` §2.8）は揃っているが、`04-salesforce-objects.md` §3 オブジェクト一覧 9 件には上限管理関連オブジェクトがゼロ。`10-traceability-matrix.md` §2 C-03 表で「SF: `UpperLimitFacility__c` なし → Custom Object 定義追加 → 04-sf.md」と主張するが事実反する（04-sf.md に存在しない）。
   - Why bad: spec §10 完了定義「7 章 受入基準すべてが verifier の判定で満たされる」を機械的に解釈すると Must.11 受入基準が満たされていない。設計上、上限管理は CloudSQL 一次入力で十分（spec §4 SoR 表でも「CloudSQL（一次入力）+ Salesforce（マスタ部分）」と並記）とも読めるが、spec の文言は「3 箇所に存在」とハード要求。`10-matrix` の虚偽記述（grep 検証もせず）も合わせて判定を曇らせる。
   - How to fix: 2 案。(a) Cycle 3 で `04-salesforce-objects.md` に `UpperLimitFacility__c` 等の最小オブジェクト定義を追加（同期キー = `facility_number`）。(b) spec.md §6.Must.11 受入基準を「`do/03` と `do/05` の 2 箇所に存在」+「SF 側マスタは Cycle 4 以降」に下方修正し合意取得。次プロジェクト計画でどちらかを選択。
   - Spec §: §6.Must.11 受入基準

3. **`v_allotment_usage` の `consumed_times` / `consumed_days` 集計式が Cycle 1 Lens B Major #8 と同型バグ**: `03-cloudsql-ddl.sql` の VIEW で `WHEN 'times' THEN a.allotment_qty - COALESCE(SUM(CASE WHEN YEAR=YEAR(NOW()) AND MONTH=MONTH(NOW()) AND a.allotment_unit='times' THEN 1 ELSE NULL END), 0)` と書かれているが、`a.allotment_unit` は GROUP BY のキーであり、CASE 内で `a.allotment_unit = 'times'` の条件は常に同じ行内で評価される（unit が times の行内では `1`、それ以外の行内では `NULL`）。SUM 自体は問題ないが、JOIN 先 `service_records` が `times` 単位ではない別サービスの行を含む場合（同じ user_id で `hour` 単位の支給と `times` 単位の支給が並存する場合）に、`hour` 単位レコードまでカウントが膨らむ。spec §6.Must.4 で「複数 ServiceAllotment を保持する利用者が居る」前提（複数サービス並用が業界標準）に対するレースコンディションが残存。
   - Why bad: Cycle 1 で同形バグを指摘したが、Cycle 2 では `YEAR/MONTH` フィルタを足しただけで集計対象の「サービス種別整合」（`sr.service_id` ↔ `a.service_type`）の JOIN 条件が無いまま。`LEFT JOIN service_records sr ON sr.user_id = a.user_id AND sr.service_date BETWEEN a.valid_from AND ...` でしか結合されておらず、サービス種別マッチが無視されている。
   - How to fix: JOIN 条件に `AND EXISTS (SELECT 1 FROM service_master sm WHERE sm.id = sr.service_id AND sm.service_type = a.service_type)` を追加するか、`service_records` に `service_type` を非正規化列として持たせるか、ビュー全体を `(user_id, service_type)` で 1 行になるよう再設計。
   - Spec §: §6.Must.4 受入基準

4. **`audit_log.before_json` / `after_json` に PII 平文を入れる方針が `08-security-and-privacy.md` § と不整合（Cycle 1 Lens B Major #9 残存）**: `03-cloudsql-ddl.sql` §16 `audit_log` で `before_json JSON / after_json JSON` を定義、`08-security-and-privacy.md` §6.1 で `event_type=UPDATE` の例に「before=変更前 JSON, after=変更後 JSON」と書かれている。一方、要配慮 PII（`disability_type`、`notes`、`recipient_cert_no` 等）の変更を audit_log に残すと、平文の要配慮 PII が `audit_log` JSON 列に保存される。`08` §3 PII 一覧では `recipient_cert_no` を Cloud KMS Application-level 暗号化と定義しているが、変更履歴 JSON では平文に展開される矛盾。さらに `audit_log` は `08` §6.2 で 1 時間ごと Cloud Storage WORM に書出されるため、5 年保持のクラウドストレージに要配慮 PII の平文が複製される。
   - Why bad: PII 最小化原則（`08-security-and-privacy.md` §9.1）と矛盾。`audit_log` を保管根拠資料として法令対応する目的と、PII 最小化（Cycle 1 R-09 / spec §6.Must.8 受入基準）が両立しない。GDPR / 個人情報保護法対応で「監査ログから個人情報を消したい」要請が来た時に削除できない（append-only）。
   - How to fix: `audit_log.before_json` / `after_json` を「PII 列を除外したスキーマフィルタ後 JSON」または「Cloud KMS 暗号化済み JSON」に変更。要配慮列は値ではなく「変更フラグ」だけ記録する方式を `03` と `08` に明記。
   - Spec §: §6.Must.8 受入基準 / §7 受入基準（PII 最小化）

## Major（強く推奨）

1. **`02-data-model.md` §2 のフリガナ列が `user_mirror` に存在しない（Cycle 1 Lens B Major #7 残存）**: SF 側 `LastNameKana__c` / `FirstNameKana__c` は §2.1 で定義済み、`03-cloudsql-ddl.sql` §3 `user_mirror` には `last_name_kana` / `first_name_kana` 相当列なし。AppSheet `UserSearchView`（`05-appsheet-tables.md` §4）の「名前・事業所で検索」を業務として実用するには、フリガナ検索（IME 確定前の入力）が必要だが対応カラム不在。

2. **`pushDailySummaryToSF` で更新する SF カスタム項目（`LastServiceDate__c`, `MonthlyServiceMinutes__c`, `MonthlyServiceCount__c` 等）が `04-salesforce-objects.md` の項目定義（§4.1〜§4.4 / §9）に未定義（Cycle 1 Lens B Major #2 / Lens A Major #4 残存）**: GAS バッチが書き込む SF 項目が SF 側で未定義。

3. **`service_records.duration_minutes` AppSheet App Formula が `(end_time - start_time) * 60`（`05-appsheet-tables.md` §2.3）で誤り（Cycle 1 Lens B Major #3 残存）**: AppSheet Time 差分は分単位で返る前提なら `* 60` で 60 倍。秒単位で返る環境なら `/ 60` が正解。AppSheet 公式仕様は Time 差分の戻り単位を厳密に確認していないが、Cycle 1 で指摘した実装誤りがそのまま Cycle 2 にコピーされている。AppSheet スタジオで MINUTE() 関数 + 差分計算など実装方針を明確化すべき。実装時に `SMALLINT UNSIGNED (max 65535)` に対し 60 倍値が入ると数時間のサービスでも即オーバーフロー。

4. **`facilities` テーブル DDL に `sf_account_id` UNIQUE 制約なし（Cycle 1 Lens B Major #4 残存）**: `03-cloudsql-ddl.sql` §1 で `sf_account_id VARCHAR(18) DEFAULT NULL` のみ。`syncFacilitiesFromSF` §4.1 が `SELECT id FROM facilities WHERE sf_account_id = ?` で突合するが UNIQUE 制約がないため重複 INSERT 後に複数行が返るリスク。

5. **`addition_master` に加算適用条件カラムが空欄（Cycle 1 Lens B Major #5 残存）**: `03-cloudsql-ddl.sql` §8 で `addition_code / addition_name / service_type / unit_diff / valid_from / valid_to` のみ。夜間支援体制加算（夜勤実施フラグ）、福祉専門職員配置等加算（職員資格構成）、サービス管理責任者配置加算（サ管在籍）等の条件付き発火が表現できない。Must.6 請求準備の単位数計算ロジックが Cycle 3 で詰まる。

6. **`upper_limit_decision.upper_limit_facility_id` の参照先が `facilities` テーブルと別系統（`upper_limit_facility` テーブル）**: 上限管理事業所は「当事業所 or 他事業所」（`is_own_facility` フラグ）であり、`facilities`（当事業所群）と別テーブルにすることで、当事業所がたまたま上限管理事業所も担っている場合に二重管理になる。`facilities.id` ↔ `upper_limit_facility.id` の対応関係が DDL に無く、同一事業所 2 行（facilities と upper_limit_facility）で `facility_number` がズレるリスク。

7. **`batch_run_log` に「since（差分基準時刻）」を保存する列がない（Cycle 1 Lens B Major #6 残存）**: `06-gas-integrations.md` §3 で `getLastSyncTimestamp(conn, 'sf_sync_users')` 関数を呼ぶが、`03-cloudsql-ddl.sql` §17 `batch_run_log` には `started_at / finished_at` しかなく、「最終成功時の SF LastModifiedDate ハイウォーターマーク」を保存する列が無い。実装時に GAS Script Properties で代用するか、新規列を追加するかが未定。

8. **`user_allotment_cache.sf_allotment_id` の UNIQUE 制約は§10 DDL にあるが、`02-data-model.md` §2.2 / §3 の「同期キー一覧」表との整合性確認が必要**: UNIQUE はあるが、`service_year_month CHAR(6) DEFAULT NULL` で月次パーティション列が空のまま運用される懸念。spec §6.Must.4 受入基準の「`service_year_month` パーティション列を使用」を実現するには、`v_allotment_usage` VIEW で実際に WHERE 条件として使われていない（VIEW は `YEAR(NOW())/MONTH(NOW())` 直接比較）→ パーティション列の存在意義が不明。

9. **`contract_mirror.has_important_matter_doc` / `has_consent_form` の更新ロジックが `syncContractsFromSF` §5 で `checkImportantMatterDoc(auth, rec.Id)` / `checkConsentForm(auth, rec.Id)` と関数呼出のみ書かれ、実装スケッチなし**: SF 側で IMD / Consent 子オブジェクトの存在を毎回確認するなら N+1 クエリで API 制限を圧迫する。Composite API or SOQL サブクエリでまとめる設計が必要だが空欄。

10. **`service_records.shift_date` が `DATE DEFAULT NULL`**: 夜勤紐付け（C-07）で重要なフィールドだが NULL 許可で、入力漏れ時の整合性チェックが無い。実務では「シフト無しでサービス提供」が稀に発生する（突発対応）ためデフォルト NULL は妥当だが、AppSheet 入力 UI で「夜勤シフトの場合は shift_date 必須」のバリデーションが `05-appsheet-tables.md` §2.3 にない。

11. **`Facility__c.FacilityCode__c` と CloudSQL `facilities.facility_code` の UNIQUE 制約が片側のみ**: `03-cloudsql-ddl.sql` §1 では `UNIQUE KEY uq_facility_code`、`04-salesforce-objects.md` §13 では「事業所番号 Text(20) 必須」と書かれるが UNIQUE 制約言及なし。SF 側で重複登録された場合に `syncFacilitiesFromSF` が CloudSQL 側 UNIQUE 制約違反で失敗する。

## Minor（余裕があれば）

1. `02-data-model.md` §2.2 `CS_AuditLog` のコメントが日本語、`03-cloudsql-ddl.sql` §16 はコメント混在。命名と文体の統一余地。
2. `service_records.notes TEXT` のサイズ上限・AppSheet 入力時の文字数制限が未定義。
3. `staff.qualification VARCHAR(50)` が自由記述のままで、サ管要件証跡なし（Cycle 1 Lens D Minor #2 残存）。
4. `audit_log.event_type` が `VARCHAR(50)` の自由文字列。enum 化していないため、ログ集計で表記揺れリスク。
5. `02-data-model.md` §1 ER 図に `audit_log` / `batch_run_log` が描かれていない（Cycle 1 Lens A Minor #2 残存）。
6. `upper_limit_facility.contact_phone` が `VARCHAR(20)` で国際フォーマット未考慮（minor）。

## スコア（1-10）

- 完全性: 6（Cycle 1 Critical 5 件は解消したが、SF 子オブジェクトの CS ミラー欠落、UpperLimitFacility SF オブジェクト欠落、audit_log の PII 取扱が新規 Critical）
- 整合性: 6（disability_type / shifts / KMS 暗号化は整合した。一方 v_allotment_usage のサービス種別 JOIN、addition_master 適用条件、フリガナ列、AppFormula `*60` 誤り等 Major レベルの古傷が複数残存）
- 妥当性: 7（DDL の制約・FK・INDEX 設計は妥当度大幅向上。CMEK / Application-level 暗号化の二段防御は妥当）
- 平均: **6.33**
