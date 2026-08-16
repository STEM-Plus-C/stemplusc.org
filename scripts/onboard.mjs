#!/usr/bin/env node
/**
 * Onboard accepted students: issue the registration packet, then — once it is
 * completed and signed — add the student and their guardian to Slack.
 *
 * Signatures gate Slack access. A family that has not completed the packet
 * (which carries the liability release) never lands in a channel.
 *
 *   FIRST: Accepted
 *      ↓  issue a prefilled Jotform link, stamped with the participant id
 *      ↓  poll Jotform submissions for that participant id      → signedAt
 *      ↓  look up guardian + student by email, invite to Slack  → slack.*
 *      ↓  not yet in the workspace? → worklist, retry next run
 *
 * Every run advances whoever can advance, so it is idempotent — run it whenever
 * and it converges. Nothing is skipped permanently; anything blocked appears in
 * the report.
 *
 * ## Why links rather than an API "send"
 *
 * The script generates a prefilled form URL per student instead of calling a
 * send endpoint. Prefill-by-query-string is a documented, stable Jotform
 * behaviour; the Sign send API shape is not something this script should be
 * guessing at. It also means the script never emails a family directly — you
 * stay in the loop on outbound contact, and there is no send quota to burn.
 *
 * Paste the link into your welcome email, or hand it to Jotform's own
 * invitation flow. Either way the participant id rides along and comes back
 * on the submission, which is what makes the matching reliable.
 *
 * ## Cost
 *
 * Jotform includes API access on every plan, including the free tier — unlike
 * BoldSign, whose API is a separate $30/month product excluded from the
 * nonprofit discount. Reading submissions costs nothing.
 *
 * DRY RUN IS THE DEFAULT. This script adds people to Slack channels. Pass
 * --commit to act, and read the dry-run output first.
 *
 * Usage:
 *   node scripts/onboard.mjs <roster.json> [--commit] [--seed]
 *   node scripts/onboard.mjs <roster.json> --links        # print links, do nothing else
 *   node scripts/onboard.mjs <roster.json> --email        # print ready-to-send emails
 *   node scripts/onboard.mjs <roster.json> --mark-signed <peopleId>
 *   node scripts/onboard.mjs <roster.json> --state <path>
 *
 * Environment (never commit these — this repository is public):
 *   SLACK_BOT_TOKEN          xoxb-… with users:read, users:read.email,
 *                            channels:read, channels:manage (groups:* if private)
 *   JOTFORM_API_KEY          Jotform API key (Settings → API)
 *   JOTFORM_FORM_SAMURAI     form id for the FRC packet
 *   JOTFORM_FORM_JEDI        form id for the FTC packet
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------- config

/**
 * Slack channels and Jotform forms, per team. Channel names must match Slack
 * exactly — the script resolves them to IDs and aborts if one is missing,
 * rather than quietly onboarding someone into nothing.
 */
const TEAMS = {
  samurai: {
    label: 'Tie Dye Samurai',
    idPrefix: 'TDS',
    studentChannel: 'all-tie-dye-samurai',
    parentChannel: 'parents',
    formEnv: 'JOTFORM_FORM_SAMURAI',
    program: 'FIRST Robotics Competition',
    welcomeUrl: 'https://tiedyesamurai.org/welcome',
  },
  jedi: {
    label: 'Tie Dye Jedi',
    idPrefix: 'TDJ',
    studentChannel: 'tie-dye-jedi-general',
    parentChannel: 'jedi-parents',
    formEnv: 'JOTFORM_FORM_JEDI',
    program: 'FIRST Tech Challenge',
    welcomeUrl: 'https://tiedyejedi.org/welcome',
  },
};

/** Two-digit season suffix used in participant ids, e.g. TDS-27-004. */
const SEASON = '27';

/** Human-readable season, for the packet email. */
const SEASON_LABEL = '2026–2027';

/** Sign-off on the packet email. Update when the coach changes. */
const SIGNATURE = [
  'Steven Klass',
  'Founder & Executive Director, STEM+C',
  'Head Coach, Tie Dye Samurai — FRC Team 10933',
  'steven@stemplusc.org',
].join('\n');

/** Where the policy documents live. Linked from the email and the form. */
const POLICIES = {
  teamAgreement: 'https://stemplusc.org/policies/team-agreement',
  consentRelease: 'https://stemplusc.org/policies/consent-release',
  privacy: 'https://stemplusc.org/policies/privacy',
};

/**
 * Jotform field unique names. Set these on each field in the form builder.
 * They are what the prefill URL writes and what the submission reads back, so
 * they must match on both sides — the numeric question ids Jotform assigns are
 * not stable enough to key on.
 *
 * Deliberately the same snake_case names `vcards.mjs` expects from a CSV
 * export, so one set of field names serves both the API path and the
 * export-a-spreadsheet path. See scripts/README.md for the full field list.
 */
const FIELDS = {
  participantId: 'participant_id',
  team: 'team',
  studentFirst: 'student_first',
  studentLast: 'student_last',
  studentEmail: 'student_email',
  studentPhone: 'student_phone',
  parentFirst: 'parent1_first',
  parentLast: 'parent1_last',
  parentEmail: 'parent1_email',
  parentPhone: 'parent1_phone',
};

const SLACK = 'https://slack.com/api';
const JOTFORM = 'https://api.jotform.com';

// ------------------------------------------------------------------ cli

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const commit = has('commit');
const seedOnly = has('seed');
const linksOnly = has('links');
const emailOnly = has('email');
const markSigned = val('mark-signed', null);
const rosterPath = argv.find(
  (a, i) => !a.startsWith('--') && !['--state', '--mark-signed'].includes(argv[i - 1])
);

if (!rosterPath) {
  console.error(
    'Usage: node scripts/onboard.mjs <roster.json> [--commit] [--seed] [--links] [--email] [--mark-signed <peopleId>]'
  );
  process.exit(1);
}

// -------------------------------------------------------------- guards

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

// --------------------------------------------------------------- state

/**
 * The ledger records only *what happened*, keyed by FIRST's PeopleID — no
 * names, no emails, no phone numbers. Contact details are re-read from the
 * roster each run, so this file never becomes a second copy of the PII.
 */
function loadState() {
  if (!existsSync(statePath)) return { version: 2, participants: {} };
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

// -------------------------------------------------------------- roster

/**
 * Pull the roster JSON out of a saved FIRST Team Roster page.
 *
 * The console snippet is fragile: the roster renders inside an iframe, so the
 * variable is not in the console's default scope, and browsers increasingly
 * warn about pasting into the console at all. Saving the page (File → Save
 * Page As) sidesteps both — the data is a plain `var ContactRosterModel = {…}`
 * assignment in the HTML.
 *
 * Brace-counted rather than regexed to the first `};`, because the JSON
 * contains strings that can hold braces and semicolons.
 */
function extractRosterFromHtml(html) {
  const marker = /var\s+ContactRosterModel\s*=\s*/;
  const m = marker.exec(html);
  if (!m) return null;

  let i = html.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function loadRoster(path) {
  const raw = readFileSync(resolve(path), 'utf8');
  let data;
  if (raw.trimStart().startsWith('<') || /var\s+ContactRosterModel/.test(raw)) {
    data = extractRosterFromHtml(raw);
    if (!data) {
      console.error(
        '\nThat looks like a saved page, but no roster was found in it.\n' +
          'Make sure you saved the Team Roster tab itself, with the roster visible.\n'
      );
      process.exit(1);
    }
  } else {
    data = JSON.parse(raw);
  }
  const model = data?.ContactRoster ?? data;
  const students = Array.isArray(model) ? model : model?.TeamStudents;
  if (!Array.isArray(students)) {
    console.error('\nNo roster found — expected ContactRosterModel with a TeamStudents array.\n');
    process.exit(1);
  }
  const team = String(model?.TeamType ?? '').toUpperCase() === 'FTC' ? 'jedi' : 'samurai';
  return { team, students };
}

// ------------------------------------------------------------- jotform

async function jotform(path) {
  const key = process.env.JOTFORM_API_KEY;
  if (!key) throw new Error('JOTFORM_API_KEY is not set');
  // Key goes in a header rather than the query string so it stays out of URLs,
  // shell history, and any proxy logs.
  const res = await fetch(`${JOTFORM}${path}`, {
    headers: { APIKEY: key, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jotform ${path} → ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.responseCode && json.responseCode !== 200) {
    throw new Error(`Jotform ${path} → ${json.responseCode}: ${json.message ?? 'unknown error'}`);
  }
  return json.content;
}

/**
 * Read one answer out of a submission by the field's unique name.
 *
 * Jotform keys answers by numeric question id, which differs per form and
 * shifts as a form is edited, so matching on the stable `name` is the only
 * durable approach. Composite fields (name, address) answer with an object
 * rather than a string.
 */
function answerByName(submission, name) {
  for (const a of Object.values(submission?.answers ?? {})) {
    if (a?.name !== name) continue;
    const v = a.answer;
    if (v == null) return undefined;
    if (typeof v === 'string') return v.trim() || undefined;
    if (typeof v === 'object') {
      const joined = Object.values(v).filter(Boolean).join(' ').trim();
      return joined || undefined;
    }
    return String(v);
  }
  return undefined;
}

/** Fetch every submission for a form, paging until exhausted. */
async function fetchSubmissions(formId) {
  const all = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const page = await jotform(
      `/form/${encodeURIComponent(formId)}/submissions?limit=${limit}&offset=${offset}`
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

/** Index submissions by the participant id they carry back. */
function indexByParticipant(submissions) {
  const map = new Map();
  for (const s of submissions) {
    // Jotform marks deleted submissions rather than removing them.
    if (String(s.status ?? '').toUpperCase() === 'DELETED') continue;
    const pid = answerByName(s, FIELDS.participantId);
    if (pid) map.set(pid.trim().toUpperCase(), s);
  }
  return map;
}

/** Prefilled form URL. The participant id is what makes matching reliable. */
/**
 * Phone numbers arrive from FIRST as whatever the family typed — bare digits,
 * or malformed separators like "801389-4191". Normalizing before prefilling
 * keeps a phone field from rejecting its own prefilled value. Mirrors the same
 * helper in vcards.mjs.
 */
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return String(raw).trim();
}

/**
 * Prefill everything FIRST already knows, so a family only fills what it
 * genuinely cannot tell us: grade, relationship, a second guardian, medical
 * notes, the media choice, and the signatures.
 *
 * Empty values are omitted rather than sent blank — FIRST leaves phone fields
 * empty often, and an empty parameter is noise in a URL a parent may look at.
 * Nothing here is read-only except the participant id, so a family can correct
 * anything FIRST had wrong.
 */
function packetLink({ formId, participantId, student, guardian, team }) {
  const params = new URLSearchParams();
  const set = (field, value) => {
    if (value) params.set(field, value);
  };

  set(FIELDS.participantId, participantId);
  // The team dropdown has exactly one option per form, so making a family pick
  // it is a required click with no decision in it.
  set(FIELDS.team, TEAMS[team].label);
  set(FIELDS.studentFirst, student.legalFirst);
  set(FIELDS.studentLast, student.last);
  set(FIELDS.studentEmail, student.email);
  set(FIELDS.studentPhone, normalizePhone(student.phone));
  set(FIELDS.parentFirst, guardian.legalFirst);
  set(FIELDS.parentLast, guardian.last);
  set(FIELDS.parentEmail, guardian.email);
  set(FIELDS.parentPhone, normalizePhone(guardian.phone));

  return `https://form.jotform.com/${formId}?${params}`;
}

/**
 * The packet email, ready to send.
 *
 * Lives here rather than in a doc so every family gets the same message and it
 * cannot drift from what the link actually does. Deliberately carries no dues
 * figures: those change per team and per season, and an email that quotes them
 * is wrong the moment they change. One link that is always right beats a number
 * that quietly is not.
 */
function packetEmail({ team, participantId, student, guardian, link }) {
  const cfg = TEAMS[team];
  const kid = student.first || student.legalFirst;
  const parent = guardian.legalFirst;

  const subject = `Welcome to ${cfg.label} — your registration link (${SEASON_LABEL} season)`;

  const body = `Hi ${parent},

Welcome to ${cfg.label}! We're glad to have ${kid} joining us for the ${SEASON_LABEL} ${cfg.program} season.

Your registration link is below. It's already filled in with what we have on file, so it should take about five minutes:

${link}

A few notes before you start:

- A parent or guardian completes this, not the student — but your student does need to be with you at the end to sign their own acknowledgment of our safety rules. Easiest to do it together in one sitting.

- Please read the two documents before you sign them. They're linked in the form, and also here:
  Student & Family Team Agreement: ${POLICIES.teamAgreement}
  Consent, Assumption of Risk, Release & Emergency Authorization: ${POLICIES.consentRelease}

- The second one describes real hazards — power tools, machine-shop equipment, heavy robots, travel — and it affects legal rights. It's worth ten minutes of your time.

- The media permission is optional and doesn't affect ${kid}'s participation. Either answer is fine.

- Our Privacy Notice explains what we do with the information you provide: ${POLICIES.privacy}

What happens next: once you've submitted, we'll make sure you and ${kid} are in our team Slack — that's where schedules, announcements, and shop access details live. If you're already in there, nothing changes; if not, you'll get an invitation.

Everything else you need — meeting schedule, season timeline, dues, what to wear in the shop, how to help — is here: ${cfg.welcomeUrl}

Questions about anything, including dues, just reply to this email. We'd always rather answer than have a family guess.

Welcome to the Tie Dye family.

${SIGNATURE}`;

  return { subject, body, to: guardian.email, participantId };
}

// --------------------------------------------------------------- slack

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

/** Resolve channel names to IDs up front, so a typo fails before we act. */
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

/** null means "not in the workspace yet" — a worklist item, not an error. */
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
    return 'added to';
  } catch (err) {
    if (String(err.message).includes('already_in_channel')) return 'already in';
    throw err;
  }
}

// ---------------------------------------------------------------- main

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
  console.log(`Marked ${entry.participantId} as signed (recorded outside Jotform).`);
  process.exit(0);
}

const { team, students } = loadRoster(rosterPath);
const cfg = TEAMS[team];
const accepted = students.filter((s) => s.ApplicationStatus === 'Accepted');

console.log(`Roster: ${cfg.label} — ${students.length} student(s), ${accepted.length} accepted`);
console.log(
  commit
    ? 'Mode:   COMMIT — Slack changes will be made\n'
    : 'Mode:   dry run — nothing will change (pass --commit to act)\n'
);

// Seed ledger entries for everyone accepted.
for (const s of accepted) {
  const key = String(s.PeopleID);
  if (!state.participants[key]) {
    state.participants[key] = {
      participantId: nextParticipantId(state, team),
      team,
      firstAcceptedSeen: new Date().toISOString(),
      linkIssuedAt: null,
      signedAt: null,
      slack: { student: null, parent: null },
    };
  }
}

if (seedOnly) {
  if (commit) saveState(state);
  console.log(`Seeded ${accepted.length} ledger entr(ies) at ${statePath}`);
  console.log(
    commit ? 'Nothing sent. Review, then run without --seed.' : 'Dry run — pass --commit to write the ledger.'
  );
  process.exit(0);
}

const formId = process.env[cfg.formEnv];

// Person shape, shared by the link builder and the Slack step.
const people = (s) => ({
  student: {
    first: s.nickname_first || s.name_first || '',
    // Legal name on the signature line; the preferred name is for contact cards.
    legalFirst: s.name_first || '',
    last: s.name_last || '',
    email: s.email || '',
    phone: s.phone || '',
  },
  guardian: {
    legalFirst: s.parent_name_first || '',
    last: s.parent_name_last || '',
    email: s.parent_email || '',
    phone: s.parent_phone || '',
  },
});

// --email: print a ready-to-send email per student and stop.
if (emailOnly) {
  if (!formId) {
    console.error(`\n${cfg.formEnv} is not set — cannot build packet links.\n`);
    process.exit(1);
  }
  for (const s of accepted) {
    const entry = state.participants[String(s.PeopleID)];
    const { student, guardian } = people(s);
    if (!guardian.email) {
      console.log(`\n${'='.repeat(72)}\n${entry.participantId} — no guardian email in FIRST, cannot send\n`);
      continue;
    }
    const link = packetLink({ formId, participantId: entry.participantId, student, guardian, team });
    const mail = packetEmail({ team, participantId: entry.participantId, student, guardian, link });
    console.log(`\n${'='.repeat(72)}`);
    console.log(`To:      ${mail.to}`);
    console.log(`Subject: ${mail.subject}`);
    console.log(`${'-'.repeat(72)}`);
    console.log(mail.body);
  }
  console.log(`\n${'='.repeat(72)}\n`);
  process.exit(0);
}

// --links: print the packet links and stop. Useful for a mail merge.
if (linksOnly) {
  if (!formId) {
    console.error(`\n${cfg.formEnv} is not set — cannot build packet links.\n`);
    process.exit(1);
  }
  for (const s of accepted) {
    const entry = state.participants[String(s.PeopleID)];
    const { student, guardian } = people(s);
    console.log(`${entry.participantId}\t${student.legalFirst} ${student.last}\t${guardian.email}`);
    console.log(`  ${packetLink({ formId, participantId: entry.participantId, student, guardian, team })}\n`);
  }
  process.exit(0);
}

const channels = commit
  ? await resolveChannels([cfg.studentChannel, cfg.parentChannel])
  : new Map([
      [cfg.studentChannel, '(dry-run)'],
      [cfg.parentChannel, '(dry-run)'],
    ]);

// One API call covers every student — cheaper and simpler than per-document polling.
let submissions = new Map();
if (formId && process.env.JOTFORM_API_KEY) {
  submissions = indexByParticipant(await fetchSubmissions(formId));
  console.log(`Jotform: ${submissions.size} submission(s) carrying a participant id\n`);
} else {
  console.log(`Jotform: skipped (${cfg.formEnv} or JOTFORM_API_KEY not set)\n`);
}

const actions = [];
const worklist = [];

for (const s of accepted) {
  const entry = state.participants[String(s.PeopleID)];
  const { student, guardian } = people(s);
  const tag = `${entry.participantId} ${s.name_first} ${s.name_last}`.trim();

  // ── 1. Issue the packet link ─────────────────────────────────────────
  if (!entry.linkIssuedAt) {
    if (!guardian.email) {
      worklist.push(`${tag}: no guardian email in FIRST — cannot issue a packet`);
      continue;
    }
    if (!formId) {
      worklist.push(`${tag}: ${cfg.formEnv} is not set — cannot build a packet link`);
      continue;
    }
    const link = packetLink({ formId, participantId: entry.participantId, student, guardian, team });
    if (commit) entry.linkIssuedAt = new Date().toISOString();
    actions.push(`${tag}: send this to ${guardian.email}\n      ${link}`);
    continue; // nothing further until it comes back signed
  }

  // ── 2. Has it come back? ─────────────────────────────────────────────
  //
  // A submission is treated as proof of signature. That is only sound because
  // both signature fields are REQUIRED on the form, so it cannot be submitted
  // unsigned — the signing happens in the form, not as an emailed request
  // afterwards.
  //
  // If anyone ever makes a signature optional, or moves signing to a
  // post-submission Jotform Sign request, this stops being true: a submission
  // would exist before anyone signed, and families would be let into Slack
  // with an unsigned liability release. jotform-check.mjs enforces the
  // required flags for exactly this reason.
  if (!entry.signedAt) {
    const submission = submissions.get(entry.participantId.toUpperCase());
    if (!submission) {
      worklist.push(`${tag}: packet issued, not yet submitted`);
      continue;
    }
    if (commit) entry.signedAt = submission.created_at ?? new Date().toISOString();
    actions.push(`${tag}: packet completed`);
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

// Students on the roster who are not accepted never enter the loop above, so
// without this they vanish from the report entirely — and someone who applied
// and is waiting on you is exactly who should not go unmentioned.
for (const s of students) {
  if (s.ApplicationStatus === 'Accepted') continue;
  const who = `${s.name_first} ${s.name_last}`.trim() || '(no name)';
  const status = s.ApplicationStatus || 'no status';
  worklist.push(
    status === 'Applied'
      ? `${who}: applied and waiting — accept or decline them in the FIRST Dashboard`
      : `${who}: on the roster but ${status} — not onboarded`
  );
}

if (commit) saveState(state);

// -------------------------------------------------------------- report

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
