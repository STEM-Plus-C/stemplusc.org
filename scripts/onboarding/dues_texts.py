#!/usr/bin/env python3
"""
Draft a payment-status text for each family, ready to send from your phone.

Reads the data workbook — Roster for who exists and their phone numbers,
Incomes for what they have paid — and computes dues through dues.compute(), the
same function the sync report uses. Nothing here works out a balance of its own:
telling a family a number the sheet disagrees with is worse than telling them
nothing.

It used to read a "Dues Status" sheet by column position, which was wrong twice
over. That sheet is gone, and positional reads are what let a row insertion
reattribute someone's money.

Phone numbers come from the Roster, so no FIRST export is needed. Whoever last
ran budget_sync.py already fetched them.

It sends nothing and changes nothing. Reading a text before it goes out is the
point: these are conversations about money with families you know, and a
generated message you have not read is not one you should send.

Usage:
    python3 scripts/onboarding/dues_texts.py
    python3 scripts/onboarding/dues_texts.py --status Behind
    python3 scripts/onboarding/dues_texts.py --all
    python3 scripts/onboarding/dues_texts.py --book "<FRC Data 2026-2027.xlsx>"

By default only families who owe something are shown — Current families need no
text. `--all` includes everyone.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dues import DATA_BOOK, compute  # noqa: E402

PORTAL = "https://www.zeffy.com/en-US/ticketing/tie-dye-samurai-season-fees"
TEAM = "Tie Dye Samurai"
COACH = "Steven"

def money(n):
    return f"${n:,.0f}"


def message(entry, parent_first, student_first):
    """
    Tone shifts with how far behind they are, but never becomes a demand.
    Every version says the same thing at the end: talk to us. That is the line
    from the dues email and the team agreement, and it should not go missing
    the one time money is actually the subject.
    """
    owed = abs(entry["balance"])
    who = parent_first or "there"
    kid = student_first or "your student"

    if entry["status"].lower() == "current":
        return (
            f"Hi {who} — just a note that {kid}'s {TEAM} dues are all up to date. "
            f"Thank you, it genuinely helps us plan. — {COACH}"
        )

    if entry["months_behind"] >= 2:
        return (
            f"Hi {who} — checking in on {TEAM} dues for {kid}. We're showing "
            f"{money(owed)} outstanding ({entry['months_behind']} payments). "
            f"You can catch up here: {PORTAL}\n\n"
            f"If the timing is difficult right now, just tell me — we can work "
            f"something out, and I'd much rather sort it than have it become a "
            f"problem. — {COACH}"
        )

    return (
        f"Hi {who} — quick reminder that {kid}'s {TEAM} dues are showing "
        f"{money(owed)} behind (one payment). Here's the link when you get a "
        f"moment: {PORTAL}\n\n"
        f"If something's changed on your end, just let me know. — {COACH}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", default=str(DATA_BOOK), help="the data workbook")
    ap.add_argument("--status", help="only this status (Behind, Watch, CRITICAL, Current)")
    ap.add_argument("--all", action="store_true", help="include families who are current")
    args = ap.parse_args()

    if not Path(args.book).exists():
        sys.exit(f"\nNo data workbook at {args.book}\nRun budget_sync.py first.\n")

    dues = compute(args.book)

    if args.status:
        dues = [d for d in dues if d["status"].lower() == args.status.lower()]
    elif not args.all:
        # Owing money is the only reason to send one of these unprompted.
        dues = [d for d in dues if d["balance"] < 0]

    dues.sort(key=lambda d: (d["balance"], d["participant_id"]))

    no_phone = []
    for d in dues:
        student = d["full_name"] or d["participant_id"]
        parent = d["parent"]
        phone = d["parent_phone"] or d["parent2_phone"]
        if not phone:
            no_phone.append(student)

        print("=" * 72)
        print(f"{student}   [{d['status']}]   {d['participant_id']}")
        print(
            f"  paid {money(d['paid'])} of {money(d['owed'])} owed"
            + (f"   ·   {money(abs(d['balance']))} behind"
               f"   ·   {d['months_behind']} month(s)" if d["balance"] < 0 else
               f"   ·   {money(d['balance'])} ahead")
        )
        if d["last_payment"]:
            print(f"  last payment {d['last_payment'].isoformat()}")
        else:
            print("  no payments recorded this season")
        print(f"  text: {phone or '— no phone on file —'}"
              f"{('   (' + parent + ')') if parent else ''}")
        print("-" * 72)
        print(message(d, parent.split(" ")[0] if parent else "", student.split(" ")[0]))
        print()

    print("=" * 72)
    print(f"\n{len(dues)} family(ies) listed.")
    if no_phone:
        print(
            f"\n{len(no_phone)} have no phone on the Roster, usually because they have\n"
            f"not re-registered through FIRST for this season:\n  " + "\n  ".join(no_phone)
        )
        print(
            "\nTheir numbers are in your phone already — the message above is still\n"
            "the useful part. They land on the Roster once they register."
        )
    print()


if __name__ == "__main__":
    main()
