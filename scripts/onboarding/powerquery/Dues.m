// Dues — who owes what, computed from the data workbook.
//
// Paste into Excel: Data > Get Data > Launch Power Query Editor >
// New Source > Blank Query > Advanced Editor > replace everything with this.
//
// Replaces the old Dues Status sheet. That one read a per-student block out of
// Incomes *by row position*, so inserting a row in the wrong place reattributed
// someone's money. This joins on participant id, which cannot slip.
//
// Refresh with Data > Refresh All after running budget_sync.py.
let
    // The one thing to change if the workbook moves.
    Path    = "/Users/steven/Library/CloudStorage/OneDrive-STEM+C/FRC Data 2026-2027.xlsx",
    Monthly = 215,
    Season  = #date(2027, 4, 1),   // last scheduled payment
    Today   = Date.From(DateTime.LocalNow()),

    Book    = Excel.Workbook(File.Contents(Path), null, true),
    Sheet   = (name) => Table.PromoteHeaders(Book{[Item = name, Kind = "Sheet"]}[Data], [PromoteAllScalars = true]),

    Roster  = Sheet("Roster"),
    Incomes = Sheet("Incomes"),

    // Payments carrying no id are deliberate: last season's arrears, and money
    // nobody could attribute. They stay in the ledger and out of this season.
    Attributed = Table.SelectRows(Incomes, each [Participant ID] <> null and Text.Trim(Text.From([Participant ID])) <> ""),
    Paid = Table.Group(Attributed, {"Participant ID"}, {{"Paid to Date", each List.Sum(List.Transform([Amount], each Number.From(_))), type number}}),

    Joined  = Table.NestedJoin(Roster, {"Participant ID"}, Paid, {"Participant ID"}, "p", JoinKind.LeftOuter),
    Flat    = Table.ExpandTableColumn(Joined, "p", {"Paid to Date"}, {"Paid to Date"}),

    Typed = Table.TransformColumns(Flat, {
        {"Start Date",   each try Date.From(_) otherwise null, type date},
        {"End Date",     each try Date.From(_) otherwise null, type date},
        {"Paid to Date", each if _ = null then 0 else Number.From(_), type number}
    }),

    // Billed from the month they started to the month they left, or to the end
    // of the season. Counting the start month is deliberate — a student who
    // joins on the 1st owes for that month.
    Months = (a as date, b as date) => (Date.Year(b) - Date.Year(a)) * 12 + (Date.Month(b) - Date.Month(a)) + 1,
    Cap    = (r) => List.Min({ if r[End Date] = null then #date(2099, 1, 1) else r[End Date], Today, Season }),

    Owed = Table.AddColumn(Typed, "Owed to Date", each
        let s = [Start Date], c = Cap(_) in
        if s = null or c < s then 0 else Months(s, c) * Monthly, type number),

    Over   = Table.AddColumn(Owed, "Over / Under", each [Paid to Date] - [Owed to Date], type number),
    Behind = Table.AddColumn(Over, "Months Behind", each if [Over / Under] < 0 then Number.Round(-[Over / Under] / Monthly, 1) else 0, type number),

    Last = Table.AddColumn(Behind, "Last Payment", each
        let mine = Table.SelectRows(Attributed, (p) => p[Participant ID] = [Participant ID]) in
        if Table.IsEmpty(mine) then null else List.Max(List.Transform(mine[Date], each try Date.From(_) otherwise null)), type date),

    Days = Table.AddColumn(Last, "Days Since", each if [Last Payment] = null then null else Duration.Days([Last Payment] - Today) * -1, Int64.Type),

    Status = Table.AddColumn(Days, "Status", each
        if [Owed to Date] = 0 then "Not yet billed"
        else if [Over / Under] >= 0 then "Current"
        else if [Months Behind] <= 1 then "Watch"
        else if [Months Behind] <= 2 then "Behind"
        else "CRITICAL", type text),

    // A student owing money with nothing recorded at all is either genuinely
    // behind or paid on a rail nobody entered — Venmo, cash, a cheque. Worth
    // checking before the family is chased for money they already sent.
    Action = Table.AddColumn(Status, "Action", each
        if [Owed to Date] = 0 then ""
        else if [Paid to Date] = 0 then "nothing recorded — check Venmo/cash"
        else if [Over / Under] < 0 then "chase"
        else "", type text),

    Out = Table.SelectColumns(Action, {
        "Participant ID", "Student", "Start Date", "End Date", "FIRST",
        "Owed to Date", "Paid to Date", "Over / Under", "Months Behind",
        "Last Payment", "Days Since", "Status", "Action"
    })
in
    Out
