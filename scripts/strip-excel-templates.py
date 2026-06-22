"""リタリコ Excel マスタからサンプル値を除去してテンプレ化。

入力: c:/dev/ainotudoi/Excelマスタ/令和8年6月_*.xls (5 ファイル)
出力: c:/dev/ainotudoi/Excelマスタ/templates/テンプレ_*.xlsx

除去対象（クリア）:
  - 利用者情報セクション B 列（氏名/カナ/番号/住所/上限額 等）
  - 日次データ各列（曜日列を除く）の値

保持:
  - A 列ラベル（GAS が検索キーに使う）
  - 暦日 1〜31 の数字
  - 曜日列の数式
  - Data Validation（ドロップダウン）
  - シート名（GAS が getSheetByName で参照）
  - 事業所情報セクションのラベル
"""
from __future__ import annotations

import sys
from pathlib import Path

import win32com.client  # type: ignore

sys.stdout.reconfigure(encoding="utf-8")

EXCEL_DIR = Path("C:/dev/ainotudoi/Excelマスタ")
OUT_DIR = EXCEL_DIR / "templates"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 入力ファイル → 出力名のマッピング
FILES = {
    "令和8年6月_計画相談支援.xls": "テンプレ_計画相談支援_R8_6.xlsx",
    "令和8年6月_障害児相談支援.xls": "テンプレ_障害児相談支援_R8_6.xlsx",
    "令和8年6月_障害児入所支援.xls": "テンプレ_児童入所施設_R8_6.xlsx",
    "令和8年6月_短期入所.xls": "テンプレ_短期入所_R8_6.xlsx",
    "令和8年6月_日中一時支援.xls": "テンプレ_日中一時支援_R8_6.xlsx",
}

# クリア対象のラベルキーワード（A 列で見つけたら B 列をクリア）
USER_INFO_LABELS = {
    "氏名", "氏名カナ", "ふりがな", "保護者氏名", "保護者氏名カナ",
    "児童氏名", "児童氏名カナ",
    "受給者証番号", "支給市町村", "市町村番号",
    "利用者負担上限額", "上限額管理事業所番号", "上限額管理事業所名", "上限額管理結果",
    "契約記入欄番号", "契約支給量開始日", "契約支給量終了日",
    "事業所番号", "事業所名", "代表者役職", "代表者氏名",
    "請求担当者役職", "請求担当者氏名",
}

# 日次データセクションの「日」ヘッダーを検出するキー
DAILY_HEADER_KEY = "日"
DAILY_WEEKDAY_KEY = "曜日"


def find_daily_header_row(ws) -> int:
    """A 列 == '日' かつ B 列 == '曜日' な行を返す（1-based）。なければ -1。"""
    used = ws.UsedRange
    max_row = min(used.Rows.Count, 200)
    for r in range(1, max_row + 1):
        a = str(ws.Cells(r, 1).Value or "").strip()
        b = str(ws.Cells(r, 2).Value or "").strip()
        if a == DAILY_HEADER_KEY and b == DAILY_WEEKDAY_KEY:
            return r
    return -1


def clear_user_info_b_column(ws, header_row: int) -> int:
    """A 列で USER_INFO_LABELS を見つけたら B 列をクリア。利用者情報セクション内のみ。"""
    cleared = 0
    used = ws.UsedRange
    max_row = min(used.Rows.Count, header_row if header_row > 0 else 200)
    for r in range(1, max_row + 1):
        a = str(ws.Cells(r, 1).Value or "").strip()
        if not a:
            continue
        if any(label in a for label in USER_INFO_LABELS):
            b_cell = ws.Cells(r, 2)
            if b_cell.Value is not None and b_cell.Value != "":
                try:
                    b_cell.Value = ""
                    cleared += 1
                except Exception:
                    # 結合セル等で値設定不可の場合はスキップ
                    pass
    return cleared


def clear_daily_data(ws, header_row: int) -> int:
    """日次データの C 列以降をクリア（A=日数字、B=曜日数式は保持）。"""
    if header_row < 0:
        return 0
    used = ws.UsedRange
    max_row = used.Rows.Count
    max_col = used.Columns.Count
    cleared = 0

    # ヘッダー行の直下から、A 列の値が空 or 数字でない行が現れるまでがデータ範囲
    for r in range(header_row + 1, max_row + 1):
        a_val = ws.Cells(r, 1).Value
        # 暦日行は A 列が 1〜31 の数字（数値 or 文字列）
        try:
            a_int = int(float(str(a_val))) if a_val is not None else None
        except (ValueError, TypeError):
            a_int = None
        if a_int is None or not (1 <= a_int <= 31):
            break  # 暦日行終了

        # C 列以降をクリア（D 列以降の加算データ・実費等）
        for c in range(3, max_col + 1):
            cell = ws.Cells(r, c)
            if cell.HasFormula:
                continue  # 数式は保持
            if cell.Value is not None and cell.Value != "":
                try:
                    cell.Value = ""
                    cleared += 1
                except Exception:
                    pass  # 結合セル等で失敗してもスキップ

    return cleared


def strip_file(xlapp, src: Path, dst: Path) -> dict:
    """1 ファイルをストリップして保存."""
    print(f"\n=== {src.name} → {dst.name} ===")

    # .xls を読み取り専用で開く（後で xlsx として保存）
    wb_src = xlapp.Workbooks.Open(str(src.resolve()), ReadOnly=True)
    try:
        # 最初のシートを取得（リタリコは通常 1 シート）
        ws = wb_src.Worksheets(1)
        sheet_name = ws.Name
        print(f"  Sheet: {sheet_name}")

        # まず xlsx として一時保存（同じ内容で形式変換）
        # xlOpenXMLWorkbook = 51
        tmp_path = dst.with_suffix(".tmp.xlsx")
        if tmp_path.exists():
            tmp_path.unlink()
        wb_src.SaveAs(str(tmp_path.resolve()), FileFormat=51)
    finally:
        wb_src.Close(SaveChanges=False)

    # 新規 xlsx を開き直してストリップ作業
    wb = xlapp.Workbooks.Open(str(tmp_path.resolve()))
    try:
        ws = wb.Worksheets(1)
        header_row = find_daily_header_row(ws)
        print(f"  Daily header row: {header_row}")

        # 全シートにわたって処理（複数利用者ブロックがある場合）
        cleared_user = clear_user_info_b_column(ws, header_row)
        cleared_daily = clear_daily_data(ws, header_row)
        print(f"  Cleared user info B cells: {cleared_user}")
        print(f"  Cleared daily data cells: {cleared_daily}")

        # 保存
        if dst.exists():
            dst.unlink()
        wb.SaveAs(str(dst.resolve()), FileFormat=51)
    finally:
        wb.Close(SaveChanges=False)
        # tmp 削除
        if tmp_path.exists():
            tmp_path.unlink()

    print(f"  Saved: {dst}")
    return {
        "src": src.name,
        "dst": dst.name,
        "header_row": header_row,
        "cleared_user": cleared_user,
        "cleared_daily": cleared_daily,
    }


def main() -> int:
    xlapp = win32com.client.Dispatch("Excel.Application")
    xlapp.Visible = False
    xlapp.DisplayAlerts = False
    try:
        results = []
        for src_name, dst_name in FILES.items():
            src = EXCEL_DIR / src_name
            dst = OUT_DIR / dst_name
            if not src.exists():
                print(f"SKIP: {src} not found")
                continue
            r = strip_file(xlapp, src, dst)
            results.append(r)
        print("\n=== Summary ===")
        for r in results:
            print(f"  {r['dst']:<40} cleared (user/daily): {r['cleared_user']}/{r['cleared_daily']}")
    finally:
        xlapp.Quit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
