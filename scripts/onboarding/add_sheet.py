#!/usr/bin/env python3
"""
Add (or replace) a worksheet in an .xlsx from a CSV, preserving everything else.

Written instead of using openpyxl because openpyxl rewrites the whole workbook
and **drops charts** when it does. The budget has one. This rebuilds the zip
part by part, copying every existing entry byte-for-byte and touching only the
four places a new sheet has to be registered:

    xl/worksheets/sheetN.xml   the sheet itself
    xl/workbook.xml            the sheet list
    xl/_rels/workbook.xml.rels the relationship
    [Content_Types].xml        the content-type override

Cell values are written as inline strings, so sharedStrings.xml is never
touched either — one less shared part to corrupt.

Usage:
    python3 scripts/onboarding/add_sheet.py <book.xlsx> <data.csv> --name Roster
    python3 scripts/onboarding/add_sheet.py <book.xlsx> <data.csv> --name Roster --dry-run

Always writes a timestamped backup next to the workbook before modifying it.
Close the file in Excel first — writing underneath an open workbook invites a
sync conflict, especially in OneDrive.
"""

import argparse
import csv
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SHEET_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"


def esc(v):
    return (
        str(v)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def col_letter(i):
    """0 -> A, 25 -> Z, 26 -> AA."""
    out = ""
    i += 1
    while i:
        i, rem = divmod(i - 1, 26)
        out = chr(65 + rem) + out
    return out


def is_number(v):
    return bool(re.fullmatch(r"-?\d+(\.\d+)?", (v or "").strip()))


def sheet_xml(rows):
    """A minimal worksheet. Numbers stay numeric; everything else is inline text."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        f'<worksheet xmlns="{NS}"><sheetData>',
    ]
    for r, row in enumerate(rows, start=1):
        parts.append(f'<row r="{r}">')
        for c, val in enumerate(row):
            if val is None or val == "":
                continue
            ref = f"{col_letter(c)}{r}"
            if is_number(val):
                parts.append(f'<c r="{ref}"><v>{esc(val)}</v></c>')
            else:
                parts.append(
                    f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{esc(val)}</t></is></c>'
                )
        parts.append("</row>")
    parts.append("</sheetData></worksheet>")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("csv_file")
    ap.add_argument("--name", required=True, help="sheet name")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    book = Path(args.workbook)
    if not book.exists():
        sys.exit(f"\nNo such workbook: {book}\n")

    rows = list(csv.reader(Path(args.csv_file).open(encoding="utf-8")))
    if not rows:
        sys.exit("\nThat CSV is empty.\n")

    zin = zipfile.ZipFile(book)
    names = zin.namelist()

    workbook_xml = zin.read("xl/workbook.xml").decode("utf-8")
    rels_xml = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    types_xml = zin.read("[Content_Types].xml").decode("utf-8")

    existing = re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', workbook_xml)
    replacing = any(n == args.name for n, _ in existing)

    # Pick identifiers that cannot collide with anything already in the file.
    used_rids = {int(m) for m in re.findall(r'Id="rId(\d+)"', rels_xml)}
    used_ids = {int(m) for m in re.findall(r'sheetId="(\d+)"', workbook_xml)}
    used_files = {int(m) for m in re.findall(r"xl/worksheets/sheet(\d+)\.xml", " ".join(names))}
    rid = f"rId{max(used_rids, default=0) + 1}"
    sheet_id = max(used_ids, default=0) + 1
    sheet_file = f"xl/worksheets/sheet{max(used_files, default=0) + 1}.xml"

    if replacing:
        # Reuse the existing part so nothing else has to be rewired.
        old_rid = next(r for n, r in existing if n == args.name)
        target = re.search(
            rf'<Relationship Id="{old_rid}"[^>]*Target="([^"]+)"', rels_xml
        )
        if target:
            sheet_file = "xl/" + target.group(1).lstrip("/")
            rid = old_rid

    print(f"\n  workbook   {book.name}")
    print(f"  sheet      {args.name}  ({'replacing' if replacing else 'new'})")
    print(f"  data       {len(rows)} row(s) x {max(len(r) for r in rows)} column(s)")
    print(f"  part       {sheet_file}   {rid}   sheetId={sheet_id}")
    print(f"  preserved  {len(names)} existing part(s), including "
          f"{sum(1 for n in names if 'chart' in n)} chart(s)")

    if args.dry_run:
        print("\n  --dry-run: nothing written.\n")
        return

    backup = book.with_name(
        f"{book.stem}.backup-{datetime.now():%Y%m%d-%H%M%S}{book.suffix}"
    )
    shutil.copy2(book, backup)
    print(f"  backup     {backup.name}")

    if not replacing:
        workbook_xml = workbook_xml.replace(
            "</sheets>",
            f'<sheet name="{esc(args.name)}" sheetId="{sheet_id}" r:id="{rid}"/></sheets>',
        )
        rels_xml = rels_xml.replace(
            "</Relationships>",
            f'<Relationship Id="{rid}" Type="{REL_NS}/worksheet" '
            f'Target="{sheet_file[3:]}"/></Relationships>',
        )
        types_xml = types_xml.replace(
            "</Types>",
            f'<Override PartName="/{sheet_file}" ContentType="{SHEET_CT}"/></Types>',
        )

    tmp = book.with_suffix(".xlsx.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == sheet_file:
                continue  # replaced below
            data = zin.read(item.filename)
            if item.filename == "xl/workbook.xml":
                data = workbook_xml.encode("utf-8")
            elif item.filename == "xl/_rels/workbook.xml.rels":
                data = rels_xml.encode("utf-8")
            elif item.filename == "[Content_Types].xml":
                data = types_xml.encode("utf-8")
            zout.writestr(item, data)
        zout.writestr(sheet_file, sheet_xml(rows))
    zin.close()
    tmp.replace(book)
    print(f"\n  Written. Backup kept at {backup.name}\n")


if __name__ == "__main__":
    main()
