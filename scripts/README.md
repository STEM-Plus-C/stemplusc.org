# Registration data → contact cards

How participant data is collected, and how to turn it into contact cards.

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

## Generating contact cards

1. In BoldSign: **Documents → Export Form Data** → save the CSV **outside this
   repository** (your Desktop is fine — the script refuses to read from inside a
   git working tree).
2. Run:

   ```bash
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

## Handling rules

- Never commit an export. `.gitignore` blocks `*.csv`, `*.vcf`, `*.vcard`,
  `roster*`, `participants*`, and `registrations*`, and the script refuses to
  read or write inside the repo — but those are backstops, not permission.
- Don't email exports around. Share the BoldSign document instead.
- Delete exports when you are done. Retention is a liability, not an asset.
- No API key is needed for any of this. If automation is ever added, the key
  belongs in an environment variable outside this repository.
