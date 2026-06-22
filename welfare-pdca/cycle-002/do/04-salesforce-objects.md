---
cycle: "002"
related_spec_sections: ["§6.Must.1", "§6.Must.2", "§6.Must.5", "§6.Must.10", "§6.Must.11", "§4（SoR単一化）"]
streams_independent_of: ["03", "06", "07", "09"]
---

# 04. Salesforce オブジェクト / 項目定義

> 対応 spec.md: §6.Must.1（利用者マスタ）/ §6.Must.2（個別支援計画）/ §6.Must.5（スタッフ）/ §6.Must.10（契約管理）/ §6.Must.11（上限管理）/ §4（Salesforce = SoR）
>
> **前提**: Salesforce Enterprise Edition + Person Account 有効化（spec §3）。
> Person Account 有効化は**不可逆**（spec §8 R-07）。
> Salesforce Shield Platform Encryption は **Cycle 2 では不採用**（R6 / C-18 — tech-research-notes.md R6）。
> CloudSQL 側 CMEK + Application-level 暗号化で代替（C-01 解消）。
> **⚠️ L-17**: Shield 非採用の「適切な安全管理措置」説明責任は法務レビュー必須。

---

## 1. 前提設定

| 設定項目 | 値 | 備考 |
|---|---|---|
| エディション | Enterprise Edition | Health Cloud は Cycle 2 Should で再評価（spec §8 R-02）|
| Person Account | **有効化必須** | 有効化前にユーザー承認取得（spec §8 R-07）|
| 共有モデル（OWD）| Private（Account/Contact）| 事業所単位の見える範囲制限（spec §3 前提）|
| 監査ログ | Field History Tracking + Setup Audit Trail | Must.8 対応 |
| API バージョン | v61.0 以降（2026-05 時点最新）| GAS UrlFetchApp 呼び出し時に指定 |
| Shield Platform Encryption | **不採用（Cycle 2）**| ⚠️ L-17 — 純額 20% コスト増・ROI 不成立。CloudSQL CMEK に集中（C-01） |

---

## 2. System of Record 一覧（C-04 解消）

> AppSheet からの Salesforce 直参照は禁止。全 SF 由来データは CloudSQL ミラー経由のみ（spec §4）。

| SF オブジェクト | SoR 指定 | CloudSQL ミラー / キャッシュ |
|---|---|---|
| PersonAccount | **Salesforce（SoR）** | `user_mirror`（読取専用キャッシュ）|
| ServiceAllotment__c | **Salesforce（SoR）** | `user_allotment_cache`（月次キャッシュ）|
| IndividualSupportPlan__c | **Salesforce（SoR）** | `support_plan_mirror`（将来 Cycle 3 実装）|
| ServiceContract__c（新規） | **Salesforce（SoR）** | `contract_mirror`（読取専用キャッシュ）|
| Facility__c | **Salesforce（SoR）** | `facility_id_map`（ID 変換のみ — C-06）|

---

## 3. カスタムオブジェクト一覧

| オブジェクト表示名 | API名（__c）| レコードタイプ | 主な用途 |
|---|---|---|---|
| 個別支援計画 | `IndividualSupportPlan__c` | Standard | spec §6.Must.2（C-08 親子構造）|
| アセスメント | `Assessment__c` | Standard | spec §6.Must.2（IndividualSupportPlan の子）|
| モニタリング記録 | `MonitoringRecord__c` | Standard | spec §6.Must.2（IndividualSupportPlan の子）|
| サービス担当者会議 | `CarePlanMeeting__c` | Standard | spec §6.Must.2（IndividualSupportPlan の子）|
| 支給決定情報 | `ServiceAllotment__c` | Standard | spec §6.Must.1（支給決定）|
| 事業所 | `Facility__c` | Standard | 事業所マスタ（C-06 の SoR）|
| 契約書 | `ServiceContract__c` | Standard | spec §6.Must.10（新規）|
| 重要事項説明書 | `ImportantMatterDocument__c` | Standard | spec §6.Must.10（新規）|
| 同意書 | `ConsentForm__c` | Standard | spec §6.Must.10（新規）|

---

## 4. Person Account カスタム項目定義（spec §6.Must.1 対応）

### 4.1 基本情報項目

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

**⚠️ L-02**: 障害種別は個人情報保護法 §2-3「要配慮個人情報」。収集時の本人同意取得要。

**`DisabilityType__c` 選択肢値（CloudSQL ENUM との対応 — C-14 解消）**:

| 表示名 | API値（SF）| CloudSQL ENUM 値 |
|---|---|---|
| 身体障害 | `physical` | `physical` |
| 知的障害 | `intellectual` | `intellectual` |
| 精神障害 | `mental` | `mental` |
| 発達障害 | `developmental` | `developmental` |
| その他 | `other` | `other` |

### 4.3 受給者証・支給決定項目 ⚠️ 特定機微情報

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 受給者証番号 | `RecipientCertNo__c` | Text(20) | ○ | 管理者・サ管・請求担当 | 管理者・サ管 | **特定機微** ⚠️ |
| 受給者証有効期限 | `RecipientCertExpiry__c` | Date | ○ | 管理者・サ管・請求担当 | 管理者・サ管 | **特定機微** ⚠️ |

**⚠️ L-01**: 受給者証番号は最小権限原則に基づき FLS 制限。Field History Tracking 有効化必須。
CloudSQL 側では **Cloud KMS Application-level 暗号化**で保護（C-01 解消 — `AES_ENCRYPT` 廃止）。

### 4.4 緊急連絡先項目

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）| PII区分 |
|---|---|---|---|---|---|---|
| 緊急連絡先氏名 | `EmergencyContactName__c` | Text(80) | - | 全ロール | 管理者・サ管 | 基本 |
| 緊急連絡先電話番号 | `EmergencyContactPhone__c` | Phone | - | 全ロール | 管理者・サ管 | 基本 |
| 緊急連絡先続柄 | `EmergencyContactRelation__c` | Picklist | - | 全ロール | 管理者・サ管 | 基本 |

---

## 5. IndividualSupportPlan__c（個別支援計画）— spec §6.Must.2 / C-08 対応

> Cycle 1 の `SupportPlan__c` を `IndividualSupportPlan__c` に改名し、子エンティティ 3 種を追加（C-08）。

### 5.1 オブジェクト設定

| 設定項目 | 値 |
|---|---|
| API名 | `IndividualSupportPlan__c` |
| 共有モデル（OWD）| Private |
| Field History Tracking | 有効化 |

### 5.2 項目定義

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）|
|---|---|---|---|---|---|
| 計画番号 | `Name` | AutoNumber | ○（自動）| 全ロール | — |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール | 管理者・サ管 |
| 計画開始日 | `PlanStartDate__c` | Date | ○ | 全ロール | 管理者・サ管 |
| 計画終了日 | `PlanEndDate__c` | Date | ○ | 全ロール | 管理者・サ管 |
| サービス管理責任者 | `ServiceManager__c` | Lookup(User) | ○ | 全ロール | 管理者・サ管 |
| モニタリング周期 | `MonitoringCycle__c` | Picklist | ○ | 全ロール | 管理者・サ管 |
| ステータス | `Status__c` | Picklist | ○ | 全ロール | 管理者・サ管 |
| 長期目標 | `LongTermGoal__c` | LongTextArea(1000) | - | サ管・管理者 | サ管 |
| 短期目標 | `ShortTermGoal__c` | LongTextArea(1000) | - | サ管・管理者 | サ管 |

### 5.3 Validation Rules

```
VR-01: 計画終了日 ≥ 計画開始日
Rule Name: ValidatePlanDateRange
Error Condition Formula: PlanEndDate__c < PlanStartDate__c
Error Message: 計画終了日は計画開始日以降の日付を入力してください。

VR-02: 同一利用者の重複 active 計画禁止（C-15 解消: SOQL ベース）
実装推奨: Apex Trigger（BeforeInsert / BeforeUpdate）
  Trigger 処理例:
    List<IndividualSupportPlan__c> overlapping = [
      SELECT Id FROM IndividualSupportPlan__c
      WHERE PersonAccount__c = :newPlan.PersonAccount__c
        AND Status__c = 'active'
        AND Id != :newPlan.Id
        AND PlanStartDate__c <= :newPlan.PlanEndDate__c
        AND PlanEndDate__c   >= :newPlan.PlanStartDate__c
    ];
    if (!overlapping.isEmpty()) {
      newPlan.addError('同一利用者の計画期間が重複しています。既存の active 計画を確認してください。');
    }
```

### 5.4 `MonitoringCycle__c` 選択肢値

| 表示名 | API値 |
|---|---|
| 月次 | `monthly` |
| 2か月 | `bimonthly` |
| 3か月 | `quarterly` |
| 6か月 | `semiannual` |
| 12か月 | `annual` |

---

## 6. Assessment__c（アセスメント）— spec §6.Must.2 / C-08 対応

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール |
| 個別支援計画 | `IndividualSupportPlan__c` | MasterDetail(IndividualSupportPlan__c) | ○ | 全ロール |
| 実施日 | `AssessmentDate__c` | Date | ○ | 全ロール |
| 担当者 | `Assessor__c` | Lookup(User) | ○ | サ管・管理者 |
| ニーズ分析 | `NeedsAssessment__c` | LongTextArea(2000) | ○ | サ管・管理者 |
| 環境因子 | `EnvironmentalFactors__c` | LongTextArea(1000) | - | サ管・管理者 |
| ステータス | `Status__c` | Picklist | ○ | 全ロール |

**実地指導減算リスク対応**: `Status__c = 'finalized'` のアセスメントが個別支援計画に紐付いていない場合、GAS バッチ `checkRecordCompleteness` で警告ログを `audit_log` に記録（spec §3 法令前提）。

---

## 7. MonitoringRecord__c（モニタリング記録）— spec §6.Must.2 / C-08 対応

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール |
| 個別支援計画 | `IndividualSupportPlan__c` | MasterDetail(IndividualSupportPlan__c) | ○ | 全ロール |
| 実施日 | `MonitoringDate__c` | Date | ○ | 全ロール |
| 実施者 | `MonitoringBy__c` | Lookup(User) | ○ | サ管・管理者 |
| 目標達成状況 | `GoalProgress__c` | LongTextArea(1000) | ○ | サ管・管理者 |
| 次回予定日 | `NextMonitoringDate__c` | Date | ○ | 全ロール |
| 計画見直し要否 | `PlanRevisionNeeded__c` | Checkbox | ○ | 全ロール |

---

## 8. CarePlanMeeting__c（サービス担当者会議）— spec §6.Must.2 / C-08 対応

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール |
| 個別支援計画 | `IndividualSupportPlan__c` | MasterDetail(IndividualSupportPlan__c) | ○ | 全ロール |
| 会議日 | `MeetingDate__c` | Date | ○ | 全ロール |
| 参加者 | `Attendees__c` | LongTextArea(500) | ○ | 全ロール |
| 議題 | `Agenda__c` | LongTextArea(1000) | - | 全ロール |
| 議事録 | `Minutes__c` | LongTextArea(2000) | ○ | サ管・管理者 |

---

## 9. ServiceAllotment__c（支給決定情報）— spec §6.Must.1 対応

> **SoR = Salesforce**。AppSheet は CloudSQL `user_allotment_cache` 経由でのみ参照（C-04）。

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| PII区分 |
|---|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール | - |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール | - |
| サービス種別 | `ServiceType__c` | Picklist | ○ | 全ロール | - |
| 支給量 | `AllotmentQty__c` | Number(6,1) | ○ | 管理者・サ管・請求担当 | **特定機微** |
| 支給単位 | `AllotmentUnit__c` | Picklist | ○ | 管理者・サ管・請求担当 | - |
| 有効開始日 | `ValidFrom__c` | Date | ○ | 管理者・サ管・請求担当 | **特定機微** |
| 有効終了日 | `ValidTo__c` | Date | ○ | 管理者・サ管・請求担当 | **特定機微** |
| 負担上限管理期間（開始）| `CopaymentLimitPeriodFrom__c` | Date | - | 管理者・サ管・請求担当 | - |
| 負担上限管理期間（終了）| `CopaymentLimitPeriodTo__c` | Date | - | 管理者・サ管・請求担当 | - |

---

## 10. ServiceContract__c（契約書）— spec §6.Must.10 対応（新規）

> ⚠️ L-14 法務レビュー必須: 利用者署名の電子化には電子署名法の確認が必要。

### 10.1 オブジェクト設定

| 設定項目 | 値 |
|---|---|
| API名 | `ServiceContract__c` |
| 共有モデル（OWD）| Private |
| Field History Tracking | 有効化（Status__c, ContractEndDate__c） |

### 10.2 項目定義

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）| FLS（編集）|
|---|---|---|---|---|---|
| 契約番号 | `Name` | AutoNumber | ○ | 全ロール | — |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール | 管理者・サ管 |
| 契約開始日 | `ContractStartDate__c` | Date | ○ | 全ロール | 管理者・サ管 |
| 契約終了日 | `ContractEndDate__c` | Date | - | 全ロール | 管理者・サ管 |
| サービス種別 | `ServiceType__c` | Picklist | ○ | 全ロール | 管理者・サ管 |
| 対象事業所 | `FacilityId__c` | Lookup(Facility__c) | ○ | 全ロール | 管理者・サ管 |
| ステータス | `Status__c` | Picklist | ○ | 全ロール | 管理者・サ管 |
| 署名日 | `SignedDate__c` | Date | - | 管理者・サ管 | 管理者 |
| 書類URL | `DocumentUrl__c` | URL | - | 管理者・サ管 | 管理者 |

**`Status__c` 選択肢値**: `draft` / `active` / `expired` / `terminated`

### 10.3 Validation Rules

```
VR-CT-01: 契約終了日 ≥ 契約開始日（NULLは許可）
Error Condition: ContractEndDate__c != null && ContractEndDate__c < ContractStartDate__c
Error Message: 契約終了日は契約開始日以降の日付を入力してください。

VR-CT-02: active 契約は重要事項説明書・同意書の存在が前提（GAS バッチで月次チェック）
```

### 10.4 ワークフロー / 自動化

**契約満了前 30 日アラート（Process Builder / Flow）**:
- 対象: `Status__c = 'active'` かつ `ContractEndDate__c != null`
- 条件: `ContractEndDate__c <= TODAY() + 30`
- 実行: GAS バッチ `checkContractExpiry` が日次で検出し、担当者（ServiceManager__c）に通知

---

## 11. ImportantMatterDocument__c（重要事項説明書）— spec §6.Must.10 対応（新規）

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール |
| 対応契約書 | `ServiceContract__c` | Lookup(ServiceContract__c) | ○ | 全ロール |
| 説明実施日 | `ExplainedDate__c` | Date | ○ | 全ロール |
| 説明担当者 | `ExplainedBy__c` | Lookup(User) | ○ | 全ロール |
| 利用者確認日 | `AcknowledgedDate__c` | Date | - | 全ロール |
| 書類バージョン | `DocumentVersion__c` | Text(10) | ○ | 全ロール |
| 書類URL | `DocumentUrl__c` | URL | - | 管理者・サ管 |

---

## 12. ConsentForm__c（同意書）— spec §6.Must.10 対応（新規）

> ⚠️ L-14 法務レビュー必須: 個人情報取扱同意は書面または電磁的記録での取得が前提。

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| レコード名 | `Name` | AutoNumber | ○ | 全ロール |
| 利用者 | `PersonAccount__c` | Lookup(Account) | ○ | 全ロール |
| 対応契約書 | `ServiceContract__c` | Lookup(ServiceContract__c) | ○ | 全ロール |
| 同意種別 | `ConsentType__c` | Picklist | ○ | 全ロール |
| 同意日 | `ConsentDate__c` | Date | ○ | 管理者・サ管 |
| 署名者氏名 | `SignedBy__c` | Text(80) | ○ | 管理者・サ管 |
| 同意撤回フラグ | `IsRevoked__c` | Checkbox | ○ | 管理者・サ管 |
| 撤回日 | `RevokedDate__c` | Date | - | 管理者 |

**`ConsentType__c` 選択肢値**: `personal_info` / `service_content` / `emergency_response` / `photo_video` / `other`

---

## 13. Facility__c（事業所）— spec §4「Facility マスタ連携」/ C-06 対応

> **SoR = Salesforce**。CloudSQL `facility_id_map` で Salesforce ID ↔ CloudSQL ID を解決（C-06）。

| 表示名 | API名 | 型 | 必須 | FLS（閲覧）|
|---|---|---|---|---|
| 事業所番号 | `FacilityCode__c` | Text(20) | ○ | 全ロール |
| 事業所名 | `Name` | Text(80) | ○ | 全ロール |
| サービス種別 | `ServiceType__c` | Picklist | ○ | 全ロール |
| 都道府県 | `Prefecture__c` | Picklist | ○ | 全ロール |
| 稼働フラグ | `IsActive__c` | Checkbox | ○ | 全ロール |

**GAS `syncFacilitiesFromSF` が `facility_id_map` を更新**（C-06 解消 — `06-gas-integrations.md` §8 参照）。

---

## 14. 法務レビュー要フラグ一覧（本ファイル内）

| # | 対象 | フラグ理由 |
|---|---|---|
| L-01 | `RecipientCertNo__c` | 障害者総合支援法上の識別情報。最小権限原則と保管根拠確認要 |
| L-02 | `DisabilityType__c` 等 | 個人情報保護法 §2-3 要配慮個人情報。本人同意取得手続き確認要 |
| L-14 | `SignedDate__c`（契約書）/ `ConsentDate__c`（同意書）| 電子署名法・サービス提供責任者要件の確認要 |
| L-17 | Salesforce Shield 非採用 | 「適切な安全管理措置」説明責任。DPO / 監査法人レビュー要 |
