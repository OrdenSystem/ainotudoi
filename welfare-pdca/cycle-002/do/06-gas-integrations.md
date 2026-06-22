---
cycle: "002"
related_spec_sections: ["§6.Must.4", "§6.Must.6", "§6.Must.7", "§4（GAS連携経路）", "§4（Facility マスタ連携 C-06）", "§4（Cloud Run jobs C-20）"]
streams_independent_of: ["02", "03", "04", "09"]
---

# 06. GAS バッチ / 連携 — 関数一覧・擬似コード

> 対応 spec.md: §6.Must.4（支給決定残量集計）/ §6.Must.6（請求準備バッチ）/ §6.Must.7（Salesforce ⇄ CloudSQL 同期バッチ設計 / Facility マスタ含む C-06）/ §4（Cloud Run jobs 分離 C-20）
>
> **前提**:
> - GAS V8 ランタイム（軽量バッチ専任。月次重量バッチは Cloud Run jobs に分離 — C-20）
> - Salesforce REST API v61.0 + OAuth2 JWT Bearer（Connected App: `WelfareGASIntegration`）
> - CloudSQL 接続: Cloud SQL Auth Proxy（推奨）
> - 秘密情報: **GCP Secret Manager** 経由（Script Properties への平文格納は廃止推奨 — C-01）
> - Application-level 暗号化: Cloud KMS API を GAS から呼び出す
>   KEK = `projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek`

---

## 1. 関数一覧（表形式）

| 関数名 | トリガ種別 | 実行頻度 | 入力 | 出力 | エラー時挙動 |
|---|---|---|---|---|---|
| `syncUsersFromSF` | 時間ベース（毎時）| 1時間ごと | SF PersonAccount SOQL | CloudSQL `user_mirror` UPSERT（KMS 暗号化）| `batch_run_log` に `failed`、次回で再試行 |
| `syncUsersFullFromSF` | 手動（管理者）| オンデマンド | SF PersonAccount 全件 | CloudSQL `user_mirror` UPSERT | 同上 |
| `syncAllotmentsFromSF` | 時間ベース（毎時）| 1時間ごと | SF ServiceAllotment__c SOQL | CloudSQL `user_allotment_cache` UPSERT | 同上 |
| **`syncFacilitiesFromSF`** | 時間ベース（日次）+ 変更時手動 | 日次 + オンデマンド | **SF Facility__c SOQL** | **CloudSQL `facility_id_map` UPSERT** | **同上（C-06 新設）** |
| `syncContractsFromSF` | 時間ベース（日次）| 日次 | SF ServiceContract__c / ImportantMatterDocument__c / ConsentForm__c SOQL | CloudSQL `contract_mirror` UPSERT | 同上 |
| `pushDailySummaryToSF` | 時間ベース（深夜）| 日次（23:00 JST）| CloudSQL `service_records` 集計 | SF PersonAccount カスタム項目更新 | エラー行スキップ + ログ |
| **`triggerBillingBatch`** | 時間ベース（月次）| 月初 2 日 0:00 JST | `billing_year_month` | **Cloud Tasks キュー投入（C-20）** | Cloud Tasks 投入失敗をログ + 管理者通知 |
| `checkContractExpiry` | 時間ベース（日次）| 日次（9:00 JST）| CloudSQL `contract_mirror` | 満了前 30 日契約一覧 → AppSheet Bot 通知トリガ | エラーはログのみ |
| `checkRecordCompleteness` | 時間ベース（日次）| 日次（7:00 JST）| SF IndividualSupportPlan / Assessment | 記録欠落 → `audit_log` に警告ログ | エラーはログのみ |
| `exportBillingCSV` | Web アプリ（GET）| オンデマンド | `billing_year_month` クエリパラメータ | CSV テキスト | HTTP 400/500 を返す |

---

## 2. 認証ユーティリティ

### 2.1 `getSalesforceAccessToken()` — JWT Bearer 認証

```javascript
// GAS V8 / 擬似コード
function getSalesforceAccessToken() {
  const clientId    = getSecret('SF_CLIENT_ID');       // Secret Manager 経由
  const privateKey  = getSecret('SF_PRIVATE_KEY');     // PEM形式（C-01: Secret Manager必須）
  const username    = getSecret('SF_USERNAME');
  const instanceUrl = getSecret('SF_INSTANCE_URL');    // 例: https://xxx.my.salesforce.com

  const header  = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: clientId,
    sub: username,
    aud: instanceUrl + '/services/oauth2/token',
    exp: now + 300
  }));

  const signingInput = header + '.' + payload;
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(signingInput, privateKey)
  );
  const jwt = signingInput + '.' + signature;

  const response = UrlFetchApp.fetch(instanceUrl + '/services/oauth2/token', {
    method: 'POST',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('SF_AUTH_FAILED: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}
```

### 2.2 `getSecret(secretName)` — Secret Manager からの秘密情報取得

```javascript
// C-01: Script Properties への平文格納廃止 → Secret Manager 経由
function getSecret(secretName) {
  const projectId = PropertiesService.getScriptProperties().getProperty('GCP_PROJECT_ID');
  const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`;
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('SECRET_FETCH_FAILED: ' + secretName);
  }
  const data = JSON.parse(response.getContentText());
  return Utilities.newBlob(Utilities.base64Decode(data.payload.data)).getDataAsString();
}
```

### 2.3 `kmsEncrypt(plaintext)` — Cloud KMS Application-level 暗号化（C-01）

```javascript
// KEK パス（DDL / GAS / Runbook で完全に同一の文字列を使用）
const KMS_KEY_PATH = 'projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek';

function kmsEncrypt(plaintext) {
  const url = `https://cloudkms.googleapis.com/v1/${KMS_KEY_PATH}:encrypt`;
  const token = ScriptApp.getOAuthToken();
  const payload = JSON.stringify({
    plaintext: Utilities.base64Encode(plaintext)
  });
  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: payload,
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('KMS_ENCRYPT_FAILED: ' + response.getContentText());
  }
  const result = JSON.parse(response.getContentText());
  // base64 エンコードされた暗号文を返す（DDL VARBINARY(256) に格納）
  return result.ciphertext;
}

function kmsDecrypt(ciphertext) {
  const url = `https://cloudkms.googleapis.com/v1/${KMS_KEY_PATH}:decrypt`;
  const token = ScriptApp.getOAuthToken();
  const payload = JSON.stringify({ ciphertext: ciphertext });
  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: payload,
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('KMS_DECRYPT_FAILED: ' + response.getContentText());
  }
  const result = JSON.parse(response.getContentText());
  return Utilities.newBlob(Utilities.base64Decode(result.plaintext)).getDataAsString();
}
```

---

## 3. `syncUsersFromSF` — Salesforce → CloudSQL 差分同期（C-01 対応版）

> spec §6.Must.7 対応。同期キー = `sf_account_id`。競合解決: SF を SoR とし CloudSQL を上書き。
> C-01 解消: `AES_ENCRYPT` を廃止し、Cloud KMS `kmsEncrypt()` を使用。

```javascript
function syncUsersFromSF() {
  const runId = generateRunId('sf_sync_users');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'sf_sync_users', runId);

  try {
    const auth  = getSalesforceAccessToken();
    const since = getLastSyncTimestamp(conn, 'sf_sync_users');

    const soql = `
      SELECT Id, LastName, FirstName, LastNameKana__c, FirstNameKana__c,
             DisabilityType__c, RecipientCertNo__c, RecipientCertExpiry__c,
             FacilityId__c, IsActive__c, LastModifiedDate
      FROM Account
      WHERE IsPersonAccount = true
        AND LastModifiedDate > ${since.toISOString()}
      ORDER BY LastModifiedDate ASC
      LIMIT 200
    `;
    const records = (callSalesforceSOQL(auth, soql)).records || [];

    let processed = 0, failed = 0;

    for (const rec of records) {
      try {
        // C-01 解消: Cloud KMS で受給者証番号を暗号化
        const encryptedCertNo = kmsEncrypt(rec.RecipientCertNo__c || '');
        // facility_id_map から cloudsql_id を解決（C-06 解消）
        const facilityId = resolveFacilityId(conn, rec.FacilityId__c);

        upsertUserMirror(conn, rec, encryptedCertNo, facilityId);
        processed++;
      } catch (e) {
        failed++;
        logAuditError(conn, 'sf_sync_users', rec.Id, e.message);
      }
    }

    if (records.length === 200) {
      triggerSyncContinuation();
    }

    logBatchEnd(conn, runId, 'success', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}

// UPSERT ヘルパー（C-01 解消: AES_ENCRYPT 廃止 → KMS 暗号化済みバイト列を直接格納）
function upsertUserMirror(conn, sfRecord, encryptedCertNo, facilityId) {
  const stmt = conn.prepareStatement(`
    INSERT INTO user_mirror
      (sf_account_id, last_name, first_name, disability_type,
       recipient_cert_no, recipient_cert_expiry, facility_id, is_active, sf_synced_at)
    VALUES (?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      last_name             = VALUES(last_name),
      first_name            = VALUES(first_name),
      disability_type       = VALUES(disability_type),
      recipient_cert_no     = FROM_BASE64(VALUES(recipient_cert_no)),
      recipient_cert_expiry = VALUES(recipient_cert_expiry),
      facility_id           = VALUES(facility_id),
      is_active             = VALUES(is_active),
      sf_synced_at          = NOW(),
      updated_at            = NOW()
  `);
  stmt.setString(1, sfRecord.Id);
  stmt.setString(2, sfRecord.LastName);
  stmt.setString(3, sfRecord.FirstName);
  stmt.setString(4, sfRecord.DisabilityType__c || 'other');
  stmt.setString(5, encryptedCertNo);  // KMS 暗号化済み base64 文字列
  stmt.setString(6, sfRecord.RecipientCertExpiry__c);
  stmt.setInt(7, facilityId);
  stmt.setInt(8, sfRecord.IsActive__c ? 1 : 0);
  stmt.executeUpdate();
}

// facility_id_map から CloudSQL facility.id を解決（C-06 解消）
function resolveFacilityId(conn, sfFacilityId) {
  if (!sfFacilityId) return null;
  const stmt = conn.prepareStatement(
    'SELECT cloudsql_id FROM facility_id_map WHERE salesforce_id = ? AND is_active = 1'
  );
  stmt.setString(1, sfFacilityId);
  const rs = stmt.executeQuery();
  if (rs.next()) {
    return rs.getInt('cloudsql_id');
  }
  throw new Error(`facility_id_map: SF ID not found: ${sfFacilityId}`);
}
```

**リトライ方針**: Cycle 1 と同様（3 回連続失敗 → 管理者通知 → 手動フル同期）。
**実行ログ保存先**: `batch_run_log` テーブル（`03-cloudsql-ddl.sql` §17 参照）。

---

## 4. `syncFacilitiesFromSF` — Facility マスタ同期（C-06 新設）

> spec §4「Facility マスタの連携（C-06 解消）」/ spec §6.Must.7 受入基準「`syncFacilitiesFromSF` 関数仕様明記」対応。

### 4.1 関数仕様

| 項目 | 内容 |
|---|---|
| **入力** | SF `Facility__c`（全件 or LastModifiedDate 差分）|
| **出力** | CloudSQL `facility_id_map` UPSERT / CloudSQL `facilities` 不足行 INSERT |
| **トリガ** | 時間ベース: 日次（2:00 JST）+ 手動: 事業所追加・変更時 |
| **冪等性** | `salesforce_id` UNIQUE KEY |
| **競合解決** | SF を SoR とし `facility_name` / `is_active` を上書き |

```javascript
function syncFacilitiesFromSF() {
  const runId = generateRunId('sf_sync_facilities');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'sf_sync_facilities', runId);

  try {
    const auth  = getSalesforceAccessToken();

    const soql = `
      SELECT Id, Name, FacilityCode__c, ServiceType__c, Prefecture__c, IsActive__c
      FROM Facility__c
      ORDER BY LastModifiedDate ASC
    `;
    const records = (callSalesforceSOQL(auth, soql)).records || [];

    let processed = 0, failed = 0;

    for (const rec of records) {
      try {
        // 1. facilities テーブルに行がなければ INSERT
        const facilityId = upsertFacility(conn, rec);
        // 2. facility_id_map を UPSERT（salesforce_id <-> cloudsql_id）
        upsertFacilityIdMap(conn, rec.Id, facilityId, rec.Name);
        processed++;
      } catch (e) {
        failed++;
        logAuditError(conn, 'sf_sync_facilities', rec.Id, e.message);
      }
    }

    logBatchEnd(conn, runId, 'success', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}

function upsertFacility(conn, sfRecord) {
  // facilities テーブルに sf_account_id で突合し、なければ INSERT
  const selectStmt = conn.prepareStatement(
    'SELECT id FROM facilities WHERE sf_account_id = ?'
  );
  selectStmt.setString(1, sfRecord.Id);
  const rs = selectStmt.executeQuery();
  if (rs.next()) {
    const id = rs.getInt('id');
    const updateStmt = conn.prepareStatement(
      'UPDATE facilities SET facility_name=?, is_active=?, updated_at=NOW() WHERE id=?'
    );
    updateStmt.setString(1, sfRecord.Name);
    updateStmt.setInt(2, sfRecord.IsActive__c ? 1 : 0);
    updateStmt.setInt(3, id);
    updateStmt.executeUpdate();
    return id;
  } else {
    const insertStmt = conn.prepareStatement(
      `INSERT INTO facilities (sf_account_id, facility_code, facility_name, service_type, prefecture, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertStmt.setString(1, sfRecord.Id);
    insertStmt.setString(2, sfRecord.FacilityCode__c);
    insertStmt.setString(3, sfRecord.Name);
    insertStmt.setString(4, sfRecord.ServiceType__c || '');
    insertStmt.setString(5, sfRecord.Prefecture__c || '');
    insertStmt.setInt(6, sfRecord.IsActive__c ? 1 : 0);
    insertStmt.executeUpdate();
    // 挿入後 ID を取得
    const rs2 = conn.createStatement().executeQuery('SELECT LAST_INSERT_ID() AS id');
    rs2.next();
    return rs2.getInt('id');
  }
}

function upsertFacilityIdMap(conn, salesforceId, cloudsqlId, facilityName) {
  const stmt = conn.prepareStatement(`
    INSERT INTO facility_id_map (salesforce_id, cloudsql_id, facility_name, is_active, sf_synced_at)
    VALUES (?, ?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE
      cloudsql_id   = VALUES(cloudsql_id),
      facility_name = VALUES(facility_name),
      is_active     = 1,
      sf_synced_at  = NOW(),
      updated_at    = NOW()
  `);
  stmt.setString(1, salesforceId);
  stmt.setInt(2, cloudsqlId);
  stmt.setString(3, facilityName);
  stmt.executeUpdate();
}
```

---

## 5. `syncContractsFromSF` — 契約 3 点セット同期（Must.10 新設）

```javascript
function syncContractsFromSF() {
  const runId = generateRunId('sf_sync_contracts');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'sf_sync_contracts', runId);

  try {
    const auth  = getSalesforceAccessToken();
    const since = getLastSyncTimestamp(conn, 'sf_sync_contracts');

    const soql = `
      SELECT Id, PersonAccount__c, FacilityId__c, ContractStartDate__c, ContractEndDate__c,
             ServiceType__c, Status__c, LastModifiedDate
      FROM ServiceContract__c
      WHERE LastModifiedDate > ${since.toISOString()}
      LIMIT 200
    `;
    const records = (callSalesforceSOQL(auth, soql)).records || [];

    let processed = 0, failed = 0;
    for (const rec of records) {
      try {
        // user_id / facility_id を CloudSQL の内部 ID に変換
        const userId     = resolveUserId(conn, rec.PersonAccount__c);
        const facilityId = resolveFacilityId(conn, rec.FacilityId__c);
        // 重要事項説明書・同意書の存在チェック（SF SOQL で別途取得）
        const hasImportant = checkImportantMatterDoc(auth, rec.Id);
        const hasConsent   = checkConsentForm(auth, rec.Id);

        upsertContractMirror(conn, rec, userId, facilityId, hasImportant, hasConsent);
        processed++;
      } catch (e) {
        failed++;
        logAuditError(conn, 'sf_sync_contracts', rec.Id, e.message);
      }
    }
    logBatchEnd(conn, runId, 'success', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}
```

---

## 6. `triggerBillingBatch` — Cloud Run jobs 起動（C-20 解消）

> spec §6.Must.6「Cloud Run jobs `generateBillingPrep` の GAS からの起動コードスケッチ」対応。

```javascript
// GAS: 月次バッチを Cloud Tasks 経由で Cloud Run jobs に投入（C-20 解消）
function triggerBillingBatch() {
  const runId          = generateRunId('trigger_billing');
  const billingYearMonth = getPreviousYearMonth();    // 前月を自動算出
  const projectId      = getSecret('GCP_PROJECT_ID');
  const location       = 'asia-northeast1';
  const queueName      = 'welfare-billing-queue';
  const cloudRunUrl    = getSecret('BILLING_JOB_URL'); // Cloud Run jobs URL

  // Cloud Tasks API: タスク投入
  const tasksUrl = `https://cloudtasks.googleapis.com/v2/projects/${projectId}/locations/${location}/queues/${queueName}/tasks`;
  const token    = ScriptApp.getOAuthToken();

  const taskBody = {
    httpRequest: {
      httpMethod: 'POST',
      url: cloudRunUrl + '/run',
      headers: {
        'Content-Type': 'application/json',
        // IAM 認証: Cloud Run jobs サービスアカウントトークン
        'Authorization': 'Bearer ' + getCloudRunInvokerToken(cloudRunUrl)
      },
      body: Utilities.base64Encode(JSON.stringify({
        billing_year_month: billingYearMonth,
        run_id: runId
      }))
    }
  };

  const response = UrlFetchApp.fetch(tasksUrl, {
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ task: taskBody }),
    muteHttpExceptions: true
  });

  const conn = getCloudSqlConnection();
  if (response.getResponseCode() !== 200) {
    logBatchEnd(conn, runId, 'failed', 0, 0, 'Cloud Tasks enqueue failed: ' + response.getContentText());
    conn.close();
    throw new Error('CLOUD_TASKS_ENQUEUE_FAILED');
  }

  logBatchStart(conn, 'trigger_billing_batch', runId);
  logBatchEnd(conn, runId, 'success', 1, 0);
  conn.close();
}
```

---

## 7. Cloud Run jobs: `generateBillingPrep`（C-20 解消）

> spec §6.Must.6「Cloud Run jobs `generateBillingPrep` の I/O 仕様・冪等性・エラー再実行手順」対応。

### 7.1 I/O 仕様

| 項目 | 内容 |
|---|---|
| **実行基盤** | Cloud Run jobs（asia-northeast1 / 時間上限なし）|
| **入力** | HTTP POST ボディ `{ billing_year_month: "YYYYMM", run_id: "..." }` |
| **入力データ** | CloudSQL `service_records`（対象月、`is_approved = 1`）+ `service_master` + `addition_master` + `upper_limit_result_sheet`（Must.11 反映）|
| **出力** | CloudSQL `billing_prep` INSERT（`upper_limit_result_sheet_id` + `adjusted_copayment` 含む）|
| **冪等性キー** | `batch_run_id`（GAS から渡されたもの）+ UNIQUE KEY `(user_id, billing_year_month, service_id, batch_run_id)` |
| **認証** | IAM（Cloud Run Invoker）|
| **DB 接続** | Cloud SQL Auth Proxy + CMEK |

### 7.2 擬似コード（Python / Cloud Run jobs）

```python
# Cloud Run jobs: generateBillingPrep
# KEK パス（DDL/GAS/Runbook で完全に同一の文字列）
KMS_KEY_PATH = "projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek"

def main(billing_year_month: str, run_id: str):
    conn = get_cloudsql_connection()  # Cloud SQL Auth Proxy 経由
    log_batch_start(conn, 'generateBillingPrep', run_id)

    try:
        users_with_records = get_users_with_approved_records(conn, billing_year_month)

        processed, failed = 0, 0
        for user_id in users_with_records:
            try:
                # 1. サービス記録を集計
                aggregated = aggregate_service_records(conn, user_id, billing_year_month)
                # 2. 上限管理結果票を参照（Must.11）
                upper_limit_row = get_upper_limit_result(conn, user_id, billing_year_month)
                # 3. billing_prep に INSERT（冪等性: batch_run_id）
                for row in aggregated:
                    insert_billing_prep(conn, {
                        'user_id': user_id,
                        'billing_year_month': billing_year_month,
                        'batch_run_id': run_id,
                        'upper_limit_result_sheet_id': upper_limit_row.get('id') if upper_limit_row else None,
                        'adjusted_copayment': upper_limit_row.get('adjusted_copayment') if upper_limit_row else None,
                        **row
                    })
                processed += 1
            except Exception as e:
                failed += 1
                log_audit_error(conn, 'generateBillingPrep', str(user_id), str(e))

        status = 'success' if failed == 0 else 'partial'
        log_batch_end(conn, run_id, status, processed, failed)
    except Exception as e:
        log_batch_end(conn, run_id, 'failed', 0, 0, str(e))
        raise
    finally:
        conn.close()

def aggregate_service_records(conn, user_id, ym):
    # C-02 解消: YEAR/MONTH フィルタで月単位集計
    sql = """
        SELECT
          sr.service_id,
          COUNT(DISTINCT sr.service_date)    AS service_days,
          SUM(CASE WHEN sm.unit_fixed IS NOT NULL
                   THEN sm.unit_fixed
                   ELSE sr.duration_minutes * sm.unit_per_minute END) AS total_units
        FROM service_records sr
        JOIN service_master sm ON sr.service_id = sm.id
        WHERE sr.user_id = %s
          AND YEAR(sr.service_date)  = %s
          AND MONTH(sr.service_date) = %s
          AND sr.is_approved = 1
        GROUP BY sr.service_id
    """
    year, month = int(ym[:4]), int(ym[4:])
    return execute_query(conn, sql, (user_id, year, month))
```

### 7.3 `scheduleResumption` — Cloud Run jobs 再起動スケッチ（spec §6.Must.9 / C-19）

```python
# Cloud Run jobs 失敗時の再実行スケッチ（Runbook §6 の手順と連動）
def schedule_resumption(billing_year_month: str, failed_run_id: str):
    """
    失敗した月次バッチを再起動する。
    新しい run_id を生成し、billing_prep の draft 行はそのまま保持。
    再実行分は新 batch_run_id で追記。
    """
    import uuid
    new_run_id = f"generateBillingPrep_{billing_year_month}_retry_{uuid.uuid4().hex[:8]}"
    # Cloud Tasks 経由で再エンキュー（GAS `triggerBillingBatch` と同じ経路）
    enqueue_cloud_task(
        url=BILLING_JOB_URL + '/run',
        body={'billing_year_month': billing_year_month, 'run_id': new_run_id}
    )
    return new_run_id
```

### 7.4 冪等性確保メカニズム

1. 同一 `(user_id, billing_year_month, service_id, batch_run_id)` の INSERT は UNIQUE KEY により失敗 → エラーとして記録
2. 再実行時は **新しい `batch_run_id`** を生成して再 INSERT（前回 draft 行は保持）
3. 請求担当が `billing_prep` で正しい `batch_run_id` の行を `confirmed` に昇格

### 7.5 エラー再実行手順

1. `batch_run_log` で `status = 'failed'` の行を確認
2. GAS `triggerBillingBatch` を手動実行（`billing_year_month` を明示）
3. または Cloud Run jobs コンソールからジョブを直接再実行
4. 完了後、請求担当が `BillingPrepView` で対象月の draft 行を確認して `confirmed` に変更

---

## 8. `syncAllotmentsFromSF` — 支給決定同期

```javascript
function syncAllotmentsFromSF() {
  const runId = generateRunId('sf_sync_allotments');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'sf_sync_allotments', runId);

  try {
    const auth  = getSalesforceAccessToken();
    const since = getLastSyncTimestamp(conn, 'sf_sync_allotments');

    const soql = `
      SELECT Id, PersonAccount__c, ServiceType__c,
             AllotmentQty__c, AllotmentUnit__c,
             ValidFrom__c, ValidTo__c, LastModifiedDate
      FROM ServiceAllotment__c
      WHERE LastModifiedDate > ${since.toISOString()}
      LIMIT 200
    `;
    const records = (callSalesforceSOQL(auth, soql)).records || [];

    let processed = 0, failed = 0;
    for (const rec of records) {
      try {
        const userId = resolveUserId(conn, rec.PersonAccount__c);
        upsertAllotmentCache(conn, rec, userId);
        processed++;
      } catch (e) {
        failed++;
        logAuditError(conn, 'sf_sync_allotments', rec.Id, e.message);
      }
    }

    logBatchEnd(conn, runId, 'success', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}
```

---

## 9. `checkContractExpiry` — 契約満了前アラート（Must.10）

```javascript
function checkContractExpiry() {
  const conn = getCloudSqlConnection();
  try {
    // 30日以内に満了する active 契約を検出
    const stmt = conn.prepareStatement(`
      SELECT cm.id, cm.user_id, cm.contract_end_date, cm.facility_id
      FROM contract_mirror cm
      WHERE cm.status = 'active'
        AND cm.contract_end_date IS NOT NULL
        AND cm.contract_end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND cm.contract_end_date >= CURDATE()
    `);
    const rs = stmt.executeQuery();
    const expiringContracts = [];
    while (rs.next()) {
      expiringContracts.push({
        userId: rs.getInt('user_id'),
        contractEndDate: rs.getString('contract_end_date'),
        facilityId: rs.getInt('facility_id')
      });
    }

    if (expiringContracts.length > 0) {
      // audit_log に記録
      logAuditEvent(conn, 'CONTRACT_EXPIRY_WARNING', 'contract_mirror', null, 'gas_batch',
        JSON.stringify({ count: expiringContracts.length, contracts: expiringContracts }));
    }
  } finally {
    conn.close();
  }
}
```

---

## 10. `exportBillingCSV` — 請求 CSV エクスポート（WebApp）

```javascript
function doGet(e) {
  const ym = e.parameter.ym;
  if (!ym || !/^\d{6}$/.test(ym)) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Invalid ym parameter' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const conn = getCloudSqlConnection();
  try {
    const rows = getBillingPrepConfirmed(conn, ym);
    const csv  = buildCsvContent(rows);
    // audit_log に EXPORT イベントを記録
    logAuditEvent(conn, 'EXPORT', 'billing_prep', ym, 'gas_batch', JSON.stringify({ ym }));
    return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV);
  } finally {
    conn.close();
  }
}
```

---

## 11. トリガ設定一覧

| 関数名 | トリガ種別 | 設定値 | 備考 |
|---|---|---|---|
| `syncUsersFromSF` | 時間ベース | 毎時（毎正時）| |
| `syncAllotmentsFromSF` | 時間ベース | 毎時（毎正時）| |
| `syncFacilitiesFromSF` | 時間ベース | 毎日 2:00-3:00 JST（C-06 新設）| |
| `syncContractsFromSF` | 時間ベース | 毎日 3:00-4:00 JST | |
| `pushDailySummaryToSF` | 時間ベース | 毎日 23:00-24:00 JST | |
| `triggerBillingBatch` | 時間ベース | 毎月 2 日 0:00-1:00 JST（C-20）| Cloud Tasks 投入のみ |
| `checkContractExpiry` | 時間ベース | 毎日 9:00-10:00 JST | |
| `checkRecordCompleteness` | 時間ベース | 毎日 7:00-8:00 JST | |
| `exportBillingCSV` | Web アプリ（doGet）| 組織内公開 | AppSheet Action から呼び出し |

---

## 12. 共通ユーティリティ

```javascript
function generateRunId(batchName) {
  return batchName + '_' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 17);
}

function getCloudSqlConnection() {
  const dbUrl      = getSecret('CS_JDBC_URL');
  const dbUser     = getSecret('CS_DB_USER');
  const dbPassword = getSecret('CS_DB_PASSWORD');
  const conn = Jdbc.getCloudSqlConnection(dbUrl, dbUser, dbPassword);
  conn.createStatement().execute("SET time_zone = 'Asia/Tokyo'");
  return conn;
}

function logBatchStart(conn, batchName, runId) {
  const stmt = conn.prepareStatement(
    'INSERT INTO batch_run_log (batch_name, run_id, status, started_at) VALUES (?, ?, "running", NOW())'
  );
  stmt.setString(1, batchName);
  stmt.setString(2, runId);
  stmt.executeUpdate();
}

function logBatchEnd(conn, runId, status, processed, failed, errorMsg) {
  const stmt = conn.prepareStatement(`
    UPDATE batch_run_log
    SET status = ?, finished_at = NOW(),
        records_processed = ?, records_failed = ?, error_message = ?
    WHERE run_id = ?
  `);
  stmt.setString(1, status);
  stmt.setInt(2, processed);
  stmt.setInt(3, failed);
  stmt.setString(4, errorMsg || null);
  stmt.setString(5, runId);
  stmt.executeUpdate();
}

function logAuditEvent(conn, eventType, tableName, recordId, actorId, afterJson) {
  const stmt = conn.prepareStatement(`
    INSERT INTO audit_log (event_type, table_name, record_id, actor_type, actor_id, after_json)
    VALUES (?, ?, ?, 'gas_batch', ?, ?)
  `);
  stmt.setString(1, eventType);
  stmt.setString(2, tableName);
  stmt.setString(3, recordId);
  stmt.setString(4, actorId);
  stmt.setString(5, afterJson);
  stmt.executeUpdate();
}
```
