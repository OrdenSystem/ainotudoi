# Lens B — データモデル健全性 — サイクル 001

## 観点と評価軸

`02-data-model.md` / `03-cloudsql-ddl.sql` / `04-salesforce-objects.md` を相互照合。同一エンティティの型・PK・必須性が矛盾していないか、参照整合性、命名規則（API 名と CloudSQL 列名）、UNIQUE 制約と冪等性、`v_allotment_usage` ビューの集計ロジック、暗号化列の参照可能性、`updated_at` の楽観ロック実装可能性を審査。

## 確認した成果物

- `welfare-pdca/cycle-001/do/02-data-model.md`（全節）
- `welfare-pdca/cycle-001/do/03-cloudsql-ddl.sql`（全テーブル＋ビュー）
- `welfare-pdca/cycle-001/do/04-salesforce-objects.md`（全節）
- `welfare-pdca/cycle-001/do/05-appsheet-tables.md` §2, §3
- `welfare-pdca/cycle-001/do/06-gas-integrations.md` §3, §5
- `welfare-pdca/cycle-001/plan/spec.md` §6.Must.1〜6, §7 データ整合性

## Critical（必ず次サイクルで直す）

1. **`user_mirror.recipient_cert_no` が `VARBINARY(64)` に対し、UPSERT で `INSERT VALUES (..., AES_ENCRYPT(?, @@global.secure_file_priv), ...)` を使う構文が壊れている**: `03-cloudsql-ddl.sql` §2 では暗号化列、`06-gas-integrations.md` §3 の `upsertUserMirror` の SQL も AES_ENCRYPT を呼ぶが、引数が `@@global.secure_file_priv`（MySQL システム変数で OS パス文字列）になっており、暗号鍵ではない。実装すると正しく暗号化されず、復号も不能になる。
   - Why bad: `secure_file_priv` は LOAD DATA INFILE 用のディレクトリパス変数で、暗号鍵としての意味を持たない。AES_ENCRYPT には 16/24/32 byte の鍵が必要。受給者証番号（spec §6.Must.1 / §6.Must.8 受入基準「特定機微 PII」）が事実上平文と同等の固定文字列で「暗号化」された状態になり、`08-security-and-privacy.md` §2.1 の「鍵は Cloud Secret Manager で管理」と乖離する。
   - How to fix: Cycle 2 で「Secret Manager から取得した鍵を GAS で読み、SET @key := '<32byte>'; INSERT ... AES_ENCRYPT(?, @key)」または CloudSQL 側で関数 `enc_cert_no(...)` を定義する設計に置き換え。鍵長と IV（必要なら AES_ENCRYPT のブロックモード指定）を 03/06/08 に明記。
   - Spec §: §6.Must.1 受入基準 / §6.Must.8 受入基準（暗号化方式）/ §8 R-05

2. **`v_allotment_usage` ビューの集計が `WHERE valid_from <= CURDATE() AND (valid_to IS NULL OR valid_to >= CURDATE())` を使い、当月超過判定として誤った範囲を集計**: `03-cloudsql-ddl.sql` §10 のビューは、`a.valid_from` 〜 `a.valid_to`（受給期間全体）における `service_records` を合計する。spec §6.Must.4「**月内**に消費したサービス時間/回数を集計し、受給者証の支給量を超過していないか可視化」と一致しない。受給期間が複数月にわたる場合、ビューは累積消費を集計するが、支給量（`allotment_qty`）は通常「月あたり」なので、最初の月で残量がマイナスに張り付き、以降ずっと超過警告が出続ける。
   - Why bad: 支給量は障害福祉サービスでは「月単位」で付与される（支給決定の運用慣行。報酬告示参照）。ビューがそれを反映しないと、`AllotmentView`（`05-appsheet-tables.md` §4）の超過ハイライトと AppSheet Bot 通知（§6 `AllotmentWarningBot`）が誤発火し、業務に支障。
   - How to fix: ビュー側で `sr.service_date BETWEEN DATE_FORMAT(CURDATE(), '%Y-%m-01') AND LAST_DAY(CURDATE())` のような当月フィルタを入れる、または `allotment_unit` の意味論を「月あたり」と明記してビューを書き換える。spec §6.Must.4 受入基準で「月内集計」の解釈を確定。
   - Spec §: §6.Must.4 受入基準

3. **`user_mirror.disability_type` の型不整合（VARCHAR(20) vs Picklist 値）**: `04-salesforce-objects.md` §4.2 で `DisabilityType__c` の選択肢値は `physical / intellectual / mental / developmental / other` の文字列だが、`02-data-model.md` §2.1 では「障害種別（身体・知的・精神・発達等）」と日本語混在表記、`03-cloudsql-ddl.sql` §2 では `VARCHAR(20)` で COMMENT「障害種別」のみ。SF 値（英語）と CS 値（日本語？英語？）の対応規約がない。
   - Why bad: GAS 同期で SF picklist 値を CloudSQL に流す際にトランスレートが必要かどうか不明。AppSheet Slice の絞り込み（`05-appsheet-tables.md` §3）も SF 値 / CS 値どちらでフィルタするか不確定。
   - How to fix: Cycle 2 で「英語コード値をそのまま流す」「日本語ラベルは AppSheet 表示時のみ enum マッピング」を明文化。02 §2.1 と 03 §2 と 04 §4.2 を同一値リストで一致させる。
   - Spec §: §6.Must.1

4. **`shifts.chk_shift_time CHECK (end_time > start_time)` が深夜またぎシフトを拒否**: `03-cloudsql-ddl.sql` §5。同じく `service_records.chk_sr_time`（§8）も同様。グループホーム（GH）夜勤は 17:00 開始 〜 翌 09:00 終了など end_time < start_time となるシフトが日常的に発生。
   - Why bad: spec §3 のステークホルダーに「シフト管理者」、§2 In Scope に「グループホーム等」と明記されており、GH 夜勤を扱えないとシフトモデル自体が機能不全。
   - How to fix: `shift_end_date` を追加して TIME 比較を撤廃する、または `is_overnight` フラグ＋次日マージで対処。02 §2.2 のシフト定義と 03 §5 を改修。
   - Spec §: §3 / §6.Must.5

5. **`SupportPlan__c` の Validation Rule VR-02 が VLOOKUP で実装不可**: `04-salesforce-objects.md` §5.3 の `PreventDuplicateActivePlan` で「VLOOKUP($ObjectType.SupportPlan__c.Fields.Status__c, …)」と書かれているが、Salesforce VLOOKUP は別オブジェクトを参照する関数で、同じオブジェクト内の重複検索には使えない（VLOOKUP は単一一致検索のみ、Status__c の値検索という用途とも不一致）。
   - Why bad: spec §6.Must.2 受入基準「同一利用者・同一期間の重複 active 計画を禁止」が実装不能な式で書かれており、見かけ上の受入基準クリアになっている。実際は Apex Trigger / Flow / Duplicate Rule で実装する必要があるが、それが代替手段として §5.3 末尾に「要 Apex Trigger 検討」と片付けられている。
   - How to fix: Duplicate Rule（標準機能）または Flow（before-save）の具体設計を 04 §5.3 に書く。VR-02 を削除するか Apex Trigger スケッチを Cycle 2 で出す。
   - Spec §: §6.Must.2 受入基準

## Major（強く推奨）

1. **`02-data-model.md` §2.1 の `SF_PersonAccount` 表に `FacilityId__c` の Lookup 先が `Facility__c` 記載なのに、利用者と Person Account の親子関係（Account ↔ Contact）の取り扱いが Cycle 1 で空欄**: Person Account 有効化時に「個人アカウント」レコードタイプが追加され、`FacilityId__c` を Account 側に置くか Contact 側に置くかで Lookup の挙動が変わる。Cycle 1 では Account 側で記述されているように読めるが明示なし。
2. **`pushDailySummaryToSF`（`06-gas-integrations.md` §6）で更新する `LastServiceDate__c`, `MonthlyServiceMinutes__c`, `MonthlyServiceCount__c` が `04-salesforce-objects.md` の項目定義（§4.1〜§4.4）に存在しない**: SF 側のカスタム項目が未定義。Lens A Major #4 と同根。
3. **`service_records.duration_minutes` が AppSheet App Formula（`05-appsheet-tables.md` §2.1）で `(end_time - start_time) * 60` と書かれているが、AppSheet で Time 差分は分単位で返るため `* 60` 不要、または記法誤り**: 実装すると 60 倍の値が DDL の `SMALLINT UNSIGNED`（最大 65535）に書き込まれ即オーバーフロー。
4. **`facilities` テーブル DDL に `sf_account_id` UNIQUE が無い**: `02-data-model.md` §2.2 では事業所マスタの説明だが、`sf_account_id` 列は DDL §1 で DEFAULT NULL のみ、UNIQUE 制約なし。同期マッピングが一意性を担保できないリスク（Lens A Critical #2 と関連）。
5. **`addition_master` に `service_type` で対象を絞っているが、加算の適用条件（人員配置・利用者属性等）の表現が一切無い**: 加算減算は条件付き発火が主流（夜間支援体制加算、福祉専門職員配置等加算等）。`02-data-model.md` §2.2 / `03-cloudsql-ddl.sql` §7 の `addition_master` は単純な単位差分だけで Cycle 2 の実装難度が跳ね上がる。spec §6.Must.6「（骨子）」とあるが骨子レベルでも適用条件カラムが空欄なのは弱い。
6. **`batch_run_log` に `last_synced_at` 系の差分基準時刻列がない**: `06-gas-integrations.md` §3 では「`getLastSyncTimestamp(conn, 'sf_sync_users')` を batch_run_log から取得」とあるが、DDL §12 の `batch_run_log` には `since` を保存する列がない。`started_at` で代用するなら明記が必要。仕様コード齟齬。
7. **CloudSQL の `user_mirror` と Salesforce PersonAccount で必須項目セットが不一致**: SF 側 `LastNameKana__c` / `FirstNameKana__c` は任意、CloudSQL 側 `user_mirror` にはフリガナ列自体が存在しない。`02-data-model.md` §2.1 で SF 側に挙げた `LastNameKana__c` が CloudSQL ミラーから落ちている → AppSheet 検索でフリガナ検索ができない。
8. **`v_allotment_usage` で `consumed_times` の集計式が条件式と分母不整合**: `CASE WHEN a.allotment_unit = 'times' THEN 1 ELSE NULL END` を SUM すると、unit が times でない行は NULL になり SUM 対象外。しかし下の `WHEN 'times' THEN a.allotment_qty - COALESCE(COUNT(sr.id), 0)` は **全 sr 行** を数えるため、単位が times の利用者ですら他種別の record_id が混入して残量計算が誤る。
9. **`audit_log.before_json` / `after_json` の JSON 型は MySQL 8 の JSON 列だが、`02-data-model.md` §2.2 / `08-security-and-privacy.md` §5.1 で「変更前/後スナップショット」と書きつつ、サイズ上限や PII を JSON にそのまま入れる是非に触れていない**: 暗号化対象の `recipient_cert_no` を変更時の `before_json` に平文で入れると暗号化方針が崩れる。

## Minor（余裕があれば）

1. `02-data-model.md` §2.2 の `CS_AuditLog` の列名（`event_type` 等）と `03-cloudsql-ddl.sql` §11 の DDL は一致しているが、コメントが日本語 / 英語混在。
2. `service_records.notes` を `LongText`（AppSheet 型）と `TEXT`（MySQL）でマッピングしているが、入力上限を AppSheet 側で制御していない。
3. `user_allotment_cache.sf_allotment_id` に UNIQUE 制約が無い（複数 SF レコードが同一 user に重複同期される可能性）。
4. `02-data-model.md` §2.1 表中の表記揺れ: 「PII区分」の値が「基本 / 要配慮 / 特定機微 / -」と「— / 基本」で混在。
5. `staff` に `phone` 列が無い（Major ではないが、シフト管理者が緊急時に連絡する手段がない）。

## スコア（1-10）

- 完全性: 6（テーブル数は揃うが、暗号化鍵、night shift、加算適用条件、SF カスタム項目欠落が複数）
- 整合性: 4（受給期間集計の意味論、unit ENUM 型不一致、AES_ENCRYPT 引数誤り、VR-02 不実装）
- 妥当性: 6（基本構造は妥当だが、シフト深夜またぎ拒否は致命的）
- 平均: **5.3**
