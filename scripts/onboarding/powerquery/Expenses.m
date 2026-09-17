// The expense ledger, hand-entered into the data workbook.
//
// Amount is Currency.Type so it loads as money rather than a bare number.
// Everything past that -- decimals, alignment, colour -- is applied once in
// Excel and survives refresh, as long as the table's *columns* are formatted
// rather than a fixed range of cells.
let
    // The one thing to change if the workbook moves. Identical to Dues.m:13.
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
