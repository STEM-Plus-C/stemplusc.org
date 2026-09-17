#!/usr/bin/env python3
"""
Keep the budget's data workbook in step with the onboarding ledger and Zeffy.

## Why there are two workbooks

The budget used to be one file doing two jobs, and the second job kept the
first one from being automated. `FRC Budget 2026-2027.xlsx` holds a chart, and
openpyxl deletes charts when it rewrites a workbook — which is why add_sheet.py
exists at all, 184 lines of zip surgery to avoid destroying one picture.

So the data moves to a workbook with no chart in it:

    FRC Data 2026-2027.xlsx     Roster, Incomes, Schedule. Written by this
                                script. Nothing decorative, nothing to lose.
    FRC Budget 2026-2027.xlsx   Charts, dues analysis, expense buckets. Read
                                from the data workbook through Power Query.
                                Owned by a person; this script never opens it.

That split is also what fixes the join. v1 kept a per-student roster block in
Incomes columns M-S, and Dues Status read it *by row position* — so inserting a
row in the wrong place silently reattributed someone's money. Here the Roster
is its own sheet and every payment carries a participant id.

## Incomes is append-only, and that is not an implementation detail

Venmo, cash and cheque payments are typed in by hand. The v1 formula already
counted `Fee - Venmo`; nobody had ever entered one, which is how a family who
paid by Venmo sat at $0 and CRITICAL and got chased for money they had sent.

If this script regenerated Incomes, every hand-entered row would vanish on the
next run. So it never rewrites or reorders that sheet. It appends Zeffy
payments it has not seen before, keyed on Zeffy's own payment id, and leaves
everything else exactly where it is. Rows without a Zeffy id are hand-entered
by definition and are never touched.

DRY RUN IS THE DEFAULT, as with onboard.mjs. Pass --commit to write.

Usage:
    python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses
    python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses --out "<v1.xlsx>"
    python3 scripts/onboarding/budget_sync.py <roster.json>
    python3 scripts/onboarding/budget_sync.py <roster.json> --commit
    python3 scripts/onboarding/budget_sync.py <roster.json> --zeffy --commit
    python3 scripts/onboarding/budget_sync.py <roster.json> --from "<v1.xlsx>" --commit

Environment (for --zeffy):
    ZEFFY_API_KEY   read from /Volumes/Development/tiedyesamurai.org/.env
"""

import argparse
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path

import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused rather than rewritten: these are already tested, and a second
# implementation of "which student is this payment for" is exactly the kind of
# duplication that lets two answers drift apart.
from dues import months_inclusive  # noqa: E402
from build_v2 import (  # noqa: E402
    ALIASES,
    END_DATES,
    EXPENSE_COLS,
    FIRST_PAYMENT,
    INCOME_COLS,
    LAST_PAYMENT,
    MONTHLY,
    NOTE_FONT,
    ROSTER_COLS,
    START_OVERRIDES,
    collect_students,
    fetch_zeffy,
    key_of,
    load_ledger_ids,
    norm,
    norm_category,
    payment_dates,
    read_zeffy_map,
    student_answer,
    style_header,
)

DATA_BOOK = Path.home() / "Library/CloudStorage/OneDrive-STEM+C/FRC Data 2026-2027.xlsx"
LEDGER_PATH = Path.home() / "STEMC-onboarding" / "state.json"

# Carried through untouched by a values-only cell copy. That copy is why
# nothing richer than bare values can live on a preserved sheet — a formula,
# a format or a dropdown is destroyed on the next run.
#
# Expenses used to be here. It now has a real reader and a real writer, which
# is what lets the script re-apply the category dropdown every sync instead of
# breaking it.
PRESERVED = ("Zeffy Map", "Sponsors")


# ----------------------------------------------------------------- reading


def reserved_by_name():
    """
    Participant ids the ledger has reserved, keyed by the name it reserved for.

    Ids come from the ledger and nowhere else. A student who pays before
    registering with FIRST still needs an id, and if this script minted one it
    would pick the next number the ledger is *also* about to hand out — two
    people holding one id, with money attaching to whichever the sheet looked
    up first. `onboard.mjs --reserve` claims the number properly.
    """
    if not LEDGER_PATH.exists():
        return {}
    import json

    data = json.loads(LEDGER_PATH.read_text()).get("participants", {})
    return {
        norm(p["reservedName"]): p["participantId"]
        for p in data.values()
        if p.get("reservedName") and p.get("participantId")
    }


def read_roster(wb):
    """Students already in the data workbook, keyed by participant id."""
    if "Roster" not in wb.sheetnames:
        return {}
    ws = wb["Roster"]
    head = [str(c.value).strip() if c.value else "" for c in ws[1]]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        rec = dict(zip(head, row))
        pid = (rec.get("Participant ID") or "").strip()
        if pid:
            out[pid] = rec
    return out


def read_incomes(wb):
    """
    Every payment row already recorded, in order.

    Returned as plain tuples rather than cells because they are about to be
    written back into a fresh sheet: the point is to preserve what they say,
    not how they were formatted.
    """
    if "Incomes" not in wb.sheetnames:
        return []
    ws = wb["Incomes"]
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not any(v not in (None, "") for v in row):
            continue
        rows.append(list(row) + [None] * (len(INCOME_COLS) - len(row)))
    return rows


def zeffy_ids_present(rows):
    """The dedupe key. Column 6 is Zeffy Payment ID; blank means hand-entered."""
    return {str(r[5]).strip() for r in rows if r[5] not in (None, "")}


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


def overwide_expense_rows(ws):
    """
    Sheet rows carrying a value past the last spec column, which a write drops.

    Takes the worksheet rather than the parsed rows on purpose. openpyxl hands
    every row back padded to the sheet's widest row, so a length check flags
    all of them the moment one is wide — and read_expenses has already dropped
    the blank rows, so its indices no longer name sheet rows. Both of those
    turn a warning about one cell into noise about every row, which is how a
    real warning gets ignored.
    """
    out = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if any(v not in (None, "") for v in row[len(EXPENSE_COLS):]):
            out.append(i)
    return out


def parse_amount(value):
    """
    An Amount cell as a number: 0.0 when the cell is empty, None when it is
    not a number at all.

    Amounts are hand-typed from receipts, and `float(cell or 0)` died on what
    people actually type -- '$1,200.00' pasted off a receipt, 'n/a', a cell
    holding only spaces. The traceback landed after the Roster and Incomes
    lines and before any expense report, drift report, missing-id report or
    refusal, and on a --commit run after the backup had already been taken.
    It also took the *income* sync down with it: until Expenses left
    PRESERVED nothing read that sheet, so one stray cell on it could not
    stop a sync that had always worked, and then it could.

    Deliberately not lenient: '$1,200.00' is not read as 1200. build() writes
    the value back verbatim, so Excel and Power Query would still see text in
    that cell and `SUM(Expenses[Amount])` on the front page would still skip
    it. Parsing it here would make this script's total right and the front
    page's total wrong -- two totals disagreeing about the same ledger, which
    is worse than one total that says which cell it cannot read.

    An empty or whitespace-only cell is not a failure. It is the blank that
    `or 0` has always counted as zero, and a cursor landing in a cell is not
    a number someone meant to type.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def unreadable_amount_rows(ws):
    """
    Sheet rows whose Amount is not a number, so no total can include them.

    Takes the worksheet for the same reason overwide_expense_rows does: the
    report has to name the row a person must go and fix, and read_expenses
    has already dropped the blank rows, so its indices no longer name sheet
    rows. Shares parse_amount with the total in expense_report so the list
    and the total cannot disagree about which rows were counted.
    """
    out = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if not any(v not in (None, "") for v in row):
            continue
        amount = row[3] if len(row) > 3 else None
        if parse_amount(amount) is None:
            out.append(i)
    return out


def category_counts(rows):
    """
    Distinct categories and how many rows use each. Blanks are not a category.

    str() before .strip() because Category is hand-typed and a bare number is
    a plausible thing to type into it -- '2026' arrives as an int, and
    int.strip() does not exist, so the whole run died on one cell. Same
    coercion, for the same reason, as norm_category() in build_v2.
    """
    return Counter(
        str(r[2] or "").strip() for r in rows if str(r[2] or "").strip()
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


def expense_report(expense_rows, overwide=(), unreadable=()):
    """
    What the expense ledger holds right now, as lines to print.

    Returned rather than printed so it can be asserted without capturing
    stdout. Says nothing it does not have to: a clean ledger produces one
    line. `overwide` and `unreadable` are parameters rather than calls to
    overwide_expense_rows() and unreadable_amount_rows() because those need
    the worksheet, not these already-parsed rows -- this stays a pure
    function over data, so its tests need no workbook. main() supplies both
    from the sheet it has open.
    """
    amounts = [parse_amount(r[3]) for r in expense_rows]
    total = sum(a for a in amounts if a is not None)
    # The count of rows that were left out is on the total line itself, not
    # only in the block below, because a short total read on its own is the
    # failure this is guarding against.
    short = f" — {len(unreadable)} row(s) not counted, see below" if unreadable else ""
    lines = [f"  Expenses  {len(expense_rows)} row(s), ${total:,.2f}{short}"]

    counts = category_counts(expense_rows)
    if counts:
        # Distinct counts spellings, because that is what the lines beneath
        # it list -- a header that said "2 distinct" above three listed rows
        # would read as a bug. Two spellings turning out to be one category
        # is exactly what the "Possible duplicates" block below calls out.
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

    if unreadable:
        shown = ", ".join(str(i) for i in unreadable[:10])
        lines.append(f"\n  {len(unreadable)} expense row(s) have an Amount that is not a "
                     f"number: row {shown}")
        lines.append("    They are not in the total above, so it is short by whatever")
        lines.append("    they say. Type the amount as a plain number: a '$', a comma or")
        lines.append("    a word makes the cell text, which Excel's SUM skips as well.")

    if overwide:
        shown = ", ".join(str(i) for i in overwide[:10])
        lines.append(f"\n  {len(overwide)} expense row(s) have more columns than the spec "
                     f"({len(EXPENSE_COLS)}): row {shown}")
        lines.append("    Those values are dropped on write. Look at what is actually in")
        lines.append("    those columns before widening the spec around it — the live")
        lines.append("    Expenses sheet is a values-only copy of an older sheet whose")
        lines.append("    shape the spec declares unknown, so the answer is most likely")
        lines.append("    to migrate the sheet into these columns, not to add more:")
        lines.append("      python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses")
    return lines


# ----------------------------------------------------------------- students


def resolve_ids(students):
    """
    Replace any locally-minted id with the one the ledger reserved.

    A student who came from the FIRST export already carries the id the ledger
    gave them. Everyone else — billed but not registered — must have a
    reservation, or they get no id at all and are reported rather than written.
    Guessing here is how two people end up sharing a number.
    """
    reserved = reserved_by_name()
    for s in students:
        if s.get("in_first"):
            continue
        pid = reserved.get(norm(s["name"]))
        s["participant_id"] = pid or ""
        s["needs_reservation"] = not pid
    return students


def gather(args):
    """
    Everyone on the team, and where each fact came from.

    Three sources, none complete on its own: the onboarding ledger knows who
    was accepted and their participant id, FIRST knows who registered, and the
    budget knows who is paying. A student can be paying before they register
    and registered before they pay.
    """
    roster_csv = {}
    if args.roster_csv:
        import csv

        with open(args.roster_csv, encoding="utf-8") as fh:
            roster_csv = {r["Student"].strip(): r for r in csv.DictReader(fh) if r.get("Student")}

    # First build seeds from v1, which is the only place the historical roster
    # block and its payments exist.
    if args.seed_from:
        _, students = collect_students(args.seed_from, roster_csv)
        return {(s["participant_id"] or f"?{s['name']}"): s for s in resolve_ids(students)}

    wb = openpyxl.load_workbook(DATA_BOOK, data_only=True) if DATA_BOOK.exists() else None
    existing = read_roster(wb) if wb else {}

    students = {}
    for pid, rec in existing.items():
        students[pid] = {
            "participant_id": pid,
            "name": (rec.get("Student") or "").strip(),
            "in_budget": True,
            "in_first": str(rec.get("FIRST") or "").strip().lower() in ("yes", "true", "1"),
            "grade": rec.get("Grade") or "",
            "autopay": rec.get("Autopay") or "",
            "packet": rec.get("Packet") or "",
            **{
                k: rec.get(h) or ""
                for k, h in (
                    ("parent1", "Parent 1"),
                    ("parent1_phone", "Parent 1 Phone"),
                    ("parent1_email", "Parent 1 Email"),
                    ("parent2", "Parent 2"),
                    ("parent2_phone", "Parent 2 Phone"),
                    ("parent2_email", "Parent 2 Email"),
                    ("student_email", "Student Email"),
                    ("student_phone", "Student Phone"),
                )
            },
        }

    # FIRST/Jotform contacts win over whatever the sheet last held: they are
    # re-exported per run and the sheet is a copy.
    for name, row in roster_csv.items():
        pid = (row.get("Participant ID") or "").strip()
        if not pid:
            continue
        s = students.setdefault(pid, {"participant_id": pid, "name": name, "in_budget": False})
        s["in_first"] = True
        s["name"] = name
        for k, h in (
            ("grade", "Grade"),
            ("parent1", "Parent 1"),
            ("parent1_phone", "Parent 1 Phone"),
            ("parent1_email", "Parent 1 Email"),
            ("parent2", "Parent 2"),
            ("parent2_phone", "Parent 2 Phone"),
            ("parent2_email", "Parent 2 Email"),
            ("student_email", "Student Email"),
            ("student_phone", "Student Phone"),
            ("packet", "Packet"),
        ):
            if row.get(h):
                s[k] = row[h]

    # Start dates, most authoritative first: the ledger (set with
    # `onboard.mjs --set-start`), then the declared overrides, then the season
    # opening. Never inferred — a wrong start date is a wrong bill.
    ledger = load_ledger_ids()
    for pid, s in students.items():
        entry = ledger.get(pid) or {}
        if entry.get("startDate"):
            s["start"] = date.fromisoformat(entry["startDate"])
        elif s["name"] in START_OVERRIDES:
            s["start"] = START_OVERRIDES[s["name"]]
        else:
            s["start"] = FIRST_PAYMENT
        s["end"] = END_DATES.get(s["name"])

    return students


# ------------------------------------------------------------------ zeffy


def new_zeffy_rows(students, seen_ids, zmap):
    """Zeffy payments not already in the ledger, attributed to a participant id."""
    by_name = {norm(s["name"]): s for s in students.values()}
    # Zeffy carries whatever a parent typed into the form, which is not always
    # what FIRST calls the student — "Arion Takas" and "Ari Takas" are one boy.
    # The aliases are declared in roster-overrides.json rather than inferred:
    # matching on last-name-plus-initial would also merge two real siblings,
    # and declared beats inferred when the thing being merged is money.
    for alias, real in ALIASES.items():
        target = by_name.get(norm(real))
        if target:
            by_name.setdefault(norm(alias), target)
    # Third value is the other team's income: both teams take money through one
    # Zeffy account, so the campaign is the only thing separating Samurai's
    # money from the Jedi's. Reported rather than dropped silently.
    payments, subs, other_team = fetch_zeffy("samurai")
    rows, unmatched, skipped = [], [], 0

    for p in sorted(payments, key=lambda p: p["created"]):
        if str(p["id"]) in seen_ids:
            skipped += 1
            continue
        when = datetime.fromtimestamp(p["created"]).date()
        amount = p["amount"] / 100
        buyer = p.get("buyer") or {}
        email = (buyer.get("email") or "").strip().lower()
        typed = student_answer(p)

        if typed:
            targets = [(typed, 1.0)]
        elif email in zmap:
            targets = zmap[email]
        else:
            targets = [("", 1.0)]

        legacy = p["_campaign"].get("legacy", False)
        for name, share in targets:
            match = by_name.get(norm(name)) if name else None
            if name and not match:
                unmatched.append((when, name, amount * share))
            if legacy:
                note = "2025-26 arrears, not this season"
            elif not name:
                hint = f"{buyer.get('first_name','?')[:1]}.{buyer.get('last_name','?')[:1]}."
                note = f"no student named — needs a Zeffy Map rule for {hint}"
            elif not match:
                note = f"no roster match for {name!r}"
            elif share != 1.0:
                note = f"{share:.0%} of a combined payment"
            else:
                note = ""
            # Arrears and unattributable money carry no id on purpose: dues key
            # on the id, so a blank keeps them out of this season's balances
            # while leaving them visible in the ledger total.
            rows.append(
                [
                    when,
                    match["participant_id"] if (match and not legacy) else "",
                    name or buyer.get("full_name") or "(unidentified)",
                    p["_campaign"]["type"],
                    round(amount * share, 2),
                    p["id"],
                    note,
                ]
            )
    return rows, unmatched, skipped, subs, other_team


# ------------------------------------------------------------------ write


def months_owed(start, end, today):
    """
    Payments due by today for one student.

    Defers to dues.months_inclusive so this script, dues_texts.py and the sync
    report cannot disagree about whether the start month counts. It does — a
    student joining on the 1st owes for that month — and being wrong here is
    wrong by $215 per family.
    """
    last = min(end or LAST_PAYMENT, LAST_PAYMENT, today)
    if not start or last < start:
        return 0
    return months_inclusive(start, last)


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
        showDropDown=False,
    )
    ws.add_data_validation(dv)
    dv.add(f"C2:C{CATEGORY_VALIDATION_ROWS}")


def build(students, income_rows, expense_rows):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    ws = wb.create_sheet("Roster")
    style_header(ws, ROSTER_COLS)
    for r, s in enumerate(sorted(students.values(), key=lambda s: s["participant_id"]), start=2):
        ws.cell(r, 1, s["participant_id"])
        ws.cell(r, 2, s["name"])
        ws.cell(r, 3, key_of(s["name"]))
        ws.cell(r, 4, s.get("grade") or None)
        ws.cell(r, 5, s.get("start") or FIRST_PAYMENT).number_format = "yyyy-mm-dd"
        if s.get("end"):
            ws.cell(r, 6, s["end"]).number_format = "yyyy-mm-dd"
        ws.cell(r, 7, s.get("autopay") or "")
        ws.cell(r, 8, "yes" if s.get("in_first") else "no")
        ws.cell(r, 9, s.get("packet") or "")
        for i, k in enumerate(
            ("parent1", "parent1_phone", "parent1_email", "parent2", "parent2_phone",
             "parent2_email", "student_email", "student_phone"),
            start=10,
        ):
            ws.cell(r, i, s.get(k) or "")

    ws = wb.create_sheet("Incomes")
    style_header(ws, INCOME_COLS)
    for r, row in enumerate(income_rows, start=2):
        when = row[0]
        ws.cell(r, 1, when.date() if isinstance(when, datetime) else when).number_format = "yyyy-mm-dd"
        for c in (2, 3, 4):
            ws.cell(r, c, row[c - 1] if row[c - 1] is not None else "")
        ws.cell(r, 5, row[4]).number_format = '"$"#,##0.00'
        ws.cell(r, 6, row[5] if row[5] is not None else "")
        ws.cell(r, 7, row[6] if row[6] is not None else "")

    ws = wb.create_sheet("Schedule")
    style_header(ws, [("Payment Date", 14), ("Amount", 10)])
    for r, d in enumerate(payment_dates(), start=2):
        ws.cell(r, 1, d).number_format = "yyyy-mm-dd"
        ws.cell(r, 2, MONTHLY).number_format = '"$"#,##0'

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

    return wb


def carry_over(wb, source):
    """Copy the hand-maintained sheets across, values only."""
    if not source or not Path(source).exists():
        return []
    src = openpyxl.load_workbook(source, data_only=True)
    done = []
    for name in PRESERVED:
        if name not in src.sheetnames:
            continue
        s_ws, d_ws = src[name], wb.create_sheet(name)
        for row in s_ws.iter_rows():
            for c in row:
                if c.value is not None:
                    d_ws.cell(c.row, c.column, c.value)
        done.append(f"{name} ({s_ws.max_row - 1} rows)")
    return done


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


def v1_expenses_refusal(seed_from, expense_rows):
    """
    Lines refusing a first build that would silently drop v1's expenses, or
    [] when there is nothing to refuse.

    Expenses came out of PRESERVED so that build() could write real formats
    and a real dropdown instead of a values-only copy -- but that also means
    a first build's expense rows come only from read_expenses(out), and on a
    first build `out` does not exist yet, so they are empty. Incomes has an
    explicit seeding block for exactly this situation; Expenses does not,
    because the live sheet's column shape is not established (see
    dump_sheet's docstring) and guessing a mapping here would be an
    improvisation, not a migration. So when v1 actually holds expense rows
    and this build has none, refuse instead of writing an Expenses sheet
    that quietly has none of them either.

    Loads v1 itself rather than taking a workbook, unlike the other
    predicates in this module: main() only opens v1 for the Incomes seed
    block, which runs when `income_rows` is empty -- a different condition
    from this one -- so there is no workbook already in hand on this code
    path to pass in, and threading one through main() would add a parameter
    that exists for this one caller alone.
    """
    if not seed_from or expense_rows:
        return []
    v1 = openpyxl.load_workbook(seed_from, data_only=True)
    try:
        if "Expenses" not in v1.sheetnames:
            return []
        # Not max_row - 1: openpyxl's bounding box includes rows that carry
        # only a border or a stray formatted-but-empty cell, which is not
        # the same question as "how many expense rows are here" -- the same
        # gap read_expenses() already closes for the real reader, by
        # skipping any row with nothing in it.
        n = len(read_expenses(v1))
        if not n:
            return []
        return [
            f"\nRefusing to write: {seed_from} carries {n} expense row(s) that "
            "this build would drop.\n",
            "    There is no flag that overrides this and nothing to re-run: carrying",
            "    them across means writing a seed block for Expenses, the way Incomes",
            "    already has one, and that is a code change. It cannot be written",
            "    until the sheet's real shape is known, so look at that first:",
            f'    python3 scripts/onboarding/budget_sync.py --dump-sheet Expenses --out "{seed_from}"\n',
        ]
    finally:
        v1.close()


# ------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roster", nargs="?", help="FIRST roster export (.json), via roster_sheet.py")
    ap.add_argument("--roster-csv", help="roster_sheet.py output, for contacts")
    ap.add_argument("--from", dest="seed_from", help="v1 workbook to seed the first build from")
    ap.add_argument("--zeffy", action="store_true", help="pull new payments from the Zeffy API")
    ap.add_argument("--out", default=str(DATA_BOOK))
    ap.add_argument("--commit", action="store_true", help="write; otherwise dry run")
    ap.add_argument("--dump-sheet", metavar="NAME",
                    help="print a sheet's shape and exit; reads only, writes nothing")
    args = ap.parse_args()

    out = Path(args.out)
    # Before gather(), which needs a roster and exits without one. Inspecting a
    # workbook must not require knowing who is on the team.
    if args.dump_sheet:
        dump_sheet(out, args.dump_sheet)
        return
    students = gather(args)
    if not students:
        sys.exit("\nNo students found. Pass --roster-csv, or --from on the first build.\n")

    existing_wb = openpyxl.load_workbook(out, data_only=True) if out.exists() else None
    income_rows = read_incomes(existing_wb) if existing_wb else []
    # Carried through as-is. Ingesting *new* expenses (receipts, a
    # Zeffy-style feed) is not this script's job -- this just has to stop
    # clobbering what is already on the sheet.
    expense_rows = read_expenses(existing_wb) if existing_wb else []
    # Computed here, where the worksheet is in hand: overwide_expense_rows
    # needs the actual sheet, not expense_rows, which has already dropped
    # blank rows and padded everything to EXPENSE_COLS width -- a length
    # check on it would flag nothing, or (padded) everything.
    overwide = (
        overwide_expense_rows(existing_wb["Expenses"])
        if existing_wb and "Expenses" in existing_wb.sheetnames
        else []
    )
    # Same reason, same place: the report has to name the sheet row someone
    # has to go and retype, and only the worksheet knows those numbers.
    unreadable = (
        unreadable_amount_rows(existing_wb["Expenses"])
        if existing_wb and "Expenses" in existing_wb.sheetnames
        else []
    )
    seen = zeffy_ids_present(income_rows)

    # First build with --from: bring v1's payment history across, once.
    seeded = 0
    if args.seed_from and not income_rows:
        src = openpyxl.load_workbook(args.seed_from, data_only=True)
        by_key = {key_of(s["name"]): s for s in students.values()}
        for r in range(2, src["Incomes"].max_row + 1):
            d, who, typ, amt = (src["Incomes"].cell(r, c).value for c in (1, 2, 3, 4))
            if not d or amt in (None, "", 0):
                continue
            m = by_key.get(str(who).strip()) if who else None
            income_rows.append(
                [d, m["participant_id"] if m else "", str(who or ""), typ or "", amt,
                 src["Incomes"].cell(r, 6).value or "", src["Incomes"].cell(r, 5).value or ""]
            )
            seeded += 1
        seen = zeffy_ids_present(income_rows)

    added, unmatched, skipped, subs, other_team = [], [], 0, {}, {}
    if args.zeffy:
        zmap = read_zeffy_map(existing_wb or (openpyxl.load_workbook(args.seed_from) if args.seed_from else None))
        added, unmatched, skipped, subs, other_team = new_zeffy_rows(students, seen, zmap or {})

    print(f"\nData workbook: {out}")
    print(f"Mode:          {'COMMIT' if args.commit else 'dry run — nothing will be written'}\n")
    print(f"  Roster    {len(students)} students")
    if seeded:
        print(f"  Incomes   {seeded} payment(s) carried over from {Path(args.seed_from).name}")
    print(f"  Incomes   {len(income_rows)} existing + {len(added)} new"
          + (f", {skipped} already present" if skipped else ""))

    hand = [r for r in income_rows if not r[5]]
    if hand:
        print(f"            {len(hand)} hand-entered (no Zeffy id) — never rewritten")

    for line in expense_report(expense_rows, overwide, unreadable):
        print(line)

    # ── who looks wrong ─────────────────────────────────────────────────────
    today = date.today()
    paid = defaultdict(float)
    for r in income_rows + added:
        if r[1]:
            paid[str(r[1]).strip()] += float(r[4] or 0)

    billed_not_reg = [s["name"] for s in students.values() if s.get("in_budget") and not s.get("in_first")]
    reg_not_billed = [s["name"] for s in students.values() if s.get("in_first") and not s.get("in_budget")]

    # The Venmo flag. A student who owes money and has paid nothing at all is
    # either genuinely behind or paid on a rail nobody recorded — and the second
    # is why a family who had paid got chased. Worth looking at before chasing.
    nothing_at_all = []
    for pid, s in students.items():
        # Someone with no id yet cannot hold a payment, so "paid nothing" tells
        # you about the missing reservation, not about the family. They are
        # already reported above; saying it twice reads as two problems.
        if s.get("needs_reservation"):
            continue
        owed = months_owed(s.get("start") or FIRST_PAYMENT, s.get("end"), today) * MONTHLY
        if owed > 0 and paid.get(pid, 0) == 0:
            nothing_at_all.append(f"{pid} {s['name']} (owes ${owed:,})")

    def block(title, items):
        if items:
            print(f"\n  {title} ({len(items)}):")
            for i in items:
                print(f"    {i}")

    # An id that this script invented would sooner or later collide with one
    # the ledger hands out, and the collision is invisible: two students, one
    # number, money attaching to whichever the sheet resolves first. So stop.
    unreserved = sorted(s["name"] for s in students.values() if s.get("needs_reservation"))
    if unreserved:
        print(f"\n  No participant id ({len(unreserved)}) — reserve one before writing:")
        for n in unreserved:
            print(f'    node scripts/onboarding/onboard.mjs --reserve "{n}"')
        print("    Ids come from the ledger so the budget and onboarding cannot")
        print("    hand the same number to two different students.")

    block("Billed but not registered with FIRST", sorted(billed_not_reg))
    block("Registered but not in the dues ledger", sorted(reg_not_billed))
    block("Owes money, nothing recorded — check for a Venmo or cash payment", sorted(nothing_at_all))
    if other_team:
        block("Excluded — the other team's Zeffy income, not this budget",
              [f"${a:>9,.2f}  {t}" for t, a in sorted(other_team.items(), key=lambda kv: -kv[1])])

    if unmatched:
        block("Payments that could not be attributed", [f"{w}  ${a:,.2f}  {n!r}" for w, n, a in unmatched[:12]])
        print("    These are in the ledger with no id — visible, counted against nobody.")
        print("    Add a rule to the Zeffy Map sheet.")

    if unreserved:
        print(f"\nRefusing to write: {len(unreserved)} student(s) have no participant id.\n")
        sys.exit(1)

    # Refuse rather than warn, for the same reason the missing-id case
    # refuses: the failure is silent. A value in column I is simply gone
    # after the next sync, and nobody reviews a sheet they believe a script
    # maintains.
    if overwide:
        print(f"\nRefusing to write: {len(overwide)} expense row(s) carry columns "
              f"the spec would drop.\n")
        sys.exit(1)

    # Refused rather than warned, for the same reason one step removed. The
    # row itself survives the write — nothing a person typed is lost — but it
    # lands back in the sheet as text, so `SUM(Expenses[Amount])` on the
    # analysis workbook's front page skips it exactly as the total above did.
    # The visible result is a plausible-looking total that is short, in the
    # one place nobody re-adds by hand. That is the silent failure; the report
    # above has already named the rows, so the fix is a cell, not a flag.
    if unreadable:
        print(f"\nRefusing to write: {len(unreadable)} expense row(s) have an Amount "
              f"that is not a number.\n")
        sys.exit(1)

    v1_refusal = v1_expenses_refusal(args.seed_from, expense_rows)
    if v1_refusal:
        for line in v1_refusal:
            print(line)
        sys.exit(1)

    if not args.commit:
        print(f"\nDry run — pass --commit to write {out.name}.\n")
        return

    if out.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = out.with_name(f"{out.stem}.backup-{stamp}{out.suffix}")
        shutil.copy2(out, backup)
        print(f"\nBacked up to {backup.name}")

    wb = build(students, income_rows + added, expense_rows)
    carried = carry_over(wb, args.seed_from if args.seed_from else (out if out.exists() else None))
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)

    print(f"Wrote {out}")
    if carried:
        print("  carried over: " + ", ".join(carried))
    print()


if __name__ == "__main__":
    main()
