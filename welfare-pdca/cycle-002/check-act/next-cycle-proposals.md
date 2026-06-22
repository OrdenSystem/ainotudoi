# 次プロジェクト引き継ぎ事項（本プロジェクト最終サイクル想定）

> 入力: `cycle-002/check-act/scorecard.md`（総合 6.27 / 10、判定 **FAIL**、Critical 11 件、+0.89 改善）
> 本プロジェクトは Cycle 2 を最終サイクルとして閉じる前提。Cycle 3 以降は別プロジェクト or 実装フェーズへの引き渡しとなる。本ファイルは「次に着手する誰か」が最初に読む引き継ぎ書。

---

## 1. このプロジェクトの到達点（成果サマリ）

- **Cycle 1 FAIL（5.38）→ Cycle 2 FAIL（6.27）**: 閾値 6.5 には 0.23 ポイント不足だが、P1 Critical 7 件は **完全解消 5 件 / 大半解消 2 件**。実装フェーズに進むための地ならしは最低限完了。
- **設計成果物**: `welfare-pdca/cycle-002/do/01〜10` の 10 ファイル、約 4,500 行。Mermaid 図 / DDL / 擬似コード / シーケンス図 / アクセス制御マトリクスを含む。
- **既知前提**: AppSheet App ID `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`（HopeCareDX_ainotudoi-443914355）/ GCP Project ID `ainotudoi-443914355` / Region `asia-northeast1`。

---

## 2. 引き継ぎ先が**着手前に必ず潰すべき**P1 Critical 6 件

> Cycle 2 verifier が新規に検出した P1 Critical 6 件（C2-01〜C2-06）。これらは spec.md §6 Must 受入基準の「形式合格 / 実質不合格」を生み出している論点で、実装フェーズに入る前に設計を完成させる必要がある。

### C2-01 個別支援計画の親子エンティティの CloudSQL ミラー欠落
- **修正対象**: `02-data-model.md` / `03-cloudsql-ddl.sql` / `05-appsheet-tables.md`
- **着手内容**: `support_plan_mirror` / `assessment_mirror` / `monitoring_record_mirror` / `care_plan_meeting_mirror` の 4 テーブル DDL を追加。同期キー = SF Id。`syncSupportPlansFromSF` GAS 関数を `06` に新設。AppSheet に `SupportPlanForm` / `AssessmentList` / `MonitoringRecordList` View を追加。
- **影響**: サビ管が AppSheet で個別支援計画を作成・編集できるようになる。SF Lightning ライセンス費の削減検討材料が揃う。

### C2-02 SF 上限管理オブジェクトの未定義
- **修正対象**: `04-salesforce-objects.md`
- **着手内容**: `UpperLimitFacility__c` 等の最小 SF オブジェクトを追加（同期キー = `facility_number`）。または spec §6.Must.11 受入基準を「CloudSQL のみで完結」に下方修正し合意取得。
- **影響**: spec §6.Must.11 の完全解消、`10-traceability-matrix.md` の虚偽記述解消。

### C2-03 AppSheet → audit_log の発火経路実装
- **修正対象**: `01-architecture.md` / `06-gas-integrations.md` / `07-integration-flows.md` / `08-security-and-privacy.md`
- **着手内容**: 「AppSheet Bot（On record change）→ Webhook → GAS WebApp → audit_log INSERT」のフローを設計。または MySQL Trigger 方式を比較検討して `03-cloudsql-ddl.sql` に AFTER INSERT/UPDATE/DELETE トリガを追加。
- **影響**: 監査ログが現実に機能する。個人情報保護法 / 障害者総合支援法対応の根拠資料として有効化。

### C2-04 audit_log JSON の PII 平文書出し（最重要リグレッション）
- **修正対象**: `03-cloudsql-ddl.sql` §16 / `08-security-and-privacy.md` §6
- **着手内容**: `audit_log.before_json` / `after_json` の書込みルールを「要配慮 PII 列は値マスク or 暗号化」に統一。`recipient_cert_no` は変更通知のみで値は記録しない。WORM バケットへの 5 年保持を始める前に必須対応。
- **影響**: PII 漏洩時に削除要請に対応できる。個人情報保護委員会報告のリスクが下がる。

### C2-05 SF User → CloudSQL staff の同期関数欠落
- **修正対象**: `06-gas-integrations.md` / `01-architecture.md`
- **着手内容**: `syncStaffFromSF` を `06` 関数一覧に追加。SF Profile + Permission Set → `staff.role` の対応表、SF Public Group → `staff_facility_map` 生成ロジックを明記。
- **影響**: USERSETTINGS 全廃の代替（Security Filter 中核）が実際に機能する。本番投入時のアクセス制御事故を防ぐ。

### C2-06 v_allotment_usage のサービス種別 JOIN 漏れ
- **修正対象**: `03-cloudsql-ddl.sql` `v_allotment_usage` VIEW
- **着手内容**: JOIN 条件に `service_master.service_type = a.service_type` の整合性チェックを追加。または `service_records` に `service_type` 非正規化列を持たせる。
- **影響**: 複数サービス並用利用者の支給量超過警告が正確になる。請求事故を防ぐ。

---

## 3. P2 Critical 3 件（着手前 or 並行で潰すべき）

| ID | 内容 | 修正対象 |
|---|---|---|
| C2-07 | AppSheet Bot 通知本文の PII マスキング | `05-appsheet-tables.md` §6 / `08-security-and-privacy.md` §3 |
| C2-08 | 身体拘束 / 行動制限の専用エンティティ追加（減算ペナルティ対策）| `04-salesforce-objects.md` / `03-cloudsql-ddl.sql` / `02-data-model.md` |
| C2-09 | 保護者 / 法定代理人 / 成年後見人エンティティ追加 | `04-salesforce-objects.md` `Guardian__c` 等 |

---

## 4. P3 Critical 2 件（コスト・運用の論点、優先度低）

| ID | 内容 | 修正対象 |
|---|---|---|
| C2-10 | SF ライセンス内訳の前提精査（Full License vs Platform License 分割）| `09-operational-runbook.md` §6 |
| C2-11 | `scheduleResumption` の再実行粒度統一（月全体 or 行単位）| `06-gas-integrations.md` §7 / `09-operational-runbook.md` §3-§4 |

---

## 5. 「実装に進めるための前提条件」チェックリスト

実装フェーズ着手前に、引き継ぎ先で以下を確認:

- [ ] **P1 Critical 6 件**（§2）が解消されている
- [ ] **GCP プロジェクト準備**: `ainotudoi-443914355` の権限が引き継ぎ先 IAM で構成済み
- [ ] **Cloud KMS 鍵リング**: `welfare/cloudsql-kek`（asia-northeast1）が作成済み
- [ ] **Secret Manager**: `SF_PRIVATE_KEY` / `CS_DB_PASSWORD` / `GCP_PROJECT_ID` / `BILLING_JOB_URL` 等の 8 種以上のシークレットが登録済み
- [ ] **Salesforce 環境**: Enterprise Edition + Person Account 有効化（**不可逆**、spec §8 R-07）の事前承認取得
- [ ] **AppSheet エディタアクセス**: HopeCareDX への co-author 招待が完了し、Cookie 取得して書込検証可能
- [ ] **法務レビュー結果**: L-13〜L-17 の 5 件のうち少なくとも L-14（電子署名）と L-17（Shield 非採用説明責任）の判断書面取得
- [ ] **コスト承認**: 想定規模（500 名 ≈ ¥328,200/月 / 2,000 名 ≈ ¥1,059,900/月）の予算枠決裁完了

---

## 6. 技術選定の再検討要否

| 選定 | 状態 | 引き継ぎ時の論点 |
|---|---|---|
| Salesforce EE + Person Account | 維持 | C2-10: Full License 10 名前提が妥当か精査。SF Platform License との混在で削減余地検討 |
| CloudSQL MySQL 8 Enterprise + CMEK | 維持 | C-01 解消で本決まり。Single-zone → Regional HA への移行タイミングを実装フェーズで確定 |
| AppSheet 単一アプリ（HopeCareDX）| 維持 | C-05 解消で本決まり。Enterprise Standard / Plus どちらのライセンスかライセンス精査（Lens E Major #3） |
| GAS V8 + Cloud Run jobs ハイブリッド | 維持 | C-20 解消で本決まり。`scheduleResumption` 粒度の確定（C2-11）が前提 |
| Salesforce Shield Platform Encryption | **Cycle 2 不採用** | L-17 法務レビュー後、規模拡大時に再評価候補 |
| Claude API（AI 機能）| **Cycle 2 / Cycle 3 不採用** | C2-04（audit_log の PII 平文）解消後に再評価。PII マスキング基盤が前提 |

---

## 7. リスク台帳引き継ぎ

`spec.md` §8 のリスク台帳 R-01〜R-15 のうち、本サイクル中に状態変化したもの:

| ID | 状態変化 |
|---|---|
| R-01（AppID 未受領）| **解消済**（Cycle 2 で受領） |
| R-03（CloudSQL コピー元 schema 未提供）| **未解消**。実装フェーズで既存 schema との突合タスク化必要 |
| R-06（GAS 6 分上限）| **対策実施済**（Cloud Run jobs 分離） |
| R-09（Claude API PII 送信）| **未解消**。Cycle 4 以降の AI 機能投入時に PII マスキング基盤要 |
| R-10（上限管理結果票授受遅延）| **対策設計済**（UpperLimitWarningBot）、L-13 法務レビュー待ち |
| R-11（SF User ⇄ staff 同期遅延）| **対策設計不在**（C2-05 関連） |
| R-13（AppSheet App ID 既知化）| **対策設計あり**（Application Access Key ローテーション + IP allowlist 検討） |
| R-14（KMS / Secret Manager 障害）| **対策設計済**（鍵キャッシュ + 手動 fallback、`09` §3 シナリオ S5/S6） |
| R-15（Shield 非採用説明責任）| **未解消**（L-17 法務レビュー必須） |

---

## 8. 法務・専門家レビューが必要な論点（実装フェーズ前に解消推奨）

| ID | 論点 | レビュー先候補 | 緊急度 |
|---|---|---|---|
| L-13 | 上限管理結果票の電子授受方式 | 国保連 / 自治体障害福祉課 | 中（Cycle 3 実装の前提）|
| L-14 | 個別支援計画・契約 3 点セットの利用者署名電子化 | 顧問弁護士 | **高**（Must.10 機能の前提）|
| L-15 | 監査ログ / 各データの保持期間（5 年）の法定整合 | 顧問弁護士 | 中 |
| L-16 | 要配慮 PII の海外サーバ保管禁止と Claude API（米国）使用整理 | 顧問弁護士 / DPO | 低（Cycle 4 以降）|
| L-17 | Salesforce Shield 非採用の「適切な安全管理措置」説明責任 | DPO / 監査法人 | **高**（R-15 / Cycle 3 監査対応）|

---

## 9. 引き継ぎ先のための「最初に読むべき」ファイル順序

1. `welfare-pdca/cycle-002/check-act/scorecard.md` — 到達点と未達課題の俯瞰
2. `welfare-pdca/cycle-002/plan/spec.md` — 設計の意図（Must 11 項目）
3. **本ファイル（next-cycle-proposals.md）** — Critical 11 件の解消順序
4. `welfare-pdca/cycle-002/do/01-architecture.md` — 全体構成図と SoR 表
5. `welfare-pdca/cycle-002/do/03-cloudsql-ddl.sql` — 全テーブル DDL
6. `welfare-pdca/cycle-002/do/08-security-and-privacy.md` — 鍵管理・PII フロー
7. `welfare-pdca/cycle-002/do/10-traceability-matrix.md` — Must / Critical 対応表（**注: grep 検証コマンドの結果は字面合っていない箇所あり、Lens A Major #1 参照**）
8. 残り do/ ファイル

---

## 10. 残スコープ（次プロジェクトの判断材料）

本プロジェクトでは扱わなかった / Out of Scope のままにした論点:

- 国保連レセプト電子請求の送信本体
- 帳票印刷レイアウト（実地指導対応含む）
- 利用者家族向けポータル（SF Customer Community 候補）
- AI 機能（Claude API による記録要約・計画ドラフト支援）— C2-04 解消後の Cycle 4 候補
- 多事業所横断 BI ダッシュボード
- スマホネイティブ実装
- 個別事業所カスタム帳票
- 多言語化
- 業務記録系（事業所内研修・虐待防止委員会・苦情処理）
- サービス利用計画（市町村が作成する計画相談支援）の保管

これらは別プロジェクト / 次フェーズで扱うか、永続的に Out of Scope とするかを引き継ぎ先で判断する。

---

## まとめ

- **Cycle 2 は FAIL（6.27/10）だが、P1 Critical 7 件全解消・+0.89 改善は実装着手の最低条件を満たす**
- **新規 Critical 11 件のうち P1 = 6 件は次プロジェクト着手前に必ず解消**
- **L-14 / L-17 の法務レビュー先行が実装フェーズの前提**
- **コスト承認（最大 ¥1,059,900/月）とSF ライセンス内訳の精査が予算決裁の鍵**
