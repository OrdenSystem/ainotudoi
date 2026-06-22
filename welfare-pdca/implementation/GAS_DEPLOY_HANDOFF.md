# GAS デプロイ ハンドオフ手順書

> 作成: 2026-06-23
> 対象 Apps Script Project: `HopeCare_CloudSQL_移行版_ainotudoi`
> scriptId: `11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb`
> Drive URL: https://script.google.com/d/11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb/edit

## 1. デプロイ対象（3 ファイル）

| # | ファイル | 種別 | 行数 | 役割 |
|---|---|---|---|---|
| 1 | `001_レセプト生成_入所系.gs` | **新規** | 741 | 入所系3サービス用処理（暦日 LEFT JOIN + 反映条件別集計） |
| 2 | `001_レセプト生成_6月改定_相談.gs` | **新規** | 215 | R8.6 改定相談2サービス用（テンプレ URL 差替） |
| 3 | `001_レセプト生成_CloudSQL.gs` | **修正** | +8 行 | makeReceptBackground にディスパッチ追加 |

ローカルパス: `c:/dev/ainotudoi/gas/HopeCare_CloudSQL_移行版_ainotudoi/`

## 2. デプロイ手段 2 通り

### 方法 A: clasp で push（推奨）

`clasp` がインストール済の場合：

```bash
cd c:/dev/ainotudoi/gas/HopeCare_CloudSQL_移行版_ainotudoi/

# 初回のみ: ログイン
clasp login

# 初回のみ: .clasp.json 作成
clasp clone 11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb
# ↑ プロジェクトを clone する（ローカルファイルが上書きされる可能性あり、注意）

# OR 既に clasp 設定済なら:
clasp push
```

⚠️ `clasp clone` はローカルファイルを上書きする可能性。**事前にバックアップ**:
```bash
cp -r gas/HopeCare_CloudSQL_移行版_ainotudoi gas/HopeCare_CloudSQL_移行版_ainotudoi.bak
```

### 方法 B: 手動コピペ（clasp 未導入なら確実）

1. Apps Script Editor を開く: https://script.google.com/d/11DEemyyA_FvawZ8qpRXc6Xsuc12VpYK7jHffg6cog9SgKxgU6AI5Evvb/edit
2. 左サイドバー「+」→「スクリプト」→ファイル名: `001_レセプト生成_入所系.gs`
3. ローカルファイル `c:/dev/ainotudoi/gas/HopeCare_CloudSQL_移行版_ainotudoi/001_レセプト生成_入所系.gs` の中身を**全選択 → コピー**
4. Apps Script Editor で**全選択 → 貼り付け → 保存（Ctrl+S）**
5. 同様に `001_レセプト生成_6月改定_相談.gs` を新規追加
6. 既存 `001_レセプト生成_CloudSQL.gs` を開き、**`makeReceptBackground()` の `result = executeMakeRecept(...)` 周辺 8 行**を修正

## 3. 既存ファイルの修正箇所（重要）

`001_レセプト生成_CloudSQL.gs` の **`makeReceptBackground()` 関数内**、約 L181-204 付近：

### 変更前
```javascript
  console.log("⏳ メイン処理（executeMakeRecept）実行中...");
  let result;
  try {
    result = executeMakeRecept(
      p.seikyuID,
      p.appSSdbURL,
      p.category,
      ...
```

### 変更後
```javascript
  console.log("⏳ メイン処理（executeMakeRecept）実行中...");
  let result;
  try {
    // ★ Phase D-3 追加: category により入所系3サービスを別関数へディスパッチ
    //   pickExecuteMakeReceptFunction_ は 001_レセプト生成_入所系.gs で定義
    //   入所系3 → executeMakeReceptInsho / その他 → executeMakeRecept（既存）
    const _executeFn =
      typeof pickExecuteMakeReceptFunction_ === "function"
        ? pickExecuteMakeReceptFunction_(p.category)
        : executeMakeRecept;
    result = _executeFn(
      p.seikyuID,
      p.appSSdbURL,
      p.category,
      ...
```

⚠️ git の最新 commit `388860f` を参照。

## 4. Script Properties 設定

Apps Script Editor → **歯車（設定）→ スクリプト プロパティ** に以下を追加:

### 必須

| Key | Value（例） |
|---|---|
| `APPSHEET_APP_ID_主app` | `b9e4f84d-f9b9-4376-97f1-83e3b07122e3` |
| `APPSHEET_API_KEY_主app` | `<.env の APPSHEET_ACCESS_KEY__b9e4f84d-... の値>` |

### テンプレ URL（5 件、Drive Upload 後）

| Key | Value（Drive Upload 後の URL） |
|---|---|
| `APPSHEET_TEMPLATE_URL_計画相談_R8_6` | `https://docs.google.com/spreadsheets/d/<id>/edit` |
| `APPSHEET_TEMPLATE_URL_障害児相談_R8_6` | 同上 |
| `APPSHEET_TEMPLATE_URL_児童入所施設` | 同上 |
| `APPSHEET_TEMPLATE_URL_短期入所` | 同上 |
| `APPSHEET_TEMPLATE_URL_日中一時支援` | 同上 |

### 既存値（変更不要）

| Key | 既存値 |
|---|---|
| `CLOUDSQL_URL` | `jdbc:postgresql://...:5432/hopecare`（既設） |
| `CLOUDSQL_USER` | `postgres`（既設） |
| `CLOUDSQL_PASS` | `R6WG7H8q9w6wniNNfwypOJifLuvP`（既設） |
| `APPSHEET_APP_ID_請求app` | （既設） |
| `APPSHEET_API_KEY_請求app` | （既設） |
| `APPSHEET_TABLE_NAME_請求app` | `請求情報DB`（既設） |
| `SEIKYU_TASK_SS_ID` | （既設） |

## 5. 動作確認テスト

### Test A: ディスパッチ関数の到達確認

Apps Script Editor で関数選択 → `pickExecuteMakeReceptFunction_` を一旦実行（または下記テスト関数を追加）：

```javascript
function test_dispatch() {
  const tests = [
    ["児童入所施設", "executeMakeReceptInsho"],
    ["短期入所", "executeMakeReceptInsho"],
    ["日中一時支援", "executeMakeReceptInsho"],
    ["計画相談支援", "executeMakeRecept"],
    ["障害児相談支援", "executeMakeRecept"],
  ];
  for (const [category, expected] of tests) {
    const fn = pickExecuteMakeReceptFunction_(category);
    const got = fn.name;
    const ok = got === expected ? "OK" : "NG";
    console.log(`[${ok}] ${category}: ${got} (期待: ${expected})`);
  }
}
```

`実行` ボタン → ログ確認。すべて `OK` ならディスパッチ正常。

### Test B: CloudSQL 接続確認

```javascript
function test_cloudsql() {
  const conn = getCloudSqlConnection_();
  try {
    const stmt = conn.prepareStatement("SELECT current_database()");
    const rs = stmt.executeQuery();
    while (rs.next()) console.log("DB:", rs.getString(1));
    rs.close();
    stmt.close();
  } finally {
    conn.close();
  }
}
```

期待: `DB: hopecare`

### Test C: 入所系テーブル参照確認

```javascript
function test_insho_tables() {
  const conn = getCloudSqlConnection_();
  try {
    const tables = ["児童入所登録", "短期入所登録", "日中一時登録"];
    for (const t of tables) {
      const stmt = conn.prepareStatement(`SELECT COUNT(*) FROM public."${t}"`);
      const rs = stmt.executeQuery();
      while (rs.next()) console.log(`${t}: ${rs.getInt(1)} 行`);
      rs.close();
      stmt.close();
    }
  } finally {
    conn.close();
  }
}
```

期待: 各テーブル 0 行（テストデータ未投入時）or 6/5/5 行（99_テストデータ.sql 適用後）

### Test D: 加算マスタ取得 API 確認

```javascript
function test_kasan_master() {
  const m = loadKasanMaster_("児童入所施設", console.log);
  console.log(`取得加算数: ${Object.keys(m).length}`);
  console.log(JSON.stringify(m, null, 2));
}
```

期待: 18 加算（児童入所施設の利用者加算マスタ行数と一致）

### Test E: E2E（実 Bot 起動）

1. AppSheet 請求アプリで 請求情報DB に該当行を作成
   - `category` = `児童入所施設`
   - `seikyuID` = （新規）
   - `TargetRows` = 99_テストデータ.sql で投入したレコード ID（カンマ区切り）
2. `自動フラグ` を ON → 更新
3. Bot:レセBOT 起動 → makeRecept → 1 秒後 makeReceptBackground
4. `請求処理タスク` スプシで進捗確認
5. 完了後、`請求情報DB.File` 列に Drive URL がセットされる
6. 出力 Excel を目視確認

## 6. ロールバック

### 既存ファイル修正のロールバック

`001_レセプト生成_CloudSQL.gs` の修正箇所を**変更前**の状態に戻す。

git 上の前 commit (`558cb0f` の前):
```bash
git show 558cb0f:gas/HopeCare_CloudSQL_移行版_ainotudoi/001_レセプト生成_CloudSQL.gs > original.gs
```

### 新規ファイル削除

Apps Script Editor で `001_レセプト生成_入所系.gs` と `001_レセプト生成_6月改定_相談.gs` をゴミ箱へ。

→ これだけで既存処理に完全復帰（後方互換性確保）

## 7. デプロイ後チェックリスト

- [ ] 3 ファイルが Apps Script Editor で正常表示される
- [ ] 構文エラーなし（保存時にチェック）
- [ ] `pickExecuteMakeReceptFunction_` 関数が定義されている
- [ ] `executeMakeReceptInsho` 関数が定義されている
- [ ] Test A: ディスパッチ確認 OK
- [ ] Test B: CloudSQL 接続 OK
- [ ] Test C: 入所系テーブル参照 OK
- [ ] Test D: 加算マスタ取得 OK
- [ ] Script Properties 全 7 件設定済
- [ ] AppSheet 側で実 Bot 起動 → 入所系 Excel 生成成功（Test E）

## 8. 関連ファイル

- 設計書: [`welfare-pdca/plans/2026-06-23-GAS新ファイル設計.md`](../plans/2026-06-23-GAS新ファイル設計.md)
- データフロー解析: [`welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md`](../context/2026-06-23-加算マスタ_データフロー完全解析.md)
- テストデータ SQL: [`welfare-pdca/implementation/ddl/99_テストデータ.sql`](ddl/99_テストデータ.sql)
- 全体ハンドオフ: [`welfare-pdca/HANDOFF_STATUS_2026-06-23.md`](../HANDOFF_STATUS_2026-06-23.md)
