---
cycle: "002"
related_spec_sections: ["§6.Must.1", "§6.Must.3", "§6.Must.4", "§6.Must.5", "§6.Must.10", "§6.Must.11", "§4（AppSheet=SoE方針）", "§4（SoR単一化 C-04）"]
streams_independent_of: ["03", "04", "06", "09"]
---

# 05. AppSheet テーブル / Slice / View / Action / Bot 構成

> 対応 spec.md: §6.Must.1（利用者マスタ参照）/ §6.Must.3（サービス提供記録）/ §6.Must.4（支給決定残量）/ §6.Must.5（スタッフ・シフト）/ §6.Must.10（契約ミラー参照）/ §6.Must.11（上限管理）/ §4（SoE 方針）
>
> **AppSheet App ID**: `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`（HopeCareDX_ainotudoi-443914355）
>
> **Cycle 2 主要変更**:
> - **C-04**: Salesforce コネクタ（`WelfareSalesforce`）を全廃。全 SF 由来データは CloudSQL ミラー経由のみ。
> - **C-05**: Security Filter の `USERSETTINGS()` を全廃。代替: `USEREMAIL() + staff_facility_map` 参照（R9）。
> - **Must.10**: `contract_mirror` テーブルの View 追加。
> - **Must.11**: 上限管理 3 テーブルの View / Slice / Action 追加。

---

## 1. データソース接続（C-04 解消）

| データソース名 | 種別 | 接続先 | 用途 |
|---|---|---|---|
| `WelfareCloudSQL` | Cloud SQL (MySQL) | `welfare_db`（asia-northeast1）| 主データソース — 全テーブルはここを経由 |

> **Salesforce コネクタ（`WelfareSalesforce`）は廃止**（C-04 解消）。AppSheet が Salesforce 直参照と CloudSQL 経路を同時に使う設計は禁止（spec §4）。

---

## 2. テーブル定義

### 2.1 user_mirror（利用者ミラー）— spec §6.Must.1

> CloudSQL `user_mirror` テーブルに接続。**読取専用**（編集は SF 側で行い GAS 同期経由）。
> `recipient_cert_no` は Cloud KMS 暗号化済みバイト列のため、AppSheet App formula で末尾 4 桁マスク表示（C-01）。

| 列名 | AppSheet 型 | キー | 説明 |
|---|---|---|---|
| `id` | Number | ○（Row Key）| CloudSQL 主キー |
| `sf_account_id` | Text | - | Salesforce ID（同期キー）|
| `last_name` | Text | - | 姓 |
| `first_name` | Text | - | 名 |
| `disability_type` | Enum | - | 障害種別（要配慮PII — Security Filter で制限）|
| `recipient_cert_no` | Text | - | 受給者証番号（**AppSheet 表示は末尾4桁マスク** — C-01）|
| `recipient_cert_expiry` | Date | - | 受給者証有効期限 |
| `facility_id` | Ref(facilities) | FK | 所属事業所（facility_id_map.cloudsql_id 解決済み）|
| `is_active` | Yes/No | - | 在籍フラグ |

**App Formula（受給者証番号マスク表示）**:
```
recipient_cert_no_masked: CONCATENATE("***-", RIGHT(recipient_cert_no, 4))
```

**Security Filter（C-05 解消 / USERSETTINGS 廃止）**:
```
[facility_id] IN
  SELECT(staff_facility_map[facility_id],
         [email] = USEREMAIL())
```
> 管理者（`facility_admin`）ロールは Security Filter を適用せず全件参照可。
> ロール判定は `staff_facility_map` からの参照で実施（USERSETTINGS() は使用しない）。

---

### 2.2 staff_facility_map（Security Filter 参照テーブル）— spec §6.Must.8 / C-05

> Security Filter が `USEREMAIL()` と照合する `email` 列を持つ。AppSheet からは読取専用。

| 列名 | AppSheet 型 | キー | 説明 |
|---|---|---|---|
| `id` | Number | ○（Row Key）| |
| `staff_id` | Ref(staff) | FK | スタッフ |
| `facility_id` | Ref(facilities) | FK | 事業所 |
| `email` | Email | - | Security Filter で USEREMAIL() と照合 |
| `primary_flag` | Yes/No | - | 主所属フラグ |
| `end_date` | Date | - | 兼務終了日（NULLは継続）|

---

### 2.3 service_records（日次サービス提供記録）— spec §6.Must.3

| 列名 | AppSheet 型 | キー | 必須 | 説明 |
|---|---|---|---|---|
| `id` | Number | ○（Row Key）| ○ | 自動採番 |
| `user_id` | Ref(user_mirror) | FK | ○ | 利用者 |
| `staff_id` | Ref(staff) | FK | ○ | 担当スタッフ |
| `service_id` | Ref(service_master) | FK | ○ | サービス種別 |
| `facility_id` | Ref(facilities) | FK | ○ | 事業所 |
| `service_date` | Date | - | ○ | 提供日 |
| `shift_date` | Date | - | - | 参照シフト日（夜勤の場合に service_date と異なる）|
| `start_time` | Time | - | ○ | 開始時刻 |
| `end_time` | Time | - | ○ | 終了時刻 |
| `duration_minutes` | Number | - | ○（App formula）| `(end_time - start_time) × 60` |
| `location_type` | Enum | - | ○ | facility / home / other |
| `location_note` | Text | - | - | 場所補足 |
| `notes` | LongText | - | - | 特記事項（要配慮PII）|
| `is_approved` | Yes/No | - | ○ | 承認フラグ |
| `approved_by` | Ref(staff) | - | - | 承認者 |
| `approved_at` | DateTime | - | - | 承認日時 |
| `updated_at` | DateTime | - | ○ | 楽観ロック用 |

**App Formula**:
```
duration_minutes: (end_time - start_time) * 60
```

**Valid_If（入力制約）**:
```
service_date <= TODAY()
  -- 未来日付のサービス記録禁止
end_time <> start_time
  -- 開始時刻と終了時刻が同じ値を禁止
```

---

### 2.4 shifts（シフト）— spec §6.Must.5 / C-07 対応

| 列名 | AppSheet 型 | キー | 説明 |
|---|---|---|---|
| `id` | Number | ○（Row Key）| |
| `staff_id` | Ref(staff) | FK | |
| `facility_id` | Ref(facilities) | FK | |
| `shift_date` | Date | - | シフト開始日 |
| `start_time` | Time | - | 開始時刻 |
| `end_time` | Time | - | 終了時刻（夜勤の場合 start_time > end_time）|
| `is_overnight` | Yes/No | - | **夜勤フラグ（C-07）**: ON で日跨ぎシフト |
| `shift_type` | Enum | - | normal / overnight / holiday |

**シフト衝突検出 Valid_If（spec §6.Must.5）**:
```
NOT(
  ISBLANK(
    FILTER("shifts",
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
```
エラーメッセージ: 同日に時刻が重複するシフトがすでに登録されています。

**夜勤トグル（AppSheet 入力 UI — spec §8 R-12 対応）**:
- `is_overnight` を Yes/No スイッチとして Form View に表示。
- `is_overnight = TRUE` の場合、`end_time < start_time` を許容する旨を UI ヒントで明示。

---

### 2.5 user_allotment_cache（支給決定残量）— spec §6.Must.4 / C-02

> CloudSQL `v_allotment_usage` ビューを AppSheet から参照。**読取専用**。

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `user_id` | Ref(user_mirror) | 利用者 |
| `service_type` | Text | サービス種別 |
| `allotment_qty` | Decimal | 支給量 |
| `allotment_unit` | Enum | hour / times / day |
| `remaining_qty` | Decimal | **当月残量（負=超過 — C-02 解消: 月単位集計）** |
| `consumed_hours` | Decimal | 当月消費時間 |
| `consumed_times` | Decimal | 当月消費回数 |
| `consumed_days` | Decimal | 当月消費日数 |
| `valid_from` | Date | 有効開始日 |
| `valid_to` | Date | 有効終了日 |

**Security Filter（C-05 解消）**:
```
[facility_id] IN
  SELECT(staff_facility_map[facility_id],
         [email] = USEREMAIL())
```

---

### 2.6 billing_prep（請求準備データ）— spec §6.Must.6

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `id` | Number | Row Key |
| `user_id` | Ref(user_mirror) | 利用者 |
| `billing_year_month` | Text | 対象年月 YYYYMM |
| `service_id` | Ref(service_master) | サービス |
| `upper_limit_result_sheet_id` | Ref(upper_limit_result_sheet) | 上限管理結果票参照（Must.11）|
| `service_days` | Number | 提供日数 |
| `net_units` | Decimal | 請求単位数 |
| `adjusted_copayment` | Decimal | 上限管理後利用者負担額（Must.11）|
| `status` | Enum | draft / confirmed / submitted |

**Security Filter（C-05 解消）**:
```
IN(
  USEREMAIL(),
  SELECT(staff_facility_map[email],
         AND([facility_id] = [_thisrow].[facility_id],
             IN(LOOKUP(USEREMAIL(), "staff", "email", "role"),
                LIST("billing_officer", "facility_admin"))))
)
```

---

### 2.7 contract_mirror（契約ミラー）— spec §6.Must.10

> CloudSQL `contract_mirror` テーブルに接続。**読取専用**（SF 側が SoR）。

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `id` | Number | Row Key |
| `user_id` | Ref(user_mirror) | 利用者 |
| `facility_id` | Ref(facilities) | 契約事業所 |
| `contract_start_date` | Date | 契約開始日 |
| `contract_end_date` | Date | 契約終了日 |
| `service_type` | Text | 対象サービス種別 |
| `status` | Enum | draft / active / expired / terminated |
| `has_important_matter_doc` | Yes/No | 重要事項説明書交付済み |
| `has_consent_form` | Yes/No | 同意書取得済み |

**Security Filter（C-05 解消）**:
```
[facility_id] IN
  SELECT(staff_facility_map[facility_id],
         [email] = USEREMAIL())
```

---

### 2.8 上限管理テーブル群（Must.11 / C-03）

#### upper_limit_result_sheet（上限管理結果票）

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `id` | Number | Row Key |
| `user_id` | Ref(user_mirror) | 利用者 |
| `billing_year_month` | Text | 対象年月 YYYYMM |
| `direction` | Enum | sent（発行）/ received（受信）|
| `total_cost_all_facilities` | Decimal | 全事業所合算費用 |
| `own_facility_cost` | Decimal | 当事業所費用 |
| `adjusted_copayment` | Decimal | 調整後利用者負担額 |
| `received_evidence_url` | URL | 受信エビデンスURL（⚠️ L-13）|
| `is_confirmed` | Yes/No | 確認済みフラグ |

#### upper_limit_decision（上限月額決定）

| 列名 | AppSheet 型 | 説明 |
|---|---|---|
| `id` | Number | Row Key |
| `user_id` | Ref(user_mirror) | 利用者 |
| `upper_limit_facility_id` | Ref(upper_limit_facility) | 上限管理事業所 |
| `monthly_upper_limit` | Decimal | 利用者負担上限月額（円）|
| `copayment_type` | Enum | none / family_income_based / flat |
| `valid_from` | Date | 適用開始日 |
| `valid_to` | Date | 適用終了日 |

---

## 3. Slice 定義

### 3.1 sl_my_records（担当スタッフのサービス記録）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `service_records` |
| Row Filter | `[staff_id] = LOOKUP(USEREMAIL(), "staff", "email", "id")` |
| 列 | id, user_id, service_date, start_time, end_time, duration_minutes, location_type, notes, is_approved |
| 用途 | 生活支援員が自分の記録のみを閲覧・入力 |

### 3.2 sl_today_shifts（当日シフト）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `shifts` |
| Row Filter | `[shift_date] = TODAY()` |
| Security Filter | `staff_facility_map` 経由（USEREMAIL() ベース — C-05 解消）|
| 用途 | 当日出勤スタッフ確認 |

### 3.3 sl_overdue_allotment（支給量超過警告）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `user_allotment_cache`（ビュー `v_allotment_usage`）|
| Row Filter | `[remaining_qty] < 0` |
| 用途 | spec §6.Must.4「超過時の警告ルール」— 残量マイナス一覧（C-02 解消: 月単位）|

### 3.4 sl_billing_draft（請求準備 draft 一覧）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `billing_prep` |
| Row Filter | `[status] = "draft"` |
| 用途 | 請求担当が確認・承認するドラフト一覧 |

### 3.5 sl_active_contracts（有効契約一覧）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `contract_mirror` |
| Row Filter | `[status] = "active"` |
| 用途 | 有効な契約 3 点セット確認（Must.10）|

### 3.6 sl_pending_upper_limit（未確認の上限管理結果票）

| 設定項目 | 値 |
|---|---|
| ソーステーブル | `upper_limit_result_sheet` |
| Row Filter | `AND([is_confirmed] = FALSE, [billing_year_month] = TEXT(YEAR(TODAY()), "0000") & TEXT(MONTH(TODAY()), "00"))` |
| 用途 | 当月の未確認結果票一覧（spec §8 R-10）|

---

## 4. View 定義

| View 名 | 種別 | ソース | 対象ロール | 説明 |
|---|---|---|---|---|
| `HomeView` | Dashboard | 複数テーブル | 全ロール | 今日の予定・未承認記録件数・超過警告・未確認上限管理件数 |
| `ServiceRecordForm` | Form | `sl_my_records` | support_worker / service_provider_lead | サービス記録入力 |
| `ServiceRecordList` | Table | `sl_my_records` | 生活支援員・サ管 | 記録一覧（日付フィルタ付き）|
| `UserSearchView` | Table | `user_mirror` | 全ロール | 利用者検索（名前・事業所）|
| `UserDetailView` | Detail | `user_mirror` | service_manager・facility_admin | 利用者詳細（受給者証マスク表示 — C-01）|
| `AllotmentView` | Table | `user_allotment_cache` | service_manager・facility_admin・billing_officer | 支給決定残量（当月単位 — C-02）|
| `ShiftView` | Calendar | `shifts` | シフト管理者・全ロール | シフトカレンダー（夜勤トグル C-07）|
| `BillingPrepView` | Table | `sl_billing_draft` | billing_officer | 請求準備ドラフト一覧 |
| `ContractView` | Table | `sl_active_contracts` | service_manager・facility_admin | 有効契約一覧（Must.10）|
| `UpperLimitResultView` | Table | `upper_limit_result_sheet` | billing_officer・service_manager | 上限管理結果票（Must.11）|
| `UpperLimitDecisionView` | Table | `upper_limit_decision` | billing_officer・facility_admin | 上限月額決定一覧（Must.11）|
| `AuditLogView` | Table | — | facility_admin のみ | 監査ログ（AppSheet からは参照のみ — 管理コンソール推奨）|

---

## 5. Action 定義

| Action 名 | テーブル | 種別 | 説明 |
|---|---|---|---|
| `ApproveServiceRecord` | `service_records` | Data: set column | `is_approved = TRUE`, `approved_by = LOOKUP(USEREMAIL(), "staff", "email", "id")`, `approved_at = NOW()` |
| `CopyShiftToNextWeek` | `shifts` | Data: add rows | 前週シフトを翌週に複製 |
| `ConfirmBilling` | `billing_prep` | Data: set column | `status = "confirmed"` — billing_officer のみ実行可 |
| `ConfirmUpperLimitResult` | `upper_limit_result_sheet` | Data: set column | `is_confirmed = TRUE`, `confirmed_at = NOW()`, `confirmed_by = LOOKUP(USEREMAIL(), "staff", "email", "id")` |
| `ExportBillingCSV` | `billing_prep` | External: open URL | GAS WebApp エンドポイントを呼び出して CSV 生成 |

---

## 6. Bot 定義

| Bot 名 | トリガ | 処理 | 説明 |
|---|---|---|---|
| `AllotmentWarningBot` | Scheduled（毎日 8:00 JST）| Notify | 支給残量が 10% 以下の利用者を担当スタッフに通知 |
| `ApprovalReminderBot` | Scheduled（毎日 18:00 JST）| Notify（サ管へ）| 当日未承認サービス記録がある場合に通知 |
| `UnapprovedRecordBot` | On change（is_approved 変更）| Notify | 承認完了時に記録作成スタッフへ通知 |
| `UpperLimitWarningBot` | Scheduled（月末 5 日前）| Notify（billing_officer へ）| 未確認の上限管理結果票がある場合に通知（spec §8 R-10）|
| `ContractExpiryBot` | Scheduled（毎日 9:00 JST）| Notify（service_manager へ）| 契約満了前 30 日の利用者を通知（Must.10）|

---

## 7. Security Filter まとめ（USERSETTINGS 全廃 — C-05 解消）

> 全テーブルで `USERSETTINGS()` を廃止。代替: `USEREMAIL() + staff_facility_map` 参照（spec §5 R9）。
> grep 検証可能: 本ファイル内に `USERSETTINGS` という文字列は存在しない。

| テーブル | Security Filter 式（USEREMAIL() + staff_facility_map ベース）| 管理者の扱い |
|---|---|---|
| `user_mirror` | `[facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())` | `facility_admin` は全件参照 |
| `service_records` | `[facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())` — 生活支援員は `sl_my_records` Slice でさらに絞込 | `facility_admin` は全件参照 |
| `billing_prep` | `AND([facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL()), IN(LOOKUP(USEREMAIL(), "staff", "email", "role"), LIST("billing_officer", "facility_admin")))` | `facility_admin` は全件 |
| `contract_mirror` | `[facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())` | `facility_admin` は全件 |
| `upper_limit_result_sheet` | `[user_id] IN SELECT(upper_limit_decision[user_id], [upper_limit_facility_id] IN SELECT(upper_limit_facility[id], [is_own_facility] = TRUE))` | `facility_admin` は全件 |
| `shifts` | `[facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())` | `facility_admin` は全件 |

> **重要**: `staff_facility_map` テーブルは CloudSQL 側で行レベル制御。AppSheet Security Filter からの参照は読取のみ。改竄不可（spec §5 R9 / C-05 解消）。
