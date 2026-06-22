# CloudSQL DDL — 入所系3サービス追加

> 対象 DB: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi` / `hopecare` データベース
> 設計準拠: [decisions-2026-06-22 §7](../../context/decisions-2026-06-22.md) / [計画書 §2.8](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md)
> 作成: 2026-06-22

## 目的

入所系 3 サービス（児童入所施設 / 短期入所 / 日中一時支援）の実績データを CloudSQL に保持するためのテーブルを新設します。

## ⚠️ 設計の根幹: 日次レコードパターン

既存「01相談記録」と同じく、**1 利用者 × 1 日 = 1 行** の日次レコードとして設計しています。実績がある日のみ INSERT し、利用がない日はレコードなし。月次集計や Excel 出力は GAS が SELECT 時に行います。

## ファイル一覧

| # | ファイル | 種別 | 行サイズ |
|---|---|---|---|
| 06 | [`06_child_care_entry_records.sql`](06_child_care_entry_records.sql) | 業務テーブル | 児童入所施設の日次実績 |
| 07 | [`07_short_stay_records.sql`](07_short_stay_records.sql) | 業務テーブル | 短期入所の日次実績 |
| 08 | [`08_daytime_temp_support_records.sql`](08_daytime_temp_support_records.sql) | 業務テーブル | 日中一時支援の日次実績 |
| 09 | [`09_municipalities.sql`](09_municipalities.sql) | 補助マスタ | 市町村マスタ（SF Account ミラー） |
| 10 | [`10_municipality_unit_prices.sql`](10_municipality_unit_prices.sql) | 補助マスタ | 日中一時単価マスタ |

> 番号 06〜10 は既存 migrate スクリプト (`migrate_01_soudan.js` 〜 `migrate_05_shutsuryokusaki_file.js`) の続番。

## 適用順序

依存関係:

```
09_municipalities         ← まずマスタ
    ↓ (FK)
10_municipality_unit_prices

06_child_care_entry_records  ← 互いに独立（並行適用可）
07_short_stay_records
08_daytime_temp_support_records (内部に shichoson_id 参照あるが FK ではない)
```

推奨順序: **09 → 10 → 06 → 07 → 08**

## 適用手順（cloud-sql-proxy 経由）

⚠️ **実行は開発チーム（`dev-support@ordentier-corp.co.jp` 権限保持者）に限定**。`lab@appsheet.fun` には適用権限なし。

```bash
# 1. cloud-sql-proxy 起動（ポート 5435 推奨。5433 は他インスタンスと衝突）
cloud-sql-proxy \
  --token=$(gcloud auth print-access-token --impersonate-service-account=dev-support@ordentier-corp.co.jp) \
  --port=5435 \
  ainotudoisql:asia-northeast1:hopecare-db-ainotudoi &

# 2. 適用（順序遵守）
for f in 09_municipalities.sql 10_municipality_unit_prices.sql \
         06_child_care_entry_records.sql 07_short_stay_records.sql \
         08_daytime_temp_support_records.sql; do
  echo "Applying $f..."
  psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" -f "$f"
done

# 3. 検証
psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" -c "\dt"
# → 既存 7 + 新規 5 = 12 テーブル確認
```

## ロールバック手順

各テーブルは独立しているため、必要なテーブルだけ DROP 可能です。

```sql
-- 全テーブル巻き戻し（依存関係逆順）
DROP TABLE IF EXISTS public.daytime_temp_support_records;
DROP TABLE IF EXISTS public.short_stay_records;
DROP TABLE IF EXISTS public.child_care_entry_records;
DROP TABLE IF EXISTS public.municipality_unit_prices;  -- FK 元
DROP TABLE IF EXISTS public.municipalities;            -- FK 先

-- 個別テーブルのみ巻き戻し
-- 例: 児童入所施設のみ取消
DROP TABLE IF EXISTS public.child_care_entry_records;
```

## 設計上の共通方針

### 1. 既存「01相談記録」パターン踏襲
- PK: `record_id VARCHAR(255)`（GAS が UUID 生成）
- 全 nullable 列（既存と同じく `NOT NULL` は主キーのみ）
- INDEX 命名: `idx_<table_prefix>_<column>` パターン
- 共通列: `toroku_nichiji` / `koushin_nichiji` / `user_mail` / `flag` / `saisei_flag`

### 2. 日次キー
- `kiroku_bi DATE NOT NULL` — その行が示す具体的な日付
- `nichi VARCHAR(2)` — '01'〜'31'（Excel 暦日行マッピング用）
- `nengetsu VARCHAR(7)` — 'YYYY-MM'（月次 GROUP BY キー）

### 3. UNIQUE 制約
- 児童入所・短期入所: `(riyousha_zaiseki_id, kiroku_bi) WHERE flag IS DISTINCT FROM TRUE`
- 日中一時: `(riyousha_zaiseki_id, kiroku_bi, shichoson_id) WHERE flag IS DISTINCT FROM TRUE`
- 部分 INDEX により**再請求時は同一日に別レコードを追加可能**（`flag=TRUE` の請求済レコードは UNIQUE から除外）

### 4. 6 月改定対応
- 実費 1〜5 列を 5 列まで拡張（`jippi_1` 〜 `jippi_5`）
- 福祉・介護職員等処遇改善加算列を `fukushi_kaigo_shoguu_kasan VARCHAR(255)` で全テーブルに設置

### 5. 加算列の暫定設計
リタリコ Excel テンプレートの正式なヘッダー列名が確定するまで、加算列は暫定的に主要なものを Boolean / VARCHAR で配置。Phase 0 完了後に列名を確定する。

## GAS への影響

### 既存処理は無改修
既存「01相談記録」を SELECT する `001_レセプト生成_CloudSQL.js` は改修不要。

### 新規追加（計画書 §5 参照）
- `001_レセプト生成_CloudSQL.js` の `executeMakeRecept()` category 分岐に 3 件追加
- 月次条件分岐（6 月改定）追加
- 暦日生成関数 + LEFT JOIN ロジック追加（暦日テーブルとの結合）

### 暦日 LEFT JOIN SQL 例（児童入所施設）

```sql
-- 月の暦日（28〜31 行）+ 実績データ LEFT JOIN
WITH calendar AS (
  SELECT generate_series(
    DATE '2026-06-01',
    DATE '2026-06-30',  -- 月末日は GAS が動的算出
    INTERVAL '1 day'
  )::DATE AS kiroku_bi
)
SELECT
  c.kiroku_bi,
  TO_CHAR(c.kiroku_bi, 'DD') AS nichi,
  TO_CHAR(c.kiroku_bi, 'Dy')  AS youbi,  -- 曜日は GAS 側既存の数式を保持するため SQL で出さない選択肢もあり
  r.riyo_jotai,
  r.kihon_hoshu,
  r.kasan,
  r.jippi_1, r.jippi_2, r.jippi_3, r.jippi_4, r.jippi_5
FROM calendar c
LEFT JOIN public.child_care_entry_records r
  ON r.kiroku_bi = c.kiroku_bi
  AND r.riyousha_zaiseki_id = $1   -- パラメータ: 利用者在籍ID
  AND r.flag IS DISTINCT FROM TRUE
ORDER BY c.kiroku_bi;
```

## 関連ドキュメント

- [decisions-2026-06-22.md](../../context/decisions-2026-06-22.md) — 不可逆な前提条件
- [計画書 §2.8 / §4.2](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md) — Excel 暦日固定行 設計根拠
- [03-cloudsql-and-docs.md](../../context/current-system/03-cloudsql-and-docs.md) — 既存 CloudSQL 構造（参照元）
