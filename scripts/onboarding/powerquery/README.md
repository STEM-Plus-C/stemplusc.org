# Power Query — the analysis workbook

`FRC Budget 2026-2027.xlsx` reads from `FRC Data 2026-2027.xlsx`. The data
workbook is written by `budget_sync.py`; the analysis workbook is yours, keeps
the chart, and is never opened by tooling.

## Loading a query

1. Open **`FRC Budget 2026-2027.xlsx`**. Leave the data workbook closed.
2. **Data → Get Data → Launch Power Query Editor**
3. **New Source → Other Sources → Blank Query**
4. **Home → Advanced Editor**, select everything, paste the contents of `Dues.m`
5. Rename the query (right panel → Properties → Name) to **`Dues`** — the name
   becomes the sheet name
6. **Close & Load To… → New worksheet**

Refresh after every `budget_sync.py` run: **Data → Refresh All**.

If the workbook ever moves, change the `Path` on line 12 of `Dues.m` and paste
it again.

## Types vs formatting

Power Query sets **types**; Excel applies **formatting**. Both are needed and
they are set in different places.

The money columns are typed `Currency.Type`, so they load as currency rather
than bare integers. Anything beyond that — decimals, alignment, colour — is
applied once in Excel and **survives refresh**, as long as you format the table
*columns* rather than a fixed range of cells.

Check it is on: click in the table → **Table Design → Properties →
External Data Properties → Preserve cell formatting on refresh**.

## Columns

| | | |
|---|---|---|
| A | Participant ID | the key; joins to Incomes |
| B | Student | |
| C | Start Date | when billing starts — from the ledger |
| D | End Date | blank unless they have left |
| E | FIRST | registered this season |
| F | Owed to Date | money |
| G | Paid to Date | money |
| H | Over / Under | money — negative means behind |
| I | Months Behind | |
| J | Last Payment | |
| K | Days Since | |
| L | **Status** | drives the highlighting |
| M | **Action** | `chase`, or `nothing recorded — check Venmo/cash` |

Rows are sorted worst-first, so whoever is furthest behind is at the top.

## Conditional highlighting

**Home → Conditional Formatting → New Rule → Use a formula to determine which
cells to format.** Apply each to `=$A$2:$M$5000` so new students are covered as
the roster grows.

Add them **in this order** and tick **Stop If True** on each — the first
matching rule wins, and the order is the point.

| # | Formula | Format | Why |
|---|---|---|---|
| 1 | `=$M2="nothing recorded — check Venmo/cash"` | blue fill | **Check before chasing.** Nothing recorded at all usually means they paid on a rail nobody entered. A family who had paid by Venmo was called CRITICAL and chased for money they had already sent — this rule exists so that cannot happen again |
| 2 | `=$L2="CRITICAL"` | red fill, bold | three or more payments behind, and money *is* recorded — so the gap is real |
| 3 | `=$L2="Behind"` | amber fill | two payments behind |
| 4 | `=$L2="Watch"` | pale yellow | one payment behind |
| 5 | `=$L2="Not yet billed"` | grey text | start date is in the future — owes nothing yet, and is not a problem |

Rule 1 sitting above rule 2 is deliberate. Both look like "this family owes
money"; only one of them is a family to contact today.

For the money columns alone, a further rule is worth having:

| Range | Formula | Format |
|---|---|---|
| `=$H$2:$H$5000` | `=$H2<0` | red text |

## Still on the old sheets

`Cash Flow`, `Tax Purposes`, `FRC Current Budget` and `Sponsors` still read the
**old** `Incomes` sheet inside the analysis workbook — not the data workbook:

| Sheet | Reads |
|---|---|
| Cash Flow | `Incomes!M`, `Incomes!O`, `Incomes!D`, `Incomes!K` |
| Tax Purposes | `Incomes!P` |
| FRC Current Budget | `Incomes!G`, `Incomes!H` |
| Sponsors | `Incomes!D` |

So there are two payment ledgers until those are migrated, and the old one is
the incomplete one — Zeffy only, no Venmo, no Benevity.

**Do not delete the `Incomes` M–S block.** Dues Status is not its only reader;
Cash Flow reads M and O, and Tax Purposes reads P.

`Dues Status` itself *is* safe to delete once the `Dues` query is loaded and
checked — nothing in the workbook references it.
