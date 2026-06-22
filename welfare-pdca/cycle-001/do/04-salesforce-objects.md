---
cycle: "001"
related_spec_sections: ["§6.Must.1", "§6.Must.2", "§4（Salesforce SoR方針）"]
streams_independent_of: ["03", "06", "07", "09"]
---

# 04. Salesforce オブジェクト / 項目定義

> 対応 spec.md: §6.Must.1（利用者マスタ）/ §6.Must.2（個別支援計画）/ §4（Salesforce = SoR）
>
> **前提**: Salesforce Enterprise Edition + Person Account 有効化（spec §3 / tech-research-notes.md R2）。  
> Person Account 有効化は**不可逆**。Cycle 2 着手前にユーザー承認が必要（spec §8 R-07）。  
> **法務レビュー要フラグ** 項目は ⚠️ で明示。

---

## 1. 前提設定

| 設定項目 | 値 | 備考 |
|---|---|---|
| エディション | Enterprise Edition | Health Cloud は Cycle 2 で再評価（spec §8 R-02）|
| Person Account | **有効化必須** | 有効化前にユーザー承認取得（spec §8 R-07）|
| 共有モデル（OWD）| Private（Account/Contact）| 事業所単位の見える範囲制限（spec §3 前提）|
| 監査ログ | Field History Tracking + Event Monitoring | Must.8 対応 |
| API バージョン | v61.0 以降（2026-05 時点最新）| GAS UrlFetchApp 呼び出し時に指定 |

---

## 2. 標準オブジェクト（Person Account = Account + Contact 統合）

Person Account 有効化後、Account レコードが「個人（利用者）」として機能する。  
ContactId と AccountId が同一エンティティに紐付く。

### 2.1 拡張標準項目（Account / Person Account）

> spec §6.Must.1 対応。表示名 / API名 / 型 / 必須 / FLS 方針 / PII区分 を明示。

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 姓 | `LastName` | Text(80) | ○ | 全ロール | 管理者・サ管 | 基本 |
| 名 | `FirstName` | Text(40) | ○ | 全ロール | 管理者・サ管 | 基本 |
| 生年月日 | `PersonBirthdate` | Date | - | 全ロール | 管理者・サ管 | 基本 |
| 住所（番地）| `PersonMailingStreet` | TextArea | - | 全ロール | 管理者・サ管 | 基本 |
| 市区町村 | `PersonMailingCity` | Text(40) | - | 全ロール | 管理者・サ管 | 基本 |
| 都道府県 | `PersonMailingState` | Text(80) | - | 全ロール | 管理者・サ管 | 基本 |
| 携帯電話 | `PersonMobilePhone` | Phone | - | 全ロール | 管理者・サ管 | 基本 |

---

## 3. カスタムオブジェクト一覧

| オブジェクト表示名 | API名（__c）| レコードタイプ | 主な用途 |
|---|---|---|---|
| 利用者マスタ拡張（Person Account カスタム項目群）| — | — | spec §6.Must.1 |
| 個別支援計画 | `SupportPlan__c` | Standard | spec §6.Must.2 |
| 支援目標 | `SupportGoal__c` | Standard | spec §6.Must.2 |
| 支給決定情報 | `ServiceAllotment__c` | Standard | spec §6.Must.1（支給決定）|
| 事業所 | `Facility__c` | Standard | 事業所マスタ |

---

## 4. Person Account カスタム項目定義

> spec §6.Must.1 受入基準「全フィールド名・型・必須/任意・FLS方針が記載」対応

### 4.1 基本情報追加項目

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 姓（フリガナ）| `LastNameKana__c` | Text(40) | - | 全ロール | 管理者・サ管 | 基本 |
| 名（フリガナ）| `FirstNameKana__c` | Text(40) | - | 全ロール | 管理者・サ管 | 基本 |
| 性別 | `Gender__c` | Picklist | - | 全ロール | 管理者・サ管 | 基本 |
| 在籍フラグ | `IsActive__c` | Checkbox | ○ | 全ロール | 管理者・サ管 | - |
| 所属事業所 | `FacilityId__c` | Lookup(Facility__c) | ○ | 全ロール | 管理者 | - |

### 4.2 障害情報項目 ⚠️ 要配慮個人情報

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 障害種別 | `DisabilityType__c` | Picklist | ○ | サ管・管理者 | 管理者・サ管 | **要配慮** ⚠️ |
| 障害等級 | `DisabilityGrade__c` | Text(10) | - | サ管・管理者 | 管理者・サ管 | **要配慮** ⚠️ |
| 障害程度区分 | `DisabilityCategory__c` | Picklist | - | サ管・管理者 | 管理者・サ管 | **要配慮** ⚠️ |

**⚠️ 法務レビューフラグ (L-02)**: 障害種別は個人情報保護法 §2-3「要配慮個人情報」に該当。  
収集時の本人同意取得、第三者提供時の明示的同意が必要。Salesforce FLS で生活支援員（一般）からの参照を制限。

`DisabilityType__c` の選択肢値:
- `physical` / 身体障害
- `intellectual` / 知的障害
- `mental` / 精神障害
- `developmental` / 発達障害
- `other` / その他

### 4.3 受給者証・支給決定項目 ⚠️ 特定機微情報

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 受給者証番号 | `RecipientCertNo__c` | Text(20) | ○ | 管理者・サ管・請求担当 | 管理者・サ管 | **特定機微** ⚠️ |
| 受給者証有効期限 | `RecipientCertExpiry__c` | Date | ○ | 管理者・サ管・請求担当 | 管理者・サ管 | **特定機微** ⚠️ |

**⚠️ 法務レビューフラグ (L-01)**: 受給者証番号は障害者総合支援法上の識別情報。  
最小権限原則に基づき FLS を請求担当・管理者・サ管のみに制限。Field History Tracking を有効化。

### 4.4 緊急連絡先項目

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 緊急連絡先氏名 | `EmergencyContactName__c` | Text(80) | - | 全ロール | 管理者・サ管 | 基本 |
| 緊急連絡先電話番号 | `EmergencyContactPhone__c` | Phone | - | 全ロール | 管理者・サ管 | 基本 |
| 緊急連絡先続柄 | `EmergencyContactRelation__c` | Picklist | - | 全ロール | 管理者・サ管 | 基本 |

---

## 5. SupportPlan__c（個別支援計画）

> spec §6.Must.2 対応

### 5.1 オブジェクト設定

| 設定項目 | 値 |
|---|---|
| API名 | `SupportPlan__c` |
| 表示名（単数）| 個別支援計画 |
| 表示名（複数）| 個別支援計画 |
| 共有モデル（OWD）| Private |
| レポートタイプ | 有効化 |
| Field History Tracking | 有効化（全主要項目）|

### 5.2 項目定義

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| 説明 |
|---|---|---|---|---|---|---|
| 計画番号 | `Name` | AutoNumber | ○（自動）| 全ロール | — | 自動採番 `SP-{0000000}` |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール | 管理者・サ管 | Person Account への参照（spec §6.Must.2 受入基準）|
| 計画開始日 | `PlanStartDate__c` | Date | ○ | 全ロール | 管理者・サ管 | |
| 計画終了日 | `PlanEndDate__c` | Date | ○ | 全ロール | 管理者・サ管 | |
| サービス管理責任者 | `ServiceManager__c` | Lookup(User) | ○ | 全ロール | 管理者・サ管 | |
| モニタリング周期 | `MonitoringCycle__c` | Picklist | ○ | 全ロール | 管理者・サ管 | 月次/2か月/3か月/6か月/12か月 |
| ステータス | `Status__c` | Picklist | ○ | 全ロール | 管理者・サ管 | draft/active/closed |
| 長期目標 | `LongTermGoal__c` | LongTextArea(1000) | - | サ管・管理者 | サ管 | **要配慮PII** ⚠️（支援内容詳細）|
| 短期目標 | `ShortTermGoal__c` | LongTextArea(1000) | - | サ管・管理者 | サ管 | **要配慮PII** ⚠️ |

### 5.3 Validation Rules

```
-- VR-01: 計画終了日 ≥ 計画開始日（spec §6.Must.2 受入基準）
Rule Name: ValidatePlanDateRange
Error Condition Formula: PlanEndDate__c < PlanStartDate__c
Error Message: 計画終了日は計画開始日以降の日付を入力してください。

-- VR-02: active プランの重複禁止（同一利用者で active が複数存在しない）
-- 実装: VLOOKUP による重複チェック または Duplicate Rules（要 Apex Trigger 検討）
Rule Name: PreventDuplicateActivePlan
Error Condition Formula:
  Status__c = 'active' AND
  VLOOKUP($ObjectType.SupportPlan__c.Fields.Status__c, $ObjectType.SupportPlan__c.Fields.PersonAccount__c, PersonAccount__c) = 'active'
Error Message: この利用者にはすでに有効な個別支援計画が存在します。
```

---

## 6. SupportGoal__c（支援目標）

| 表示名 | API名 | 型 | 必須 | 説明 |
|---|---|---|---|---|
| 目標番号 | `Name` | AutoNumber | ○ | 自動採番 `SG-{0000000}` |
| 個別支援計画 | `SupportPlan__c` | MasterDetail(SupportPlan__c) | ○ | 親計画への強参照 |
| 目標タイトル | `GoalTitle__c` | Text(100) | ○ | |
| 目標詳細 | `GoalDetail__c` | LongTextArea(500) | - | **要配慮PII** ⚠️ |
| 達成目標日 | `TargetDate__c` | Date | - | |
| 表示順 | `SortOrder__c` | Number(3,0) | - | AppSheet 表示順制御用 |

---

## 7. ServiceAllotment__c（支給決定情報）

> spec §6.Must.1「支給決定情報」対応。GAS バッチで CloudSQL の `user_allotment_cache` テーブルに同期。

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| PII区分 | 説明 |
|---|---|---|---|---|---|---|
| 支給決定番号 | `Name` | AutoNumber | ○ | 全ロール | - | 自動採番 |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール | - | Person Account 参照 |
| サービス種別 | `ServiceType__c` | Picklist | ○ | 全ロール | - | 生活介護/就B/GH等 |
| 支給量 | `AllotmentQty__c` | Number(6,1) | ○ | 管理者・サ管・請求担当 | **特定機微** ⚠️ | |
| 支給単位 | `AllotmentUnit__c` | Picklist | ○ | 管理者・サ管・請求担当 | - | hour/times/day |
| 有効開始日 | `ValidFrom__c` | Date | ○ | 管理者・サ管・請求担当 | **特定機微** ⚠️ | |
| 有効終了日 | `ValidTo__c` | Date | ○ | 管理者・サ管・請求担当 | **特定機微** ⚠️ | |
| 市区町村福祉事務所 | `WelfareOffice__c` | Text(50) | - | 全ロール | - | 支給決定機関名 |

---

## 8. Facility__c（事業所マスタ）

| 表示名 | API名 | 型 | 必須 | 説明 |
|---|---|---|---|---|
| 事業所名 | `Name` | Text(80) | ○ | 標準 Name 項目 |
| 事業所番号 | `FacilityCode__c` | Text(20) | ○ | 都道府県指定番号（UNIQUE）|
| サービス種別 | `ServiceType__c` | Picklist | ○ | 生活介護/就B/GH等 |
| 都道府県 | `Prefecture__c` | Picklist | ○ | |
| 稼働フラグ | `IsActive__c` | Checkbox | ○ | |
| CloudSQL ID | `CloudSqlFacilityId__c` | Number(18,0) | - | CloudSQL facilities.id（同期後に設定）|

---

## 9. ロール・プロファイル設計方針

> spec §6.Must.8 受入基準「アクセス制御マトリクス」の SF 層対応。  
> 詳細マトリクス（5ロール × 5オブジェクト）は `08-security-and-privacy.md` §4 を参照。

| SF プロファイル / 権限セット名 | 対象ロール | 主なオブジェクト権限 |
|---|---|---|
| `WF_Admin` | 事業所管理者 | 全オブジェクト CRUD + FLS 全参照 |
| `WF_ServiceManager` | サービス管理責任者 | PersonAccount 参照/編集、SupportPlan CRUD、SupportGoal CRUD |
| `WF_SupportWorker` | 生活支援員 | PersonAccount 参照のみ（要配慮 PII は FLS 非表示）|
| `WF_ShiftManager` | シフト管理者 | PersonAccount 参照、Staff/Shift 参照（Salesforce 外で管理）|
| `WF_BillingStaff` | 請求担当 | PersonAccount 参照、ServiceAllotment 参照、請求準備データ 参照 |

---

## 10. Connected App（GAS 連携用）

> spec §4「GAS → Salesforce 連携」/ tech-research-notes.md R3 対応

| 設定項目 | 値 |
|---|---|
| Connected App 名 | `WelfareGASIntegration` |
| OAuth スコープ | `api`, `refresh_token`, `offline_access` |
| 認証フロー | OAuth 2.0 JWT Bearer（サービスアカウント用）|
| IP 制限 | GAS 実行 IP レンジに限定（またはオール許可後に制限強化）|
| Session Policy | Refresh token rotation 有効 |

---

## 11. Field History Tracking 対象項目

> spec §6.Must.8「監査ログ要件」対応（SF 層）

| オブジェクト | 追跡対象項目 |
|---|---|
| PersonAccount（拡張）| `DisabilityType__c`, `RecipientCertNo__c`, `RecipientCertExpiry__c`, `IsActive__c` |
| SupportPlan__c | `Status__c`, `PlanStartDate__c`, `PlanEndDate__c`, `ServiceManager__c` |
| ServiceAllotment__c | `AllotmentQty__c`, `ValidFrom__c`, `ValidTo__c` |

---

## 12. 法務レビュー要フラグ（SF 層）

| # | 対象 | フラグ理由 |
|---|---|---|
| L-01 | `RecipientCertNo__c`, `ValidFrom__c`, `ValidTo__c` | 受給者証情報の収集・管理の法的根拠（障害者総合支援法）確認要 |
| L-02 | `DisabilityType__c`, `DisabilityGrade__c`, `DisabilityCategory__c` | 要配慮個人情報（個人情報保護法 §2-3）の同意取得・管理手続き確認要 |
| L-05 | Person Account 有効化 | 不可逆設定。有効化前に法人としての個人データ管理方針確認要（spec §8 R-07）|
| L-06 | `LongTermGoal__c`, `ShortTermGoal__c`, `GoalDetail__c` | 支援内容詳細は要配慮個人情報に相当しうる。保管・閲覧権限の法務確認要 |
