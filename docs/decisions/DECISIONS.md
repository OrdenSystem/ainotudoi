# DECISIONS Log

このリポジトリで Claude Code（または人間）が行った **指示に無い判断・設計選択・実装** を、
追記のみで時系列に記録します。**過去エントリは書き換えないこと**。

## エントリ形式

```
## YYYY-MM-DD: <判断の要約>
- **理由**: <なぜそうしたか>
- **代替案と却下理由**: <他にあり得た案 / なぜ採らなかったか>
- **影響範囲**: <対象ファイル / モジュール>
- **判断者**: <人間 / Claude Code>
```

---

## 2026-06-10: 初期セットアップ — 8 個の ECC スキルを選定して導入

- **理由**: 指示書 §2「技術スタックに合致する ECC スキルのみ選定」を満たしつつ、起動時の判断ノイズを最小化するため、180 余りのスキルから 8 個を抽出した。
- **選定内訳と根拠**:
  - `architecture-decision-records` — 指示書 §4 の DECISIONS.md 運用に直結
  - `google-workspace-ops` — 主要技術スタックの「スプシ / GAS」に直結
  - `browser-qa` — 実行環境（Chrome ブラウザ）の動作確認
  - `agent-harness-construction` — 指示書 §3 の 3 役エージェント設計に有用
  - `skill-stocktake` — 指示書 §2 の「棚卸し」運用そのもの
  - `security-review` — verifier ロールのセキュリティ観点支援。福祉領域は要配慮個人情報を扱うため必須
  - `verification-loop` — verifier の検証フロー支援
  - `postgres-patterns` — GCP Cloud SQL を PostgreSQL 前提で運用するため
- **代替案と却下理由**:
  - `hookify-rules` … 別ライブラリ向け記法スキルで、Claude Code の `settings.json` の hooks セクションとは無関係のため除外
  - `healthcare-*`（cdss/emr/phi-compliance）… 医療系で福祉とは制度が異なる。誤適用リスクを避け除外
  - 全選定（180個）… 起動時の読み込みと判断ノイズが致命的になるため不可（指示書 §2 / §6 と矛盾）
- **影響範囲**: `.claude/skills/`（8 ディレクトリをコピー）
- **判断者**: Claude Code

## 2026-06-10: `.mcp.json` を空の `mcpServers` で初期化（最小構成）

- **理由**: 指示書 §6「起動パフォーマンス・MCP は必要分のみ」とユーザ選択（「最小構成（appsheet のみ）」と「Google Workspace 系」の併記）を踏まえ、起動軽量化を優先。`appsheet` MCP はグローバル設定経由で既に利用可能、Google Workspace 系は Claude.ai 接続経由で利用可能なため、プロジェクトスコープでの再宣言を見送った。
- **代替案と却下理由**:
  - `appsheet` のみ宣言 … 起動コマンドがグローバル側で確立しており再宣言は重複起動のリスク
  - `appsheet` + Google Workspace 系 5 つを宣言 … 起動遅延要因になりかねず、§6 の精神に反する
- **影響範囲**: `.mcp.json`
- **判断者**: Claude Code
- **再評価条件**: プロジェクト独自の MCP（独自 SQL コネクタ、社内ツール等）が必要になった時点で追記する。

## 2026-06-10: ECC リポジトリの新規 clone を行わず、既存ユーザスコープから流用

- **理由**: `C:\Users\MEDI-LAB\.claude\everything-claude-code\` に ECC（github.com/affaan-m/everything-claude-code）が既に存在し、`origin` も正しい。再 clone は冗長で、`auto mode classifier` のセキュリティ判断にも合致しないため、既存物を信頼ソースとして使用。
- **代替案と却下理由**:
  - 新規 `git clone` … 既存と同一内容になる上、auto mode で拒否された
  - submodule 化 … プロジェクトディレクトリが現時点で git repo ではないため不要
- **影響範囲**: `.claude/skills/`（コピー元として既存パスを参照）
- **判断者**: Claude Code

## 2026-06-10: PreToolUse の context-guard を Bash/PowerShell の両方で動作させる

- **理由**: Windows + PowerShell が前提だが、Claude Code は POSIX 系コマンドを Bash tool 経由で実行することもあるため、両方のシェル経路でガードを発動させる必要がある。PowerShell スクリプトで実装し `powershell.exe` で起動することで、Bash 側からの CLI 実行も検査できる。
- **代替案と却下理由**:
  - Bash スクリプトで実装 … Windows ネイティブ環境で `gcloud` 等のフルパス・引数解析が安定しない
  - matcher を分ける … 同一ロジックの二重保守になる
- **影響範囲**: `.claude/hooks/`, `.claude/settings.json`
- **判断者**: Claude Code

## 2026-06-10: Cloud SQL スキーマ複製 — proxy 認証/接続まわりの実装判断

`hahaha-cloudsql:hopecare-db` のスキーマ（7テーブル/19索引/8制約・データ無し）を `ainotudoisql:hopecare-db-ainotudoi` に複製完了。ハンドオフ手順（`docs/cloudsql-migration-handoff.md`）の実行中、以下を指示外で判断した。

- **判断1: cloud-sql-proxy をポート 5433 → 5435/5436 へ変更**
  - **理由**: 前セッションの残骸 proxy（PID 40092 / `moziokosi-491401:mojiokoshi-db`）がポート 5433 を占有しており、docker コンテナの IPv4 経路が別インスタンスへ誤接続して `password authentication failed` を誘発していた。未使用ポートに退避して衝突を排除。
  - **代替案と却下理由**: 残骸 proxy を kill … 他作業のプロセスの可能性があり破壊的なため不可。
- **判断2: proxy 認証を ADC → `--token`（dev-support のアクセストークン）に切替**
  - **理由**: 既定 ADC は `hopecare-db` への `cloudsql.instances.get` 権限が無く 403。`gcloud auth application-default login` はブラウザ対話が必要。`gcloud auth print-access-token`（アクティブアカウント=dev-support）を `--token` で渡せば非対話で権限を満たせる。
  - **代替案と却下理由**: ADC 再ログイン … 対話的でハンドオフの自動化を阻害。
- **判断3: `gcloud sql instances create` で `--region` を外し `--zone=asia-northeast1-b` のみ指定**
  - **理由**: ハンドオフ記載コマンドは `--region` と `--zone` 併記だったが gcloud が排他エラー（exit 2）。zone 指定でリージョンは導出される。
- **判断4: 移行先 postgres パスワードを英数字のみ 28 文字で生成**
  - **理由**: 元パスワードの特殊文字（`#`/`!` 等）がシェル設定時に変質した疑いがあり認証で長時間ハマったため、再発防止に shell-safe な英数字限定とした。`.env.local`（gitignore 済み）に保存。
- **判断5: import 時 `psql -v ON_ERROR_STOP=1`**
  - **理由**: スキーマ適用の途中失敗を確実に検出するため（既定の継続実行では部分適用を見逃す）。
- **影響範囲**: `gas/_schema/hopecare-schema.sql`（新規）, `.env.local`（新規・gitignore）, `docs/cloudsql-migration-handoff.md`（進捗更新）
- **判断者**: Claude Code
- **フォローアップ（推奨）**: 元 `hopecare-db` の postgres パスワードはチャット履歴に露出したため `gcloud sql users set-password` でローテート推奨（ハンドオフ既知事項 #2）。

## 2026-06-10: Salesforce OAuth — token_url を My Domain に変更し OAuth コードを堅牢化

GAS `GeminiAPI_App_SF接続_ainotudoi` の SF 認証が `OAUTH_AUTHORIZATION_BLOCKED: Cross-org OAuth flows are not supported`（二次症状として token 交換で `unknown_error / retry your request`）で失敗していた。原因は外部クライアントアプリ `hopecareGAS_pk`（配信=ローカル）に対し汎用 `login.salesforce.com` で認証し、別組織ログイン＝クロス組織と判定されたこと。

- **判断1: `token_url` を `login.salesforce.com` → My Domain `ainotsudoi-gakuen.my.salesforce.com` に変更**
  - **理由**: ローカル配信の外部クライアントアプリは自組織でのみ有効。My Domain でログイン先組織を固定してクロス組織を解消。
  - **代替案と却下理由**: PKCE 実装追加 … 当該アプリは PKCE 要求 OFF だったため不要。`login.salesforce.com` のまま … クロス組織の根本原因なので不可。
- **判断2: `000_fetch.js` の refresh 用 URL ハードコードを廃し `token_url` グローバル参照に統一**
  - **理由**: GAS は全 .js が同一グローバルスコープ。エンドポイントの二重管理によるドリフトを防ぐ。
- **判断3: `doGet` に authorize エラー検出（`e.parameter.error`）と `code` 欠如ガードを追加、`getAccessToken` を `muteHttpExceptions`＋成功時のみ `setProp`、`getMyUrl` を `encodeURIComponent` 化**
  - **理由**: authorize 失敗時に紛らわしい token 段階の二次エラー（line 44）が出るのを防ぎ、原因を直接表示。エラー JSON をプロパティに誤保存する事故も防止。
- **影響範囲**: `gas/GeminiAPI_App_SF接続_ainotudoi/000_OAuth.js`, `gas/GeminiAPI_App_SF接続_ainotudoi/000_fetch.js`
- **判断者**: Claude Code
- **注意**: `doGet`（/exec）変更は既存デプロイの新バージョン更新で反映（同 /exec URL を維持し SF コールバックを壊さない）。`token_url` のサンドボックス切替時はこの定数を差し替える。

## 2026-06-10: AppSheet MCP サーバーを `C:\dev\AppsheetMCP` に導入し `.mcp.json` に登録

メインアプリ `HopeCareDX_ainotudoi-443914355`（App ID `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`）を MCP 経由で読むため、AppSheet MCP サーバーを導入した。

- **判断1: MCP サーバーを ainotudoi リポ外（`C:\dev\AppsheetMCP`）に clone**
  - **理由**: 当サーバーは「複数プロジェクト共用の横断ツール」設計（README）。ainotudoi リポに同梱すると肥大化・責務混在。READMEパターンB（別リポを絶対パス参照）を採用。`git clone https://github.com/lab-masuyama/AppsheetMCP.git`。
  - **代替案と却下理由**: ainotudoi 配下に同梱（パターンA）… 横断ツールの再利用性を損なう。Google Drive 配下配置 … npm install が EBADF/EPERM で失敗するため不可（README 注意書き）。
- **判断2: `.mcp.json` に `appsheet` を絶対パス（`C:/dev/AppsheetMCP/dist/index.js`）で登録**
  - **理由**: CLAUDE.md §5「グローバル ~/.claude.json の MCP に依存しない／プロジェクトスコープで必要分のみ」に従いプロジェクト `.mcp.json` へ明示登録。確認の結果、グローバル設定にも当 MCP は未登録だった（過去 DECISIONS の「グローバル経由で利用可能」は現状と不一致）。
- **判断3: Access Key 等の機密は AppsheetMCP リポ側 `.env`（gitignore 済み）に保存**
  - **理由**: CLAUDE.md の機密管理方針。ainotudoi リポにはコミットしない。サーバーが dotenv で読む正規の置き場所。`APPSHEET_DEFAULT_APP_ID` / `APPSHEET_ACCESS_KEY__<id>` / `APPSHEET_REGION=www` / `APPSHEET_LOGIN_ACCOUNT=lab@appsheet.fun` を設定。
- **判断4: `npm run setup`（ECG 同期）はスキップ**
  - **理由**: everything-claude-code は既に `~/.claude/` に同梱済み（2026-06-10 既存判断）。appsheet-* サブエージェントも本セッションで稼働確認済みのため再同期不要。
- **影響範囲**: `.mcp.json`（appsheet 追記）, `C:\dev\AppsheetMCP\`（新規 clone・リポ外）, `C:\dev\AppsheetMCP\.env`（機密・gitignore）
- **判断者**: Claude Code
- **注意**: MCP サーバーは Claude Code 起動時に読込まれるため、登録は**再起動後に有効化**。再起動後 `appsheet_preflight` で疎通確認する。書込み(Phase 4)を使う場合は `npm run cookie:init` で Cookie 取得が別途必要（約30日で失効）。
