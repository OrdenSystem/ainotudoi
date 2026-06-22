"""AppSheet 列の Type を変更する saveapp 直接呼出しスクリプト。

特に Decimal → Number（整数化）の用途に最適化。
TypeAuxData.DecimalDigits の処理も含む。

使用例:
    python scripts/appsheet-set-column-type.py \\
        --app-name HopeCareDX_ainotudoi-443914355 \\
        --table DisabilityCard__c \\
        --column ContractRowNumber__c \\
        --type Number \\
        --apply

複数列を一括:
    --config scripts/column-type-updates.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")


def load_cookie() -> str:
    for line in Path(".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("APPSHEET_COOKIE="):
            return line[len("APPSHEET_COOKIE=") :].strip()
    raise SystemExit("ERROR: .env に APPSHEET_COOKIE がありません")


def load_app_id() -> str:
    for line in Path(".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("APPSHEET_DEFAULT_APP_ID="):
            return line[len("APPSHEET_DEFAULT_APP_ID=") :].strip()
    raise SystemExit("ERROR: .env に APPSHEET_DEFAULT_APP_ID がありません")


def get_headers(cookie: str, app_name: str) -> dict[str, str]:
    return {
        "Cookie": cookie,
        "Origin": "https://www.appsheet.com",
        "Referer": (
            "https://www.appsheet.com/template/AppDef?appName="
            + urllib.parse.quote(app_name, safe="")
        ),
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
    }


def fetch_load_app(app_name: str, cookie: str) -> dict:
    url = (
        f"https://www.appsheet.com/api/loadApp/{urllib.parse.quote(app_name, safe='')}"
        "?version=&checkConsistency=false&useUpdatedWarningText=false"
    )
    req = urllib.request.Request(url, headers=get_headers(cookie, app_name))
    with urllib.request.urlopen(req, timeout=60) as resp:
        wrapper = json.loads(resp.read())
    return json.loads(wrapper["app"])


def find_attribute(app: dict, table: str, column: str) -> dict:
    schema_name = f"{table}_Schema"
    for s in app["AppData"].get("DataSchemas") or []:
        if s.get("Name") == schema_name:
            for a in s.get("Attributes") or []:
                if a.get("Name") == column:
                    return a
            raise SystemExit(f"ERROR: 列 '{column}' が schema '{schema_name}' に見つかりません")
    raise SystemExit(f"ERROR: schema '{schema_name}' が見つかりません")


def post_save_app(app_id: str, app_name: str, app: dict, cookie: str) -> dict:
    body = {
        "location": "0, 0",
        "locale": "ja",
        "tzOffset": -540,
        "userSettings": {"_RowNumber": "0", "_THISUSER": "onlyvalue"},
        "appId": app_id,
        "appJson": json.dumps(app, ensure_ascii=False),
    }
    headers = get_headers(cookie, app_name)
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        "https://www.appsheet.com/api/saveapp",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise SystemExit(
            f"ERROR: saveapp 失敗: {e.code} {e.read().decode('utf-8', errors='replace')[:500]}"
        )
    parsed = json.loads(text)
    if not parsed.get("Success"):
        raise SystemExit(
            f"ERROR: saveapp 内部エラー: {parsed.get('ErrorDescription')}"
        )
    return parsed


def update_attribute_type(attr: dict, new_type: str) -> tuple[str, str]:
    """Update attribute Type and adjust TypeAuxData. Returns (before, after) tuple."""
    before = attr.get("Type")
    attr["Type"] = new_type
    aux_str = attr.get("TypeAuxData") or "{}"
    try:
        aux = json.loads(aux_str)
    except (json.JSONDecodeError, TypeError):
        aux = {}
    # Number 型は DecimalDigits を持たない (整数表示)
    if new_type == "Number":
        aux.pop("DecimalDigits", None)
    attr["TypeAuxData"] = json.dumps(aux, ensure_ascii=False)
    return before, new_type


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--app-name", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--config", help="複数列一括: JSON 設定ファイル")
    g.add_argument("--single", action="store_true", help="単一列モード")
    p.add_argument("--table")
    p.add_argument("--column")
    p.add_argument("--type")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    if args.single and not (args.table and args.column and args.type):
        raise SystemExit("ERROR: --single モードは --table --column --type が必須")

    cookie = load_cookie()
    app_id = load_app_id()

    if args.config:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    else:
        config = [{"table": args.table, "column": args.column, "type": args.type}]

    print(f"App: {args.app_name} ({app_id})")
    print(f"Updates: {len(config)} columns")
    print()

    print("[1/3] loadApp ...", flush=True)
    app = fetch_load_app(args.app_name, cookie)

    print("[2/3] applying ...")
    summary = []
    for entry in config:
        attr = find_attribute(app, entry["table"], entry["column"])
        before, after = update_attribute_type(attr, entry["type"])
        summary.append((entry["table"], entry["column"], before, after))

    print()
    print("=== Diff summary ===")
    print(f"{'Table':<25} | {'Column':<30} | Before -> After")
    print("-" * 75)
    for t, c, b, a in summary:
        mark = "" if b == a else "  (changed)"
        print(f"{t:<25} | {c:<30} | {b} -> {a}{mark}")
    print()

    if not args.apply:
        print("(dry-run) --apply を付けると実適用します。")
        return 0

    print("[3/3] saveapp ...", flush=True)
    result = post_save_app(app_id, args.app_name, app, cookie)
    print(f"OK: Success={result.get('Success')}")

    # Verify
    print()
    print("Verify ...")
    fresh = fetch_load_app(args.app_name, cookie)
    for entry in config:
        verify_attr = find_attribute(fresh, entry["table"], entry["column"])
        actual_type = verify_attr.get("Type")
        mark = "OK" if actual_type == entry["type"] else "NG"
        print(f"  [{mark}] {entry['table']}.{entry['column']}: Type={actual_type}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
