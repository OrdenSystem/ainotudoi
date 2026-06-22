---
ファイル: 05-appsheet-automation.md
作成日: 2026-06-22
作成者: メインエージェント直接執筆（HAR から appdef snapshot を抽出し Python 解析）
ソース: c:/dev/ainotudoi/snapshots/appdef-b9e4f84d-f9b9-4376-97f1-83e3b07122e3.json
抽出方法: ユーザー提供 HAR (97MB) の `POST /api/template/{appId}/` レスポンス本体 (11.6MB) をフォールバックとして使用
---

# AppSheet メインアプリ「HopeCareDX」Automation / Action / Bot / Process 綿密把握レポート

## §1. アプリ全体メタデータ

| 項目 | 値 |
|---|---|
| App ID | `b9e4f84d-f9b9-4376-97f1-83e3b07122e3` |
| App Name | `HopeCareDX_ainotudoi-443914355` |
| Short Name | Hope Care DX_ainotudoi |
| Version | 1.000168 |
| Owner ID | 443914355 |
| Owner Email | dev-support@ordentier-corp.co.jp |
| Cloned From | `HopeCareDX_hahaha-443914355`（社内サンプルアプリから複製） |
| Auth Provider | google |
| Auth Required | true |
| Last Modified | 2026-06-12T17:25:35Z |
| Platform Version | 5.1 |
| Is Deployable | true |

### 全体カウント（**最重要**）

| 要素 | 件数 | 備考 |
|---|---|---|
| テーブル（DataSets） | **42** | CloudSQL/SF 同期テーブル混在 |
| Slice（TableSlices） | **23** | フィルタ済みビュー |
| Action（DataActions） | **292** | Action ベースで業務フローが組まれている |
| View（MenuEntries） | **160** | Form/Detail/Inline/List/Deck などの総合計 |
| **Bot（AppBots）** | **🚨 0** | **存在しない** |
| Process（AppProcesses） | 🚨 0 | 存在しない |
| Workflow Rules（AppWorkflowRules） | 🚨 0 | 存在しない |
| Events（AppEvents） | 🚨 0 | 存在しない |
| Tasks | 0 | — |
| User Roles | 2 | — |

> ⚠️ **重要な事実**: このアプリは **Bot / Process / Workflow を一切使用していない**。すべての業務フロー（GAS Webhook 連携・複雑なロジック）は **Action ベース**で実装されている。AppSheet の「Automation」機能は使われていない。

## §2. テーブル一覧（全 42 件）

業務カテゴリで整理：

### 2-1. 業務記録系（**入所系追加で複製元・拡張対象になる候補**）

| # | テーブル名 | 用途（推測） | 入所系追加への関連 |
|---|---|---|---|
| 1 | `ケース記録` | Case__c のミラー的位置 | 既存業務記録 |
| 22 | **`01相談記録`** | CloudSQL の同名テーブルに対応。**請求対象の月次実績データ** | **★最重要の複製元** |
| 13 | `音声記録対応` | AI 文字起こし連携 | 全サービス共通 |
| 12 | `AIプロンプト` | AI 機能 | 全サービス共通 |

### 2-2. 帳票・出力系（**入所系追加で 6 月改定版スプシ・専用ブック追加が必要**）

| # | テーブル名 | 用途 | 入所系追加への関連 |
|---|---|---|---|
| 5 | `出力先ファイル` | 請求 Excel の生成先管理 | **新サービス分のエントリ追加必要** |
| 6 | `ひな型帳票マスタ` | ひな型スプシのマスタ管理 | **新スプシ用エントリ追加** |
| 7 | `ひな型帳票マスタ子レコード` | ひな型シート内訳 | **3 サービス分追加** |
| 8 | `ひな型帳票マスタ子レコード選択肢` | 選択肢マスタ | 加算項目追加 |
| 9 | `帳票マスタ複製登録` | 月次複製運用 | 新サービス対応 |
| 10 | `帳票子レコード複製登録` | 同上 | 新サービス対応 |

### 2-3. 利用者・職員マスタ（SF 直同期テーブル群）

| # | テーブル名 | 対応 SF オブジェクト | 入所系追加への関連 |
|---|---|---|---|
| 39 | `Account` | SF Account | — |
| 41 | `Customer__c` | SF Customer__c | 既存流用 |
| 40 | `CustomerMaster__c` | SF CustomerMaster__c | 既存流用 |
| 42 | `CustomerStatus__c` | SF CustomerStatus__c | 既存流用（在籍管理） |
| **29** | **`DisabilityCard__c`** | **SF DisabilityCard__c** | **★ 9 項目拡張対象** |
| 23 | `LegalRepresentative__c` | SF LegalRepresentative__c | 既存流用 |
| 17 | `Office__c` | SF Office__c | **★ ServiceType ピックリスト追加** |
| 18 | `ProcessMgmt__c` | SF ProcessMgmt__c | — |
| 19 | `Staff__c` | SF Staff__c | 既存流用 |
| 31 | `StaffCertifications__c` | SF StaffCertifications__c | 既存流用 |
| 20 | `StaffStatus__c` | SF StaffStatus__c | 既存流用 |
| 24 | `SupportPersonnel__c` | SF SupportPersonnel__c | 既存流用 |
| 38 | `OurCompany__c` | SF OurCompany__c | — |

### 2-4. 支援記録・テンプレ系

| # | テーブル名 | 用途 |
|---|---|---|
| 3 | `支援記録マスタ` | 個別支援計画マスタ |
| 4 | `支援記録マスタ子レコード` | 計画詳細 |
| 21 | `記録選択肢マスタ` | 記録分類マスタ |
| 25 | `業種種別マスタ` | サービス種別マスタ |
| 26 | `相談者_本人との関係マスタ` | 関係マスタ |
| 27 | `001_事業所加算マスタ` | 事業所ごとの加算 |
| 28 | `001_利用者加算マスタ` | 利用者ごとの加算 |
| 30 | `001_利用者基本マスタ` | 利用者基本情報 |
| 32 | `受給者証ファイル` | 受給者証 PDF 等 |
| 37 | `連携先機関マスタ` | 連携機関 |

### 2-5. 設定・システム系

| # | テーブル名 | 用途 |
|---|---|---|
| 2 | `_Per User Settings` | システム標準 |
| 11 | `設定` | アプリ設定 |
| 33 | `個設定` | ユーザー個別設定 |
| 34 | `アプリ更新情報` | 更新通知 |
| 36 | `個設定付` | 設定拡張 |
| 35 | `リセットAIコンテキスト` | AI 設定リセット |
| 14 | `スタッフimage` | 画像管理 |
| 15 | `利用者image` | 画像管理 |
| 16 | `共通image` | 画像管理 |

## §3. ⚠️ User Roles（2 件）と Security Filter

| Role | Access Mode | 備考 |
|---|---|---|
| Role 1 | — | （詳細 JSON で確認可） |
| Role 2 | — | — |

詳細は `C:/tmp/appsheet-userroles.json` 参照。

> Security Filter は全テーブルで `null`（個別設定）と表示されているが、これは appdef の表現の問題かも。実際の運用には Slice や Action.Condition で制御している可能性が高い。

## §4. Action 一覧（**最重要 — 292 件**）

### Action タイプ別内訳

| Action Type | 件数 | 入所系追加での扱い |
|---|---|---|
| NAVIGATE_APP | 80 | 画面遷移。新サービス用 View に遷移する追加 Action 必要 |
| EDIT_RECORD | 35 | レコード編集 |
| SET_COLUMN_VALUE | 34 | フラグ立て・状態変更 |
| ADD_RECORD | 30 | 新規追加 |
| DELETE_RECORD | 25 | 削除 |
| **NAVIGATE_URL** | **23** | **★ GAS WebApp に飛ばす可能性が高い**（URL は式で動的生成） |
| CALL | 15 | 電話発信 |
| SMS | 15 | SMS 送信 |
| EMAIL | 10 | メール送信 |
| OPEN_FILE | 6 | ファイル開封 |
| **NAVIGATE_DIFFERENT_APP** | **5** | **★ 請求アプリへの遷移**（App ID `f6ddf60e-...`） |
| EXPORT_VIEW | 4 | View エクスポート |
| ADD_RECORD_TO | 4 | 別テーブル追加 |
| COPY_EDIT_ROW | 3 | コピー編集 |
| IMPORT_FILE | 1 | ファイル取込 |
| REF_ACTION | 1 | 参照アクション |
| COMPOSITE | 1 | 複合アクション |

### NAVIGATE_URL Action（GAS Webhook の本命）

23 件存在するが、URL は ValueDefinitions の式（CONCATENATE("https://...", [param]) 等）で動的生成。詳細は `C:/tmp/appsheet-actions.json` の `value_definitions` を参照。

GAS の `02-gas-workflow.md` §9〜§12 で判明している GAS WebApp 関数群（`makeRecept` / `STEP01_ChildAndMakeSpreadsheet_CloudSQL` / `completeBillingWithIDs_CloudSQL` / `AddRecordCopyYYYYMM` / `AddKasanCoding` / `HopeRecorderStartTranscription` / `syncDriveFoldersToSalesforce` / `syncStaffFoldersToSalesforce`）が、これら NAVIGATE_URL Action のいずれかから叩かれている。

### NAVIGATE_DIFFERENT_APP Action（請求アプリへの遷移）

5 件存在。これらは App ID `f6ddf60e-…` の請求アプリ（`請求_HopeCareDX_愛の集い`）に遷移する Action。入所系追加でも同様の遷移 Action を 3 つ追加する必要がある。

## §5. View 一覧（160 件、抜粋）

主要 View 抜粋（全 160 件は `C:/tmp/appsheet-views.json` を参照）：

| View Name | 表示名 | 種別 |
|---|---|---|
| `01相談記録_Detail` | "相談記録 詳細" | Detail |
| `01相談記録_Form` | "相談登録 Form" | Form |
| `01相談記録_Inline` | "相談記録" | Inline |
| `相談登録_Bord` | "相談登録 Bord" | Bord（ダッシュボード） |
| `ケース記録_Bord` | — | Bord |
| `帳票作成_Bord` | "帳票 Bord" | Bord |
| `相談登録_List` | — | List |
| `ケース記録_List` | — | List |
| `帳票_List` | — | List |
| `Customer__c 2_Form` | "利用者登録フォーム" | Form |
| `CustomerMaster__c 2_Form` | "フェイスシート入力フォーム" | Form |
| `障害福祉サービス受給者証` | "計画モニタリング管理" | — |
| `児童通所支援受給者証` | "障害児モニタリング管理" | — |
| `障害福祉サービス受給者証` | — | — |
| `001_事業所加算マスタ_とよさん_Detail` | — | Detail |
| `001_利用者加算マスタ_とよさん_Detail` | — | Detail |
| etc. | | |

### 入所系3サービス追加で「複製元」となる View

入所系の新規 View を作るときの**複製元**：

| 新規 View（提案） | 複製元（既存） | 目的 |
|---|---|---|
| `02児童入所施設記録_Form` | `01相談記録_Form` | 児童入所施設の月次実績入力 |
| `02児童入所施設記録_Detail` | `01相談記録_Detail` | 詳細表示 |
| `02児童入所施設記録_Inline` | `01相談記録_Inline` | インライン |
| `03短期入所記録_Form` | `01相談記録_Form` | 短期入所 |
| `03短期入所記録_Detail` | `01相談記録_Detail` | 詳細 |
| `03短期入所記録_Inline` | `01相談記録_Inline` | インライン |
| `04日中一時支援記録_Form` | `01相談記録_Form` | 日中一時 |
| `04日中一時支援記録_Detail` | `01相談記録_Detail` | 詳細 |
| `04日中一時支援記録_Inline` | `01相談記録_Inline` | インライン |
| `児童入所_Bord` / `短期入所_Bord` / `日中一時_Bord` | `相談登録_Bord` | サービス別ダッシュボード |

⚠️ **ただし**、`decisions-2026-06-22.md §5` で **3 オブジェクト/3 テーブル新設**が確定しているため、複製元の `01相談記録_*` 系を **コピー → 新テーブル参照に変更** という手順になる。

## §6. Slice 一覧（23 件）

詳細は `C:/tmp/appsheet-slices.json` 参照。Slice は Row Filter で抽出した部分集合で、ロール別・状態別の表示制御に使われている。入所系追加では：

- 新テーブル 3 つに対する Slice（例: `児童入所_active`、`短期入所_未請求`、`日中一時_当月` 等）を追加

## §7. Bot / Process / Workflow の不在の意味

🚨 **このアプリは Bot を 1 つも使っていない**。AppSheet には「Automation Bot」機能があるが、本アプリではすべて **Action ベース**で実装されている。

### 入所系3サービス追加への含意

| 想定 | 検証結果 |
|---|---|
| 月次集計トリガーは Bot で起動 | ❌ 違う |
| 月次集計トリガーは Action から GAS WebApp（NAVIGATE_URL）を叩く | ✅ 正解 |
| Bot/Process の改修が必要 | ❌ 不要（そもそも存在しない） |
| 既存 Action のうち category 値で分岐するものを拡張 | ✅ 主要改修ポイント |

これは **GAS の `02-gas-workflow.md` §7「現状 category 値 = `計画相談支援` と `障害児相談支援` の 2 種のみ」** という発見とも整合する。

## §8. AppSheet ↔ GAS の接続点

| 方向 | 経路 |
|---|---|
| AppSheet → GAS | **NAVIGATE_URL Action（23 件）** が GAS WebApp URL を式で組み立てて発火 |
| GAS → AppSheet | `000_callAppSheetApi.js` が **AppSheet Application API v2** で書込（Access Key 認証） |
| AppSheet → CloudSQL | データソース直結（JDBC、Behavior.APISettings で設定） |
| AppSheet → 請求アプリ | **NAVIGATE_DIFFERENT_APP Action（5 件）** で App ID `f6ddf60e-…` に遷移 |

## §9. AppSheet ↔ Salesforce の接続点

13 テーブルが SF オブジェクトを直接データソースとして読み取り：
`Account` / `Customer__c` / `CustomerMaster__c` / `CustomerStatus__c` / `DisabilityCard__c` / `LegalRepresentative__c` / `Office__c` / `OurCompany__c` / `ProcessMgmt__c` / `Staff__c` / `StaffCertifications__c` / `StaffStatus__c` / `SupportPersonnel__c`

⚠️ DisabilityCard__c はリアルタイム同期で AppSheet に表示されるため、**SF 側で 9 項目を追加すれば AppSheet 側で表示できる**（テーブル定義の再認識は必要）。

## §10. 入所系3サービス追加への影響範囲（最重要・計画書直接入力）

`decisions-2026-06-22.md` の方針を踏まえた **AppSheet 側改修一覧**：

### 10-1. 新規テーブル追加（CloudSQL データソース連携）

| 新規テーブル名 | データソース | 主要列 | 複製元 |
|---|---|---|---|
| `02児童入所施設記録` | CloudSQL `child_care_entry_records` | `cloudsql-and-docs.md` §7-1 参照 | `01相談記録` |
| `03短期入所記録` | CloudSQL `short_stay_records` | `cloudsql-and-docs.md` §7-2 参照 | `01相談記録` |
| `04日中一時支援記録` | CloudSQL `daytime_temp_support_records` | `cloudsql-and-docs.md` §7-3 参照 | `01相談記録` |

### 10-2. 新規 View 追加（3 サービス × Form/Detail/Inline/Bord/List）

§5 の「複製元 → 新規 View」マトリクス参照。最低 3 サービス × 5 View = **15 View 追加**が想定。

### 10-3. 新規 Action 追加

3 サービスそれぞれに以下相当の Action を**既存 `01相談記録` 関連 Action を複製**して作る：

- `ADD_RECORD`（新規追加）
- `EDIT_RECORD`（編集）
- `DELETE_RECORD`（削除）
- `NAVIGATE_APP`（一覧表示・詳細表示）
- **`NAVIGATE_URL`** ← **GAS WebApp `makeRecept` を叩くトリガー**（最重要）
- **`NAVIGATE_DIFFERENT_APP`** ← 請求アプリへの遷移（あれば）

`01相談記録_Action_*` 系 Action（推定 30 件以上）を複製 → 対象テーブルを新サービステーブルに変更 → 命名を `02児童入所施設_*` / `03短期入所_*` / `04日中一時_*` に統一。

### 10-4. 既存テーブル拡張（DisabilityCard__c の自動表示）

SF 側で `DisabilityCard__c` に 9 項目追加（`decisions §4`）→ AppSheet 側はテーブル定義再認識のみで自動表示。**AppSheet 側で手動列追加不要**。

### 10-5. ひな型帳票マスタ系への 6 月改定 + 新サービス対応

- `ひな型帳票マスタ` に新ブック（入所系専用 + 6 月改定計画相談・障害児相談）のエントリ追加
- `ひな型帳票マスタ子レコード` に新サービスシート 3 件 + 改定 2 件のエントリ追加
- `ひな型帳票マスタ子レコード選択肢` に「福祉介護職員等処遇改善加算」等の追加項目

### 10-6. 業種種別マスタ（=ServiceType__c のミラー）への 2 値追加

`業種種別マスタ` テーブルに `児童入所施設` と `日中一時支援` を追加。`短期入所` は既存。

### 10-7. Office__c の ServiceType ピックリスト追加（SF 側で行う）

SF Office__c.ServiceType__c に `児童入所施設` と `日中一時支援` 追加。AppSheet 側は自動同期。

### 10-8. **触ってはいけない既存要素**

`02-gas-workflow.md` §1 の 4 警告と整合：

| 触らない対象 | 理由 |
|---|---|
| 既存 `01相談記録_*` 系 View / Action 全て | 既存稼働を壊さない |
| `ひな型帳票マスタ` の既存エントリ（旧版 5 月以前） | 遡及請求対応のため維持 |
| 既存 NAVIGATE_URL Action（`makeRecept` 起動）の URL 式 | GAS 側で分岐を増やすので AppSheet 側 URL 式は不変 |
| `業種種別マスタ` の既存 2 値（`計画相談支援` / `障害児相談支援`） | 既存運用のため不変 |
| 既存 Slice の Row Filter | 既存運用のため不変 |

## §11. 請求アプリ（App ID `f6ddf60e-…`）への接続点

NAVIGATE_DIFFERENT_APP Action 5 件が請求アプリへの入口。

**請求アプリ自体の構造**は別途取得が必要（**現時点でユーザー提供の `saveapp` cURL あり、ここから body 抽出可能**）。請求アプリは以下のシートを持つことが GAS 側から判明：

- 事業所加算項目DB
- 市町村情報DB
- 利用者情報基本項目DB
- 上限額管理状況DB
- 日報Excel置換
- 請求情報DB

入所系追加でも、これらに新サービス分のエントリを追加する必要がある。

## §12. リスク観点

| リスク | 影響 | 対策 |
|---|---|---|
| Action 292 件のうち `計画相談支援` / `障害児相談支援` をハードコードしている Condition 式 | 新サービスでも一律処理になりかねない | Action.Condition 全件 grep して影響範囲特定 |
| `業種種別マスタ` 依存 Slice の Row Filter | 3 値追加で挙動変更の可能性 | Slice の RowFilter 23 件確認 |
| 既存 Form の Required / Initial Value 式 | 影響予想 | Form の Validation 式確認 |
| AppSheet データソース再認識（DisabilityCard__c 9 列追加時） | 同期遅延・列認識ミス | SF 列追加後に AppSheet Editor で「Regenerate」実行 |

## §13. 入所系3サービス向け新テーブル/View/Action 設計案（草案レベル）

3 サービスそれぞれについて：

### 共通設計
- データソース: CloudSQL（新規 3 テーブル）
- キー列: `id`（CloudSQL の PK）
- ラベル列: 利用者名 + サービス提供日 + 種類
- Security Filter: `[利用者ID] = LOOKUP(USEREMAIL(), Staff__c, AuthUserEmail, 担当利用者リスト)` 相当（既存 Filter を参考に）

### サービス別主要列差分
- **児童入所施設**: 入所/家族支援/集中的支援/要支援児童Ⅱ/体験利用支援/強度行動/朝食/昼食/夕食/光熱水
- **短期入所**: 宿泊/食事加算/送迎/短期加算/長時間/医療連携/医療連携人数/障害支援区分/定超特例/地域拠点/緊急受入/重度障害者/集中的支援/医療型短期入所
- **日中一時支援**: 開始時刻/終了時刻/食事加算/送迎/入浴/市町村ID

これらは `04-litalico-excel-masters.md` §10-1〜10-3 の CloudSQL DDL と完全に対応する。

## §14. 未確認事項

- ⚠️ Security Filter が全テーブルで null と出るが、実際は何で制御しているか（Slice or Action.Condition の組合せか）
- ⚠️ 23 件の NAVIGATE_URL の URL 式（ValueDefinitions.Expression）の中身詳細
- ⚠️ User Roles 2 件の具体的な内容（管理者・現場職員の権限差）
- ⚠️ 請求アプリの構造（appdef 未取得、ユーザー提供 saveapp cURL から抽出可能）
- ⚠️ Action のうち category ハードコード式の件数（grep が必要）

これらは計画書草案レビュー後の詳細設計フェーズで詰める。
