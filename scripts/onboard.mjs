#!/usr/bin/env node
/**
 * Onboard accepted students: send the signing packet, then — once signed —
 * add the student and their guardian to the right Slack channels.
 *
 * Signatures gate Slack access. A family that has not completed the packet
 * (which contains the liability release) never lands in a channel.
 *
 * The flow per student, advanced as far as it can go on each run:
 *
 *   FIRST: Accepted
 *      ↓  send BoldSign packet, prefilled from the roster   → packetSentAt
 *      ↓  poll BoldSign for completion                      → signedAt
 *      ↓  look up guardian + student by email, invite       → slack.*
 *      ↓  not yet in the workspace? → worklist, retry next run
 *
 * Every run re-evaluates everyone, so it is idempotent — run it whenever and
 * it converges. Nothing is skipped permanently; anything blocked appears in
 * the report.
 *
 * DRY RUN IS THE DEFAULT. This script emails documents to families and adds
 * people to channels — both outward-facing and awkward to undo. Pass --commit
 * to actually act, and read the dry-run output first.
 *
 * Usage:
 *   node scripts/onboard.mjs <roster.json> [--commit] [--seed]
 *   node scripts/onboard.mjs <roster.json> --mark-signed <peopleId>
 *   node scripts/onboard.mjs <roster.json> --state <path>
 *
 * Environment (never commit these — this repository is public):
 *   SLACK_BOT_TOKEN            xoxb-… with users:read, users:read.email,
 *                              channels:read, channels:manage (groups:* if the
 *                              channels are private)
 *   BOLDSIGN_API_KEY           BoldSign API key
 *   BOLDSIGN_TEMPLATE_SAMURAI  template id for the FRC packet
 *   BOLDSIGN_TEMPLATE_JEDI     template id for the FTC packet
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------- config

/**
 * Slack channels, per team. Names must match Slack exactly — the script
 * resolves them to IDs and fails loudly if one does not exist, rather than
 * quietly onboarding someone into nothing.
 */
const TEAMS = {
  samurai: {
    label: 'Tie Dye Samurai',
    idPrefix: 'TDS',
    studentChannel: 'all-tie-dye-samurai',
    parentChannel: 'parents',
    templateEnv: 'BOLDSIGN_TEMPLATE_SAMURAI',
  },
  jedi: {
    label: 'Tie Dye Jedi',
    idPrefix: 'TDJ',
    studentChannel: 'tie-dye-jedi-general',
    parentChannel: 'jedi-parents',
    templateEnv: 'BOLDSIGN_TEMPLATE_JEDI',
  },
};

/** Two-digit season suffix used in participant IDs, e.g. TDS-27-004. */
const SEASON = '27';

/** Human-readable season, for document titles. */
const SEASON_LABEL = '2026–2027';

const SLACK = 'https://slack.com/api';
const BOLDSIGN = 'https://api.boldsign.com/v1';

// ------------------------------------------------------------------ cli

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const commit = has('commit');
const seedOnly = has('seed');
const markSigned = val('mark-signed', null);
const rosterPath = argv.find(
  (a, i) => !a.startsWith('--') && !['--state', '--mark-signed', '--team'].includes(argv[i - 1])
);

if (!rosterPath) {
  console.error(
    'Usage: node scripts/onboard.mjs <roster.json> [--commit] [--seed] [--mark-signed <peopleId>]'
  );
  process.exit(1);
}

// ------------------------------------------------------------- guards

function findRepoRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function assertOutsideRepo(path, what) {
  const repo = findRepoRoot(dirname(resolve(path)));
  if (repo) {
    console.error(
      `\nRefusing to ${what} inside a git repository.\n  path: ${resolve(path)}\n  repo: ${repo}\n\n` +
        `This data identifies minors and this repository is public.\n`
    );
    process.exit(1);
  }
}

assertOutsideRepo(rosterPath, 'read roster data from');

const statePath = resolve(val('state', join(homedir(), 'STEMC-onboarding', 'state.json')));
assertOutsideRepo(statePath, 'store onboarding state');

// ------------------------------------------------------------- state

/**
 * The ledger records only *what happened*, keyed by FIRST's PeopleID — no
 * names, no emails, no phone numbers. Contact details are re-read from the
 * roster on each run, so this file never becomes a second copy of the PII.
 */
function loadState() {
  if (!existsSync(statePath)) return { version: 1, participants: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.error(`\nCould not read state file ${statePath}: ${err.message}\n`);
    process.exit(1);
  }
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function nextParticipantId(state, team) {
  const prefix = `${TEAMS[team].idPrefix}-${SEASON}-`;
  const used = Object.values(state.participants)
    .map((p) => p.participantId)
    .filter((id) => id?.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter(Number.isFinite);
  return `${prefix}${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
}

// ------------------------------------------------------------- roster

function loadRoster(path) {
  const data = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const model = data?.ContactRoster ?? data;
  const students = Array.isArray(model) ? model : model?.TeamStudents;
  if (!Array.isArray(students)) {
    console.error('\nNo roster found — expected ContactRosterModel with a TeamStudents array.\n');
    process.exit(1);
  }
  // FIRST's TeamType tells us which program this roster belongs to.
  const team = String(model?.TeamType ?? '').toUpperCase() === 'FTC' ? 'jedi' : 'samurai';
  return { team, students };
}

// -------------------------------------------------------------- slack

async function slack(method, params = {}, post = false) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
  const url = post ? `${SLACK}/${method}` : `${SLACK}/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    method: post ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': post ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
    },
    body: post ? JSON.stringify(params) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

/** Resolve channel names to IDs once, up front, so a typo fails before we act. */
async function resolveChannels(names) {
  const wanted = new Set(names);
  const found = new Map();
  let cursor;
  do {
    const page = await slack('conversations.list', {
      limit: '200',
      exclude_archived: 'true',
      types: 'public_channel,private_channel',
      ...(cursor ? { cursor } : {}),
    });
    for (const c of page.channels ?? []) if (wanted.has(c.name)) found.set(c.name, c.id);
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && found.size < wanted.size);

  const missing = [...wanted].filter((n) => !found.has(n));
  if (missing.length) {
    console.error(
      `\nThese Slack channels do not exist (or the bot cannot see them):\n` +
        missing.map((m) => `  #${m}`).join('\n') +
        `\n\nCreate them, invite the bot, and re-run. Refusing to continue —\n` +
        `onboarding someone into a channel that is not there helps nobody.\n`
    );
    process.exit(1);
  }
  return found;
}

/** null means "not in the workspace yet", which is a worklist item, not an error. */
async function findSlackUser(email) {
  if (!email) return null;
  try {
    const res = await slack('users.lookupByEmail', { email });
    return res.user?.id ?? null;
  } catch (err) {
    if (String(err.message).includes('users_not_found')) return null;
    throw err;
  }
}

async function inviteToChannel(channelId, userId) {
  try {
    await slack('conversations.invite', { channel: channelId, users: userId }, true);
    return 'added';
  } catch (err) {
    // Already a member is a success for our purposes.
    if (String(err.message).includes('already_in_channel')) return 'already in channel';
    throw err;
  }
}

// ----------------------------------------------------------- boldsign

async function boldsign(path, { method = 'GET', body } = {}) {
  const key = process.env.BOLDSIGN_API_KEY;
  if (!key) throw new Error('BOLDSIGN_API_KEY is not set');
  const res = await fetch(`${BOLDSIGN}${path}`, {
    method,
    headers: {
      'X-API-KEY': key,
      accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`BoldSign ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Build the send-from-template request.
 *
 * NOTE: verify this body against BoldSign's API Explorer before the first
 * --commit run. The auth header and the properties endpoint are confirmed; the
 * exact role/field shape here is not, which is why --dry-run prints the request
 * verbatim for you to compare.
 */
function packetRequest({ templateId, participantId, student, guardian, team }) {
  return {
    templateId,
    title: `${TEAMS[team].label} — ${SEASON_LABEL} season registration`,
    roles: [
      {
        roleIndex: 1,
        // Legal names throughout — this is a signed agreement, not a contact
        // card, so a preferred name does not belong on the signature line.
        signerName: `${guardian.legalFirst} ${guardian.last}`.trim(),
        signerEmail: guardian.email,
        signerType: 'Signer',
        formFields: [
          { id: 'participant_id', value: participantId },
          { id: 'student_first', value: student.legalFirst },
          { id: 'student_last', value: student.last },
          { id: 'team', value: TEAMS[team].label },
        ],
      },
      {
        roleIndex: 2,
        signerName: `${student.legalFirst} ${student.last}`.trim(),
        signerEmail: student.email,
        signerType: 'Signer',
      },
    ],
  };
}

const COMPLETED = new Set(['completed', 'signed']);

// --------------------------------------------------------------- main

const state = loadState();

if (markSigned) {
  const entry = state.participants[markSigned];
  if (!entry) {
    console.error(`\nNo ledger entry for PeopleID ${markSigned}. Run --seed first.\n`);
    process.exit(1);
  }
  entry.signedAt = new Date().toISOString();
  entry.signedVia = 'manual';
  saveState(state);
  console.log(`Marked ${entry.participantId} as signed (recorded outside BoldSign).`);
  process.exit(0);
}

const { team, students } = loadRoster(rosterPath);
const cfg = TEAMS[team];
const accepted = students.filter((s) => s.ApplicationStatus === 'Accepted');

console.log(`Roster: ${cfg.label} — ${students.length} student(s), ${accepted.length} accepted`);
console.log(commit ? 'Mode:   COMMIT — changes will be made\n' : 'Mode:   dry run — nothing will change (pass --commit to act)\n');

// Seed ledger entries for everyone accepted.
for (const s of accepted) {
  const key = String(s.PeopleID);
  if (!state.participants[key]) {
    state.participants[key] = {
      participantId: nextParticipantId(state, team),
      team,
      firstAcceptedSeen: new Date().toISOString(),
      packetSentAt: null,
      packetDocumentId: null,
      signedAt: null,
      slack: { student: null, parent: null },
    };
  }
}

if (seedOnly) {
  if (commit) saveState(state);
  console.log(`Seeded ${accepted.length} ledger entr(ies) at ${statePath}`);
  console.log(commit ? 'Nothing sent. Review, then run without --seed.' : 'Dry run — pass --commit to write the ledger.');
  process.exit(0);
}

const channels = commit
  ? await resolveChannels([cfg.studentChannel, cfg.parentChannel])
  : new Map([
      [cfg.studentChannel, '(dry-run)'],
      [cfg.parentChannel, '(dry-run)'],
    ]);

const templateId = process.env[cfg.templateEnv];
const actions = [];
const worklist = [];

for (const s of accepted) {
  const key = String(s.PeopleID);
  const entry = state.participants[key];
  const who = `${s.name_first} ${s.name_last}`.trim();
  const tag = `${entry.participantId} ${who}`;

  // `first` is what a human would call them; `legalFirst` is what belongs on a
  // signature line. FIRST stores a preferred name separately, so keep both.
  const student = {
    first: s.nickname_first || s.name_first || '',
    legalFirst: s.name_first || '',
    last: s.name_last || '',
    email: s.email || '',
  };
  const guardian = {
    first: s.parent_nickname_first || s.parent_name_first || '',
    legalFirst: s.parent_name_first || '',
    last: s.parent_name_last || '',
    email: s.parent_email || '',
  };

  // ── 1. Send the packet ────────────────────────────────────────────────
  if (!entry.packetSentAt) {
    if (!guardian.email) {
      worklist.push(`${tag}: no guardian email in FIRST — cannot send the packet`);
      continue;
    }
    if (!templateId) {
      worklist.push(`${tag}: ${cfg.templateEnv} is not set — cannot send the packet`);
      continue;
    }
    const req = packetRequest({ templateId, participantId: entry.participantId, student, guardian, team });
    if (commit) {
      const res = await boldsign('/template/send', { method: 'POST', body: req });
      entry.packetDocumentId = res.documentId ?? null;
      entry.packetSentAt = new Date().toISOString();
      actions.push(`${tag}: packet sent to ${guardian.email}`);
    } else {
      actions.push(`${tag}: would send packet to ${guardian.email}`);
      console.log(`\n--- BoldSign request for ${tag} (verify against API Explorer) ---`);
      console.log(JSON.stringify(req, null, 2));
      console.log('---\n');
    }
    continue; // nothing further until it is signed
  }

  // ── 2. Has it been signed? ────────────────────────────────────────────
  if (!entry.signedAt) {
    if (!commit) {
      actions.push(`${tag}: would check signing status`);
      continue;
    }
    if (!entry.packetDocumentId) {
      worklist.push(`${tag}: packet sent but no document id recorded — check BoldSign by hand`);
      continue;
    }
    const props = await boldsign(`/document/properties?documentId=${encodeURIComponent(entry.packetDocumentId)}`);
    const status = String(props.status ?? '').toLowerCase();
    if (COMPLETED.has(status)) {
      entry.signedAt = new Date().toISOString();
      actions.push(`${tag}: packet completed`);
    } else {
      worklist.push(`${tag}: packet still ${props.status ?? 'pending'}`);
      continue;
    }
  }

  // ── 3. Signed — grant Slack access ───────────────────────────────────
  for (const [role, person, channelName] of [
    ['parent', guardian, cfg.parentChannel],
    ['student', student, cfg.studentChannel],
  ]) {
    if (entry.slack[role]) continue;
    if (!person.email) {
      worklist.push(`${tag}: no ${role} email — cannot add to #${channelName}`);
      continue;
    }
    if (!commit) {
      actions.push(`${tag}: would add ${role} (${person.email}) to #${channelName}`);
      continue;
    }
    const userId = await findSlackUser(person.email);
    if (!userId) {
      worklist.push(`${tag}: invite ${person.email} to the Slack workspace (${role}), then re-run`);
      continue;
    }
    const outcome = await inviteToChannel(channels.get(channelName), userId);
    entry.slack[role] = new Date().toISOString();
    actions.push(`${tag}: ${role} ${outcome} #${channelName}`);
  }
}

if (commit) saveState(state);

// ------------------------------------------------------------- report

console.log(actions.length ? `Actions (${actions.length}):` : 'Actions: none');
for (const a of actions) console.log(`  • ${a}`);

if (worklist.length) {
  console.log(`\nNeeds attention (${worklist.length}):`);
  for (const w of worklist) console.log(`  • ${w}`);
}

console.log(
  commit
    ? `\nLedger updated: ${statePath}`
    : `\nDry run — nothing changed. Re-run with --commit when the output looks right.`
);
