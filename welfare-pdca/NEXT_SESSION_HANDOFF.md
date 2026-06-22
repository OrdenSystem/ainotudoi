# 次セッション引継ぎ書

**作成日**: 2026-06-23
**作成者**: Claude Code (claude-opus-4-7)
**ブランチ**: `feat/welfare-3services-onboarding`

---

## 0. このドキュメントの使い方

次セッション開始時は **このファイルから読む**。
以下を順に確認すれば、即座に作業再開できる。

1. §1 全体進捗（完了/残課題）
2. §2 ユーザー作業 4 件のステータス確認質問
3. §3 E2E テスト 6 件
4. §4 関連ドキュメント早見表

---

## 1. 全体進捗サマリ

### 完了（私が実施・本番反映済 + git commit 済）

| レイヤ | 内容 | 状態 |
|--------|------|------|
| **SF Schema** | DisabilityCard__c に 8 列追加 + Validation + Picklist + Layout + PermSet | ✅ 本番デプロイ済 |
| **AppSheet 主アプリ View** | 7 View に 32 列追加（Form/Detail/Inline 4本含む） | ✅ saveapp 適用済 |
| **AppSheet DB 加算マスタ** | 3 マスタ × 3 サービス = 112 行投入（事業所/利用者/利用者基本） | ✅ AppSheet API v2 で投入済 |
| **CloudSQL DDL** | 5 新規テーブル本番適用（児童入所登録 / 短期入所登録 / 日中一時登録 / 市町村マスタ / 日中一時単価マスタ） | ✅ 本番 hopecare DB 適用済 |
| **大和高田市 単価マスタ** | 21 行 INSERT（障害種別×区分×時間区分） | ✅ 投入済 |
| **GAS 新ファイル 2 本** | `001_レセプト生成_入所系.gs` (741 行) + `001_レセプト生成_6月改定_相談.gs` (215 行) | ✅ git commit 済 / ⏸ Apps Script 未デプロイ |
| **GAS 既存ファイル patch** | `001_レセプト生成_CloudSQL.gs` のディスパッチ追加 8 行 | ✅ git commit 済 / ⏸ Apps Script 未デプロイ |

### 残課題（次セッション以降）

- ユーザー作業 4 件（§2 参照）
- E2E テスト 6 件（§3 参照）

---

## 2. ユーザー作業 4 件のステータス確認

次セッション開始時、まずユーザーに以下を聞く（クローズドクエッション）：

```
ユーザー作業 4 件のうち、どこまで完了していますか？
(1) リタリコ Excel テンプレ 5 ファイル準備 + Drive Upload  → 完了 / 未完
(2) Apps Script 3 ファイルデプロイ                          → 完了 / 未完
(3) Script Properties 7 項目設定                            → 完了 / 未完
(4) AppSheet 請求アプリ Bot 引数調整                        → 完了 / 未完
```

### 詳細

#### (1) リタリコ Excel テンプレ 5 ファイル準備 + Drive Upload
- **対象**: 計画相談支援 / 障害児相談支援 / 児童入所施設 / 短期入所 / 日中一時支援
- **シート名**: GAS の `getSheetByName(category)` で取れるよう **category 名と一致** させる
- **マスタ値削除**: テンプレ用にサンプル値を消し、ロジック行 (数式・データ検証・条件付き書式) は保持
- **Drive Upload Folder ID**: `1gWph6ukhk1SEB6v_WbjfETyTNQRFLQcW`
- 関連スクリプト: `scripts/strip-excel-templates.py` （COM 経由で値削除）

#### (2) Apps Script デプロイ
- **scriptId**: `11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb`
- **方法**: clasp push or 手動コピペ
- **新規ファイル**:
  - `gas/HopeCare_CloudSQL_移行版_ainotudoi/001_レセプト生成_入所系.gs`
  - `gas/HopeCare_CloudSQL_移行版_ainotudoi/001_レセプト生成_6月改定_相談.gs`
- **既存ファイル 1 行 patch**:
  - `gas/HopeCare_CloudSQL_移行版_ainotudoi/001_レセプト生成_CloudSQL.gs` L181-204 付近
- 詳細手順: `welfare-pdca/implementation/GAS_DEPLOY_HANDOFF.md`

#### (3) Script Properties 7 項目
| Key | 説明 |
|-----|------|
| `APPSHEET_API_KEY` | AppSheet 主アプリ API Key |
| `APPSHEET_APP_ID` | `b9e4f84d-f9b9-4376-97f1-83e3b07122e3` |
| `TEMPLATE_URL_計画相談支援` | (1)で配置したテンプレ URL |
| `TEMPLATE_URL_障害児相談支援` | 同上 |
| `TEMPLATE_URL_児童入所施設` | 同上 |
| `TEMPLATE_URL_短期入所` | 同上 |
| `TEMPLATE_URL_日中一時支援` | 同上 |

#### (4) AppSheet 請求アプリ Bot 引数調整
- **請求アプリ ID**: `f6ddf60e-a346-4d4c-a143-eeb9aed81287`
- Bot: 「請求書作成」系の Call Script Task の引数（特に `category` / `SSsourceURL`）を入所系 3 サービスに対応
- 既存 2 サービス（計画相談支援/障害児相談支援）の引数は不変

---

## 3. E2E テスト 6 件

ユーザー作業 4 件完了後、以下を順に実施：

| # | テスト | コマンド/操作 |
|---|--------|---------------|
| 1 | CloudSQL テストデータ投入 | `psql ... < welfare-pdca/implementation/ddl/99_テストデータ.sql` |
| 2 | GAS 単体（Test A〜D） | Apps Script エディタで実行 |
| 3 | 児童入所施設 E2E | AppSheet 主 → 請求 Bot 起動 → Excel 生成確認 |
| 4 | 短期入所 E2E | 同上 |
| 5 | 日中一時支援 E2E | 同上 |
| 6 | 相談既存処理 退行テスト | 既存 2 サービスで Excel 生成して差分ゼロ確認 |

詳細: `welfare-pdca/FINAL_E2E_CHECKLIST.md`

---

## 4. 関連ドキュメント早見表

| ファイル | 目的 |
|---------|------|
| `welfare-pdca/HANDOFF_STATUS_2026-06-23.md` | 全体ハンドオフ（包括版） |
| `welfare-pdca/FINAL_E2E_CHECKLIST.md` | E2E チェックリスト + PR 文ドラフト |
| `welfare-pdca/implementation/GAS_DEPLOY_HANDOFF.md` | GAS デプロイ詳細手順（clasp / 手動コピペ両対応） |
| `welfare-pdca/implementation/ddl/HANDOFF.md` | CloudSQL DDL 手順（適用済み参考） |
| `welfare-pdca/implementation/ddl/99_テストデータ.sql` | E2E 用 sample data |
| `welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md` | 加算マスタ 3 種の責務分担調査結果 |

---

## 5. 重要 ID / パス（再掲）

- **AppSheet 主アプリ ID**: `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`
- **AppSheet 請求アプリ ID**: `f6ddf60e-a346-4d4c-a143-eeb9aed81287`
- **AppSheet DB base ID**: `0xwgjdrXPv4BIyuQb3buAd`
- **GAS scriptId**: `11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb`
- **CloudSQL**: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi` (DB: `hopecare`)
- **Drive Folder**: `1gWph6ukhk1SEB6v_WbjfETyTNQRFLQcW`
- **SF Org**: `00Dd500000BHTwvEAH` (ordentier.ainotsudoi@force.com)

---

## 6. 設計上の注意事項（必ず守る）

1. **既存「相談 2 サービス」処理は無変更で温存**
2. **入所系・R8.6 改定処理は新規 .gs に分離**（既存 .gs はディスパッチ 1 箇所のみ）
3. **AppSheet 主アプリの加算マスタは「使用事業所」で「愛の集い」フィルタ**
4. **大和高田市は市町村番号 292028、市給付率 90%、月 5 日上限**
5. **GAS §6 厳守 4 事項**:
   - §6-1 事業所加算は請求アプリから
   - §6-2 市町村数で行番号動的計算
   - §6-3 テキスト置換ルール追加のみ
   - §6-4 曜日列は setFormulas で数式保持

---

## 7. 直前の commit 履歴

```
9ac7643 docs(welfare): 最終 E2E チェックリスト + PR 文ドラフト
1abf574 feat(welfare-gas): 001_レセプト生成_6月改定_相談.gs 骨格作成
6ba19a5 feat(welfare-gas): 001_レセプト生成_入所系.gs 骨格作成
a3585a5 feat(welfare-templates): リタリコExcel→テンプレ化スクリプト
58944c0 docs(welfare-gas): GAS 新ファイル設計書 + v1 ジェネレータ削除
305e809 feat(welfare-appsheet): 入所系3サービス×3マスタ=112行をAppSheet DB投入
```

---

**休憩前メモ**: 今日は実装フェーズ（D）まで完了。次セッションでユーザー作業 4 件のステータス確認 → E2E 6 件で完了。
