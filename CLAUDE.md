# プロジェクトコンテキスト

- **目的**: 障害福祉事業所のシステム構築
- **主要技術**: AppSheet / Salesforce / GCP Cloud SQL / Google スプレッドシート / Google Apps Script (GAS)
- **実行環境**: Chrome ブラウザ（クライアント）、Windows 11 + PowerShell（開発端末）
- **リポジトリパス**: `C:\dev\ainotudoi`

---

## 1. シェル運用ルール（重要）

- 開発端末は **Windows + PowerShell** が前提。
- シェルスクリプトでは POSIX 専用構文を使わないこと:
  - `/dev/null` → PowerShell では `$null`（Bash 経由なら可、混在時は明示）
  - `$VAR` の素朴展開 → PowerShell では `$env:VAR`
  - 環境変数前置 `VAR=x cmd` → PowerShell では `$env:VAR='x'; cmd`
- Bash 経由 (`bash -c` / `Bash` tool) で書く場合は冒頭に `#!/usr/bin/env bash` 等を明記する。

---

## 2. CLI 認証コンテキスト（必ず専用 context で動かす）

このリポジトリの CLI は **必ず** プロジェクト専用 context で実行する。グローバル既定の流用は禁止。

- **Single Source of Truth**: `.claude/project-context.env`
- **ガード**: `.claude/hooks/pretooluse-context-guard.ps1` が `PreToolUse` 時に検証し、ドリフト時は exit 2 で block。
- **一時バイパス**: `.claude/.skip-context-check` ファイルを作成すると PreToolUse ガードをスキップ（commit 禁止、`.gitignore` 登録済み）。

### 期待値テーブル（`.claude/project-context.env` を真とする）

| CLI | 期待値キー | 用途 |
|---|---|---|
| `gcloud` / `gsutil` / `bq` | `GCLOUD_PROJECT`, `GCLOUD_ACCOUNT`, `GCLOUD_REGION`, `GCLOUD_CONFIG` | Cloud SQL / GCS / BigQuery |
| `gh` | `GH_HOST`, `GH_USER` | GitHub 操作 |
| `firebase` | `FIREBASE_PROJECT` | Firebase（使う場合） |
| `sf` / `sfdx` | `SF_ORG_ALIAS`, `SF_USERNAME` | Salesforce CLI |

### ドリフト時の復旧コマンド（例）

```powershell
# gcloud を専用 config に切替
gcloud config configurations activate $env:GCLOUD_CONFIG

# gh アカウント切替
gh auth switch --user $env:GH_USER

# Salesforce
sf config set target-org $env:SF_ORG_ALIAS
```

---

## 3. エージェント運用

3 役（Opus）で進める。詳細は `.claude/agents/*.md` を参照。

| 役割 | ファイル | 出力先 |
|---|---|---|
| planner | `.claude/agents/planner.md` | `docs/plans/*.md` |
| implementer | `.claude/agents/implementer.md` | コード |
| verifier | `.claude/agents/verifier.md` | レビュー所見（修正はしない） |

ワークフロー: **要件提示 → planner → 承認 → implementer → verifier → 必要なら差し戻し**

横断知識は各 `.claude/agent-memory/<name>/MEMORY.md` に蓄積。

---

## 4. 自律判断の履歴化

Claude Code が **指示に無い判断・設計選択・実装** を行った場合、
必ず `docs/decisions/DECISIONS.md` に **追記のみ** で記録すること（過去エントリは書き換えない）。

エントリ形式: `日付 / 判断の要約 / 理由 / 代替案と却下理由 / 影響範囲（ファイル）`

---

## 5. 起動運用

- **MCP は最小**: `.mcp.json` で必要分のみ有効化。グローバル `~/.claude.json` 側の MCP には依存しない。
- **rules / docs の重複**: 同名・同内容を二重に読み込ませない。`CLAUDE.md` は肥大化させずリンクで逃がす。
- **ターミナル自動復元には依存しない**: Cursor のワークスペース・インデックス／LSP が落ち着いてから手動で `claude` を起動する。
  - 参考: `"terminal.integrated.enablePersistentSessions": false`
- **SessionStart hook はノンブロッキング**: 軽い冪等 activate のみ。外部 CLI 呼び出しは最小化。

---

## 6. 参照ドキュメント

- `docs/decisions/DECISIONS.md` … 自律判断ログ（追記のみ）
- `docs/plans/` … planner 出力
- `.claude/agents/` … エージェント定義
- `.claude/skills/` … 導入済み ECC スキル一覧
- `.claude/project-context.env` … CLI 期待値の Single Source of Truth
