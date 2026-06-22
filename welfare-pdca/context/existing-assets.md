# 既存資産と前提（Cycle 1 着手時点のスナップショット）

> このファイルは planner / implementer / verifier が共通の前提として読みます。
> 値が「未定」の項目は、planner が技術調査結果に基づいて**仮定**を立て、verifier 視点 D（福祉業界要件）と E（運用・コスト）で妥当性を判定します。

## 1. AppSheet

| 項目 | 値 |
|---|---|
| App Name | **HopeCareDX_ainotudoi-443914355**（Cycle 1 途中で受領） |
| App ID | **b9e4f84d-f9b9-4376-97f1-83e3b07122e3** |
| Region | `www`（preflight で確認済み） |
| Access Key | `.env` 設定済み（実値は秘匿） |
| Cookie / Editor | 未取得 — 設計フェーズでは不要。書込が必要になったら Cookie 取得を実施 |
| 想定スコープ | サービス提供記録、利用者検索、日報、シフト確認、簡易承認 |
| MCP プロセス反映 | 現セッションでは Access Key が再読込されない事象あり。Live 検査が必要なら Claude Code 再起動推奨 |

## 2. Salesforce

| 項目 | 値 |
|---|---|
| エディション | **未定** — planner は最新調査の上で Health Cloud / Service Cloud / Enterprise Edition のいずれかを根拠つき推奨する |
| Person Account の有効化 | **未定** — 福祉ドメインでの利用者管理に必要なため、planner が有効化前提で設計するか判定 |
| 既存カスタムオブジェクト | **未定** — 「利用者」「契約」「支給決定」「サービス提供記録」「請求」相当の有無を仮定 |
| 共有モデル | **未定** — 事業所単位の見える範囲制限が前提と仮定 |

## 3. Google Apps Script (GAS)

| 項目 | 値 |
|---|---|
| 既存スクリプト | 別途準備済み（プロジェクト外） — 本設計では参照経路（Salesforce / CloudSQL）と関数責務だけを定義する |
| ランタイム | **未定** — planner は最新の V8 ランタイム前提で記述 |
| 認可 | **未定** — 連携先別の OAuth 構成は planner が仮定して設計、verifier がセキュリティ視点で検証 |

## 4. GCP CloudSQL

| 項目 | 値 |
|---|---|
| 構築方針 | **別プロジェクトのコピーで新規構築** |
| コピー元プロジェクト ID / スキーマ | **未提供** — 仕様は planner が以下の仮定で代替 |
| 仮定エンジン | MySQL 8.x（AppSheet 公式サポート + 業界普及度） — planner が PostgreSQL と比較検討し採否を `tech-research-notes.md` に残す |
| 仮定リージョン | `asia-northeast1`（東京） |
| 仮定インスタンス | `db-custom-2-7680` 相当（小〜中規模事業所想定） |
| 主要テーブル仮置き | `users`, `services`, `service_records`, `staff`, `shifts`, `billing_prep` |

## 5. 法令・業界制約（共通前提）

| 項目 | 内容 |
|---|---|
| 個人情報保護法 | 利用者の氏名・住所・連絡先・障害種別・支援内容は要配慮個人情報に該当しうる |
| 障害者総合支援法 | 支給決定情報、サービス等級、受給者証番号の管理が必要 |
| 報酬告示 | 加算/減算判定はビジネスロジックとして CloudSQL 側で持つ前提（請求外部連携） |
| 法務レビュー | 個別条文判断は本プロジェクト範囲外。verifier が「専門家レビュー必要」フラグを立てる |

## 6. このファイルの更新ルール

- ユーザーから具体情報（AppSheet AppID、Salesforce エディション、GCP コピー元 schema 等）を受領したら、本ファイルを差し替える。
- 差し替え後の最初の planner 起動で、`spec.md` の「変更点」セクションに反映を明記する。
