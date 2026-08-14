# Registration data → contact cards

How participant data is collected, and how to turn it into contact cards.

---

## Season runbook

A student passes through five systems between "my kid wants to join" and "paid
up on the roster." They arrive in each under a different identity — a name in
FIRST, a signer email in BoldSign, `Clairet R` in the budget, and in Zeffy
whoever actually paid, which is a parent's Venmo handle or an employer's
matching-gift program.

**The fix is a participant ID assigned at approval and carried into every
system.** Two conventions below do most of the work; everything else is
bookkeeping.

### Stage 0 — Intake and approval (FIRST Dashboard)

Parents register their student through the team link or QR code from **Team
Contacts/Roster** in the FIRST Dashboard. You accept or decline there; FIRST
emails the parent either way.

After approval FIRST holds the student's name, the parent/guardian's name and
email, and FIRST's own consent and release.

> **FIRST's consent is not ours.** Families sign both. FIRST's covers FIRST's
> events; ours covers our shop, our tools, and our travel.

### Stage 1 — Assign a participant ID  ← *convention 1*

On approval, assign an ID and never change it:

```
TDS-27-004     Tie Dye Samurai, 2026–27 season, fourth student approved
TDJ-27-011     Tie Dye Jedi, same season, eleventh
```

It goes in the roster, gets prefilled into BoldSign, and becomes a column in the
budget. This is the join key that makes the rest of the pipeline checkable.

### Stage 2 — Signing packet (BoldSign)

Send the appropriate template and **prefill** `participant_id`, student name,
and parent name/email from what FIRST already gave you — BoldSign supports
prefilling form fields at send time, so nothing is retyped and nothing is
mistyped.

The parent then supplies phone numbers, emergency information, and the media
choice, and both parties sign. BoldSign now holds the complete contact record
and the executed agreements.

### Stage 3 — Roster

Export form data from BoldSign, then run `vcards.mjs` for contact cards (see
below). The season roster is: participant ID, student name, grade, team, start
date, and date signed.

You can also build contact cards straight from FIRST, before BoldSign comes
back — useful the moment a student is accepted. See *Getting the roster out of
FIRST* below.

### Stage 4 — Budget

Add the student to `FRC Budget.xlsx` with their **participant ID** and **start
date**. The existing `Start Date`, `Total Months Committed`, and `Over Under`
columns already handle proration for mid-season joins — that part works; it just
needs to be kept current.

### Stage 5 — Payment (Zeffy)  ← *convention 2*

**Add a custom question to the Zeffy fee form: "Student's full name."** Make it
required if Zeffy allows it.

This is the highest-value change in this document and it takes five minutes. It
binds each payment to a student *at the moment of payment*, so you stop
reverse-engineering who `venmo-handle-77` belongs to. Zeffy has no waiver or
signature capability, so it stays purely the payment system — which is fine,
because its processing is free.

### Reconciliation — the exception list

Once every system carries the participant ID, these questions become answerable,
and the answers are where students fall through:

| Check | Means |
|---|---|
| Approved in FIRST, no envelope sent | Packet never went out |
| Envelope sent, not completed | Family stalled mid-signature |
| Signed, not in the budget | Roster and budget have drifted |
| In the budget, no Zeffy payments | Dues not started |
| Zeffy payment matching no student | Convention 2 was skipped, or a new sibling |
| Start date but wrong months committed | Proration not recalculated after a mid-season join |

**Matching gifts stay manual.** Benevity and similar corporate programs remit
under the employer's name with no student reference, so they cannot be
auto-bound. Note them against a participant ID by hand when they land.

### If this still hurts

Conventions 1 and 2 are most of the value and require no software. If the seams
still cost real time after a season with them, the honest next step is a tool
with linked records — Airtable's free tier covers a team this size and makes
payer↔student an actual relationship rather than a name match. That is likely a
better answer than a bespoke script anyone here has to maintain.

---

## Why it works this way

The website collects nothing. `stemplusc.org` is a static site rsynced to shared
hosting, and **this repository is public on GitHub** — neither is an appropriate
place for the names, emails, and phone numbers of minors.

Registration data is captured in **BoldSign**, alongside the signatures, because
BoldSign already needs the student and parent names and emails in order to route
the signature requests. One system holding this data is better than three.

Contact cards are generated **locally, on your machine**, from a CSV you export
by hand. The data never reaches a server, a third party, or this repository.

## The COPPA constraint

Tie Dye Jedi serves grades 6–9, so some participants are under 13. COPPA
obligations attach as soon as an operator has actual knowledge that a user is
under 13, and the FTC is explicit that a checkbox is not verifiable parental
consent.

**Every data field is assigned to the parent/guardian signer role.** The student
role carries only their own signature acknowledging the safety rules. A parent
supplying their own child's details is not online collection *from a child*.

Two consequences, both deliberate:

- **Ask for grade, not date of birth.** Grade is what determines team placement.
  A DOB field manufactures the "actual knowledge of under-13" trigger for no
  operational gain.
- **Student email and phone are optional.** For emergencies you need a reliable
  adult contact. Collect less.

## BoldSign field plan

Create these as form fields on the **parent/guardian role**. The field IDs must
match exactly — the script looks them up by name.

| Field ID | Type | Required | Notes |
|---|---|---|---|
| `student_first` | Text | Yes | |
| `student_last` | Text | Yes | |
| `student_grade` | Dropdown | Yes | 6–12 |
| `student_email` | Text | No | Omit for under-13 |
| `student_phone` | Text | No | Omit for under-13 |
| `parent1_first` | Text | Yes | |
| `parent1_last` | Text | Yes | |
| `parent1_email` | Text | Yes | |
| `parent1_phone` | Text | Yes | |
| `parent1_relationship` | Dropdown | Yes | Mother / Father / Guardian |
| `parent2_*` | — | No | Same five fields, all optional |
| `team` | Dropdown | Yes | Tie Dye Samurai / Tie Dye Jedi |

Also on the parent role, per section 7 of the consent agreement: a **radio
group** for the media choice — "I authorize program media" / "I do not authorize
program media". It must be a radio group, not a checkbox, and it must not be a
condition of participation.

Suggested templates:

| Template | Signers |
|---|---|
| Minor participant packet | Parent/guardian **+** student |
| Adult participant packet | Participant only (18+) |
| Mentor / volunteer | Individual |

## Getting the roster out of FIRST

**FIRST has no CSV export.** The Team Roster page offers Expand All, Close All,
and *Printable Roster* — and that last one is a print view, not a data export.

It does not need one. The page carries the entire roster as JSON in a variable
called `ContactRosterModel`, and that object holds exactly what contact cards
need: student name, email and phone, parent/guardian name, email and phone,
application status, and Consent & Release status.

To save it:

1. Open **Team Contacts → Team Roster** in the FIRST Dashboard.
2. Open your browser's developer console (⌥⌘I on macOS, then the Console tab).
3. Paste this and press enter — it downloads the roster to your Downloads
   folder:

   ```js
   const blob = new Blob([JSON.stringify(ContactRosterModel, null, 2)], { type: 'application/json' });
   const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'first-roster.json' });
   a.click();
   ```

4. Run `vcards.mjs` against the downloaded file. It detects the format
   automatically.

This is your own data in your own browser session — no API key, no third-party
service, nothing leaving your machine. Delete the file when you are done.

**What FIRST gives you, and what it does not.** Student and parent names and
emails are reliable. **Phone numbers are frequently missing** — students often
have none on file, and parent phone is regularly blank. FIRST also collects no
second guardian, no grade, and no medical or emergency information. That gap is
the reason the BoldSign step exists; it is not redundant with FIRST.

Every run prints a **needs-attention list**: students whose application is not
Accepted, students whose FIRST Consent & Release is not on record, and students
with no reachable guardian. Those are the gaps that cost a student a season, so
they print every time rather than hiding behind a flag.

## Generating contact cards

1. Get a roster file, from either source, saved **outside this repository**
   (Desktop or Downloads is fine — the script refuses to read from inside a git
   working tree):
   - **FIRST**: the `first-roster.json` from the console snippet above, or
   - **BoldSign**: **Documents → Export Form Data** → save the CSV.
2. Run:

   ```bash
   node scripts/vcards.mjs ~/Downloads/first-roster.json
   node scripts/vcards.mjs ~/Desktop/export.csv
   ```

   Output goes to `~/STEMC-vcards/<timestamp>/`, one `.vcf` per person.

   ```bash
   node scripts/vcards.mjs ~/Desktop/export.csv --dry-run   # report only
   node scripts/vcards.mjs ~/Desktop/export.csv --single    # one combined file
   node scripts/vcards.mjs ~/Desktop/export.csv --out ~/somewhere
   node scripts/vcards.mjs ~/Desktop/export.csv --team "Tie Dye Jedi"
   ```

3. Import the `.vcf` files into Contacts.
4. **Delete the CSV and the output folder** once imported.

Each student card carries their guardians' names, phones, and emails in the
notes, so one lookup during an emergency gets you everyone.

## Onboarding accepted students — `onboard.mjs`

Sends the signing packet, then — **once signed** — adds the student and their
guardian to Slack. Signatures gate channel access, so a family that has not
completed the packet (which carries the liability release) never lands in a
channel.

```
FIRST: Accepted
   ↓  send BoldSign packet, prefilled from the roster   → packetSentAt
   ↓  poll BoldSign for completion                      → signedAt
   ↓  look up guardian + student by email, invite       → slack.*
   ↓  not in the workspace yet? → worklist, retry next run
```

Every run advances whoever can advance, so it is idempotent — run it whenever
and it converges. Nothing is dropped; anything blocked appears in the report.

### Dry run is the default

This script emails documents to families and adds people to channels. Both are
outward-facing and awkward to undo, so **nothing happens without `--commit`**.
The dry run prints the exact BoldSign request body it would send — compare that
against BoldSign's API Explorer before your first real run. The auth header and
the document-properties endpoint are verified; the template-send body shape is
not.

```bash
node scripts/onboard.mjs ~/Downloads/first-roster.json            # dry run
node scripts/onboard.mjs ~/Downloads/first-roster.json --seed     # ledger only
node scripts/onboard.mjs ~/Downloads/first-roster.json --commit   # act
node scripts/onboard.mjs ~/Downloads/first-roster.json --mark-signed 6489569
```

### Two passes, because Slack requires it

`conversations.invite` adds an **existing workspace member** to a channel, and
`users.lookupByEmail` only finds people who have already joined. Programmatic
*workspace* invites (`admin.users.invite`) are Enterprise Grid only — not
available on the nonprofit Pro plan.

So a brand-new family takes two passes: the first sends the packet and reports
"invite these emails to Slack"; the next run picks up whoever has since joined.
Putting the workspace invite link in the packet email lets most families
self-serve.

### Channels

Resolved by name and verified up front — a typo or missing channel aborts the
run rather than onboarding someone into nothing.

| Team | Students | Parents |
|---|---|---|
| Tie Dye Samurai | `#all-tie-dye-samurai` | `#parents` |
| Tie Dye Jedi | `#tie-dye-jedi-general` | `#jedi-parents` |

The team is taken from the roster's own `TeamType`, so the right channels are
chosen without a flag.

### The ledger

State lives at `~/STEMC-onboarding/state.json`, keyed by FIRST's `PeopleID`. It
records **only what happened** — participant ID, packet sent/signed timestamps,
channel status — and deliberately holds **no names, emails, or phone numbers**.
Contact details are re-read from the roster each run, so the ledger never
becomes a second copy of the PII.

For the transition: `--seed` creates entries for everyone currently accepted
without sending anything, so you can inspect first. `--mark-signed <peopleId>`
records someone who signed outside BoldSign, so the script stops chasing them.

### Environment

Never commit these — this repository is public.

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` with `users:read`, `users:read.email`, `channels:read`, `channels:manage` (`groups:*` if the channels are private) |
| `BOLDSIGN_API_KEY` | BoldSign API key |
| `BOLDSIGN_TEMPLATE_SAMURAI` | Template id for the FRC packet |
| `BOLDSIGN_TEMPLATE_JEDI` | Template id for the FTC packet |

## Handling rules

- Never commit an export. `.gitignore` blocks `*.csv`, `*.vcf`, `*.vcard`,
  `roster*`, `participants*`, and `registrations*`, and the script refuses to
  read or write inside the repo — but those are backstops, not permission.
- Don't email exports around. Share the BoldSign document instead.
- Delete exports when you are done. Retention is a liability, not an asset.
- No API key is needed for any of this. If automation is ever added, the key
  belongs in an environment variable outside this repository.
