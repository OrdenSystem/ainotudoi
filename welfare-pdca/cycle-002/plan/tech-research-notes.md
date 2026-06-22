# 技術調査ノート — Cycle 002

> 調査日: 2026-05-28 / 調査者: welfare-planner
> 各項目とも権威ソース 1〜2 件で停止。深追いはせず spec.md の根拠リンクとして利用。
> Cycle 001 の R1〜R5 は前提として有効。本ファイルは Cycle 002 で追加調査した R6〜R9 のみ記載。

---

## R6. Salesforce Shield Platform Encryption（費用と適用範囲）

### 採否判定
- **Cycle 2: 非採用**。ただし `Cycle 3 検討候補` として残す。

### 費用構造
- Shield Platform Encryption は単体購入で **Salesforce 純額の 20%** が標準価格。
  - 例: 純額 ¥500,000/年 → 暗号化単体だけで ¥100,000/年
  - フル Shield バンドル（Encryption + Data Detect + Event Monitoring + Field Audit Trail）は純額の **30%**
- Developer Edition では検証目的で無償利用可能 → PoC は無償で実施可能。

### 適用範囲
- **標準項目 / カスタム項目を個別選択可能**（データ分類・コンプライアンス要件に応じた選択）。
- **ファイル・添付ファイルは all-or-nothing**: 暗号化ポリシー有効化時に全ファイルが対象。
- Probabilistic 暗号化と Deterministic 暗号化の選択肢あり（後者は等価検索可だが SOQL の一部関数制限あり）。

### 障害福祉ドメインでの判断
- 採用見送り理由 3 点:
  1. 中小事業所想定で 20% 上乗せは ROI が立たない（C-18 月額試算と整合）。
  2. Cycle 2 で必要な PII 暗号化は **CloudSQL 側 CMEK + Cloud Functions による Application-level 暗号化（受給者証番号等の決め打ち項目）** で代替可能。
  3. Person Account の標準項目暗号化は Classic Encryption（無償・上限 175 文字）で当面対応し、要配慮 PII の本格暗号化は CloudSQL 側に集中させる。
- 非採用の説明責任は **L-17 法務レビュー対象** として明示する（リスク台帳 R-15 新設）。

### 出典
- [Shield Pricing | Salesforce](https://www.salesforce.com/platform/shield/pricing/)
- [Salesforce Shield Licensing Guide (Redress Compliance)](https://redresscompliance.com/salesforce-shield-licensing-guide.html)

---

## R7. Cloud SQL MySQL Enterprise の TDE + Cloud KMS 連携

### 採否判定
- **Cycle 2: 採用**。CMEK 必須化を spec.md §8 セキュリティ受入基準に組み込む。

### 仕組み
- Cloud SQL for MySQL は **CMEK（Customer-Managed Encryption Keys）** を Cloud KMS と統合してサポート。
- 鍵階層: ユーザが Cloud KMS で管理する **KEK** が、Cloud SQL 内部の **DEK** を暗号化（envelope 暗号化）。データ復号時は KEK で DEK を復号 → DEK でデータ復号。
- バックアップも同じ CMEK 主キーバージョンで暗号化される（Point-in-time recovery と互換）。

### 実装制約
- **リージョン整合性必須**: Cloud KMS キーリングのロケーションと Cloud SQL インスタンスのリージョンが一致しないとインスタンス作成失敗。
  - 障害福祉システムは `asia-northeast1`（東京）→ KMS キーリングも `asia-northeast1` 必須。
  - **multi-region / global キーは使用不可**。
- **サービスアカウント経由のアクセス**: CMEK を有効化した Cloud SQL インスタンスは、Cloud KMS への鍵アクセスを専用サービスアカウント経由で実施。
- **鍵削除リスク**: KEK バージョン destroy 後はデータ復元不能 → Runbook に「鍵 destroy 前に必ず KEK 退避」を明記。

### 障害福祉ドメインでの判断
- Cycle 1 C-01「鍵管理経路の不在」の中核解決策。
- Application-level 暗号化（受給者証番号などの決め打ち項目）は Cloud Functions + Cloud KMS の `encrypt`/`decrypt` API で実装、`AES_ENCRYPT(?, @@global.secure_file_priv)` の擬似 SQL は全削除。
- KEK ローテーション周期は **90 日**（GCP デフォルト）を採用、Runbook に手順明記。

### 出典
- [Cloud SQL for MySQL CMEK 設定ガイド](https://cloud.google.com/sql/docs/mysql/configure-cmek)
- [Cloud SQL for MySQL CMEK 概要](https://cloud.google.com/sql/docs/mysql/cmek)

---

## R8. Cloud Functions / Cloud Run jobs vs GAS（6 分上限対策）

### 採否判定
- **Cycle 2: ハイブリッド採用**。
  - 軽量・現場連動ジョブ（Salesforce → CloudSQL 差分同期 1 時間ごと）→ **GAS V8 を維持**
  - 重量・長時間ジョブ（月次集計・国保連向け CSV 生成）→ **Cloud Functions 2nd gen（HTTP 9 分上限）または Cloud Run jobs（時間無制限）** に分離

### 実行時間上限の比較
| 実行基盤 | 上限 | 適用範囲 |
|---|---|---|
| GAS（コンシューマ / Workspace 個人） | **6 分** | 既存軽量ジョブの継続 |
| GAS（Workspace Business+） | **30 分** | 上限緩和でも長時間バッチには不向き |
| Cloud Functions 2nd gen (HTTP) | **9 分** | 中規模バッチ |
| Cloud Functions 2nd gen (event-driven) | **60 分** | Pub/Sub トリガの非同期処理 |
| Cloud Run jobs | **24 時間（事実上の上限なし）** | 月次集計・大量レコード処理 |

### 採用根拠（C-20 Cycle 1 指摘の解消）
- Cycle 1 R-06 リスクは「GAS の 6 分上限により月次バッチが時間切れ」。Cycle 2 では **`generateBillingPrep` 月次集計を Cloud Run jobs に移管** することで根本解決。
- GAS から Cloud Run jobs の起動は **Cloud Tasks + 同期 HTTP 呼び出し** または **Eventarc 経由の非同期トリガ** で実施。
- 認証は GAS 側のサービスアカウントトークン取得 → Cloud Run jobs の IAM 認証で完結。

### 障害福祉ドメインでの判断
- 既存資産（GAS 運用人材）を活かしつつ、月次の請求準備バッチだけ Cloud Run jobs に切り出すことで「人材リスキル最小・上限到達リスク回避」を両立。
- Cloud Run jobs のコールドスタートは数秒程度で月次バッチには無視可能。

### 出典
- [Compare Cloud Run functions | Google Cloud Documentation](https://docs.cloud.google.com/run/docs/functions/comparison)
- [Cloud Run jobs vs Cloud Functions vs Cloud Scheduler 比較](https://oneuptime.com/blog/post/2026-02-17-how-to-compare-cloud-run-jobs-vs-cloud-functions-vs-cloud-scheduler-for-background-tasks/view)

---

## R9. AppSheet Security Filter の代替手段

### 採否判定
- **Cycle 2: USERSETTINGS() を全廃**。代替として「**サーバ側参照テーブル `staff_facility_map` を SECURITY_FILTER 式で参照**」する方式を採用。

### USERSETTINGS の弱点（C-05 Cycle 1 指摘）
- USERSETTINGS() は **クライアント側で保持・変更可能** な User Settings の値を返す。利用者が改竄すれば他事業所のデータが見える事故が起こりうる。
- AppSheet 公式コミュニティでも「USERSETTINGS は UI 表示制御に使い、Security 判定には使わない」が定説。

### 推奨代替手段
1. **USEREMAIL() ベース + サーバ参照テーブル方式（Cycle 2 採用）**
   - `staff_facility_map` テーブル（CloudSQL 側）に `email × allowed_facility_id` を保持。
   - AppSheet Security Filter 式例:
     ```
     [facility_id] IN
       SELECT(staff_facility_map[facility_id],
              [email] = USEREMAIL())
     ```
   - 改竄不可（テーブルは CloudSQL 側で行レベル制御）、監査ログに反映可能。

2. **USERROLE() ベース**
   - AppSheet の標準機能（Admin / User の 2 段階）。役職ロール（サビ管 / サ提責 / 生活支援員 / 請求担当 / 管理者）の 5 段階表現には不足。

3. **Slice + Slice Filter**
   - View 単位の絞り込みに使うべきで、Security 判定そのものではない。Security Filter（テーブル単位）が Pass しないと Slice も意味を持たない。

### 注意点
- Security Filter は **同期時に全行評価** → `staff_facility_map` は小さく保つ（数百行程度）。
- 兼務スタッフの複数事業所表示は `staff_facility_map` に複数行で表現。

### 障害福祉ドメインでの判断
- C-05 の解消手段としては「USERSETTINGS 全廃 + サーバ側 staff_facility_map 参照」が必要十分。
- Cycle 2 Must 8 セキュリティ受入基準に「全 Security Filter 式に USERSETTINGS() を含まない」を機械チェック可能な条件として明記。

### 出典
- [Security filters: The Essentials - AppSheet Help](https://support.google.com/appsheet/answer/10104488?hl=en)
- [Limit users to their own data using security filters - AppSheet Help](https://support.google.com/appsheet/answer/10104977?hl=en)

---

## まとめ（Cycle 2 spec.md §5 への流し込み材料）

| 領域 | Cycle 1 採用 | Cycle 2 変更点 | 根拠 |
|---|---|---|---|
| Salesforce Shield Encryption | 未検討 | **不採用**、CloudSQL 側 CMEK に集中 | R6 / C-18 コスト |
| CloudSQL 暗号化 | デフォルト Google 管理鍵 | **CMEK 必須化（KEK = Cloud KMS / asia-northeast1）** | R7 / C-01 解消 |
| 月次バッチ実行基盤 | GAS 単独 | **GAS（軽量） + Cloud Run jobs（月次重量）** ハイブリッド | R8 / C-20 / R-06 解消 |
| AppSheet 行レベル制御 | USERSETTINGS 想定 | **USEREMAIL + `staff_facility_map` 参照、USERSETTINGS 全廃** | R9 / C-05 解消 |
