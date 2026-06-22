# 技術調査ノート — Cycle 001

> 調査日: 2026-05-28 / 調査者: welfare-planner
> 各項目とも権威ソース 1〜2 件で停止。深追いはせず spec.md の根拠リンクとして利用。

## R1. AppSheet のデータソース（CloudSQL / Salesforce）

- AppSheet は **Cloud SQL（MySQL / PostgreSQL）** を公式サポート。AWS RDS、Azure SQL も同等。SQL 系オンプレ接続もサポート（SQL Server / MySQL / MariaDB / PostgreSQL）。
- **Salesforce Objects** はネイティブのデータソースタイプとして公式サポート（OAuth ベース）。
- 公式ヘルプは MySQL / PostgreSQL について「Google Cloud SQL でホストされていれば直接接続可能」と明記。
- 結論: AppSheet → CloudSQL（MySQL or PostgreSQL）と AppSheet → Salesforce の両系統が成立。**現場入力テーブルは CloudSQL、利用者マスタは Salesforce を直参照** という二系統設計が可能。
- 出典:
  - https://support.google.com/appsheet/answer/10106676?hl=en （MySQL）
  - https://support.google.com/appsheet/answer/10106598?hl=en （PostgreSQL）
  - https://solutions.appsheet.com/data-sources

## R2. Salesforce Health Cloud / Service Cloud の障害福祉適合性

- **Health Cloud** はヘルスケア向け業界クラウド。Patient/Member、ケアプラン、ケアコーディネーション、デバイス連携を提供。日本の障害福祉専用ソリューションは公式には未提供だが、Person Account + ケアプラン構造は障害福祉の「利用者×支給決定×個別支援計画」モデルに転用可能。
- **Service Cloud** は汎用ケース管理。障害福祉のインシデント・苦情管理に転用可能だがケアプランは非対応。
- **Enterprise Edition** は標準オブジェクト + カスタムオブジェクトで「利用者・契約・支給決定・サービス記録」を独自モデル化する選択肢。コスト最安だが業界対応は薄い。
- 結論: Cycle 1 仮定は **Enterprise Edition + Person Account 有効化** とする（Health Cloud は要見積もり高額のためリスク台帳）。Cycle 2 で Health Cloud との比較検討を継続。
- 出典:
  - https://www.salesforce.com/healthcare/cloud/
  - https://trailhead.salesforce.com/content/learn/modules/health-cloud-for-providers/meet-health-cloud-for-providers

## R3. GAS V8 ランタイムと Salesforce 連携

- **Rhino ランタイムは 2026-01-31 で実行停止済み**。V8 ランタイムが唯一の選択肢。
- Salesforce 連携の手段:
  - **JSforce**（V8 上で動作可能。OAuth2 / username-password / refresh token フロー対応）
  - 純正 REST API + UrlFetchApp（軽量）
  - Salesforce Connected App 登録は必須（OAuth2 client）
- Salesforce の新セキュリティ要件: **未インストール Connected App は制限**。GAS 側は事業者 Salesforce 組織に Connected App をインストールする前提。
- 結論: GAS は V8 + UrlFetchApp ベースの薄い REST 呼び出しで構成。JSforce は型補完が効かないため Cycle 1 では採用見送り、Cycle 2 で再評価。
- 出典:
  - https://developers.google.com/apps-script/guides/v8-runtime/migration
  - https://jsforce.github.io/start/

## R4. GCP CloudSQL 最新エディションと東京リージョン

- **Cloud SQL Enterprise / Enterprise Plus** の 2 エディション体制。Enterprise Plus は MySQL / PostgreSQL 両対応で最大 3 倍の性能、Near-Zero Downtime 計画メンテナンス対応。
- **asia-northeast1（東京）** で両エディション利用可能。
- 障害福祉中小事業所規模では Enterprise で十分（コスト優先）。Enterprise Plus は将来 SLA 強化時に切替可能。
- 結論: Cycle 1 仮定は **Cloud SQL for MySQL 8.x / Enterprise / asia-northeast1 / db-custom-2-7680**。エンジン採否は MySQL を採用（AppSheet 公式サポート安定 + GAS UrlFetch でも問題なし + 日本市場での運用人材調達容易性）。PostgreSQL の優位（JSONB / 配列型）はサービス記録の自由記述だけのため必須ではない。
- 出典:
  - https://cloud.google.com/blog/products/databases/announcing-the-cloud-sql-enterprise-plus-edition-for-mysql-and-postgresql
  - https://docs.cloud.google.com/sql/docs/mysql/editions-intro

## R5. Claude API 最新モデル ID

- 現行ラインナップ（2026-05 時点）:
  - **Opus 4.7** = `claude-opus-4-7`
  - **Sonnet 4.6** = `claude-sonnet-4-6`
  - **Haiku 4.5** = `claude-haiku-4-5-20251001`
- 注意: `claude-sonnet-4-7` / `claude-haiku-4-7` は **未リリース**。プロンプトキャッシング推奨。
- 結論: 障害福祉システム内 AI 機能（サービス記録のサマリ生成、計画作成補助）は **Sonnet 4.6 を主、Haiku 4.5 を軽量サマリに、Opus 4.7 は計画レビュー時のみ**。Cycle 1 は Sonnet 4.6 1 本で開始。
- 出典:
  - https://platform.claude.com/docs/en/about-claude/models/overview
  - https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions

## まとめ（spec.md §5 への流し込み材料）

| 領域 | 採用 | 主理由 |
|---|---|---|
| 利用者マスタ | Salesforce EE + Person Account | R2 |
| 現場入力 UI | AppSheet | R1（Salesforce/CloudSQL 両接続） |
| バッチ/連携 | GAS V8 + UrlFetchApp | R3 |
| 業務DB | CloudSQL for MySQL 8 / Enterprise / 東京 | R4 |
| AI機能（Cycle 1 スコープ最小） | Claude Sonnet 4.6 | R5 |
