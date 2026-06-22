# 障害福祉システム — サイクル 002 仕様書

> Brief: "Salesforce + AppSheet + GAS + GCP CloudSQL で障害福祉サービス事業所の業務を一気通貫支援する基盤を、Cycle 1 FAIL の主因（P1 7 件）を解消した上で、福祉業界要件（契約・上限管理）と運用品質を兼ね備えた設計図として確定する"
> 前サイクルからの主な変更:
> - Cycle 1 FAIL 主因（総合 5.38）の P1 Critical 7 件（C-01〜C-07）を全て Must 受入基準に直結させ、verifier が「解消したか」を客観判定できる形に明文化した。
> - Must 数を **9 → 11** に拡張（契約管理 / 上限管理を福祉業界必須として昇格）。
> - AppSheet App ID `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`（HopeCareDX_ainotudoi-443914355）を **既知前提化** し、Cycle 1 R-01「AppID 未受領で机上論化」を解消。

## 1. Vision

中小規模の障害福祉サービス事業所（生活介護・就労継続支援 B 型・グループホーム等）において、サービス管理責任者・生活支援員・請求担当が **1 つの導線（AppSheet HopeCareDX）から、契約締結・受給者証管理・上限管理事業所間の連携を含む実運用に耐える業務フロー** を実施でき、月次の国保連請求準備までを内部で完結できる状態を、設計図ベースで確定する。Cycle 2 では Cycle 1 で抜けていた福祉業界固有要件（契約・上限管理）と運用品質（鍵管理・監査ログ・行レベル制御）を盛り込み、verifier 総合スコア ≥ 6.5 を達成する。

## 2. Scope

### In scope
- 利用者マスタ（基本情報・受給者証・支給決定情報）の管理モデル
- **契約・重要事項説明書・同意書管理（新規 Must.10）**
- 個別支援計画（アセスメント / モニタリング / サービス担当者会議を含む親子構造）
- 日次サービス提供記録（GH 夜勤シフト＝日跨ぎ対応含む）
- スタッフ・シフトモデル
- **上限管理（上限管理事業所 / 利用者負担上限月額 / 上限管理結果票）（新規 Must.11）**
- 月次請求準備データ（上限管理結果反映後の単位数集計まで）
- Salesforce ⇄ GAS ⇄ CloudSQL ⇄ AppSheet の連携設計（単一経路で SoR 二重定義を解消）
- セキュリティ・PII 保護方針（CMEK + Cloud KMS による鍵管理経路の明文化）
- AppSheet 行レベル制御の改竄不可化（USERSETTINGS 全廃）
- 月次バッチの GAS 6 分上限対策（Cloud Run jobs への分離）

### Out of scope（将来サイクル送り）
- 国保連 CSV 出力フォーマットの完全仕様
- 帳票印刷レイアウト
- 利用者家族向けポータル
- AI 機能（Claude API）の組込み — Cycle 1 R-09 と C-01 の解消優先のため Cycle 3 以降
- 多事業所横断 BI ダッシュボード
- スマホネイティブ実装
- 国保連レセプト電子請求の送信本体（外部システム連携前提）
- 個別事業所カスタム帳票
- 多言語化

## 3. ステークホルダーと前提

### 利用ユーザー
| 役割 | 主要操作 |
|---|---|
| サービス管理責任者（サビ管） | 利用者登録、契約締結、個別支援計画作成、月次集計確認 |
| サービス提供責任者（サ提責） | サービス提供記録監修、シフト調整 |
| 生活支援員 | 日次サービス記録入力、利用者情報参照 |
| シフト管理者 | スタッフ・シフト登録（**夜勤シフト = 日跨ぎ対応**） |
| 請求担当 | 月次請求準備データのレビュー、上限管理結果票授受、国保連向けエクスポート |
| 事業所管理者 | アクセス権限管理、監査ログ確認、契約書類保管 |

### 法令前提（**条文判断は本プロジェクト範囲外。法務レビューフラグのみ**）
- 障害者総合支援法（支給決定情報、サービス等級、受給者証番号の管理）
- **障害福祉サービス等利用契約（契約書 + 重要事項説明書 + 同意書の 3 点セット必須）**
- 個人情報保護法（要配慮個人情報＝障害種別・支援内容の取扱い）
- **実地指導減算リスク**（アセスメント / モニタリング / サービス担当者会議の記録欠落で報酬減算）
- 障害福祉サービス等報酬告示（**上限管理事業所間の月次授受**含む）

### 既存資産前提（`existing-assets.md` 由来 / Cycle 2 更新点）
- **AppSheet AppID 確定**: `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`（HopeCareDX_ainotudoi-443914355）。Region `www`。
- Salesforce: Enterprise Edition + Person Account 有効化を継続仮定。Shield Platform Encryption は **Cycle 2 では不採用**（R6 / C-18）。
- GAS: V8 ランタイム継続。**月次バッチは Cloud Run jobs に分離**（R8 / C-20）。
- CloudSQL: MySQL 8.x Enterprise / `asia-northeast1` / `db-custom-2-7680` 継続。**CMEK 必須化（KEK = Cloud KMS / asia-northeast1）**（R7 / C-01）。
- 用語追加: **夜勤シフトは `shift_date` + `is_overnight` フラグで管理し、`start_time > end_time` の表現を許容**（C-07）。

## 4. アーキテクチャ方針（高レベル）

### System of Record（SoR）の単一化（C-04 / C-12 / C-13 解消）

| エンティティ | SoR | 補助レイヤ | AppSheet 接続方針 |
|---|---|---|---|
| 利用者マスタ（Person Account） | **Salesforce** | CloudSQL `user_mirror`（読取専用キャッシュ） | **CloudSQL 経由でのみ読取**（直接 SF 参照しない） |
| 契約・同意書（新規） | **Salesforce** | CloudSQL `contract_mirror` | CloudSQL 経由読取 |
| 支給決定 | **Salesforce** | CloudSQL `allotment_cache`（月次キャッシュ） | CloudSQL 経由読取 |
| 個別支援計画（アセスメント / モニタリング含む） | **Salesforce** | CloudSQL `support_plan_mirror` | CloudSQL 経由読取 |
| サービス提供記録 | **CloudSQL** | — | CloudSQL 直接 CRUD |
| スタッフ・シフト | **CloudSQL** | SF `User` と `facility_id_map` で連携 | CloudSQL 直接 CRUD |
| 上限管理（事業所 / 月額 / 結果票）（新規） | **CloudSQL**（一次入力） + Salesforce（マスタ部分） | — | CloudSQL 直接 CRUD |
| 請求準備データ | **CloudSQL** | — | CloudSQL 読取 + Cloud Run jobs 書込 |
| 監査ログ | **CloudSQL append-only テーブル** + Cloud Storage WORM バケット | — | AppSheet からは見せない（管理コンソール経由のみ） |

> **重要原則**: AppSheet が Salesforce 直参照と CloudSQL 経路を同時に使う設計は禁止。すべての SF 由来データは CloudSQL ミラー経由で読み取る。これにより同期キーの一意性、Security Filter の単一化、監査経路の単一化が達成される。

### Facility マスタの連携（C-06 解消）
- Facility は SF 側 SoR、CloudSQL 側で `facility_id_map`（`salesforce_id` ↔ `cloudsql_id`）で解決。
- `user_mirror.facility_id` などの FK は **必ず `facility_id_map` 経由で解決**（GAS `syncFacilitiesFromSF` 関数を新設）。

### 鍵管理経路（C-01 解消 / R7 採用）
- Cloud KMS（`asia-northeast1` キーリング）
  - → CloudSQL CMEK（KEK = `projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek`）
  - → Cloud Run jobs / Cloud Functions が `cloud-kms` API で受給者証番号等の Application-level 暗号化
  - → Secret Manager（接続情報・サービスアカウント鍵）は別管理
  - → AppSheet には平文を返さず、表示用 View で末尾 4 桁マスク表示
- フルパス（DDL / GAS / Runbook 3 箇所で同名参照）: `projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek/cryptoKeyVersions/{v}`

### 連携経路と頻度（Cycle 1 から更新）
| From | To | 方向 | 頻度 | 手段 |
|---|---|---|---|---|
| Salesforce | CloudSQL | 一方向（マスタ配信） | 1 時間ごと差分 + 手動全件 | GAS V8 + UrlFetchApp + SF REST API |
| Salesforce | CloudSQL | 一方向（Facility マスタ） | 日次 + 変更時即時 | GAS `syncFacilitiesFromSF`（C-06） |
| CloudSQL | Salesforce | 一方向（集計連携） | 日次バッチ | GAS V8 + UrlFetchApp |
| AppSheet | CloudSQL | 双方向（CRUD） | リアルタイム | AppSheet 公式 MySQL コネクタ |
| **GAS** | **Cloud Run jobs** | **起動 + 結果取得** | **月次（請求準備バッチ）** | **Cloud Tasks + IAM 認証 HTTP**（C-20 / R-06 解消） |
| Cloud Run jobs | CloudSQL | バッチ書込 | 月次 | Cloud SQL Auth Proxy + CMEK |
| 上限管理事業所 | 当事業所 | 月次授受（紙 or 電子） | 月次 | 受信エビデンス CloudSQL 保存（L-13 要法務） |

### 採用しない選択肢と理由
- **Salesforce Shield Platform Encryption 不採用**（R6 / C-18）: 純額 20% コスト増、要配慮 PII は CloudSQL CMEK に集中。L-17 法務レビュー必須。
- **AppSheet DB / Google Sheets 不採用**: 件数・履歴・JOIN 要件で限界。
- **Health Cloud 不採用（Cycle 2 据置）**: ライセンス費高、Person Account ベースで業務カバー可能。
- **AI 機能（Claude API）非投入**（Cycle 2 据置）: C-01 解消が前提条件、PII マスキング基盤未整備。
- **PostgreSQL 不採用**: MySQL 継続（R4 維持）。
- **CloudSQL 単独 SoR 不採用**: Cycle 1 と同方針、SF の標準監査・FLS を活用。

## 5. 技術選定（根拠つき）

| 領域 | 採用 | 代替候補 | 採用理由（最新調査ベース）| 出典 |
|---|---|---|---|---|
| 利用者マスタ | Salesforce EE + Person Account | Health Cloud / 自作 RDB | Cycle 1 R2 維持。Person Account が「個人客＝利用者」モデルに直接対応 | [tech-research-notes (Cycle 1) R2](../../cycle-001/plan/tech-research-notes.md#r2) |
| 現場入力 UI | AppSheet（App ID 確定） | PowerApps / 自作 | R1 維持 | [tech-research-notes (Cycle 1) R1](../../cycle-001/plan/tech-research-notes.md#r1) |
| バッチ・連携（軽量） | GAS V8 + UrlFetchApp | Cloud Functions | R3 維持。Salesforce → CloudSQL の 1 時間差分同期は GAS で十分 | [tech-research-notes (Cycle 1) R3](../../cycle-001/plan/tech-research-notes.md#r3) |
| **バッチ・連携（重量・月次）** | **Cloud Run jobs** | Cloud Functions 2nd gen (event-driven 60 分) | **GAS 6 分上限を根本解決。Cloud Run jobs は時間無制限。GAS から Cloud Tasks 経由で起動** | [tech-research-notes R8](./tech-research-notes.md#r8) |
| 業務 DB | CloudSQL for MySQL 8 Enterprise / asia-northeast1 / db-custom-2-7680 | PostgreSQL / Enterprise Plus | R4 維持 | [tech-research-notes (Cycle 1) R4](../../cycle-001/plan/tech-research-notes.md#r4) |
| **DB 鍵管理** | **Cloud KMS CMEK（asia-northeast1）** | Google 管理鍵 / Salesforce Shield | **C-01 解消の中核。KEK ローテーション 90 日。バックアップも同じ CMEK で暗号化** | [tech-research-notes R7](./tech-research-notes.md#r7) |
| **SF 側追加暗号化** | **採用見送り（CloudSQL CMEK に集中）** | Salesforce Shield Platform Encryption | **純額 20% コストで Cycle 2 段階では ROI 不成立。L-17 法務レビューで非採用説明責任** | [tech-research-notes R6](./tech-research-notes.md#r6) |
| **AppSheet 行レベル制御** | **USEREMAIL() + `staff_facility_map` 参照（USERSETTINGS 全廃）** | USERSETTINGS / USERROLE | **C-05 解消。USERSETTINGS はクライアント改竄可能** | [tech-research-notes R9](./tech-research-notes.md#r9) |
| AI 機能 | **Cycle 2 では未投入** | Claude Sonnet 4.6 | C-01 / R-09 解消優先、Cycle 3 で再検討 | — |

## 6. 機能リスト（優先順）

### Must（このサイクルで設計成果物として完成 / 11 項目）

1. **利用者マスタ管理**: Salesforce Person Account に受給者証番号・支給決定・障害種別・緊急連絡先を保持。AppSheet からは CloudSQL `user_mirror` 経由で読取（C-04: AppSheet 直 SF 参照禁止）。
   - 受入基準: SF オブジェクト定義（`do/04-salesforce-objects.md`）に 全フィールド名・型・必須/任意・FLS 方針が記載。受給者証番号は **Cloud KMS CMEK + Application-level 暗号化対象** として明示。`disability_type` 値域は SF picklist と CloudSQL ENUM の対応表が `do/04` に存在（C-14）。

2. **個別支援計画（アセスメント / モニタリング / サービス担当者会議を含む）**: 計画期間・支援目標・モニタリング周期・サービス担当者会議の議事録を SF カスタムオブジェクトで親子構造化（C-08）。
   - 受入基準: SF 上で `IndividualSupportPlan__c` を親、`Assessment__c` / `MonitoringRecord__c` / `CarePlanMeeting__c` を子とした 1:N 関係が定義。**実地指導減算リスク**（Cycle 2 §3 法令前提）に対応する記録欠落検出ルールが明示。重複 active 計画チェックは **Apex Trigger or SOQL ベース Validation Rule** で実装案を `do/04` に記載（C-15）。

3. **日次サービス提供記録**: GH 夜勤含む日跨ぎシフトに対応した記録モデル。AppSheet で入力、CloudSQL 保存。
   - 受入基準: `service_records` DDL に外部キー制約・複合インデックス（`user_id`, `service_date`）・タイムゾーン（Asia/Tokyo）・`shift_date` + `is_overnight` フラグ参照が明示。`shifts.chk_shift_time` 制約は `end_time != start_time` のみに緩和、日跨ぎサンプルレコードコメント必須（C-07）。

4. **支給決定残量計算（月単位の正しい集計）**: 月内消費分のみで超過判定（C-02 解消）。
   - 受入基準: `v_allotment_usage` 集計 SQL が `WHERE YEAR(service_date) = YEAR(NOW()) AND MONTH(service_date) = MONTH(NOW())` または `service_year_month` パーティション列を使用。`do/03-cloudsql-ddl.sql` にサンプル SQL 必須。AppSheet 側 Slice/View 設計、超過時の警告ルールが明文化。

5. **スタッフ・シフトモデル**: 1 スタッフ複数事業所兼務、夜勤日跨ぎ対応、シフト衝突検出。SF `User` と CloudSQL `staff` の同期キー `facility_id_map` 経由で解決（C-06 / C-12 / C-13）。
   - 受入基準: `staff` テーブル DDL に `salesforce_user_id` カラム、`facility_id_map` 経由の FK 解決方針、Staff.role に `service_manager` / `service_provider_lead` / `support_worker` / `billing_officer` / `facility_admin` の enum 値定義（C-16）。

6. **請求準備データ生成（上限管理結果反映）**: 月次バッチで `service_records` → `billing_prep` 集計。**Cloud Run jobs で実行（C-20 / R-06 解消）**。上限管理結果票の数値反映を含む。
   - 受入基準: Cloud Run jobs `generateBillingPrep` の I/O 仕様・冪等性・エラー再実行手順を `do/06-gas-integrations.md` および `do/07-integration-flows.md` に記載。`billing_prep` DDL 完備、上限管理結果票テーブル（Must.11）からの参照 FK あり。GAS からの起動コードスケッチ必須。

7. **Salesforce ⇄ CloudSQL 同期バッチ設計（Facility マスタ含む）**: GAS で利用者マスタ・支給決定・**Facility** を 1 時間ごと差分同期（C-06）。
   - 受入基準: 同期キー（`salesforce_id`）・競合解決ルール（last-write-wins + 警告ログ）・失敗時リトライ方針・実行ログ保存先が `do/06-gas-integrations.md` に記載。`syncFacilitiesFromSF` 関数仕様明記。

8. **セキュリティ・PII 保護方針（鍵管理経路フルパス明文化 / USERSETTINGS 全廃 / append-only 監査ログ）**: C-01 / C-05 / C-09 / C-10 を統合解決。
   - 受入基準:
     - **鍵管理パス**: `do/08-security-and-privacy.md` に `Secret Manager → CloudSQL CMEK → Cloud Run jobs Application-level 暗号化 → AppSheet マスク表示` の完全フローが記述、KEK ID 文字列が DDL / GAS / Runbook の 3 箇所で同一（C-01）。
     - **USERSETTINGS 全廃**: `do/05-appsheet-tables.md` の Security Filter 式に `USERSETTINGS()` が 1 箇所も含まれない（grep 検証可能）。代替式は `USEREMAIL() + staff_facility_map`（R9）。
     - **CloudSQL 行レベル制御**: AppSheet を経由しない直接 SQL アクセス時の PII 保護方針として、Cloud SQL Auth Proxy + IAM 認証 + ユーザ別 VIEW（`v_user_for_staff_{role}`）が `do/08` に記載（C-09）。
     - **監査ログ**: `audit_log` テーブルは **append-only**（UPDATE / DELETE 権限を全ユーザから剥奪）、かつ **Cloud Storage WORM バケット（Bucket Lock + retention 5 年）** にストリーム書出し（C-10）。
     - PII フィールド一覧 / 各層権限境界 / 暗号化方式が一覧化。

9. **障害時運用 Runbook**: SF 停止 / CloudSQL 停止 / GAS 連携失敗 / **Cloud Run jobs 失敗** / **Cloud KMS 障害（R-14）** / **Secret Manager 障害** の 6 シナリオを検知・暫定対応・復旧の 3 列で網羅。
   - 受入基準: `do/09-operational-runbook.md` に 6 シナリオ × 3 列の表が存在。RPO ≤ 1 時間 / RTO ≤ 4 時間が数字として記載、PITR 手順表（C-19）あり。Cloud Run jobs の `scheduleResumption` 実コードスケッチが `do/06` に存在。Cloud KMS 鍵キャッシュ＋手動 fallback 手順あり。**月額コスト試算（C-18）**: AppSheet ライセンス / SF EE / CloudSQL Enterprise / Cloud Run / KMS の想定規模別月額合算が `do/09` に明記。

10. **【新規】契約・重要事項説明書・同意書管理（C-11 由来）**: 利用者と事業所間の契約 3 点セットを SF カスタムオブジェクトで管理。Must.2 個別支援計画作成の前提として成立。
    - 受入基準: `do/04-salesforce-objects.md` に `ServiceContract__c`（契約書）/ `ImportantMatterDocument__c`（重要事項説明書）/ `ConsentForm__c`（同意書）の 3 オブジェクトが定義。Person Account との Lookup、契約期間バリデーション、契約満了前 30 日アラートのワークフロー仕様あり。`do/05-appsheet-tables.md` に CloudSQL `contract_mirror` 経由の AppSheet 表示 View 設計。利用者署名の電子化は **L-14 法務レビュー必要** フラグ明示。

11. **【新規】上限管理（上限管理事業所 / 利用者負担上限月額 / 上限管理結果票）（C-03 由来）**: 国保連請求の前提となる上限管理エンティティ。
    - 受入基準: `do/03-cloudsql-ddl.sql` と `do/04-salesforce-objects.md` と `do/05-appsheet-tables.md` の 3 箇所に以下 3 エンティティが存在:
      - `upper_limit_facility`（上限管理事業所マスタ）
      - `upper_limit_decision`（利用者ごとの月額上限額・適用期間）
      - `upper_limit_result_sheet`（受信 / 発信の月次結果票、受信エビデンス保管含む）
    - Must.6（請求準備）が `upper_limit_result_sheet` の値を参照して単位数調整することが `do/07-integration-flows.md` の月次フロー図に明示。

### Should（次サイクル候補）
- Health Cloud との機能比較レビュー（再評価）
- 加算減算判定ロジックの完全実装
- 国保連向け CSV エクスポート完全フォーマット
- AppSheet 側 AI 機能（記録要約・計画ドラフト）— C-01 解消後に Cycle 3 で投入
- 苦情・インシデント管理（Service Cloud 採否含む）
- BI レポーティング層
- 上限管理結果票の電子授受方式実装（L-13 法務レビュー後）
- Salesforce Shield Platform Encryption 再評価（規模拡大時）
- 支給期間と上限期間の分離 SF カスタム項目（C-17）

### Won't（今回扱わない）
- 利用者家族向けポータル
- 帳票印刷レイアウト
- 多事業所横断 BI ダッシュボード
- スマホネイティブ実装
- 国保連レセプト電子請求の送信本体
- 個別事業所カスタム帳票レイアウト
- 多言語化

## 7. 受入基準（verifier が判定する観点）

verifier は本セクションを **6 章 Must 11 項目それぞれの完成度** と並行して判定する。

- **Cycle 1 P1 Critical 解消**: C-01〜C-07 が下記 §10 のマッピングに従って解消されている。
- **機能完全性**: Must 11 項目すべてが `do/01〜10` のいずれかに設計成果物として収まる。
- **データ整合性**:
  - 主要エンティティ（利用者・契約・個別支援計画・サービス記録・スタッフ・シフト・**上限管理 3 種**・請求準備・監査ログ）の **主キー・一意制約・外部キー** が DDL またはオブジェクト定義で明示。
  - SF ⇄ CloudSQL 間の **同期キー**（`salesforce_id` カラム）が全ミラーテーブルに存在。
  - **Facility マスタ参照**は必ず `facility_id_map` 経由（C-06）。
- **セキュリティ**:
  - **鍵管理経路フルパス**（C-01）が `do/08` の 1 セクションで明文化、KEK ID 文字列が DDL / GAS / Runbook の 3 箇所で同一。
  - 要配慮個人情報（障害種別、支援内容、緊急連絡先、受給者証番号、契約書類）の保管位置一覧。
  - **CloudSQL CMEK + Cloud KMS asia-northeast1** が前提（R7）。
  - 通信時暗号化 TLS 1.2+ が層ごとに明示。
  - アクセス制御マトリクス（5 ロール × 主要オブジェクト 11 種）。
  - **AppSheet Security Filter に USERSETTINGS() を含まない**（C-05 / R9 / grep 検証可能）。
  - **CloudSQL 行レベル制御**（C-09）が `do/08` に記載。
  - **`audit_log` テーブル append-only + Cloud Storage WORM**（C-10）。
- **運用性**:
  - Runbook で 6 シナリオ × 3 列が網羅、RPO ≤ 1 時間 / RTO ≤ 4 時間 が数字として記載。
  - PITR 手順表（C-19）。
  - **Cloud Run jobs `scheduleResumption` 実コードスケッチ**（C-20）。
  - **月額コスト試算**（C-18）が想定規模別に記載。
- **法令適合（範囲制限）**:
  - 法務レビュー必要箇所（L-13〜L-17）が赤フラグ列挙。
  - 個人情報保護法・障害者総合支援法・契約 3 点セット・上限管理の各観点で言及。
- **トレーサビリティ**: `do/10-traceability-matrix.md` で Must 11 項目それぞれが「どの設計ファイルのどの節で扱われたか」を逆引きできる。C-01〜C-07 解消対応関係も同マトリクスに含める。

## 8. リスク台帳

| ID | リスク | 影響 | 発生可能性 | 対策 |
|---|---|---|---|---|
| R-01 | （Cycle 1）AppID 未受領 → **解消済み**（Cycle 2 で受領） | — | — | Cycle 2 spec で既知前提化 |
| R-02 | Salesforce エディション未確定（EE 仮定）。Health Cloud 必須要件が後から判明する可能性 | 大（再設計） | 中 | Should に再評価項目を保持 |
| R-03 | CloudSQL コピー元 schema 未提供。新規 DDL と既存差分の整合性 | 中 | 高 | Cycle 2 でも未受領のため Must.7 で「新規設計版」と明記、Cycle 3 で突合タスク化 |
| R-04 | 障害福祉報酬告示の改定（年次/3 年毎）に追従できない構造 | 大（毎年改修） | 中 | サービスコード・単位数・加算減算をハードコードせず master テーブル化 |
| R-05 | 要配慮個人情報の取扱いが個人情報保護法ガイドラインに不適合 | 大（法令違反） | 低〜中 | L-17 法務レビューフラグ、CloudSQL CMEK 必須化（C-01 解消） |
| R-06 | （Cycle 1）GAS の 6 分上限 → **対策実施**（Cloud Run jobs 分離 / R8） | 低（残リスク） | 低 | Must.6 で Cloud Run jobs 実装、Runbook で再実行手順整備 |
| R-07 | Person Account 有効化は不可逆 | 大 | 低 | Cycle 2 着手前にユーザー承認、契約 / 個別支援計画も Person Account 前提で設計 |
| R-08 | AppSheet 同時編集競合でサービス記録の上書き事故 | 中 | 中 | 楽観ロック + 「同一スタッフ・同一利用者・同一日」一意制約 |
| R-09 | Claude API 利用時の PII 送信リスク | 大 | 中 | Cycle 2 でも AI 機能 Won't 据置、Cycle 3 で PII マスキング基盤前提 |
| **R-10**（新） | 上限管理事業所が他事業所の場合、上限管理結果票の月次授受が遅延し請求保留が発生 | 高（請求遅延） | 中 | 月次締切前バッチで未受信検出 → サビ管に通知（Must.11） |
| **R-11**（新） | SF User と CloudSQL `staff` の同期遅延でアクセス制御が一時的に緩む | 中（PII 露出） | 中 | 同期は near-realtime（Platform Event）or 入退社ワークフロー組込み |
| **R-12**（新） | GH 夜勤の打刻が日跨ぎ判定誤りで記録二重化 | 中（請求誤り） | 中 | `is_overnight` フラグ + `shift_date` 1 本化、AppSheet 入力 UI に夜勤明示トグル（Must.3 / Must.5） |
| **R-13**（新） | AppSheet App ID 既知化に伴う API スキャンリスク | 中 | 中 | Application Access Key ローテーション運用、IP allowlist 検討（AppSheet 制約あり） |
| **R-14**（新） | Secret Manager / Cloud KMS 障害時に CloudSQL 暗号化フィールドが読めず業務停止 | 高 | 低 | 鍵キャッシュ + 手動 fallback 手順を Runbook に明記（Must.9） |
| **R-15**（新） | Shield Encryption 非採用の「適切な安全管理措置」説明責任 | 中（監査指摘） | 中 | L-17 法務レビューで非採用判断書面化、CloudSQL CMEK で代替の根拠を残す |

## 9. implementer への指示（並列化ヒント）

### 並列ストリーム（4 本に拡張）

| ストリーム | 担当範囲 | 出力ファイル |
|---|---|---|
| **S1: データ（モデル & DDL & SF オブジェクト）** | Must.1, 2, 3, 5, 11 のスキーマ設計（契約・上限管理含む） | `do/02-data-model.md`, `do/03-cloudsql-ddl.sql`, `do/04-salesforce-objects.md`, `do/05-appsheet-tables.md` |
| **S2: 連携シーケンス & バッチ（GAS + Cloud Run jobs）** | Must.4, 6, 7 のフロー設計 / Cloud Run jobs 分離 | `do/01-architecture.md`, `do/06-gas-integrations.md`, `do/07-integration-flows.md` |
| **S3: セキュリティ・運用（鍵管理 / 監査 / Runbook / コスト）** | Must.8, 9 / C-01・C-05・C-09・C-10・C-18・C-19 解消 | `do/08-security-and-privacy.md`, `do/09-operational-runbook.md` |
| **S4:【新規】福祉業界要件（契約・アセスメント・上限管理の業務 SOP）** | Must.2 子エンティティ / Must.10 契約 / Must.11 上限管理の業務フロー記述 | `do/11-welfare-domain-workflows.md`, `do/10-traceability-matrix.md` |

### 依存関係
- **S1 が S2 / S3 / S4 の前提**: データモデル確定 → 連携 / セキュリティ / 業界要件
- S2 / S3 / S4 は S1 完了後に並列実行可能
- `do/10-traceability-matrix.md` は **最後に作成**（S4 内、全ファイル参照のため）

### 共通制約
- 全ファイル冒頭に `spec.md` 6 章のどの Must を扱うかを明記
- Cycle 1 で発覚した P1 7 件（C-01〜C-07）の解消対応関係を `do/10` に必ず収録
- DDL は MySQL 8.x 構文、`utf8mb4`、`Asia/Tokyo`
- SF オブジェクトは API 名と表示名併記、Person Account 拡張は標準 + カスタム項目を区別
- AppSheet 設計は「テーブル / Slice / View / Action / Bot / Security Filter」の 6 観点（Security Filter は USERSETTINGS 不使用を明示）
- GAS / Cloud Run jobs 設計は関数単位の I/O・トリガ種別・実行頻度を表形式で
- 鍵 ID 文字列（KEK パス）は DDL / GAS / Runbook で **完全に同一の文字列** を使う

## 10. このサイクルの「完了」定義

- **6 章 Must 11 項目すべて** が `do/01〜11` のいずれかで設計成果物として実体を持つ
- **7 章 受入基準すべて** が verifier の判定で満たされる
- **8 章 リスク台帳の Critical（R-02 / R-04 / R-05 / R-07 / R-09 / R-10 / R-14）** に Cycle 2 設計上の予防策が示されている
- `do/10-traceability-matrix.md` で Must 11 項目および C-01〜C-07 解消対応関係が逆引き可能
- **verifier 総合スコア ≥ 6.5**（Cycle 1 = 5.38 から 1.12 ポイント以上の改善）

### Cycle 1 P1 Critical 7 件 → Cycle 2 解消対応マッピング（verifier 判定用）

| Critical ID | 内容 | 解消責任 Must | 解消責任 §（spec.md） |
|---|---|---|---|
| C-01 | 鍵管理経路の不在 | Must.8 | §4「鍵管理経路（C-01 解消）」/ §6.Must.8 受入基準（鍵管理パス） |
| C-02 | 月次集計の誤り | Must.4 | §6.Must.4 受入基準（`WHERE YEAR/MONTH` 明記） |
| C-03 | 上限管理エンティティ欠落 | Must.11 | §6.Must.11（新規 3 エンティティ） |
| C-04 | 支給決定 SoR の二重定義 | Must.1 / 全 SoR 表 | §4「SoR の単一化」表 + §6.Must.1 受入基準（AppSheet 直 SF 参照禁止） |
| C-05 | USERSETTINGS 改竄リスク | Must.8 | §6.Must.8 受入基準（USERSETTINGS 全廃 / R9 採用） |
| C-06 | SF Facility → CloudSQL 同期 | Must.7 | §4「Facility マスタの連携」+ §6.Must.7 受入基準（`syncFacilitiesFromSF`） |
| C-07 | GH 夜勤の制約違反 | Must.3 / Must.5 | §3 用語 + §6.Must.3 受入基準（`is_overnight` フラグ）+ §6.Must.5 |
