# サイクル 2 への提案（Cycle 1 → Cycle 2 引き継ぎ）

> 入力: `cycle-001/check-act/scorecard.md`（総合 5.38 / 10、判定 **FAIL**、Critical 21 / Major 43）
> 目的: P1 Critical 7 件（C-01〜C-07）を確実に解消し、Cycle 2 で総合 ≥ 6.5 を超える。
> 補完情報: AppSheet App ID `b9e4f84d-f9b9-4376-97f1-83e3b07122e3` / App Name `HopeCareDX_ainotudoi-443914355` は Cycle 1 途中で受領済み。Cycle 2 spec ではこれを「既知前提」として扱う。

---

## 1. 採用すべき変更（Critical 由来 / Cycle 2 の Must 直接編集）

### 1.1 P1（必ず Cycle 2 で解消）

| Issue | spec.md のどこを書き換えるか | 受入基準の修正案 |
|---|---|---|
| **C-01 鍵管理経路の不在** | §6.Must.8 受入基準に「Secret Manager → CloudSQL 起動オプション → MySQL `--keyring-file-data` 連携 → アプリ復号 → AppSheet 表示」のフルパスを明文化。§4 アーキテクチャに「KMS / Secret Manager 配置」をブロック追加。 | 受配者証番号の暗号化鍵参照が DDL / GAS / 運用 Runbook の 3 箇所で同一名で記述されている。`AES_ENCRYPT(?, @@global.secure_file_priv)` の擬似実装を全削除。Cloud Secret Manager 連携の実コマンドサンプル必須。 |
| **C-02 月次集計の誤り** | §6.Must.4 受入基準に「月単位（service_date が YEAR(today())-MONTH(today())）の集計のみで超過判定」を明記。 | `v_allotment_usage` の集計 SQL に `WHERE YEAR/MONTH` または `service_year_month` パーティション列を導入。サンプル SQL を 03 に追加。 |
| **C-03 上限管理エンティティ欠落** | §6.Must.6 に「上限管理事業所 / 利用者負担上限月額 / 上限管理結果票」のエンティティ要件を追加。 | 02-data-model.md と 03-cloudsql-ddl.sql と 04-salesforce-objects.md に `upper_limit_facility` / `upper_limit_decision`（月額上限）/ `upper_limit_result_sheet`（受信/発信）の 3 エンティティが存在し、国保連請求の前提を満たす。 |
| **C-04 支給決定 SoR の二重定義** | §4 を再設計。「Salesforce が SoR」「CloudSQL は月次キャッシュのみ」「AppSheet は CloudSQL を読み取り、SF は書込のみ」を 1 経路に統一。 | 01-architecture.md / 02-data-model.md / 05-appsheet-tables.md の 3 ファイル間で支給決定情報の参照経路が完全一致。AppSheet が SF 直参照と CloudSQL 経路を同時に使う設計は禁止。 |
| **C-05 USERSETTINGS 改竄リスク** | §6.Must.8 に「ロール判定は USERSETTINGS ではなく Security Filter 内の SECURITY_FILTER 関数 + CloudSQL `staff_facility_map` で行う」と明記。 | 05-appsheet-tables.md の Security Filter 式から USERSETTINGS() を全廃。CloudSQL 側の `staff_facility_map` テーブル定義と行レベル制御方針を 08 に追記。 |
| **C-06 SF Facility → CloudSQL 同期** | §4 の連携経路に「Facility マスタは SF が SoR、CloudSQL は ID マッピング表（`facility_id_map`: salesforce_id ↔ cloudsql_id）で解決」を明記。 | 06-gas-integrations.md に `syncFacilitiesFromSF` 関数を新設。`user_mirror` 等の FK は `facility_id_map` 経由で解決。 |
| **C-07 GH 夜勤の制約違反** | §3 の用語に「夜勤シフトは start_time > end_time の表現を許容（日跨ぎ）」を明記。 | `shifts.chk_shift_time` を `end_time != start_time` のみに緩和し、跨日判定は `shift_date` + `is_overnight` フラグで管理。日跨ぎを想定したサンプルレコードを 03 のコメントに追加。 |

### 1.2 P2（強く推奨、Cycle 2 の Must に組み込む）

- **C-08 アセスメント／モニタリング／サービス担当者会議** → §6.Must.2「個別支援計画」に親子エンティティとして含める。実地指導減算リスクの記述を §3 法令前提に追加。
- **C-09 CloudSQL 行レベル制御** → §7 受入基準に「AppSheet を経由しない直接 SQL アクセスの PII 保護方針」を新項目として追加。CloudSQL ユーザ別 VIEW / プロキシ層案を 08 に。
- **C-10 audit_log 改竄防止** → §6.Must.8 に「append-only / WORM / 別バケットへのストリーム書出し」を必須要件として追加。
- **C-11 契約書・重要事項説明書・同意書** → §6.Must.1（利用者マスタ）の親子エンティティとして契約管理を組み込む。Cycle 2 の Must 数は 11 個になる想定。
- **C-12 / C-13** → §4 アーキテクチャと §6.Must.5（スタッフ）の説明を明確化（C-04 と同方針で「SF SoR、CloudSQL 同期キャッシュ」）。

### 1.3 P3（余力次第、ただし spec.md には記載する）

- **C-14 disability_type 値域統一** → 04 / 03 / 05 で picklist 値の対応表を持つ。マスタテーブル化案も検討。
- **C-15 重複 active 計画チェック** → SF Validation Rule を VLOOKUP ではなく SOQL ベース or Apex Trigger に変更。式案を 04 に。
- **C-16 サビ管 / サ提責の役職** → Staff.role に enum 値として明示（'service_manager' / 'service_provider_lead'）。
- **C-17 支給期間と上限期間の分離** → SF カスタム項目を 2 系統に分離（`ServiceDecisionPeriod__c` と `CopaymentLimitPeriod__c`）。
- **C-18 月額コスト試算** → 09 に「想定規模別月額コスト試算」セクションを新設。AppSheet ライセンス費 / SF EE / CloudSQL / Claude API トークン費の合算想定を提示。
- **C-19 / C-20 PITR と GAS 6 分上限** → 09 に手順表を追加、`scheduleResumption` の実コードスケッチを 06 に必須化。

---

## 2. スコープ調整提案

### 2.1 Must に昇格（Cycle 2 で新規 Must 化）

- **Must.10（新）契約・同意書管理**（C-11 由来）— 個別支援計画 Must.2 の前段成立に必須
- **Must.11（新）上限管理（事業所・上限月額・結果票）**（C-03 由来）— 請求 Must.6 の前提として必須

### 2.2 Should に降格

- なし。Cycle 1 の Must.1〜9 は全て Cycle 2 でも Must（中身を強化して再掲）。

### 2.3 新規 Won't（このプロジェクトでは扱わない）

- 国保連レセプト電子請求の **送信本体**（既存外部システム連携前提を再確認）
- 個別事業所カスタム帳票のレイアウト
- 多言語化（日本語のみ）

---

## 3. 技術選定の再検討要否

| 選定 | 維持/再検討 | 理由 |
|---|---|---|
| Salesforce EE + Person Account | **維持**（ただし Cycle 2 で Shield 追加採否を再評価） | C-05 / C-09 で要配慮 PII の暗号化要件が増えた。Shield Platform Encryption の費用便益を tech-research-notes に追記し、不採用ならその理由を明記する。 |
| CloudSQL MySQL 8 Enterprise（東京） | **維持** | C-01 / C-10 で鍵管理・WORM 要件が明確化。Enterprise の Transparent Data Encryption と Cloud KMS 連携で対応可能。 |
| AppSheet 単一アプリ | **維持** | C-05 を踏まえて Security Filter 設計を再構築。 |
| GAS V8 + UrlFetchApp | **維持**（C-20 のため Cloud Functions 比較を tech-research-notes に追加） | 6 分上限と継続実行の問題が顕在化。代替候補 Cloud Functions / Cloud Run jobs の比較表を Cycle 2 spec §5 の脚注に追加。 |
| Claude API（AI 機能） | **Cycle 2 でも Won't 据え置き** | C-01 で PII 取扱の基盤が脆弱なため、AI 機能投入は Cycle 3 以降に延期。 |

---

## 4. リスク台帳への追記項目（Cycle 2 spec.md §8）

| ID（仮） | リスク文 | 影響 | 可能性 | 対策案 |
|---|---|---|---|---|
| R-10 | 上限管理事業所が他事業所の場合、上限管理結果票の月次授受が遅延し請求保留が発生 | 高（請求遅延） | 中 | 月次締切前バッチで未受信検出 → サビ管に通知 |
| R-11 | Salesforce User と CloudSQL `staff` の同期遅延でアクセス制御が一時的に緩む | 中（PII 露出） | 中 | 同期は near-realtime（Platform Event 利用）or 入退社ワークフローへの組み込み |
| R-12 | GH 夜勤の打刻が日跨ぎ判定誤りでサービス提供記録が二重化 | 中（請求誤り） | 中 | `is_overnight` フラグと `shift_date` 1 本化、AppSheet 入力 UI に夜勤明示トグル |
| R-13 | AppSheet App ID 既知になり、外部からの API スキャンリスクが顕在化 | 中 | 中 | Application Access Key のローテーション運用、IP allowlist 検討（AppSheet 制約あり） |
| R-14 | Secret Manager 障害時に CloudSQL 暗号化フィールドが読めなくなり業務停止 | 高 | 低 | 鍵キャッシュ＋手動 fallback 手順を Runbook に明記 |

---

## 5. 法務・専門家レビューが必要な論点（次サイクル前にユーザー経由で外部レビュー）

| ID | 論点 | レビュー先候補 |
|---|---|---|
| L-13 | 上限管理結果票の電子授受方式（紙運用との並行可否） | 国保連 / 自治体障害福祉課 |
| L-14 | 個別支援計画における利用者署名の電子化（電子署名法、サービス提供責任者要件） | 顧問弁護士 |
| L-15 | 監査ログの保存期間と法定保存期間（5 年 / 10 年 / 永久）の対応関係 | 顧問弁護士 |
| L-16 | 要配慮個人情報の海外サーバ保管禁止と Claude API（米国）使用の整理 | 顧問弁護士 / DPO |
| L-17 | Salesforce Shield 非採用時の「適切な安全管理措置」の説明責任 | DPO / 監査法人 |

---

## 6. Cycle 2 着手前にユーザー確認したい事項（任意）

- AppSheet 実体（HopeCareDX）への Editor アクセス可否（co-author 招待 / Cookie 取得の許可）— Cycle 2 do/ で Security Filter 設計を実体ベースで検証したい
- 顧問弁護士 / 監査法人レビュー対象を L-13〜L-17 のうちどれに絞るか
- GCP コピー元プロジェクト ID / 元 schema の提供可否（C-06 / C-01 解消の精度向上）

---

## 7. Cycle 2 サイクル目標（planner への明示指示）

- Cycle 2 spec.md は本ファイル §1〜§5 を反映して再構成すること。
- Must 数は 11（既存 9 + 新規 2: 契約管理・上限管理）。
- 受入基準は「Cycle 1 で発覚した P1 7 件が解消できる」を明示条件に含める。
- §10「定義 完了」に「総合スコア ≥ 6.5 を Cycle 2 verifier から得る」を加える。
- §9 並列化ヒントは **4 ストリーム**（S1 データ／S2 連携／S3 セキュリティ／S4 福祉業界要件 = アセスメント・契約・上限管理）に増強。
