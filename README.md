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
git clone git@github.com:lab-masuyama/AppsheetMCP.git appsheet-mcp
cd appsheet-mcp
npm install
npm run setup            # ← everything-claude-code (ECG) を ~/.claude/ に clone or pull
cp .env.example .env
# .env を編集して APPSHEET_DEFAULT_APP_ID と APPSHEET_ACCESS_KEY__<APP_ID> を設定
npm run build
```

### Claude Code で初めて使う時のオンボーディング

`.env` の編集が終わったら、Claude Code に **`appsheet_preflight`** を呼んでもらってください。AppID / Access Key / Cookie / snapshot / API 到達を一括チェックして、足りない項目と次の手順を返します。

会話例：

> ユーザー: AppSheet を繋ぎたい
>
> Claude: では `appsheet_preflight` を呼びます… 結果、Access Key と Cookie が未設定です。順に確認させてください。
>   1. Application Access Key は発行済みですか？（Y/N）…

`.claude/agents/appsheet-onboarding.md` というサブエージェントが**クローズドクエッション中心**で誘導するように仕込まれており、PROACTIVELY 起動するように設計されています。書込み許可・Cookie 取得許可・開発者招待確認まで対話で完結します。

`npm run setup` は [`affaan-m/everything-claude-code`](https://github.com/affaan-m/everything-claude-code) を `~/.claude/everything-claude-code/` に同期します（既存なら `git pull --rebase --autostash`、無ければ `git clone --depth=1`）。これで Claude Code から AppsheetMCP のサブエージェント（`.claude/agents/appsheet-*`）と ECG のエージェント・スキル・コマンドの両方が利用可能になります。Claude Code 再起動後に有効化されます。

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

### パターン A: 同じプロジェクト配下に clone した場合

```json
{
  "mcpServers": {
    "appsheet": {
      "command": "node",
      "args": ["./appsheet-mcp/dist/index.js"],
      "cwd": "./appsheet-mcp"
    }
  }
}
```

### パターン B: 他リポジトリ（別プロジェクト）から参照する場合

このリポジトリは「複数プロジェクトで共用する横断ツール」として設計されているため、利用する側のプロジェクトとは別の場所に clone するケースが一般的。その場合は **絶対パス参照** にする。

```json
{
  "mcpServers": {
    "appsheet": {
      "command": "node",
      "args": ["C:/work/appsheet-mcp/dist/index.js"],
      "cwd": "C:/work/appsheet-mcp"
    }
  }
}
```

**Windows + Google Drive で運用する場合の注意**: Drive 配下（`G:\` や `J:\`）に clone すると `npm install` が EBADF/EPERM で失敗します。symlink/junction も Drive の仮想ボリューム上では張れないため、**実体は `C:\work\appsheet-mcp\` 等のローカルディスクに配置**し、参照側プロジェクトの `.mcp.json` から絶対パスで指す運用が安全です。

### パターン C: チームで共有する場合（環境変数化）

メンバーごとに clone 先が異なる場合は、`${VAR}` で環境変数を展開できます（Claude Code 公式仕様）。

```json
{
  "mcpServers": {
    "appsheet": {
      "command": "node",
      "args": ["${APPSHEET_MCP_DIR}/dist/index.js"],
      "cwd": "${APPSHEET_MCP_DIR}"
    }
  }
}
```

各メンバーは OS の環境変数に `APPSHEET_MCP_DIR=C:\work\appsheet-mcp`（自分の clone 先）を設定。Windows なら `setx APPSHEET_MCP_DIR "C:\work\appsheet-mcp"`、macOS/Linux なら `~/.zshrc` 等に `export APPSHEET_MCP_DIR=...` を追記。

## 提供ツール

### Phase 0（オンボーディング・事前チェック）

| ツール | 概要 |
|--------|------|
| `appsheet_preflight` | **会話の最初に必ず呼ぶ**。AppID/Key/Cookie/snapshot/API 到達を一括チェックし、未充足項目と次手順を返す（副作用なし） |
| `appsheet_run_cookie_init` | 初回 Cookie 取得を MCP 経由で起動。**`userConsent: true` 必須**。1 回目は `consentPrompt` 返却で確認、2 回目で実行（headed Chromium が開く） |

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

##### 方法 A: Playwright で自動化 (推奨)

```bash
# 初回 1 回だけ実行: headed Chromium が開くので Google アカウントでログイン
npm run cookie:init
```

セッションは `playwright-userdata/` に永続化される (`.gitignore` 済み)。以降:

- MCP 内から **`appsheet_refresh_cookie`** ツールを呼び出すと headless で Cookie を更新 → `.env` を書き換え
- Google OAuth セッションが切れたら再度 `npm run cookie:init` で headed login をやり直す

`.env` に `APPSHEET_LOGIN_ACCOUNT=<your-account>@example.com` を入れておくと Google アカウント選択画面をスキップできる（複数アカウントを Chromium に保存している場合に便利）。

##### 方法 B: 手動コピー (フォールバック)

1. AppSheet Editor を開く（Google ログイン状態）
2. F12 → Network タブ → 任意の編集を 1 回行ってから Save
3. `saveapp` リクエストを右クリック → Copy → **「Copy as cURL (bash)」**
4. 結果を `samples/saveapp.curl.txt` に貼り付け
5. cURL の `-b '...'` 部分を抽出して `.env` の `APPSHEET_COOKIE=...` に設定

Cookie 有効期限は約 30 日。失効時は再取得が必要 (Playwright 経由なら `appsheet_refresh_cookie` を 1 回呼ぶだけ)。

#### saveapp の HAR キャプチャ自動化（新ツール開発用）

新しい Editor 操作（Bot / Step / Task の追加など）を `appsheet-mcp` に取り込みたいとき、Editor で実機操作したときに飛ぶ `/api/saveapp` の payload を自動収集する仕組みを用意してある。手で DevTools → HAR エクスポートする必要はない。

```bash
npm run capture-har -- \
  --label=add_data_action_step \
  --app=<APP_ID> \
  --app-name=<INTERNAL_APP_NAME>
```

オプション:

| 引数 | 説明 |
|------|------|
| `--label=<string>` | 保存ファイル名のラベル（必須） |
| `--app=<APP_ID>` | 対象 App の UUID（必須） |
| `--app-name=<string>` | Editor ディープリンクに使う internal app name（例: `介護カルテシステム-995205666`）。指定すると対象アプリの Editor が直接開く |
| `--account=<email>` | Google アカウント直指定。省略時は `.env` の `APPSHEET_LOGIN_ACCOUNT` |
| `--out=<dir>` | 保存先（default: `samples/captured/`） |
| `--max=<n>` | 最大キャプチャ件数（default: 50） |
| `--timeout=<minutes>` | セッション全体のタイムアウト分（default: 30） |

挙動:

1. headed Chromium が起動し、Editor が開く
2. ユーザーは普段どおり Bot / Step / Task を追加して **Save** するだけ
3. `POST /api/saveapp` が飛ぶたびに `samples/captured/<label>-<seq>-<timestamp>.json` に
   - リクエスト URL / メソッド / ヘッダ（Cookie 等は除外）
   - リクエスト body と `appJson` をパースした object
   - レスポンス status / body
   をまとめて自動保存
4. ブラウザを閉じるかタイムアウトで終了

これで集めた JSON の `parsedAppJson` 配下を diff すれば、新ツール（例: `add_data_action_step`）の payload 仕様が機械的に把握できる。

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

## 会話パラダイム（Claude Code との対話設計）

このリポジトリは Claude Code との対話で**事故が起きにくいパターン**を仕込んであります（[CLAUDE.md](CLAUDE.md) と各サブエージェント参照）。

| シーン | 質問スタイル | 担当エージェント |
|--------|-------------|----------------|
| 新規開発・新規アプリ・新規テーブル設計 | **オープンクエッション**（要件をヒアリングで広げる） | `appsheet-architect` |
| 既存アプリの編集・式書換・列追加 | **クローズドクエッション**（候補から番号で選ばせる、dry-run → 承認 → apply） | `appsheet-builder` |
| 動作不良・エラーの調査 | クローズド寄り（仮説検証） | `appsheet-debugger` |
| 既存アプリの構造レビュー | クローズド寄り（観点を絞って報告） | `appsheet-reviewer` |
| 新規環境セットアップ | **クローズド中心**（preflight 駆動） | `appsheet-onboarding` |

書込み系ツールはすべて **デフォルト dry-run** で、`apply: true` を付けるには **ユーザーから明示 Y を取ってから** 再実行する設計です。削除・テーブル丸ごと操作は影響範囲を口頭で要約してから確認を取ります。

## Cursor / Claude Code リロードについて

「リロードしてください」プロンプトが出やすいケースの内訳と対処：

| 操作 | リロード必要？ | 理由 |
|------|---------------|------|
| `.env` 更新（Access Key / Cookie 追加） | **不要** | 各ツール呼出時に `process.env` を読むので即反映 |
| Cookie 取得・`appsheet_refresh_cookie` 実行 | **不要** | 動的データ。MCP プロセス内で `process.env.APPSHEET_COOKIE` も更新される |
| `snapshots/*.json` 更新 | **不要** | ツール実行時に読む |
| MCP サーバーのコード更新（新ツール追加・description 変更） | **MCP 再起動のみ**（IDE 全体リロード不要） | 本サーバーは `tools.listChanged: true` を advertise しているので、MCP プロセス再起動後はクライアントが自動再取得 |
| `.mcp.json` 自体の編集 | **必要** | クライアント設定の再読込 |

つまり**日常運用でリロードを要求される場面はほぼありません**。Cursor が頻繁にリロードを促す場合は、`.mcp.json` のパスや環境変数展開の問題（毎回設定が変わって見えている）を疑ってください。

## ライセンス・利用上の注意

- AppSheet Application API は公式ドキュメントの仕様に従う
- Phase 4 の Editor 自動操作は AppSheet 利用規約のグレーゾーン。本番利用前にユーザー側で確認すること
