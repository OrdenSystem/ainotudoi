"""AppSheet View の ColumnOrder を更新する saveapp 直接呼出しスクリプト。

複数 View の ColumnOrder に新列を挿入するバッチ操作。1 回の saveapp で全 view を更新。

使用例:
    python scripts/appsheet-update-view-columns.py \\
        --app-name HopeCareDX_ainotudoi-443914355 \\
        --config scripts/view-updates-disability-card.json \\
        [--apply]

config JSON 形式:
    [
      {
        "view_name": "障害福祉サービス受給者証_Form",
        "after_column": "UpperLimitMgmt__c",
        "new_columns": ["UpperLimitFacilityNumber__c", "UpperLimitFacilityName__c", "UpperLimitResult__c"]
      },
      ...
    ]
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
    if not isinstance(wrapper.get("app"), str):
        raise SystemExit("ERROR: loadApp レスポンスの app フィールドが文字列ではありません")
    return json.loads(wrapper["app"])


def find_control(app: dict, view_name: str) -> dict:
    for c in app["Presentation"]["Controls"]:
        if c.get("Name") == view_name:
            return c
    raise SystemExit(f"ERROR: View '{view_name}' が見つかりません")


def update_column_order(
    column_order: list[str], after_column: str, new_columns: list[str]
) -> tuple[list[str], list[str]]:
    """Insert new_columns into column_order after after_column. Skip already present."""
    if after_column not in column_order:
        raise SystemExit(
            f"ERROR: after_column '{after_column}' が ColumnOrder にありません"
        )
    to_insert = [c for c in new_columns if c not in column_order]
    skipped = [c for c in new_columns if c in column_order]
    idx = column_order.index(after_column)
    new_order = column_order[: idx + 1] + to_insert + column_order[idx + 1 :]
    return new_order, skipped


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
        err = parsed.get("ErrorDescription", "(no description)")
        retry = " [retryable]" if parsed.get("Retryable") else ""
        raise SystemExit(f"ERROR: saveapp 内部エラー: {err}{retry}")
    return parsed


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--app-name", required=True)
    p.add_argument("--config", required=True, help="View 更新設定 JSON ファイル")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    cookie = load_cookie()
    app_id = load_app_id()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))

    print(f"App: {args.app_name} ({app_id})")
    print(f"Updates: {len(config)} views")
    print()

    print("[1/3] loadApp ...", flush=True)
    app = fetch_load_app(args.app_name, cookie)

    print("[2/3] applying updates in-memory ...")
    summary = []
    for entry in config:
        view_name = entry["view_name"]
        after = entry["after_column"]
        new_cols = entry["new_columns"]
        control = find_control(app, view_name)
        vd = control.get("ViewDefinition") or {}
        current = vd.get("ColumnOrder") or []
        new_order, skipped = update_column_order(current, after, new_cols)
        if new_order == current:
            summary.append((view_name, len(current), len(new_order), 0, skipped))
            continue
        vd["ColumnOrder"] = new_order
        control["ViewDefinition"] = vd
        # IMPORTANT: AppSheet reads view settings from Control.Settings (JSON string)
        # on save. ViewDefinition modifications alone are silently dropped.
        settings_raw = control.get("Settings") or "{}"
        try:
            settings = json.loads(settings_raw)
        except (json.JSONDecodeError, TypeError):
            settings = {}
        settings["ColumnOrder"] = new_order
        control["Settings"] = json.dumps(settings, ensure_ascii=False)
        added = len(new_order) - len(current)
        summary.append((view_name, len(current), len(new_order), added, skipped))

    print()
    print("=== Diff summary ===")
    print(f"{'View':<50} | before -> after | added | skipped(already present)")
    print(f"{'-'*50}-+----------------+-------+---------------")
    total_added = 0
    for view_name, before, after, added, skipped in summary:
        sk = ",".join(skipped) if skipped else "-"
        print(f"{view_name:<50} |  {before:3d} -> {after:3d}    |  +{added}   | {sk}")
        total_added += added
    print()
    print(f"Total columns added across all views: {total_added}")
    print()

    if total_added == 0:
        print("変更なし。終了。")
        return 0

    if not args.apply:
        print("(dry-run) --apply を付けると実適用します。")
        return 0

    print("[3/3] saveapp ...", flush=True)
    result = post_save_app(app_id, args.app_name, app, cookie)
    print(
        f"OK: Success={result.get('Success')}  Error={result.get('ErrorDescription')}"
    )

    # Verify
    print()
    print("Verify (re-fetching app) ...")
    fresh = fetch_load_app(args.app_name, cookie)
    for entry in config:
        control = find_control(fresh, entry["view_name"])
        current = (control.get("ViewDefinition") or {}).get("ColumnOrder") or []
        ok_count = sum(1 for c in entry["new_columns"] if c in current)
        print(
            f"  [{entry['view_name']}] new cols verified: {ok_count}/{len(entry['new_columns'])}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
