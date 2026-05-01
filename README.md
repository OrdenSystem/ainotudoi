# appsheet-mcp

AppSheet を Claude Code から操作するための MCP サーバー（Model Context Protocol）。

## 目的

GCP / Salesforce / SQL は Claude Code から API 経由で操作できるが、AppSheet には公式の Metadata API が無いため手動作業が残る。本サーバーは：

- **Phase 1**：AppSheet Application API v2（公式・データ CRUD）を MCP ツールとして提供 ✅
- **Phase 2**：AppSheet 内部 OpenAPI スナップショットからテーブル/列構造・型・enum を取得 ✅
- **Phase 3**：Editor 直接操作で式・Action・Bot/Automation を取得（Playwright・予定）
- **Phase 4**：Editor 直接操作で式更新・Action/Bot のトグル（実験的・予定）

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

## 動作確認

```bash
npm run build
node dist/index.js
# stdin から MCP プロトコルでメッセージを流すか、Claude Code から呼ぶ
```

## ライセンス・利用上の注意

- AppSheet Application API は公式ドキュメントの仕様に従う
- Phase 4 の Editor 自動操作は AppSheet 利用規約のグレーゾーン。本番利用前にユーザー側で確認すること
