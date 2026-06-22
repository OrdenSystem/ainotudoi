# CloudSQL DDL — 入所系3サービス追加

> 対象 DB: `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi` / `hopecare` データベース
> 設計準拠: [decisions-2026-06-22 §7](../../context/decisions-2026-06-22.md) / [計画書 §2.8](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md)
> 作成: 2026-06-22 / 命名規約改訂: 2026-06-22（日本語化）

## 目的

入所系 3 サービス（児童入所施設 / 短期入所 / 日中一時支援）の実績データを CloudSQL に保持するためのテーブルを新設します。

## ⚠️ 設計の根幹

### 日次レコードパターン
既存「01相談記録」と同じく、**1 利用者 × 1 日 = 1 行** の日次レコード。実績がある日のみ INSERT し、利用がない日はレコードなし。月次集計や Excel 出力は GAS が SELECT 時に行う。

### 命名規約（2026-06-22 ユーザー方針）
- **テーブル名・列名は日本語**（既存「01相談記録」と統一）
- **「登録」を採用**（UI 表示と統一・既存「01相談記録」も UI では「相談登録」）
- 既存「01相談記録」テーブル名は**温存**（破壊的変更を避ける）

### ケース記録の流用
- 既存「ケース記録 + ケースマスタ」のレイヤーを入所系でも再利用
- ケース記録に親別の FK 列を 3 追加（11_ケース記録_FK追加.sql）

## ファイル一覧（6 ファイル）

| # | ファイル | 種別 | テーブル |
|---|---|---|---|
| 06 | [`06_児童入所登録.sql`](06_児童入所登録.sql) | 業務テーブル新設 | `児童入所登録` |
| 07 | [`07_短期入所登録.sql`](07_短期入所登録.sql) | 業務テーブル新設 | `短期入所登録` |
| 08 | [`08_日中一時登録.sql`](08_日中一時登録.sql) | 業務テーブル新設 | `日中一時登録` |
| 09 | [`09_市町村マスタ.sql`](09_市町村マスタ.sql) | 補助マスタ新設 | `市町村マスタ` |
| 10 | [`10_日中一時単価マスタ.sql`](10_日中一時単価マスタ.sql) | 補助マスタ新設 | `日中一時単価マスタ` |
| 11 | [`11_ケース記録_FK追加.sql`](11_ケース記録_FK追加.sql) | **既存テーブル ALTER** | `ケース記録`（既存）に 3 列追加 |

> 番号 06〜11 は既存 migrate スクリプト (`migrate_01_soudan.js` 〜 `migrate_05_shutsuryokusaki_file.js`) の続番。

## 適用順序

依存関係:

```
09_市町村マスタ
    ↓ (FK)
10_日中一時単価マスタ

06_児童入所登録    ← 互いに独立（並行適用可）
07_短期入所登録
08_日中一時登録 (内部に 市町村ID 参照あるが FK ではない)
    ↓
11_ケース記録_FK追加  ← 06〜08 のテーブル名を参照するコメントを含むが
                       実際の FK 制約は付けない（多態性のため）
```

推奨順序: **09 → 10 → 06 → 07 → 08 → 11**

## 適用手順（cloud-sql-proxy + psycopg2 / psql 経由）

⚠️ **実行は開発チーム（`dev-support@ordentier-corp.co.jp` 権限保持者）に限定**。

### psql で実行する場合

```bash
# 1. cloud-sql-proxy 起動（ポート 5435 推奨）
cloud-sql-proxy \
  --token=$(gcloud auth print-access-token) \
  --port=5435 \
  ainotudoisql:asia-northeast1:hopecare-db-ainotudoi &

# 2. 適用（順序遵守）
for f in 09_市町村マスタ.sql 10_日中一時単価マスタ.sql \
         06_児童入所登録.sql 07_短期入所登録.sql 08_日中一時登録.sql \
         11_ケース記録_FK追加.sql; do
  echo "=== Applying $f ==="
  psql "host=127.0.0.1 port=5435 dbname=hopecare user=postgres" \
       --set ON_ERROR_STOP=on \
       -f "$f"
done
```

### Python (psycopg2) で実行する場合

```python
import psycopg2
from pathlib import Path

APPLY_ORDER = [
    "09_市町村マスタ.sql",
    "10_日中一時単価マスタ.sql",
    "06_児童入所登録.sql",
    "07_短期入所登録.sql",
    "08_日中一時登録.sql",
    "11_ケース記録_FK追加.sql",
]

conn = psycopg2.connect(
    host="127.0.0.1", port=5435,
    dbname="hopecare", user="postgres",
    password="<env から取得>"
)
conn.autocommit = False  # 各ファイルが BEGIN/COMMIT で自己完結

for fname in APPLY_ORDER:
    print(f"Applying {fname}")
    sql = Path(f"welfare-pdca/implementation/ddl/{fname}").read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    print(f"  OK")
conn.close()
```

## ロールバック手順

依存逆順で DROP / ALTER 取消:

```sql
-- 11 の取消（ケース記録から列削除）
ALTER TABLE public."ケース記録"
    DROP COLUMN IF EXISTS "児童入所登録ID",
    DROP COLUMN IF EXISTS "短期入所登録ID",
    DROP COLUMN IF EXISTS "日中一時登録ID";

-- 業務テーブル 3 個
DROP TABLE IF EXISTS public."日中一時登録";
DROP TABLE IF EXISTS public."短期入所登録";
DROP TABLE IF EXISTS public."児童入所登録";

-- 補助マスタ 2 個（依存順）
DROP TABLE IF EXISTS public."日中一時単価マスタ";
DROP TABLE IF EXISTS public."市町村マスタ";
```

データが入った後の DROP は CSV エクスポート → DROP の手順で。

## 設計上の共通方針

### 1. 既存「01相談記録」パターン踏襲
- PK: `<テーブル名>ID VARCHAR(255)`
- 全 nullable 列（既存と同じく `NOT NULL` は主キー + 記録日のみ）
- INDEX 命名: `idx_<table_short>_<column>` パターン
- 共通列: `登録日時` / `更新日時` / `UserMail` / `フラグ` / `再請求フラグ`

### 2. 日次キー
- `記録日 DATE NOT NULL` — その行が示す具体的な日付
- `日 VARCHAR(2)` — '01'〜'31'（Excel 暦日行マッピング用）
- `年月 VARCHAR(7)` — 'YYYY-MM'（月次 GROUP BY キー）

### 3. UNIQUE 制約
- 児童入所・短期入所: `("利用者在籍ID", "記録日") WHERE "フラグ" IS DISTINCT FROM TRUE`
- 日中一時: `("利用者在籍ID", "記録日", "市町村ID") WHERE "フラグ" IS DISTINCT FROM TRUE`
- 部分 INDEX により**再請求時は同一日に別レコードを追加可能**

### 4. 6 月改定対応
- 実費 1〜5 列を 5 列まで拡張（`実費1` 〜 `実費5`）
- `福祉介護職員等処遇改善加算` 列を全テーブルに設置

### 5. ケース記録の多態 FK
- ケース記録の `相談記録ID`（既存）+ `児童入所登録ID` / `短期入所登録ID` / `日中一時登録ID`（新規）
- 親が決まると 4 列のうち 1 列に値が入る形
- DB レベルの FK 制約は付けない（4 列 NULL 許可・運用での整合性保証）

### 6. 加算列の暫定設計
リタリコ Excel テンプレートの正式なヘッダー列名が確定するまで、加算列は暫定的に主要なものを Boolean / VARCHAR で配置。Phase 0 完了後に列名を確定する。

## GAS への影響

### 既存処理は無改修
既存「01相談記録」「ケース記録」を SELECT する `001_レセプト生成_CloudSQL.js` は改修不要。

### 新規追加（計画書 §5 参照）
- `001_レセプト生成_CloudSQL.js` の `executeMakeRecept()` category 分岐に 3 件追加
- 月次条件分岐（6 月改定）追加
- 暦日生成関数 + LEFT JOIN ロジック追加

### 暦日 LEFT JOIN SQL 例（児童入所登録）

```sql
WITH calendar AS (
  SELECT generate_series(
    DATE '2026-06-01',
    DATE '2026-06-30',
    INTERVAL '1 day'
  )::DATE AS "記録日"
)
SELECT
  c."記録日",
  TO_CHAR(c."記録日", 'DD') AS "日",
  r."利用状態",
  r."基本報酬",
  r."加算",
  r."実費1", r."実費2", r."実費3", r."実費4", r."実費5"
FROM calendar c
LEFT JOIN public."児童入所登録" r
  ON r."記録日" = c."記録日"
  AND r."利用者在籍ID" = $1
  AND r."フラグ" IS DISTINCT FROM TRUE
ORDER BY c."記録日";
```

## 関連ドキュメント

- [decisions-2026-06-22.md](../../context/decisions-2026-06-22.md) — 不可逆な前提条件
- [計画書 §2.8 / §4.2](../../plans/2026-06-22-入所系3サービス追加_詳細実装計画.md) — Excel 暦日固定行 設計根拠
- [03-cloudsql-and-docs.md](../../context/current-system/03-cloudsql-and-docs.md) — 既存 CloudSQL 構造（参照元）
- [HANDOFF.md](HANDOFF.md) — 本番適用手順書（dev-support 権限保持者向け）
