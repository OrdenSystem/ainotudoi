# appsheet-mcp — Claude 用作業指針

このリポジトリは AppSheet を Claude Code から操作する MCP サーバーです。**プロジェクト非依存**で複数アプリ・複数案件で流用するため、**会話パラダイムを厳守**して事故を防いでください。

## 会話の最初に必ず

新しい会話で AppSheet 関連の作業を始める時は、まず無条件に **`appsheet_preflight`** を呼んでください（副作用なし）。

返り値の：
- `checks` — 環境セットアップの状態
- `nextSteps` — 上から順に潰すべき項目
- `conversationGuide` — 会話パラダイム（必読）

`nextSteps` が空でなければ、**先に `appsheet-onboarding` サブエージェントへバトンタッチ** してください。準備が整っていない状態で書込み系ツールを呼ぶのは禁止。

## 会話パラダイム（最重要）

### 新規開発・新規作成 → オープンクエッション

「テーブル新設 / View 新設 / Bot 新設 / アプリ設計」などは、要件・前提・データソース選択・REF 関係を**ヒアリングで広げる**段階。

- 「どんな業務を自動化したいですか？」「想定ユーザーは誰ですか？」「データ量は？」
- 設計が固まる前に書込みツールを呼ばない
- `appsheet-architect` サブエージェントの守備範囲

### 編集・是正・データ操作 → クローズドクエッション

「既存テーブルの列追加 / 式書換 / レコード追加更新削除 / Action 実行」などは、対象が決まっていて**ミスると影響が出る**段階。

- 「○○テーブルの△△列を××に変更します。よろしいですか？（Y/N）」
- 対象テーブル名・列名・Action 名が**曖昧なら必ず候補列挙してユーザーに番号で選ばせる**：
  - テーブル候補 → `appsheet_get_tables` の結果から
  - 列候補 → `appsheet_get_columns` または `appsheet_get_full_columns` から
  - Action 候補 → `appsheet_get_actions` から
- 推測で名前を渡さない（同名・類似名で誤爆事故を起こすため）
- `appsheet-builder` サブエージェントの守備範囲

## 書込み系ツールの 2 段階ルール

`appsheet_set_*` / `appsheet_add_*` / `appsheet_remove_*` / `appsheet_clone_*` / `appsheet_create_*` 系：

1. **dry-run（apply: false / 省略）で diff を取得 → ユーザーに見せる**
2. **明示 Y を取ったら apply: true で再実行**

絶対にユーザーの明示同意なしに `apply: true` を最初から付けない。

## 削除・破壊系の特別ルール

`appsheet_remove_table` / `appsheet_remove_bot` / `appsheet_remove_view` / `appsheet_delete_records` 等：

1. **影響範囲を口頭で要約**（連動する Action / View / Bot 数 / 影響行数）
2. **ユーザーから「削除する」と明示同意を取る**
3. dry-run で差分確認
4. apply で実行

## Cookie 自動取得の特別ルール

`appsheet_run_cookie_init` は headed Chromium をデスクトップに開く副作用があります。**必ず 2 段階**：

1. **1 回目: `userConsent` を指定せず呼ぶ** → `consentPrompt` が返る → そのままユーザーに見せて Y/N を取る
2. **2 回目: ユーザーが Y なら `userConsent: true` で再実行** → ブラウザが開く

最初から `userConsent: true` を付けるのは禁止。

## エージェント分担

| サブエージェント | 担当 |
|---|---|
| `appsheet-onboarding` | 新規環境セットアップ。preflight → AppID 収集 → 招待確認 → Cookie 取得 → 初回 snapshot |
| `appsheet-architect` | データモデル設計。**書込みしない** |
| `appsheet-builder` | 設計→実装の書込み。dry-run → 承認 → apply の 3 段階 |
| `appsheet-debugger` | 動作不良の調査・原因特定 |
| `appsheet-reviewer` | 既存アプリの構造レビュー |

## ファイルパス参照

- 仕様 → [docs/appsheet-spec.md](docs/appsheet-spec.md)
- 実装手順 → [docs/appsheet-mcp-cookbook.md](docs/appsheet-mcp-cookbook.md)
- 設計判断基準 → [docs/appsheet-best-practices.md](docs/appsheet-best-practices.md)
- 環境変数 → [.env.example](.env.example)

## Cursor / Claude Code リロードについて

`.env` の更新（Access Key 追加 / Cookie 更新）は **MCP プロセス再起動もリロードも不要** です（process.env から動的に読むため）。

- snapshot ファイル（`snapshots/*.json`）の更新も同様。実行時に読む
- Cookie 取得ツール（`appsheet_run_cookie_init` / `appsheet_refresh_cookie`）の実行後もリロード不要
- リロードが本当に必要なのは `.mcp.json` 自体を編集した時だけ
