# FRC budget: recording outflows, and a front page built from both sides

**Date:** 2026-09-17
**Status:** design, approved in principle — not yet implemented

## The problem

`FRC Budget.xlsx` had a front page worth keeping: total income, total expenses,
over/under, a chart, and income and expense breakdowns beside each other. It was
assembled by hand. Nothing regenerates it, and half its inputs no longer exist
in the place it reads them from.

Meanwhile the income side has been automated and the expense side has not. The
2026–27 season needs both, with a clear split of labour: **income is recorded by
tooling, expenses are recorded by a person**, and one page reads the result.

## What already exists

| Piece | State |
|---|---|
| `budget_sync.py` → `FRC Data 2026-2027.xlsx` (Roster, Incomes, Schedule) | built |
| Append-only `Incomes`, so hand-entered Venmo/cash/cheque rows survive a sync | built |
| Two-workbook split: data workbook script-owned, analysis workbook human-owned | built |
| `Dues.m` Power Query, replacing the old `Dues Status` sheet | built |
| `Expenses` | **a name in `PRESERVED`, copied values-only, no defined shape** |
| `FRC Current Budget` — the front page, and the workbook's chart | **not migrated** |

The chart problem is already solved and this design does not revisit it.
openpyxl destroys charts when it *writes* a workbook, so the analysis workbook
is never written by tooling — only read, which is safe. That constraint shapes
everything below.

## Scope

**In:**

- An `Expenses` sheet with a real column spec, read and rewritten by
  `budget_sync.py` under the same append-only contract as `Incomes`
- A self-tightening category dropdown and a drift report
- The front page (`FRC Current Budget`) rebuilt on Power Query, with planned
  spend as its new headline

**Out** — named so nobody expects them:

- Migrating `Cash Flow`, `Tax Purposes` and `Sponsors`. They still read the old
  in-workbook `Incomes` block, so they stay stale rather than wrong-but-trusted,
  exactly as `powerquery/README.md` already documents.
- The FTC/Jedi budget. This workbook is FRC/Samurai only, mirroring how income
  sync already separates the teams by Zeffy campaign and reports the other
  team's money rather than absorbing it.
- Parsing receipts, and any bank or card feed. Expenses arrive as ad-hoc
  receipts and vendor order history; there is no structured source to parse.
- A per-category spend plan. Planned spend is one number this season.

## Design

### Ownership follows who types, not which file

Expenses are hand-entered, so the obvious move is to put them in the workbook a
human owns. That is the wrong call here, for a stated reason: the goal is for
tooling to take on more of this over time, and the analysis workbook is the one
file tooling can never write. Putting expenses there would foreclose that
permanently.

So `Expenses` goes in the **data workbook**, as the twin of `Incomes` — which
already holds script-generated rows (Zeffy, keyed on a payment id) beside
hand-entered ones (Venmo, cash, cheque) under an append-only contract that is
written, tested, and whose failure mode is documented in the module docstring.
Reusing that pattern is the whole point; a second implementation of "don't
destroy what a person typed" is how two answers drift apart.

### The `Expenses` sheet

```python
EXPENSE_COLS = [
    ("Date", 12),          # when the money left
    ("Vendor", 22),        # AndyMark, Amazon, FIRST Inspires
    ("Category", 18),      # free text, dropdown-assisted — see below
    ("Amount", 11),        # '"$"#,##0.00'
    ("Paid By", 14),       # team card, or who fronted it
    ("Receipt", 22),       # order or invoice number — the tie to evidence
    ("Expense ID", 38),    # script-filled only; blank means hand-entered
    ("Notes", 24),
]
```

`Expense ID` is the dedupe key, mirroring `Zeffy Payment ID`. Nothing fills it
yet. It is specified now because it is one column today and a retrofit across
two hundred rows later.

`Receipt` exists because a 501(c)(3) expense that cannot be tied to evidence is
a problem at audit, not at entry time.

No `Team` column: this workbook is FRC only.

### The append-only contract

Three functions, each mirroring an `Incomes` counterpart that already works:

| New | Mirrors | Does |
|---|---|---|
| `read_expenses(wb)` | `read_incomes` | every row already recorded, in order, as plain tuples |
| `expense_ids_present(rows)` | `zeffy_ids_present` | the dedupe set; blank id means hand-entered |
| `build()` gains an `Expenses` sheet | the `Incomes` block | rewrites rows verbatim, re-applies formats |

`Expenses` is removed from `PRESERVED`. That tuple does a values-only cell copy,
which is why nothing rich can live on a preserved sheet — every dropdown,
format and formula is silently destroyed on the next sync. Graduating the sheet
to a real reader plus a real writer is what makes the dropdown possible at all,
because the script re-applies it from scratch each run.

### Categories tighten themselves

Free text was chosen deliberately: there is no taxonomy worth inventing before
seeing what actually gets typed. Free text also drifts — `Robot parts`,
`robot parts`, `Robot Parts` become three buckets. Rather than asking anyone to
be disciplined, the drift is made mechanical:

- A `Categories` sheet holds the distinct categories seen so far, ordered by
  frequency then name. It is regenerated every run.
- Data validation on `Expenses!C2:C5000` points at that range, with
  `allow_blank=True` and **error messages off** — so it offers what you have
  used before while still accepting something new. A validation that rejected a
  new category would defeat the decision to start loose.
- The dry-run report prints the histogram and flags near-duplicates,
  grouping with `norm_category()`, which collapses case and spacing only —
  deliberately *not* the existing `norm()`, which splits on the first hyphen
  because it is tuned for names and would truncate `Pre-season build`:

```
  Categories (7 distinct, 41 rows):
      18  Robot parts
       9  Raw materials
       6  Registration
       ...
    Possible duplicates — same category, three spellings:
      'Robot parts' (18) / 'robot parts' (2) / 'Robot Parts' (1)
```

Drift becomes visible rather than silent, which is the same principle the
income side already applies to unattributable payments.

### The front page

The summary block changes shape, because $59k is a spend estimate rather than
last season's fundraising target. Last year's "Estimated Season" of $51,750 was
charted against *income*, not against expenses — whatever its composition, it
was a figure to raise, while over/under was computed separately as expenses
minus income. Reusing that layout for a spend number would quietly chart two
unrelated things against each other.

| Cell | Source |
|---|---|
| Total Income | `SUM` over the `Incomes` query |
| Total Expenses | `SUM` over the `Expenses` query |
| Planned Spend | `PlannedSpend`, a named input cell — `$59,000` |
| Over / Under Income | expenses − income |
| Remaining to Plan | plan − expenses |
| Income by student | the existing `Dues` query (Participant ID, Student, Paid to Date) |
| Expenses by vendor | `SUMIFS` over `Expenses` |
| Expenses by category | `SUMIFS` over `Expenses` |
| Chart | clustered bars: Income / Spend / Plan |

Two new Power Query files, `Incomes.m` and `Expenses.m`, following `Dues.m`'s
shape and typed with `Currency.Type` on money columns. Per-student income needs
no new query — `Dues.m` already produces it.

Breakdowns are `SUMIFS` over loaded tables rather than four more queries: fewer
moving parts, and the totals stay readable in the formula bar.

`PlannedSpend` lives in the analysis workbook as a named cell because it is a
guess a person will revise, and one number does not justify a config file. If
script-side reporting against the plan is ever wanted, it moves to
`roster-overrides.json` as `plannedSpend` and gets written to a `Plan` sheet —
a known, cheap upgrade, deliberately not built now.

## Implementation notes

**Step one is a diagnostic, not a change.** The current `Expenses` sheet's shape
is unknown — it has only ever been copied blindly, and OneDrive is unreadable
from here. So `budget_sync.py` gains `--dump-sheet <name>`, which prints a
sheet's header row and first few rows and changes nothing. Run it against the
live workbook before writing any migration, and decide from real output whether
existing rows map onto `EXPENSE_COLS` or the sheet starts fresh.

**Two openpyxl behaviours to verify empirically, not from memory.** Both are
cheap to settle in the fixture test and expensive to get wrong:

- `DataValidation.showDropDown` is inverted in the OOXML spec — setting it true
  *suppresses* the in-cell arrow. Confirm which value actually shows a dropdown.
- Cross-sheet `formula1` may or may not want a leading `=`
  (`=Categories!$A$2:$A$200` vs `Categories!$A$2:$A$200`). Pick whichever Excel
  opens without a repair prompt.

**The data workbook must be closed when syncing.** Excel holds a lock and the
rewrite is a full rebuild. A backup is already written as
`FRC Data 2026-2027.backup-<stamp>.xlsx` before every commit.

## Testing

There is no test suite in this repo and pytest is not installed, so tests are a
standalone script of plain assertions over fixture workbooks built in a temp
directory. This runs entirely locally and needs no OneDrive access.

```bash
python3 scripts/onboarding/test_budget_sync.py
```

| # | Asserts |
|---|---|
| 1 | `read_expenses` round-trips rows unchanged in value and order |
| 2 | hand-entered rows (blank `Expense ID`) are identical after a full rebuild |
| 3 | a row whose `Expense ID` is already present is skipped, not duplicated |
| 4 | the category histogram counts correctly |
| 5 | near-duplicate detection groups the three spellings of one category |
| 6 | the written workbook reopens in openpyxl, and the validation covers `C2:C5000` |
| 7 | the analysis workbook's mtime is unchanged by a sync — the script never opens it |

Test 7 is the one that protects the chart, and it is worth having as an
assertion rather than a convention.

## Acceptance criteria

Each is a command with an observable result. Every one is run by a person, for
the reason in Constraints.

1. `--dump-sheet Expenses` prints the live sheet's real shape and changes nothing.
2. A dry run prints expense count, category histogram and duplicate flags, and
   leaves both workbooks untouched.
3. Three rows typed into `Expenses` by hand are still present, unchanged, after
   `--commit` — with formats and dropdown re-applied.
4. A backup file appears alongside the data workbook on commit.
5. `Data → Refresh All` in the analysis workbook makes the front-page totals
   match the data workbook, and the chart is still there.
6. `python3 scripts/onboarding/test_budget_sync.py` passes.

## Constraints and open items

- **Claude cannot read `~/Library/CloudStorage/OneDrive-STEM+C`** — macOS TCC
  denies directory listing even though POSIX permits it. Consequence: every
  acceptance check above is a command the user runs and pastes back, and no live
  workbook can be inspected from here. Granting Full Disk Access to
  `/Applications/Claude.app` would lift this; the decision is open and nothing in
  this design depends on it. Test mechanics are verifiable locally regardless.
- `mount` hangs on this machine, suggesting a stalled network mount. Unrelated
  to this work, noted because it cost time to diagnose.
- Planned spend of $59,000 is an explicitly rough figure and expected to move.

## Risks

| Risk | Handling |
|---|---|
| The live `Expenses` sheet has rows in an unknown shape | `--dump-sheet` first; migrate from real output |
| A sync destroys hand-typed expense rows | append-only contract, plus test 2 and the pre-commit backup |
| Free-text categories fragment | histogram and near-duplicate report every run; dropdown tightens from use |
| A rewrite eats the chart | the analysis workbook is never opened for writing; test 7 asserts it |
| Two payment ledgers coexist until Cash Flow and Tax Purposes migrate | out of scope and already documented; the old one is the incomplete one |
