"""AppSheet Enum 列に値を追加する直接 API スクリプト。

MCP 経由を回避し、saveapp エンドポイントを直接叩く。
.env の APPSHEET_COOKIE を読み込み、loadApp → modify → saveapp の 3 段階。

使い方:
    python scripts/appsheet-add-enum-value.py \\
        --app-name HopeCareDX_ainotudoi-443914355 \\
        --table Office__c \\
        --column ServiceType__c \\
        --values 児童入所施設 日中一時支援 \\
        --dry-run

    --apply で実適用、--dry-run で diff のみ表示。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")


def load_cookie() -> str:
    env_path = Path(".env")
    if not env_path.exists():
        raise SystemExit("ERROR: .env が見つかりません")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("APPSHEET_COOKIE="):
            return line[len("APPSHEET_COOKIE=") :].strip()
    raise SystemExit("ERROR: .env に APPSHEET_COOKIE がありません")


def load_app_id() -> str:
    env_path = Path(".env")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("APPSHEET_DEFAULT_APP_ID="):
            return line[len("APPSHEET_DEFAULT_APP_ID=") :].strip()
    raise SystemExit("ERROR: .env に APPSHEET_DEFAULT_APP_ID がありません")


def get_editor_headers(cookie: str, app_name: str) -> dict[str, str]:
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
    req = urllib.request.Request(url, method="GET", headers=get_editor_headers(cookie, app_name))
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    wrapper = json.loads(data)
    if not isinstance(wrapper.get("app"), str):
        raise SystemExit("ERROR: loadApp レスポンスの app フィールドが文字列ではありません")
    return json.loads(wrapper["app"])


def find_attribute(app: dict, table_name: str, column_name: str) -> dict:
    schema_name = f"{table_name}_Schema"
    schemas = app.get("AppData", {}).get("DataSchemas", [])
    for s in schemas:
        if s.get("Name") == schema_name:
            for a in s.get("Attributes", []) or []:
                if a.get("Name") == column_name:
                    return a
            raise SystemExit(f"ERROR: 列 '{column_name}' が schema '{schema_name}' に見つかりません")
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
    headers = get_editor_headers(cookie, app_name)
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        "https://www.appsheet.com/api/saveapp",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"ERROR: saveapp 失敗: {e.code} {text[:500]}")
    parsed = json.loads(text)
    if not parsed.get("Success"):
        err = parsed.get("ErrorDescription", "(no description)")
        retry = " [retryable]" if parsed.get("Retryable") else ""
        raise SystemExit(f"ERROR: saveapp 内部エラー: {err}{retry}")
    return parsed


def main() -> int:
    p = argparse.ArgumentParser(description="AppSheet Enum 値追加")
    p.add_argument("--app-name", required=True)
    p.add_argument("--table", required=True)
    p.add_argument("--column", required=True)
    p.add_argument("--values", nargs="+", required=True, help="追加する値（複数可）")
    p.add_argument("--apply", action="store_true", help="実適用（省略時は dry-run）")
    args = p.parse_args()

    cookie = load_cookie()
    app_id = load_app_id()

    print(f"App: {args.app_name} ({app_id})")
    print(f"Target: {args.table}.{args.column}")
    print(f"Adding: {args.values}")
    print()

    # 1. loadApp
    print("[1/3] loadApp ...", flush=True)
    app = fetch_load_app(args.app_name, cookie)

    # 2. modify
    attr = find_attribute(app, args.table, args.column)
    typ = attr.get("Type")
    if typ not in ("Enum", "EnumList"):
        raise SystemExit(f"ERROR: 列の型は {typ}。Enum / EnumList のみ対応")

    aux_str = attr.get("TypeAuxData") or "{}"
    aux = json.loads(aux_str)
    before = list(aux.get("EnumValues") or aux.get("Values") or [])
    to_add = [v for v in args.values if v not in before]
    already = [v for v in args.values if v in before]
    after = before + to_add

    print("[2/3] diff:")
    print(f"  before: {len(before)} values")
    if already:
        print(f"  already present (skip): {already}")
    print(f"  to add: {to_add}")
    print(f"  after: {len(after)} values")
    print()

    if not to_add:
        print("変更なし。終了。")
        return 0

    if not args.apply:
        print("(dry-run) --apply を付けると実適用します。")
        return 0

    aux["EnumValues"] = after
    attr["TypeAuxData"] = json.dumps(aux, ensure_ascii=False)

    # 3. saveapp
    print("[3/3] saveapp ...", flush=True)
    result = post_save_app(app_id, args.app_name, app, cookie)
    print(f"OK: Success={result.get('Success')}  ErrorDescription={result.get('ErrorDescription')}")

    # verify
    verify_app = fetch_load_app(args.app_name, cookie)
    verify_attr = find_attribute(verify_app, args.table, args.column)
    verify_aux = json.loads(verify_attr.get("TypeAuxData") or "{}")
    verify_values = verify_aux.get("EnumValues") or verify_aux.get("Values") or []
    print("Verify:")
    for v in args.values:
        mark = "OK" if v in verify_values else "NG"
        print(f"  [{mark}] {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
