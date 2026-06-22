# Lens C — セキュリティ・個人情報 — サイクル 001

## 観点と評価軸

`08-security-and-privacy.md` を 02 / 03 / 04 / 05 / 06 と照合。PII の保管場所と暗号化方式、Salesforce 共有設定 / FLS、CloudSQL 行レベル制御、AppSheet Security Filter、監査ログ、認証情報の保管、PII フロー、外部 API（Claude）への送信制御を審査。

## 確認した成果物

- `welfare-pdca/cycle-001/do/08-security-and-privacy.md`（全節）
- `welfare-pdca/cycle-001/do/02-data-model.md` §2, §4
- `welfare-pdca/cycle-001/do/03-cloudsql-ddl.sql` §2, §8, §11
- `welfare-pdca/cycle-001/do/04-salesforce-objects.md` §4, §9, §11
- `welfare-pdca/cycle-001/do/05-appsheet-tables.md` §2, §7
- `welfare-pdca/cycle-001/do/06-gas-integrations.md` §2, §3, §8
- `welfare-pdca/plan/spec.md` §6.Must.8, §7 セキュリティ受入基準, §8 R-05, R-09

## Critical（必ず次サイクルで直す）

1. **CloudSQL 行レベル制御が「アプリ層で担保」とだけ書かれ、AppSheet を経由しない直接 SQL アクセス（GAS、運用 DBA、ad-hoc クエリ）に対する PII 保護が空欄**: `08-security-and-privacy.md` §4 で「CloudSQL: MySQL ユーザー権限 + Row-Level Security はアプリ層（AppSheet Security Filter / GAS）で担保」と明記。MySQL 8 はネイティブ Row-Level Security をサポートせず、`08` §4 は「アプリ層」と一行で済ませている。spec §7「アクセス制御マトリクス（5ロール × 5主要オブジェクト）」のうち CloudSQL 層の `5 ロール × CloudSQL` の権限粒度が定義されていない。GAS バッチも `dbUser`（`06-gas-integrations.md` §2.2）の単一接続を使う設計で、操作種別ごとに分けない。
   - Why bad: AppSheet 経由でアクセスを絞っても、CloudSQL Public IP（`01-architecture.md` §4.2）+ Auth Proxy で DBA や管理者が直接ログインすると、`user_mirror.disability_type`（要配慮 PII）が一覧 SELECT で抜ける。最小権限が建前だけで実装不能。
   - How to fix: Cycle 2 で CloudSQL 上に「読取専用ロール」「PII 列マスク VIEW」「請求担当ロール」を作成し、`08` §4 に「CloudSQL ユーザー × テーブル/列」のマトリクスを書く。要配慮 PII 列を含むテーブルは VIEW 経由で必要列だけ公開する設計を 03 と 08 に追加。
   - Spec §: §6.Must.8 受入基準 / §7 セキュリティ受入基準

2. **AES_ENCRYPT 鍵管理の経路が不明確（Lens B Critical #1 と同根）**: `08-security-and-privacy.md` §2.1 で「暗号化キーは GCP Secret Manager で管理（GAS サービスアカウントが取得）」と書かれているが、`06-gas-integrations.md` §3 の `upsertUserMirror` では `@@global.secure_file_priv` を鍵として使う誤った SQL が書かれており、Secret Manager 取得 → SET セッション変数 → AES_ENCRYPT の経路が GAS コードに無い。AppSheet が `user_mirror.recipient_cert_no` を表示する経路（`05-appsheet-tables.md` §2.2）でも復号方法（VIEW or AES_DECRYPT 関数）が `03` / `05` / `08` のいずれにも書かれない。
   - Why bad: 「暗号化している」と謳いつつ実装ロジックは空。Cycle 2 で実装着手時に「現場入力では復号した値を見たい」という UX 要件と「鍵を漏洩させない」という運用要件が衝突して設計やり直しになる。
   - How to fix: 鍵の保管 → 取得 → セッション設定 → 暗号/復号 → AppSheet 表示までの一筆書きフローを 08 と 03 と 05 と 06 に明記。鍵ローテーション手順も 09 に追加。

3. **AppSheet `audit_log` View（`05-appsheet-tables.md` §4 `AuditLogView`）の Security Filter が `USERSETTINGS(Role) = "admin"` で「ロール」を AppSheet 側に自己申告させる設計**: AppSheet の `USERSETTINGS()` は AppSheet App 側で設定する値で、改竄可能性がある（クライアントから書き換え可）。同様に `user_mirror` の Security Filter `[facility_id] = USERSETTINGS(FacilityId)` も同じ脆弱性を持つ。
   - Why bad: 要配慮 PII（`user_mirror.disability_type`）と監査ログにアクセスする境界が、信頼できないクライアント側設定に依存。spec §6.Must.8「アクセス制御マトリクス」が形式的にはマトリクス化されているが、技術的に成立しない。
   - How to fix: Cycle 2 で USEREMAIL() ベース or Salesforce SSO 連携で「現ログインユーザーのロール / 所属事業所」をサーバ側で解決する設計に変更。08 §4 / 05 §7 を全面改訂。
   - Spec §: §6.Must.8 受入基準

4. **`audit_log` の改竄防止策が無い**: `03-cloudsql-ddl.sql` §11 と `08-security-and-privacy.md` §5.1 にイベント種別と保持期間 5 年は書かれているが、「`audit_log` 自身が改竄されない」保証（ハッシュチェーン / append-only / WORM / 別アカウントの読取専用バケットへの非同期エクスポート）が無い。`actor_id` を偽装した INSERT も `09-operational-runbook.md` §3 シナリオ B 復旧フローで「データ整合性チェック」とだけ書かれて空。
   - Why bad: 監査ログは個人情報保護法 / 障害者総合支援法対応の根拠資料になる。改竄可能なログは法的にも実務的にも価値が大幅に減じる。
   - How to fix: Cycle 2 で「audit_log の毎日 GCS への append-only エクスポート + GCS バケットを別プロジェクト + Object Lock（or バージョニング + 保持ロック）」を 08 §5.1 と 09 §2 に追記。
   - Spec §: §6.Must.8 受入基準 / §7 受入基準

## Major（強く推奨）

1. **`08-security-and-privacy.md` §1.1 PII 一覧と `02-data-model.md` §2.1 / §2.2 が完全には一致しない**: `LongTermGoal__c` / `ShortTermGoal__c` は `08` §1.1 で「Salesforce のみ」だが、GAS の `claudeAssistSummary`（§8）に送る対象が「サービス記録テキスト」とだけ書かれて、計画書テキストが将来含まれる可能性のリスク言及がない。
2. **AppSheet `sf_person_accounts` の Security Filter 設計が `05-appsheet-tables.md` §7 にない**: CloudSQL `user_mirror` には Security Filter が記載されているが、AppSheet が直接 Salesforce 経由で読む `sf_person_accounts`（SF Object）への Security Filter は未記載。生活支援員でも SF 接続経由で全 PersonAccount が見えるリスク。
3. **GAS Script Properties に Salesforce 秘密鍵を平文保管する記述（`06-gas-integrations.md` §1 / `08-security-and-privacy.md` §2.1）**: 「Google の標準暗号化」と書かれているが、Script Properties は GAS スクリプト編集権限を持つアカウント全員が `getProperty` で取得可能。Secret Manager 経由に統一する方が望ましい。`08-security-and-privacy.md` §2.1 と `06-gas-integrations.md` §2.1 で記載が割れる（「Secret Manager 推奨」と「Script Properties に保管」の二重記述）。
4. **AppSheet → CloudSQL の接続資格情報の保管・ローテーション方針が未記載**: AppSheet エディタに DB ユーザー / パスワードを設定する以上、これも秘密情報だが `08-security-and-privacy.md` で扱われない。AppSheet App を共同編集する開発者の権限境界の言及もない。
5. **インシデント対応「72時間以内の個人情報保護委員会への報告」（§7 ステップ 4）の社内連絡フローが具体性に欠ける**: 担当者「法務担当」とだけ書かれているが、事業所には社内法務がいない場合の代替（外部弁護士の予約契約等）が空欄。
6. **Salesforce Shield 不採用の判断根拠が薄い**: `08` §2.1 で「Cycle 2 で再評価」とのみ。要配慮 PII / 特定機微 PII を扱う前提で「Shield なしで個人情報保護法の安全管理措置を満たすか」の判断根拠が無い。法務レビューフラグ L-10 で言及はあるが、優先度のランクが明示されない。
7. **AppSheet Bot 通知（`05-appsheet-tables.md` §6）の通知本文が「{利用者名} 残り{N}時間」と要配慮 PII を含むプッシュ通知になる**: 端末ロック画面に表示される可能性があり、第三者が見られる。プッシュ通知本文の PII マスキング方針が空欄。
8. **`claudeAssistSummary` の PII マスキング関数 `maskPii(serviceNoteText)` の中身が未定義**（`06-gas-integrations.md` §8）: 「氏名・受給者証番号等を置換」とだけ。R-09 対応の「PII マスキング前提」の実装が抽象表現で済ませられている。Cycle 1 では Should 扱いだが、Cycle 2 で MUST 化する場合の前提が抜ける。

## Minor（余裕があれば）

1. `08` §2.2 で AppSheet → Salesforce は HTTPS とあるが、AppSheet 内部の TLS バージョンは AppSheet 仕様に依存し独立に保証できない注記を入れたい。
2. インシデント対応の連絡先（§7）に GCP / Salesforce ベンダーサポートの電話番号 / アカウント ID 欄が空。
3. 監査ログ保持 5 年の「業務記録（個別支援計画）と独立した保持」の根拠記述が無い（同じ 5 年でも法令根拠が異なる場合あり）。

## スコア（1-10）

- 完全性: 5（5 ロール×5 オブジェクトの「マトリクス」は埋まっているが、CloudSQL 直接アクセス時の制御、`audit_log` 改竄防止、AppSheet `USERSETTINGS` 経由のロール判定の実装可能性が空欄）
- 整合性: 5（暗号鍵管理が文章と DDL/コード で食い違い、Script Properties vs Secret Manager の二重表記）
- 妥当性: 6（PII 分類・通信時 TLS・FLS の方針自体は妥当）
- 平均: **5.3**
