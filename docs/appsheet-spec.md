# AppSheet 仕様ハンドブック

> **位置づけ**: `appsheet-mcp` のツール群と、`.claude/agents/` 配下のサブエージェントが共通参照する**北極星ドキュメント**。AppSheet の公式ドキュメントが薄い領域（内部 API・loadApp/saveapp の JSON 構造・式言語の挙動）を、HAR と実スナップショットから検証した一次情報で補完する。
>
> **対象読者**: Claude Code（人間ではなく LLM）が読む前提で書いている。各章末の「実装メモ」は MCP のどのツールが該当領域を扱うかの索引。

---

## 1. このドキュメントの位置づけ

### 1.1 なぜ必要か

AppSheet は GUI 中心のローコードプラットフォームで、Salesforce / GCP のような公式 Metadata API を持たない。Claude Code から自動操作するには以下の 2 つを併用する：

| 経路 | 認証 | 用途 | 安定度 |
|------|------|------|--------|
| **Application API v2** | Application Access Key | データ CRUD・Action 実行 | 公式・安定 |
| **内部 API** (`/api/loadApp`, `/api/saveapp`) | ブラウザ Cookie | アプリ定義の取得・書込 | 非公式・実験的 |

データ層は公式 API で済むが、**メタ層（テーブル設計・式・View・Bot）は内部 API しか手段がない**。本書はその内部 API の挙動を文書化する。

### 1.2 公式ドキュメントとの関係

公式が一次資料な領域：式関数の意味論、UI 機能の仕様、API v2 のリクエスト形式。

本書が一次資料な領域：

- loadApp / saveapp のリクエスト/レスポンス JSON スキーマ
- アプリ定義の 48 トップレベルキー
- ComponentId・`_isNew` などの内部規約
- 同名テーブル長さ衝突等の OpenAPI 既知バグ
- Cookie 失効・Bot 4 配列リンク等の実装上のハマり所

### 1.3 用語の規約

- **アプリ定義 (App Definition)**: `/api/loadApp/<App名>` が返す全 JSON。saveapp では「丸ごと置換型」で送り返す。
- **エンティティ (Entity)**: アプリ定義の中の一個の構成要素（Schema 1 件、Action 1 件、View 1 件、Bot 1 件 等）。すべて `ComponentId` を持つ。
- **コンポーネント (Component)**: AppSheet 内部用語。本書の「エンティティ」とほぼ同義。`ComponentId` の "Component" はこれ。
- **MCP ツール**: 本リポジトリの `appsheet_*` ツール。本書末尾の「実装メモ」で対応関係を示す。

---

## 2. アプリ定義の全体構造

### 2.1 48 トップレベルキー

`/api/loadApp/<App名>` の `appJson` を JSON.parse すると 48 のトップレベルキーが現れる。分類すると：

| 分類 | キー | 役割 |
|------|------|------|
| **メタ識別** | `Id`, `ShortName`, `Name`, `Title`, `Description`, `OwnerId`, `OriginalOwnerId`, `Version`, `StableVersion`, `PlatformVersion`, `SubsystemVersionConfig`, `DateCreated`, `LastModified`, `LastDataModified`, `NumEdits` | アプリの ID とバージョン |
| **公開・運営** | `IsPublic`, `IsTeamPublic`, `UsePublicOwner`, `Visibility`, `IsRunnable`, `IsDeployable`, `IsPersonal`, `Status`, `Category`, `Department`, `Industry`, `Tags`, `PrivacyPolicy`, `TermsOfUse`, `DesignComments` | デプロイ状態と分類 |
| **ライセンス** | `HasValidPlan`, `PlanViolationLevel`, `OwnerInPremiumPlan`, `OwnerSubscription`, `RunnableCheckDate` | プラン整合性 |
| **クローン情報** | `CloneFrom`, `CloneFromVersion`, `DefnFolderName` | 元アプリ参照 |
| **★ Presentation** | `Presentation` (オブジェクト) | View・テーマ・MenuEntries |
| **★ Behavior** | `Behavior` (オブジェクト) | Action・Bot・Workflow・認証 |
| **★ AppData** | `AppData` (オブジェクト) | Schema・DataSet・Slice・Action 定義本体 |
| **その他** | `UserRoles`, `ExprLookup`, `IsValid`, `DisableAutoUpdate`, `ComponentId`, `PercentOnLatestVersion` | 雑多 |

実装の重心は **`Presentation` / `Behavior` / `AppData` の 3 つ**。saveapp で送る差分もほぼここに集中する。

### 2.2 `AppData` の中身

データレイヤの本体。

```
AppData
├── DataSets[]       テーブルとデータソース（SQL/Spreadsheet/AppSheet DB 等）の紐付け
├── DataSchemas[]    列定義の集合（Attributes[] が列の配列）
├── TableSlices[]    Slice 定義
├── DataActions[]    Action 定義（種別・式・対象列）
├── ExpressionSettings  式評価の全体設定
└── IsValid / Visibility / DisableAutoUpdate / ComponentId / ExprLookup
```

**重要**: テーブルは `DataSets` と `DataSchemas` の **2 箇所に分散**している。`DataSet.SchemaName` と `Schema.Name` で名前リンク。テーブルを 1 個増やすには両方への追加が必要。

### 2.3 `Behavior` の中身

振る舞いとセキュリティ。

```
Behavior
├── AppBots[]              Bot 定義
├── AppEvents[]            Bot のトリガー（テーブル + 条件）
├── AppProcesses[]         Bot の処理フロー
├── Tasks[]                個別タスク（Send Email / Call a Script / Run Action 等）
├── WorkflowRules[]        旧 Workflow（Bot の前世代）
├── AppWorkflowRules[]     Workflow 拡張
├── AppPredictiveModels[]  ML モデル
├── AppOcrModels[]         OCR モデル
├── ChatbotSettings        Chatbot 設定
├── APISettings            API 公開設定
├── IFrameSettings         Embed 設定
├── ExternalServiceSettings 外部サービス連携
├── AssistantSettings      Assistant
├── 認証関連: AuthRequired, AuthProvider, AuthDomain, AuthGroups, AllDataIsPublic, ...
├── 同期関連: DisableCaching, EnableCaching, DelayedSync, DeltaSync, SyncOnStart, ...
└── セキュリティ: EncryptLocalData, SecurePDFAccess, SecureImageAccess, RequireUserConsent, TreatAllDataAsPII, ...
```

**重要**: Bot は **AppBots / AppEvents / AppProcesses / Tasks の 4 配列に分散**して名前文字列でリンクする。クローンや削除では 4 配列同時に操作する必要がある（→ §5.3）。

### 2.4 `Presentation` の中身

UI 層。

```
Presentation
├── Controls[]         View 定義（deck/table/detail/form/dashboard/onboarding/...）
├── MenuEntries[]      左メニューの並び
├── FormatRules[]      条件付き書式
├── ActionNameMappings  Action 表示名マッピング
├── テーマ系: DisplayTheme, FontSize, FontFamily, FormPageStyle, FormStyle, ...
├── 表示系: ShowColumnNames, ShowLogoOnLaunch, HorizontalScrolling, ShowColumnsInOrder, ...
├── 写真・地図: PhotoResolution, MapPinMax, AllowGalleryAccess, AllowLatLongOverride, ...
├── スライドショー: SlideshowDisplayMode, SlideshowImageStyle, ...
├── 起動: DefaultStartView, StartWithAbout
├── ヘッダ/フッタ: HeaderStyle, FooterStyle, ShowViewNameInHeader, FiveButtonFooter, ...
└── その他: EnableFeedback, EnableAssistant, AgenticApps
```

**注意**: AppSheet 用語の "View" は本 JSON 上では `Controls[]` の要素として表現される。`ActionType` フィールドが View タイプを示す（`detail` / `table` / `deck` / `form` / `dashboard` / `onboarding` / `chart` / `calendar` / `map` / `gallery`）。

### 2.5 `ComponentId` と `_isNew`

すべてのエンティティ（Schema・Column・DataSet・Slice・Action・View・Bot・Event・Process・Task）は 26 文字の base32 風 `ComponentId` を持つ。これはクライアント生成（GUID 風）で、saveapp 時に新規エンティティを送るには必ず付与する。

新規エンティティを追加する場合：

```json
{
  "_isNew": true,
  "ComponentId": "01J9KZX5N0R8M2P3V4W5Y6T7Q8",
  "Name": "新規テーブル"
}
```

`_isNew: true` を付け忘れると、AppSheet 側は「既存エンティティの更新」と解釈し、`ComponentId` 不一致で無視するか 500 を返す。

### 2.6 `IsValid` / `Visibility` / `DisableAutoUpdate` / `ExprLookup`

各エンティティ（およびトップレベル）に共通でぶら下がる 4 兄弟：

| キー | 用途 |
|------|------|
| `IsValid` | 式評価が通っているか。saveapp 後の verify でこれを見る |
| `Visibility` | 表示制御（`Visible` / `Hidden`）。Editor 用 |
| `DisableAutoUpdate` | 自動更新の抑制 |
| `ExprLookup` | 式参照のキャッシュ。読み取り専用 |

これらは多くの場合 saveapp で省略しても AppSheet 側がデフォルト値を入れてくれる。

### 2.7 saveapp の「丸ごと置換型」

最重要事項。`/api/saveapp` は **アプリ定義丸ごと（appJson に full JSON 文字列）を送り返す** API。差分送信ではない。

帰結：

1. **競合検知の責務はクライアント側**。複数人が同時編集すると後勝ちで上書きされる。
2. **送り返すデータが 1 件でも欠けると、その分が削除される**。loadApp で取得した完全 JSON を起点に、必要箇所だけ書き換えて全体を送る運用が必須。
3. **レスポンスに更新後 App を含む**。post-fetch（saveapp 後の loadApp 再取得）は不要で、レスポンスの `App` を verify に使うほうが eventual consistency を回避できる。

実装メモ: [src/tools/edit.ts](../src/tools/edit.ts) 全般、特に `runSaveApp()` ヘルパが verify ロジックを持つ。

---

## 3. データレイヤ

### 3.1 データソース種別

`DataSet.SourceType` で識別：

| SourceType | 実体 | 適性 |
|------------|------|------|
| `Cloud Database` | SQL（MySQL/PostgreSQL/SQL Server/BigQuery） | **業務データの基本**。蓄積・トランザクション系 |
| `Google` (Spreadsheet) | Google スプレッドシート | ユーザー設定画面・少量マスタ・Excel 出力連携 |
| `AppSheet` (AppSheet DB) | AppSheet 内蔵 DB | マスタ共有・複数アプリ間で共通参照したいデータ |
| `Excel` | OneDrive/Dropbox 上の xlsx | 既存資産の取り込み |
| `Salesforce` | SOQL 経由 | Salesforce 連携 |
| `SmartSheet` | Smartsheet API | プロジェクト管理連携 |

**選択指針** (詳細は `appsheet-best-practices.md` §データ量とデータソース)：

- 蓄積系・行が増え続ける → **SQL**
- ユーザー設定・少量・人間が直接編集したい → **Spreadsheet**
- マスタ・複数アプリ共通 → **AppSheet DB**
- スプシは Enterprise でも数万行で詰まりやすい

### 3.2 テーブル: `DataSet` × `DataSchema`

テーブル 1 個は **`DataSets[]` の 1 要素 + `DataSchemas[]` の 1 要素** の組で表現される。`DataSet.SchemaName === Schema.Name` でリンクする。

`DataSet` の主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name` | テーブル名（アプリ内一意） |
| `SchemaName` | リンクする Schema 名（通常は Name と同じ） |
| `SourceType`, `Source`, `SourcePath`, `SourceQualifier` | データソース指定 |
| `DataSourceName` | AppSheet 内のデータソースの名前（接続設定の参照） |
| `AllowedUpdates` | `Adds`, `Updates`, `Deletes`, `ReadOnly` の組み合わせ |
| `UpdateMode` | `Updateable` / `ReadOnly` |
| `DataFilter`, `DataFilterEvaluatable` | **Security Filter**。実カラム式のみ許可（→ §7） |
| `DataAccessMode` | `Online` / `Offline` |
| `ServerCachingInterval` | サーバキャッシュ期間 |

`DataSchema` の主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name` | Schema 名 |
| `Attributes` | **列定義の配列**（次節） |
| `IsAutoCreated` | スキーマ自動生成フラグ |
| `IsDependent` | 依存テーブル（仮想テーブル）か |

### 3.3 列定義: `Schema.Attributes[]`

実装注意: JSON では配列だが、内部表現は数値キーのオブジェクトに見えることがある（`Object.keys()` で `"0", "1", ...`）。`Array.isArray()` 不能なケースは `Object.values()` で配列化する。

各列の主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name` | 列名 |
| `Type` | 型（次節 §3.4） |
| `TypeAuxData` | **型ごとの詳細設定（JSON 文字列）**。Enum 値もここ |
| `IsKey`, `IsKeyPart` | キー列フラグ |
| `IsLabel` | Label 列（一覧表示で使う代表値） |
| `IsRequired` | 必須 |
| `IsHidden` | 非表示 |
| `Searchable` | 検索対象 |
| `IsScannable`, `IsNfcScannable` | バーコード/NFC 入力 |
| `IsSensitive` | センシティブ表示制御 |
| `IsVirtual` | **仮想列フラグ** |
| `IsAutoGenerated` | 自動生成 |
| `IsSys` | システム列（`_RowNumber` 等） |
| `IsReadOnly` | 読取専用 |
| `ResetOnEdit` | 編集時リセット |
| `DefEdit` | 編集可能 |
| `Default`, `DefaultExpression` | 初期値（リテラル / 式） |
| `Formula`, `AppFormula`, `AsdbFormula` | **App Formula**（仮想列の場合は値式、実列の場合は表示式） |
| `Description` | 列の説明 |
| `DisplayName` | 表示名 |
| `Category` | 分類 |
| `IsValid` | 式評価結果 |

**App Formula の意味**：

- **仮想列の場合** (`IsVirtual: true`): その列の値を計算する式（必須）
- **実列の場合**: 編集時に強制的に計算する式（オプション、設定すると手入力不可）

**TypeAuxData の構造**（JSON 文字列で格納されているので JSON.parse して扱う）：

```json
{
  "MaxValue": null,
  "MinValue": null,
  "Valid_If": null,
  "Required_If": null,
  "Show_If": null,
  "Editable_If": null,
  "Reset_If": null,
  "Suggested_Values": null,
  "EnumValues": ["値1", "値2"],
  "AllowOtherValues": false,
  "InputMode": "Buttons"
}
```

**Enum 値は `Values` ではなく `TypeAuxData.EnumValues`** に格納される（混同しやすい）。

### 3.4 型システム

| Type | 用途 | TypeAuxData の主な項目 |
|------|------|----------------------|
| `Text` | 短文（255 字目安） | `Valid_If`, `Suggested_Values` |
| `LongText` | 長文 | （Text と同様） |
| `Number` | 整数 | `MinValue`, `MaxValue`, `StepValue`, `NumericDigits` |
| `Decimal` | 小数 | `MinValue`, `MaxValue`, `NumericDigits`, `ShowThousandsSeparator` |
| `Percent` | パーセント | `MinValue`, `MaxValue`, `NumericDigits` |
| `Price` | 通貨 | `Currency`, `NumericDigits` |
| `Date` | 日付 | `Min_Date`, `Max_Date` |
| `Time` | 時刻 | - |
| `DateTime` | 日時 | `Min_Date`, `Max_Date` |
| `Yes/No` | 真偽 | - |
| `Enum` | 選択肢（単一） | `EnumValues`, `AllowOtherValues`, `InputMode` |
| `EnumList` | 選択肢（複数） | `EnumValues`, `InputMode` |
| `Ref` | 他テーブルへの参照 | `ReferencedTableName`, `ReferencedKeyColumn`, `IsAPartOf`（A が入る） |
| `List` | リスト | `ElementType` |
| `Image` / `Thumbnail` / `Drawing` / `Signature` / `File` | 画像・添付 | - |
| `Address` / `LatLong` | 地理 | - |
| `Email` / `Phone` / `Url` | 連絡先 | - |
| `Color` / `Show` / `App` / `Progress` / `Duration` | その他 | - |

**型変換の安全リスト**（Phase 4 ツールで判定）：

- 安全: `Text ↔ LongText`、`Number ↔ Decimal ↔ Percent`、`Date ↔ DateTime`
- 警告付き: `Text → Enum`、`Number → Text`
- 危険: `Ref → 他型`、`Date → Number`、`EnumList → Enum`

### 3.5 仮想列 (Virtual Column)

`IsVirtual: true` を立て、`AppFormula` に値式を書く。

特性：

- データソース側の物理列に書込まない
- アプリ起動時・データ同期時に**全行で再計算**される
- **大量行のテーブルで多用するとパフォーマンス劣化**
- 主に表示・集計（SELECT、SUM、COUNT、REF_ROWS）に使う

代替手段（best-practices.md §仮想列で詳述）：

- 入力時に確定して良い値（ユーザー氏名・コードのラベル等）→ **REF + LOOKUP** で参照、もしくは **入力時 Initial Value で実列に書く**
- 集計・REF_ROWS は仮想列の典型用途で、これは妥当

### 3.6 Slice (`AppData.TableSlices[]`)

テーブルの「絞り込みビュー」。実データは元テーブル参照。主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name` | Slice 名 |
| `SourceTable` | 元テーブル名 |
| `FilterCondition`, `FilterEvaluatable` | 行フィルタ式（`=` プレフィックス必須） |
| `Columns` | 公開する列のサブセット（順序付き） |
| `Actions` | 使える Action 名の配列。`["**auto**"]` で全 Action 自動継承 |
| `AllowedUpdates` | 数値（0 = テンプレ継承） |
| `UpdateMode` | 数値（7 = テンプレ継承） |

Slice の使い分けは Security Filter とは別レイヤ。Slice は **クライアント評価**で、データは全件ダウンロードされた上で表示時にフィルタされる。データ秘匿目的では使えない（→ §7）。

---

## 4. 式言語 (AppSheet Expression)

### 4.1 式が評価される場所

| 場所 | キー | 評価タイミング |
|------|------|--------------|
| **App Formula** (実列) | `Column.AppFormula` | 編集確定時 |
| **App Formula** (仮想列) | `Column.AppFormula` | データ同期時に全行 |
| **Initial Value** | `Column.DefaultExpression` | 行追加時 1 回 |
| **Show_If / Required_If / Valid_If / Editable_If / Reset_If** | `Column.TypeAuxData.*` | フォーム描画時 |
| **Action Condition / Value** | `Action.Condition`, `Action.Value` | アクション実行判定時 |
| **Slice Filter** | `Slice.FilterCondition` | データ同期後・クライアント側 |
| **Security Filter** | `DataSet.DataFilter` | サーバ側・**実カラムのみ** |
| **Bot Event Condition** | `Event.Condition` | データ変更検知時 |

### 4.2 主要関数カタログ

**ユーザーコンテキスト**

| 関数 | 戻り値 | 用途 |
|------|--------|------|
| `USEREMAIL()` | Text | ログイン中ユーザーのメール |
| `USERSETTINGS(name)` | Any | User Settings テーブルの値 |
| `CONTEXT(key)` | Any | `Host`, `View`, `ViewType` 等の実行環境 |

**現在値**

| 関数 | 用途 |
|------|------|
| `NOW()` | 現在日時 |
| `TODAY()` | 今日の日付 |
| `UNIQUEID()` | 16 文字 UUID |
| `RANDBETWEEN(min, max)` | 乱数 |

**条件分岐**

| 関数 | 用途 |
|------|------|
| `IF(cond, then, else)` | 二分岐 |
| `IFS(c1, v1, c2, v2, ...)` | 多分岐（else は最後を `TRUE, default` で表現） |
| `SWITCH(expr, k1, v1, k2, v2, ..., default)` | 値マッチ分岐 |
| `AND(...)`, `OR(...)`, `NOT(x)` | 論理演算 |

**テキスト操作**

| 関数 | 用途 |
|------|------|
| `CONCATENATE(a, b, ...)` | 連結 |
| `SUBSTITUTE(text, old, new)` | 置換 |
| `LEFT/RIGHT/MID(text, ...)` | 部分文字列 |
| `LEN(text)` | 文字数 |
| `UPPER/LOWER(text)` | 大小変換 |
| `TEXT(value, format)` | 数値・日付の文字列化 |
| `CONTAINS/STARTSWITH/ENDSWITH` | 部分一致 |
| `SPLIT(text, delim)` | 分割（List を返す） |

**リスト操作**

| 関数 | 用途 |
|------|------|
| `LIST(a, b, c)` | リスト構築 |
| `IN(value, list)` | 含有判定 |
| `COUNT(list)` | 件数 |
| `INDEX(list, n)` | n 番目（1-origin） |
| `TOP/BOTTOM(list, n)` | 先頭/末尾 n 件 |
| `INTERSECT/UNION(a, b)` | 集合演算 |
| `ORDERBY(refs, expr, [desc])` | 並べ替え |
| `FILTER(table, condition)` | 条件抽出（**SELECT より高速**） |

**REF / LOOKUP / SELECT**

| 関数 | 用途 |
|------|------|
| `[親列]` | dereference（Ref 列経由で親レコードの列にアクセス） |
| `[親列].[孫列]` | 連鎖 dereference |
| `LOOKUP(key, table, keyCol, returnCol)` | 単一行参照（key で検索） |
| `SELECT(table[colExpr], condition, [distinctOnly])` | 列リスト抽出 |
| `REF_ROWS(table, refColumn)` | 親→子の逆参照（is-a-part-of 子の取得） |
| `ANY(list)` | リストの先頭要素 |
| `MAXROW(table, expr, [cond])`, `MINROW(...)` | 集計関数（条件付き極値行） |

**SELECT vs FILTER vs REF_ROWS の使い分け**:

- 親→子: **REF_ROWS** が最速（インデックス使用）
- 一般条件: **FILTER** （SELECT より速い）
- 列の値だけ欲しい: **SELECT**
- 集計値 1 個: **MAXROW + dereference** または **SUM(SELECT(...))**

### 4.3 Evaluatable と式の格納形式

`/api/saveapp` で式を送る場合、**2 つの場所に書き分ける**：

| キー | 内容 |
|------|------|
| `Condition`, `Value`, `DataFilter`, `RowFilterCondition`, `AppFormula` 等 | **式の文字列**（例: `"NOT(ISBLANK([列名]))"`) |
| `ConditionEvaluatable`, `ValueEvaluatable`, `DataFilterEvaluatable` 等 | AppSheet 内部のパース済み式木 |

**実装上のコツ**: Evaluatable は AppSheet 側で再パースされるので、**書込時は文字列だけ送り、Evaluatable は元の値を維持または空文字**で送る。複雑な式（CASE/SWITCH のネスト）は再パースされず無視されるケースがあるので、saveapp 後の verify で式が反映されているか必ず確認する。

実装メモ: [src/tools/edit.ts](../src/tools/edit.ts) の `appsheet_set_action_condition`, `appsheet_set_action_value`, `appsheet_set_column_formula` がこの 2 つを送り分ける。

### 4.4 イディオム集

**Security Filter で USEREMAIL() 切替**

```
[担当者メール] = USEREMAIL()
```

実カラム制約があるので、Slice では使わずここで使う。

**User Settings テーブル経由の高速化**

```
LOOKUP(USEREMAIL(), "ユーザー設定", "メール", "表示モード") = "詳細"
```

USEREMAIL() を直接 Security Filter に書くより、別テーブルで一段噛ませると複雑な権限ロジックを式で組める。

**親レコードの値で子の表示制御**

```
[案件].[ステータス] = "進行中"
```

dereference 1 段で親値参照。SELECT より圧倒的に速い。

**子レコード集計**

```
SUM(REF_ROWS("見積明細", "案件ID")[小計])
```

`REF_ROWS` は親→子のインデックスを使うので、SELECT より高速。

**Bot トリガー条件（フラグパターン）**

```
AND([処理フラグ] = TRUE, ISNOTBLANK([更新日時]))
```

Bot 処理末尾でフラグを FALSE に戻す（best-practices.md §Schedule vs Data Change Bot）。

---

## 5. 振る舞い (Behavior)

### 5.1 Action (`AppData.DataActions[]`)

主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name`, `DisplayName` | Action 名・表示名 |
| `Table`, `TableScope` | 対象テーブル |
| `ActionType` | 種別（次表） |
| `Condition`, `ConditionEvaluatable` | 実行可否条件式 |
| `Value`, `ValueEvaluatable` | 操作対象値式（種別ごとに意味が変わる） |
| `ColumnToEdit` | 編集対象列（Set Column Value 系） |
| `Inputs` | 入力プロンプト定義（With Inputs 系） |
| `ActionSettings` | 種別固有設定 |
| `Icon` | アイコン |
| `IsEmbedded` | 他 Action の中で呼ばれるか |
| `Scope` | スコープ |
| `ActionDefinition` | 一部 Action 種別の追加定義 |

**ActionType の主要種別**：

| ActionType | 用途 | Value の意味 |
|-----------|------|------------|
| `Data: set the values of some columns in this row` | 列を編集 | 編集後の値式 |
| `Data: add a new row to another table using values from this row` | 別テーブルに行追加 | 追加対象行の値式 |
| `Data: delete this row` | 削除 | - |
| `Data: execute an action on a set of rows` | 一括 Action | 対象行のリスト式 + 子 Action 名 |
| `App: open a form to edit this row` | 編集フォーム起動 | View 名 |
| `App: open a form to add a new row to this table` | 追加フォーム起動 | View 名 |
| `App: go to another view within this app` | 別 View へ遷移 | View 名式 |
| `App: go to another AppSheet app` | 別アプリへ遷移 | アプリ URL |
| `App: copy this row and edit the copy` | 複製編集 | - |
| `App: import a CSV file for this view` | CSV インポート | View 名 |
| `App: open a URL` | **OpenUrl（外部 URL 起動）** | URL 式（HTTPS 推奨） |
| `App: send an email` | メール作成 | To/Subject/Body 等の構造体 |
| `App: send a SMS message` | SMS | To/Body |
| `App: phone the contact` | 電話発信 | 電話番号式 |
| `App: external service: Call a webhook` | Webhook 呼出 | URL/Method/Body |
| `App: text a notification` | プッシュ通知 | - |
| `Grouped: execute a sequence of actions` | 複数 Action 連結 | 子 Action 名のリスト |

### 5.2 Workflow / Automation の関係

歴史的経緯：

- **旧 Workflow** (`WorkflowRules[]`, `AppWorkflowRules[]`): データ変更をトリガーに Webhook 等を呼ぶ仕組み。古い AppSheet で使われた。
- **新 Automation = Bot** (`AppBots[]` + `AppEvents[]` + `AppProcesses[]` + `Tasks[]`): 現在主流。複雑なフローをノーコードで組める。

**新規開発は Bot を使う**。旧 Workflow は既存アプリでのみ残し、新規追加は推奨しない。

### 5.3 Bot の 4 配列構造

**最重要**: Bot は 4 つの配列に分散している。

```
AppBots[]       Bot 本体（名前・有効/無効・EventName・ProcessName）
   │
   ├─ EventName ───→ AppEvents[]      トリガー定義（テーブル・条件・スケジュール）
   │
   └─ ProcessName ──→ AppProcesses[]  処理フロー定義（Tasks の組み合わせ）
                          │
                          └─ TaskNames ──→ Tasks[]  個別タスク（Send Email 等）
```

**リンクは全部「名前文字列」**。ID 参照ではない。クローンや削除では：

- Bot を削除 → 関連 Event / Process / Tasks も削除（孤児を残さない）
- Bot をクローン → 4 配列すべて新規 ComponentId で複製し、名前を新名に置換

実装メモ: [src/tools/edit.ts](../src/tools/edit.ts) の `appsheet_clone_bot`, `appsheet_remove_bot` がこの 4 配列同時操作を行う。

**Bot Event の種別**：

| 種別 | トリガー |
|------|----------|
| `DataChange` (`Adds`, `Updates`, `Deletes`) | テーブルの行変更 |
| `Schedule` | 時刻スケジュール（毎日・毎週・cron 風） |
| `Webhook` | 外部からの POST 受信 |
| `ScheduledReport` | 定期レポート送信 |

**Task の種別** (`Task.TaskType` で識別)：

| TaskType | 用途 |
|----------|------|
| `Notification` (Email/SMS/Push) | メール・SMS・プッシュ通知送信 |
| `Webhook` | 外部 API 呼出 |
| `AppsScript` | **Call a Script**（GAS 関数呼出） |
| `Process` | 別 Process を内部呼出（再帰可） |
| `Branch` | 条件分岐 |
| `Wait` | 一定時間待機 |
| `Return` | 戻り値設定 |
| `RunAction` | 既存 Action を実行 |
| `CreateNewRow` | 行追加 |

### 5.4 Call a Script (AppsScript Task)

**仕様の要点**：

- AppSheet Editor で OAuth 認可済みの GAS スクリプトの関数を呼べる
- パラメータは AppSheet 式で組み立てて渡す
- **戻り値の型は LongText 1 個のみ**（オブジェクトは返せない）
- 複数値返したい時の **イディオム**: GAS 側でカンマ区切り文字列を返し、AppSheet 側で `INDEX(SPLIT([戻り値], ","), n)` で取り出す

**Task のフィールド**：

| フィールド | 用途 |
|-----------|------|
| `FunctionName` | GAS の関数名 |
| `Inputs[]` | パラメータ（型 + 値式） |
| `ScriptId` | GAS スクリプト ID |
| `ReturnVariableName` | 戻り値を Process 内で参照する変数名 |

**配置**: 通常は Bot の Task として組み込む。Action から直接 Call a Script は不可（Webhook なら可）。

実装メモ: 現在 MCP に Call a Script 専用ヘルパは未実装（Phase 5 で追加候補）。

---

## 6. プレゼンテーション (Presentation)

### 6.1 View (`Presentation.Controls[]`)

主要フィールド：

| フィールド | 用途 |
|-----------|------|
| `Name`, `DisplayName` | View 名・表示名 |
| `TableOrFolderName` | 対象テーブル / Slice |
| `ActionType` | View タイプ（次表） |
| `Position` | 表示位置（`primary` / `menu` / `ref` / `none`） |
| `ShowIf` | 表示条件式（USEREMAIL() で出し分け等） |
| `ViewDefinition` | View タイプ固有の詳細設定 |
| `Settings` | 共通設定 |
| `Parameters` | パラメータ（一部 View タイプで使用） |

### 6.2 View タイプ (`ActionType`)

| ActionType | 用途 |
|-----------|------|
| `table` | テーブル一覧 |
| `deck` | カード一覧 |
| `gallery` | サムネ一覧 |
| `detail` | 詳細表示 |
| `form` | 入力フォーム |
| `dashboard` | 複数 View の組合せ表示 |
| `onboarding` | オンボーディング |
| `chart` | グラフ |
| `calendar` | カレンダー |
| `map` | 地図 |
| `gantt` | ガント |
| `card` | カード詳細 |
| `kanban` | カンバン |

### 6.3 MenuEntries

`Presentation.MenuEntries[]` は左メニューの並び・グループ。

| フィールド | 用途 |
|-----------|------|
| `ViewName` | 対象 View 名 |
| `Group` | グループ名 |
| `Position` | 並び順 |

### 6.4 FormatRules

`Presentation.FormatRules[]` は条件付き書式。

| フィールド | 用途 |
|-----------|------|
| `Name` | ルール名 |
| `Tables` | 対象テーブル |
| `Columns` | 対象列 |
| `IfThisIsTrue` | 適用条件式 |
| `Format` | 色・アイコン・太字等の設定 |

---

## 7. Security

### 7.1 Security Filter (`DataSet.DataFilter`)

**サーバ側評価**。クライアントには絞り込み後のデータのみ届く。

**重要な制約**：

1. **実カラム式しか書けない**（仮想列・dereference は使えない）
2. **テーブル単位**（列ごとには設定できない → IsHidden で代替）
3. **クライアント側で再評価されない**（オフライン時は最後の同期データを使用）

### 7.2 Slice との使い分け

| | Security Filter | Slice |
|--|----------------|-------|
| 評価場所 | サーバ | クライアント |
| データ秘匿 | ✅ 可能 | ❌ 全件ダウンロード後に絞るだけ |
| 仮想列・dereference | ❌ 不可 | ✅ 可能 |
| 表示用カスタム | ❌ 不向き | ✅ 主用途 |
| Bot トリガー対象指定 | × | ✅ 対象 Slice 指定で絞る |
| パフォーマンス | ✅ 行数削減 | △ ダウンロード量は変わらず |

### 7.3 USEREMAIL() パターンと User Settings テーブル

**パターン A: 担当者ベース絞り込み（鉄板）**

```
DataSet.DataFilter = "[担当者メール] = USEREMAIL()"
```

シンプルで高速。実カラム制約も満たす。

**パターン B: アカウント表示設定テーブル経由（高度）**

```
ユーザー設定テーブル: [メール], [表示モード], [部署], [権限]

担当案件テーブル.DataFilter = 
  "[担当者メール] = USEREMAIL() OR 
   [部署] = LOOKUP(USEREMAIL(), \"ユーザー設定\", \"メール\", \"部署\")"
```

このパターンは：

- 1 ユーザー処理高速化（権限ロジックを 1 テーブルに集約）
- Automation の RowID 受け渡しで権限が伝搬する
- 標準 CSV ダウンロードも絞り込み済み

ただし LOOKUP は **実カラムである User Settings テーブル**を参照するので OK（仮想列を経由しないこと）。

### 7.4 認証・暗号化

`Behavior` 配下：

| キー | 用途 |
|------|------|
| `AuthRequired` | サインイン必須 |
| `AuthProvider` | `Google` / `Microsoft` / `AppSheet` / `Smartsheet` 等 |
| `AuthDomain` | ドメイン制限 |
| `AllowAllSignedInUsers` | サインイン済み全員許可 |
| `AuthGroups` | ホワイトリスト |
| `EncryptLocalData` | デバイス暗号化 |
| `SecurePDFAccess` | PDF 認証必須 |
| `SecureImageAccess` | 画像認証必須 |
| `RequireUserConsent` | 同意取得 |
| `TreatAllDataAsPII` | PII 扱い |

---

## 8. 内部 API (saveapp / loadApp)

### 8.1 エンドポイント

| エンドポイント | メソッド | 認証 | 用途 |
|--------------|--------|------|------|
| `/api/loadApp/<App名>` | GET | Cookie | アプリ定義の完全取得 |
| `/api/saveapp` | POST | Cookie + body 内の AppId | アプリ定義の保存 |
| `/api/v2/apps/<App ID>/openapi.json` | GET | Cookie | OpenAPI スキーマ |
| `/api/v2/apps/<App ID>/tables/<Table>/Action` | POST | Application Access Key | データ CRUD（公式） |

**注意**:

- `App名` (URL パス) と `App ID` (UUID) は別物。URL パスは ShortName と OwnerId の合成で `<short>-<owner>` 形式。
- saveapp と openapi.json は Cookie 認証必須。Application Access Key では 401。

### 8.2 saveapp のリクエストボディ

| フィールド | 用途 |
|-----------|------|
| `AppId` | App ID (UUID) |
| `appJson` | **アプリ定義の全 JSON 文字列**（JSON.stringify した結果） |
| `Action` | `SaveApp` |
| `OldVersion` | 競合検知用 |
| `OnRequestVersion` | クライアントバージョン |

`appJson` の中身は §2.1 の 48 トップレベルキーすべて。差分送信ではない。

### 8.3 saveapp のレスポンス

```json
{
  "Success": true,
  "App": {
    "Id": "...",
    "Version": "...",
    "appJson": "{...}"
  },
  "Errors": [],
  "Warnings": []
}
```

**重要な使い方**:

1. `Success: false` の場合 → `Errors` に詳細
2. 成功時 → `App.appJson` を JSON.parse → 自分が送ったエンティティが含まれているか **verify**
3. Verify は post-fetch（loadApp 再呼出）ではなく **このレスポンスを使う**。eventual consistency（DB 反映遅延）を回避できる

### 8.4 失敗パターンと対処

| パターン | 兆候 | 対処 |
|---------|------|------|
| **Cookie 失効** | 401 / HTML ログイン画面が返る | `.env` の `APPSHEET_COOKIE` を再取得（30 日有効） |
| **OldVersion 不一致** | `Errors: [{ Type: "VersionMismatch" }]` | loadApp で最新 Version を取得して再送 |
| **ComponentId 衝突** | 新規エンティティが反映されない | UNIQUEID 風に再生成。同一セッションで生成した ID を再利用しないこと |
| **`_isNew` 忘れ** | エラーは出ないが新規が無視される | 新規エンティティには必ず `_isNew: true` |
| **名前リンク切れ** | Bot が動かない／View が空 | 4 配列名前リンク（§5.3）の整合性チェック |
| **複雑式の再パース失敗** | Action Condition が無視される | saveapp 後の verify で `IsValid` を確認。式を簡素化するか段階分割 |
| **Schema と DataSet の名前不一致** | テーブル一覧に出ない | `DataSet.SchemaName === Schema.Name` を保証 |

### 8.5 Cookie の取得・更新

1. AppSheet Editor を Google ログイン状態で開く
2. F12 → Network タブ → 任意の編集を 1 回行って Save
3. `saveapp` リクエスト右クリック → Copy → **Copy as cURL (bash)**
4. 結果を `samples/saveapp.curl.txt` に貼り付け
5. cURL の `-b '...'` 部分（Cookie ヘッダ）を抽出して `.env` の `APPSHEET_COOKIE=...` に設定

**Cookie は約 30 日で失効**。失効すると 401 / HTML ログイン画面が返る。MCP ツールはこれを検出して即時エラーを返す。

実装メモ: [src/auth/cookies.ts](../src/auth/cookies.ts) が `.env` から Cookie を読み込む。[src/auth/appsheet.ts](../src/auth/appsheet.ts) の `runSaveApp()` が saveapp の認証付き呼出を行う。

---

## 9. 既知の制限・落とし穴

### 9.1 OpenAPI のスキーマ ID 衝突 (Phase 2)

`/api/v2/apps/<id>/openapi.json` のスキーマ ID 生成は **テーブル名の文字数** に依存しており、同じ文字数のテーブルが複数あると衝突する。

例: `ログ` と `設定` はどちらも 2 文字 → 一方しか OpenAPI に出ない。

**回避策**:

- メタ情報取得は **Phase 3 の HAR スナップショット (`appsheet_get_full_columns`)** を優先
- どうしても OpenAPI を使う場合は `appsheet_find_records` で 1 行取得して列名を抽出

### 9.2 仮想列の起動コスト

仮想列は **アプリ起動時・データ同期時に全行で再計算** される。

**症状**:

- 行数が数千を超えると起動が遅い
- スプシソースで仮想列多用 → タイムアウト

**回避策**:

- 入力時に確定する値は実列に書く（Initial Value で）
- REF 経由の dereference は仮想列ではなく直接 `[親列].[孫列]` で書く（仮想列を経由しない）
- 集計はやむを得ず仮想列で良いが、Slice の RowFilter で評価対象行を絞る

### 9.3 Action 式の再パース失敗

複雑な式（CASE/SWITCH のネスト、巨大な IFS）は AppSheet 側で再パースされず無視されるケースがある。

**症状**: saveapp は Success だが Action が動かない・Condition が常に TRUE/FALSE になる。

**対処**:

- saveapp 後の verify で `IsValid` を必ず確認
- `Evaluatable` を空文字で送ると AppSheet 側で再パースを強制
- 複雑な式は中間列（仮想列で式評価結果を保持）に分割

### 9.4 Bot の名前リンク切れ

4 配列の名前リンク（§5.3）が崩れると Bot は黙って動かない。

**対処**:

- Bot 削除時は 4 配列同時削除（→ `appsheet_remove_bot`）
- Bot クローン時は 4 配列同時複製・名前置換（→ `appsheet_clone_bot`）
- 手動編集後は `appsheet_load_app_def` でロードして整合性チェック

### 9.5 公式 API v2 の制限

`appsheet_find_records` (公式 API) には以下の制限：

- **`Selector` パラメータが事実上必須**: 全件取得には `Filter([テーブル名], TRUE)` 等の式を渡す
- **戻り値件数の上限**（テーブルあたり数千行が目安）
- **スプシソースでは反映が遅い**（数秒〜数十秒）
- **Image/File 列は URL のみ返却**（バイナリは別 API）

### 9.6 saveapp の同時編集競合

複数人が同時に Editor を開いて保存すると **後勝ち**。

**対処**:

- 自動化スクリプトは `OldVersion` を loadApp 直後の値にして送る（VersionMismatch エラーで検知）
- 失敗時は loadApp を再取得して差分マージしてリトライ

---

## 実装メモ — MCP ツールとの対応索引

| 領域 | 該当ツール | ソース |
|------|-----------|--------|
| データ CRUD（公式 API v2） | `appsheet_find_records`, `appsheet_add_records`, `appsheet_edit_records`, `appsheet_delete_records`, `appsheet_invoke_action` | [src/tools/data.ts](../src/tools/data.ts) |
| OpenAPI スナップショット | `appsheet_load_spec`, `appsheet_save_spec`, `appsheet_get_app_overview`, `appsheet_get_tables`, `appsheet_get_columns`, `appsheet_get_table_summary` | [src/tools/spec.ts](../src/tools/spec.ts) |
| HAR スナップショット | `appsheet_import_har`, `appsheet_load_app_def`, `appsheet_get_app_metadata`, `appsheet_get_full_columns`, `appsheet_get_actions`, `appsheet_get_action_detail`, `appsheet_get_views`, `appsheet_get_bots` | [src/tools/appdef.ts](../src/tools/appdef.ts) |
| 列のフラグ・型・Description | `appsheet_set_column_flag`, `appsheet_set_column_type`, `appsheet_set_column_description` | [src/tools/edit.ts](../src/tools/edit.ts) |
| バーチャル列 | `appsheet_add_virtual_column`, `appsheet_remove_column` | [src/tools/edit.ts](../src/tools/edit.ts) |
| View | `appsheet_clone_view`, `appsheet_remove_view` | [src/tools/edit.ts](../src/tools/edit.ts) |
| Action | `appsheet_clone_action`, `appsheet_remove_action`, `appsheet_set_action_condition`, `appsheet_set_action_value` | [src/tools/edit.ts](../src/tools/edit.ts) |
| Bot | `appsheet_clone_bot`, `appsheet_remove_bot` | [src/tools/edit.ts](../src/tools/edit.ts) |
| 列の式 | `appsheet_set_column_formula` | [src/tools/edit.ts](../src/tools/edit.ts) |
| Enum 値 | `appsheet_set_enum_values`, `appsheet_add_enum_value`, `appsheet_remove_enum_value` | [src/tools/edit.ts](../src/tools/edit.ts) |
| テーブル | `appsheet_clone_table`, `appsheet_remove_table` | [src/tools/edit.ts](../src/tools/edit.ts) |
| ライブ更新 | `appsheet_refresh_app_def` | [src/tools/edit.ts](../src/tools/edit.ts) |

**未実装（Phase 5 候補）**:

- Slice 追加・削除（template HAR 未取得）
- Security Filter 設定 (`DataSet.DataFilter` 書込）
- Automation/Bot の新規作成（クローンではなくゼロから）
- Call a Script Task の組込み
- OpenUrl Action の組込みヘルパ
- 新規テーブル一括追加（Schema + DataSet + Initial View + Default Actions）
- Cookie 自動更新（Playwright で再ログイン）

---

## 参考

- 公式: https://support.google.com/appsheet/
- 公式 API v2: https://support.google.com/appsheet/answer/10105768
- 内部 API は AppSheet Editor の DevTools で観察可能（Network タブ → loadApp / saveapp）
