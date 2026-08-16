# Registration data → contact cards

How participant data is collected, and how to turn it into contact cards.

---

## Season runbook

A student passes through five systems between "my kid wants to join" and "paid
up on the roster." They arrive in each under a different identity — a name in
FIRST, a submission in Jotform, `Clairet R` in the budget, and in Zeffy
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

It goes in the roster, rides out on the Jotform packet link, and becomes a
column in the budget. This is the join key that makes the rest of the pipeline checkable.

### Stage 2 — Registration packet (Jotform)

`onboard.mjs --links` builds a prefilled form URL carrying `participant_id`,
student name, and parent email from what FIRST already gave you — nothing is
retyped and nothing is mistyped. Send it, or hand it to Jotform's invitation
flow.

The parent then supplies phone numbers, emergency information, and the media
choice, and both parties sign. Jotform now holds the complete contact record
and the executed agreements, and the participant id comes back on the
submission.

### Stage 3 — Roster

Export submissions from Jotform, then run `vcards.mjs` for contact cards (see
below). The season roster is: participant ID, student name, grade, team, start
date, and date signed.

You can also build contact cards straight from FIRST, before the packet comes
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
| Approved in FIRST, no packet issued | Packet link never went out |
| Packet issued, not submitted | Family stalled mid-form |
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

Registration data and signatures are captured together in **Jotform**, on the
current Bronze plan (1,000 submissions/month, full API access). One form
collects the contact details, the emergency information, the media choice, and
both signatures — so one system holds this data rather than three.

Jotform rather than BoldSign for a specific reason: **BoldSign's API is a
separate $30/month product billed per document, and the nonprofit discount
excludes API plans.** Jotform includes API access on every plan. Being a form
tool first also means the registration fields are native rather than bolted onto
a signing document, and conditional logic is available — which the COPPA design
below actually needs.

Contact cards are generated **locally, on your machine**. The data never reaches
a server we run, a third party, or this repository.

## The COPPA constraint

Tie Dye Jedi serves grades 6–9, so some participants are under 13. COPPA
obligations attach as soon as an operator has actual knowledge that a user is
under 13, and the FTC is explicit that a checkbox is not verifiable parental
consent.

**The parent completes the entire form.** The student's only interaction is
signing their own acknowledgment of the safety rules. A parent supplying their
own child's details is not online collection *from a child*.

Two consequences, both deliberate:

- **Ask for grade, not date of birth.** Grade determines team placement. A DOB
  field manufactures the "actual knowledge of under-13" trigger for no
  operational gain.
- **Student email and phone are optional**, and hidden entirely for younger
  students by conditional logic (below). For emergencies you need a reliable
  adult. Collect less.

## Jotform form build sheet

Build one form per team. Set each field's **unique name** to the value in the
first column — that is what the prefill URL writes and what the API reads back.
Jotform's numeric question ids shift as a form is edited and must not be keyed
on.

These are the same snake_case names `vcards.mjs` expects from a CSV export, so
one set of names serves both the API path and the export-a-spreadsheet path.

| Unique name | Type | Required | Notes |
|---|---|---|---|
| `participant_id` | Short text | Yes | **Read-only / hidden** — prefilled by the link |
| `team` | Dropdown | Yes | Prefilled; Tie Dye Samurai / Tie Dye Jedi |
| `student_first` | Short text | Yes | Prefilled from FIRST; legal first name |
| `student_last` | Short text | Yes | Prefilled from FIRST |
| `student_grade` | Dropdown | Yes | 6–12 — drives the conditional logic |
| `student_email` | Email | No | Hidden when grade is 6–7 |
| `student_phone` | Phone | No | Hidden when grade is 6–7 |
| `parent1_first` | Short text | Yes | |
| `parent1_last` | Short text | Yes | |
| `parent1_email` | Email | Yes | Prefilled from FIRST |
| `parent1_phone` | Phone | Yes | The number we call first in an emergency |
| `parent1_relationship` | Dropdown | Yes | Mother / Father / Guardian |
| `parent2_first` | Short text | No | |
| `parent2_last` | Short text | No | |
| `parent2_email` | Email | No | |
| `parent2_phone` | Phone | No | |
| `parent2_relationship` | Dropdown | No | |
| `medical_notes` | Long text | No | Allergies, conditions, restrictions, medications |
| `media_choice` | **Radio** | Yes | See below — must be radio, not checkbox |

### The media choice

Section 7 of the consent agreement requires this to be **presented separately
and not be a condition of participation**. So:

- A **radio group**, never a checkbox. Two options, neither preselected:
  *I authorize program media* / *I do not authorize program media*.
- Not gated — a student participates either way, and the form must submit on
  either answer.

A pre-ticked box, or a design where declining blocks submission, would undercut
the clause the agreement is relying on.

### Conditional logic

Under **Settings → Conditions**, add a show/hide rule:

> If `student_grade` is 6 or 7 → hide `student_email` and `student_phone`

This is the COPPA design made mechanical rather than remembered. Grade 8+ is
comfortably over 13; 6–7 is where under-13 participants live.

### Signatures

**Both signatures are captured in the form and are required**, so the form
cannot be submitted unsigned. That is what lets `onboard.mjs` treat a
submission as proof of signature.

Do not move signing to a post-submission Jotform Sign request. If signatures are
requested by email after submit, a submission exists before anyone has signed,
and the script would add families to Slack with an unsigned liability release —
silently. `jotform-check.mjs` enforces the required flags for this reason.

The student signs **in session** rather than by email: `student_email` is
optional and, for younger students, may not exist at all. Routing their
signature to an address we deliberately do not collect would stall every
under-13 registration. The parent fills the form and hands over the device —
which is what the Team Agreement already assumes when it asks families to read
it together.

Configure the form for **two signers** via Jotform Sign:

| Signer | Signs | Notes |
|---|---|---|
| Parent/guardian | Team Agreement + Consent, Assumption of Risk, Release & Emergency Authorization | Completes every data field |
| Student | Acknowledgment of the safety rules | Signature only — no data entry |

The published documents live at
[stemplusc.org/policies](https://stemplusc.org/policies); link them from the
form so families can read before they sign rather than after.

Jotform Sign is eSIGN and UETA compliant and produces an audit trail — who
signed, when — which is what the consent agreement's electronic-signature
section asks for.

### Prefilling

`onboard.mjs --links` generates a URL per student carrying `participant_id`,
`student_first`, `student_last`, and `parent1_email`. The participant id coming
back on the submission is what makes matching reliable — it is the join key the
runbook describes, working end to end.

Paste those links into your welcome email, or hand them to Jotform's own
invitation flow.

### API key

Jotform → **Settings → API** → create a key. Put it in `JOTFORM_API_KEY` in your
environment, and the two form ids in `JOTFORM_FORM_SAMURAI` and
`JOTFORM_FORM_JEDI`. Never in this repository — it is public.

The form id is the number in the form's URL:
`https://www.jotform.com/build/`**`250123456789`**.

### Building the forms, step by step

Build one, then use Jotform's **Clone Form** to make the second and change the
`team` default — the two forms are identical apart from that.

1. **Create the form.** Jotform → Create Form → Start from Scratch.
2. **Add the 19 fields** from the table above, in that order. Types are in the
   table; the order is what a family reads, so keep student fields together and
   guardian fields together.
3. **Set each unique name.** This is the step that matters and the one that is
   easy to get wrong. Click a field → the gear icon → **Advanced** → **Field
   Details** → **Unique Name**. Type it exactly as the table has it — lowercase,
   underscores, no spaces. The label shown to families can say whatever you
   like; the unique name is what the scripts key on.
4. **Make `participant_id` read-only.** Advanced → Read Only. It arrives
   prefilled from the packet link and a family should never change it. Hiding it
   entirely also works.
5. **Set the required flags** per the table.
6. **Add the conditional rule.** Settings → **Conditions** → Add Condition →
   *Show/Hide Field*: `IF student_grade IS 6` → *Hide* `student_email` and
   `student_phone`. Add a second condition for grade 7.
7. **Configure `media_choice`.** A radio group with exactly two options, **no
   default selected**, and confirm the form still submits with either answer.
   Section 7 of the consent agreement requires it be a genuine choice and not a
   condition of participation.
8. **Set up signing.** Jotform Sign, two signers: the parent/guardian signs the
   Team Agreement and the Consent, Assumption of Risk, Release & Emergency
   Authorization; the student signs the safety-rules acknowledgment only. Link
   [stemplusc.org/policies](https://stemplusc.org/policies) from the form so
   families can read the documents before signing.
9. **Verify it.** See below.
10. **Clone for the other team**, change the `team` field's default, and verify
    that one too.

### Verifying the forms

```bash
export JOTFORM_API_KEY=…
export JOTFORM_FORM_SAMURAI=…  JOTFORM_FORM_JEDI=…
node scripts/jotform-check.mjs
```

It reads each form through a read-only endpoint and reports every unique name
that is missing, misspelled, or the wrong control type — with a "did you mean"
when a near-miss looks like a typo. It changes nothing.

Run it after building, and again after any edit to a form. A renamed or retyped
unique name breaks matching **silently**: `onboard.mjs` simply stops finding
submissions, and you would not notice until a family had already filled the form
in and nobody got added to Slack.

Three things it cannot see, so check them by hand in the builder:

- the conditional rule actually hides the two student fields at grades 6 and 7
- both signers are configured, signing the right documents
- `media_choice` has no preselected option and does not block submission

### Why the forms are not built by script

Jotform's API is, in their own words, "mostly read only". Form creation exists
in their SDKs but the request shape is not in the public reference, and guessing
at an undocumented shape is how the BoldSign version of this ended up
untestable. Building two forms once a season is a half hour; verifying them
automatically is where the leverage actually is, because that is the part you
would otherwise repeat every time you touch a field.

## Getting the roster out of FIRST

FIRST has no export. The Team Roster page holds the whole roster in a
JavaScript variable, and a bookmarklet pulls it out in one click.

**Order matters:** be *on the roster page* before you click the bookmarklet. It
reads what the browser has loaded, so clicking it from the dashboard, the team
profile, or anywhere else finds nothing. That is the mistake to expect.

### One-time setup

Make a bookmark whose **address** is this entire line:

```
javascript:(()=>{let seen=0,blocked=0;const find=(w,d)=>{seen++;try{if(w.ContactRosterModel)return w.ContactRosterModel}catch(e){blocked++;return null}if(d>5)return null;let n=0;try{n=w.frames.length}catch(e){blocked++;return null}for(let i=0;i<n;i++){try{const r=find(w.frames[i],d+1);if(r)return r}catch(e){blocked++}}return null};let root=window;try{root=window.top}catch(e){}const m=find(root,0);if(!m){alert('Roster not found.\n\nSearched '+seen+' frame(s), '+blocked+' inaccessible.\n\nMake sure the Team Roster tab is open and the roster is visible, then click again.');return}const t=(m.TeamType||'team').toLowerCase(),n=m.TeamNumber||'',c=(m.TeamStudents||[]).length;const b=new Blob([JSON.stringify(m,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='first-roster-'+t+(n?'-'+n:'')+'.json';document.body.appendChild(a);a.click();a.remove();alert('Saved first-roster-'+t+'-'+n+'.json  ('+c+' students)');})()
```

- **Safari** — Bookmarks → Add Bookmark (on any page), name it `Get Roster`,
  save to Favorites. Then Bookmarks → Edit Bookmarks, right-click it → **Edit
  Address**, paste, Enter.
- **Chrome** — Bookmark manager → ⋮ → **Add new bookmark**, paste into URL.

### Every time you need the roster

1. Open the FIRST Dashboard and go into the team you want.
2. Navigate to **Team Contacts → Team Roster**.
3. **Wait for the roster to actually appear on screen** — student cards
   visible, not a spinner.
4. *Now* click **Get Roster**.
5. It confirms with `Saved first-roster-frc-10933.json (3 students)` and the
   file lands in Downloads, named from the team so the two rosters cannot be
   mixed up.

```bash
node scripts/onboard.mjs ~/Downloads/first-roster-frc-10933.json --seed --commit
node scripts/vcards.mjs  ~/Downloads/first-roster-frc-10933.json
```

Repeat from step 1 for the other team — its roster saves under its own name.

**Delete the file when you are done.** It holds minors' names, emails, and
phone numbers.

### If it says "Roster not found"

The alert reports how many frames it searched and how many it could not reach.

| Message | Meaning |
|---|---|
| Searched 1, 0 inaccessible | Not on the roster page — go back to step 2 |
| Searched several, 0 inaccessible | On the right page but the roster had not finished loading — wait, click again |
| Some inaccessible | Cross-origin frames are blocking it; tell me the numbers |

Nearly always it is the first one.

### Why not save the page, or use the console

Both fail, for the same reason, and both are worth not retrying:

- **Save Page As** captures only the outer document. The roster loads inside an
  iframe (`id="rp"`), so the saved file is the dashboard wrapper with no roster
  in it. The file looks plausible — a few hundred KB — and contains nothing
  useful.
- **Pasting a snippet into the console** runs in the top frame, where the
  variable does not exist. You get `ReferenceError: Can't find variable:
  ContactRosterModel`.

The bookmarklet searches nested frames from the top window down, which is what
neither of the above does.

Both scripts also accept a `.json` file or a saved `.html` page, so if you ever
do get an unwrapped page some other way, it will still work.

**What FIRST gives you, and what it does not.** Student and parent names and
emails are reliable. **Phone numbers are frequently missing.** FIRST collects no
second guardian, no grade, and no medical or emergency information — which is
why the Jotform step is not redundant with it.

Every run prints a **needs-attention list**: applications not yet accepted,
missing FIRST Consent & Release, and students with no reachable guardian. Those
are the gaps that cost a student a season, so they print every time.

## Generating contact cards

1. Get a roster file, from either source, saved **outside this repository**
   (Desktop or Downloads is fine — the script refuses to read from inside a git
   working tree):
   - **FIRST**: the `first-roster.json` from the console snippet above, or
   - **Jotform**: open the form → **Submissions → Download → CSV**.
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
   ↓  issue a prefilled Jotform link, stamped with the id  → linkIssuedAt
   ↓  poll Jotform submissions for that participant id     → signedAt
   ↓  look up guardian + student by email, invite       → slack.*
   ↓  not in the workspace yet? → worklist, retry next run
```

Every run advances whoever can advance, so it is idempotent — run it whenever
and it converges. Nothing is dropped; anything blocked appears in the report.

### Dry run is the default

This script emails documents to families and adds people to channels. Both are
outward-facing and awkward to undo, so **nothing happens without `--commit`**.
The script never emails a family directly — it prints the packet link for you
to send, so outbound contact stays in your hands and there is no send quota to
burn. Prefill-by-query-string is documented and stable; the Sign send API shape
is not something this script guesses at.

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
records someone who signed outside Jotform, so the script stops chasing them.

### Environment

Never commit these — this repository is public.

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` with `users:read`, `users:read.email`, `channels:read`, `channels:manage` (`groups:*` if the channels are private) |
| `JOTFORM_API_KEY` | Jotform API key (Settings → API) |
| `JOTFORM_FORM_SAMURAI` | Form id for the FRC packet |
| `JOTFORM_FORM_JEDI` | Form id for the FTC packet |

## Handling rules

- Never commit an export. `.gitignore` blocks `*.csv`, `*.vcf`, `*.vcard`,
  `roster*`, `participants*`, and `registrations*`, and the script refuses to
  read or write inside the repo — but those are backstops, not permission.
- Don't email exports around. Share the Jotform submission instead.
- Delete exports when you are done. Retention is a liability, not an asset.
- No API key is needed for any of this. If automation is ever added, the key
  belongs in an environment variable outside this repository.
