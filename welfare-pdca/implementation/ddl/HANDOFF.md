# CloudSQL DDL 本番適用 ハンドオフ手順書

> **対象**: 開発チーム / `dev-support@ordentier-corp.co.jp` 権限保持者
> **作成**: 2026-06-22 / **依頼者**: lab@appsheet.fun
> **CloudSQL Instance**: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi`
> **DB**: `hopecare` (PostgreSQL 15)

## なぜ別ハンドオフが必要か

`lab@appsheet.fun`（依頼者）は CloudSQL の psql 実行権限を持たず、`dev-support@ordentier-corp.co.jp` のみが本番 DB への接続権を持つ。本書は権限保持者が**手元で 1 回ずつ DDL を適用し、エラーゼロで完了させる**ための単独完結手順書。

## 適用対象（6 ファイル・日本語名）

> 全 SQL ファイルは [`welfare-pdca/implementation/ddl/`](.) に格納。

| 順序 | ファイル | テーブル | 依存 |
|---|---|---|---|
| 1 | [`09_市町村マスタ.sql`](09_市町村マスタ.sql) | `public."市町村マスタ"` | なし |
| 2 | [`10_日中一時単価マスタ.sql`](10_日中一時単価マスタ.sql) | `public."日中一時単価マスタ"` | 09 (FK) |
| 3 | [`06_児童入所登録.sql`](06_児童入所登録.sql) | `public."児童入所登録"` | なし |
| 4 | [`07_短期入所登録.sql`](07_短期入所登録.sql) | `public."短期入所登録"` | なし |
| 5 | [`08_日中一時登録.sql`](08_日中一時登録.sql) | `public."日中一時登録"` | なし（`市町村ID` は FK 制約なし） |
| 6 | [`11_ケース記録_FK追加.sql`](11_ケース記録_FK追加.sql) | **既存** `public."ケース記録"` に 3 列追加 | 06〜08（命名整合性のため最後） |

各 SQL は `BEGIN; ... COMMIT;` で囲まれており、テーブル単位でアトミック。失敗時は自動ロールバックされる。

### 命名規約（2026-06-22 ユーザー方針）
- テーブル名・列名は **日本語**（既存「01相談記録」と統一）
- **「登録」を採用**（UI 表示と同一・既存「01相談記録」も UI では「相談登録」）
- ケース記録 へは破壊的 ALTER せず、列追加のみ（既存非破壊）

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
  AND tablename IN ('市町村マスタ', '日中一時単価マスタ',
                    '児童入所登録', '短期入所登録', '日中一時登録');
-- 期待結果: 0 件（テーブル未存在）

-- ケース記録に既存列確認（11 適用後に 3 列追加を期待）
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ケース記録'
  AND column_name IN ('児童入所登録ID', '短期入所登録ID', '日中一時登録ID');
-- 期待結果（適用前）: 0 件 / （適用後）: 3 件
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

# 依存関係順 (09 → 10 → 06 → 07 → 08 → 11)
APPLY_ORDER=(
  09_市町村マスタ.sql
  10_日中一時単価マスタ.sql
  06_児童入所登録.sql
  07_短期入所登録.sql
  08_日中一時登録.sql
  11_ケース記録_FK追加.sql
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
-- 1. テーブル数（既存 7 + 新規 5 = 12。ケース記録は ALTER のみで増えない）
SELECT COUNT(*) AS total_tables FROM pg_tables WHERE schemaname = 'public';

-- 2. 新規 5 テーブル存在確認
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('市町村マスタ', '日中一時単価マスタ',
                    '児童入所登録', '短期入所登録', '日中一時登録')
ORDER BY tablename;

-- 3. ケース記録に新 3 列が追加されたか
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ケース記録'
  AND column_name IN ('児童入所登録ID', '短期入所登録ID', '日中一時登録ID');
-- 期待結果: 3 件

-- 4. 各テーブルの列数確認
SELECT
  c.relname AS table_name,
  COUNT(a.attname) AS column_count
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
WHERE c.relname IN ('市町村マスタ', '日中一時単価マスタ',
                    '児童入所登録', '短期入所登録', '日中一時登録')
GROUP BY c.relname
ORDER BY c.relname;
-- 期待値:
--   市町村マスタ: 7
--   日中一時単価マスタ: 9
--   児童入所登録: 39
--   短期入所登録: 38
--   日中一時登録: 42

-- 5. FK 制約確認
SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public."日中一時単価マスタ"'::regclass
  AND contype = 'f';
-- 期待値: fk_単価_市町村 FOREIGN KEY ("市町村ID") REFERENCES "市町村マスタ"("市町村ID")

-- 6. UNIQUE 部分 INDEX 確認
SELECT indexname FROM pg_indexes
WHERE tablename IN ('児童入所登録', '短期入所登録', '日中一時登録', '日中一時単価マスタ')
  AND indexname LIKE '%unique%'
ORDER BY indexname;
-- 期待値: 4 件
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
