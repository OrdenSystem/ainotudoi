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

## 2026-06-10: 愛の集い向け GCP API キー（Gemini 制約）を 3 つ発行

GAS の Script Properties にセットする Gemini 用 API キーを、ユーザ指示により発行（ローテーション予備として 3 つ）。

- **判断1: 発行先 GCP プロジェクトを `ainotudoisql` に特定**
  - **理由**: 「愛の集いプロジェクト」の指示に対し、`gcloud projects list` 中で名称一致（ainotudoiSQL）。さらに当プロジェクトに Cloud SQL インスタンス `hopecare-db-ainotudoi`（POSTGRES_15）が存在し、AppSheet のデータソース `愛の集い-SQLdatabase`（PostgreSQL public）と一致することを確認して裏取り。
  - **代替案と却下理由**: アクティブ config が指す `hope-care-ai` … 名称不一致かつ `apikeys.keys.list` 権限拒否で発行不可。`gen-lang-client-*`/`hopecarekibounoie` 等 … 愛の集いとの紐付け根拠なし。
- **判断2: `apikeys.googleapis.com` と `generativelanguage.googleapis.com` を `ainotudoisql` で有効化**
  - **理由**: API キー作成 API が未有効だったため必須。キー制約先（Gemini）も有効化しないと実用にならないため併せて有効化。
- **判断3: 全キーを Gemini（`generativelanguage.googleapis.com`）に API 制約**
  - **理由**: 用途は GAS の GeminiHelper、無制約キーは漏洩時被害が広い。ユーザ選択により制約を採用。
- **発行内容**: displayName `ainotudoi-gas-1/2/3`（UID は `gcloud services api-keys list --project=ainotudoisql` で参照）。**キー文字列は機密のため本ログには記載しない**。GAS は Script Properties 経由で参照、public リポにはコミットしない。
- **影響範囲**: GCP プロジェクト `ainotudoisql`（API 2 件有効化・API キー 3 件新規作成）。リポ内ファイル変更なし。
- **判断者**: Claude Code
- **注意**: 失効は `gcloud services api-keys delete <UID> --project=ainotudoisql`。実行アカウントは `dev-support@ordentier-corp.co.jp`（config `hopecareai`）。CLAUDE.md 期待の config `ainotudoi` は未作成のため `--project` 明示で実行した。

## 2026-06-10: 2つ目の AppSheet アプリ「請求_HopeCareDX_愛の集い」を MCP に登録

メインアプリのコピーで構築した請求アプリ（App Id `f6ddf60e-a346-4d4c-a143-eeb9aed81287`）を MCP で扱えるよう登録した。

- **判断1: Access Key を `C:\dev\AppsheetMCP\.env` に追記（リポ外・gitignore）**
  - **理由**: 既存方針（機密は AppsheetMCP 側 .env）。`APPSHEET_ACCESS_KEY__f6ddf60e-...` を追加。
- **判断2: snapshot は Cookie 直 curl（urllib）で取得しサーバー再起動を待たずに作成**
  - **理由**: 起動中 MCP は .env を起動時1度のみ読むため追記直後は MCP ツールが Access Key 未検出で弾く（既知の落とし穴）。loadApp/openapi は Cookie 認証で叩けるため、`snapshots\appdef-f6ddf60e-...json`（Version 1.000003 / 40 DataSets）と `snapshots\openapi-f6ddf60e-...json`（98 paths）を直接生成。同一アカウント（dev-support@ordentier-corp.co.jp / Owner 443914355）の既存 Cookie をそのまま流用。
  - **代替案と却下理由**: Claude Code 再起動を先に求める … 取得作業を止めずに進めるため後回し（最終的に再起動は必要）。
- **判断3: OpenAPI は Access Key 経由が 401 のため Cookie 経由で取得**
  - **理由**: Access Key 版 openapi が 401（コピー直後で当アプリの「Enable API」未設定の可能性）。Cookie 版は 200。データ行 API（find_records 等）は再起動後に preflight で疎通確認し、401 なら当アプリ側で API 有効化が必要。
- **影響範囲**: `C:\dev\AppsheetMCP\.env`（Access Key 追記）, `snapshots\appdef-f6ddf60e-...json`, `snapshots\openapi-f6ddf60e-...json`。ainotudoi リポのコード変更なし。
- **判断者**: Claude Code
- **注意**: MCP ツールで当アプリを使うには **Claude Code の完全再起動**が必須（.env 再読込）。再起動後 `appsheet_preflight`（appId=f6ddf60e-..., appName=請求_HopeCareDX_愛の集い-443914355）で writeReady と api_reachable を確認する。

## 2026-06-10: 原本 GAS「HopeCare_CloudSQL_移行版」を `モデルサンプル/` にクローンし ainotudoi へ差分マージ

原本（scriptId `1HCWiA28dc1kmqfMF-cDNZAGZsYv9S-ivnDA_5jinwunL_Qqhs1y0r3cP`）を `モデルサンプル/HopeCare_CloudSQL_移行版/` にクローン（git 管理対象）。ユーザ指示「原本の堅牢点と機能ファイルを取り込み、ainotudoi の改善は活かし、移行スクリプトは無視」に従い `gas/HopeCare_CloudSQL_移行版_ainotudoi/` へマージ。マージ方式は Claude Code が判断した。

- **判断1: 200/201/子展開 は原本を丸ごと採用（wholesale）**
  - **理由**: 差分精査の結果これら 3 ファイルは ainotudoi 側に独自改善が無く「機能削除のみ」だった（200=排他ロック削除、201=進捗メモ＋明示カラム削除、子展開=後追い非同期フォールバック撤去）。原本が堅牢版のため丸ごと戻すのが安全かつ自己完結。`selectAsObjects_(...,columns)` は 201 内定義・201 内呼出に閉じており、`columns` は任意引数（未指定で `SELECT *`）と確認済み。
  - **代替案と却下理由**: 行単位の部分マージ … 削除のみのため差分が大きく、かえって誤マージ риск大。
- **判断2: AI帳票出力 のみ部分マージ**
  - **理由**: 当ファイルは原本の `case '帳票スプシ生成' → runHyohyoSpushiGenerate_` と ainotudoi の `nowJST_()`（JST 補正）の**双方を残す**必要があった。ainotudoi 版を base に case のみ復活させ、nowJST_ 改善（6箇所）を保持。
- **判断3: 機能ファイル3本（210_ResetAIContextWorker / ひな型複製_帳票登録_整理 ×2）をコピー、移行スクリプト（migrate_01〜05 / verify_migration / test_cloudsql）は除外**
  - **理由**: ユーザ指示（機能ファイルは取り込み・移行スクリプトは無視）。verify_migration/test_cloudsql は移行・テスト用スキャフォールドのため機能ファイルに含めず除外。
- **判断4: Slack ラベル `HAHAHA__` → `あいのつどい_`**（ユーザ指示）。`appsscript.json` の追加スコープ `cloud-platform`/`userinfo.email` は ainotudoi 改善として維持。
- **検証**: 関数重複定義なし／復活機能の依存関数（runHyohyoSpushiGenerate_・enqueueHyohyoSpushiJob_・updateQueueMemo_・recordPlaceholderPositionsToMaster_step01_・copyExistingSpreadsheetIfNeeded_step01_）すべて定義済み／HAHAHA 残存なし、を grep 検証済み。
- **影響範囲**: `gas/HopeCare_CloudSQL_移行版_ainotudoi/`（5ファイル変更＋3ファイル新規）, `モデルサンプル/HopeCare_CloudSQL_移行版/`（新規クローン）。
- **判断者**: Claude Code
- **未実施（要承認）**: ローカル編集のみ。**本番 GAS への `clasp push` は未実行**（外部反映のためユーザ承認後に実施）。
- **追補（同日, verifier クロス検証 2 体 = APPROVE 後）**:
  - 機能ファイルのうち `ひな型複製_帳票登録_整理.js` / `_CloudSQL.js` は中身が **退役マーカー（全行コメント・実行コード0行）** であり、原本では既存機能コードを上書き停止させる墓標だったが、ainotudoi には停止対象の機能が元々無く純粋なメモ化＋他事業所(HopeCare)リソース ID コメント混入になるため、**ユーザ承認のうえ削除**。取り込む機能ファイルは `210_ResetAIContextWorker.js`（AppSheet「AIリセット」→ request_queue へ RESET_PENDING 転記する生きた Worker）の 1 本のみとした。`210` は 5〜10 分の時間トリガー設置が運用前提（ユーザが設置予定）。
  - **時刻基準が 2 系統併存**: `AIジョブキュー` 系は DB `NOW()`（Cloud SQL サーバ時刻）、CRUD 系は `nowJST_()`（GAS 側 UTC+9h 補正）。今回のマージ意図（既存 JST 補正の維持）に合致するため修正せず、将来デバッグ用に併存を明記。
