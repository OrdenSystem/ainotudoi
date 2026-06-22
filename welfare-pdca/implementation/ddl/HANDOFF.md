# CloudSQL DDL 本番適用 ハンドオフ手順書

> **対象**: 開発チーム / `dev-support@ordentier-corp.co.jp` 権限保持者
> **作成**: 2026-06-22 / **依頼者**: lab@appsheet.fun
> **CloudSQL Instance**: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi`
> **DB**: `hopecare` (PostgreSQL 15)

## なぜ別ハンドオフが必要か

`lab@appsheet.fun`（依頼者）は CloudSQL の psql 実行権限を持たず、`dev-support@ordentier-corp.co.jp` のみが本番 DB への接続権を持つ。本書は権限保持者が**手元で 1 回ずつ DDL を適用し、エラーゼロで完了させる**ための単独完結手順書。

## 適用対象（5 ファイル）

> 全 SQL ファイルは [`welfare-pdca/implementation/ddl/`](.) に格納（commit `70a6804` に含まれる）。

| 順序 | ファイル | テーブル | 依存 |
|---|---|---|---|
| 1 | [`09_municipalities.sql`](09_municipalities.sql) | `public.municipalities` | なし |
| 2 | [`10_municipality_unit_prices.sql`](10_municipality_unit_prices.sql) | `public.municipality_unit_prices` | 09 (FK) |
| 3 | [`06_child_care_entry_records.sql`](06_child_care_entry_records.sql) | `public.child_care_entry_records` | なし |
| 4 | [`07_short_stay_records.sql`](07_short_stay_records.sql) | `public.short_stay_records` | なし |
| 5 | [`08_daytime_temp_support_records.sql`](08_daytime_temp_support_records.sql) | `public.daytime_temp_support_records` | なし（`shichoson_id` は FK 制約なし） |

各 SQL は `BEGIN; ... COMMIT;` で囲まれており、テーブル単位でアトミック。失敗時は自動ロールバックされる。

## 事前確認チェックリスト

### ① 接続情報の保管場所

接続情報（パスワード）は `.env.local`（リポジトリには commit されていない）にある。手元になければ前任者から共有を受ける。

### ② 適用先 DB の現状確認

CloudSQL 移行後は以下の 7 テーブル + 26 インデックスの状態：

```sql
-- 既存テーブル一覧
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- 期待結果: 01相談記録 / AIジョブキュー / ケース記録 / 出力先ファイル /
--          帳票マスタ複製登録 / 帳票子レコード複製登録 / 音声記録対応
```

### ③ 新規 5 テーブルが未存在であること

```sql
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('municipalities', 'municipality_unit_prices',
                    'child_care_entry_records', 'short_stay_records',
                    'daytime_temp_support_records');
-- 期待結果: 0 件（テーブル未存在）
```

## 実行手順

### Step 1: cloud-sql-proxy 起動

`auto mode classifier` の干渉に注意（過去事例: `hahaha-cloudsql` への書込み系 gcloud 操作は広く block される）。block されたら `!` プレフィックスまたは `settings.local.json` の allowlist 追加で対応。

```bash
# proxy 認証は ADC ではなく impersonate token を推奨
# (5435 / 5436 ポートを使う。5433 は他インスタンスと衝突するので避ける)

cloud-sql-proxy \
  --token=$(gcloud auth print-access-token --impersonate-service-account=dev-support@ordentier-corp.co.jp) \
  --port=5435 \
  ainotudoisql:asia-northeast1:hopecare-db-ainotudoi &

# proxy 起動確認
sleep 3
psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" -c "SELECT version();"
```

### Step 2: 順序通りに 5 ファイル適用

```bash
cd /path/to/welfare-pdca/implementation/ddl

# 依存関係順 (09 → 10 → 06 → 07 → 08)
APPLY_ORDER=(
  09_municipalities.sql
  10_municipality_unit_prices.sql
  06_child_care_entry_records.sql
  07_short_stay_records.sql
  08_daytime_temp_support_records.sql
)

for f in "${APPLY_ORDER[@]}"; do
  echo "=== Applying: $f ==="
  psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" \
       --set ON_ERROR_STOP=on \
       -f "$f"
  if [ $? -ne 0 ]; then
    echo "FAILED at $f. Stopping."
    exit 1
  fi
done
echo "All 5 files applied successfully."
```

`--set ON_ERROR_STOP=on` で SQL エラー時に即終了。`BEGIN/COMMIT` で囲まれているため、エラーが起きたファイルはロールバックされる。

### Step 3: 検証

```bash
psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" <<'SQL'
-- 1. テーブル数（既存 7 + 新規 5 = 12）
SELECT COUNT(*) AS total_tables FROM pg_tables WHERE schemaname = 'public';

-- 2. 新規 5 テーブル存在確認
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('municipalities', 'municipality_unit_prices',
                    'child_care_entry_records', 'short_stay_records',
                    'daytime_temp_support_records')
ORDER BY tablename;

-- 3. 各テーブルの列数確認
SELECT
  c.relname AS table_name,
  COUNT(a.attname) AS column_count
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
WHERE c.relname IN ('municipalities', 'municipality_unit_prices',
                    'child_care_entry_records', 'short_stay_records',
                    'daytime_temp_support_records')
GROUP BY c.relname
ORDER BY c.relname;
-- 期待値:
--   municipalities: 7
--   municipality_unit_prices: 8
--   child_care_entry_records: 39
--   short_stay_records: 37
--   daytime_temp_support_records: 41

-- 4. FK 制約確認
SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.municipality_unit_prices'::regclass
)
AND contype = 'f';
-- 期待値: fk_mup_shichoson FOREIGN KEY (shichoson_id) REFERENCES municipalities(shichoson_id) ON DELETE RESTRICT

-- 5. UNIQUE 部分 INDEX 確認
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename IN ('child_care_entry_records', 'short_stay_records',
                    'daytime_temp_support_records', 'municipality_unit_prices')
  AND indexname LIKE '%unique%'
ORDER BY indexname;
-- 期待値: 4 件（各業務テーブルに 1 件 + mup_unique_active）
SQL
```

## 適用後の運用

### 既存 GAS への影響

**改修不要**。既存「01相談記録」を SELECT する `001_レセプト生成_CloudSQL.js` は無変更で動作する。

### 新サービスの実装作業（GAS 側）

[計画書 §5](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md) に従って Phase 5 で実装:
- `executeMakeRecept()` の category 分岐に 3 サービス追加
- 月次条件分岐（6 月改定対応）追加
- 暦日生成 + LEFT JOIN ロジック追加

[README.md §GAS 暦日 LEFT JOIN SQL 例](README.md) を参照。

## ロールバック

問題発生時は依存逆順で DROP：

```sql
DROP TABLE IF EXISTS public.daytime_temp_support_records;
DROP TABLE IF EXISTS public.short_stay_records;
DROP TABLE IF EXISTS public.child_care_entry_records;
DROP TABLE IF EXISTS public.municipality_unit_prices;  -- FK 元
DROP TABLE IF EXISTS public.municipalities;            -- FK 先
```

データが入った後は注意（CSV エクスポート → DROP → 再作成 → リストアの順）。

## トラブルシューティング

### エラー: `ERROR: relation "municipalities" does not exist`
→ 適用順序の問題。09 を 10 より先に。

### エラー: `permission denied for schema public`
→ `dev-support@ordentier-corp.co.jp` 権限で接続していない。`gcloud auth list` で確認。

### エラー: `column "seikyu_nissuu" of relation does not exist`
→ DDL は既に修正済み（日次レコード設計に変更され、GENERATED 列は削除された）。最新の SQL ファイルを使用しているか確認（commit `70a6804` 以降）。

### auto mode classifier が gcloud / psql を block する
→ block されたコマンドの先頭に `!` を付ける、または `.claude/settings.local.json` の allowlist に追加。

## 完了報告

適用完了したら以下を依頼者（lab@appsheet.fun）に共有してください：

- [ ] 全 5 ファイル適用成功
- [ ] 検証 SQL 5 件すべて期待値通り
- [ ] AppSheet 接続テスト（業務テーブルへの読書きテスト）
- [ ] 残課題（あれば）

---

**参照ドキュメント**:
- [README.md](README.md) — 各 DDL ファイルの設計説明
- [decisions-2026-06-22.md](../../context/decisions-2026-06-22.md) — 不可逆な前提条件（§7 暦日固定行）
- [計画書 §2.8 / §4.2](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md) — Excel 暦日固定行 設計根拠
