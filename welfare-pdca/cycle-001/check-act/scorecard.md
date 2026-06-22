# サイクル 001 スコアカード

## 重み付け総合スコア

| Lens | 平均 | 重み | 加重 |
|---|---|---|---|
| A. アーキテクチャ整合性 | 6.0 | 0.20 | 1.20 |
| B. データモデル健全性 | 5.3 | 0.25 | 1.325 |
| C. セキュリティ・個人情報 | 5.3 | 0.25 | 1.325 |
| D. 福祉業界要件 | 5.0 | 0.20 | 1.00 |
| E. 運用・コスト・拡張性 | 5.3 | 0.10 | 0.53 |
| **総合** | | | **5.38 / 10** |

## 判定: **FAIL**

- PASS: ≥8.0 かつ Critical ゼロ
- CONDITIONAL: 6.5-8.0 または Critical あり
- FAIL: <6.5
- 本サイクルは総合 5.38 < 6.5 で **FAIL**。spec §10 が定める Cycle 1 現実閾値 6.5 も下回る。Critical 計 21 件（A:4 / B:5 / C:4 / D:5 / E:3）。

## Critical Issues 一覧（全レンズ統合・優先度順）

> 重複する Issue は統合。「優先度」は次サイクルでの着手順を示す（P1=最優先）。

| # | 優先度 | 領域 | 統合 Issue | 由来 Lens | 関連 spec § |
|---|---|---|---|---|---|
| C-01 | P1 | データ整合性 / セキュリティ | `recipient_cert_no` の暗号化が `AES_ENCRYPT(?, @@global.secure_file_priv)` で実装誤り。鍵が MySQL システム変数（OS パス）になっており、特定機微 PII が事実上保護されない。`08-security-and-privacy.md` §2.1 の「Secret Manager で管理」と DDL/GAS コードが乖離。 | B#1 / C#2 | §6.Must.8 / §8 R-05 |
| C-02 | P1 | データモデル | `v_allotment_usage` ビューが「受給期間全体」を集計しており、spec §6.Must.4「月内に消費」と整合しない。月単位の支給量を超えた状態が累積で残り、超過警告が常時誤発火。 | B#2 | §6.Must.4 受入基準 |
| C-03 | P1 | 福祉業界要件 | 「上限管理事業所 / 利用者負担上限月額 / 上限管理結果票」の概念が一切モデル化されておらず、Must.6「請求準備データ」が国保連請求の前提を満たさない。 | D#1 | §6.Must.6 |
| C-04 | P1 | アーキテクチャ整合性 | 支給決定情報の SoR が二重定義され、AppSheet が同時に SF 直参照（`sf_service_allotments`）+ CloudSQL キャッシュ（`user_allotment_cache` / `v_allotment_usage`）を参照。01/02/05 の 3 ファイル間で経路が一致しない。 | A#1 | §4 / §6.Must.4 |
| C-05 | P1 | セキュリティ | AppSheet `USERSETTINGS()` ベースのロール / 所属事業所判定は改竄可能。要配慮 PII への AppSheet Security Filter が技術的に成立しない。 | C#3 | §6.Must.8 |
| C-06 | P1 | アーキテクチャ整合性 | `Facility__c`（Salesforce）と `facilities`（CloudSQL）の同期方針が未定義。`syncUsersFromSF` で SF Id → CloudSQL `facilities.id` の解決ロジックがなく、`user_mirror` の FK 制約違反が発生する。 | A#2 | §4 / §6.Must.1 |
| C-07 | P1 | データモデル | `shifts.chk_shift_time CHECK(end_time > start_time)` が GH 夜勤（17:00 → 翌 09:00 等）を拒否。spec §3「グループホーム等」と矛盾。 | B#4 | §6.Must.5 |
| C-08 | P2 | 福祉業界要件 | アセスメント / モニタリング実施記録 / サービス担当者会議の関連エンティティが欠落。`SupportPlan__c` 1 行だけで Must.2 受入基準を満たしたと評価しているが、実地指導で減算対象になる構造。 | D#2 | §6.Must.2 |
| C-09 | P2 | セキュリティ | CloudSQL の行レベル制御が「アプリ層で担保」とだけ書かれ、AppSheet を経由しない直接 SQL アクセスへの PII 保護が空欄。spec §7「5ロール × 5主要オブジェクト」のうち CloudSQL 層が定義不在。 | C#1 | §6.Must.8 / §7 |
| C-10 | P2 | セキュリティ | `audit_log` 自身の改竄防止策（append-only / WORM / 別バケット非同期エクスポート）が無い。法令対応の根拠資料としての価値を担保できない。 | C#4 | §6.Must.8 |
| C-11 | P2 | 福祉業界要件 | 「契約書 / 重要事項説明書 / 同意書」のドキュメント管理エンティティが Cycle 1 に存在しない。個別支援計画の前段が成立しない。 | D#5 | §6.Must.1 / §6.Must.2 |
| C-12 | P2 | アーキテクチャ整合性 | `audit_log` 書込みのアクター・経路が DDL とアーキ図で不整合。AppSheet 経由の更新が監査されない穴ができる。 | A#4 | §6.Must.8 |
| C-13 | P2 | アーキテクチャ整合性 | `staff` の SoR が決まらず、SF User と CloudSQL `staff` の同期方法・タイミングが空欄。`04` §9 のプロファイルは SF にスタッフが存在する前提だが、`06` には同期バッチが無い。 | A#3 | §6.Must.5 |
| C-14 | P3 | データモデル | `disability_type` の SF Picklist 値（英語コード）と CloudSQL `VARCHAR(20)` の値域が未統一。AppSheet Slice フィルタも仕様未定義。 | B#3 | §6.Must.1 |
| C-15 | P3 | データモデル | `SupportPlan__c` VR-02 が VLOOKUP で実装不能な式。spec §6.Must.2 受入基準「重複 active 計画を禁止」が形式合格にとどまる。 | B#5 | §6.Must.2 |
| C-16 | P3 | 福祉業界要件 | サービス管理責任者とサービス提供責任者の役職定義が混在。役職は `Staff.role` で正規化する必要。 | D#3 | §3 / §6.Must.2 |
| C-17 | P3 | 福祉業界要件 | 受給者証の「支給決定期間」と「自己負担上限額の決定期間」が単一 `ValidFrom__c` / `ValidTo__c` で混在表現されている。 | D#4 | §6.Must.1 |
| C-18 | P3 | 運用・コスト | 月額コスト試算（CloudSQL / Salesforce EE / AppSheet / Claude）が一切ない。「中小事業所がペイできる」要件の検証手段が空。 | E#1 | §1 / §7 |
| C-19 | P3 | 運用・コスト | PITR リストア手順は記述あるが、AppSheet データソース切替・GAS Script Properties 更新の所要時間が RTO 4h と整合する根拠が無い。Public IP 運用では DNS 切替も不可。 | E#2 | §6.Must.9 |
| C-20 | P3 | 運用・コスト | GAS 6 分上限と `scheduleResumption` の実装スケッチが空欄。連続失敗 / 二重実行防止 / 分散ロックが未定義で、月次バッチの安定性が担保できない。 | E#3 | §6.Must.6 |

> 統合の脚注: C-01 は Lens B#1 と Lens C#2 が同じ「鍵管理経路」を別方向（B: SQL 構文誤り / C: Secret Manager 連携の不在）で批判。両方を吸収して 1 件に統合し、Cycle 2 では「鍵の保管 → 取得 → 設定 → 暗号復号 → AppSheet 表示」の全経路を明文化することで決着とする。C-02 / C-04 はそれぞれ独立の論点（集計範囲 vs 参照経路）として併記。

## Major Issues 件数（参考）

| Lens | Major 件数 |
|---|---|
| A | 6 |
| B | 9 |
| C | 8 |
| D | 10 |
| E | 10 |
| **合計** | **43** |

> Major の代表的論点: `pushDailySummaryToSF` が SF カスタム項目を未定義のまま更新（A#4 / B#2）、`addition_master` の適用条件が空欄（B#5）、Salesforce Shield 不採用根拠の薄さ（C#6）、契約書・モニタリング・上限管理周辺の不足（D#1〜10）、月次コスト・API コール数試算不在（E#1, E#5）。

## 前サイクルからの改善

本サイクルは PDCA 1 周目のため該当なし。

## リグレッション

本サイクルは PDCA 1 周目のため該当なし。

## 補足

- spec §10「Cycle 1 の現実閾値 ≥ 6.5」を 1.12 ポイント下回る。Cycle 2 で **6.5 へ到達するための優先 Critical 7 件（P1）の解決** が必要十分条件。
- Critical 21 件中 P1=7 件（C-01〜C-07）を Cycle 2 で確実に解消すれば、総合スコアは +1.5〜2.0 程度の押し上げが期待でき、6.5 閾値に届く見込み。
- Cycle 2 では `existing-assets.md` の AppSheet App ID（`b9e4f84d-f9b9-4376-97f1-83e3b07122e3`）と App Name（`HopeCareDX_ainotudoi-443914355`）が既知前提となるため、AppSheet 実体への接続・実地検証を含む形に深化させる余地がある。
- Task tool（general-purpose subagent）が本セッション環境で未提供のため、5 並列レンズは welfare-verifier 単独で順次レビューとして実施。各レンズの観点は独立に評価し、結果を独立ファイル（`lens-{A..E}.md`）として残した。
