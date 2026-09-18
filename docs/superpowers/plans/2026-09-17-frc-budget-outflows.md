# FRC Budget Outflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the season budget an expense side — a hand-entered `Expenses` sheet that a sync never destroys — and a front page that reads both halves.

**Architecture:** `Expenses` becomes the twin of the existing `Incomes` sheet in `FRC Data 2026-2027.xlsx`, under the same append-only contract: the script reads every existing row, rewrites it verbatim, and re-applies formatting it owns. Categories stay free text, with drift surfaced by a report and a dropdown regenerated from actual use. The analysis workbook (`FRC Budget 2026-2027.xlsx`) holds the charts and is never opened by tooling.

**Tech Stack:** Python 3.13, openpyxl 3.1.5, Excel Power Query (M). No pytest — tests are a plain-assert script.

**Spec:** [`scripts/onboarding/budget-outflows-design.md`](../../../scripts/onboarding/budget-outflows-design.md)

## Global Constraints

- **Dry run is the default.** Every command changes nothing unless `--commit` is passed. This matches `onboard.mjs` and the existing `budget_sync.py`.
- **`Incomes` and `Expenses` are append-only.** Never reorder, rewrite, or reformat a row a person typed. Rows without a generated id are hand-entered by definition.
- **The analysis workbook is never opened by tooling.** openpyxl destroys charts on write. Only `FRC Data 2026-2027.xlsx` is read or written.
- **Participant ids come from the ledger, never minted locally.** Unchanged by this work; do not add an id-minting path.
- **This repository is public on GitHub.** No student names, emails, phone numbers or roster data in code, tests, fixtures or commit messages. Fixtures use invented vendor and category names only.
- **Python ≥ 3.13, openpyxl 3.1.5.** pytest is **not** installed; do not add it as a dependency.
- **Run from the repo root** with `set -a; source .env; set +a` where env is needed.
- Money format is exactly `'"$"#,##0.00'`. Date format is exactly `"yyyy-mm-dd"`.
- **`~/Library/CloudStorage/OneDrive-STEM+C` is unreadable from the dev machine** (macOS TCC). Every check against a live workbook is run by the user. All tests in this plan run against fixtures in a temp directory and need no OneDrive access.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/onboarding/build_v2.py` | Shared column specs and text helpers. Gains `EXPENSE_COLS` and `norm_category()`. *(De facto the shared-constants module — `budget_sync.py` imports 18 names from it. Arguably misnamed; not restructured here.)* |
| `scripts/onboarding/budget_sync.py` | Reads the ledger/FIRST/Zeffy, writes the data workbook. Gains expense readers, the category report, the `Expenses` and `Categories` writers, and `--dump-sheet`. |
| `scripts/onboarding/test_budget_sync.py` | **New.** Plain-assert tests over fixture workbooks in a temp dir. |
| `scripts/onboarding/powerquery/Incomes.m` | **New.** Loads `Incomes` from the data workbook, typed. |
| `scripts/onboarding/powerquery/Expenses.m` | **New.** Loads `Expenses` from the data workbook, typed. |
| `scripts/onboarding/powerquery/README.md` | Gains loading and front-page instructions for the two new queries. |
| `scripts/onboarding/budget-outflows-design.md` | The spec. One line corrected in Task 3. |

---

### Task 1: `--dump-sheet`, a read-only look at the live workbook

The live `Expenses` sheet has only ever been copied blindly and cannot be inspected from this machine. Writing a migration against a guessed shape is how you destroy the rows you meant to keep. So the first deliverable reads and prints, and writes nothing.

**Files:**
- Modify: `scripts/onboarding/budget_sync.py` — add `dump_sheet()` after `carry_over()` (ends line 420); add the flag at `423-431`; add the early return after `out = Path(args.out)` (line 433)
- Create: `scripts/onboarding/test_budget_sync.py`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `dump_sheet(path: Path, name: str, limit: int = 8) -> None` — prints; exits non-zero via `sys.exit` if the workbook or sheet is missing. `fixture_workbook(tmp: Path, expenses=None, incomes=None) -> Path` in the test file, used by every later task.

- [ ] **Step 1: Write the failing test**

Create `scripts/onboarding/test_budget_sync.py`:

```python
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `ERROR test_dump_sheet_reports_header_and_rows` with `AttributeError: module 'budget_sync' has no attribute 'dump_sheet'`.

- [ ] **Step 3: Implement `dump_sheet`**

In `scripts/onboarding/budget_sync.py`, after `carry_over()` (which ends at line 420) and before the `# --- main ---` divider:

```python
def dump_sheet(path, name, limit=8):
    """
    Print a sheet's header and first rows. Reads only; writes nothing.

    This exists because the live workbook cannot be inspected from the machine
    the script is written on, and the Expenses sheet has only ever been copied
    blindly by `PRESERVED`. Guessing its shape and writing a migration against
    the guess is how you destroy the rows you were trying to keep.
    """
    if not path.exists():
        sys.exit(f"\nNo workbook at {path}\n")
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        print(f"\n{path}")
        print(f"Sheets: {', '.join(wb.sheetnames)}\n")
        if name not in wb.sheetnames:
            sys.exit(f"No sheet named {name!r}.\n")
        rows = []
        for row in wb[name].iter_rows(values_only=True):
            rows.append(row)
            if len(rows) > limit:
                break
        if not rows:
            print(f"{name} is empty.\n")
            return
        print(f"{name} — header ({len(rows[0])} columns):")
        for i, value in enumerate(rows[0], start=1):
            print(f"  {i:>2}  {value!r}")
        body = rows[1:]
        if body:
            print(f"\nFirst {len(body)} data row(s):")
            for row in body:
                print("  " + " | ".join("" if v is None else str(v)[:18] for v in row))
        print()
    finally:
        wb.close()
```

- [ ] **Step 4: Add the flag and the early return**

In `main()`, add after the `--commit` argument (line 430):

```python
    ap.add_argument("--dump-sheet", metavar="NAME",
                    help="print a sheet's shape and exit; reads only, writes nothing")
```

And immediately after `out = Path(args.out)` (line 433), before `students = gather(args)`:

```python
    # Before gather(), which needs a roster and exits without one. Inspecting a
    # workbook must not require knowing who is on the team.
    if args.dump_sheet:
        dump_sheet(out, args.dump_sheet)
        return
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `1 passed, 0 failed`.

- [ ] **Step 6: Confirm it is genuinely read-only**

Prove the dump cannot write, by checking the file it was pointed at is untouched:

```bash
python3 - <<'PY'
import sys, tempfile
from pathlib import Path
from datetime import date
sys.path.insert(0, "scripts/onboarding")
import budget_sync as bs
from test_budget_sync import fixture_workbook

with tempfile.TemporaryDirectory() as td:
    p = fixture_workbook(Path(td), expenses=[
        [date(2026, 8, 1), "Acme Parts", "Robot parts", 10.0, "", "", "", ""]])
    before = (p.stat().st_mtime_ns, p.stat().st_size)
    bs.dump_sheet(p, "Expenses")
    after = (p.stat().st_mtime_ns, p.stat().st_size)
    assert before == after, f"dump_sheet modified the workbook: {before} -> {after}"
    print("\nOK — workbook unchanged by dump_sheet")
PY
```

Expected: the dump output, then `OK — workbook unchanged by dump_sheet`.

Then confirm the early return sits above every write path:

Run: `grep -n "dump_sheet\|wb.save\|shutil.copy2" scripts/onboarding/budget_sync.py`

Expected: both `dump_sheet` references have **lower** line numbers than the single `wb.save(...)` and the `shutil.copy2(...)` backup.

- [ ] **Step 7: Commit**

```bash
git add scripts/onboarding/budget_sync.py scripts/onboarding/test_budget_sync.py
git commit -m "Look at a sheet before writing a migration against it

The Expenses sheet has only ever been copied blindly by PRESERVED, and
the workbook lives somewhere the dev machine cannot read. --dump-sheet
prints what is actually there and changes nothing, so the migration is
written against the real shape instead of a guess.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The expense column spec and its readers

**Files:**
- Modify: `scripts/onboarding/build_v2.py` — add `EXPENSE_COLS` after `INCOME_COLS` (ends line 387)
- Modify: `scripts/onboarding/budget_sync.py` — import it in the `from build_v2 import (...)` block at lines 64-82; add readers after `zeffy_ids_present()` (ends line 157)
- Modify: `scripts/onboarding/test_budget_sync.py`

**Interfaces:**
- Consumes: `fixture_workbook()` from Task 1
- Produces: `EXPENSE_COLS: list[tuple[str, int]]` (8 entries); `read_expenses(wb) -> list[list]` (each row padded to 8); `expense_ids_present(rows) -> set[str]`; `overwide_expense_rows(rows) -> list[int]` (1-based sheet row numbers)

- [ ] **Step 1: Write the failing tests**

Append to `scripts/onboarding/test_budget_sync.py`, above `def main()`:

```python
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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: the four new tests ERROR on `ImportError: cannot import name 'EXPENSE_COLS'`.

- [ ] **Step 3: Add `EXPENSE_COLS`**

In `scripts/onboarding/build_v2.py`, directly after the `INCOME_COLS` list (ends line 387):

```python
# The expense ledger's shape. Hand-entered, so the columns are the ones a
# person can fill from a receipt without looking anything up.
#
# Expense ID is the dedupe key and mirrors Incomes' Zeffy Payment ID: blank
# means a person typed this row, filled means a script put it there. Nothing
# fills it yet. It is here now because it is one column today and a retrofit
# across two hundred rows later.
#
# Receipt is the tie to evidence. A 501(c)(3) expense that cannot be traced to
# an invoice is a problem at audit, not at entry time.
#
# No Team column: this workbook is FRC only, the same way income sync separates
# the teams by Zeffy campaign rather than by a column.
EXPENSE_COLS = [
    ("Date", 12),
    ("Vendor", 22),
    ("Category", 18),
    ("Amount", 11),
    ("Paid By", 14),
    ("Receipt", 22),
    ("Expense ID", 38),
    ("Notes", 24),
]
```

- [ ] **Step 4: Import it and write the readers**

In `scripts/onboarding/budget_sync.py`, add `EXPENSE_COLS,` to the `from build_v2 import (` block (lines 64-82), keeping the list alphabetical — it goes immediately after `END_DATES,`.

Then, after `zeffy_ids_present()` (ends line 157):

```python
def read_expenses(wb):
    """
    Every expense row already recorded, in order.

    Same contract as read_incomes, for the same reason: these rows are about to
    be written into a fresh sheet, so what they say has to survive verbatim.
    Nobody's typing is reformatted on the way through.
    """
    if "Expenses" not in wb.sheetnames:
        return []
    ws = wb["Expenses"]
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not any(v not in (None, "") for v in row):
            continue
        rows.append(list(row) + [None] * (len(EXPENSE_COLS) - len(row)))
    return rows


def expense_ids_present(rows):
    """The dedupe key. Column 7 is Expense ID; blank means hand-entered."""
    return {str(r[6]).strip() for r in rows if r[6] not in (None, "")}


def overwide_expense_rows(rows):
    """
    Sheet rows carrying more columns than the spec, which a write would drop.

    read_expenses pads a short row but cannot shorten a long one, and build()
    only writes the columns it knows about — so a value typed into column I
    disappears on the next sync, silently. Reported so it cannot.
    """
    return [i for i, r in enumerate(rows, start=2) if len(r) > len(EXPENSE_COLS)]
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `5 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add scripts/onboarding/build_v2.py scripts/onboarding/budget_sync.py scripts/onboarding/test_budget_sync.py
git commit -m "Give expenses a column spec and a reader that preserves rows

Expenses had no shape at all -- just a name in PRESERVED, copied
values-only. This is the spec, plus the same reader contract Incomes
uses: read every row, pad it, change nothing.

Expense ID is specified but fills nothing yet. It is one column now and
a retrofit across a season of rows later.

overwide_expense_rows catches the silent case: a value typed past the
last spec column is dropped on write, because build() writes only the
columns it knows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Categories that tighten themselves

Free text was chosen deliberately — no taxonomy is worth inventing before seeing what gets typed. Free text also drifts. This makes the drift visible instead of asking anyone to be disciplined.

**Files:**
- Modify: `scripts/onboarding/build_v2.py` — add `norm_category()` after `norm()` (ends line 149)
- Modify: `scripts/onboarding/budget_sync.py` — import it; add `category_counts()` and `category_variants()` after `overwide_expense_rows()`
- Modify: `scripts/onboarding/test_budget_sync.py`
- Modify: `scripts/onboarding/budget-outflows-design.md` — correct the `norm()` claim

**Interfaces:**
- Consumes: `read_expenses()` from Task 2
- Produces: `norm_category(s) -> str`; `category_counts(rows) -> collections.Counter`; `category_variants(counts) -> list[list[tuple[str, int]]]` (only groups with >1 spelling, each group sorted most-used first)

- [ ] **Step 1: Write the failing tests**

Append to `scripts/onboarding/test_budget_sync.py`, above `def main()`:

```python
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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: the three new tests ERROR on `ImportError: cannot import name 'norm_category'`.

- [ ] **Step 3: Add `norm_category`**

In `scripts/onboarding/build_v2.py`, directly after `norm()` (ends line 149):

```python
def norm_category(s):
    """
    Loosen a category enough to spot two spellings of one bucket.

    Deliberately not norm(): that one is tuned for student names and splits on
    the first hyphen ('Alex Rivera- July'), which would silently truncate a
    category like 'Pre-season build' to 'pre'. It also strips digits, which a
    category may legitimately carry.

    Case and internal spacing are the only things collapsed, because merging
    anything more would hide a distinction someone meant to draw. The job here
    is to flag 'Robot parts' against 'robot parts' for a human to resolve, not
    to decide that two categories are the same.
    """
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s)).strip().casefold()
```

- [ ] **Step 4: Add the tallies**

In `scripts/onboarding/budget_sync.py`, add `norm_category,` to the `from build_v2 import (` block (alphabetically, after `norm,`), and add `from collections import Counter, defaultdict` — the file already imports `defaultdict` at line 52, so change that line to include `Counter`.

Then after `overwide_expense_rows()`:

```python
def category_counts(rows):
    """Distinct categories and how many rows use each. Blanks are not a category."""
    return Counter(
        (r[2] or "").strip() for r in rows if (r[2] or "").strip()
    )


def category_variants(counts):
    """
    Groups of spellings that normalise to one category.

    Only groups with more than one spelling come back — the report is about
    drift, and a category spelled one way consistently is not drift. Each group
    leads with the most-used spelling, which is the one worth standardising on.
    """
    groups = defaultdict(list)
    for name, n in counts.items():
        groups[norm_category(name)].append((name, n))
    return [
        sorted(v, key=lambda pair: (-pair[1], pair[0]))
        for v in groups.values()
        if len(v) > 1
    ]
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `8 passed, 0 failed`.

- [ ] **Step 6: Correct the spec**

The spec claims category grouping reuses `norm()`. It cannot, for the reason in the docstring. In `scripts/onboarding/budget-outflows-design.md`, find:

```
  grouping with the same `norm()` the codebase already uses for name matching:
```

Replace with:

```
  grouping with `norm_category()`, which collapses case and spacing only —
  deliberately *not* the existing `norm()`, which splits on the first hyphen
  because it is tuned for names and would truncate `Pre-season build`:
```

- [ ] **Step 7: Commit**

```bash
git add scripts/onboarding/build_v2.py scripts/onboarding/budget_sync.py scripts/onboarding/test_budget_sync.py scripts/onboarding/budget-outflows-design.md
git commit -m "Spot two spellings of one expense category

Categories are free text on purpose -- there is no taxonomy worth
inventing before seeing what gets typed. The cost is drift, and the
answer is to make it visible rather than to ask for discipline.

norm_category collapses case and spacing and nothing else. It is not
norm(), which splits on the first hyphen because it is tuned for names
and would quietly truncate 'Pre-season build' to 'pre'. The spec said to
reuse norm(); that was wrong and is corrected here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Write the sheets, and a dropdown that suggests without forbidding

**Files:**
- Modify: `scripts/onboarding/budget_sync.py` — add the `DataValidation` import; change `PRESERVED` at line 89; add `write_categories()` and `attach_category_dropdown()` before `build()` (line 358); extend `build()` (lines 358-400)
- Modify: `scripts/onboarding/test_budget_sync.py`

**Interfaces:**
- Consumes: `EXPENSE_COLS`, `read_expenses()`, `category_counts()` from Tasks 2-3
- Produces: `build(students, income_rows, expense_rows) -> openpyxl.Workbook` — **note the new third parameter**, relied on by Task 5; `write_categories(wb, counts) -> int` (number of categories written); `attach_category_dropdown(ws, n_categories) -> None`; `CATEGORY_VALIDATION_ROWS = 5000`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/onboarding/test_budget_sync.py`, above `def main()`:

```python
def cell_equal(before, after):
    """
    Compare a written cell with the one read back.

    openpyxl writes '' as an empty cell and reads it back as None, so a strict
    == would fail on every blank a person left blank. Both spellings mean
    empty. 0 is not empty and is compared normally.
    """
    if before in (None, "") and after in (None, ""):
        return True
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
    rows = [[date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", ""]]
    wb = bs.build({}, [], rows)
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

    openpyxl destroys charts on write, and the chart lives in the analysis
    workbook. Nothing in this script should reference that file at all. If
    someone adds a reference, this fires and they have to think about it.
    """
    src = (Path(__file__).resolve().parent / "budget_sync.py").read_text()
    assert "FRC Budget" not in src, "budget_sync.py must not reference the analysis workbook"
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: the rebuild tests ERROR on `TypeError: build() takes 2 positional arguments but 3 were given`; `test_expenses_is_no_longer_blindly_preserved` FAILs.

- [ ] **Step 3: Add the import and shrink `PRESERVED`**

In `scripts/onboarding/budget_sync.py`, after `import openpyxl` (line 56):

```python
from openpyxl.worksheet.datavalidation import DataValidation
```

Replace line 89:

```python
# Carried through untouched by a values-only cell copy. That copy is why
# nothing richer than bare values can live on a preserved sheet — a formula,
# a format or a dropdown is destroyed on the next run.
#
# Expenses used to be here. It now has a real reader and a real writer, which
# is what lets the script re-apply the category dropdown every sync instead of
# breaking it.
PRESERVED = ("Zeffy Map", "Sponsors")
```

- [ ] **Step 4: Add the category writers**

Immediately before `build()` (line 358):

```python
# Excel rejects a validation over an empty range, and a fixed ceiling means new
# rows are covered as the sheet grows without re-running anything.
CATEGORY_VALIDATION_ROWS = 5000


def write_categories(wb, counts):
    """
    The dropdown's source list, regenerated from what has actually been typed.

    Derived data: rebuilt every run, so nothing should be typed here. Ordered
    by use then name, so the categories reached for most sit at the top of the
    dropdown.
    """
    ws = wb.create_sheet("Categories")
    style_header(ws, [("Category", 24), ("Rows", 8)])
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].casefold()))
    for r, (name, n) in enumerate(ordered, start=2):
        ws.cell(r, 1, name)
        ws.cell(r, 2, n)
    ws.cell(len(ordered) + 3, 1, "Rebuilt by budget_sync.py — do not type here.").font = NOTE_FONT
    return len(ordered)


def attach_category_dropdown(ws, n_categories):
    """
    Offer the categories already in use, without forbidding a new one.

    showErrorMessage=False is the whole point. The categories are deliberately
    not a fixed taxonomy — the decision was to let the data settle first — so a
    validation that rejected an unseen value would undo that decision on the
    first receipt from a new kind of vendor. This suggests; it does not gate.
    """
    if not n_categories:
        return
    dv = DataValidation(
        type="list",
        formula1=f"Categories!$A$2:$A${n_categories + 1}",
        allow_blank=True,
        showErrorMessage=False,
    )
    ws.add_data_validation(dv)
    dv.add(f"C2:C{CATEGORY_VALIDATION_ROWS}")
```

`NOTE_FONT` is **not** currently imported (the block at lines 64-82 has `norm` and `style_header` but not `NOTE_FONT`). Add `NOTE_FONT,` to it, alphabetically — it goes immediately after `MONTHLY,`.

- [ ] **Step 5: Extend `build()`**

Change the signature at line 358 to `def build(students, income_rows, expense_rows):`.

After the `Schedule` sheet block (ends line 399, before `return wb`), insert:

```python
    ws = wb.create_sheet("Expenses")
    style_header(ws, EXPENSE_COLS)
    for r, row in enumerate(expense_rows, start=2):
        when = row[0]
        ws.cell(r, 1, when.date() if isinstance(when, datetime) else when).number_format = "yyyy-mm-dd"
        ws.cell(r, 2, row[1] if row[1] is not None else "")
        ws.cell(r, 3, row[2] if row[2] is not None else "")
        ws.cell(r, 4, row[3]).number_format = '"$"#,##0.00'
        for c in (5, 6, 7, 8):
            ws.cell(r, c, row[c - 1] if row[c - 1] is not None else "")

    # Categories before the dropdown: the validation points at that sheet's
    # range, so it has to exist and its length has to be known.
    n_categories = write_categories(wb, category_counts(expense_rows))
    attach_category_dropdown(ws, n_categories)
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `14 passed, 0 failed`.

- [ ] **Step 7: Settle the two openpyxl unknowns against real output**

The spec flags both as verify-don't-assume. Inspect the XML openpyxl actually emits:

```bash
python3 -c "
import sys, zipfile, tempfile, re
from pathlib import Path
from datetime import date
sys.path.insert(0, 'scripts/onboarding')
import budget_sync as bs
wb = bs.build({}, [], [[date(2026,8,1),'Acme Parts','Tools',10.0,'','','','']])
with tempfile.TemporaryDirectory() as td:
    p = Path(td)/'probe.xlsx'; wb.save(p)
    z = zipfile.ZipFile(p)
    for n in z.namelist():
        if n.startswith('xl/worksheets/sheet'):
            x = z.read(n).decode()
            for m in re.findall(r'<dataValidation[^>]*>', x):
                print(n, m)
"
```

Expected: exactly one `<dataValidation ...>` element, with `type=\"list\"`, `sqref=\"C2:C5000\"`, a `formula1` naming `Categories`, and **no** `showDropDown=\"1\"` attribute. If `showDropDown=\"1\"` appears, Excel will hide the arrow — pass `showDropDown=False` explicitly and re-run.

Record the observed element in the commit message. Whether Excel *renders* the arrow is confirmed by the user in acceptance check 5 — that part cannot be verified from here.

- [ ] **Step 8: Commit**

```bash
git add scripts/onboarding/budget_sync.py scripts/onboarding/test_budget_sync.py
git commit -m "Write the expense ledger, and a dropdown that suggests rather than gates

Expenses graduates out of PRESERVED. That values-only copy is exactly
why nothing richer than bare values could ever live on the sheet, and
owning the write is what lets the dropdown be re-applied every sync
instead of being destroyed by one.

The Categories sheet is derived from what has actually been typed, so
the list tightens as the season goes on without anyone designing a
taxonomy. showErrorMessage is off deliberately: the categories are not a
fixed set, so rejecting an unseen value would undo that decision on the
first receipt from a new kind of vendor.

showDropDown is inverted in OOXML -- true suppresses the in-cell arrow
-- so it is asserted absent rather than set true, checked against the
emitted sheet XML.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire it into the run, and refuse to lose a column

**Files:**
- Modify: `scripts/onboarding/budget_sync.py` — read expenses in `main()` near line 439; add the report after the Incomes lines (466-472); add the refusal beside the existing one (around line 528); update the `build()` call at line 543
- Modify: `scripts/onboarding/test_budget_sync.py`

**Interfaces:**
- Consumes: `read_expenses()`, `overwide_expense_rows()`, `category_counts()`, `category_variants()`, `build(students, income_rows, expense_rows)` from Tasks 2-4
- Produces: `expense_report(expense_rows) -> list[str]` — the report lines, returned rather than printed so they can be asserted

- [ ] **Step 1: Write the failing tests**

Append to `scripts/onboarding/test_budget_sync.py`, above `def main()`:

```python
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
    assert "2 distinct" in text, "'Robot parts' and 'robot parts' are two spellings, not one"
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
    wide = [date(2026, 8, 1), "Acme Parts", "Tools", 10.0, "", "", "", "", "stray"]
    text = "\n".join(bs.expense_report([wide]))
    assert "more columns than the spec" in text, text
    assert "row 2" in text, text
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: the three new tests ERROR on `AttributeError: module 'budget_sync' has no attribute 'expense_report'`.

- [ ] **Step 3: Write `expense_report`**

In `scripts/onboarding/budget_sync.py`, after `category_variants()`:

```python
def expense_report(expense_rows):
    """
    What the expense ledger looks like right now, as lines to print.

    Returned rather than printed so it can be asserted without capturing
    stdout. Says nothing it does not have to: a clean ledger produces one line.
    """
    total = sum(float(r[3] or 0) for r in expense_rows)
    lines = [f"  Expenses  {len(expense_rows)} row(s), ${total:,.2f}"]

    counts = category_counts(expense_rows)
    if counts:
        lines.append(f"\n  Categories ({len(counts)} distinct, {sum(counts.values())} rows):")
        for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].casefold())):
            lines.append(f"    {n:>4}  {name}")

    variants = category_variants(counts)
    if variants:
        lines.append("\n  Possible duplicates — one category, several spellings:")
        for group in variants:
            lines.append("    " + " / ".join(f"{name!r} ({n})" for name, n in group))
        lines.append("    Standardise on the first of each and re-run; the dropdown")
        lines.append("    follows what is actually used.")

    wide = overwide_expense_rows(expense_rows)
    if wide:
        shown = ", ".join(str(i) for i in wide[:10])
        lines.append(f"\n  {len(wide)} expense row(s) have more columns than the spec "
                     f"({len(EXPENSE_COLS)}): row {shown}")
        lines.append("    Those values are dropped on write. Move them into Notes, or")
        lines.append("    widen EXPENSE_COLS, before committing.")
    return lines
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `17 passed, 0 failed`.

- [ ] **Step 5: Wire it into `main()`**

Read the expenses alongside the incomes. After the existing `seen = zeffy_ids_present(income_rows)` (line 440):

```python
    expense_rows = read_expenses(existing_wb) if existing_wb else []
```

Print the report after the hand-entered Incomes line (after line 472):

```python
    for line in expense_report(expense_rows):
        print(line)
```

Add the refusal beside the existing participant-id refusal, immediately before `if not args.commit:` (line 533):

```python
    # Refuse rather than warn, for the same reason the missing-id case refuses:
    # the failure is silent. A value in column I is simply gone after the next
    # sync, and nobody reviews a sheet they believe a script maintains.
    overwide = overwide_expense_rows(expense_rows)
    if overwide:
        print(f"\nRefusing to write: {len(overwide)} expense row(s) carry columns "
              f"the spec would drop.\n")
        sys.exit(1)
```

Pass them to `build()` at line 543:

```python
    wb = build(students, income_rows + added, expense_rows)
```

- [ ] **Step 6: Verify the whole suite and that a dry run is still inert**

Run: `python3 scripts/onboarding/test_budget_sync.py`

Expected: `17 passed, 0 failed`.

Run: `python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses --out /tmp/does-not-exist.xlsx`

Expected: `No workbook at /tmp/does-not-exist.xlsx`, exit 1, nothing created.

- [ ] **Step 7: Commit**

```bash
git add scripts/onboarding/budget_sync.py scripts/onboarding/test_budget_sync.py
git commit -m "Report the expense ledger, and refuse to silently drop a column

The dry run now says what the expense side holds: the total, the
categories by use, and any category spelled more than one way.

A row carrying more columns than the spec is a refusal, not a warning.
build() writes the columns it knows about, so a value typed past the
last one vanishes on the next sync -- and nobody proofreads a sheet they
believe a script maintains. Same reasoning as the missing-participant-id
refusal: warn on the loud failures, refuse on the silent ones.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The front page

Excel configuration, so this task's verification is a documented manual procedure rather than an assertion — the analysis workbook cannot be opened by tooling, which is the point of the whole split.

**Files:**
- Create: `scripts/onboarding/powerquery/Incomes.m`
- Create: `scripts/onboarding/powerquery/Expenses.m`
- Modify: `scripts/onboarding/powerquery/README.md` — add to "Loading a query", and replace the `FRC Current Budget` line in "Still to migrate"

**Interfaces:**
- Consumes: the `Expenses` and `Incomes` sheets written in Tasks 4-5
- Produces: Power Query tables named `Incomes` and `Expenses`; the named cell `PlannedSpend`

- [ ] **Step 1: Write `Incomes.m`**

Create `scripts/onboarding/powerquery/Incomes.m`, following `Dues.m`'s shape (read it first for the `Path` convention on line 12):

```
// Every payment recorded this season, from the data workbook.
//
// The front page needs a total that includes money the Dues query leaves out:
// arrears on the legacy Zeffy form, and payments nobody could attribute to a
// student. Those carry no participant id on purpose, so a per-student roll-up
// cannot see them — but they are real income and belong in the headline.
let
    // The one thing to change if the workbook moves. Identical to Dues.m:12.
    Path = "/Users/steven/Library/CloudStorage/OneDrive-STEM+C/FRC Data 2026-2027.xlsx",
    Source = Excel.Workbook(File.Contents(Path), null, true),
    Sheet = Source{[Item = "Incomes", Kind = "Sheet"]}[Data],
    Promoted = Table.PromoteHeaders(Sheet, [PromoteAllScalars = true]),
    Kept = Table.SelectRows(Promoted, each [Date] <> null),
    Typed = Table.TransformColumnTypes(
        Kept,
        {
            {"Date", type date},
            {"Participant ID", type text},
            {"Payer", type text},
            {"Type", type text},
            {"Amount", Currency.Type},
            {"Zeffy Payment ID", type text},
            {"Notes", type text}
        }
    )
in
    Typed
```

The `Path` above is `Dues.m:12` verbatim. If it has since changed, copy it from there rather than retyping, so all three queries agree.

- [ ] **Step 2: Write `Expenses.m`**

Create `scripts/onboarding/powerquery/Expenses.m`:

```
// The expense ledger, hand-entered into the data workbook.
//
// Amount is Currency.Type so it loads as money rather than a bare number.
// Everything past that -- decimals, alignment, colour -- is applied once in
// Excel and survives refresh, as long as the table's *columns* are formatted
// rather than a fixed range of cells.
let
    // The one thing to change if the workbook moves. Identical to Dues.m:12.
    Path = "/Users/steven/Library/CloudStorage/OneDrive-STEM+C/FRC Data 2026-2027.xlsx",
    Source = Excel.Workbook(File.Contents(Path), null, true),
    Sheet = Source{[Item = "Expenses", Kind = "Sheet"]}[Data],
    Promoted = Table.PromoteHeaders(Sheet, [PromoteAllScalars = true]),
    Kept = Table.SelectRows(Promoted, each [Date] <> null),
    Typed = Table.TransformColumnTypes(
        Kept,
        {
            {"Date", type date},
            {"Vendor", type text},
            {"Category", type text},
            {"Amount", Currency.Type},
            {"Paid By", type text},
            {"Receipt", type text},
            {"Expense ID", type text},
            {"Notes", type text}
        }
    )
in
    Typed
```

Same `Path` as above — both new queries and `Dues.m` must name the identical file.

- [ ] **Step 3: Document loading them and building the page**

In `scripts/onboarding/powerquery/README.md`, after the existing "Loading a query" section, add:

````markdown
## The front page

Load `Incomes.m` and `Expenses.m` the same way as `Dues.m`, naming the queries
**`Incomes`** and **`Expenses`**. Then build the summary block with formulas
rather than a third query — the totals stay readable in the formula bar, and
there is one less thing to refresh.

First, the one input cell. Put `59000` somewhere on the front page, select it,
and name it **`PlannedSpend`** (Formulas → Define Name). It is a rough estimate
and will move; it lives here rather than in a config file because one number
does not justify one.

| Cell | Formula |
|---|---|
| Total Income | `=SUM(Incomes[Amount])` |
| Total Expenses | `=SUM(Expenses[Amount])` |
| Planned Spend | `=PlannedSpend` |
| Over / Under Income | `=SUM(Expenses[Amount])-SUM(Incomes[Amount])` |
| Remaining to Plan | `=PlannedSpend-SUM(Expenses[Amount])` |

For the breakdowns, use `SUMIFS` against a list of the distinct values:

- **By vendor** — `=SUMIFS(Expenses[Amount],Expenses[Vendor],$A2)`
- **By category** — `=SUMIFS(Expenses[Amount],Expenses[Category],$A2)`, with the
  `Categories` query or sheet supplying column A
- **Income by student** — already in the `Dues` query: Participant ID, Student,
  Paid to Date. No new query needed.

The chart is three clustered bars — Income, Spend, Plan — over the three summary
cells. **It lives in this workbook and nothing else may.** `budget_sync.py`
never opens this file, because openpyxl drops charts when it rewrites a
workbook; that is the reason the data lives in a second file at all.

Refresh after every sync: **Data → Refresh All**.
````

And in "Still to migrate", replace:

```
- [ ] **FRC Current Budget** — reads `Incomes!G`, `Incomes!H` (holds the chart)
```

with:

```
- [x] **FRC Current Budget** — rebuilt on the `Incomes` and `Expenses` queries,
      planned-spend-led. Still holds the chart, still never opened by tooling.
```

- [ ] **Step 4: Check the M syntax by eye against `Dues.m`**

Run: `diff <(grep -c . scripts/onboarding/powerquery/Dues.m) <(grep -c . scripts/onboarding/powerquery/Expenses.m) ; head -14 scripts/onboarding/powerquery/Dues.m`

Confirm the `Path` line in both new files matches `Dues.m` exactly. A wrong path fails at refresh with a file-not-found that looks like a permissions problem.

There is no way to execute M outside Excel, so this is the limit of what can be checked here. Acceptance check 5 is the real test.

- [ ] **Step 5: Commit**

```bash
git add scripts/onboarding/powerquery/Incomes.m scripts/onboarding/powerquery/Expenses.m scripts/onboarding/powerquery/README.md
git commit -m "Build the front page from both halves of the ledger

Two queries and a named cell, with the summary in formulas rather than a
third query so the totals stay readable and there is less to refresh.

Income comes from Incomes rather than from the Dues roll-up, because
Dues keys on participant id and arrears and unattributable payments
carry none by design. They are still real income and belong in the
headline.

The page is planned-spend-led. Last season's compared a fundraising
target against income, and this season's estimate is a spend figure, so
reusing that layout would chart two unrelated things against each other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Acceptance criteria

Tasks 1-5 are verified by `python3 scripts/onboarding/test_budget_sync.py` (17 tests, all fixture-based). The checks below need the live workbooks and so are **run by the user**, who pastes the output back.

1. **Look before touching.** `python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses` prints the live sheet's real header and first rows, and changes nothing. If its shape does not match `EXPENSE_COLS`, stop and design the migration from that output before running anything with `--commit`.
2. **A dry run is inert.** `python3 scripts/onboarding/budget_sync.py <roster>` prints the expense total, the category histogram and any duplicate spellings, and leaves both workbooks' mtimes unchanged.
3. **Hand-typed rows survive.** Type three expense rows into the data workbook, close it, run with `--commit`, reopen: all three are present and unchanged, with money formatted and a dropdown on the Category cells.
4. **A backup exists.** `FRC Data 2026-2027.backup-<stamp>.xlsx` appears beside the data workbook after the commit.
5. **The page adds up and the chart lives.** In the analysis workbook, Data → Refresh All: Total Income and Total Expenses match the data workbook's own totals, and the chart is still there. This is also the only real test of the dropdown arrow — Excel's rendering cannot be checked from the dev machine.
6. **A new category is accepted.** Type a category that has never been used into a Category cell. Excel must accept it without an error dialog, and it must appear in the `Categories` sheet after the next sync.

## Where this plan departs from the spec

Two of the spec's seven listed tests could not be written as the spec describes. Both are deliberate, not oversights.

- **"A row whose `Expense ID` is already present is skipped, not duplicated."** Nothing appends expense rows yet — `Expense ID` is specified but never filled, because expenses arrive as receipts with no structured feed to import. There is no skip behaviour to test. What is tested instead is that `expense_ids_present()` extracts the dedupe set correctly and ignores hand-entered rows, so the key is ready for whatever appends first. **When an appender is built, that test becomes required.**
- **"The analysis workbook's mtime is unchanged by a sync."** Asserting this properly means running `main()` end to end, which needs a roster, a ledger and possibly the Zeffy API — none of which belong in a unit test, and the roster cannot be committed to a public repo. Reframed as an invariant guard: the test asserts `budget_sync.py` never mentions `"FRC Budget"` at all. Weaker as a behavioural check, stronger as a tripwire — it fires the moment someone adds a reference, which is the actual failure mode. Acceptance check 5 remains the real proof that the chart survives.

Also corrected in Task 3: the spec said category grouping reuses `norm()`. It cannot — `norm()` splits on the first hyphen because it is tuned for names.

## Notes for the executor

- **The data workbook must be closed** when running with `--commit`. Excel holds a lock and the write is a full rebuild.
- **Never run `--commit` against the live workbook before acceptance check 1.** The shape of the existing `Expenses` sheet is genuinely unknown.
- If acceptance check 1 shows rows in an unexpected shape, that is a **new task**, not an improvisation: write the migration against the real header, with a test that the old rows land in the right columns.
- Do not add pytest. Do not add an id-minting path. Do not open the analysis workbook.
