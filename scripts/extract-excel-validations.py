"""リタリコ Excel マスタの Data Validation（プルダウン選択肢）を抽出。

各セルの Validation.Type = 3 (xlValidateList) を対象に、
A 列ラベル + B 列の値 + Validation.Formula1 を CSV で出力。
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import win32com.client  # type: ignore[import]

sys.stdout.reconfigure(encoding="utf-8")

EXCEL_DIR = Path("C:/dev/ainotudoi/Excelマスタ")
OUT_DIR = Path("C:/dev/ainotudoi/scripts/excel-validation-output")
OUT_DIR.mkdir(parents=True, exist_ok=True)

TARGET_FILES = [
    "令和8年6月_障害児入所支援.xls",
    "令和8年6月_短期入所.xls",
    "令和8年6月_日中一時支援.xls",
]


def resolve_formula(formula: str, wb) -> list[str]:
    """Validation.Formula1 を解決。直接リスト or 名前範囲 or セル範囲。"""
    if not formula:
        return []
    f = formula.lstrip("=")
    # ケース 1: ="あ,い,う" 形式（カンマ区切り直接リスト）
    if "," in f and not any(c in f for c in "!$:"):
        return [v.strip().strip('"') for v in f.split(",") if v.strip()]
    # ケース 2: 範囲参照（例 =Sheet2!$A$1:$A$10）
    if "!" in f or "$" in f:
        try:
            rng = wb.Application.Range(f)
            vals = []
            for v in rng.Value:
                if isinstance(v, tuple):
                    vals.extend(str(x).strip() for x in v if x is not None)
                elif v is not None:
                    vals.append(str(v).strip())
            return [v for v in vals if v]
        except Exception:
            return [f]
    # ケース 3: 名前範囲
    try:
        rng = wb.Application.Range(f)
        vals = []
        for v in rng.Value:
            if isinstance(v, tuple):
                vals.extend(str(x).strip() for x in v if x is not None)
            elif v is not None:
                vals.append(str(v).strip())
        return [v for v in vals if v]
    except Exception:
        return [f]


def extract(xlapp, file_path: Path, out_csv: Path) -> None:
    print(f"\n=== {file_path.name} ===")
    wb = xlapp.Workbooks.Open(str(file_path.resolve()), ReadOnly=True)
    try:
        rows: list[dict] = []
        for ws in wb.Worksheets:
            sheet_name = ws.Name
            used = ws.UsedRange
            max_row = used.Rows.Count
            max_col = used.Columns.Count
            print(f"  Sheet '{sheet_name}': {max_row} x {max_col}")

            # 各セルの Validation を確認
            for r in range(1, max_row + 1):
                # 行のラベル(A 列)を取得
                a_label = ""
                try:
                    a_label = str(ws.Cells(r, 1).Value or "")
                except Exception:
                    pass
                for c in range(1, max_col + 1):
                    try:
                        cell = ws.Cells(r, c)
                        v = cell.Validation
                        if v.Type == 3:  # xlValidateList
                            f1 = v.Formula1 or ""
                            choices = resolve_formula(f1, wb)
                            current_value = ""
                            try:
                                current_value = str(cell.Value or "")
                            except Exception:
                                pass
                            rows.append({
                                "sheet": sheet_name,
                                "row": r,
                                "col": c,
                                "address": cell.Address,
                                "label_in_A": a_label[:120],
                                "current_value": current_value[:80],
                                "validation_formula": f1[:200],
                                "choices_count": len(choices),
                                "choices": " / ".join(choices),
                            })
                    except Exception:
                        continue
        print(f"  Total validation cells: {len(rows)}")
    finally:
        wb.Close(SaveChanges=False)

    if rows:
        with out_csv.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"  Saved: {out_csv}")


def main() -> int:
    xlapp = win32com.client.Dispatch("Excel.Application")
    xlapp.Visible = False
    xlapp.DisplayAlerts = False
    try:
        for fname in TARGET_FILES:
            fpath = EXCEL_DIR / fname
            if not fpath.exists():
                print(f"SKIP: {fpath} not found")
                continue
            out_csv = OUT_DIR / f"{fpath.stem}_validations.csv"
            extract(xlapp, fpath, out_csv)
    finally:
        xlapp.Quit()
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
