# appsheet-mcp

AppSheet を Claude Code から操作するための MCP サーバー（Model Context Protocol）。

## 目的

GCP / Salesforce / SQL は Claude Code から API 経由で操作できるが、AppSheet には公式の Metadata API が無いため手動作業が残る。本サーバーは：

- **Phase 1**：AppSheet Application API v2（公式・データ CRUD）を MCP ツールとして提供
- **Phase 2**：Google Sheets API + AppSheet Documentation 解析でテーブル構造・式・Action・Bot を取得
- **Phase 3**：Documentation エクスポート自動化（Playwright）
- **Phase 4**：Editor 直接操作で式更新・Action/Bot のトグル（実験的）

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

## 提供ツール（Phase 1）

| ツール | 概要 |
|--------|------|
| `appsheet_find_records` | Find アクションで取得（selector で AppSheet 式可） |
| `appsheet_add_records` | 行追加 |
| `appsheet_edit_records` | 行更新（キー列必須） |
| `appsheet_delete_records` | 行削除 |
| `appsheet_invoke_action` | 任意 Action 実行 |

## 動作確認

```bash
npm run build
node dist/index.js
# stdin から MCP プロトコルでメッセージを流すか、Claude Code から呼ぶ
```

## ライセンス・利用上の注意

- AppSheet Application API は公式ドキュメントの仕様に従う
- Phase 4 の Editor 自動操作は AppSheet 利用規約のグレーゾーン。本番利用前にユーザー側で確認すること
