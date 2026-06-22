# 入所系3サービス追加プロジェクト — ハンドオフ状況

> 作成: 2026-06-23
> ブランチ: `feat/welfare-3services-onboarding`
> リポジトリ: `OrdenSystem/ainotudoi`
> 担当: Claude (AI) + ユーザー (lab@appsheet.fun)

## 1. プロジェクト概要

愛の集い学園（奈良県大和高田市）のシステムに、既存の相談2サービス（計画相談支援・障害児相談支援）に加えて **入所系3サービス** を追加する。

| 追加サービス | 対象 | 単価制度 |
|---|---|---|
| 児童入所施設 | 障害児入所支援（福祉型） | 国制度（厚労省告示） |
| 短期入所 | 障害福祉サービス | 国制度（厚労省告示） |
| 日中一時支援 | 市町村地域生活支援事業 | **大和高田市独自要綱**（告示第121号） |

加えて、令和8年6月改定（処遇改善加算 Ⅰロ・Ⅱロ 新設等）にも対応。

## 2. ✅ 完了済タスク

### 2.1 SF Schema 拡張（本番反映済）
- `DisabilityCard__c` に 8 列追加（契約系 5 + 上限管理 3）
- `Office__c.ServiceType__c` に 2 値追加（児童入所施設 / 日中一時支援）
- `UpperLimitFacilityNumber_Hankaku` Validation Rule 追加
- Page Layout に「契約情報（入所系3サービス）」セクション追加
- Permission Set `DisabilityCard_NewFields_FLS` 作成・assign 済
- **commit**: `fc7f469`

### 2.2 AppSheet 同期 + View 整備（本番反映済）
- ServiceType__c picklist に 2 値同期済
- DisabilityCard__c に 8 列同期済
- Receipt 7 View に 8 列配置（**32 列追加合計**）
- Decimal → Number 型修正（ContractRowNumber / MonthlyAllotmentDays）
- Date 列の Default TODAY() クリア
- **commit**: `f170fe0`, `0394376`

### 2.3 AppSheet DB 加算マスタ 112 行投入（本番反映済）
- `001_事業所加算マスタ`: 61 行（児童 31 + 短期 25 + 日中 5）
- `001_利用者加算マスタ`: 34 行（児童 18 + 短期 13 + 日中 3）
- `001_利用者基本マスタ`: 17 行（児童 7 + 短期 5 + 日中 5）
- 全行 `使用事業所=愛の集い`、`適用開始=06/01/2026`
- **commit**: `305e809`

### 2.4 CloudSQL DDL ファイル作成（**未適用**）
- 業務 3 テーブル: `児童入所登録` / `短期入所登録` / `日中一時登録`
- 補助 2 マスタ: `市町村マスタ` / `日中一時単価マスタ`
- ケース記録 ALTER（既存テーブルに FK 3 列追加）
- 大和高田市 初期データ INSERT（市町村 1 + 単価 21）
- **commit**: `9e76925`, `f0c4c3a`

### 2.5 GAS 新ファイル作成（**未デプロイ**）
- `001_レセプト生成_入所系.gs` (741 行) — 暦日 LEFT JOIN + 反映条件別集計
- `001_レセプト生成_6月改定_相談.gs` (215 行) — テンプレ URL 差替
- `001_レセプト生成_CloudSQL.gs` への 1 行ディスパッチパッチ追加
- **commit**: `558cb0f`, `1abf574`, `388860f`

### 2.6 リタリコ Excel テンプレ（**Drive 未アップ**）
- 5 ファイル分のサンプル値除去済（`Excelマスタ/templates/`）
- ファイル名: `テンプレ_<サービス名>_R8_6.xlsx`
- **commit**: `a3585a5`

### 2.7 調査・設計ドキュメント
- データフロー完全解析レポート（4 並列エージェント研究）
- 加算リスト 突合表（リタリコ × 厚労省告示）
- 報酬体系 裏取りレポート（大和高田市の単価表含む）
- AppSheet テーブル設計書
- GAS 新ファイル設計書

## 3. ⏳ 残作業

### 3.1 ユーザー手動作業（最優先）

#### A. リタリコ Excel テンプレ 5 ファイルを Drive にアップロード
- アップ先: https://drive.google.com/drive/folders/1gWph6ukhk1SEB6v_WbjfETyTNQRFLQcW
- ローカルパス: `c:/dev/ainotudoi/Excelマスタ/templates/`
- 形式: `.xlsx` のまま（Google Sheet 変換は任意）

#### B. Script Properties 設定（GAS 側）
```
APPSHEET_APP_ID_主app          = b9e4f84d-f9b9-4376-97f1-83e3b07122e3
APPSHEET_API_KEY_主app         = <既存 .env の APPSHEET_ACCESS_KEY__b9e4f84d-...>
APPSHEET_TEMPLATE_URL_計画相談_R8_6     = <Drive アップ後の URL>
APPSHEET_TEMPLATE_URL_障害児相談_R8_6   = <Drive アップ後の URL>
APPSHEET_TEMPLATE_URL_児童入所施設     = <Drive アップ後の URL>
APPSHEET_TEMPLATE_URL_短期入所         = <Drive アップ後の URL>
APPSHEET_TEMPLATE_URL_日中一時支援     = <Drive アップ後の URL>
```

#### C. CloudSQL DDL 本番適用
- 適用順序: `09 → 10 → 06 → 07 → 08 → 11 → 12`
- 手順書: [welfare-pdca/implementation/ddl/HANDOFF.md](implementation/ddl/HANDOFF.md)
- 実行者: `dev-support@ordentier-corp.co.jp` 権限保持者

#### D. GAS ファイル 3 つを Apps Script Editor にデプロイ
- `001_レセプト生成_入所系.gs`（新規）
- `001_レセプト生成_6月改定_相談.gs`（新規）
- `001_レセプト生成_CloudSQL.gs`（既存・1 箇所修正）
- 適用先 scriptId: `11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb`

#### E. AppSheet Bot 設定確認
- `レセBOT` のトリガ条件と引数 19 個は **変更不要**
- `pickExecuteMakeReceptFunction_` で category 分岐
- 入所系3 category 名（児童入所施設 / 短期入所 / 日中一時支援）が AppSheet 側で正しく流れることを確認

### 3.2 テスト

#### Test 1: 暦日 LEFT JOIN SQL 単体
```sql
WITH calendar AS (
  SELECT generate_series(
    DATE '2026-06-01',
    DATE '2026-06-30',
    INTERVAL '1 day'
  )::DATE AS "記録日"
)
SELECT COUNT(*) FROM calendar;  -- 期待: 30
```

#### Test 2: 加算マスタ取得 API
```javascript
// GAS Editor で実行
function test_loadKasanMaster() {
  const m = loadKasanMaster_("児童入所施設", console.log);
  console.log(`取得加算数: ${Object.keys(m).length}`);
  console.log(JSON.stringify(m, null, 2));
}
```

#### Test 3: 入所系レセプト生成 (E2E)
1. テスト用ダミーデータを `児童入所登録` に 1 利用者×3 日分 INSERT
2. 請求アプリで該当レコードを選択 → レセ生成
3. Drive に Excel 出力されることを確認
4. 暦日 28-31 行が並んでいることを目視確認
5. 加算が正しく転記されていることを確認

## 4. 設計の重要ポイント（再確認）

### 4.1 加算マスタの責務分担
- **001_事業所加算マスタ**: 事業所体制系（看護師配置、栄養士配置、処遇改善加算 等）
- **001_利用者加算マスタ**: 利用者単位（自活訓練、入院・外泊、強度行動障害 等）
  - **反映条件 = 同月最新日のみ反映**: 月 1 回フラグ系（既存パターン）
  - **反映条件 = 同月全件反映_カウント**: 日数加算系（入所系新規）★
- **001_利用者基本マスタ**: 帳票ラベル（氏名、受給者証番号、支給市町村 等）

### 4.2 GAS データフロー
```
AppSheet 請求アプリ
  └ Bot:レセBOT → makeRecept (queue 登録, 既存)
     └ makeReceptBackground (queue 処理, 既存 + 1 行 patch)
        └ pickExecuteMakeReceptFunction_(category)  ← 新規ディスパッチ
           ├ 入所系3 → executeMakeReceptInsho (新規)
           └ 相談2  → executeMakeRecept (既存・無変更)
```

### 4.3 decisions §6 厳守事項（GAS 既存ロジック）
- §6-1 事業所加算は請求アプリ `事業所加算項目DB` から取得 ✅
- §6-2 市町村数で行番号動的計算 ✅
- §6-3 「日報Excel置換」シートの置換 ✅
- §6-4 曜日セル数式保持 (`setFormulas`) ✅

## 5. 環境情報

### 5.1 認証情報
- AppSheet: `lab@appsheet.fun`（Drive 共有: 1gWph6...）+ `dev-support@ordentier-corp.co.jp`（CloudSQL）
- Salesforce: `ordentier.ainotsudoi@force.com` (System Admin)
- gcloud: `dev-support@ordentier-corp.co.jp`（token 切れ時は `gcloud auth login` 必要）

### 5.2 主要 ID
- AppSheet 主アプリ ID: `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`
- AppSheet 請求アプリ ID: `f6ddf60e-a346-4d4c-a143-eeb9aed81287`
- HopeCareマスタ DB base: `0xwgjdrXPv4BIyuQb3buAd`
- CloudSQL: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi`
- GAS scriptId: `11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb`
- Salesforce Org ID: `00Dd500000BHTwvEAH`

## 6. リスク・既知の制約

| リスク | 対策 |
|---|---|
| CloudSQL DDL 未適用 → GAS が動かない | 適用は dev-support 権限保持者 |
| Drive Upload 未完了 → テンプレ URL 不明 | ユーザー手動アップ → URL 取得 |
| GAS デプロイ未実施 → Apps Script で動かない | clasp push or 手動コピペ |
| `pickExecuteMakeReceptFunction_` 未定義時のフォールバック | 既存 executeMakeRecept にフォールバック実装済 |
| 入所系3 のテンプレ構造未検証 | 実 Excel ダウンロード → 構造確認推奨 |
| 「同月全件反映_カウント」の集計値表示形式 | `"日数 (区分)"` 形式実装、要件変更時は修正 |

## 7. 累積 commit （36 件）

```
388860f feat(welfare-gas): makeReceptBackground 内で入所系ディスパッチ追加
558cb0f feat(welfare-gas): 001_レセプト生成_入所系.gs 実装完了
1abf574 feat(welfare-gas): 001_レセプト生成_6月改定_相談.gs 骨格作成
6ba19a5 feat(welfare-gas): 001_レセプト生成_入所系.gs 骨格作成
a3585a5 feat(welfare-templates): リタリコExcel→テンプレ化スクリプト
58944c0 docs(welfare-gas): GAS 新ファイル設計書 + v1 ジェネレータ削除
305e809 feat(welfare-appsheet): 入所系3サービス×3マスタ=112行をAppSheet DB投入
f0c4c3a feat(welfare): D-2 並行 3 成果物
a32134d docs(welfare-research): 入所系3サービス 報酬体系 裏取りレポート
9e76925 refactor(welfare-cloudsql): DDL を日本語化 + 加算は AppSheet マスタ参照方式へ統一
5d08546 docs(welfare-appsheet): 入所系3サービス AppSheet テーブル設計書
0394376 feat(welfare-appsheet): 入所系3サービス列の AppSheet 微調整（本番反映済）
aad5062 docs(welfare-cloudsql): DDL 本番適用 ハンドオフ手順書を追加
f170fe0 feat(welfare-appsheet): 受給者証 View 4 本に新規 8 列を配置（本番反映済）
b226387 chore(scripts): AppSheet saveapp 直接呼出しスクリプト追加
70a6804 feat(welfare-cloudsql): 入所系3サービス CloudSQL DDL 5本（日次レコード設計）
fc7f469 feat(welfare-sf): SF Schema拡張 - 入所系3サービス対応（本番デプロイ済）
2c5ec2d docs(welfare): 入所系3サービス追加 決定事項と詳細実装計画書
7e123b2 docs(welfare): PDCA frameworkと既存システム調査レポート
（他 17 件）
```

## 8. ハンドオフ可能状態

| 領域 | 状態 |
|---|---|
| SF Schema | ✅ 本番反映済（追加作業なし） |
| AppSheet 主アプリ View | ✅ 本番反映済 |
| AppSheet DB 加算マスタ | ✅ 本番反映済 |
| CloudSQL DDL | ❌ **未適用**（HANDOFF.md 参照） |
| GAS 新ファイル | ❌ **未デプロイ**（git 反映済、Apps Script 側 push 必要） |
| リタリコ Excel テンプレ | ❌ **Drive 未アップ**（ローカル `Excelマスタ/templates/`） |
| Script Properties | ❌ **未設定**（テンプレ URL × 5 + APPSHEET_API_KEY） |
| 業務テスト | ❌ **未実施**（CloudSQL 適用後に E2E テスト） |

## 9. 推奨次ステップ順序

1. **Drive Upload** (ユーザー 5 分)
2. **Script Properties 設定** (ユーザー 5 分)
3. **CloudSQL DDL 適用** (dev-support 30 分)
4. **GAS Apps Script デプロイ** (ユーザー 5-10 分)
5. **テストデータ投入 → E2E テスト** (合同 30-60 分)
6. **問題があれば修正コミット** → 再テスト

完了後、main ブランチへ merge or PR 作成。
