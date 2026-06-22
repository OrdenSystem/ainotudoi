---
cycle: "001"
related_spec_sections: ["§6.Must.8", "§7（受入基準: セキュリティ）", "§8 R-05, R-09"]
streams_independent_of: []
---

# 08. セキュリティ・個人情報保護方針

> 対応 spec.md: §6.Must.8（セキュリティ・PII 保護方針）/ §7 受入基準（セキュリティ観点）/ §8 R-05（個人情報保護法不適合リスク）/ §8 R-09（AI 機能での PII 送信リスク）
>
> **前提**: 本ファイルは `02-data-model.md`（PII フィールド一覧）/ `04-salesforce-objects.md`（FLS 方針）/ `05-appsheet-tables.md`（Security Filter）/ `06-gas-integrations.md`（GAS 認証）を横断して統合した PII フロー前提に基づいて作成。
>
> **⚠️ 法務レビュー必須**: 本ドキュメントは設計上の方針を示すものであり、個別条文の法的解釈は範囲外。実装前に専門家（弁護士・個人情報保護コンサルタント等）によるレビューが必要。

---

## 1. 個人情報 3 分類と保管位置

> spec §7 受入基準「要配慮個人情報の保管位置一覧」対応

| 分類 | 定義 | 対象データ例 | 主な保管場所 |
|---|---|---|---|
| **基本個人情報** | 氏名・住所・電話番号・生年月日 | 利用者氏名、緊急連絡先、スタッフ氏名・メール | Salesforce PersonAccount / CloudSQL user_mirror（非暗号化列）|
| **要配慮個人情報** | 個人情報保護法 §2-3 該当 | 障害種別・障害等級・障害程度区分・支援内容詳細（notes）・長期/短期目標 | Salesforce（FLS 制限）/ CloudSQL（列レベル制限）|
| **特定機微情報** | 障害者総合支援法上の識別子 | 受給者証番号・支給量・有効期間 | Salesforce（FLS 制限 + Field History）/ CloudSQL（AES_ENCRYPT）|

### 1.1 PII フィールド一覧（全層横断）

| フィールド | 分類 | 保管場所 | 暗号化 | アクセス制限 |
|---|---|---|---|---|
| `LastName` / `FirstName` | 基本 | Salesforce + CloudSQL `user_mirror` | 保存時: GCP/SF 標準 | 全ロール参照可 |
| `PersonMobilePhone` | 基本 | Salesforce | 保存時: SF 標準 | 全ロール参照可 |
| `PersonMailingStreet/City/State` | 基本 | Salesforce | 保存時: SF 標準 | 全ロール参照可 |
| `EmergencyContactName/Phone` | 基本 | Salesforce | 保存時: SF 標準 | 全ロール参照可 |
| `DisabilityType__c` | **要配慮** ⚠️ | Salesforce + CloudSQL `user_mirror.disability_type` | 保存時: GCP/SF 標準 | サ管・管理者のみ FLS / AppSheet Security Filter |
| `DisabilityGrade__c` / `DisabilityCategory__c` | **要配慮** ⚠️ | Salesforce のみ | 保存時: SF 標準 | サ管・管理者のみ |
| `service_records.notes` | **要配慮** ⚠️ | CloudSQL のみ | 保存時: GCP 標準 | 担当スタッフ + サ管 + 管理者 |
| `LongTermGoal__c` / `ShortTermGoal__c` | **要配慮** ⚠️ | Salesforce のみ | 保存時: SF 標準 | サ管・管理者のみ |
| `RecipientCertNo__c` | **特定機微** ⚠️ | Salesforce + CloudSQL `user_mirror.recipient_cert_no` | SF 標準 / **CloudSQL: AES_ENCRYPT** | 管理者・サ管・請求担当 |
| `RecipientCertExpiry__c` | **特定機微** ⚠️ | Salesforce + CloudSQL | SF 標準 / GCP 標準 | 管理者・サ管・請求担当 |
| `ServiceAllotment__c`（支給量・期間）| **特定機微** ⚠️ | Salesforce + CloudSQL `user_allotment_cache` | SF 標準 / GCP 標準 | 管理者・サ管・請求担当 |
| `staff.email` | 基本 | CloudSQL | GCP 標準 | 管理者・本人 |

---

## 2. 暗号化方針（保存時・通信時）

> spec §7 受入基準「保存時暗号化・通信時暗号化が層ごとに明示」対応

### 2.1 保存時暗号化（Encryption at Rest）

| 層 | 方式 | CMEK 採否 | 備考 |
|---|---|---|---|
| **CloudSQL** | GCP デフォルト暗号化（AES-256）| **不採用（Cycle 1）**。Cycle 2 で再評価（spec §7）| 受給者証番号は追加で AES_ENCRYPT（アプリ層暗号化）|
| **Salesforce** | SF プラットフォーム標準暗号化（AES-256）| Salesforce Shield Encryption は **未採用（Cycle 1）**。Cycle 2 で再評価 | Field History Tracking で変更監査を補完 |
| **GAS Script Properties** | Google の標準暗号化 | — | 認証情報を保管（`SF_PRIVATE_KEY`, `CS_DB_PASSWORD` 等）|
| **CloudSQL バックアップ** | GCP デフォルト暗号化 | 不採用（Cycle 1）| バックアップデータも同等暗号化 |

**受給者証番号の追加暗号化（CloudSQL）**:
```sql
-- 格納時: AES_ENCRYPT(plaintext, key_string)
-- 参照時: CAST(AES_DECRYPT(recipient_cert_no, key_string) AS CHAR)
-- 暗号化キーは GCP Secret Manager で管理（GAS サービスアカウントが取得）
```

**⚠️ 法務レビューフラグ (L-10)**: CMEK 不採用の理由と代替措置（アプリ層暗号化）の妥当性について、個人情報保護法ガイドライン（安全管理措置）の観点から法務確認要。

### 2.2 通信時暗号化（Encryption in Transit）

| 通信経路 | 方式 | TLS バージョン |
|---|---|---|
| AppSheet ↔ CloudSQL | TLS（Cloud SQL Auth Proxy or SSL 証明書）| TLS 1.2 以上 |
| AppSheet ↔ Salesforce | HTTPS（OAuth 2.0）| TLS 1.2 以上 |
| GAS ↔ Salesforce | HTTPS（JWT Bearer + UrlFetchApp）| TLS 1.2 以上 |
| GAS ↔ CloudSQL | Cloud SQL Auth Proxy（内部 TLS）or JDBC SSL | TLS 1.2 以上 |
| GAS ↔ Claude API | HTTPS（UrlFetchApp）| TLS 1.2 以上 |
| ブラウザ ↔ AppSheet | HTTPS（Google インフラ）| TLS 1.3 推奨 |

---

## 3. PII フロー図

```mermaid
graph LR
    subgraph "入力・収集"
        UI1[利用者 / 事業所担当者]
        UI2[AppSheet 入力フォーム]
    end

    subgraph "Salesforce（SoR: マスタ）"
        SF_PA[PersonAccount\n基本・要配慮・特定機微]
        SF_SP[SupportPlan\n要配慮]
        SF_SA[ServiceAllotment\n特定機微]
    end

    subgraph "GAS（連携層）"
        GAS_SYNC[差分同期バッチ\nsf_account_id でマッピング]
        GAS_NO_PII[月次バッチ\nPII を参照せず集計]
    end

    subgraph "CloudSQL（SoR: トランザクション）"
        CS_UM[user_mirror\n基本・要配慮・特定機微\ncert_no: AES_ENCRYPT]
        CS_SR[service_records\n基本・要配慮(notes)]
        CS_BP[billing_prep\n集計データのみ\nPII 最小化]
        CS_LOG[audit_log\nイベント記録\nactor_id のみ]
    end

    subgraph "AppSheet（SoE）"
        AS_RO[SF 参照: 読取専用]
        AS_RW[CS 書込: CRUD]
    end

    UI1 --> UI2
    UI2 --> SF_PA
    UI2 --> AS_RW
    AS_RW --> CS_SR
    SF_PA --> GAS_SYNC
    SF_SA --> GAS_SYNC
    GAS_SYNC --> CS_UM
    CS_SR --> GAS_NO_PII
    GAS_NO_PII --> CS_BP
    SF_PA --> AS_RO
    SF_SA --> AS_RO
    CS_UM --> AS_RW
    CS_SR --> CS_LOG
    CS_UM --> CS_LOG
```

**PII 最小化原則**:
- `billing_prep` には氏名・障害種別等の PII を含めない（`user_id` FK のみ）
- Claude API へは PII を**送信しない**（Cycle 1 では AI 機能は Must 対象外。Cycle 2 で PII マスキング設計 — spec §8 R-09）

---

## 4. アクセス制御マトリクス（5ロール × 5主要オブジェクト）

> spec §7 受入基準「アクセス制御マトリクス（5ロール × 5主要オブジェクト）」対応

凡例: ○=閲覧可 / ●=編集可 / ×=不可 / △=一部のみ（要配慮 PII を除く等）

| ロール | 利用者マスタ<br/>（PersonAccount/user_mirror）| 個別支援計画<br/>（SupportPlan）| サービス提供記録<br/>（service_records）| スタッフ・シフト<br/>（staff/shifts）| 請求準備データ<br/>（billing_prep）|
|---|---|---|---|---|---|
| **事業所管理者** | ○● | ○● | ○● | ○● | ○● |
| **サービス管理責任者** | ○●（要配慮含む）| ○● | ○●（全スタッフ分）| ○（参照のみ）| ○（参照のみ）|
| **生活支援員** | △（要配慮 PII 非表示）| ○（参照のみ）| ●（自分の記録のみ）| ○（自分のシフトのみ）| ×（非表示）|
| **シフト管理者** | △（基本情報のみ）| ×（非表示）| ○（参照のみ）| ○● | ×（非表示）|
| **請求担当** | △（受給者証含む）| ×（非表示）| ○（集計参照のみ）| ×（非表示）| ○●（draft→confirmed）|

**実装手段**:
- Salesforce: Profile + Permission Set + FLS（フィールドレベルセキュリティ）+ Sharing Rule（OWD = Private）
- CloudSQL: MySQL ユーザー権限 + Row-Level Security はアプリ層（AppSheet Security Filter / GAS）で担保
- AppSheet: Security Filter 式 + ロールベース View 表示制御（`05-appsheet-tables.md` §7 参照）

---

## 5. 監査ログ要件

> spec §6.Must.8 受入基準「監査ログ要件」対応

### 5.1 CloudSQL 監査ログ（`audit_log` テーブル）

| イベント種別 | 記録タイミング | 記録内容 |
|---|---|---|
| `CREATE` | `service_records` / `user_mirror` 新規 INSERT | before=null, after=新レコード JSON |
| `UPDATE` | `service_records` / `user_mirror` UPDATE | before=変更前 JSON, after=変更後 JSON |
| `DELETE` | 論理削除フラグ変更（物理削除なし）| before=削除前 JSON |
| `APPROVE` | `service_records.is_approved = 1` 変更 | actor=承認者 staff_id |
| `EXPORT` | `exportBillingCSV` 呼出時 | actor=請求担当, event=EXPORT, record_id=billing_year_month |
| `SYNC_SF` | GAS バッチ同期完了時 | actor=gas_batch, event=SYNC_SF, records_processed |
| `AUTH_FAIL` | GAS 認証失敗時 | actor=gas_batch, error_message |

保持期間: **5 年**（法務レビュー要フラグ L-04）  
削除手順: 定期バッチ（年次）で `created_at < NOW() - INTERVAL 5 YEAR` のレコードを物理削除。削除前に外部ストレージ（GCS 等）へのアーカイブ推奨（Cycle 2 で実装）。

### 5.2 Salesforce 監査ログ

| 機能 | 対象 | 保持期間 |
|---|---|---|
| Field History Tracking | `DisabilityType__c`, `RecipientCertNo__c`, `Status__c`（SupportPlan）等 | 18ヶ月（SF 標準）|
| Setup Audit Trail | 設定変更（プロファイル・権限変更等）| 6ヶ月 |
| Event Monitoring（要ライセンス）| ログインイベント・API 呼出 | Cycle 2 で検討 |

---

## 6. 個人情報管理方針

### 6.1 最小化原則

- `billing_prep` テーブルには氏名・障害種別等の PII を含めない（`user_id` FK のみ）
- CloudSQL `user_mirror` は SF PersonAccount の必要最小限の列のみを同期
- GAS バッチは処理に必要な列のみを SOQL で取得（SELECT * を使わない）

### 6.2 保持期間方針

| データ種別 | 保持期間 | 削除方法 | 法務フラグ |
|---|---|---|---|
| サービス提供記録（`service_records`）| 5 年（法務確認要）| 論理削除後に物理削除 | ⚠️ L-04 |
| 請求準備データ（`billing_prep`）| 5 年（法務確認要）| 物理削除 | ⚠️ L-04 |
| 監査ログ（`audit_log`）| 5 年 | 物理削除（アーカイブ後）| ⚠️ L-04 |
| 利用者ミラー（`user_mirror`）| 在籍中 + 退所後 5 年（法務確認要）| `is_active = 0` 後、期間経過で物理削除 | ⚠️ L-04 |
| Salesforce PersonAccount | Salesforce Data Export で別途管理 | SF 側の削除ポリシーに準拠 | ⚠️ L-04 |

### 6.3 本人同意取得（設計上の予防策）

⚠️ **法務レビュー必須項目（spec §8 R-05）**:
- 要配慮個人情報（障害種別等）の収集前に本人から書面同意取得が必要（個人情報保護法）
- 個人情報取扱いの説明・同意取得の手続きは本システムのスコープ外だが、実装前に法務確認が必要
- 同意取得済みフラグを将来的に PersonAccount に追加することを Cycle 2 で検討

---

## 7. インシデント対応方針

| ステップ | 内容 | 担当 |
|---|---|---|
| 1. 検知 | 不審アクセス（`audit_log` の異常 IP / 異常 actor）/ GCP Security Command Center アラート | 事業所管理者 |
| 2. 初期対応 | 対象スタッフ・GAS サービスアカウントのアクセス停止。CloudSQL の疑わしいユーザーを無効化 | 事業所管理者 |
| 3. 影響範囲確認 | `audit_log` で漏洩可能性のあるレコードを特定。PII の種類（要配慮 / 特定機微）を確認 | 事業所管理者 + 担当開発者 |
| 4. 報告義務確認 | 要配慮個人情報が漏洩した場合は個人情報保護委員会への報告義務（72時間以内）が発生しうる ⚠️ | 法務担当 |
| 5. 再発防止 | アクセス制御の見直し・パスワード / API キーのローテーション・GAS 認証の再設定 | 担当開発者 |

---

## 8. 法務レビュー要フラグ一覧（本ファイルで新規追加）

| # | 対象 | フラグ理由 |
|---|---|---|
| L-10 | CMEK 不採用（Cycle 1）| 安全管理措置としての暗号化水準が個人情報保護法ガイドライン要件を満たすかの確認要 |
| L-11 | Claude API 連携（将来）| 要配慮 PII を AI API に送信する場合の法的根拠・委託契約・処理地（US）の確認要（spec §8 R-09）|
| L-12 | `audit_log` 削除バッチ | 保持期間終了後の削除手続きと、削除前アーカイブの要否確認 |

（L-01〜L-09 は `02-data-model.md`, `04-salesforce-objects.md`, `09-operational-runbook.md` に分散して記載。`10-traceability-matrix.md` で全法務フラグを集約）
