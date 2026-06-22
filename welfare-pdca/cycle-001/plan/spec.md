# 障害福祉システム — サイクル 001 仕様書

> Brief: "Salesforce + AppSheet + GAS + GCP CloudSQL で障害福祉サービス事業所の業務（利用者管理／サービス記録／請求準備）を一気通貫支援する基盤を設計する"
> 前サイクルからの主な変更: 本サイクルは PDCA 1 周目のため該当なし。

## 1. Vision

中小規模の障害福祉サービス事業所（生活介護・就労継続支援 B 型・グループホーム等）において、サービス管理責任者・生活支援員・請求担当が **1 つの導線（AppSheet）から利用者情報・サービス記録・支給決定残量を確認でき、月次の国保連請求準備までを内部で完結** できる状態を、設計図ベースで確定する。1 サイクル目では「動く設計」を出し、Cycle 2 で福祉業界要件・運用観点を強化する。

## 2. Scope

### In scope
- 利用者マスタ（基本情報・受給者証・支給決定情報）の管理モデル
- 個別支援計画と支援目標の管理モデル（最小フィールド）
- 日次サービス提供記録（誰が・どの利用者に・どのサービスを・何分提供したか）
- スタッフ・シフトの管理モデル（最小）
- 月次請求準備データ（サービスコード × 日数 × 単位数 × 加算減算）— **外部国保連連携の手前まで**
- Salesforce ⇄ GAS ⇄ CloudSQL ⇄ AppSheet の高レベル連携設計
- セキュリティ・個人情報保護方針（保管位置・暗号化・アクセス制御）

### Out of scope（将来サイクル送り）
- 国保連 CSV 出力フォーマットの完全仕様（報酬告示の最新差分追従が必要）
- 請求エラー時の自動リトライ・差戻し UI
- 帳票印刷レイアウト
- モバイル端末ネイティブアプリ
- 利用者家族向けポータル
- 加算減算判定ロジックの完全実装（Cycle 2 で骨子のみ）
- 多事業所横断レポーティング（BI 層）

## 3. ステークホルダーと前提

### 利用ユーザー
| 役割 | 主要操作 |
|---|---|
| サービス管理責任者 | 利用者登録、個別支援計画作成、月次集計確認 |
| 生活支援員 | 日次サービス記録入力、利用者情報参照 |
| シフト管理者 | スタッフ・シフト登録 |
| 請求担当 | 月次請求準備データのレビュー、国保連向けエクスポート |
| 事業所管理者 | アクセス権限管理、監査ログ確認 |

### 法令前提（**条文判断は本プロジェクト範囲外。法務レビューフラグのみ**）
- 障害者総合支援法（支給決定情報、サービス等級、受給者証番号の管理）
- 個人情報保護法（要配慮個人情報＝障害種別・支援内容の取扱い）
- 障害福祉サービス等報酬告示（加算減算判定の根拠 — Cycle 1 では構造のみ）

### 既存資産前提（`existing-assets.md` 由来）
- AppSheet AppID は未受領 → 「障害福祉現場入力 UI 用の単一アプリ」を仮定
- Salesforce エディションは未定 → **Enterprise Edition + Person Account 有効化** を仮定（根拠: tech-research-notes.md R2）
- GAS は V8 ランタイム前提（Rhino は 2026-01-31 で停止済み）
- CloudSQL は別プロジェクトコピーで構築。コピー元 schema は未提供 → DDL は本サイクルで新規設計
- Region: `asia-northeast1`（東京）

## 4. アーキテクチャ方針（高レベル）

### System of Record（SoR）
- **Salesforce**: 利用者マスタ（Person Account）、支給決定、個別支援計画、契約、苦情・インシデント
- **CloudSQL (MySQL)**: 日次サービス提供記録、シフト、スタッフ勤怠、請求準備データ、システム監査ログ

### System of Engagement（SoE）
- **AppSheet**: 現場入力 UI（記録入力・利用者検索・シフト確認・月次集計プレビュー）— **CloudSQL を主データソース、Salesforce を読取専用の参照ソース** として接続
- **GAS**: 連携バッチ（Salesforce ⇄ CloudSQL の差分同期、月次集計バッチ、外部請求システム向け CSV 生成）

### 連携経路と頻度
| From | To | 方向 | 頻度 | 手段 |
|---|---|---|---|---|
| Salesforce | CloudSQL | 一方向（マスタ配信） | 1 時間ごと差分 + 手動全件 | GAS V8 + UrlFetchApp + Salesforce REST API |
| CloudSQL | Salesforce | 一方向（集計連携） | 日次バッチ | GAS V8 + UrlFetchApp |
| AppSheet | CloudSQL | 双方向（CRUD） | リアルタイム | AppSheet 公式 MySQL コネクタ |
| AppSheet | Salesforce | 読取のみ | リアルタイム | AppSheet 公式 Salesforce コネクタ |
| GAS | Claude API | 必要時 | オンデマンド | UrlFetchApp + `claude-sonnet-4-6` |

### 採用しない選択肢と理由
- **CloudSQL を SoR にしない（マスタ）**: 障害福祉では監査対応と権限細粒度が要件、Salesforce 標準機能（Field-Level Security / Sharing Rule / Audit Trail）の方が短期実装で堅牢
- **AppSheet DB / Google Sheets を主データ層にしない**: 件数・履歴保持・SQL JOIN 要件で限界
- **Cloud Functions / Cloud Run の採用見送り**: 既存資産 GAS の運用人材確保済み（前提）、追加学習コスト回避
- **PostgreSQL 不採用**: 業界普及度と運用人材調達容易性で MySQL（R4）
- **Health Cloud 不採用（Cycle 1）**: ライセンス費高、Cycle 2 で再評価

## 5. 技術選定（根拠つき）

| 領域 | 採用 | 代替候補 | 採用理由（最新調査ベース）| 出典 |
|---|---|---|---|---|
| 利用者マスタ | Salesforce EE + Person Account | Health Cloud / 自作 RDB | R2: Person Account が「個人客＝利用者」モデルに直接対応。Health Cloud は Cycle 2 で再検討 | tech-research-notes.md#R2 |
| 現場入力 UI | AppSheet | PowerApps / 自作 React | R1: Salesforce / CloudSQL 両方を公式コネクタで接続可能。コードレスで福祉現場向け改修速度が出る | tech-research-notes.md#R1 |
| バッチ・連携 | GAS V8 + UrlFetchApp | Cloud Functions / Cloud Run / JSforce | R3: 既存資産前提、V8 はサポート継続、UrlFetchApp で Salesforce REST 呼び出し可。JSforce は Cycle 2 評価 | tech-research-notes.md#R3 |
| 業務 DB | CloudSQL for MySQL 8.x / Enterprise / asia-northeast1 / db-custom-2-7680 | PostgreSQL / Enterprise Plus | R4: 中小事業所コスト適合、AppSheet 公式サポート安定、人材調達容易 | tech-research-notes.md#R4 |
| AI 機能（最小） | Claude `claude-sonnet-4-6` | Opus 4.7 / Haiku 4.5 / Gemini | R5: コスト性能比、サービス記録要約・個別支援計画ドラフト生成に適合。プロンプトキャッシング前提 | tech-research-notes.md#R5 |

## 6. 機能リスト（優先順）

### Must（このサイクルで設計成果物として完成）

1. **利用者マスタ管理**: Salesforce Person Account を拡張し、受給者証番号・支給決定・障害種別・緊急連絡先を保持。AppSheet から読取・GAS で CloudSQL に同期。
   - 受入基準: Salesforce オブジェクト/フィールド定義（[`do/04-salesforce-objects.md`](../do/04-salesforce-objects.md)）に 全フィールド名・型・必須/任意・FLS 方針が記載され、PII フィールドが特定可能なこと
2. **個別支援計画モデル**: 計画期間・支援目標（複数）・モニタリング周期・サービス管理責任者の関係を Salesforce カスタムオブジェクトで設計。
   - 受入基準: Person Account との Lookup 関係・期間バリデーション・必須項目が DDL/オブジェクト定義に明示
3. **日次サービス提供記録**: 誰が（スタッフ）・どの利用者に・何のサービスを・開始/終了時刻・提供場所・特記事項を CloudSQL に保存。AppSheet で入力。
   - 受入基準: `service_records` テーブル DDL に外部キー制約・インデックス（利用者 ID + 提供日）・タイムゾーン（Asia/Tokyo）が明示
4. **支給決定残量計算**: 月内に消費したサービス時間/回数を集計し、受給者証の支給量を超過していないか AppSheet で可視化。
   - 受入基準: 集計 SQL（または GAS 集計ロジックの疑似コード）と AppSheet 側 Slice/View 設計が示され、超過時の警告ルールが明文化
5. **スタッフ・シフトモデル**: スタッフ基本情報・資格区分・所属事業所・シフト（日次）の最小モデル。
   - 受入基準: 1 スタッフが複数事業所兼務可能なリレーション、シフト衝突検出ルールが定義
6. **請求準備データ生成**: 月次バッチで `service_records` を「利用者 × サービスコード × 日数 × 単位数 × 加算減算（骨子）」に集計し `billing_prep` に格納。
   - 受入基準: GAS バッチの I/O 仕様・冪等性・エラー再実行手順が記載。`billing_prep` テーブル DDL 完備
7. **Salesforce ⇄ CloudSQL 同期バッチ設計**: GAS で利用者マスタ・支給決定を 1 時間ごと差分同期。手動全件同期トリガもあり。
   - 受入基準: 同期キー・競合解決ルール・失敗時リトライ方針・実行ログ保存先が記載
8. **セキュリティ・PII 保護方針**: 要配慮個人情報の保管位置・暗号化（保存時/通信時）・アクセス制御マトリクス・監査ログ要件。
   - 受入基準: PII フィールド一覧・各層（Salesforce/CloudSQL/AppSheet/GAS）の権限境界・暗号化方式（CMEK 採否含む）が一覧化
9. **障害時運用 Runbook（最小）**: Salesforce 停止時／CloudSQL 停止時／GAS 連携失敗時の検知・暫定対応・復旧手順。
   - 受入基準: 3 シナリオ × （検知・暫定対応・復旧）が表形式で記述、RPO/RTO 数値仮置きあり

### Should（次サイクル候補）
- Health Cloud との機能比較レビュー
- 加算減算判定ロジックの完全実装
- 国保連向け CSV エクスポート完全フォーマット
- AppSheet 側 AI 機能（記録要約・計画ドラフト）の組込み
- 苦情・インシデント管理（Service Cloud 採否含む）
- BI レポーティング層

### Won't（今回扱わない）
- 利用者家族向けポータル
- 帳票印刷レイアウト
- 多事業所横断 BI ダッシュボード
- スマホネイティブ実装

## 7. 受入基準（verifier が判定する観点）

verifier は本セクションを **6 章 Must 9 項目それぞれの完成度** と並行して判定する。

- **機能完全性**: 6 章 Must 9 項目すべてが `do/01〜10` のいずれかに設計成果物として収まり、リファレンス可能
- **データ整合性**:
  - 主要エンティティ（利用者・個別支援計画・サービス提供記録・スタッフ・シフト・請求準備）の **主キー・一意制約・外部キー** が DDL またはオブジェクト定義で明示
  - Salesforce ⇄ CloudSQL 間の **同期キー**（例: Salesforce Id を CloudSQL に保持）が指定
- **セキュリティ**:
  - 要配慮個人情報（障害種別、支援内容、緊急連絡先 等）の **保管位置一覧** が存在
  - **保存時暗号化**（GCP デフォルト + CMEK 採否）・**通信時暗号化**（TLS 1.2+）が層ごとに明示
  - **アクセス制御マトリクス**（5 ロール × 5 主要オブジェクト）が記載
- **運用性**:
  - 9 番 Must の Runbook で **検知方法・暫定対応・復旧手順** が 3 シナリオ × 3 列で網羅
  - **RPO ≤ 1 時間 / RTO ≤ 4 時間**（仮値）が数字として書かれ、根拠が示される
- **法令適合（範囲制限）**:
  - 法務レビュー必要箇所が **赤フラグとして列挙** されている（個別条文判断はしない）
  - 個人情報保護法における要配慮個人情報の扱いが「保管位置・最小化・アクセス制限」の観点で言及
- **トレーサビリティ**: `do/10-traceability-matrix.md` で 6 章 Must 9 項目それぞれが「どの設計ファイルのどの節で扱われたか」を逆引きできる

## 8. リスク台帳

| ID | リスク | 影響 | 発生可能性 | 対策 |
|---|---|---|---|---|
| R-01 | AppSheet AppID 未受領のままで設計が机上論化 | 設計と実環境の乖離 | 中 | Cycle 2 開始前に AppID を必須化。本サイクルは「単一アプリ前提」を明示しレビュー時に検証 |
| R-02 | Salesforce エディション未確定（EE 仮定）。Health Cloud 必須要件が後から判明する可能性 | 大（再設計） | 中 | Cycle 2 で Health Cloud / EE 比較レビューを Must 化。リスク決定は事業所サイドで実施 |
| R-03 | CloudSQL コピー元 schema 未提供。本サイクルで起こした DDL と既存差分の整合性が後で爆発 | 中 | 高 | DDL に「新規設計版」と明記、Cycle 2 でコピー元との突合タスクを Must 化 |
| R-04 | 障害福祉報酬告示の改定（年次／3 年毎）に追従できない構造になる | 大（毎年改修） | 中 | サービスコード・単位数・加算減算をハードコードせず `service_master` / `addition_master` テーブル化 |
| R-05 | 要配慮個人情報の取扱いが個人情報保護法ガイドラインに不適合 | 大（法令違反） | 低〜中 | 法務レビューフラグを設計成果物に明示。実装前にレビュー必須 |
| R-06 | GAS の 6 分実行上限により月次バッチが時間切れ | 中 | 中 | 月次バッチを利用者単位でチャンク分割、トリガ再実行で継続可能に設計 |
| R-07 | Person Account 有効化は不可逆。後で標準 Account に戻せない | 大 | 低（仮定承認後） | Cycle 1 spec で「有効化前提」を明示し、ユーザー承認を Cycle 2 着手前に取る |
| R-08 | AppSheet の同時編集競合（オフライン同期）でサービス記録の上書き事故 | 中 | 中 | 楽観ロック（updated_at 比較）と「同一スタッフ・同一利用者・同一日」の一意制約で抑止 |
| R-09 | Claude API 利用時の個人情報送信リスク（要配慮 PII 含むサービス記録の AI 要約） | 大 | 中 | Cycle 1 では AI 機能 Must から外す（Should 送り）。Cycle 2 で「PII マスキング前提」設計 |

## 9. implementer への指示（並列化ヒント）

### 並列ストリーム（3 本）
| ストリーム | 担当範囲 | 出力ファイル |
|---|---|---|
| **S1: データモデル & DDL** | 6 章 Must 1, 2, 3, 5, 6 のスキーマ設計 | `do/02-data-model.md`, `do/03-cloudsql-ddl.sql`, `do/04-salesforce-objects.md`, `do/05-appsheet-tables.md` |
| **S2: 連携シーケンス & バッチ** | 6 章 Must 4, 6, 7 のフロー設計 | `do/01-architecture.md`, `do/06-gas-integrations.md`, `do/07-integration-flows.md` |
| **S3: 運用・セキュリティ** | 6 章 Must 8, 9 + 全体トレーサビリティ | `do/08-security-and-privacy.md`, `do/09-operational-runbook.md`, `do/10-traceability-matrix.md` |

### 依存関係
- **S1 が S2 / S3 の前提**: データモデル確定 → 連携フロー設計 → 運用手順 / セキュリティの対象明確化
- S2 と S3 は S1 完了後に並列実行可能
- `do/10-traceability-matrix.md` は **最後に作成**（全 do/01〜09 の参照元として）

### 共通制約
- 全ファイル冒頭に `spec.md` 6 章のどの Must を扱うかを明記
- DDL は MySQL 8.x 構文、文字コードは `utf8mb4`、タイムゾーンは `Asia/Tokyo`
- Salesforce オブジェクトは API 名と表示名を併記、Person Account 拡張は標準 + カスタム項目を区別
- AppSheet 設計は「テーブル / Slice / View / Action / Bot」の 5 観点で記述
- GAS 設計は関数単位の I/O・トリガ種別・実行頻度を表形式で

## 10. このサイクルの「完了」定義

- **6 章 Must 9 項目すべて** が `do/01〜09` のいずれかで設計成果物として実体を持つ
- **7 章 受入基準すべて** が verifier の判定で満たされる
- **8 章 リスク台帳の Critical（R-02 / R-04 / R-05 / R-07 / R-09）** に対し、Cycle 1 で「設計上の予防策」が示されている
- `do/10-traceability-matrix.md` で全 Must が逆引き可能
- verifier 5 視点（A〜E）クロス検証で **総合スコア ≥ 6.5**（Cycle 1 の現実的閾値、Cycle 2 で ≥ 8.0 を狙う）
