# Lens E — 運用・コスト・拡張性 — サイクル 001

## 観点と評価軸

`09-operational-runbook.md` を中心に、RPO/RTO の妥当性、バックアップ・PITR・DR、リリース手順、ロールバック、スケール戦略、月額コスト想定、GAS 6 分上限と将来スケール時のボトルネック、AppSheet ライセンスコスト、Salesforce ライセンスコストの観点を審査。

## 確認した成果物

- `welfare-pdca/cycle-001/do/09-operational-runbook.md`（全節）
- `welfare-pdca/cycle-001/do/01-architecture.md` §4
- `welfare-pdca/cycle-001/do/06-gas-integrations.md` §3, §4, §7
- `welfare-pdca/cycle-001/do/08-security-and-privacy.md` §2, §5
- `welfare-pdca/cycle-001/plan/spec.md` §6.Must.9, §7 運用受入基準

## Critical（必ず次サイクルで直す）

1. **月額コスト試算が一切ない**: `01-architecture.md` §4.1 で「db-custom-2-7680」を仮定するが、CloudSQL Enterprise 東京リージョン db-custom-2-7680 の概算月額、Salesforce Enterprise Edition 1 ユーザー単価、AppSheet Core / Enterprise Plus ライセンス単価、Claude API トークン費用の試算が `09-operational-runbook.md` / `01-architecture.md` のいずれにも存在しない。spec §1「中小規模の障害福祉サービス事業所」を対象としているのにコスト感ゼロ。
   - Why bad: 「中小規模事業所がペイできるシステム」を構造設計するのに月額試算なしでは、Cycle 2 で「事業所の予算規模」と乖離して着手不能になる。Salesforce EE は 1 ユーザー約 18,000 円/月、AppSheet Enterprise Plus は 1 ユーザー約 3,000 円/月、CloudSQL Enterprise db-custom-2-7680 は約 25,000 〜 35,000 円/月（asia-northeast1）。ステークホルダー 5 ロール × 10 名規模で月額 25 〜 30 万円規模になる試算が示されておらず、判断材料がない。
   - How to fix: Cycle 2 で `09` に「月額コスト試算（最小構成 / 想定ユーザー数 10/50/100 名スケール）」表を追加し、ライセンス・GCP・通信を内訳化。事業所が払える上限を spec.md に明記。
   - Spec §: §1 Vision / §7 運用受入基準

2. **PITR でのリストア手順は記述あるが、`AppSheet ↔ CloudSQL` の DSN 切替・GAS の Script Properties 更新が一連の作業フローとして検証可能な手順になっていない**: `09` §3 シナリオ B で「AppSheet のデータソース接続をリストアインスタンスに切替（または DNS 変更）」「GAS の JDBC URL を新インスタンスに更新（Script Properties）」と書かれているが、AppSheet のデータソース接続変更は AppSheet エディタ操作で「再認証 + リーガー再生成」が必要、DNS で切替するなら CloudSQL の固定 IP かプライベート IP のどちらで運用するかを決めねばならない。Cycle 1 で「Public IP 許可」（§4.2）としているため DNS 切替は機能しない。
   - Why bad: RTO 4 時間目標を達成する手順としては実用に耐えない（実際は AppSheet 再設定 + 再認証で半日かかる）。リハーサルもしないと完全停止に至る。
   - How to fix: Cycle 2 で「リストア用エイリアス IP」「AppSheet の事前設定済みセカンダリデータソース」「GAS の DSN を Properties Service で参照させる二系統設計」を追加。`09` §3 シナリオ B の復旧手順を「事前準備済みであることを前提に N 分で実行可能」と書き直す。
   - Spec §: §6.Must.9 受入基準 / §7 運用受入基準

3. **GAS 6 分上限と月次バッチのチャンク継続の運用検証が `runMonthlyBilling` 擬似コード（`06-gas-integrations.md` §4）に記述あるも、復旧シナリオが Runbook で語られない**: `06` §4.2 で「getRemainingExecutionTime() < 60000 で scheduleResumption() を呼ぶ」とあるが、`scheduleResumption` 実装が空欄。連続失敗時の累積トリガが GAS の同時実行上限（20 並列）に達した時の挙動、`Script Properties` のオフセット保存が失敗した場合の重複実行防止が `09` で扱われない。
   - Why bad: 月初 3 日以内に請求準備が確定しないと、後段の人手レビュー → 国保連送信が遅れる。バッチ中断時の運用が空欄だと毎月の請求業務が安定しない。
   - How to fix: Cycle 2 で「scheduleResumption の実装スケッチ」「分散ロック（CloudSQL の advisory lock）」「再開最大 N 回でアラート」を 06 と 09 に追加。

## Major（強く推奨）

1. **CloudSQL HA 構成「Single-zone で開始、Regional は SLA 強化時に移行」（`01-architecture.md` §4.1）と、RPO ≤ 1h / RTO ≤ 4h（`09` §1）が一貫しない**: Single-zone はゾーン全体障害時に RTO 数時間〜半日（手動 PITR + 新インスタンス作成）。「自動」と書かれていない手順で 4 時間を守るのは現実的に厳しい。Regional HA への移行優先度を Cycle 2 で明示するか、RTO を 8 時間に緩めるかを選択。
2. **`audit_log` の年次削除バッチが運用責任表に挙がっていない**: `08` §5.1 で「定期バッチ（年次）で物理削除」と書かれるが、`09` §6 定期保守タスクには「audit_log 保持期間チェック」だけで、削除実行は記述されない。法令保持期間が経過したら誰が物理削除するかが空欄。
3. **GAS スクリプトの Git 管理が「推奨」止まり（`09` §2）**: 監査対応では「GAS スクリプトのバージョン履歴」が証跡として必要。Cycle 2 で `clasp` + Git を Must 化、リリース手順 4.1 に PR / レビュー手順を組み込み。
4. **AppSheet バージョン履歴（`09` §5）からのロールバックは「30 分」と書かれるが、AppSheet 設定の「Bot / Action / Slice」全体の同時ロールバックは可能でも、CloudSQL DDL とセットでロールバックする調整は記述なし**: 「DDL も AppSheet も同時にロールバック」の手順を追加。
5. **`syncUsersFromSF` を 1 時間ごとに毎日 24 回実行した時の Salesforce API コール数の試算がない**: SF API 制限は EE で 1000 calls/day/user 程度（実際は組織単位で「Daily API Requests」上限 ≈ 100,000 + 25 × ユーザー数）。差分 SOQL 200 件チャンクは比較的低コストだが、Composite API での `pushDailySummaryToSF` が利用者 100 名 / 4 件 / 月で 12,000 calls/month、複数バッチでの呼び出し試算がない。
6. **Cloud SQL の自動拡張ストレージ初期 50GB は中小事業所には妥当だが、`audit_log` の `before_json` / `after_json` で行毎に 5 〜 50 KB を 5 年保持する成長予測がない**: 利用者 50 名 × 1 日 5 操作 × 365 日 × 5 年 × 10KB ≒ 4.5 GB。`service_records` 本体と監査ログで初期 50GB を超える時期の試算がない。
7. **Salesforce Data Export は週次が SF EE の標準だが、`09` §2「3 ヶ月保持」は SF 側のダウンロード保持期間ではなく、ダウンロードしたファイルの保持先（GCS / 外部ストレージ）が空欄**: バックアップが Salesforce 内に留まり、Salesforce 障害時の BCP に役立たない可能性。
8. **GAS の `claude-sonnet-4-6` 利用が「サービス記録要約補助（Should）」だが、トークン上限と料金試算が一切無い**: spec §5 R5 でプロンプトキャッシング有効化を謳うが、月次の AI コスト試算が無い。Cycle 2 で MUST 化されれば予算超過の可能性。
9. **Cycle 1 における設定変更の証跡が `audit_log` の `actor_type='system'` で一括分類**: AppSheet 設定変更を `batch_run_log`（イベント種別 = APP_UPDATE）として記録するとの記述（`09` §4.3）と、`audit_log` の `event_type` 一覧（`08` §5.1）に APP_UPDATE が無いことの不整合。
10. **`09` §7 連絡先・エスカレーションに「外部 SaaS ベンダーサポート」「内製チーム」「業務委託先」の役割分担が不在**: 法人としての RACI（責任者 / 実行者 / 相談者 / 報告者）が空欄。

## Minor（余裕があれば）

1. PITR の保持 7 日間は中小事業所には妥当だが、ランサムウェア対応で「論理削除攻撃から 7 日以内に検知できるか」の論点が無い。
2. CloudSQL Enterprise エディションを選んでいるが、Enterprise Plus への将来移行の手順（既存インスタンスからのアップグレード可否）が `09` に空欄。
3. `staff` テーブルの「退職時のアカウント無効化バッチ」が `09` §6 定期保守に無い。
4. AppSheet ライセンス区分（Core / Enterprise Standard / Enterprise Plus）の選択根拠が `01-architecture.md` で記述なし（Security Filter は Enterprise Plus でしか使えない式が含まれる可能性）。
5. `gcloud sql instances restore-backup` の `--restore-instance` フラグ（`09` §3 シナリオ B）は新インスタンス名作成の文脈で使われるが、`gcloud sql backups restore` との使い分けが不正確。

## スコア（1-10）

- 完全性: 4（コスト試算ゼロ、AI 利用試算ゼロ、BCP 検証手順薄、定期保守の責任表薄）
- 整合性: 6（バックアップ・PITR・Runbook の構造自体は一貫）
- 妥当性: 6（中小事業所運用としては「3 シナリオ × 3 列」の骨格は妥当だが、Single-zone と RTO 4h の整合性に難）
- 平均: **5.3**
