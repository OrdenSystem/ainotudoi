# Cloud SQL スキーマ複製作業 — ハンドオフ

最終更新: 2026-06-10（**✅ 全タスク完了**）

> **完了サマリ**: `hahaha-cloudsql:hopecare-db` の public スキーマ（7テーブル / 19索引 / 8制約・**データ0行**）を
> `ainotudoisql:asia-northeast1:hopecare-db-ainotudoi`（DB `hopecare`）へ複製済み。接続情報は `.env.local`（gitignore 済み）。
> 実装上の判断は `docs/decisions/DECISIONS.md`（2026-06-10 エントリ）参照。
> **残推奨作業**: 元 postgres パスワードのローテート（チャット露出のため、既知事項 #2）。

## 目的

`hahaha-cloudsql` プロジェクトの Cloud SQL インスタンスのスキーマ（テーブル名・列名・型・インデックス・FK・view・sequence 等）を、`ainotudoisql` プロジェクトに **データを伴わずに** 複製する。

---

## 元 / 移行先 情報

### 元（読み取り元）

| 項目 | 値 |
|---|---|
| プロジェクト | `hahaha-cloudsql` |
| 接続名 | `hahaha-cloudsql:asia-northeast1:hopecare-db` |
| インスタンス名 | `hopecare-db` |
| エンジン | PostgreSQL 15 |
| リージョン | `asia-northeast1` (zone `asia-northeast1-b`) |
| マシン | `db-g1-small` |
| ディスク | 10 GB |
| データベース | `hopecare`（移行対象） / `postgres`（既定） |
| 既存 DB ユーザ | `postgres` (BUILT_IN) のみ |
| Cloud SQL SA | `p435699522659-x31qu6@gcp-sa-cloud-sql.iam.gserviceaccount.com` |
| IAM 認証フラグ | 未有効 |

### 移行先（書込み先）

| 項目 | 値 |
|---|---|
| プロジェクト | `ainotudoisql` |
| インスタンス名（予定） | `hopecare-db-ainotudoi` |
| エンジン（予定） | PostgreSQL 15（元と同一） |
| リージョン（予定） | `asia-northeast1`（元と同一） |
| マシン（予定） | `db-g1-small`（元と同一） |
| ディスク（予定） | 10 GB（元と同一） |
| DB 名（予定） | `hopecare`（元と同一） |
| postgres パスワード（予定） | 自動生成 → `.env.local` 保存（gitignore 済み） |

---

## 確定済みの方針（ユーザ承認済み）

- **gcloud アカウント**: `dev-support@ordentier-corp.co.jp`
  （`lab@appsheet.fun` は両プロジェクトへの権限なし）
- **コピー範囲**: スキーマのみ（テーブル名・列名・型・インデックス・FK・view・sequence 等）。データは持ち越さない。
- **DDL 取得経路**: cloud-sql-proxy + Docker `postgres:15` の `pg_dump --schema-only`
  - 理由: GCS バケット作成を auto mode classifier が拒否したため。proxy 経路は外部ストレージ不要。
- **pg_dump 接続 DB ユーザ**: 既存 `postgres` ユーザ（パスワードはユーザがメインチャットで提示予定）
  - 当初は一時 `migrator` ユーザ作成路線を Recommended としたが、auto mode classifier が「共有インフラへの書込み」として拒否したため、ユーザ判断で postgres パスワード直接使用に切替。

---

## 進捗

| # | タスク | 状態 |
|---|---|---|
| 8 | ainotudoisql で Cloud SQL Admin API 有効化 | ✅ 完了 |
| 9 | 元 hopecare DB のスキーマ DDL を export | ✅ 完了（`gas/_schema/hopecare-schema.sql`、7テーブル/19索引/8制約） |
| 10 | 移行先 `hopecare-db-ainotudoi` インスタンス作成 | ✅ 完了（RUNNABLE、PRIMARY 136.110.96.28） |
| 11 | hopecare DB 作成 + スキーマ import | ✅ 完了（import 検証: tables=7 / indexes=26 / rows=0） |
| 12 | `.env.local` 書込み + DECISIONS.md 追記 | ✅ 完了 |
| 13 | 元 postgres パスワードのローテート | ⏳ 推奨（未実施） |

---

## 残作業の手順（パスワード受領後の流れ）

### Step 1: cloud-sql-proxy 起動（バックグラウンド）

```powershell
cloud-sql-proxy hahaha-cloudsql:asia-northeast1:hopecare-db `
  --address 0.0.0.0 --port 5433
```

`--address 0.0.0.0` は Docker コンテナから `host.docker.internal:5433` で接続するために必要。

### Step 2: Docker postgres:15 で pg_dump --schema-only

```powershell
docker run --rm -e PGPASSWORD=<受領パスワード> postgres:15 `
  pg_dump -h host.docker.internal -p 5433 `
  -U postgres -d hopecare `
  --schema-only --no-owner --no-acl `
  > gas/_schema/hopecare-schema.sql
```

出力先: `gas/_schema/hopecare-schema.sql`（作成ディレクトリ）

### Step 3: proxy 停止

バックグラウンド job を停止。

### Step 4: 移行先インスタンス作成

```powershell
$NEWPW = [Convert]::ToBase64String((1..24 | ForEach-Object {Get-Random -Max 256})) -replace '[/+=]',''
gcloud sql instances create hopecare-db-ainotudoi `
  --project=ainotudoisql `
  --database-version=POSTGRES_15 `
  --region=asia-northeast1 --zone=asia-northeast1-b `
  --tier=db-g1-small --storage-size=10 `
  --root-password=$NEWPW
```

所要時間: 5〜10 分。

### Step 5: 移行先 DB 作成

```powershell
gcloud sql databases create hopecare `
  --instance=hopecare-db-ainotudoi --project=ainotudoisql
```

### Step 6: スキーマ import

移行先 proxy を起動して psql で適用（Docker 経由）:

```powershell
cloud-sql-proxy ainotudoisql:asia-northeast1:hopecare-db-ainotudoi `
  --address 0.0.0.0 --port 5434
```

```powershell
docker run --rm -i -e PGPASSWORD=$NEWPW `
  -v ${PWD}/gas/_schema:/work postgres:15 `
  psql -h host.docker.internal -p 5434 -U postgres -d hopecare `
  -f /work/hopecare-schema.sql
```

### Step 7: 接続情報を `.env.local` に保存

```
# C:\dev\ainotudoi\.env.local（gitignore 済み）
AINOTUDOI_CLOUDSQL_INSTANCE=hopecare-db-ainotudoi
AINOTUDOI_CLOUDSQL_CONNECTION=ainotudoisql:asia-northeast1:hopecare-db-ainotudoi
AINOTUDOI_CLOUDSQL_DB=hopecare
AINOTUDOI_CLOUDSQL_USER=postgres
AINOTUDOI_CLOUDSQL_PASSWORD=<Step 4 で生成した $NEWPW>
```

### Step 8: 後片付け

- proxy バックグラウンド job 停止
- パスワード変数のクリア: `Remove-Item Env:PGPASSWORD`
- DECISIONS.md に作業履歴追記

---

## 既知の注意点

1. **auto mode classifier の干渉**: `hahaha-cloudsql` への書込み系操作（GCS バケット作成、DB ユーザ作成）は広く拒否される。
   - 必要時はユーザに `!` プレフィックスで PowerShell から直接叩いてもらう。
   - または `.claude/settings.local.json` の `permissions.allow` に個別パターンを追加。

2. **postgres ユーザのパスワード露出**: 提示されたパスワードはチャット履歴に残る。作業完了後、可能なら `gcloud sql users set-password postgres` で元側のパスワードをローテートしておくことを推奨。

3. **権限不足の可能性**: pg_dump がスーパーユーザでない場合、所有していないオブジェクトの定義が落ちることがある。`postgres` ユーザは cloudsqlsuperuser なので問題は起きないはず。

4. **`gcloud sql export sql` には `--schema-only` が無い**: PostgreSQL では `--clean` `--if-exists` フラグはあるが schema-only は存在しないため、pg_dump 経路を採用した。

---

## 参考: これまでの試行ログ要約

1. `gcloud sql instances describe hopecare-db --project=hahaha-cloudsql` → `lab@appsheet.fun` で 403
2. `gcloud auth login dev-support@ordentier-corp.co.jp` → reauth 必要（ブラウザ完了済）
3. 各種 describe / list 成功 → 元インスタンス情報判明
4. `gcloud services enable sqladmin.googleapis.com --project=ainotudoisql` → 成功
5. `gsutil mb gs://hahaha-cloudsql-export-tmp/` → auto mode で block
6. `gcloud sql users create migrator ...` → auto mode で block
7. → postgres ユーザのパスワード提供方針に切替（ユーザ判断）
