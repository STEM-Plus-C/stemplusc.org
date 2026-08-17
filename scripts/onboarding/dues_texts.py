#!/usr/bin/env python3
"""
Draft a payment-status text for each family, ready to send from your phone.

Reads the Dues Status sheet from the budget — the authority on who owes what —
and pairs it with phone numbers from a FIRST roster export where one exists.
Prints a per-family block: name, status, phone, and a message you can copy
straight into Messages.

It sends nothing and changes nothing. Reading a text before it goes out is the
point: these are conversations about money with families you know, and a
generated message you have not read is not one you should send.

Usage:
    python3 scripts/onboarding/dues_texts.py <budget.xlsx> [--roster <roster.json>]
    python3 scripts/onboarding/dues_texts.py <budget.xlsx> --status Behind
    python3 scripts/onboarding/dues_texts.py <budget.xlsx> --all

By default only families who owe something are shown — Current families need no
text. `--all` includes everyone.

No third-party libraries: an .xlsx is a zip of XML, and the standard library
reads both.
"""

import argparse
import html
import re
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path

PORTAL = "https://www.zeffy.com/en-US/ticketing/tie-dye-samurai-season-fees"
TEAM = "Tie Dye Samurai"
COACH = "Steven"

# Excel's day zero, with the 1900 leap-year bug that Excel preserves.
EXCEL_EPOCH = date(1899, 12, 30)


def excel_date(value):
    try:
        return EXCEL_EPOCH + timedelta(days=int(float(value)))
    except (TypeError, ValueError):
        return None


def money(n):
    return f"${n:,.0f}"


def read_sheet(xlsx_path, wanted_sheet):
    """Return {row_number: {column_letter: value}} for one sheet."""
    z = zipfile.ZipFile(xlsx_path)

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        raw = z.read("xl/sharedStrings.xml").decode("utf-8", "replace")
        shared = [
            html.unescape(re.sub(r"<[^>]+>", "", m))
            for m in re.findall(r"<si>(.*?)</si>", raw, re.S)
        ]

    workbook = z.read("xl/workbook.xml").decode("utf-8", "replace")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8", "replace")
    targets = dict(
        re.findall(r'Id="rId(\d+)"[^>]*Target="(worksheets/sheet\d+\.xml)"', rels)
    )
    sheets = re.findall(r'<sheet name="([^"]+)"[^>]*r:id="rId(\d+)"', workbook)

    path = next((targets[rid] for name, rid in sheets if name == wanted_sheet), None)
    if not path:
        sys.exit(
            f"\nNo sheet named {wanted_sheet!r} in that workbook.\n"
            f"Found: {', '.join(n for n, _ in sheets)}\n"
        )

    xml = z.read("xl/" + path).decode("utf-8", "replace")
    rows = {}
    for cell in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>', xml, re.S):
        col, row, attrs, body = cell.groups()
        value = re.search(r"<v>(.*?)</v>", body, re.S)
        if not value:
            continue
        text = value.group(1)
        if 't="s"' in attrs:
            idx = int(text)
            text = shared[idx] if idx < len(shared) else text
        rows.setdefault(int(row), {})[col] = text
    return rows


def load_dues(xlsx_path):
    """
    Columns: A Student, B Key, C Start, D Paid, E Owed, F Over/Under,
    G Months Behind, H Last Payment, J Status.

    Column B (the short key) is the reliable identifier — column A is populated
    only on the first row in the sheet as it stands.
    """
    rows = read_sheet(xlsx_path, "Dues Status")
    out = []
    for n in sorted(rows):
        if n == 1:
            continue
        r = rows[n]
        key = (r.get("B") or "").strip()
        if not key or key in {"0"}:
            continue
        status = (r.get("J") or "").strip()
        if not status:
            continue
        out.append(
            {
                "key": key,
                "full_name": (r.get("A") or "").strip() or None,
                "paid": float(r.get("D") or 0),
                "owed": float(r.get("E") or 0),
                "balance": float(r.get("F") or 0),
                "months_behind": int(float(r.get("G") or 0)),
                "last_payment": excel_date(r.get("H")),
                "status": status,
            }
        )
    return out


def load_roster_phones(path):
    """Map 'First L' -> {student, parent, parent_phone} from a FIRST export."""
    import json

    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    if raw.lstrip().startswith("<") or "var ContactRosterModel" in raw:
        m = re.search(r"var\s+ContactRosterModel\s*=\s*", raw)
        if not m:
            return {}
        start = raw.index("{", m.end() - 1)
        depth, in_str, esc = 0, False, False
        for i in range(start, len(raw)):
            c = raw[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    data = json.loads(raw[start : i + 1])
                    break
        else:
            return {}
    else:
        data = json.loads(raw)

    model = data.get("ContactRoster", data)
    records, aliases = {}, {}
    for s in model.get("TeamStudents", []):
        legal = (s.get("name_first") or "").strip()
        nick = (s.get("nickname_first") or "").strip()
        last = (s.get("name_last") or "").strip()
        if not legal:
            continue
        canonical = key_for(legal, last)
        records[canonical] = {
            "student": f"{legal} {last}".strip(),
            "parent": " ".join(
                x for x in [s.get("parent_name_first"), s.get("parent_name_last")] if x
            ).strip(),
            "parent_phone": normalize_phone(s.get("parent_phone")),
            "parent_email": (s.get("parent_email") or "").strip(),
        }
        # The budget sheet uses whatever name the coach types — often the
        # preferred one. "Zack R" and "Zachary R" are the same family.
        for k in {canonical, key_for(nick, last)}:
            if k:
                aliases[k] = canonical
    return records, aliases


def load_jotform_phones(form_id, api_key):
    """
    Phone numbers from completed registration packets.

    A better source than FIRST for anyone who has registered: parent1_phone is
    required on the form, whereas FIRST leaves it blank more often than not.
    """
    import json
    import urllib.request

    url = f"https://api.jotform.com/form/{form_id}/submissions?limit=1000"
    req = urllib.request.Request(url, headers={"APIKEY": api_key, "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as exc:  # network, auth, anything
        print(f"  (could not read Jotform submissions: {exc})\n", file=sys.stderr)
        return {}

    phones = {}
    for sub in payload.get("content") or []:
        if str(sub.get("status", "")).upper() == "DELETED":
            continue
        answers = {}
        for a in (sub.get("answers") or {}).values():
            name, val = a.get("name"), a.get("answer")
            if not name or val is None:
                continue
            if isinstance(val, dict):
                val = " ".join(str(v) for v in val.values() if v).strip()
            answers[name] = str(val).strip()

        first = answers.get("student_first", "")
        last = answers.get("student_last", "")
        if not first:
            continue
        key = key_for(first, last)
        phones[key] = {
            "student": f"{first} {last}".strip(),
            "parent": " ".join(
                x for x in [answers.get("parent1_first"), answers.get("parent1_last")] if x
            ).strip(),
            "parent_phone": normalize_phone(answers.get("parent1_phone")),
            "parent_email": answers.get("parent1_email", ""),
        }
    return phones


def key_for(first, last):
    """'Zachary', 'Randall' -> 'zachary r'. Empty first name yields nothing."""
    first = (first or "").strip()
    last = (last or "").strip()
    return f"{first} {last[:1]}".strip().lower() if first else ""


def normalize_phone(raw):
    if not raw:
        return ""
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 10:
        return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"
    if len(digits) == 11 and digits[0] == "1":
        return f"{digits[1:4]}-{digits[4:7]}-{digits[7:]}"
    return str(raw).strip()


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
    ap.add_argument("budget", help="FRC Budget 2026-2027.xlsx")
    ap.add_argument("--roster", help="FIRST roster export, for phone numbers")
    ap.add_argument(
        "--jotform",
        action="store_true",
        help="also read phones from submitted packets (needs JOTFORM_API_KEY "
        "and JOTFORM_FORM_SAMURAI)",
    )
    ap.add_argument("--status", help="only this status (Behind, Watch, Current)")
    ap.add_argument("--all", action="store_true", help="include families who are current")
    args = ap.parse_args()

    dues = load_dues(args.budget)

    # FIRST first, then let submitted packets overwrite it — a family that
    # completed registration gave us a phone they had to fill in, which beats
    # whatever FIRST happened to hold.
    records, aliases = load_roster_phones(args.roster) if args.roster else ({}, {})
    if args.jotform:
        import os

        key = os.environ.get("JOTFORM_API_KEY")
        form = os.environ.get("JOTFORM_FORM_SAMURAI")
        if not key or not form:
            sys.exit("\nJOTFORM_API_KEY and JOTFORM_FORM_SAMURAI must be set for --jotform.\n")
        for k, v in load_jotform_phones(form, key).items():
            if not v.get("parent_phone"):
                continue
            canonical = aliases.get(k, k)
            records.setdefault(canonical, {}).update(v)
            aliases.setdefault(k, canonical)

    if args.status:
        dues = [d for d in dues if d["status"].lower() == args.status.lower()]
    elif not args.all:
        dues = [d for d in dues if d["balance"] < 0]

    dues.sort(key=lambda d: (d["balance"], d["key"]))

    no_phone = []
    for d in dues:
        match = records.get(aliases.get(d["key"].lower(), d["key"].lower()), {})
        student = match.get("student") or d["full_name"] or d["key"]
        parent = match.get("parent") or ""
        phone = match.get("parent_phone") or ""
        if not phone:
            no_phone.append(student)

        print("=" * 72)
        print(f"{student}   [{d['status']}]")
        print(
            f"  paid {money(d['paid'])} of {money(d['owed'])} owed"
            f"   ·   {money(abs(d['balance']))} behind"
            f"   ·   {d['months_behind']} month(s)"
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
            f"\n{len(no_phone)} have no phone number on file, because they have not "
            f"re-registered\nthrough FIRST for this season:\n  "
            + "\n  ".join(no_phone)
        )
        print(
            "\nTheir numbers are in your phone already — the message above is still\n"
            "the useful part. Their numbers land here automatically once they register."
        )
    print()


if __name__ == "__main__":
    main()
