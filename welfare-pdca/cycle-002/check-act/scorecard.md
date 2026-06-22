# サイクル 002 スコアカード

## 重み付け総合スコア

| Lens | 平均 | 重み | 加重 |
|---|---|---|---|
| A. アーキテクチャ整合性 | 6.67 | 0.20 | 1.334 |
| B. データモデル健全性 | 6.33 | 0.25 | 1.583 |
| C. セキュリティ・個人情報 | 6.33 | 0.25 | 1.583 |
| D. 福祉業界要件 | 5.67 | 0.20 | 1.134 |
| E. 運用・コスト・拡張性 | 6.33 | 0.10 | 0.633 |
| **総合** | | | **6.27 / 10** |

## 判定: **FAIL**

- PASS: ≥8.0 かつ Critical ゼロ
- CONDITIONAL: 6.5–8.0 または Critical あり
- FAIL: <6.5
- 本サイクルは総合 6.27 < 6.5 で **FAIL**。spec.md §10「verifier 総合スコア ≥ 6.5（Cycle 1 = 5.38 から 1.12 ポイント以上の改善）」の閾値を **0.23 ポイント下回る**。
- ただし Cycle 1 比 +0.89 ポイントの改善は達成（5.38 → 6.27）。P1 Critical 7 件の全面解消が効いた一方、設計の深層に新規 Critical が出現したため閾値到達には至らず。
- Critical 件数（重複統合後）: 全 **11 件**（A 3 / B 4 / C 3 / D 3 / E 3 を統合）。

## Critical Issues 一覧（全レンズ統合・優先度順）

> 重複統合: Lens A Critical #2「audit_log AppSheet 経路空欄」と Lens C Critical #1 は同一論点 → 1 件統合。
> Lens A Critical #3「個別支援計画 UI 経路」と Lens B Critical #1「SF 子オブジェクトの CS ミラー欠落」と Lens D Critical #3「同意取得日不在」は密結合 → C-2102 として一体扱いだが Critical 件数としては別カウント。

| # | 優先度 | 領域 | 統合 Issue | 由来 Lens | 関連 spec § / Cycle 1 残課題 |
|---|---|---|---|---|---|
| **C2-01** | P1 | データモデル / 業界要件 | **`Assessment__c` / `MonitoringRecord__c` / `CarePlanMeeting__c`（SF 子）に対応する CloudSQL ミラー DDL が無く、AppSheet からアセスメント・モニタリング・担当者会議が読み書きできない**。`01-architecture.md` §2 で「support_plan_mirror = Cycle 3 実装」と先送り。spec §6.Must.2 受入基準「親子構造 1:N 関係が定義」「実地指導減算リスクに対応する記録欠落検出ルールが明示」が UI 経路抜きで形式合格扱い。`10-traceability-matrix.md` §3 「CS_CarePlanMeeting DDL」と虚偽記述。 | A#3 / B#1 / D#2(部分) | §6.Must.2 / §3 法令前提（実地指導減算）/ Cycle 1 D#2 残存 |
| **C2-02** | P1 | データモデル / 業界要件 | **`UpperLimitFacility__c` 等の SF カスタムオブジェクトが `04-salesforce-objects.md` に未定義**。spec §6.Must.11 受入基準は「`do/03` / `do/04` / `do/05` の 3 箇所に存在」を明示要求するが、04 にゼロ。`10-traceability-matrix.md` §2 C-03「SF: UpperLimitFacility__c → Custom Object 定義追加 → 04-sf.md」と虚偽記述。 | B#2 / D#1(部分) | §6.Must.11 受入基準 |
| **C2-03** | P1 | アーキテクチャ / セキュリティ | **AppSheet 由来の更新が `audit_log` に記録される実装経路が空欄**。`01-architecture.md` §1 Mermaid のエッジは描かれるが、`05-appsheet-tables.md` §5 Action 5 種のうち audit_log INSERT を実行するのは `exportBillingCSV`（GAS WebApp）のみ。AppSheet 標準では 1 アクションから複数テーブル INSERT を発火する Standard 手段が無く、Bot or Webhook 経由 GAS の実装スケッチがない。spec §6.Must.8「audit_log append-only」が監査記録欠損で形式合格扱い。Cycle 1 A#4 が部分解消止まり。 | A#2 / C#1 | §6.Must.8 受入基準 / Cycle 1 A#4 残存 |
| **C2-04** | P1 | セキュリティ | **`audit_log.before_json / after_json` に要配慮 PII が平文で残り、Cloud Storage WORM（5 年保持）に複製される**。`08-security-and-privacy.md` §9.1「最小化原則」と直接矛盾。要配慮列マスク方針が `03` / `08` のいずれにも無い。Cycle 1 Lens B Major #9 が Cycle 2 で Critical 化（WORM 書出しと連動して影響拡大）。 | B#4 / C#2 | §6.Must.8 / §7（要配慮 PII 保護）/ Cycle 1 B Major #9 残存 |
| **C2-05** | P1 | アーキテクチャ | **SF User → CloudSQL `staff` の同期関数が空欄**。Security Filter `staff_facility_map` 参照（C-05 中核）の前提テーブル投入経路が未定義。spec §8 R-11 は同期遅延リスクを挙げるが、そもそも同期関数が存在しないことに気づいていない。`06-gas-integrations.md` §1 関数一覧に `syncStaffFromSF` 不在。Cycle 1 A#3 残存。 | A#1 | §6.Must.5 / §6.Must.8 受入基準 / Cycle 1 A#3 残存 |
| **C2-06** | P1 | データモデル | **`v_allotment_usage` でサービス種別 JOIN 条件欠落**。`a.allotment_unit` が GROUP BY キーのため一見正常に見えるが、`LEFT JOIN service_records ON sr.user_id = a.user_id` のみで `service_type` JOIN がなく、複数サービス並用利用者の集計がクロス汚染。Cycle 1 Lens B Major #8 が Cycle 2 で同型バグ残存（YEAR/MONTH フィルタを足しただけで根本未修正）。 | B#3 | §6.Must.4 受入基準 / Cycle 1 B Major #8 残存 |
| **C2-07** | P2 | セキュリティ | **AppSheet Bot 通知本文に利用者氏名等の要配慮 PII を含むリスク**。`AllotmentWarningBot` / `ContractExpiryBot` / `UpperLimitWarningBot` 3 種すべて利用者識別子を含む通知設計。`08-security-and-privacy.md` でマスキング方針記載なし。第三者ロック画面閲覧リスク。Cycle 1 Lens C Major #7 残存。 | C#3 | §6.Must.8 / §3 法令前提（要配慮 PII 第三者提供） |
| **C2-08** | P2 | 業界要件 | **身体拘束 / 行動制限の記録専用エンティティが欠落**。「身体拘束廃止未実施減算」（基本報酬の 5/100 減算）の具体金銭ペナルティ対応不能。`service_records.notes TEXT` 自由記述では月次集計・実地指導抽出不可。Cycle 1 Lens D Major #7 が Cycle 2 で Critical 化。 | D#1 | §3 法令前提 / §2 In Scope（GH 等） |
| **C2-09** | P2 | 業界要件 | **保護者 / 法定代理人 / 成年後見人エンティティ未対応**。`ConsentForm__c.SignedBy__c Text(80)` で文字列吸収だが、契約者 ≠ 利用者の家族構造で「同じ保護者の複数契約」を検索できない。spec §6.Must.10 受入基準（契約者の識別）と矛盾。Cycle 1 Lens D Major #10 残存。 | D#2 | §6.Must.10 受入基準 / §3 法令前提 |
| **C2-10** | P3 | 運用・コスト | **SF ライセンス内訳前提が `09` §6 で 10 名 Full License × $150 と単一区分**。AppSheet 50 名と SF 10 名の役割境界が `01-architecture.md` の SoR 表で個別支援計画 SF SoR と矛盾（サビ管が SF Lightning 直接編集する設計暗黙化）。spec §1「中小事業所がペイ」判定材料として支配的（試算 65%）だが代替案検討空。 | E#1 | §1 Vision / §7 運用受入基準（コスト） |
| **C2-11** | P3 | 運用・コスト | **Cloud Run jobs `scheduleResumption` の再実行粒度が GAS / Python / Runbook で不一致**。GAS は月全体新 run_id、Python は失敗行のみ retry、Runbook §3 シナリオ S4 は status='error' のみ再実行。`billing_prep` に複数 batch_run_id 混在で請求担当が confirm すべき行を選択困難。spec §6.Must.6 受入基準「冪等性」が形式合格にとどまる。 | E#2 | §6.Must.6 受入基準 |

> 詳細な Major / Minor は各 lens-{A..E}.md を参照。

## P1 7 件（Cycle 1 C-01〜C-07）解消検証

| Critical ID | 内容 | 解消 Must / spec § | 解消状況 | エビデンス |
|---|---|---|---|---|
| **C-01** | 鍵管理経路の不在（AES_ENCRYPT 誤り）| Must.8 / §4「鍵管理経路」/ §6.Must.8 受入基準 | **完全解消** | DDL §3 `VARBINARY(256)` + KMS コメント、GAS §2.3 `kmsEncrypt/kmsDecrypt` 実装、Runbook §1 環境定義表で KEK パス統一。grep で `AES_ENCRYPT` 実装ヒットゼロ（注: 廃止解説の文脈は 16 件ヒット）。Lens B / C で「完全解消」評価 |
| **C-02** | 月次集計の誤り（v_allotment_usage 全期間集計） | Must.4 / §6.Must.4 受入基準（`WHERE YEAR/MONTH`） | **解消** | DDL `v_allotment_usage` の `consumed_hours/times/days` および `remaining_qty` に `YEAR(NOW()) AND MONTH(NOW())` フィルタ追加。Lens B で「解消」評価。**ただしサービス種別 JOIN 漏れの別 Critical（C2-06）が残存** |
| **C-03** | 上限管理エンティティ欠落 | Must.11 / §6.Must.11 | **大半解消** | DDL §12-14 で 3 テーブル新設、AppSheet §2.8 で View / Slice、`07` §5 で月次授受シーケンス図。**ただし SF 側オブジェクト未定義（C2-02）と「sent 方向の送信フロー空欄」（Lens D Major #12）が残存** |
| **C-04** | 支給決定 SoR の二重定義（AppSheet が SF 直 + CS 両参照） | Must.1 / 全 SoR 表 / §6.Must.1 受入基準 | **完全解消** | `05-appsheet-tables.md` §1 で `WelfareSalesforce` コネクタ廃止明記、`01-architecture.md` §2 SoR 表で全エンティティ「CloudSQL 経由のみ読取」統一。Lens A で「解消」評価 |
| **C-05** | USERSETTINGS 改竄リスク | Must.8 / §6.Must.8 受入基準（USERSETTINGS 全廃 / R9） | **完全解消** | `05-appsheet-tables.md` §7 で全 Security Filter を `USEREMAIL() + staff_facility_map` 参照に統一、`staff_facility_map` テーブル DDL §5。Lens C で「解消」評価。**ただし前提テーブル `staff` の投入経路が空（C2-05）** |
| **C-06** | SF Facility → CloudSQL 同期未定義 | Must.7 / §4「Facility マスタの連携」/ §6.Must.7 | **完全解消** | DDL §2 `facility_id_map` 新設、GAS §4 `syncFacilitiesFromSF` 完全実装、`07` §2 にシーケンス図。Lens A / B で「解消」評価 |
| **C-07** | GH 夜勤の制約違反（CHECK end_time > start_time） | Must.3 / Must.5 / §3 用語 / §6.Must.3 受入基準 | **完全解消** | DDL §6 で `CHECK (end_time != start_time)` 緩和、`is_overnight` 追加、夜勤例コメント明記。AppSheet §2.4 で `is_overnight` トグル UI 追加。Lens B で「解消」評価 |

**判定**: P1 Critical 7 件はすべて設計上解消（完全解消 5 件 / 大半解消 2 件）。Cycle 2 の主目的「Cycle 1 FAIL 主因の解消」は **達成**。一方、深層レビューで新規 Critical 11 件が浮上したため総合スコアは閾値未達。

## 前サイクルからの改善

| 領域 | Cycle 1 | Cycle 2 | 改善幅 |
|---|---|---|---|
| **Lens A 平均** | 6.0 | 6.67 | +0.67 |
| **Lens B 平均** | 5.3 | 6.33 | +1.03 |
| **Lens C 平均** | 5.3 | 6.33 | +1.03 |
| **Lens D 平均** | 5.0 | 5.67 | +0.67 |
| **Lens E 平均** | 5.3 | 6.33 | +1.03 |
| **総合** | **5.38** | **6.27** | **+0.89** |
| Critical 件数 | 21 件（P1=7 / P2=4 / P3=10） | 11 件（P1=6 / P2=3 / P3=2） | -10 件 |

**特に効いた改善（次サイクル planner が継続すべき）**:
1. **KMS / Secret Manager 一本化（C-01）**: DDL / GAS / Runbook の 3 ファイルで KEK パス文字列共有、Application-level 暗号化と CMEK の二段防御を明文化。Lens B / C スコアを大きく押し上げ。
2. **`facility_id_map` + `syncFacilitiesFromSF`（C-06）**: SF Facility ↔ CloudSQL facilities の ID マッピングを独立テーブル化し、FK 解決を一元化。クロスファイル整合性が大幅向上。
3. **USERSETTINGS 全廃 + `staff_facility_map`（C-05）**: 改竄可能なクライアント側設定への依存を全廃。AppSheet Security Filter 設計を CloudSQL 側に責任移転。
4. **Cloud Run jobs 分離（C-20）**: GAS 6 分上限という根本的なボトルネックを解消。`scheduleResumption` 実装スケッチも整備（粒度不一致は残るが構造は完成）。
5. **コスト試算 / PITR 手順表 / 6 シナリオ × 3 列 Runbook（C-18 / C-19）**: Lens E の中核 Critical 3 件すべて埋まり、Cycle 1 比で運用記述の具体性が大幅向上。
6. **契約 3 点セット + 上限管理 3 テーブル + 個別支援計画親子（Must.10 / Must.11 / C-08）**: 業界要件のカバレッジ拡張（D Critical 5 件中 3 件完全解消、2 件部分解消）。

## リグレッション

| 件数 | 内容 |
|---|---|
| **3 件** | (1) `audit_log.before_json` への PII 平文（Cycle 1 B Major #9 → Cycle 2 C2-04 Critical 化、WORM 書出しと連動で影響拡大）<br/>(2) AppSheet Bot 通知本文 PII（Cycle 1 C Major #7 → Cycle 2 C2-07 Critical 化、Bot 数が 3 → 5 種に増えた分リスク拡大）<br/>(3) 身体拘束記録（Cycle 1 D Major #7 → Cycle 2 C2-08 Critical 化、減算ペナルティの具体性指摘） |

> Cycle 1 で「Major」だった 3 論点を Cycle 2 で対応せず放置した結果、Cycle 2 設計のレベルアップに伴い「相対的な重大度」が上昇して Critical 化。意味的には新規 Critical ではなく **未解決 Major の Critical 格上げ**。

**最重要リグレッション 1 件**: **`audit_log.before_json` への PII 平文（C2-04）**。Cycle 2 で `audit_log` を append-only + WORM 5 年保持に強化したため、PII が平文で 5 年間削除不能の場所に複製される設計矛盾が深刻化した。Cycle 3 着手前に必ず修正必要（個人情報保護委員会対応の根拠資料として致命的）。

## spec §10「verifier 総合スコア ≥ 6.5」達成判定

- **未達成**（実績 6.27、目標 6.50、不足 0.23）。
- P1 7 件解消は完了したが、新規 Critical 11 件（うちリグレッション 3 件）で押し戻された。
- Cycle 1 から **+0.89 ポイント** 改善 → Cycle 2 spec の意図「Cycle 1 = 5.38 から 1.12 ポイント以上の改善」は **未達成**（+0.89 < +1.12）。

## 補足

- 5 並列 Task tool が本セッション環境で未提供のため、Cycle 1 同様 welfare-verifier 単独で順次レビュー実施。各レンズの観点は独立に評価し、結果を独立ファイル（`lens-{A..E}.md`）として残した。
- 本プロジェクトの **最終サイクル想定**のため、`next-cycle-proposals.md` は次プロジェクト引き継ぎ事項を簡潔に記載する。
- spec.md §10 閾値未達であっても、P1 全件解消・総合 +0.89 改善は実装に進めるための最低限の地ならし達成。プロジェクト判断としては「条件付き合格（CONDITIONAL）に近い FAIL」と解釈してよい。
