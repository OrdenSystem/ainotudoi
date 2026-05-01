# appsheet-mcp

AppSheet を Claude Code から操作するための MCP サーバー（Model Context Protocol）。

## 目的

GCP / Salesforce / SQL は Claude Code から API 経由で操作できるが、AppSheet には公式の Metadata API が無いため手動作業が残る。本サーバーは：

- **Phase 1**：AppSheet Application API v2（公式・データ CRUD）を MCP ツールとして提供 ✅
- **Phase 2**：AppSheet 内部 OpenAPI スナップショットからテーブル/列構造・型・enum を取得 ✅
- **Phase 3**：HAR から loadApp レスポンスを抽出し、式・仮想列・Action・View を取得 ✅
- **Phase 4**：Cookie 認証で /api/loadApp と /api/saveapp を直接叩き、列のフラグ・型・Description を書換 ✅

**プロジェクト非依存設計**。複数の AppSheet アプリを `.env` の追記だけで切り替えられる。

## セットアップ

```bash
cd appsheet-mcp
npm install
cp .env.example .env
# .env を編集して APPSHEET_DEFAULT_APP_ID と APPSHEET_ACCESS_KEY__<APP_ID> を設定
npm run build
```

### `.env` の書き方

```ini
APPSHEET_DEFAULT_APP_ID=<App ID>
APPSHEET_ACCESS_KEY__<App ID>=V2-xxxxx-xxxxx
```

複数アプリを使う場合は `APPSHEET_ACCESS_KEY__<別の App ID>=...` を追記。MCP ツール呼び出しで `appId` 引数を指定すれば切り替わる。

### App ID と Access Key の取り方

1. AppSheet Editor → 対象アプリを開く
2. `Manage` → `Integrations` → `IN: from cloud services and webhooks` セクション
3. `Enable` → Application Access Key を生成
4. App ID は同セクションに表示される UUID

## Claude Code への登録

プロジェクトルートの `.mcp.json` に登録するか、ユーザースコープでも可。

```json
{
  "mcpServers": {
    "appsheet": {
      "command": "node",
      "args": ["./appsheet-mcp/dist/index.js"],
      "cwd": "."
    }
  }
}
```

## 提供ツール

### Phase 1（データ CRUD・公式 API v2 経由・安定）

| ツール | 概要 |
|--------|------|
| `appsheet_find_records` | Find アクションで取得（selector で AppSheet 式可） |
| `appsheet_add_records` | 行追加 |
| `appsheet_edit_records` | 行更新（キー列必須） |
| `appsheet_delete_records` | 行削除 |
| `appsheet_invoke_action` | 任意 Action 実行 |

### Phase 2（メタ情報・OpenAPI スナップショットベース）

| ツール | 概要 |
|--------|------|
| `appsheet_load_spec` | スナップショット読み込み（`snapshots/openapi-<appId>.json` または `samples/openapi.json`） |
| `appsheet_save_spec` | OpenAPI JSON 文字列を `snapshots/` に保存 |
| `appsheet_get_app_overview` | アプリタイトル + テーブル一覧 + 各テーブルの操作・列数 |
| `appsheet_get_tables` | 全テーブル名 + 操作リスト + 列数 |
| `appsheet_get_columns` | 列名・型・format・enum・required（公式列のみ・仮想列/式は Phase 3） |
| `appsheet_get_table_summary` | テーブルの操作 + 列定義を一括取得 |

#### スナップショットの取得方法

OpenAPI エンドポイントは Application Access Key では認証されず、ログイン中のブラウザセッションが必要。

1. ブラウザで `https://www.appsheet.com/api/v2/apps/<App ID>/openapi.json` を開く
2. 表示された JSON を `snapshots/openapi-<App ID>.json` として保存（または `samples/openapi.json`）
3. MCP からは `appsheet_load_spec` で読込（パス指定省略時は規定パスを順に探索）

#### 既知の制限

**同名長テーブルのスキーマ衝突**：AppSheet の OpenAPI 生成は table 名のキャラクタ数が同じ場合にスキーマ ID が衝突し、片方しか出ない（例：`ログ` と `設定` はどちらも 2 文字なので一方が抜ける）。`appsheet_get_columns` は明示的にエラーを返し、回避策（`appsheet_find_records` で 1 行取得 → キー一覧から列名抽出）を案内する。

### Phase 3（アプリ定義フル取得・HAR スナップショットベース）

| ツール | 概要 |
|--------|------|
| `appsheet_import_har` | DevTools で保存した HAR から loadApp レスポンスを抽出して `snapshots/appdef-<appId>.json` に保存 |
| `appsheet_load_app_def` | appdef スナップショットを読込み、テーブル/Action/View/Bot 件数を返す |
| `appsheet_get_app_metadata` | アプリ ID・タイトル・バージョン・テーブル一覧 |
| `appsheet_get_full_columns` | 列の完全情報（型・式・初期値・仮想列・enum・各種フラグ） |
| `appsheet_get_actions` | Action 一覧（条件式・値式付き） |
| `appsheet_get_action_detail` | 指定 Action の生データ（評価ツリー含む） |
| `appsheet_get_views` | View 一覧（対象テーブル・タイプ・Position・ShowIf） |
| `appsheet_get_bots` | Bot/Automation 一覧 |

#### HAR スナップショットの取得方法

AppSheet Editor の `/api/loadApp/<App名>` レスポンスにアプリ定義丸ごと（48 トップレベルキー、Behavior/Presentation/AppData 配下に Action・Bot・View・Schema 全部）が JSON 文字列として入っている。これをブラウザ DevTools 経由で HAR として吸い出し、MCP がパースする方式。

1. AppSheet Editor で対象アプリを開く
2. **F12** で DevTools → **Network** タブ → 上部「Fetch/XHR」フィルター
3. **F5** でリフレッシュ
4. リクエスト一覧の空白部分を **右クリック → 「Save all as HAR with content」**
5. 任意の場所に保存（例: `samples/editor.har`）
6. MCP から `appsheet_import_har({ path: "samples/editor.har" })` を呼ぶ → スナップショット化

スナップショットができれば、以降は `appsheet_get_full_columns` 等のクエリツールでアプリ定義を自由に参照できる。

#### 取れる情報の例

- 列の **App Formula / Initial Value**（例: ID 列の `=UNIQUEID()`）
- **仮想列**（`isVirtual: true`）と通常列の区別
- Action の **値式・条件式**（例: `[WP投稿URL]` / `NOT(ISBLANK([WP投稿URL]))`）
- View の **対象テーブル・タイプ・Position・表示条件**
- Bot/Automation 定義（このアプリでは未作成のため空）

### Phase 4（Cookie 認証で書込み・実験的）

| ツール | 概要 |
|--------|------|
| `appsheet_refresh_app_def` | Cookie 認証で `/api/loadApp` を叩き snapshot を直接更新（HAR 不要） |
| `appsheet_set_column_flag` | 列のブールフラグを書換（IsHidden/Searchable/IsLabel/IsScannable/IsNfcScannable/IsSensitive/ResetOnEdit/IsRequired/DefEdit） |
| `appsheet_set_column_type` | 列の Type を変更（Text↔LongText 等。安全リストで判定し外れる変換は warning） |
| `appsheet_set_column_description` | 列の Description を更新 |
| `appsheet_add_virtual_column` | 新規バーチャル列を追加（AppFormula 必須・型指定可・dry-run/apply） |
| `appsheet_remove_column` | 列を削除（バーチャル列は安全・実列は AppSheet 側のみ削除） |
| `appsheet_clone_view` | 既存 View をクローンして新規 View 作成（Name/Table/Position 置換可） |
| `appsheet_clone_action` | 既存 Action をクローンして新規 Action 作成（Name/Table/ColumnToEdit 置換可） |
| `appsheet_remove_view` | View を削除 |
| `appsheet_remove_action` | Action を削除（System Action は推奨せず） |
| `appsheet_clone_bot` | 既存 Bot をクローン（Bot + Event + Process + Tasks の 4 配列まとめて再生成） |
| `appsheet_remove_bot` | Bot とそれに紐づく Event / Process / Tasks を一括削除 |
| `appsheet_set_column_formula` | 列の AppFormula / Initial Value 式を更新 |
| `appsheet_set_action_condition` | Action の Condition（実行可否条件）を更新 |
| `appsheet_set_action_value` | Action の Value（操作対象値）式を更新 |
| `appsheet_set_enum_values` | Enum/EnumList 列の選択肢を一括置換（TypeAuxData.EnumValues） |
| `appsheet_add_enum_value` | Enum/EnumList 列に選択肢を 1 つ追加 |
| `appsheet_remove_enum_value` | Enum/EnumList 列から選択肢を 1 つ削除 |
| `appsheet_clone_table` | テーブル丸ごとクローン（DataSet + Schema + Actions + Views 一括） |
| `appsheet_remove_table` | テーブルとその全関連エンティティを一括削除 |

#### Cookie の取得

`/api/saveapp` は Application Access Key で認証されないため、ブラウザログインセッションの Cookie を流用する。

1. AppSheet Editor を開く（Google ログイン状態）
2. F12 → Network タブ → 任意の編集を 1 回行ってから Save
3. `saveapp` リクエストを右クリック → Copy → **「Copy as cURL (bash)」**
4. 結果を `samples/saveapp.curl.txt` に貼り付け
5. cURL の `-b '...'` 部分を抽出して `.env` の `APPSHEET_COOKIE=...` に設定

Cookie 有効期限は約 30 日。失効時は再取得が必要。

#### 安全ガード

書込み系ツールはすべて **デフォルト dry-run**（送信せず差分のみ返す）。実適用は引数 `apply: true` 必須。適用後は loadApp で再取得し、変更が反映されたか **事後検証** して結果を返す。

#### 利用上の注意

`/api/saveapp` は AppSheet Editor の内部 API であり、公式 API ではない。社内向け・自社アプリ向けの利用に限定し、外部 SaaS への組込み等は AppSheet 利用規約と照らし合わせて判断すること。仕様変更で予告なく動作しなくなる可能性がある。

## 動作確認

```bash
npm run build
node dist/index.js
# stdin から MCP プロトコルでメッセージを流すか、Claude Code から呼ぶ
```

## ライセンス・利用上の注意

- AppSheet Application API は公式ドキュメントの仕様に従う
- Phase 4 の Editor 自動操作は AppSheet 利用規約のグレーゾーン。本番利用前にユーザー側で確認すること
