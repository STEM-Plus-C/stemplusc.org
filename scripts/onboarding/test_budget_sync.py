#!/usr/bin/env python3
"""
Tests for the budget sync's expense side.

Plain assertions, no pytest — it is not installed and this repo has no test
suite to hang one off. Every test builds its own workbook in a temp directory,
so nothing here touches OneDrive, the real data workbook, or the network.

Run:
    python3 scripts/onboarding/test_budget_sync.py
"""

import io
import sys
import tempfile
import traceback
from contextlib import contextmanager, redirect_stdout
from datetime import date, datetime
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))

import budget_sync as bs  # noqa: E402
import build_v2  # noqa: E402
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
    # The padding branch itself rarely fires on real openpyxl input — the
    # sheet's bounding box already supplies width 8 here — but the contract
    # callers rely on is the output width, not how it got there.
    assert all(len(r) == 8 for r in got), "every returned row is exactly the spec width"


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
    # openpyxl pads every row it returns to the sheet's widest row, so the
    # only reliable way to find the one overwide row is to read the actual
    # worksheet — and a blank row ahead of the offender proves the result is
    # a real (1-based) sheet row number, not an index into some filtered list.
    normal = [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "", ""]
    blank = [None] * 8
    offender = [date(2026, 8, 3), "Cog Co", "Tools", 30.0, "", "", "", "", "stray value"]
    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=[normal, blank, offender, normal])
        wb = openpyxl.load_workbook(path, data_only=True)
        got = bs.overwide_expense_rows(wb["Expenses"])
    assert got == [4], f"expected only the offending sheet row, got {got}"

    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=[normal, normal])
        wb = openpyxl.load_workbook(path, data_only=True)
        assert bs.overwide_expense_rows(wb["Expenses"]) == []


@test
def test_norm_category_collapses_case_and_spacing_only():
    from build_v2 import norm_category
    assert norm_category("Robot parts") == norm_category("robot parts")
    assert norm_category("Robot  Parts") == norm_category("Robot Parts")
    assert norm_category("  Tools ") == "tools"
    assert norm_category(None) == ""
    # norm() splits on the first hyphen, which would truncate this to 'pre'.
    # A category is not a name and must not be treated like one.
    assert norm_category("Pre-season build") == "pre-season build"
    assert norm_category("Travel") != norm_category("Tools")


@test
def test_category_counts_tallies_non_blank_categories():
    rows = [
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "", ""],
        [date(2026, 8, 2), "Bolt Supply", "Robot parts", 20.0, "", "", "", ""],
        [date(2026, 8, 3), "Cog Co", "Tools", 30.0, "", "", "", ""],
        [date(2026, 8, 4), "Dial Ltd", "", 40.0, "", "", "", ""],
        [date(2026, 8, 5), "Edge Inc", "   ", 50.0, "", "", "", ""],
    ]
    counts = bs.category_counts(rows)
    assert dict(counts) == {"Robot parts": 2, "Tools": 1}, dict(counts)


@test
def test_category_variants_groups_spellings_and_ignores_clean_ones():
    from collections import Counter
    counts = Counter({"Robot parts": 18, "robot parts": 2, "Robot Parts": 1, "Travel": 7})
    groups = bs.category_variants(counts)
    assert len(groups) == 1, groups
    assert [name for name, _n in groups[0]] == ["Robot parts", "robot parts", "Robot Parts"], groups[0]
    assert groups[0][0] == ("Robot parts", 18), "most-used spelling leads"


@test
def test_expense_report_states_total_categories_and_drift():
    rows = [
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 100.0, "", "", "", ""],
        [date(2026, 8, 2), "Bolt Supply", "robot parts", 50.5, "", "", "", ""],
        [date(2026, 8, 3), "Cog Co", "Tools", 20.0, "", "", "", ""],
    ]
    text = "\n".join(bs.expense_report(rows))
    assert "3 row(s)" in text, text
    assert "$170.50" in text, text
    assert "3 distinct" in text, (
        "three spellings are listed below the header, so three are counted; "
        "it's the duplicates section below that reveals two of them are one category"
    )
    assert "Possible duplicates" in text, text
    assert "'Robot parts' (1)" in text and "'robot parts' (1)" in text, text


@test
def test_expense_report_is_quiet_when_there_is_nothing_to_say():
    text = "\n".join(bs.expense_report([]))
    assert "0 row(s)" in text, text
    assert "Possible duplicates" not in text
    assert "Categories" not in text


@test
def test_expense_report_flags_rows_wider_than_the_spec():
    # overwide_expense_rows reads the worksheet, not expense_rows (see its
    # docstring), so expense_report takes the result as a parameter rather
    # than recomputing it -- callers pass in the physical sheet row numbers
    # they already have.
    wide = [date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", "", "stray"]
    text = "\n".join(bs.expense_report([wide], overwide=[2]))
    assert "more columns than the spec" in text, text
    assert "row 2" in text, text


@test
def test_hand_typed_amounts_and_categories_do_not_crash_the_run():
    """
    A review finding, and a robustness regression against main.

    Before this branch Expenses sat in PRESERVED and nothing read it, so a
    stray cell on the one sheet people type into could not hurt anything.
    Then category_counts did `(r[2] or "").strip()` and expense_report did
    `float(r[3] or 0)`, and each of the four cells below killed the whole run
    with a traceback -- after the Roster and Incomes lines, before any
    expense report, drift report, missing-id report or refusal, and on a
    --commit run after the backup had already been taken. Every one of them
    is a plausible thing to type into a sheet fed by receipts.
    """
    # Category as a number: 2026 arrives as an int, and int has no .strip().
    assert dict(bs.category_counts([[None, "Acme Parts", 2026, 10.0, "", "", "", ""]])) == {
        "2026": 1
    }, "a numeric category is a category, not an AttributeError"

    assert bs.parse_amount(120.5) == 120.5
    assert bs.parse_amount(40) == 40.0
    assert bs.parse_amount("40.25") == 40.25, "a bare numeric string reads the same everywhere"
    # Whitespace is an empty cell someone's cursor landed in, and `or 0` has
    # always counted an empty Amount as zero. Not a parse failure.
    assert bs.parse_amount("   ") == 0.0
    assert bs.parse_amount(None) == 0.0
    assert bs.parse_amount("") == 0.0
    # Not coerced on purpose: see parse_amount's docstring. Reading '$1,200.00'
    # as 1200 here while Excel still holds text would make this total right
    # and the front page's total wrong.
    assert bs.parse_amount("$1,200.00") is None
    assert bs.parse_amount("n/a") is None

    rows = [
        [date(2026, 8, 1), "Acme Parts", "Tools", 100.0, "", "", "", ""],
        [date(2026, 8, 2), "Bolt Supply", "Tools", "   ", "", "", "", ""],
        [date(2026, 8, 3), "Cog Co", "Tools", "$1,200.00", "", "", "", ""],
        [date(2026, 8, 4), "Dial Ltd", 2026, "n/a", "", "", "", ""],
        [date(2026, 8, 5), "Edge Inc", "Travel", 20.5, "", "", "", ""],
    ]
    with tempfile.TemporaryDirectory() as td:
        path = fixture_workbook(Path(td), expenses=rows)
        wb = openpyxl.load_workbook(path, data_only=True)
        unreadable = bs.unreadable_amount_rows(wb["Expenses"])
    # Physical sheet rows, as the over-wide list is: '$1,200.00' on sheet row
    # 4 and 'n/a' on sheet row 5. The whitespace row is not in the list.
    assert unreadable == [4, 5], unreadable

    text = "\n".join(bs.expense_report(rows, unreadable=unreadable))
    assert "5 row(s), $120.50" in text, (
        f"the total must be the amounts that parse, nothing guessed:\n{text}"
    )
    assert "2 row(s) not counted" in text, f"the total must say it is short:\n{text}"
    assert "row 4, 5" in text, f"and name the rows to retype:\n{text}"

    # And with nothing odd in it, the total is still simply right.
    clean = [
        [date(2026, 8, 1), "Acme Parts", "Tools", 100.0, "", "", "", ""],
        [date(2026, 8, 2), "Bolt Supply", "Travel", 50.5, "", "", "", ""],
    ]
    clean_text = "\n".join(bs.expense_report(clean))
    assert "2 row(s), $150.50" in clean_text, clean_text
    assert "not counted" not in clean_text, clean_text


@test
def test_build_writes_expense_number_formats():
    """
    A review finding: deleting both .number_format assignments in build()'s
    Expenses block leaves every other test green, yet formats are half the
    stated reason Expenses graduated out of PRESERVED. Pin them down.

    Asserted after a save and a reload, not on the in-memory workbook: what
    matters is the format an operator opens the file to, and a format that is
    set on a cell object but lost in serialization would pass the in-memory
    check while the sheet on disk still shows a bare 10.
    """
    rows = [[date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", ""]]
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "formats.xlsx"
        bs.build({}, [], rows).save(out)
        ws = openpyxl.load_workbook(out)["Expenses"]
        assert ws.cell(2, 1).number_format == "yyyy-mm-dd", ws.cell(2, 1).number_format
        assert ws.cell(2, 4).number_format == '"$"#,##0.00', ws.cell(2, 4).number_format


@test
def test_refuses_a_first_build_that_would_drop_v1_expenses():
    """
    Removing Expenses from PRESERVED broke the --from seed path: on a first
    build `out` does not exist, so expense_rows is empty and v1's hand-typed
    expense rows would land nowhere, silently -- asymmetric with Incomes,
    which has an explicit seeding block. There is no seed block for
    Expenses (the live sheet's column shape is unknown), so the only correct
    move is to refuse and point at --dump-sheet.
    """
    with tempfile.TemporaryDirectory() as td:
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        ws = wb.create_sheet("Expenses")
        ws.append([name for name, _width in EXPENSE_COLS])
        ws.append([date(2026, 8, 1), "Acme Parts", "Robot parts", 100.0, "", "", "", ""])
        v1_path = str(Path(td) / "v1.xlsx")
        wb.save(v1_path)

        refusal = bs.v1_expenses_refusal(v1_path, [])
        text = "\n".join(refusal)
        assert "1 expense row" in text, text
        assert "this build would drop" in text, text
        assert "--dump-sheet Expenses" in text, text
        assert v1_path in text, text

        # Not a first build -- expense_rows already has something -- so
        # there is nothing to silently drop.
        already_has_rows = [[date(2026, 8, 1), "Vendor", "Cat", 1.0, "", "", "", ""]]
        assert bs.v1_expenses_refusal(v1_path, already_has_rows) == []
        # No --from at all: nothing to seed from, nothing to refuse.
        assert bs.v1_expenses_refusal(None, []) == []

    # Review finding: a sheet can carry rows past the header that openpyxl's
    # max_row counts but that hold no expense data at all -- a border
    # applied to a range, a stray formatted-but-empty cell. Counting via
    # max_row said "5 expense row(s)" for a sheet with none; the fix is to
    # count what read_expenses() actually returns, which already treats an
    # all-blank row as not a row.
    from openpyxl.styles import Border, Side

    with tempfile.TemporaryDirectory() as td:
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        ws = wb.create_sheet("Expenses")
        ws.append([name for name, _width in EXPENSE_COLS])
        thin = Border(left=Side(style="thin"))
        for r in range(2, 7):
            for c in range(1, len(EXPENSE_COLS) + 1):
                ws.cell(r, c).border = thin
        bordered_path = str(Path(td) / "v1-bordered.xlsx")
        wb.save(bordered_path)

        assert bs.v1_expenses_refusal(bordered_path, []) == [], (
            "styling with no values is not an expense row; a real --from "
            "first build must not be blocked over formatting alone"
        )


def cell_equal(before, after):
    """
    Compare a written cell with the one read back.

    openpyxl writes '' as an empty cell and reads it back as None, so a strict
    == would fail on every blank a person left blank. Both spellings mean
    empty. 0 is not empty and is compared normally.
    """
    if before in (None, "") and after in (None, ""):
        return True
    # A date-formatted cell always reads back as `datetime`, even one written
    # as a plain `date` — verified against actual openpyxl output, not
    # assumed. That is a serialization detail, not a changed value.
    if isinstance(before, date) and isinstance(after, datetime):
        return before == after.date()
    return before == after


@test
def test_hand_entered_rows_survive_a_rebuild_unchanged():
    """The whole point. A sync must not alter a row a person typed."""
    rows_in = [
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 120.5, "team card", "INV-1", "", "left as typed"],
        [date(2026, 8, 9), "Bolt Supply", "raw materials", 40.0, "R. Coach", "INV-2", "", ""],
    ]
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "rebuilt.xlsx"
        bs.build({}, [], rows_in).save(out)
        reread = bs.read_expenses(openpyxl.load_workbook(out, data_only=True))
    assert len(reread) == 2, reread
    for before, after in zip(rows_in, reread):
        for i, (name, _width) in enumerate(EXPENSE_COLS):
            assert cell_equal(before[i], after[i]), (
                f"{name} changed: {before[i]!r} -> {after[i]!r}"
            )


@test
def test_build_writes_a_categories_sheet_ordered_by_use():
    rows = [
        [date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", ""],
        [date(2026, 8, 2), "Bolt Supply", "Robot parts", 20.0, "", "", "", ""],
        [date(2026, 8, 3), "Cog Co", "Robot parts", 30.0, "", "", "", ""],
    ]
    wb = bs.build({}, [], rows)
    assert "Categories" in wb.sheetnames, wb.sheetnames
    ws = wb["Categories"]
    assert [ws.cell(r, 1).value for r in (2, 3)] == ["Robot parts", "Tools"], "most-used first"
    assert [ws.cell(r, 2).value for r in (2, 3)] == [2, 1]


@test
def test_dropdown_covers_the_category_column_and_does_not_forbid_new_values():
    """
    Asserted on the reopened workbook, which is what the spec's test 6 names.

    A DataValidation attached to an in-memory worksheet proves the object was
    built, not that Excel will ever see it — the validation has to survive
    serialization to be a dropdown at all.
    """
    rows = [[date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", ""]]
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "dropdown.xlsx"
        bs.build({}, [], rows).save(out)
        wb = openpyxl.load_workbook(out)
    dvs = list(wb["Expenses"].data_validations.dataValidation)
    assert len(dvs) == 1, f"expected one validation, got {len(dvs)}"
    dv = dvs[0]
    assert dv.type == "list"
    assert f"C2:C{bs.CATEGORY_VALIDATION_ROWS}" in str(dv.sqref), str(dv.sqref)
    assert not dv.showErrorMessage, "a new category must not be rejected"
    assert dv.allow_blank, "a blank category must stay allowed"
    assert "Categories" in dv.formula1, dv.formula1
    # showDropDown is inverted in OOXML: true SUPPRESSES the in-cell arrow.
    assert dv.showDropDown in (None, False), (
        f"showDropDown={dv.showDropDown!r} would hide the arrow in Excel"
    )


@test
def test_no_dropdown_when_there_are_no_categories_yet():
    wb = bs.build({}, [], [])
    assert list(wb["Expenses"].data_validations.dataValidation) == [], "empty range is invalid in Excel"


@test
def test_expenses_is_no_longer_blindly_preserved():
    assert "Expenses" not in bs.PRESERVED, (
        "PRESERVED does a values-only copy, which destroys the dropdown and formats"
    )
    assert "Zeffy Map" in bs.PRESERVED and "Sponsors" in bs.PRESERVED


@test
def test_the_script_never_names_the_analysis_workbook():
    """
    An invariant guard, not a behavioural test.

    A behavioural test would need to actually load the analysis workbook to
    prove this script never touches it, and that workbook holds roster data
    that cannot live in a public repo. So this checks the one thing that can
    be checked without one: no *code path* names the file.

    Parsed with ast rather than grepped as raw text, because the filename
    belongs in the documentation — the module docstring's two-file table
    exists specifically to say which file is which — and only a reference
    reachable from running code (a string literal outside a docstring) is
    the defect this guards against. Docstrings are collected first and
    excluded; comments never appear in the AST at all, so they are exempt
    automatically, which is correct for the same reason.

    Scoped to budget_sync.py alone, deliberately, even though it imports
    fourteen names from build_v2: this guards the module that actually opens
    workbooks, and widening it to the import graph would assert over
    build_v2's own callers, which have nothing to do with this script's
    promise never to open the analysis workbook.
    """
    import ast

    src = (Path(__file__).resolve().parent / "budget_sync.py").read_text()
    tree = ast.parse(src)

    docstring_ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            doc_node = node.body[0] if node.body else None
            if (
                isinstance(doc_node, ast.Expr)
                and isinstance(doc_node.value, ast.Constant)
                and isinstance(doc_node.value.value, str)
            ):
                docstring_ids.add(id(doc_node.value))

    offenders = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and "FRC Budget" in node.value
        and id(node) not in docstring_ids
    ]
    assert not offenders, [
        f"line {n.lineno}: {n.value!r}" for n in offenders
    ]


# --------------------------------------------------- driving main() end to end
#
# An earlier round recorded that main() could not be tested because doing so
# needs a roster, and a roster cannot live in a public repo. That was wrong.
# The roster is a flag, not a fixture: a two-column CSV holding one invented
# name satisfies it. The only things main() reaches for by module constant are
# the data workbook and the onboarding ledger, and both can be redirected. So
# the four properties nothing else covers -- a dry run writes nothing, a commit
# leaves a backup, and each new refusal actually exits 1 -- are testable after
# all, with no real roster, no ledger and no network.


def write_roster_csv(tmp):
    """
    A two-column roster holding one invented student.

    Two columns because these tests are about what main() writes, not about
    contact fields; every other column is optional. The name is invented --
    this repository is public and no fixture carries a real one.
    """
    path = tmp / "roster.csv"
    path.write_text("Student,Participant ID\nRiver Testcase,TDS-27-901\n", encoding="utf-8")
    return path


@contextmanager
def module_pointed_at(tmp):
    """
    Redirect budget_sync's module-level paths into a temp directory.

    load_ledger_ids is stubbed in *both* modules that look it up: budget_sync
    imported it by name, and build_v2.collect_students calls its own global on
    the --from path. Patching only one leaves a test reading the real ledger
    on whichever machine happens to have one.
    """
    saved = (bs.DATA_BOOK, bs.LEDGER_PATH, bs.load_ledger_ids, build_v2.load_ledger_ids)
    bs.DATA_BOOK = tmp / "FRC Data test.xlsx"
    bs.LEDGER_PATH = tmp / "no-such-ledger.json"
    bs.load_ledger_ids = build_v2.load_ledger_ids = lambda *a, **k: {}
    try:
        yield
    finally:
        bs.DATA_BOOK, bs.LEDGER_PATH, bs.load_ledger_ids, build_v2.load_ledger_ids = saved


def run_main(argv):
    """Run main() with these flags; return (exit code, captured stdout)."""
    buf = io.StringIO()
    saved_argv = sys.argv
    sys.argv = ["budget_sync.py", *argv]
    try:
        with redirect_stdout(buf):
            try:
                bs.main()
                code = 0
            except SystemExit as exc:
                code = 0 if exc.code is None else exc.code
    finally:
        sys.argv = saved_argv
    return code, buf.getvalue()


TYPED_EXPENSE = [
    date(2026, 8, 1), "Acme Parts", "Robot parts", 120.5, "team card", "INV-1", "", "as typed",
]


@test
def test_a_dry_run_leaves_the_workbook_byte_for_byte_unchanged():
    """
    The headline safety property after row preservation, and the spec's second
    acceptance criterion. Dry run is the default, so this is what an operator
    gets when they forget --commit.

    Bytes rather than mtime: a rebuild that happened to land on the same
    modification time would still have rewritten every row on the sheet.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        out = fixture_workbook(tmp, expenses=[TYPED_EXPENSE])
        csv_path = write_roster_csv(tmp)
        before_bytes = out.read_bytes()
        before_files = sorted(p.name for p in tmp.iterdir())

        with module_pointed_at(tmp):
            code, text = run_main(["--roster-csv", str(csv_path), "--out", str(out)])

        assert code == 0, f"exit {code}:\n{text}"
        assert "dry run" in text, text
        assert "Wrote" not in text, text
        assert out.read_bytes() == before_bytes, "a dry run rewrote the data workbook"
        assert sorted(p.name for p in tmp.iterdir()) == before_files, (
            "a dry run created a file — no backup, no temp, nothing"
        )


@test
def test_a_commit_leaves_exactly_one_backup_beside_the_workbook():
    """
    The spec's fourth acceptance criterion. The backup is the only thing
    standing between a bad rebuild and a season of hand-typed rows, so its
    absence has to fail a test rather than be noticed afterwards.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        out = fixture_workbook(tmp, expenses=[TYPED_EXPENSE])
        csv_path = write_roster_csv(tmp)
        before_bytes = out.read_bytes()
        before_files = {p.name for p in tmp.iterdir()}

        with module_pointed_at(tmp):
            code, text = run_main(
                ["--roster-csv", str(csv_path), "--out", str(out), "--commit"]
            )

        assert code == 0, f"exit {code}:\n{text}"
        assert "Backed up to" in text, text
        assert out.read_bytes() != before_bytes, "--commit did not rewrite the workbook"
        new = sorted(p.name for p in tmp.iterdir() if p.name not in before_files)
        assert len(new) == 1, f"expected one new file, got {new}"
        assert ".backup-" in new[0] and new[0].endswith(".xlsx"), new[0]

        # And the row a person typed is still there, through main() rather
        # than through build() directly.
        reread = bs.read_expenses(openpyxl.load_workbook(out, data_only=True))
        assert len(reread) == 1 and reread[0][1] == "Acme Parts", reread


@test
def test_the_overwide_refusal_exits_1_and_writes_nothing():
    """
    The refusal is only worth anything if it actually stops the write. The
    predicate is tested above; this tests the wiring -- exit code and, more
    importantly, that nothing reached the disk, not even the backup.
    """
    wide = [date(2026, 8, 3), "Cog Co", "Tools", 30.0, "", "", "", "", "stray value"]
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        out = fixture_workbook(tmp, expenses=[TYPED_EXPENSE, wide])
        csv_path = write_roster_csv(tmp)
        before_bytes = out.read_bytes()
        before_files = sorted(p.name for p in tmp.iterdir())

        with module_pointed_at(tmp):
            code, text = run_main(
                ["--roster-csv", str(csv_path), "--out", str(out), "--commit"]
            )

        assert code == 1, f"expected exit 1, got {code}:\n{text}"
        assert "Refusing to write" in text, text
        assert "Backed up to" not in text, "refused after taking a backup"
        assert out.read_bytes() == before_bytes
        assert sorted(p.name for p in tmp.iterdir()) == before_files, "a refusal left a file behind"


@test
def test_the_unreadable_amount_refusal_exits_1_and_writes_nothing():
    """
    The third refusal, added with parse_amount, gets the same wiring check as
    the other two: removing its sys.exit(1) has to fail a test rather than
    quietly let a short total reach the front page.
    """
    pasted = [date(2026, 8, 2), "Bolt Supply", "Tools", "$1,200.00", "", "", "", ""]
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        out = fixture_workbook(tmp, expenses=[TYPED_EXPENSE, pasted])
        csv_path = write_roster_csv(tmp)
        before_bytes = out.read_bytes()
        before_files = sorted(p.name for p in tmp.iterdir())

        with module_pointed_at(tmp):
            code, text = run_main(
                ["--roster-csv", str(csv_path), "--out", str(out), "--commit"]
            )

        assert code == 1, f"expected exit 1, got {code}:\n{text}"
        assert "Amount that is not a number" in text, text
        # The report still ran: the operator is told which row to retype, and
        # the total says it is short, before anything refuses.
        assert "row 3" in text, text
        assert "1 row(s) not counted" in text, text
        assert "Backed up to" not in text, "refused after taking a backup"
        assert out.read_bytes() == before_bytes
        assert sorted(p.name for p in tmp.iterdir()) == before_files, "a refusal left a file behind"


@test
def test_the_v1_expenses_refusal_exits_1_and_writes_nothing():
    """
    Same wiring check for the other new refusal. This one is reached on a
    --from first build, where the output workbook does not exist yet -- so
    "writes nothing" means the file is still not there afterwards.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1 = tmp / "v1.xlsx"
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        # collect_students reads v1's Incomes sheet, and main's seed block
        # reads it again; a header alone is enough for both.
        inc = wb.create_sheet("Incomes")
        inc.append([name for name, _width in INCOME_COLS])
        exp = wb.create_sheet("Expenses")
        exp.append([name for name, _width in EXPENSE_COLS])
        exp.append([date(2026, 8, 1), "Acme Parts", "Robot parts", 100.0, "", "", "", ""])
        wb.save(v1)

        out = tmp / "first-build.xlsx"
        csv_path = write_roster_csv(tmp)
        before_files = sorted(p.name for p in tmp.iterdir())

        with module_pointed_at(tmp):
            code, text = run_main(
                ["--roster-csv", str(csv_path), "--from", str(v1),
                 "--out", str(out), "--commit"]
            )

        assert code == 1, f"expected exit 1, got {code}:\n{text}"
        assert "1 expense row(s) that this build would drop" in text, text
        assert "--dump-sheet Expenses" in text, text
        assert not out.exists(), "refused, and yet wrote the workbook"
        assert sorted(p.name for p in tmp.iterdir()) == before_files, "a refusal left a file behind"


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
