---
cycle: "001"
related_spec_sections: ["§6.Must.3", "§6.Must.4", "§6.Must.5", "§4（AppSheet=SoE方針）"]
streams_independent_of: ["03", "04", "06", "09"]
---

# 05. AppSheet テーブル / Slice / View / Action / Bot 構成

> 対応 spec.md: §6.Must.3（サービス提供記録入力）/ §6.Must.4（支給決定残量可視化）/ §6.Must.5（スタッフ・シフト確認）/ §4（SoE としての AppSheet 方針）
>
> **前提**:
> - CloudSQL を主データソース（CRUD）、Salesforce を読取専用参照ソースとして接続（spec §4）
> - AppSheet AppID は未受領（Cycle 1 は「障害福祉現場入力 UI 用の 1 アプリ」前提 — spec §3 / existing-assets.md §1）
> - 楽観ロック: `service_records.updated_at` 比較で同時編集競合を抑止（spec §8 R-08）

---

## 1. データソース接続

| データソース名 | 種別 | 接続先 | 用途 |
|---|---|---|---|
| `WelfareCloudSQL` | Cloud SQL (MySQL) | `welfare_db`（asia-northeast1）| 主データソース — サービス記録・シフト・請求準備等 |
| `WelfareSalesforce` | Salesforce Objects | 本番 SF org | 読取専用 — 利用者マスタ・支給決定情報 |

---

## 2. テーブル定義

### 2.1 service_records（日次サービス提供記録）

> spec §6.Must.3 対応。CloudSQL `service_records` テーブルに接続。

| 列名 | データソース列 | AppSheet 型 | キー | 必須 | 説明 |
|---|---|---|---|---|---|
| `id` | `id` | Number | ○（Row Key）| ○ | 自動採番 |
| `user_id` | `user_id` | Ref(user_mirror) | FK | ○ | 利用者 |
| `staff_id` | `staff_id` | Ref(staff) | FK | ○ | 担当スタッフ |
| `service_id` | `service_id` | Ref(service_master) | FK | ○ | サービス種別 |
| `facility_id` | `facility_id` | Ref(facilities) | FK | ○ | 事業所 |
| `service_date` | `service_date` | Date | - | ○ | 提供日 |
| `start_time` | `start_time` | Time | - | ○ | 開始時刻 |
| `end_time` | `end_time` | Time | - | ○ | 終了時刻 |
| `duration_minutes` | `duration_minutes` | Number | - | ○（App formula）| `(end_time - start_time) × 60`（分）|
| `location_type` | `location_type` | Enum | - | ○ | facility/home/other |
| `location_note` | `location_note` | Text | - | - | 場所補足 |
| `notes` | `notes` | LongText | - | - | 特記事項 |
| `is_approved` | `is_approved` | Yes/No | - | ○ | 承認フラグ |
| `approved_by` | `approved_by` | Ref(staff) | - | - | 承認者 |
| `approved_at` | `approved_at` | DateTime | - | - | 承認日時 |
| `updated_at` | `updated_at` | DateTime | - | ○ | 楽観ロック用（編集時比較）|

**App Formula**:
- `duration_minutes`: `(end_time - start_time) * 60` （AppSheet の Time 差分計算）

**Valid_If（入力制約）**:
- `service_date <= TODAY()` — 未来日付のサービス記録を禁止
- `end_time > start_time` — 終了時刻 > 開始時刻
- シフト衝突チェック（簡易版）: `ISBLANK(SELECT(shifts[id], AND([staff_id]=_thisrow.[staff_id], [shift_date]=_thisrow.[service_date])))` = FALSE（担当スタッフのシフト存在を確認）

---

### 2.2 user_mirror（利用者ミラー）

> Salesforce からの同期テーブル。AppSheet 上では**読取専用**（編集は SF 側で行う）。

| 列名 | データソース列 | AppSheet 型 | キー | 説明 |
|---|---|---|---|---|
| `id` | `id` | Number | ○（Row Key）| CloudSQL 主キー |
| `sf_account_id` | `sf_account_id` | Text | - | Salesforce ID（同期キー）|
| `last_name` | `last_name` | Text | - | 姓 |
| `first_name` | `first_name` | Text | - | 名 |
| `disability_type` | `disability_type` | Text | - | 障害種別（要配慮PII — Security Filter で制限）|
| `recipient_cert_no` | `recipient_cert_no` | Text | - | 受給者証番号（特定機微PII — 非表示 or 管理者のみ）|
| `facility_id` | `facility_id` | Ref(facilities) | FK | 所属事業所 |
| `is_active` | `is_active` | Yes/No | - | 在籍フラグ |

**Security Filter**: `[facility_id] = USERSETTINGS(FacilityId)` — ログインスタッフの事業所に所属する利用者のみ表示。

---

### 2.3 staff（スタッフ）

| 列名 | データソース列 | AppSheet 型 | キー | 説明 |
|---|---|---|---|---|
| `id` | `id` | Number | ○（Row Key）| |
| `last_name` | `last_name` | Text | - | |
| `first_name` | `first_name` | Text | - | |
| `email` | `email` | Email | - | |
| `qualification` | `qualification` | Text | - | 資格区分 |
| `is_active` | `is_active` | Yes/No | - | |

---

### 2.4 shifts（シフト）

| 列名 | データソース列 | AppSheet 型 | キー | 説明 |
|---|---|---|---|---|
| `id` | `id` | Number | ○（Row Key）| |
| `staff_id` | `staff_id` | Ref(staff) | FK | |
| `facility_id` | `facility_id` | Ref(facilities) | FK | |
| `shift_date` | `shift_date` | Date | - | |
| `start_time` | `start_time` | Time | - | |
| `end_time` | `end_time` | Time | - | |
| `shift_type` | `shift_type` | Enum | - | normal/overtime/holiday |

**シフト衝突検出 Valid_If**（spec §6.Must.5 受入基準）:
```
NOT(
  ISBLANK(
    FILTER(shifts,
      AND(
        [staff_id] = _thisrow.[staff_id],
        [shift_date] = _thisrow.[shift_date],
        NOT([id] = _thisrow.[id]),
        OR(
          AND([start_time] <= _thisrow.[start_time], [end_time] > _thisrow.[start_time]),
          AND([start_time] < _thisrow.[end_time], [end_time] >= _thisrow.[end_time])
        )
      )
    )
  )
)
-- エラーメッセージ: 同日に時刻が重複するシフトがすでに登録されています。
```

---

### 2.5 user_allotment_cache（支給決定残量）

> spec §6.Must.4 対応。`v_allotment_usage` ビューを AppSheet から参照。

| 列名 | データソース列 | AppSheet 型 | 説明 |
|---|---|---|---|
| `user_id` | `user_id` | Ref(user_mirror) | 利用者 |
| `service_type` | `service_type` | Text | サービス種別 |
| `allotment_qty` | `allotment_qty` | Decimal | 支給量 |
| `allotment_unit` | `allotment_unit` | Enum | hour/times/day |
| `remaining_qty` | `remaining_qty` | Decimal | **残量（負=超過）**|
| `consumed_hours` | `consumed_hours` | Decimal | 当月消費時間 |
| `valid_from` | `valid_from` | Date | 有効開始日 |
| `valid_to` | `valid_to` | Date | 有効終了日 |

**このテーブルは読取専用**（CloudSQL ビュー `v_allotment_usage` から）。

---

### 2.6 billing_prep（請求準備データ）

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `id` | Number | Row Key |
| `user_id` | Ref(user_mirror) | 利用者 |
| `billing_year_month` | Text | 対象年月 YYYYMM |
| `service_id` | Ref(service_master) | サービス |
| `service_days` | Number | 提供日数 |
| `net_units` | Decimal | 請求単位数 |
| `status` | Enum | draft/confirmed/submitted |

**このテーブルは請求担当ロールのみ Edit 可**（Security Filter + Role-Based Access）。

---

### 2.7 Salesforce 読取テーブル（WelfareSalesforce データソース）

AppSheet は Salesforce コネクタ（OAuth）で以下を参照専用として接続。

| AppSheet テーブル名 | SF オブジェクト | 用途 |
|---|---|---|
| `sf_person_accounts` | `Account`（Person Account）| 利用者基本情報の参照表示 |
| `sf_service_allotments` | `ServiceAllotment__c` | 支給決定情報の参照 |
| `sf_support_plans` | `SupportPlan__c` | 個別支援計画の参照 |

**書き込みは行わない**。AppSheet からの編集は CloudSQL テーブルのみに対して実施。

---

## 3. Slice 定義

### 3.1 sl_my_records（担当スタッフのサービス記録）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `service_records` |
| Row Filter | `[staff_id] = USERSETTINGS(StaffId)` |
| 列 | `id`, `user_id`, `service_date`, `start_time`, `end_time`, `duration_minutes`, `location_type`, `notes`, `is_approved` |
| 用途 | 生活支援員が自分の記録のみを閲覧・入力するビュー用 |

### 3.2 sl_today_shifts（当日シフト）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `shifts` |
| Row Filter | `[shift_date] = TODAY() AND [facility_id] = USERSETTINGS(FacilityId)` |
| 用途 | 当日出勤スタッフの確認 |

### 3.3 sl_overdue_allotment（支給量超過警告）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `user_allotment_cache`（ビュー `v_allotment_usage`）|
| Row Filter | `[remaining_qty] < 0` |
| 用途 | spec §6.Must.4「超過時の警告ルール」— 残量マイナスの利用者を一覧化 |

### 3.4 sl_billing_draft（請求準備 draft 一覧）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `billing_prep` |
| Row Filter | `[status] = "draft"` |
| Security Filter | ロール=請求担当のみ |
| 用途 | 請求担当が確認・承認するドラフト一覧 |

---

## 4. View 定義

| View 名 | 種別 | ソース | 対象ロール | 説明 |
|---|---|---|---|---|
| `HomeView` | Dashboard | 複数テーブル | 全ロール | 今日の予定・未承認記録件数・超過警告件数を表示 |
| `ServiceRecordForm` | Form | `sl_my_records` | 生活支援員 | サービス記録入力フォーム |
| `ServiceRecordList` | Table | `sl_my_records` | 生活支援員・サ管 | 記録一覧（日付フィルタ付き）|
| `UserSearchView` | Table | `user_mirror` | 全ロール | 利用者検索（名前・事業所）|
| `UserDetailView` | Detail | `user_mirror` + SF 参照 | サ管・管理者 | 利用者詳細（支給決定・計画リンク）|
| `AllotmentView` | Table | `user_allotment_cache` | サ管・管理者・請求担当 | 支給決定残量一覧（超過ハイライト）|
| `ShiftView` | Calendar | `shifts` | シフト管理者・全ロール | シフトカレンダー |
| `BillingPrepView` | Table | `sl_billing_draft` | 請求担当 | 請求準備ドラフト一覧 |
| `AuditLogView` | Table | `audit_log` | 管理者のみ | 監査ログ参照 |

---

## 5. Action 定義

| Action 名 | テーブル | 種別 | 説明 |
|---|---|---|---|
| `ApproveServiceRecord` | `service_records` | Data: set column | `is_approved = true`, `approved_by = USERSETTINGS(StaffId)`, `approved_at = NOW()` |
| `CopyShiftToNextWeek` | `shifts` | Data: add rows | 前週シフトを翌週に複製 |
| `ConfirmBilling` | `billing_prep` | Data: set column | `status = "confirmed"` — 請求担当のみ実行可 |
| `ExportBillingCSV` | `billing_prep` | External: open URL | GAS の WebApp エンドポイントを呼び出して CSV 生成をトリガ |

---

## 6. Bot 定義

| Bot 名 | トリガ | 処理 | 説明 |
|---|---|---|---|
| `AllotmentWarningBot` | Scheduled（毎日 8:00 JST）| Notify（スタッフへプッシュ通知）| 支給残量が 10% 以下になった利用者一覧を担当スタッフに通知 |
| `ApprovalReminderBot` | Scheduled（毎日 18:00 JST）| Notify（サ管へ通知）| 当日未承認のサービス記録がある場合に通知 |
| `UnapprovedRecordBot` | On change（service_records is_approved 変更）| Notify | 承認完了時にレコード作成スタッフへ通知 |

---

## 7. Security Filter まとめ

> spec §6.Must.8「AppSheet 層の権限境界」対応。詳細マトリクスは `08-security-and-privacy.md` §4 参照。

| テーブル | Security Filter 式 | 対象外ロール |
|---|---|---|
| `user_mirror` | `[facility_id] = USERSETTINGS(FacilityId)` | 管理者（全件参照）|
| `service_records` | 生活支援員: `[staff_id] = USERSETTINGS(StaffId)` | サ管・管理者（全件参照）|
| `billing_prep` | `USERSETTINGS(Role) = "billing"` | 請求担当以外は非表示 |
| `audit_log` | `USERSETTINGS(Role) = "admin"` | 管理者のみ |
| `user_allotment_cache` | `[facility_id] = USERSETTINGS(FacilityId)` | 管理者 |
