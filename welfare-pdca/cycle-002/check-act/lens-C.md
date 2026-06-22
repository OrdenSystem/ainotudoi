# Lens C — セキュリティ・個人情報 — サイクル 002

## 観点と評価軸

`08-security-and-privacy.md` を 02 / 03 / 04 / 05 / 06 と照合。鍵管理経路（C-01）、USERSETTINGS 全廃（C-05）、CloudSQL 行レベル制御（C-09）、`audit_log` append-only + WORM（C-10）、PII フィールド一覧、暗号化方式、アクセス制御マトリクス、Salesforce Shield 不採用の説明責任（L-17）、Cycle 3 で先送りした Claude API 使用時の PII マスキング基盤を審査。Cycle 1 Lens C Critical 4 件の解消も確認。

## 確認した成果物

- `welfare-pdca/cycle-002/do/08-security-and-privacy.md`（全節）
- `welfare-pdca/cycle-002/do/02-data-model.md` §2 / §4
- `welfare-pdca/cycle-002/do/03-cloudsql-ddl.sql` §3 / §16 / §18
- `welfare-pdca/cycle-002/do/04-salesforce-objects.md` §1 / §4 / §14
- `welfare-pdca/cycle-002/do/05-appsheet-tables.md` §2 / §7
- `welfare-pdca/cycle-002/do/06-gas-integrations.md` §2 / §3 / §9 / §10
- `welfare-pdca/cycle-002/do/09-operational-runbook.md` §1 / §3 / §5
- `welfare-pdca/cycle-002/plan/spec.md` §6.Must.8 / §7 受入基準 / §8 R-05/R-09/R-14/R-15
- 比較: `welfare-pdca/cycle-001/check-act/lens-C.md`

## Cycle 1 Lens C Critical の解消確認

| Cycle 1 Critical | 解消状況 | 根拠 |
|---|---|---|
| C#1: CloudSQL 行レベル制御がアプリ層任せで空欄 | **解消** | `08-security-and-privacy.md` §5 で MySQL ユーザー分離（4 種）、ロール別 VIEW `v_user_for_staff_{role}` の DDL サンプル、`audit_log` への REVOKE 文を明記 |
| C#2: AES_ENCRYPT 鍵管理の経路が文章とコードで乖離 | **解消** | §1 KEK パス統一、Secret Manager → Cloud KMS → CMEK / Application-level の鍵管理フロー図を `08` §1.2 と `07-integration-flows.md` §7 に明示 |
| C#3: USERSETTINGS 改竄リスク | **解消** | `05-appsheet-tables.md` §7 で全 Security Filter を `USEREMAIL() + staff_facility_map` 参照に統一。`staff_facility_map.email` は CloudSQL 側で保護（`08` §5.1 の最小権限） |
| C#4: audit_log の改竄防止策が無い | **解消** | `08` §5.3 で REVOKE UPDATE/DELETE、§6.2 で Cloud Storage WORM バケット（Bucket Lock + retention 5 年）への 1 時間ごとストリーム書出し |

> 4 件すべて解消（設計上は完成）。ただし下記 Critical で実装責務が空欄の論点が残存。

## Critical（必ず次サイクルで直す）

1. **`audit_log` への INSERT が AppSheet 経路で発火されない（Lens A Critical #2 と同根、セキュリティ側からも Critical）**: `08-security-and-privacy.md` §6.1 のイベント種別表で `CREATE / UPDATE / DELETE / APPROVE / EXPORT` を列挙し AppSheet 側で発火するイベントの大半を含む。しかし `05-appsheet-tables.md` §5 Action 定義の `ApproveServiceRecord` `CopyShiftToNextWeek` `ConfirmBilling` `ConfirmUpperLimitResult` `ExportBillingCSV` のうち、`audit_log` への INSERT を実行するのは `exportBillingCSV`（`06-gas-integrations.md` §10 GAS WebApp 経由）のみ。AppSheet からの直接 INSERT/UPDATE/DELETE は監査ログを残さない設計。`07-integration-flows.md` §3 Mermaid で「AS->>CS_AL: INSERT audit_log」と描かれるが、AppSheet 公式機能で 1 アクションから複数テーブル INSERT を発火する Standard 手段は無く、AppSheet Bot（"On record change"）か Webhook 経由 GAS が必要だが実装スケッチがない。
   - Why bad: spec §6.Must.8 受入基準で「`audit_log` テーブルは append-only」を機械検証可能な要件として要求しているが、append-only でも記録されないイベントは存在し得ない。要配慮 PII 閲覧履歴も `08` §6.1 表に含まれず（`SELECT` イベントは記載なし）、個人情報保護法のアクセスログ義務に対応できないリスク。
   - How to fix: Cycle 3 で「AppSheet Action → AppSheet Bot → Webhook → GAS WebApp → `audit_log` INSERT」のフローを `08` §6.1 と `06-gas-integrations.md` に追加。MySQL Trigger 方式と比較検討。`02-data-model.md` §2.2 `CS_AuditLog` の `actor_type` enum に `appsheet_user` を追加検討。
   - Spec §: §6.Must.8 受入基準（append-only / 監査ログ完全性）

2. **`audit_log.before_json / after_json` に要配慮 PII が平文で残る（Lens B Critical #4 と同根、Cycle 1 Lens B Major #9 残存）**: `03-cloudsql-ddl.sql` §16 で `before_json JSON / after_json JSON`、`08-security-and-privacy.md` §6.1 で「before=変更前 JSON, after=変更後 JSON」と書かれている。要配慮 PII（`disability_type`、`notes`、`LongTermGoal__c` 等）の変更時に平文 JSON が `audit_log` に保管され、§6.2 で 1 時間ごと Cloud Storage WORM バケット（5 年保持）にストリーム書出しされる。Cloud KMS Application-level 暗号化対象の `recipient_cert_no` も、変更時には平文（kmsDecrypt 後の値）を `after_json` に含めるとリスク。
   - Why bad: `08` §9.1「最小化原則」と矛盾。WORM 保持 5 年（§6.2 / §9.2）で削除不能なため、PII 漏洩時に個人情報保護委員会への報告 + 削除要請に対応できない。Cycle 1 同種指摘（Lens B Major #9）の格上げ忘れが Cycle 2 で Critical 化。
   - How to fix: Cycle 3 で `audit_log.before_json` / `after_json` を「PII 列マスク済み JSON（要配慮列は値ではなく `***` or `changed`）」に統一。`recipient_cert_no` は変更通知のみで値は記録しない。`08` §6.1 と `03` §16 に書き込みルールを明文化。
   - Spec §: §6.Must.8 受入基準 / §7 受入基準（要配慮 PII 保護）

3. **AppSheet Bot 通知（`05-appsheet-tables.md` §6）の本文に要配慮 PII が含まれるリスクが Cycle 2 で対処されていない（Cycle 1 Lens C Major #7 残存）**: `AllotmentWarningBot`「支給残量が 10% 以下の利用者を担当スタッフに通知」、`ContractExpiryBot`「契約満了前 30 日の利用者を通知」、`UpperLimitWarningBot`「未確認の上限管理結果票があります」など、通知本文に利用者氏名を含めばロック画面表示で第三者閲覧リスクあり。`08` §3 / §7 でプッシュ通知本文の PII マスキング方針が記載なし。
   - Why bad: 障害者総合支援法上の要配慮 PII（障害種別と紐付く利用者識別子）を端末ロック画面に表示することは要配慮 PII 第三者提供に該当しうる。spec §3 法令前提（個人情報保護法）と矛盾。
   - How to fix: Cycle 3 で AppSheet Bot 通知本文を「利用者 ID: U-1234 残量 10% 以下です。詳細はアプリで」のような匿名化形式に統一。`05-appsheet-tables.md` §6 Bot 設定と `08-security-and-privacy.md` §3 PII フィールド一覧表に「通知本文マスク」列を追加。
   - Spec §: §6.Must.8 受入基準 / §3 法令前提

## Major（強く推奨）

1. **`exportAuditLogsToGcs` の GCS アップロード URL が空欄（`08-security-and-privacy.md` §6.2 擬似コード）**: `const gcsUrl = 'https://storage.googleapis.com/upload/storage/v1/b/welfare-audit-logs-${getSecret('GCP_PROJECT_ID')}/o?uploadType=media&name=...'` の末尾 `name=...` がプレースホルダのまま。実装時に YYYY/MM/DD/HH のオブジェクト名生成ロジックが欠落。さらに `Utilities.newBlob(...)` を JSON で渡しているが `application/json` のままで GCS にアップロードしても 1 ファイル 1 行扱いになり、§6.2「YYYY/MM/DD/HH/audit_log_{timestamp}.jsonl」と書出し形式が一致しない。

2. **`08-security-and-privacy.md` §7 アクセス制御マトリクス（5 ロール × 11 オブジェクト）と `05-appsheet-tables.md` §7 Security Filter 表の権限粒度が一致しない**: §7 マトリクスで「請求担当」は「契約書類: △（契約有効確認のみ）」とあるが、`05-appsheet-tables.md` §7 `contract_mirror` の Security Filter は `[facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())` で**全請求担当が自事業所の全契約 active/draft/expired/terminated すべて参照可能**。「契約有効確認のみ」を実現するには `[status] = 'active'` のサブ条件が必要だが Slice/Security Filter で実装されていない。

3. **`v_user_for_staff_{role}` VIEW が `08-security-and-privacy.md` §5.2 にあるが、CloudSQL ユーザー権限の GRANT が DDL `03-cloudsql-ddl.sql` で適用されていない**: §5.2 で 3 ロール用 VIEW を CREATE するが、各 VIEW を「どの MySQL ユーザーが SELECT 可能か」の GRANT 文が DDL §18 と `08` §5.1 ユーザー分離表で対応していない。`welfare_admin_user` が VIEW 不要、`welfare_app_user` が AppSheet 経由なのでロール VIEW を直接 SELECT する経路がない（AppSheet はテーブル直参照）。実体として VIEW の用途が「直接 SQL 接続する DBA 向け」のみで、利用者数が限定的なら過剰設計に。

4. **GAS Script Properties への `AUDIT_LOG_LAST_ID` 保管が改竄リスク（`08-security-and-privacy.md` §6.2 擬似コード）**: GAS Script Properties は GAS スクリプト編集権限を持つアカウント全員が `setProperty/getProperty` で変更可能。`AUDIT_LOG_LAST_ID` を改竄して大きな値にすると、過去ログを WORM バケットにエクスポートせず欠損を生じさせられる。本 Critical でないが、append-only + WORM の改竄防止意図が中途半端。

5. **インシデント対応「72 時間以内の個人情報保護委員会への報告」（§10 / Cycle 1 Lens C Major #5）の社内連絡フローが具体性に欠ける**: §10 ステップ 4「報告義務確認: 法務担当」とのみ。中小事業所には社内法務がいない場合の代替（外部弁護士の予約契約、業界団体経由のテンプレ）が空欄。Cycle 1 から進展なし。

6. **Salesforce Shield 不採用の説明責任（L-17）の社内決裁プロセスが空欄**: `04-salesforce-objects.md` §1 / §14、`08-security-and-privacy.md` §4.1 / §11 で L-17 フラグを明示しているが、「DPO / 監査法人が承認したエビデンス」をどこに保管するか、Cycle 3 で誰がレビューを依頼するかが空欄。spec.md §8 R-15「Shield 非採用の説明責任」を挙げているが、具体的アクションオーナーなし。

7. **Salesforce Field History Tracking の保持期間 18 ヶ月（`08` §6.3）と CloudSQL `audit_log` 5 年（§9.2）の不整合**: 要配慮 PII の変更履歴が、SF 側で 18 ヶ月後に消える一方、CloudSQL 側では 5 年残る。CloudSQL のミラーは SF の 1 時間ごと差分同期で「いつ変更されたか」「誰が変更したか」を `audit_log` に書く必要があるが、SF 側変更を GAS 経由で記録するロジック（誰が変更したかのアクター情報を SF から取得して `audit_log.actor_id` に転記）が `06-gas-integrations.md` §3 にない。

8. **`06-gas-integrations.md` §2.1 `getSalesforceAccessToken()` の `privateKey` を `getSecret('SF_PRIVATE_KEY')` で取得した後、メモリ上の Plain text として GAS 実行ランタイムに残る**: Cloud KMS で復号した PEM 鍵が GAS 実行コンテキスト内で平文展開される。GAS Apps Script の実行ログ（`console.log` / `Logger.log`）に誤って出力すると Cloud Logging で平文保管されるリスク。GAS Apps Script でメモリ上の秘密情報を逃さない技術的手段は薄いが、`08` §9.3 程度に「秘密情報のログ出力禁止」運用ルールを書くべき。

9. **`08-security-and-privacy.md` §7 アクセス制御マトリクスの「監査ログ」列で生活支援員・サ管・シフト管理者・請求担当が `×` だが、`05-appsheet-tables.md` §4 `AuditLogView` は「facility_admin のみ」と明記**: ロール統一はされているが、§7 マトリクスの「事業所管理者: ○（読取のみ）」が `AuditLogView` で実現できているか、AppSheet App formula で `LOOKUP(USEREMAIL(), "staff", "email", "role") = "facility_admin"` 等の表示制御が必要だが `05` §4 では明記なし（「AppSheet からは参照のみ — 管理コンソール推奨」とフォールバック）。

10. **KMS 鍵削除手順（KEK version destroy）と「再暗号化 or バックアップ取得」（`08` §1.3 ステップ 4）の手順が `09-operational-runbook.md` §3 シナリオ S5 と整合しない**: `09` シナリオ S5 では「鍵キャッシュ + マスク表示」で運用継続を案内、§5 PITR では「バックアップは同 KEK で暗号化」と書かれる。KEK version destroy 後の PITR リストアが「destroy 済み KEK が必要」で復元不能になる事故シナリオが `08` / `09` のいずれにも詳説されていない。spec §8 R-14「Secret Manager / Cloud KMS 障害時に CloudSQL 暗号化フィールドが読めず業務停止」とは別のオペレーション事故（KEK ローテーション運用ミス）への対処が空。

## Minor（余裕があれば）

1. `08` §4.2 通信時暗号化表の AppSheet ↔ CloudSQL が「Cloud SQL Auth Proxy（内部 TLS）or SSL 証明書」と OR 表現。どちらが採用かを `01-architecture.md` §6.2 と合わせて確定すべき。
2. `08` §10 インシデント対応ステップ 4 で「個人情報保護委員会への報告義務（72時間以内）が発生しうる」と書かれるが、GDPR は 72 時間、日本の改正個情法は「速やかに（具体的時間は政令で）」で 72 時間ハード期限ではない。注記の精度。
3. `08` §6.3 Salesforce Field History Tracking 対象に `RecipientCertNo__c` が含まれるが、SF Field History は値そのものを記録する。Shield 不採用と組み合わせると平文の番号履歴が SF Audit Trail に残る。
4. `08` §3 PII フィールド一覧の「staff.email」が基本扱いだが、`staff_facility_map.email` も同じ値で Security Filter のキーになるためサニタイズ要件は厳しい。
5. `08` §1.1 KEK パス末尾 `cryptoKeyVersions/{v}` を含むフルパス文字列を 3 ファイル統一と要求するが、`{v}` は実行時に変動するため、ローテーション後に文字列が不一致になる仕様矛盾。CryptoKey までで止める方が運用と整合（既に DDL / GAS / Runbook はそうしている）。

## スコア（1-10）

- 完全性: 6（C-01/C-05/C-09/C-10 はすべて解消したが、AppSheet 由来の audit_log 書込み経路、audit_log JSON の PII、通知本文 PII の 3 件が新規 Critical）
- 整合性: 6（鍵管理経路は KMS 一本化で大幅改善。一方マトリクスと Security Filter 実装の粒度、SF / CS の保持期間ギャップが残存）
- 妥当性: 7（CMEK + Application-level + Secret Manager + WORM + append-only の二重三重防御は妥当。Shield 不採用判断も R-15 でリスク化されている）
- 平均: **6.33**
