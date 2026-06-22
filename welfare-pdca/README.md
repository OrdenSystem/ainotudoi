# 障害福祉システム PDCA 開発チーム

このディレクトリは、3 エージェント体制で障害福祉システムのアーキテクチャを反復改善するための作業領域です。

## チーム構成

| 役割 | エージェント | モデル | PDCA | 主な成果物 |
|---|---|---|---|---|
| 計画 | `welfare-planner` | opus | **P** | `cycle-NNN/plan/spec.md`、技術選定根拠 |
| 実装 | `welfare-implementer` | sonnet | **D** | `cycle-NNN/do/01..10` 設計成果物 |
| 検証 | `welfare-verifier` | opus | **C/A** | スコアカード、次サイクル提案 |

## ディレクトリ構造

```
welfare-pdca/
├── README.md                       # 本ファイル
├── context/
│   ├── project-brief.md            # ユーザー要求の固定化
│   └── existing-assets.md          # 既存 AppSheet/Salesforce/GAS と GCP コピー元
├── cycle-001/
│   ├── plan/
│   │   ├── spec.md
│   │   └── tech-research-notes.md
│   ├── do/
│   │   ├── 01-architecture.md
│   │   ├── 02-data-model.md
│   │   ├── 03-cloudsql-ddl.sql
│   │   ├── 04-salesforce-objects.md
│   │   ├── 05-appsheet-tables.md
│   │   ├── 06-gas-integrations.md
│   │   ├── 07-integration-flows.md
│   │   ├── 08-security-and-privacy.md
│   │   ├── 09-operational-runbook.md
│   │   └── 10-traceability-matrix.md
│   └── check-act/
│       ├── lens-A.md ... lens-E.md   # 並列クロス検証
│       ├── scorecard.md
│       └── next-cycle-proposals.md
├── cycle-002/  …同構造
└── final-report.md                  # 全サイクル終了後
```

## サイクル実行ルール

1. **新規 / 再計画**: `welfare-planner` が `context/` と前サイクルの proposals を読み、`spec.md` を生成。
2. **実装**: `welfare-implementer` が `spec.md` を読み、独立ストリームを並列で起こして `do/` を埋める。
3. **検証**: `welfare-verifier` が 5 視点（A〜E）を並列クロス検証し、スコアカードと次サイクル提案を出す。
4. 2 周以上回す。サイクルを跨ぐ唯一の入出力は `next-cycle-proposals.md` と `scorecard.md`。

## 判定基準

| 判定 | 条件 |
|---|---|
| PASS | 総合スコア ≥ 8.0 かつ Critical Issue ゼロ |
| CONDITIONAL | 6.5〜8.0、または Critical あり |
| FAIL | < 6.5 |

## 実装範囲のスコープ

- 本プロジェクトの成果は **設計図中心**（Markdown / DDL / 図表）。
- 実 AppSheet / Salesforce / GAS は別途準備済み — 本ディレクトリでは触らない（ユーザー明示指示時のみ）。
- GCP は新規プロジェクトだが、別プロジェクトのコピーで構築するため、コピー元仕様を `context/existing-assets.md` に記録する。

## 関連エージェント定義

- [.claude/agents/welfare-planner.md](../.claude/agents/welfare-planner.md)
- [.claude/agents/welfare-implementer.md](../.claude/agents/welfare-implementer.md)
- [.claude/agents/welfare-verifier.md](../.claude/agents/welfare-verifier.md)
