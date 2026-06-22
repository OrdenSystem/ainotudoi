# 09 運用 Runbook — 障害福祉システム Cycle 2

> 対象システム: HopeCareDX (AppSheet / CloudSQL / Salesforce / GAS / Cloud Run jobs)
> RTO ≤ 4 時間 / RPO ≤ 1 時間 を全シナリオで達成すること

---

## §1 前提条件・環境定義

| 変数 | 値 |
|------|----|
| GCP Project ID | `ainotudoi-443914355` |
| CloudSQL インスタンス | `welfare-mysql` (asia-northeast1, db-custom-2-7680) |
| Cloud KMS KEK パス | `projects/ainotudoi-443914355/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek` |
| Secret Manager プレフィックス | `projects/ainotudoi-443914355/secrets/` |
| AppSheet App ID | `b9e4f84d-f9b9-4376-97f1-83e3b07122e3` |
| Cloud Run jobs サービス | `welfare-billing-batch` (asia-northeast1) |
| GCS WORM バケット | `gs://welfare-audit-worm-ainotudoi-443914355` |
| Cloud Tasks キュー | `welfare-batch-queue` (asia-northeast1) |
| SF 組織 | `lab@appsheet.fun` の本番 Enterprise Edition |

---

## §2 SLA 目標

| 指標 | 目標値 | 計測方法 |
|------|--------|----------|
| **RPO** | **≤ 1 時間** | CloudSQL PITR ログ間隔 (binlog 1 分連続) + 最終バックアップからの再生可能時刻 |
| **RTO** | **≤ 4 時間** | 障害検知 → サービス再開までの経過時間 (Cloud Monitoring アラート起点) |
| 月次請求バッチ完了 | 毎月 5 日 12:00 JST まで | Cloud Run jobs 終了ステータス |
| GAS 日次同期成功率 | ≥ 99% (月) | Apps Script Dashboard |

---

## §3 障害シナリオ別対応表（6 シナリオ × 3 列）

### シナリオ S1: Salesforce 停止

| フェーズ | 内容 |
|----------|------|
| **検知** | Cloud Monitoring — GAS `syncUsersFromSF` エラー率 > 50% が 15 分継続 → PagerDuty アラート。SF Status Page (trust.salesforce.com) を確認。 |
| **暫定対応** | 1. GAS トリガーを全停止: Apps Script UI → トリガー → 無効化。2. AppSheet は CloudSQL ミラーデータのみで継続運用 (読取 OK、SF 依存 Bot 停止)。3. 新規利用者登録・契約更新を紙台帳へ切替 (Runbook §8 紙運用手順参照)。4. SF 障害期間中の変更ログを `sf_pending_changes` スプレッドシートに手動記録。 |
| **復旧** | 1. SF 復旧確認 (trust.salesforce.com GREEN)。2. GAS トリガーを再有効化。3. 手動記録した変更を `sf_pending_changes` から一括インポート (GAS `bulkSyncPending()`)。4. CloudSQL ミラーテーブルの整合性を `checkMirrorIntegrity()` で検証。5. 差異レコードを補正して正常稼働を確認。 |

---

### シナリオ S2: CloudSQL 停止

| フェーズ | 内容 |
|----------|------|
| **検知** | Cloud SQL インスタンスヘルスチェック失敗 → Cloud Monitoring `database/up` = 0 が 5 分継続 → アラート。AppSheet でデータ取得エラーが表示される。 |
| **暫定対応** | 1. AppSheet を「メンテナンスモード」に切替 (AppSheet Studio → Deploy → Maintenance)。2. GAS 全トリガー停止。3. Cloud Run jobs が実行中なら `gcloud run jobs cancel` でキャンセル (途中状態は `billing_prep.status = 'running'` のまま保持)。4. ユーザーへ緊急通知 (AppSheet Notification Bot は停止するため、管理者がメール一斉送信)。 |
| **復旧** | 1. CloudSQL インスタンス復旧確認: `gcloud sql instances describe welfare-mysql`。2. PITR が必要な場合は §5 PITR 手順を実行。3. Cloud SQL Auth Proxy 再接続確認。4. AppSheet メンテナンスモード解除。5. GAS トリガー再有効化。6. 中断した Cloud Run jobs を `scheduleResumption()` で再開 (§4 参照)。7. `checkMirrorIntegrity()` で整合性確認。 |

---

### シナリオ S3: GAS 関数失敗

| フェーズ | 内容 |
|----------|------|
| **検知** | Apps Script Dashboard → 実行ログ → エラー率上昇。Cloud Monitoring カスタムメトリクス `custom.googleapis.com/gas/sync_error_count` > 0 → アラート。GAS 内 `notifyError()` が Slack #welfare-ops チャンネルへ投稿。 |
| **暫定対応** | 1. エラー関数の特定: Apps Script 実行ログで関数名・エラーメッセージ確認。2. 単発エラー (ネットワーク瞬断等) → 次回トリガーで自動リトライ (GAS retry wrapper: 最大 3 回、指数バックオフ)。3. 連続失敗 → 該当トリガーを手動停止して影響範囲を局所化。4. `syncUsersFromSF` 失敗 → SF データ更新を一時停止、既存ミラーで運用継続。 |
| **復旧** | 1. エラー原因を特定 (Secret Manager 権限切れ / CloudSQL 接続数超過 / SF API 制限)。2. 原因に応じた修正: 権限 → IAM ポリシー更新、接続数 → Cloud SQL接続プール調整、API 制限 → バックオフ時間延長。3. `testSyncFunction()` でスモークテスト実行。4. 手動で 1 回実行して正常終了を確認。5. トリガー再有効化。6. 失敗期間のデータ欠損を `backfillSyncData(startDate, endDate)` で補完。 |

---

### シナリオ S4: Cloud Run jobs 失敗（月次請求バッチ）

| フェーズ | 内容 |
|----------|------|
| **検知** | Cloud Run jobs 実行ステータス `FAILED` → Cloud Monitoring アラート。GAS `triggerBillingBatch()` の Cloud Tasks 応答確認。`billing_prep` テーブルの `status = 'error'` レコード数 > 0。 |
| **暫定対応** | 1. エラーログ確認: `gcloud run jobs executions describe {execution-name} --region asia-northeast1`。2. 途中完了分の確認: `SELECT COUNT(*), status FROM billing_prep WHERE batch_month = CURRENT_MONTH GROUP BY status`。3. 完了分 (`status = 'done'`) は再処理不要。4. 失敗分 (`status = 'error'` / `'running'`) を特定してエラー原因調査。5. 締切 (毎月 5 日 12:00) まで 4 時間以上ある場合のみ再実行を試みる。 |
| **復旧** | 1. `scheduleResumption()` を呼び出して失敗分のみ再処理 (§4 参照)。2. 冪等性確保: `billing_prep` の `status` チェックで重複処理を防ぐ。3. 再実行後に全件 `status = 'done'` を確認。4. 上限額管理 (`upper_limit_result_sheet`) の整合性確認。5. 締切を超過する場合は福祉事務所への延長申請手続きを開始 (Runbook §9 行政連絡手順)。 |

---

### シナリオ S5: Cloud KMS 障害

| フェーズ | 内容 |
|----------|------|
| **検知** | GAS `kmsEncrypt()` / `kmsDecrypt()` が `503 Service Unavailable` を返す。Cloud Monitoring — KMS API エラー率 > 1% → アラート。AppSheet での利用者詳細表示がタイムアウト。 |
| **暫定対応** | 1. KMS キャッシュ活用: `kmsDecrypt()` は GAS キャッシュサービス (CacheService) に復号済み値を TTL=300 秒でキャッシュ。障害発生直後はキャッシュから提供を継続。2. キャッシュ期限切れ後は **受給者証番号の表示を `***-****` にマスク**して運用継続 (AppSheet 式で `IF(KMS_AVAILABLE, decrypted_value, "***-****")`)。3. 新規利用者登録の受給者証番号入力を一時停止。4. GCP Status Dashboard で KMS インシデント確認。 |
| **復旧** | 1. KMS 復旧確認: テスト暗号化 `gcloud kms encrypt --keyring=welfare --key=cloudsql-kek --location=asia-northeast1 --plaintext-file=/dev/stdin --ciphertext-file=/dev/null <<< "test"`。2. GAS キャッシュをフラッシュ: `CacheService.getScriptCache().removeAll(['kms_*'])`。3. 一時停止していた新規登録を再開。4. マスク表示が解除されることを確認。5. インシデント対応記録を `audit_log` に手動追記。 |

**KMS 手動 fallback 手順:**

```
# KMS が長期停止 (> 8h) で手動 fallback が必要な場合
# ※ 要セキュリティ責任者承認

# 1. 緊急用 DEK をローカル生成 (オフライン環境)
openssl rand -base64 32 > /tmp/emergency-dek.key

# 2. 緊急 DEK で対象データを再暗号化 (最小権限環境で実行)
# GAS emergency-decrypt.gs を実行して平文取得 → 再暗号化

# 3. KMS 復旧後に通常 KEK で再ラップ
# emergency-dek は使用直後に安全削除
shred -u /tmp/emergency-dek.key
```

---

### シナリオ S6: Secret Manager 障害

| フェーズ | 内容 |
|----------|------|
| **検知** | GAS `getSecret()` が例外をスロー → GAS エラーログ + Slack 通知。Cloud Monitoring — Secret Manager API エラー率 > 0.1%。 |
| **暫定対応** | 1. GAS 内シークレットキャッシュ活用: `getSecret()` は PropertiesService (Script Properties) に TTL なしキャッシュを保持。**障害前に一度成功していれば** キャッシュから読み取りを継続。2. キャッシュなし場合 → `SF_PRIVATE_KEY` 不在により SF 接続不可。GAS トリガーを全停止して SF 連携を中断。3. `CS_DB_PASSWORD` 不在により CloudSQL 接続不可。AppSheet も停止。ユーザー通知を発報。 |
| **復旧** | 1. GCP Status Dashboard で Secret Manager インシデント確認・復旧待機。2. 復旧後 `gcloud secrets versions access latest --secret SF_PRIVATE_KEY` でアクセス確認。3. GAS キャッシュが古い場合は Script Properties をクリア: `PropertiesService.getScriptProperties().deleteAllProperties()`。4. GAS トリガー再有効化。5. テスト実行で SF 接続・CloudSQL 接続を確認。 |

---

## §4 Cloud Run jobs `scheduleResumption` 参照

`do/06-gas-integrations.md` §5 に実装コードスケッチを記載済み。要点を以下に抜粋:

```python
# Cloud Run jobs: welfare-billing-batch/main.py (抜粋)
def scheduleResumption(failed_records: list[dict]) -> None:
    """
    失敗した billing_prep レコードのみを対象に Cloud Tasks へ
    再実行タスクをエンキューする。冪等性は billing_prep.status で保証。
    """
    client = tasks_v2.CloudTasksClient()
    queue_path = client.queue_path(PROJECT_ID, LOCATION, QUEUE_NAME)

    for record in failed_records:
        # status が 'error' のもののみ再処理
        if record["status"] != "error":
            continue

        task_body = {
            "billing_prep_id": record["id"],
            "user_id": record["user_id"],
            "batch_month": record["batch_month"],
            "retry_count": record.get("retry_count", 0) + 1,
        }
        # 既存タスクとの重複防止: task_id に billing_prep_id を埋め込む
        task = {
            "name": f"{queue_path}/tasks/billing-{record['id']}",
            "http_request": {
                "http_method": tasks_v2.HttpMethod.POST,
                "url": CLOUD_RUN_JOB_URL,
                "oidc_token": {"service_account_email": SA_EMAIL},
                "body": json.dumps(task_body).encode(),
            },
            "schedule_time": datetime.utcnow() + timedelta(minutes=5),
        }
        try:
            client.create_task(parent=queue_path, task=task)
        except AlreadyExists:
            # 同一 billing_prep_id のタスクが既にキューにある → スキップ
            pass
```

完全実装は `do/06-gas-integrations.md` §5「Cloud Run jobs Python 実装スケッチ」を参照。

---

## §5 PITR (Point-in-Time Recovery) 手順表（C-19）

CloudSQL は自動バックアップ (日次) + binlog による PITR を有効化する。

| ステップ | コマンド / 操作 | 所要時間目安 |
|----------|----------------|-------------|
| 1. インスタンス停止確認 | `gcloud sql instances describe welfare-mysql --format="value(state)"` → `RUNNABLE` 以外を確認 | 1 分 |
| 2. 復旧目標時刻の決定 | インシデント発生時刻 - 安全マージン 10 分 = target_time | 5 分 |
| 3. PITR クローン作成 | `gcloud sql instances clone welfare-mysql welfare-mysql-pitr --point-in-time="YYYY-MM-DDTHH:MM:SSZ"` | 15〜30 分 |
| 4. クローンの整合性検証 | クローンインスタンスに接続し `SELECT COUNT(*) FROM service_records WHERE DATE(created_at) = DATE(target_time)` でレコード数確認 | 10 分 |
| 5. アプリ接続先切替 | GAS `INSTANCE_CONNECTION_NAME` を `welfare-mysql-pitr` に更新 (Secret Manager 経由) | 5 分 |
| 6. AppSheet データソース更新 | AppSheet Studio → Data → WelfareCloudSQL → 接続文字列更新 → Save | 10 分 |
| 7. 動作確認 | AppSheet でレコード表示・登録テスト実施 | 15 分 |
| 8. 旧インスタンスのバックアップ保管 | `gcloud sql instances patch welfare-mysql --no-backup` で自動バックアップ停止後、スナップショットを GCS エクスポート | 20 分 |
| 9. インスタンス名正規化 (任意) | DNS / Secret Manager の接続先を `welfare-mysql-pitr` → `welfare-mysql` に rename するか、新インスタンスを正式名で再作成 | 30 分 |
| **合計 RTO 目安** | | **≤ 2 時間** (RTO ≤ 4 時間以内) |

**RPO 確認:**
- binlog 連続書き込み間隔: 1 分
- 自動バックアップ: 04:00 JST 日次
- 最大データ損失: バックアップ後 ~ PITR 目標時刻まで ≤ 1 時間 **(RPO ≤ 1 時間を満足)**

---

## §6 月額コスト試算（C-18）

想定規模: 利用者 500 名、職員 50 名、施設 5 か所、月次サービス実績 3,000 件

| コンポーネント | 想定規模 | 月額試算 (USD) | 月額試算 (JPY ≒ × 150) |
|--------------|---------|-------------|----------------------|
| **AppSheet** | Enterprise 50 ユーザー ($10/user/月) | $500 | ¥75,000 |
| **Salesforce Enterprise Edition** | 10 ライセンス ($150/user/月) | $1,500 | ¥225,000 |
| **CloudSQL Enterprise** | db-custom-2-7680, 50GB SSD, asia-northeast1 | $180 | ¥27,000 |
| **Cloud Run jobs** | 月 1 回 × 平均 30 分 × 2 vCPU | $2 | ¥300 |
| **Cloud KMS** | 鍵管理 1 鍵 + API 呼出 100 万回/月 | $3 | ¥450 |
| **Secret Manager** | 2 シークレット × アクセス 10 万回/月 | $1 | ¥150 |
| **Cloud Tasks** | 月 1,000 タスク | $0.05 | ¥8 |
| **Cloud Storage (WORM)** | audit_log エクスポート 10GB/月 × 5 年保持 | $2 | ¥300 |
| **GAS (Apps Script)** | 無料枠内 (実行時間 ≤ 6 分/回 × 日次) | $0 | ¥0 |
| **合計** | | **≈ $2,188** | **≈ ¥328,200/月** |

**スケールアップ試算 (利用者 2,000 名、職員 200 名):**

| コンポーネント | 変化 | 月額試算 (JPY) |
|--------------|------|----------------|
| AppSheet | 200 ユーザー | ¥300,000 |
| Salesforce EE | 30 ライセンス | ¥675,000 |
| CloudSQL Enterprise | db-custom-4-15360, 200GB | ¥81,000 |
| Cloud Run jobs | 月 1 回 × 90 分 | ¥900 |
| KMS / Secret Manager / Tasks | 比例増 | ¥3,000 |
| **合計** | | **≈ ¥1,059,900/月** |

> **注意**: Salesforce EE ライセンス費用が全体の 60〜65% を占める。利用者数増加フェーズでは AppSheet ユーザー数の最適化 (閲覧専用ユーザーの Creator → User ダウングレード) による費用削減を検討すること。

---

## §7 定期メンテナンス手順

### 7.1 月次メンテナンス（毎月第 1 月曜 02:00〜04:00 JST）

```
1. CloudSQL バックアップ確認
   gcloud sql backups list --instance welfare-mysql

2. Secret Manager シークレット有効期限確認
   gcloud secrets versions list SF_PRIVATE_KEY
   gcloud secrets versions list CS_DB_PASSWORD

3. KMS 鍵バージョン確認
   gcloud kms keys versions list \
     --keyring=welfare \
     --key=cloudsql-kek \
     --location=asia-northeast1

4. AppSheet デプロイバージョン確認 (AppSheet Studio → Deploy → History)

5. GAS 実行ログ確認 (過去 30 日のエラー率集計)

6. audit_log GCS エクスポート実行
   (GAS scheduledAuditExport() トリガー確認)
```

### 7.2 四半期メンテナンス

- KMS 鍵ローテーション実施 (`gcloud kms keys versions create`)
- Salesforce API バージョン確認・更新
- CloudSQL メンテナンスウィンドウ確認
- セキュリティパッチ適用状況確認

---

## §8 紙運用切替手順（システム全停止時）

| 業務 | 紙帳票 | 保管場所 | 復旧後のデータ投入 |
|------|--------|----------|------------------|
| サービス実績記録 | 実績記録票 (様式第 3 号) | 各施設事務室 | GAS `bulkImportFromCSV()` |
| 利用者登録 | 利用者台帳 | 施設長保管 | AppSheet 手動入力 |
| 受給者証確認 | 受給者証コピー | セキュリティキャビネット (施錠) | `syncUsersFromSF()` 実行後確認 |
| 請求作業 | 国保連請求書 (手書き) | 管理者保管 | 月次バッチ再実行で上書き |

---

## §9 行政連絡手順（月次請求締切超過時）

1. **当日 12:00 時点で batch 未完了の場合**: 都道府県国保連 担当係へ電話連絡
2. **連絡事項**: 事業所番号、施設名、遅延理由 (システム障害)、提出予定日時
3. **国保連FAX 番号**: 事業所ごとの契約書類に記載 (本 Runbook には記載しない)
4. **遅延許容**: 国保連は通常 2 営業日の猶予を認めるが、事前連絡が必須
5. **インシデント記録**: `audit_log` + 紙ベースのインシデント報告書を作成・保管 (5 年)

---

## §10 連絡先・エスカレーション

| レベル | 担当 | 連絡手段 | 目標応答時間 |
|--------|------|----------|------------|
| L1 オペレーター | 施設担当者 | Slack #welfare-ops | 15 分 |
| L2 システム管理者 | 情報システム担当 | 携帯電話 (24h) | 1 時間 |
| L3 外部ベンダー | GCP サポート | Cloud Console → Support | 4 時間 (P2) |
| L4 セキュリティ | セキュリティ責任者 | 専用緊急連絡先 | 即時 (データ漏洩時) |

---

## §11 監視設定サマリー

```yaml
# Cloud Monitoring アラートポリシー (抜粋)
alertPolicies:
  - displayName: "CloudSQL Down"
    conditions:
      metric: cloudsql.googleapis.com/database/up
      comparison: COMPARISON_LT
      threshold: 1
      duration: 300s
    notificationChannels: [pagerduty, slack-welfare-ops]

  - displayName: "KMS Error Rate"
    conditions:
      metric: cloudkms.googleapis.com/request_count
      filter: metric.label.status != "OK"
      rate_window: 600s
      threshold: 0.01
    notificationChannels: [pagerduty]

  - displayName: "Billing Batch Failed"
    conditions:
      metric: run.googleapis.com/job/completed_execution_count
      filter: metric.label.result = "failed"
    notificationChannels: [pagerduty, slack-welfare-ops]

  - displayName: "GAS Sync Error"
    conditions:
      metric: custom.googleapis.com/gas/sync_error_count
      threshold: 0
    notificationChannels: [slack-welfare-ops]
```
