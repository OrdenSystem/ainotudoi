# 障害福祉システム PDCA — 最終レポート（Cycle 1 + Cycle 2）

> 期間: 2026-05-28 〜 2026-05-29
> チーム構成: welfare-planner（Opus / P）/ welfare-implementer（Sonnet / D）/ welfare-verifier（Opus / C/A）
> 対象スコープ: Salesforce + AppSheet + GAS + GCP CloudSQL による障害福祉システム全体アーキテクチャ設計

---

## 1. エグゼクティブサマリ

| 指標 | Cycle 1 | Cycle 2 | 差分 |
|---|---|---|---|
| 総合スコア | 5.38 / 10 | 6.27 / 10 | **+0.89** |
| 判定 | FAIL | FAIL（条件付き合格に近い） | — |
| Critical 件数 | 21 | 11 | **−10** |
| Must 機能数 | 9 | 11（契約・上限管理を追加） | +2 |
| 設計成果物 | 10 ファイル / 2,703 行 | 10 ファイル | — |
| P1 Critical 解消率（C-01〜C-07） | — | **100%（完全 5 / 大半 2）** | — |

**最終判定**: 設計は実装着手の最低限を満たすが、`audit_log` PII 平文（C2-04）の修正が次着手前に必須。スコア目標（≥6.5）は 0.23 ポイント未達。

---

## 2. チーム運用パラダイム

ECC の GAN ハーネス（gan-planner / gan-generator / gan-evaluator）をベースに、障害福祉ドメイン特化の 3 役構成を `.claude/agents/` に作成しました：

- **[welfare-planner](../.claude/agents/welfare-planner.md)** (Opus): 要件・技術選定・受入基準・リスク台帳を spec.md に集約。**コード書かず**。
- **[welfare-implementer](../.claude/agents/welfare-implementer.md)** (Sonnet): spec.md を読み、設計成果物 10 ファイルを **並列ストリームで** 出力。
- **[welfare-verifier](../.claude/agents/welfare-verifier.md)** (Opus): **5 視点（A〜E）クロス検証**でスコアカードと次サイクル提案を出力。

PDCA の引き継ぎは `cycle-NNN/check-act/next-cycle-proposals.md` 1 ファイルに集約し、planner の次サイクル起動時の主入力としました。

---

## 3. Cycle 1 サマリ（5.38 / 10, FAIL）

### 3.1 主な成果

- 9 Must 機能をスケッチ
- Salesforce EE + Person Account / CloudSQL MySQL 8 / AppSheet 単一アプリ / GAS V8 連携の構成決定
- 法務レビュー必要項目 L-01〜L-12 の特定

### 3.2 Critical 21 件の内訳

| 優先度 | 件数 | 代表例 |
|---|---|---|
| P1 | 7 | C-01 鍵管理経路（AES_ENCRYPT 誤実装）、C-03 上限管理未モデル化、C-04 支給決定 SoR 二重定義、C-05 USERSETTINGS 改竄リスク、C-07 GH 夜勤拒否 |
| P2 | 5 | アセスメント／モニタリング欠落、audit_log 改竄防止欠落、契約書管理欠落 |
| P3 | 9 | disability_type 値域不統一、サビ管／サ提責の役職混在、月額コスト試算未記述 |

### 3.3 ファイル一覧

- [Plan: spec.md](cycle-001/plan/spec.md) / [tech-research-notes.md](cycle-001/plan/tech-research-notes.md)
- Do: [01-architecture.md](cycle-001/do/01-architecture.md), [02-data-model.md](cycle-001/do/02-data-model.md), [03-cloudsql-ddl.sql](cycle-001/do/03-cloudsql-ddl.sql), [04-salesforce-objects.md](cycle-001/do/04-salesforce-objects.md), [05-appsheet-tables.md](cycle-001/do/05-appsheet-tables.md), [06-gas-integrations.md](cycle-001/do/06-gas-integrations.md), [07-integration-flows.md](cycle-001/do/07-integration-flows.md), [08-security-and-privacy.md](cycle-001/do/08-security-and-privacy.md), [09-operational-runbook.md](cycle-001/do/09-operational-runbook.md), [10-traceability-matrix.md](cycle-001/do/10-traceability-matrix.md)
- Check & Act: [lens-A〜E.md](cycle-001/check-act/), [scorecard.md](cycle-001/check-act/scorecard.md), [next-cycle-proposals.md](cycle-001/check-act/next-cycle-proposals.md)

---

## 4. Cycle 2 サマリ（6.27 / 10, FAIL）

### 4.1 Cycle 1 → Cycle 2 で達成

- **P1 Critical 7 件すべて設計上解消**（完全 5 件 / 大半 2 件）
- Must を 9 → 11 に拡張（契約管理・上限管理を新規 Must 化）
- AppSheet App ID/Name（`b9e4f84d-…` / `HopeCareDX_ainotudoi-443914355`）を既知前提化
- Cloud Run jobs 採用で GAS 6 分上限問題を解消
- KMS / Secret Manager 一本化（DDL・GAS・Runbook の 3 ファイルで KEK パス文字列共有）
- USERSETTINGS 全廃 → `USEREMAIL() + staff_facility_map`
- `facility_id_map` + `syncFacilitiesFromSF` で SF↔CloudSQL ID マッピング一元化
- 月額コスト試算（500 名 ≈ ¥328,200/月）、PITR 9 ステップ手順表、6 障害シナリオ × 3 列 Runbook

### 4.2 残課題（Critical 11 件）

| # | 優先度 | タイトル |
|---|---|---|
| **C2-01** | P1 | アセスメント／モニタリング／担当者会議の CloudSQL ミラー DDL 欠落（AppSheet から読み書き不能） |
| **C2-02** | P1 | `UpperLimitFacility__c` 等 SF 上限管理オブジェクトが 04 未定義（受入基準虚偽） |
| **C2-03** | P1 | AppSheet 由来更新の `audit_log` 経路空欄（Bot/Webhook スケッチ無し） |
| **C2-04** | P1 | **`audit_log.before_json` への要配慮 PII 平文 → WORM 5 年保持で削除不能化（リグレッション、最重要）** |
| **C2-05** | P1 | SF User → CloudSQL `staff` 同期関数空欄（Security Filter 前提テーブル投入経路不在） |
| **C2-06** | P1 | `v_allotment_usage` のサービス種別 JOIN 欠落（クロス汚染） |
| C2-07 | P2 | Bot 通知本文の PII（リグレッション） |
| C2-08 | P2 | 身体拘束記録専用エンティティ欠落（減算リスク／リグレッション） |
| C2-09 | P2 | 保護者・成年後見人エンティティ未対応 |
| C2-10 | P3 | SF ライセンス内訳が単一区分でコスト試算が脆弱 |
| C2-11 | P3 | Cloud Run jobs `scheduleResumption` の再実行粒度不一致 |

### 4.3 ファイル一覧

- [Plan: spec.md](cycle-002/plan/spec.md) / [tech-research-notes.md](cycle-002/plan/tech-research-notes.md)
- Do: [01](cycle-002/do/01-architecture.md), [02](cycle-002/do/02-data-model.md), [03](cycle-002/do/03-cloudsql-ddl.sql), [04](cycle-002/do/04-salesforce-objects.md), [05](cycle-002/do/05-appsheet-tables.md), [06](cycle-002/do/06-gas-integrations.md), [07](cycle-002/do/07-integration-flows.md), [08](cycle-002/do/08-security-and-privacy.md), [09](cycle-002/do/09-operational-runbook.md), [10](cycle-002/do/10-traceability-matrix.md)
- Check & Act: [lens-A〜E.md](cycle-002/check-act/), [scorecard.md](cycle-002/check-act/scorecard.md), [next-cycle-proposals.md](cycle-002/check-act/next-cycle-proposals.md)

---

## 5. 次プロジェクト着手前にやること（優先順）

| # | 項目 | 出典 |
|---|---|---|
| 1 | **`audit_log` の要配慮 PII マスキング方針策定**（C2-04） — JSON マスク or 列除外 or 別バケット分離。WORM 5 年保持と両立する手順を確定。 | cycle-002/check-act/scorecard.md §リグレッション最重要 |
| 2 | アセスメント／モニタリング／担当者会議の CloudSQL ミラー DDL 追加（C2-01） | 同上 P1 |
| 3 | `UpperLimitFacility__c` 系 SF オブジェクトの追加定義（C2-02） | 同上 P1 |
| 4 | AppSheet → audit_log の Bot/Webhook 実装スケッチ（C2-03） | 同上 P1 |
| 5 | `syncStaffFromSF` 関数の実装と GAS トリガー設計（C2-05） | 同上 P1 |
| 6 | `v_allotment_usage` に `service_type` JOIN 追加（C2-06） | 同上 P1 |
| 7 | 法務レビュー手配: L-13 上限管理結果票の電子授受、L-14 利用者署名電子化、L-15 監査ログ保存期間、L-16 Claude API 海外サーバ、L-17 SF Shield 非採用の説明責任 | cycle-001/check-act/next-cycle-proposals.md §5 |
| 8 | GCP コピー元プロジェクトの schema 取得 → cycle-001/03-cloudsql-ddl.sql との突き合わせ | context/existing-assets.md §4 |

---

## 6. 運用上の知見

### 6.1 うまく機能した

- **PDCA 引き継ぎを 1 ファイル（next-cycle-proposals.md）に集約** → planner の次サイクル起動が迷わない
- **5 視点クロス検証** → 単一視点では見落とす横断的整合性（C-04 二重定義など）を捕捉
- **traceability-matrix.md を最後に書く** → Must 受入基準と成果物の対応漏れを検出
- **モデル割り当て**: Plan/CA は Opus（深い推論）、Do は Sonnet（量を捌く）の使い分けが効いた

### 6.2 改善余地

- 本セッションでは subagent 並列起動（Task tool 5 並列）が verifier 内部で**順次実行**になった。本来は単一メッセージ内で 5 並列発火させると 5 倍速で完了する想定。
- API 過負荷（HTTP 529）で 2 回の中断発生。長時間プロンプトはチェックポイント保存設計が必要。
- 実 AppSheet アプリへの live inspection は Cycle 2 で設計検証する余地があったが、MCP プロセスの env キャッシュ事象で活用不能。Claude Code 再起動が必要。
- リグレッション（Major → Critical 格上げ）が 3 件発生。Cycle 1 Major も Cycle 2 で着手すべきだった。

### 6.3 エージェント定義の今後

- `.claude/agents/welfare-{planner,implementer,verifier}.md` は Git 管理することでチーム共有可能。
- 新規セッションでは subagent_type として直接呼び出せるようになる（本セッションでは general-purpose で代用）。
- 別の福祉系プロジェクトでも `context/` 配下を差し替えれば再利用可能。

---

## 7. 関連ファイル

- エージェント定義: [.claude/agents/welfare-planner.md](../.claude/agents/welfare-planner.md), [welfare-implementer.md](../.claude/agents/welfare-implementer.md), [welfare-verifier.md](../.claude/agents/welfare-verifier.md)
- チーム README: [welfare-pdca/README.md](README.md)
- プロジェクトブリーフ: [context/project-brief.md](context/project-brief.md)
- 既存資産: [context/existing-assets.md](context/existing-assets.md)
- ECC 参考実装: `C:/tmp/ECC-ref/agents/gan-{planner,generator,evaluator}.md`
