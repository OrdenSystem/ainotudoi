---
cycle: "001"
related_spec_sections: ["§6.Must.4", "§6.Must.6", "§6.Must.7", "§4（GAS連携経路）"]
streams_independent_of: ["02", "03", "04", "09"]
---

# 06. GAS バッチ / 連携 — 関数一覧・擬似コード

> 対応 spec.md: §6.Must.4（支給決定残量集計）/ §6.Must.6（請求準備バッチ）/ §6.Must.7（Salesforce ⇄ CloudSQL 同期バッチ設計）
>
> **前提**:
> - GAS V8 ランタイム（Rhino 廃止済み — tech-research-notes.md R3）
> - Salesforce REST API v61.0 + OAuth2 JWT Bearer（Connected App: `WelfareGASIntegration`）
> - CloudSQL 接続: Cloud SQL Auth Proxy（推奨）または Public IP + SSL
> - 実行上限: 6分/回（spec §8 R-06 — チャンク分割で対処）
> - 秘密情報: GAS Script Properties に保管（`SF_PRIVATE_KEY`, `SF_CLIENT_ID`, `CS_CONNECTION_STRING` 等）

---

## 1. 関数一覧（表形式）

| 関数名 | トリガ種別 | 実行頻度 | 入力 | 出力 | エラー時挙動 |
|---|---|---|---|---|---|
| `syncUsersFromSF` | 時間ベース（毎時）| 1時間ごと | Salesforce PersonAccount SOQL | CloudSQL `user_mirror` UPSERT | `batch_run_log` に `failed` 記録、次回トリガで再試行 |
| `syncUsersFullFromSF` | 手動（管理者実行）| オンデマンド | Salesforce PersonAccount 全件 | CloudSQL `user_mirror` UPSERT | 同上 |
| `syncAllotmentsFromSF` | 時間ベース（毎時）| 1時間ごと | Salesforce ServiceAllotment__c | CloudSQL `user_allotment_cache` UPSERT | 同上 |
| `pushDailySummaryToSF` | 時間ベース（深夜）| 1日1回（23:00 JST）| CloudSQL `service_records` 集計 | Salesforce PersonAccount カスタム項目更新 | エラー行をスキップして `batch_run_log` に記録 |
| `runMonthlyBilling` | 時間ベース（月次）| 月初 3 日 0:00 JST | CloudSQL `service_records`（前月）| CloudSQL `billing_prep` INSERT | チャンク分割 + `batch_run_id` で冪等性確保 |
| `exportBillingCSV` | Web アプリ（GET）| オンデマンド（請求担当が AppSheet から呼出）| `billing_year_month` クエリパラメータ | レスポンス: CSV テキスト or Blob | HTTP 400/500 を返す |
| `claudeAssistSummary` | 手動 / Web アプリ | オンデマンド | サービス記録テキスト（PII マスク済）| 要約テキスト | Claude API エラー時はフォールバックメッセージを返す |

---

## 2. 認証ユーティリティ

### 2.1 `getSalesforceAccessToken()` — JWT Bearer 認証

```javascript
// GAS V8 / 擬似コード
function getSalesforceAccessToken() {
  const props = PropertiesService.getScriptProperties();
  const clientId    = props.getProperty('SF_CLIENT_ID');
  const privateKey  = props.getProperty('SF_PRIVATE_KEY');   // PEM形式、Secret Manager推奨
  const username    = props.getProperty('SF_USERNAME');
  const instanceUrl = props.getProperty('SF_INSTANCE_URL'); // 例: https://xxx.my.salesforce.com

  // JWT ヘッダー / ペイロード生成（V8 Utilities.base64EncodeWebSafe）
  const header  = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: clientId,
    sub: username,
    aud: instanceUrl + '/services/oauth2/token',
    exp: now + 300
  }));

  const signingInput = header + '.' + payload;
  // GAS V8 では RSA 署名を直接サポートしないため、Apps Script の Utilities.computeRsaSha256Signature を使用
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(signingInput, privateKey)
  );
  const jwt = signingInput + '.' + signature;

  const response = UrlFetchApp.fetch(instanceUrl + '/services/oauth2/token', {
    method: 'POST',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('SF_AUTH_FAILED: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText()); // { access_token, instance_url }
}
```

### 2.2 `getCloudSqlConnection()` — CloudSQL 接続

```javascript
// GAS から CloudSQL への接続（JDBC）
function getCloudSqlConnection() {
  const props      = PropertiesService.getScriptProperties();
  const dbUrl      = props.getProperty('CS_JDBC_URL');   // jdbc:google:mysql://...
  const dbUser     = props.getProperty('CS_DB_USER');
  const dbPassword = props.getProperty('CS_DB_PASSWORD'); // Secret Manager 推奨

  const conn = Jdbc.getCloudSqlConnection(dbUrl, dbUser, dbPassword);
  conn.createStatement().execute("SET time_zone = 'Asia/Tokyo'");
  return conn;
}
```

---

## 3. `syncUsersFromSF` — Salesforce → CloudSQL 差分同期

> spec §6.Must.7 対応。同期キー = `sf_account_id`。競合解決: SF を SoR とし CloudSQL を上書き。

```javascript
function syncUsersFromSF() {
  const runId = generateRunId('sf_sync_users');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'sf_sync_users', runId);

  try {
    const auth  = getSalesforceAccessToken();
    const since = getLastSyncTimestamp(conn, 'sf_sync_users'); // batch_run_log から取得

    // SOQL: LastModifiedDate で差分取得
    const soql = `
      SELECT Id, LastName, FirstName, DisabilityType__c,
             RecipientCertNo__c, RecipientCertExpiry__c,
             FacilityId__c, IsActive__c, LastModifiedDate
      FROM Account
      WHERE IsPersonAccount = true
        AND LastModifiedDate > ${since.toISOString()}
      ORDER BY LastModifiedDate ASC
      LIMIT 200
    `;
    const sfResponse = callSalesforceSOQL(auth, soql);
    const records    = sfResponse.records || [];

    let processed = 0;
    let failed    = 0;

    for (const rec of records) {
      try {
        upsertUserMirror(conn, rec);  // sf_account_id で ON DUPLICATE KEY UPDATE
        processed++;
      } catch (e) {
        failed++;
        logAuditError(conn, 'sf_sync_users', rec.Id, e.message);
      }
    }

    // 200件 LIMIT に達した場合、再トリガで継続（GAS 6分上限対策）
    if (records.length === 200) {
      triggerSyncContinuation();  // PropertiesService に since を保存してトリガ再発火
    }

    logBatchEnd(conn, runId, 'success', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;  // GAS に失敗を通知（メール通知トリガ）
  } finally {
    conn.close();
  }
}

// UPSERT ヘルパー
function upsertUserMirror(conn, sfRecord) {
  const stmt = conn.prepareStatement(`
    INSERT INTO user_mirror
      (sf_account_id, last_name, first_name, disability_type,
       recipient_cert_no, recipient_cert_expiry, facility_id, is_active, sf_synced_at)
    VALUES (?, ?, ?, ?, AES_ENCRYPT(?, @@global.secure_file_priv), ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      last_name             = VALUES(last_name),
      first_name            = VALUES(first_name),
      disability_type       = VALUES(disability_type),
      recipient_cert_no     = AES_ENCRYPT(VALUES(recipient_cert_no), @@global.secure_file_priv),
      recipient_cert_expiry = VALUES(recipient_cert_expiry),
      is_active             = VALUES(is_active),
      sf_synced_at          = NOW(),
      updated_at            = NOW()
  `);
  // ... パラメータセットと executeUpdate()
}
```

**リトライ方針**:
1. `batch_run_log` に `status='failed'` を記録
2. 次回の時間ベーストリガ（1時間後）で `since` を失敗直前の最終成功タイムスタンプに設定して再実行
3. 3回連続失敗 → GAS 失敗メール通知 → 事業所管理者が手動で `syncUsersFullFromSF()` を実行

**実行ログ保存先**: `batch_run_log` テーブル（`03-cloudsql-ddl.sql` §12 参照）

---

## 4. `runMonthlyBilling` — 月次請求準備バッチ

> spec §6.Must.6 対応。I/O 仕様・冪等性・エラー再実行手順を記載。

### 4.1 I/O 仕様

| 項目 | 内容 |
|---|---|
| **入力** | CloudSQL `service_records`（前月分、`is_approved = 1`）+ `service_master` + `addition_master` |
| **出力** | CloudSQL `billing_prep`（対象年月ごとの集計行）|
| **バッチパラメータ** | `billing_year_month`（YYYYMM）— 省略時は前月を自動算出 |
| **冪等性キー** | `batch_run_id`（実行ごとに UUID 生成）+ `billing_prep` の UNIQUE KEY `(user_id, billing_year_month, service_id, batch_run_id)` |

### 4.2 擬似コード

```javascript
function runMonthlyBilling(billingYearMonth) {
  const ym    = billingYearMonth || getPreviousYearMonth(); // 省略時は前月
  const runId = generateRunId('monthly_billing');
  const conn  = getCloudSqlConnection();
  logBatchStart(conn, 'monthly_billing', runId);

  try {
    // 対象利用者をチャンク取得（GAS 6分上限対策 — spec §8 R-06）
    const users = getUsersWithRecords(conn, ym);  // SELECT DISTINCT user_id
    const CHUNK_SIZE = 50;

    let processed = 0;
    let failed    = 0;

    for (let i = 0; i < users.length; i += CHUNK_SIZE) {
      const chunk = users.slice(i, i + CHUNK_SIZE);

      for (const userId of chunk) {
        try {
          const aggregated = aggregateServiceRecords(conn, userId, ym);
          // aggregated: [{ service_id, service_days, total_units, addition_units, deduction_units }]
          for (const row of aggregated) {
            insertBillingPrep(conn, {
              userId, ym, runId, ...row
            });
          }
          processed++;
        } catch (e) {
          failed++;
          logAuditError(conn, 'monthly_billing', String(userId), e.message);
        }
      }

      // 残り実行時間が 1 分未満なら次回継続トリガを設定
      if (getRemainingExecutionTime() < 60000) {
        scheduleResumption('monthly_billing', ym, i + CHUNK_SIZE, runId);
        break;
      }
    }

    logBatchEnd(conn, runId, failed === 0 ? 'success' : 'partial', processed, failed);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}

// 集計ロジック擬似コード
function aggregateServiceRecords(conn, userId, ym) {
  // 1. service_records を service_id ごとに集計
  const sql = `
    SELECT
      sr.service_id,
      COUNT(DISTINCT sr.service_date)                    AS service_days,
      SUM(CASE WHEN sm.unit_fixed IS NOT NULL
               THEN sm.unit_fixed
               ELSE sr.duration_minutes * sm.unit_per_minute END) AS total_units
    FROM service_records sr
    JOIN service_master sm ON sr.service_id = sm.id
    WHERE sr.user_id = ?
      AND DATE_FORMAT(sr.service_date, '%Y%m') = ?
      AND sr.is_approved = 1
    GROUP BY sr.service_id
  `;
  // 2. addition_master から加算・減算を適用（骨子のみ — spec §2 Out of scope の完全実装は Cycle 2）
  // 3. net_units = total_units + addition_units - deduction_units
  // ... 結果を配列で返す
}
```

### 4.3 冪等性確保メカニズム

1. 同一 `(user_id, billing_year_month, service_id, batch_run_id)` の INSERT は UNIQUE KEY により失敗 → エラーとして記録
2. 再実行時は **新しい `batch_run_id`** を生成して再 INSERT（前回の draft を上書きしない）
3. 請求担当が `billing_prep` を確認し、`status = 'confirmed'` に昇格させることで請求確定

### 4.4 エラー再実行手順

1. `batch_run_log` で `status = 'failed'` の行を確認
2. `billing_year_month` を指定して `runMonthlyBilling('YYYYMM')` を手動実行
3. 前回 `draft` 行はそのまま残り、再実行分が新 `batch_run_id` で追記される
4. 請求担当が正しい batch_run_id の行を選択して `confirmed` に変更

---

## 5. `syncAllotmentsFromSF` — 支給決定同期

> spec §6.Must.4「残量計算の前提データ確保」対応

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

    for (const rec of records) {
      upsertAllotmentCache(conn, rec);
    }

    logBatchEnd(conn, runId, 'success', records.length, 0);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}
```

---

## 6. `pushDailySummaryToSF` — 日次集計 → Salesforce

> spec §4「CloudSQL → Salesforce 日次集計連携」対応

```javascript
function pushDailySummaryToSF() {
  const runId   = generateRunId('push_daily_summary');
  const conn    = getCloudSqlConnection();
  const auth    = getSalesforceAccessToken();

  logBatchStart(conn, 'push_daily_summary', runId);

  try {
    // 昨日のサービス記録件数・時間を利用者ごとに集計して SF に PATCH
    const yesterday = getYesterday(); // YYYY-MM-DD
    const summaries = getDailySummaries(conn, yesterday);

    for (const summary of summaries) {
      // Salesforce Composite API で一括更新（最大 25件/リクエスト）
      patchSalesforceRecord(auth, 'Account', summary.sf_account_id, {
        LastServiceDate__c:          yesterday,
        MonthlyServiceMinutes__c:    summary.monthly_minutes,
        MonthlyServiceCount__c:      summary.monthly_count
      });
    }

    logBatchEnd(conn, runId, 'success', summaries.length, 0);
  } catch (e) {
    logBatchEnd(conn, runId, 'failed', 0, 0, e.message);
    throw e;
  } finally {
    conn.close();
  }
}
```

---

## 7. `exportBillingCSV` — 請求 CSV エクスポート（WebApp）

> spec §6.Must.6「外部請求システム向け CSV 生成」対応（将来連携の手前まで）

```javascript
// Web アプリとして公開（doGet）
function doGet(e) {
  const ym = e.parameter.ym; // クエリパラメータ: ?ym=202506

  if (!ym || !/^\d{6}$/.test(ym)) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Invalid ym parameter' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const conn = getCloudSqlConnection();
  try {
    const rows = getBillingPrepConfirmed(conn, ym);
    const csv  = buildCsvContent(rows);

    return ContentService.createTextOutput(csv)
      .setMimeType(ContentService.MimeType.CSV);
  } finally {
    conn.close();
  }
}
```

**アクセス制御**: Web アプリ公開範囲を「組織内のユーザーのみ」に限定。AppSheet の `ExportBillingCSV` Action から呼び出す（`05-appsheet-tables.md` §5 参照）。

---

## 8. `claudeAssistSummary` — AI 要約補助（最小）

> spec §5 R5 / §8 R-09「Cycle 1 は AI Must から外す」対応。Should 扱いのため構造のみ定義。

```javascript
function claudeAssistSummary(serviceNoteText) {
  // ⚠️ PII マスキング必須（spec §8 R-09）
  // Cycle 1 では呼び出し構造のみ定義。実 PII は渡さない。
  const maskedText = maskPii(serviceNoteText); // 氏名・受給者証番号等を置換

  const props   = PropertiesService.getScriptProperties();
  const apiKey  = props.getProperty('CLAUDE_API_KEY');

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: '障害福祉サービスの記録を簡潔に要約してください。個人を特定できる情報は含めないでください。',
        cache_control: { type: 'ephemeral' }  // プロンプトキャッシング（spec §5 R5）
      }
    ],
    messages: [{ role: 'user', content: maskedText }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':        apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':     'application/json'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    // フォールバック: 要約失敗をユーザーに通知（元テキスト使用を促す）
    return { summary: null, error: 'AI要約サービスが一時的に利用できません。' };
  }

  const result = JSON.parse(response.getContentText());
  return { summary: result.content[0].text, error: null };
}
```

---

## 9. 共通ユーティリティ

```javascript
// 実行ID生成
function generateRunId(batchName) {
  return batchName + '_' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 17);
}

// バッチ開始ログ
function logBatchStart(conn, batchName, runId) {
  const stmt = conn.prepareStatement(
    'INSERT INTO batch_run_log (batch_name, run_id, status, started_at) VALUES (?, ?, "running", NOW())'
  );
  stmt.setString(1, batchName);
  stmt.setString(2, runId);
  stmt.executeUpdate();
}

// バッチ終了ログ
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

// 残り実行時間の簡易確認
function getRemainingExecutionTime() {
  // GAS V8 に標準の残時間 API はないため、開始時刻からの差分で推定
  // 正確な管理は PropertiesService でチャンクオフセットを保持して継続実行
  return 360000 - (Date.now() - _scriptStartTime); // 6分 = 360秒
}
```

---

## 10. トリガ設定一覧

| 関数名 | トリガ種別 | 設定値 | 備考 |
|---|---|---|---|
| `syncUsersFromSF` | 時間ベース | 毎時（毎正時）| GAS プロジェクト > トリガ |
| `syncAllotmentsFromSF` | 時間ベース | 毎時（毎正時）| 同上 |
| `pushDailySummaryToSF` | 時間ベース | 毎日 23:00-24:00 | 同上 |
| `runMonthlyBilling` | 時間ベース | 毎月 2 日 0:00-1:00 | 同上（月初 3 日以内に確定）|
| `exportBillingCSV` | Web アプリ（doGet）| 組織内公開 | AppSheet Action から呼び出し |
