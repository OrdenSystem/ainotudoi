"""AppSheet テーブルに行を追加する Application API v2 直接呼出しスクリプト。

MCP `add_records` ツールと同等の挙動を直接 API で実行する。
.env の APPSHEET_ACCESS_KEY__<APPID> を使用（Cookie 認証不要）。

使用例:
    python scripts/appsheet-add-records.py \\
        --app-id b9e4f84d-f9b9-4376-97f1-83e3b07122e3 \\
        --table 001_事業所加算マスタ \\
        --csv scripts/master-rows-jido-nyusho.csv \\
        --apply

CSV 形式（1 行目がヘッダ、各列が AppSheet テーブルの列名）:
    事業所加算一覧,区分_選択肢,事業所REF,適用開始_年月日,加算種別,...
    乳幼児加算,,児童入所施設,2026-06-01,1.事業所の体制・評価に関する加算,...
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in Path(".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def get_access_key(env: dict[str, str], app_id: str) -> str:
    key = env.get(f"APPSHEET_ACCESS_KEY__{app_id}")
    if not key:
        raise SystemExit(
            f"ERROR: .env に APPSHEET_ACCESS_KEY__{app_id} がありません"
        )
    return key


def add_rows_via_api(
    app_id: str, table: str, rows: list[dict], access_key: str
) -> dict:
    """Application API v2 で行追加."""
    url = (
        f"https://www.appsheet.com/api/v2/apps/{app_id}/tables/"
        f"{urllib.parse.quote(table, safe='')}/Action"
    )
    body = {
        "Action": "Add",
        "Properties": {
            "Locale": "ja-JP",
            "Timezone": "Asia/Tokyo",
        },
        "Rows": rows,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "ApplicationAccessKey": access_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"ERROR: API失敗 {e.code}: {text[:500]}")
    if not text.strip():
        return {"status": status, "rows_added": len(rows), "body": ""}
    try:
        return {"status": status, "rows_added": len(rows), "body": json.loads(text)}
    except json.JSONDecodeError:
        return {"status": status, "rows_added": len(rows), "body": text[:500]}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--app-id", required=True)
    p.add_argument("--table", required=True)
    p.add_argument("--csv", required=True, help="行データ CSV ファイル")
    p.add_argument("--apply", action="store_true", help="実適用（省略時 dry-run）")
    p.add_argument("--batch-size", type=int, default=50, help="1 リクエスト当たり行数")
    args = p.parse_args()

    env = load_env()
    access_key = get_access_key(env, args.app_id)

    rows: list[dict] = []
    with Path(args.csv).open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            # 空文字列は除外（AppSheet 側で初期値処理に任せる）
            rows.append({k: v for k, v in r.items() if v != ""})

    print(f"App ID: {args.app_id}")
    print(f"Table: {args.table}")
    print(f"CSV: {args.csv}")
    print(f"Rows: {len(rows)}")
    print()

    if not rows:
        print("行データが空です。終了。")
        return 0

    print("=== サンプル（先頭 3 行）===")
    for i, r in enumerate(rows[:3]):
        print(f"  [{i+1}] {r}")
    print()

    if not args.apply:
        print("(dry-run) --apply で実適用します。")
        return 0

    # バッチ送信
    total = len(rows)
    sent = 0
    for i in range(0, total, args.batch_size):
        batch = rows[i : i + args.batch_size]
        print(f"[batch {i//args.batch_size + 1}] {len(batch)} 行送信中 ...")
        result = add_rows_via_api(args.app_id, args.table, batch, access_key)
        sent += result["rows_added"]
        print(f"  → status={result['status']}, added={result['rows_added']}")

    print()
    print(f"完了: {sent}/{total} 行追加")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
