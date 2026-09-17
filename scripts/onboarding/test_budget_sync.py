#!/usr/bin/env python3
"""
Tests for the budget sync's expense side.

Plain assertions, no pytest — it is not installed and this repo has no test
suite to hang one off. Every test builds its own workbook in a temp directory,
so nothing here touches OneDrive, the real data workbook, or the network.

Run:
    python3 scripts/onboarding/test_budget_sync.py
"""

import sys
import tempfile
import traceback
from datetime import date
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))

import budget_sync as bs  # noqa: E402
from build_v2 import EXPENSE_COLS, INCOME_COLS  # noqa: E402

TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


def fixture_workbook(tmp, expenses=None, incomes=None):
    """
    A minimal data workbook with the sheets budget_sync reads.

    Vendors and categories are invented. This repository is public, so no
    fixture ever carries a real name.
    """
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for sheet, cols, rows in (
        ("Incomes", INCOME_COLS, incomes or []),
        ("Expenses", EXPENSE_COLS, expenses or []),
    ):
        ws = wb.create_sheet(sheet)
        for i, (name, _width) in enumerate(cols, start=1):
            ws.cell(1, i, name)
        for r, row in enumerate(rows, start=2):
            for c, value in enumerate(row, start=1):
                ws.cell(r, c, value)
    path = tmp / "FRC Data test.xlsx"
    wb.save(path)
    return path


@test
def test_dump_sheet_reports_header_and_rows():
    import io
    from contextlib import redirect_stdout

    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=[
            [date(2026, 8, 1), "Acme Parts", "Robot parts", 120.5, "team card", "INV-1", "", ""],
        ])
        buf = io.StringIO()
        with redirect_stdout(buf):
            bs.dump_sheet(path, "Expenses")
        out = buf.getvalue()
        assert "Expenses" in out, out
        assert "'Vendor'" in out, "header cells should be printed with repr"
        assert "Acme Parts" in out, "first data row should be printed"
        assert "8 columns" in out, f"expected the column count, got:\n{out}"


@test
def test_read_expenses_roundtrips_values_and_order():
    rows_in = [
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 120.5, "team card", "INV-1", "", ""],
        [date(2026, 8, 9), "Bolt Supply", "Raw materials", 40.0, "team card", "INV-2", "", "rush"],
    ]
    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=rows_in)
        wb = openpyxl.load_workbook(path, data_only=True)
        got = bs.read_expenses(wb)
    assert len(got) == 2, got
    assert [r[1] for r in got] == ["Acme Parts", "Bolt Supply"], "order must be preserved"
    assert got[0][3] == 120.5
    assert all(len(r) == len(EXPENSE_COLS) for r in got), "rows pad to the spec width"


@test
def test_read_expenses_skips_blank_rows_and_missing_sheet():
    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=[
            [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "", ""],
            [None, None, None, None, None, None, None, None],
        ])
        wb = openpyxl.load_workbook(path, data_only=True)
        assert len(bs.read_expenses(wb)) == 1
        del wb["Expenses"]
        assert bs.read_expenses(wb) == [], "a missing sheet is empty, not an error"


@test
def test_expense_ids_present_ignores_hand_entered_rows():
    rows = [
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "EXP-1", ""],
        [date(2026, 8, 2), "Bolt Supply", "Raw materials", 20.0, "", "", "", ""],
        [date(2026, 8, 3), "Cog Co", "Tools", 30.0, "", "", "  EXP-2  ", ""],
    ]
    assert bs.expense_ids_present(rows) == {"EXP-1", "EXP-2"}, bs.expense_ids_present(rows)


@test
def test_overwide_rows_are_detected():
    narrow = [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "", ""]
    wide = narrow + ["stray value"]
    assert bs.overwide_expense_rows([narrow]) == []
    assert bs.overwide_expense_rows([narrow, wide]) == [3], "1-based sheet row, header is row 1"


def main():
    failed = 0
    for fn in TESTS:
        try:
            fn()
            print(f"  ok    {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {exc}")
        except Exception:
            failed += 1
            print(f"  ERROR {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
