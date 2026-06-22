---
cycle: "002"
related_spec_sections: ["§4（連携経路）", "§6.Must.6", "§6.Must.7", "§6.Must.11", "§4（Cloud Run jobs C-20）"]
streams_independent_of: ["02", "03", "04", "09"]
---

# 07. 連携シーケンス図（Integration Flows）

> 対応 spec.md: §4（連携経路）/ §6.Must.6（請求準備バッチ）/ §6.Must.7（Salesforce ⇄ CloudSQL 同期）/ §6.Must.11（上限管理月次フロー）/ §4（Cloud Run jobs 分離 C-20）
>
> **Cycle 2 主要変更**:
> - C-04: AppSheet の Salesforce 直参照経路を全廃。全フローは CloudSQL 経由のみ。
> - C-06: `syncFacilitiesFromSF` フローを新設（Facility マスタ連携）。
> - C-20: 月次請求準備バッチを Cloud Run jobs に分離。GAS は Cloud Tasks 経由でキック。
> - Must.11: 上限管理結果票の月次フローを追加。billing_prep が upper_limit_result_sheet を参照。

---

## 1. Salesforce → CloudSQL 差分同期フロー（1 時間ごと）

```mermaid
sequenceDiagram
    autonumber
    participant GAS as GAS V8<br/>（syncUsersFromSF）
    participant SM as Secret Manager
    participant KMS as Cloud KMS<br/>（KEK: cloudsql-kek）
    participant SF as Salesforce<br/>（PersonAccount SoR）
    participant CS as CloudSQL<br/>（user_mirror）
    participant AL as CloudSQL<br/>（audit_log）

    GAS->>SM: getSecret(SF_PRIVATE_KEY, CS_DB_PASSWORD)
    SM-->>GAS: secrets
    GAS->>SF: POST /oauth2/token（JWT Bearer）
    SF-->>GAS: access_token
    GAS->>SF: SOQL: Account WHERE IsPersonAccount=true AND LastModifiedDate > since
    SF-->>GAS: PersonAccount records（最大200件）

    loop 各レコード
        GAS->>KMS: encrypt(RecipientCertNo__c)
        KMS-->>GAS: encrypted_cert_no（C-01解消: AES_ENCRYPT廃止）
        GAS->>CS: facility_id_map.cloudsql_id を解決（C-06）
        CS-->>GAS: cloudsql_facility_id
        GAS->>CS: INSERT INTO user_mirror ... ON DUPLICATE KEY UPDATE
        CS-->>GAS: OK
        GAS->>AL: INSERT audit_log（event_type='SYNC_SF'）
    end

    alt 200件到達（継続あり）
        GAS->>GAS: triggerSyncContinuation()<br/>PropertiesService に since を保存して再トリガ
    end

    GAS->>CS: UPDATE batch_run_log SET status='success'
```

**リトライ方針**:
- `batch_run_log.status = 'failed'` → 次回の時間ベーストリガで `since` = 最終成功タイムスタンプから再試行
- 3 回連続失敗 → GAS 失敗メール通知 → 管理者が `syncUsersFullFromSF()` を手動実行
- **競合解決**: SF の `LastModifiedDate` > `sf_synced_at` の場合のみ上書き（last-write-wins）

**冪等性確保**: `sf_account_id` UNIQUE KEY + ON DUPLICATE KEY UPDATE

---

## 2. Facility マスタ同期フロー（日次 — C-06 新設）

```mermaid
sequenceDiagram
    autonumber
    participant GAS as GAS V8<br/>（syncFacilitiesFromSF）
    participant SF as Salesforce<br/>（Facility__c SoR）
    participant CS_FAC as CloudSQL<br/>（facilities）
    participant CS_MAP as CloudSQL<br/>（facility_id_map）
    participant AL as CloudSQL<br/>（audit_log）

    GAS->>SF: SOQL: Facility__c 全件
    SF-->>GAS: Facility records

    loop 各 Facility
        GAS->>CS_FAC: SELECT id FROM facilities WHERE sf_account_id = ?
        alt 既存行あり
            GAS->>CS_FAC: UPDATE facilities SET facility_name, is_active
        else 新規
            GAS->>CS_FAC: INSERT INTO facilities
            CS_FAC-->>GAS: LAST_INSERT_ID（cloudsql_id）
        end
        GAS->>CS_MAP: INSERT INTO facility_id_map（salesforce_id, cloudsql_id）ON DUPLICATE KEY UPDATE
        GAS->>AL: INSERT audit_log（event_type='SYNC_FACILITY'）
    end

    GAS->>GAS: logBatchEnd('success')
```

**重要**: `user_mirror.facility_id` など全 FK 参照は `facility_id_map.cloudsql_id` 経由で解決済みの値を格納（C-06 解消）。

---

## 3. AppSheet → CloudSQL サービス記録入力フロー（リアルタイム）

```mermaid
sequenceDiagram
    autonumber
    participant User as 生活支援員
    participant AS as AppSheet<br/>（HopeCareDX）
    participant CS_SR as CloudSQL<br/>（service_records）
    participant CS_SFM as CloudSQL<br/>（staff_facility_map）
    participant CS_AL as CloudSQL<br/>（audit_log）

    User->>AS: ServiceRecordForm 入力
    AS->>CS_SFM: Security Filter評価<br/>facility_id IN SELECT(staff_facility_map[facility_id], email=USEREMAIL())
    CS_SFM-->>AS: 許可（USERSETTINGS()不使用 — C-05解消）
    AS->>CS_SR: INSERT INTO service_records
    CS_SR-->>AS: OK（updated_at で楽観ロック）
    AS->>CS_AL: INSERT audit_log（event_type='CREATE', table='service_records'）
    AS-->>User: 登録完了

    alt 支給量超過検知
        AS->>User: 超過警告（AllotmentWarningBot）
    end
```

---

## 4. 月次請求準備バッチフロー（Cloud Run jobs — C-20 解消）

> spec §6.Must.6「Cloud Run jobs `generateBillingPrep` の I/O 仕様・冪等性・エラー再実行」対応
> spec §6.Must.11「Must.6 が upper_limit_result_sheet の値を参照して単位数調整する」ことが本フロー図で明示。

```mermaid
sequenceDiagram
    autonumber
    participant GAS as GAS V8<br/>（triggerBillingBatch）
    participant CT as Cloud Tasks
    participant CRJ as Cloud Run jobs<br/>（generateBillingPrep）
    participant SM as Secret Manager
    participant KMS as Cloud KMS
    participant CS_SR as CloudSQL<br/>（service_records）
    participant CS_UL as CloudSQL<br/>（upper_limit_result_sheet）
    participant CS_BP as CloudSQL<br/>（billing_prep）
    participant CS_AL as CloudSQL<br/>（audit_log）

    Note over GAS: 毎月2日 0:00 JST（時間ベーストリガ）

    GAS->>CT: Cloud Tasks enqueue<br/>{ billing_year_month, run_id }
    CT->>CRJ: HTTPS POST /run（IAM 認証）

    CRJ->>SM: getSecret(CS_DB_PASSWORD, KMS_KEY_PATH)
    SM-->>CRJ: secrets

    CRJ->>CS_SR: SELECT DISTINCT user_id<br/>WHERE YEAR/MONTH = 前月 AND is_approved=1
    CS_SR-->>CRJ: user_id リスト

    loop 各 user_id
        CRJ->>CS_SR: SELECT 集計（YEAR/MONTH フィルタ — C-02解消）
        CS_SR-->>CRJ: service_days, total_units

        CRJ->>CS_UL: SELECT upper_limit_result_sheet<br/>WHERE user_id=? AND billing_year_month=?<br/>AND is_confirmed=1（Must.11 — 上限管理結果反映）
        CS_UL-->>CRJ: adjusted_copayment（未受信の場合NULL）

        CRJ->>CS_BP: INSERT INTO billing_prep<br/>（batch_run_id で冪等性確保）
        CS_BP-->>CRJ: OK

        CRJ->>CS_AL: INSERT audit_log（event_type='BILLING_PREP'）
    end

    CRJ->>CS_AL: INSERT batch_run_log status='success'

    alt 月次バッチ失敗
        CRJ->>CS_AL: INSERT batch_run_log status='failed'
        CRJ->>GAS: 失敗通知（Cloud Pub/Sub or webhook）
        Note over GAS: scheduleResumption() で新 run_id で再エンキュー
    end
```

**冪等性**: UNIQUE KEY `(user_id, billing_year_month, service_id, batch_run_id)` — 再実行しても重複 INSERT せず
**上限管理結果反映**: `upper_limit_result_sheet.adjusted_copayment` が `billing_prep.adjusted_copayment` に転写される（spec §6.Must.11 受入基準）

---

## 5. 上限管理月次授受フロー（Must.11 — C-03 解消）

> spec §6.Must.11「Must.6（請求準備）が `upper_limit_result_sheet` の値を参照して単位数調整することが `07` の月次フロー図に明示」対応。

```mermaid
sequenceDiagram
    autonumber
    participant BillingStaff as 請求担当
    participant AS as AppSheet
    participant CS_UL as CloudSQL<br/>（upper_limit_result_sheet）
    participant CS_UD as CloudSQL<br/>（upper_limit_decision）
    participant ExtFacility as 他事業所（上限管理事業所）
    participant CRJ as Cloud Run jobs<br/>（generateBillingPrep）
    participant CS_BP as CloudSQL<br/>（billing_prep）

    Note over ExtFacility,CS_UL: 月末〜月初: 他事業所から結果票を受信（⚠️L-13: 電子授受方式は法務確認要）

    ExtFacility->>BillingStaff: 上限管理結果票（紙 or 電子）
    BillingStaff->>AS: UpperLimitResultView に結果票を入力<br/>（direction='received', total_cost, adjusted_copayment）
    AS->>CS_UL: INSERT upper_limit_result_sheet
    BillingStaff->>AS: ConfirmUpperLimitResult Action
    AS->>CS_UL: UPDATE is_confirmed=TRUE, confirmed_at=NOW()

    Note over BillingStaff,CS_BP: 月初 2 日: 月次バッチが結果票を参照

    CRJ->>CS_UL: SELECT WHERE user_id=? AND billing_year_month=? AND is_confirmed=TRUE
    CS_UL-->>CRJ: adjusted_copayment
    CRJ->>CS_BP: INSERT billing_prep（adjusted_copayment 反映）

    Note over BillingStaff,CS_BP: 月初: 請求担当が billing_prep を確認して confirmed へ

    BillingStaff->>AS: BillingPrepView で draft 確認
    BillingStaff->>AS: ConfirmBilling Action
    AS->>CS_BP: UPDATE status='confirmed'

    alt 上限管理結果票が未受信（月末前チェック）
        Note over AS,BillingStaff: UpperLimitWarningBot が通知（spec §8 R-10）
        AS->>BillingStaff: 「未確認の上限管理結果票があります」プッシュ通知
    end
```

---

## 6. CloudSQL → Salesforce 日次集計フロー

```mermaid
sequenceDiagram
    autonumber
    participant GAS as GAS V8<br/>（pushDailySummaryToSF）
    participant CS as CloudSQL<br/>（service_records）
    participant SF as Salesforce<br/>（PersonAccount）

    Note over GAS: 毎日 23:00 JST（時間ベーストリガ）

    GAS->>CS: SELECT service_records 昨日分集計<br/>（user_id ごとの月累計）
    CS-->>GAS: summaries

    loop 最大 25 件ずつ
        GAS->>SF: PATCH Composite API<br/>PersonAccount.LastServiceDate__c<br/>MonthlyServiceMinutes__c 等更新
        SF-->>GAS: 200 OK
    end

    GAS->>CS: UPDATE batch_run_log status='success'
```

---

## 7. 鍵管理フロー（C-01 解消）

```mermaid
sequenceDiagram
    autonumber
    participant GAS as GAS / Cloud Run jobs
    participant SM as Secret Manager
    participant KMS as Cloud KMS<br/>（asia-northeast1: cloudsql-kek）
    participant CS as CloudSQL<br/>（user_mirror）
    participant AS as AppSheet

    Note over GAS,KMS: 受給者証番号の暗号化フロー（同期バッチ時）

    GAS->>SM: getSecret(KMS_KEY_PATH)
    SM-->>GAS: key_path
    GAS->>KMS: POST :encrypt（plaintext=受給者証番号）
    KMS-->>GAS: ciphertext（base64）
    GAS->>CS: INSERT user_mirror.recipient_cert_no = FROM_BASE64(ciphertext)

    Note over AS,CS: AppSheet 参照時（末尾4桁マスク表示）

    AS->>CS: SELECT recipient_cert_no FROM user_mirror WHERE ...
    CS-->>AS: ciphertext bytes
    AS->>AS: App formula: CONCATENATE("***-", RIGHT(TO_TEXT(recipient_cert_no), 4))
    AS-->>User: "***-1234"（マスク表示）
```

---

## 8. リトライ方針まとめ

| フロー | リトライ手段 | 冪等性確保 |
|---|---|---|
| SF → CloudSQL 差分同期 | 次回時間ベーストリガ（1時間後）で `since` を最終成功時刻に設定 | `sf_account_id` / `sf_allotment_id` UNIQUE |
| Facility マスタ同期 | 次回日次トリガ | `salesforce_id` UNIQUE |
| 月次請求準備（Cloud Run jobs）| GAS が新 `run_id` で Cloud Tasks に再エンキュー | `(user_id, billing_year_month, service_id, batch_run_id)` UNIQUE |
| AppSheet → CloudSQL CRUD | AppSheet アプリ内の楽観ロック（`updated_at` 比較）+ 再送 | `updated_at` 楽観ロック |

---

## 9. エラーハンドリング方針

| シナリオ | 検知方法 | 対処 |
|---|---|---|
| GAS バッチ失敗 | `batch_run_log.status = 'failed'` / GAS 失敗メール通知 | 管理者がスクリプトエディタでログ確認 → 原因修正 → 手動実行 |
| Cloud Run jobs 失敗 | `batch_run_log.status = 'failed'` / Cloud Logging アラート | `scheduleResumption()` で新 `run_id` 再エンキュー（`09-operational-runbook.md` §3 参照）|
| Cloud KMS 障害 | CloudSQL 接続エラー / GAS encrypt 失敗 | 鍵キャッシュ（有効期間内）で継続 → `09-operational-runbook.md` §3「シナリオ E」参照 |
| 上限管理結果票 未受信 | `UpperLimitWarningBot`（月末 5 日前）| 請求担当が手動対応。`billing_prep.adjusted_copayment = NULL` で draft を作成し後から更新可 |
