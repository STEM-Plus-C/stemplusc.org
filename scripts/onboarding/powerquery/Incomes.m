// Every payment recorded this season, from the data workbook.
//
// The front page needs a total that includes money the Dues query leaves out:
// arrears on the legacy Zeffy form, and payments nobody could attribute to a
// student. Those carry no participant id on purpose, so a per-student roll-up
// cannot see them — but they are real income and belong in the headline.
let
    // The one thing to change if the workbook moves. Identical to Dues.m:13.
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
