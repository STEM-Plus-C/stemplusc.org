---
name: onboarding-pipeline
description: Use when working a FIRST team roster export — sending registration packets, chasing families who have not signed, recording signatures, adding people to Slack, reporting dues, or answering "who is stuck?" for Tie Dye Samurai or Tie Dye Jedi.
---

# Onboarding pipeline

`scripts/onboarding/README.md` is the authority on flags and per-team
behaviour. **Read it.** This file covers only what that README cannot know:
how the pipeline behaves when *you* drive it.

## Run it through the Terminal panel, not Bash

The roster export lands in `~/Downloads`, which Bash cannot read on this Mac:

```
ls: /Users/<user>/Downloads: Operation not permitted
```

That is macOS TCC, not a permissions bug, and it does not go away on retry.
Every command taking the roster path goes through `run_in_terminal`, then
`read_terminal` to collect output.

Bash *can* read the ledger and the previews — both live under
`~/STEMC-onboarding/`, outside the protected folders. Use it there; it is
cheaper and does not consume a tab.

You get **6 terminal tabs**, one per call, never reused. The happy path below
is five sequentially-dependent calls, so there is almost no slack. Do not
spend a tab on `ls` or `grep` — those go to Bash.

## The order that works

Run from the repo root with the environment loaded. Every command takes the
roster path:

```
set -a; source .env; set +a; node scripts/onboarding/onboard.mjs <roster> [flags]
```

| # | Flag | Why this position |
|---|---|---|
| 1 | *(none)* | Dry run. Read-only, and the real status report — who is stuck, and on what |
| 2 | `--seed --commit` | Mints ledger entries and ids. Sends nothing. Existing entries keep their stamps |
| 3 | `--set-email <ID>:<student\|parent>=<addr>` | Address corrections. Requires step 2. Writes immediately — **no `--commit`**, unlike every other writing flag |
| 4 | `--preview` | Writes an HTML file and prints its path. Nothing leaves the mailbox |
| 5 | `--send --commit` | Samurai. Jedi uses `--draft --commit`, then `--check-sent` |
| 5b | `--remind [ID]` | Nudges packets 7+ days overdue. Its own message, not a re-send of the welcome |
| 6 | `--commit` | Records signatures, adds people to Slack, posts the welcome |

The team is read from the roster's `TeamType` (FTC → Jedi, else Samurai), not
from a flag, so you cannot point a Samurai command at a Jedi roster by mistake.

## Sends are roster-wide

There is no flag that scopes a send to one student. `--send` walks every
accepted student; the only thing protecting the rest is that they already
carry `packetSentAt` or `packetDraftedAt`. **Your intent protects nobody.**
Two unsent families means two emails.

So confirm the count before you send, not after. Step 4 prints it:

```
1 packet(s) written to ~/STEMC-onboarding/previews/packet-preview-<stamp>.html
```

If that number is not what you meant to send, stop. After the run, the
`N sent, M skipped, 0 failed` line is the receipt.

Grep the preview with Bash to check the recipient and the packet link before
step 5 — the student address appears URL-encoded (`%40`, not `@`).

## Check addresses before step 5

Step 5 is the irreversible one. Read the recipient domains in the dry run
first: FIRST holds whatever a family typed on the day, and a near-miss domain
(`oulook.com` for `outlook.com`) sends fine and fails silently weeks later —
the student address is what `users.lookupByEmail` gets handed at step 6, so
the breakage surfaces as a failed Slack invite, detached from its cause.

Fix with step 3. The override lives in the ledger, wins wherever that address
is used, and is announced in every run that applies it. It does **not** change
the greeting, which is built from FIRST's guardian fields — so an override
alone can still address the wrong parent by name.

## Chasing is not re-sending

`--resend` repeats the original welcome email **and overwrites
`packetSentAt`**, so the ledger forgets how long a family has been waiting.
Reach for `--remind` instead: a shorter message, its own `remindedAt` stamp,
and a 7-day cooldown so a weekly sweep never nags.

Reminder copy carries **no personal detail about the student** — a generated
line pretending to remember what someone did in the shop is worse than none.
When a family deserves that, write it yourself and use `--links` for the URL.

## Gotchas

| You see | It means | Do |
|---|---|---|
| `No ledger entry for TDS-27-0NN. Run --seed --commit first.` | The dry run prints **prospective** ids for unseeded students. Seeing an id does not mean it exists | Step 2, then re-run |
| A student you expected in `--send` is skipped | They carry `packetSentAt`/`packetDraftedAt`. Repeat runs never double-send | `--resend <ID>` if you mean it |
| Worry that `--send --commit` also commits everyone else | It does not. The send branch exits after the mail loop | Step 6 is a separate run |
| `--send` refuses for Jedi | Deliberate. His packets go to his own Drafts to send himself | `--draft --commit` |

## This repo is public

Family names, addresses and ledger contents never go into a file here, a
commit message, or a PR. Use `TDS-27-0NN` and `someone@example.com`.

**This is why there is no sample dry-run output below** — it would be a roster
of minors. Run step 1 and read the real thing; do not paste it back here.
The ledger lives at `~/STEMC-onboarding/state.json` (override with `--state`),
and the script refuses to put it inside the repo.
