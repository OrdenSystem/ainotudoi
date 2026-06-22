# 入所系3サービス E2E 最終チェックリスト

> 作成: 2026-06-23
> ブランチ: `feat/welfare-3services-onboarding`
> 目的: ユーザー作業 4 件 + テスト 5 件のチェックリスト
> 関連: [HANDOFF_STATUS_2026-06-23.md](HANDOFF_STATUS_2026-06-23.md) / [GAS_DEPLOY_HANDOFF.md](implementation/GAS_DEPLOY_HANDOFF.md)

## ✅ システム側 完了済（私が実施）

- [x] SF Schema 8 列 + Validation Rule + Picklist + Layout 本番反映
- [x] AppSheet 主アプリ View 7 本に 32 列追加（本番反映）
- [x] AppSheet 主アプリ Data Source 同期（8 列 + 2 picklist 値）
- [x] AppSheet DB 加算マスタ 112 行投入（3 マスタ × 3 サービス、本番反映）
- [x] CloudSQL DDL 7 ファイル本番適用（既存 7 + 新規 5 = 12 テーブル）
- [x] 大和高田市 単価マスタ 21 行 INSERT
- [x] CloudSQL 単体テスト 4 ケース全パス
- [x] GAS 新ファイル 2 本（git 反映、741 + 215 行）
- [x] GAS 既存 1 行 patch（git 反映）

## ⏳ ユーザー作業 4 件

### 作業 1: リタリコ Excel テンプレ 5 ファイル準備 + Drive Upload

**手順**（[詳細は推奨方針 A 参照](#)):
- [ ] リタリコ実 xls 5 ファイルを Google Sheets に開く（自動変換）
- [ ] シート名を **category 値**にリネーム
  - [ ] 計画相談支援 → シート名 `計画相談支援`
  - [ ] 障害児相談支援 → シート名 `障害児相談支援`
  - [ ] 障害児入所支援 → シート名 **`児童入所施設`**
  - [ ] 短期入所 → シート名 `短期入所`
  - [ ] 日中一時支援 → シート名 `日中一時支援`
- [ ] サンプル値除去（任意、ユーザー判断）
- [ ] ファイル名を統一: `テンプレ_<category>_R8_6`
- [ ] [Drive Folder](https://drive.google.com/drive/folders/1gWph6ukhk1SEB6v_WbjfETyTNQRFLQcW) にアップロード
- [ ] 5 ファイルすべて URL 取得

### 作業 2: Apps Script デプロイ

[詳細手順: GAS_DEPLOY_HANDOFF.md](implementation/GAS_DEPLOY_HANDOFF.md)
- [ ] 方法 A (clasp push) or 方法 B (手動コピペ) を実施
- [ ] `001_レセプト生成_入所系.gs` 反映
- [ ] `001_レセプト生成_6月改定_相談.gs` 反映
- [ ] `001_レセプト生成_CloudSQL.gs` の `makeReceptBackground()` 修正反映
- [ ] 保存時の構文エラーがないことを確認

### 作業 3: Script Properties 設定

Apps Script Editor → 歯車 → スクリプトプロパティ
- [ ] `APPSHEET_APP_ID_主app` = `b9e4f84d-f9b9-4376-97f1-83e3b07122e3`
- [ ] `APPSHEET_API_KEY_主app` = <既存 .env から>
- [ ] `APPSHEET_TEMPLATE_URL_計画相談_R8_6` = <Drive URL>
- [ ] `APPSHEET_TEMPLATE_URL_障害児相談_R8_6` = <Drive URL>
- [ ] `APPSHEET_TEMPLATE_URL_児童入所施設` = <Drive URL>
- [ ] `APPSHEET_TEMPLATE_URL_短期入所` = <Drive URL>
- [ ] `APPSHEET_TEMPLATE_URL_日中一時支援` = <Drive URL>

### 作業 4: AppSheet 請求アプリの Bot 引数調整

ボット トリガで渡す `category` / `SSsourceURL` 等が以下と整合するか確認:
- [ ] `category` 値が 5 つすべてサポート: 計画相談支援 / 障害児相談支援 / **児童入所施設** / **短期入所** / **日中一時支援**
- [ ] 入所系の場合、`SSsourceURL` に **入所系テンプレ URL** が渡される（AppSheet 内のテーブルから取得 or 直接設定）
- [ ] `TargetRows` に **入所系登録テーブルの ID リスト**（カンマ区切り）が渡される
  - 既存は「相談記録ID」だったが、入所系では「児童入所登録ID」「短期入所登録ID」「日中一時登録ID」のいずれか
  - 動的に切替えるか、AppSheet の Bot で category 別に分岐

## 🧪 E2E テスト（4 件 + 1 件総合）

### Test 1: CloudSQL テストデータ投入

```bash
# (cloud-sql-proxy 起動済前提)
psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" -f welfare-pdca/implementation/ddl/99_テストデータ.sql

# Python でも実行可能
python -c "
import psycopg2
c = psycopg2.connect(host='127.0.0.1', port=5435, dbname='hopecare',
                     user='postgres', password='<PASSWORD>')
with open('welfare-pdca/implementation/ddl/99_テストデータ.sql', encoding='utf-8') as f:
    c.cursor().execute(f.read())
c.commit()
c.close()
"
```

- [ ] 児童入所登録 6 行 INSERT 成功
- [ ] 短期入所登録 5 行 INSERT 成功
- [ ] 日中一時登録 5 行 INSERT 成功
- [ ] 検証クエリ（3 サービス各件数 + 暦日 LEFT JOIN）期待通り

### Test 2: GAS 単体動作確認（[GAS_DEPLOY_HANDOFF.md §5](implementation/GAS_DEPLOY_HANDOFF.md) Test A-D）

- [ ] Test A: `test_dispatch()` → 全 OK 表示
- [ ] Test B: `test_cloudsql()` → DB: hopecare
- [ ] Test C: `test_insho_tables()` → 各 6/5/5 件（テストデータ投入後）
- [ ] Test D: `test_kasan_master()` → 18 加算

### Test 3: 入所系 E2E（児童入所施設）

1. AppSheet 請求アプリで 請求情報DB に新規行
   - `category` = `児童入所施設`
   - `seikyuID` = （自動採番）
   - `TargetRows` = `test_児入_20260601_001,test_児入_20260602_001,...,test_児入_20260606_001`
   - `SSsourceURL` = Drive Upload した「テンプレ_児童入所施設」の URL
   - `appSSdbURL` = 既設（請求 App スプシ）
   - その他既設 18 引数
2. `自動フラグ` ON → 更新
3. 「請求処理タスク」スプシで進捗確認
4. 完了後の確認:
   - [ ] Status: 完遂
   - [ ] 請求情報DB.File 列に Drive URL がセットされる
   - [ ] 生成 Excel が Drive に存在
   - [ ] Excel を開いて確認:
     - [ ] シート 1 つだけ（児童入所施設）
     - [ ] 暦日 30 日分（6 月）の行がある
     - [ ] 6/1-6/2: 在籍状態 + 基本報酬Ⅰ
     - [ ] 6/3-6/5: 入院/外泊 + 入院・外泊時加算 = 3
     - [ ] 6/6: 在籍 + 基本報酬Ⅰ
     - [ ] 6/7-6/30: 空欄（実績なし）
     - [ ] 加算列「入院・外泊時加算」のカウントセル = `3 (1)` 形式 or 単純 `3`
     - [ ] 曜日数式が動作（A 列の数字に応じて曜日表示）

### Test 4: 入所系 E2E（短期入所）

同様の手順で:
- [ ] `category` = `短期入所`
- [ ] `TargetRows` = `test_短期_20260610_001,...,test_短期_20260621_001`
- [ ] Excel 出力確認: 単独型加算 5 日 + 緊急短期入所受入加算 1 日 + 送迎加算 3 日

### Test 5: 入所系 E2E（日中一時支援）

同様の手順で:
- [ ] `category` = `日中一時支援`
- [ ] `TargetRows` = `test_日中_20260615_001,...,test_日中_20260629_001`
- [ ] Excel 出力確認: 大和高田市の単価マスタ参照、送迎加算 5 日 + 食事加算 4 日 + 入浴加算 2 日

### Test 6: 相談 既存処理 退行テスト

既存処理に影響がないか確認:
- [ ] `category` = `計画相談支援` で R7 以前の月（例: `2026-05`）→ 既存テンプレで処理
- [ ] `category` = `計画相談支援` で R8.6 以降の月（例: `2026-07`）→ 新テンプレで処理
- [ ] 出力 Excel が既存と同じ形式（破壊的変更なし）

## 📊 累積成果（git commit 数）

```
40+ commit on feat/welfare-3services-onboarding branch

主な成果:
  - 計画書 / 設計書 / 調査レポート: 8 ドキュメント
  - DDL: 7 ファイル (CloudSQL 適用済)
  - GAS: 2 新規ファイル + 1 既存修正
  - スクリプト: 8 ユーティリティ (AppSheet 操作 / Excel ストリップ / DDL 適用)
  - AppSheet DB 行データ: 112 行投入（CSV 9 ファイル）
  - SF Metadata: 8 フィールド + 1 ValidationRule + Picklist 変更 + Layout 変更 + PermissionSet
```

## 🎯 マージ準備状況

| 領域 | 状態 |
|---|---|
| feature ブランチ | ✅ push 済（`feat/welfare-3services-onboarding`） |
| Conflict | ❌ なし（main から派生、main 無変更） |
| 自動テスト | ❌ 既存 CI なし |
| 本番反映 | 部分的（SF + AppSheet + CloudSQL のみ、GAS+Templates 未） |

## 推奨マージタイミング

ユーザー作業 4 件 + Test 1-6 すべて緑になってから main へ merge or PR 作成。

PR 文ドラフト案:
```
タイトル: 入所系3サービス追加（児童入所施設 / 短期入所 / 日中一時支援）+ R8.6改定対応

## 概要
愛の集い学園（奈良県大和高田市）に既存の相談2サービスに加え入所系3サービスを追加。
令和8年6月改定（処遇改善加算Ⅰロ・Ⅱロ等）にも対応。

## 主な変更
1. **SF Schema** — DisabilityCard__c に契約・上限管理 8 列追加、Office__c.ServiceType__c に 2 値追加
2. **AppSheet 主アプリ** — 受給者証 View 7 本に 32 列追加、ServiceType picklist 2 値同期
3. **AppSheet DB 加算マスタ** — 3 サービス × 3 マスタ = 112 行投入
4. **CloudSQL** — 業務 3 テーブル + 補助 2 マスタ新設、ケース記録に親 FK 3 列追加
5. **GAS** — 入所系処理 + R8.6改定相談処理 を新ファイル化、既存処理は無変更でディスパッチ追加
6. **大和高田市 単価マスタ** — 21 行 INSERT（身体9 + 知的9 + 精神3）

## テスト
- [x] CloudSQL DDL 単体テスト 4 ケース
- [ ] GAS デプロイ後の E2E テスト 4 ケース（入所3 + 相談退行）

## 関連ドキュメント
- HANDOFF_STATUS_2026-06-23.md
- FINAL_E2E_CHECKLIST.md
- implementation/GAS_DEPLOY_HANDOFF.md
- implementation/ddl/HANDOFF.md
```

## ✅ 完了報告フォーマット

各 Test を実施したら、以下のフォーマットでチェックしてください：

```
Test X: [PASS/FAIL]
  詳細: [観察された内容]
  問題: [あれば]
```

問題があれば私が原因解析・修正します。
