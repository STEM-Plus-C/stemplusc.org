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
 *   node scripts/onboarding/onboard.mjs <roster.json> [--commit] [--seed]
 *   node scripts/onboarding/onboard.mjs <roster.json> --links        # print links, do nothing else
 *   node scripts/onboarding/onboard.mjs <roster.json> --email        # print ready-to-send emails
 *   node scripts/onboarding/onboard.mjs <roster.json> --draft --commit  # leave them in Drafts
 *   node scripts/onboarding/onboard.mjs <roster.json> --send --commit   # deliver them
 *   node scripts/onboarding/onboard.mjs <roster.json> --mark-signed <peopleId>
 *   node scripts/onboarding/onboard.mjs <roster.json> --set-email TDS-27-002:student=a@b.com
 *   node scripts/onboarding/onboard.mjs <roster.json> --set-start TDS-27-004=2026-10-01
 *   node scripts/onboarding/onboard.mjs <roster.json> --dues
 *   node scripts/onboarding/onboard.mjs <roster.json> --state <path>
 *
 * Environment (never commit these — this repository is public):
 *   SLACK_BOT_TOKEN          xoxb-… with users:read, users:read.email,
 *                            channels:read, channels:manage (groups:* if private)
 *   JOTFORM_API_KEY          Jotform API key (Settings → API)
 *   JOTFORM_FORM_SAMURAI     form id for the FRC packet
 *   JOTFORM_FORM_JEDI        form id for the FTC packet
 *   MS_TENANT_ID             Entra directory (tenant) id  ─┐ only needed for
 *   MS_CLIENT_ID             Entra application (client) id │ --draft/--send;
 *   MS_CLIENT_SECRET         the secret Value, not its id  │ see graph-mail.mjs
 *   MS_SENDER                mailbox to send as           ─┘
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { renderText, renderHtml } from './packet-email.mjs';

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
    /**
     * Copied on every packet email, so the coach responsible for a team sees
     * their own families arrive. Empty for Samurai: the head coach is also
     * MS_SENDER, and copying yourself on your own mail helps nobody.
     */
    cc: [],
    /**
     * Who the packet email is from and signed by. Per team, because each team
     * has its own head coach — a family replying to their packet should reach
     * the coach who runs their season, not whoever happens to run the script.
     */
    /**
     * Whose Drafts a packet lands in. Null means MS_SENDER — whoever runs the
     * script. Samurai's head coach is that person, so there is nothing to route.
     */
    mailbox: null,
    signature: {
      name: 'Steven Klass',
      titles: [
        'Founder & Executive Director, STEM+C',
        'Head Coach, Tie Dye Samurai FRC Team 10933',
      ],
      org: 'STEM+C',
      tagline: 'Real projects. Real mentors. Real engineers.',
      email: 'steven@stemplusc.org',
      phone: '(480) 225-1112',
    },
    /**
     * Ten payments on the 1st, July through April, or the season in full.
     * A student joining mid-season owes the payments from their start month
     * onward — same monthly amount, fewer months, not the full total spread
     * thinner.
     */
    dues: {
      monthly: 215,
      inFull: 2150,
      firstPayment: '2026-07-01',
      lastPayment: '2027-04-01',
      portalUrl: 'https://www.zeffy.com/en-US/ticketing/tie-dye-samurai-season-fees',
    },
  },
  jedi: {
    label: 'Tie Dye Jedi',
    idPrefix: 'TDJ',
    studentChannel: 'tie-dye-jedi-general',
    parentChannel: 'jedi-parents',
    formEnv: 'JOTFORM_FORM_JEDI',
    program: 'FIRST Tech Challenge',
    welcomeUrl: 'https://tiedyejedi.org/welcome',
    /**
     * Nobody extra is copied: the Jedi packets are meant to go out from the
     * Jedi coach's own mailbox, so that coach is the sender rather than a cc.
     */
    cc: [],
    /**
     * Jedi packets are drafted into the Jedi head coach's own mailbox, so they
     * go out from — and replies come back to — the coach running that season,
     * not whoever happened to run the script. Reaching this mailbox requires
     * the Graph access policy to cover it; see the README.
     */
    mailbox: 'rob@stemplusc.org',
    signature: {
      name: 'Robert Heaton',
      titles: ['Head Coach, Tie Dye Jedi FTC Team 35811'],
      org: 'STEM+C',
      tagline: 'Real projects. Real mentors. Real engineers.',
      email: 'rob@stemplusc.org',
      phone: null,
    },
    // FTC dues are not set for this season. Fill in the same shape as Samurai
    // when they are; the dues report skips the team while this is null.
    dues: null,
  },
};

/** Two-digit season suffix used in participant ids, e.g. TDS-27-004. */
const SEASON = '27';

/** Human-readable season, for the packet email. */
const SEASON_LABEL = '2026–2027';

/**
 * Post a one-line welcome in the student channel when a family completes their
 * packet. Set false to stop announcing without touching anything else.
 *
 * Announced once per student, tracked in the ledger — re-running the script
 * must not re-welcome anyone.
 */
const ANNOUNCE = true;

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
 * export-a-spreadsheet path. See scripts/onboarding/README.md for the full field list.
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
const draftOnly = has('draft');
const sendOnly = has('send');
const resend = has('resend');
const markSigned = val('mark-signed', null);
const setEmail = val('set-email', null);
const setStart = val('set-start', null);
const duesOnly = has('dues');
const reserve = val('reserve', null);
const linkId = val('link', null);

// Every flag that takes a value, so its value is not mistaken for the roster
// path. Miss one here and rosterPath silently becomes that flag's argument.
const VALUE_FLAGS = ['--state', '--mark-signed', '--set-email', '--set-start', '--reserve', '--link'];
const rosterPath = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));

// These manage the ledger and never read a roster.
const ledgerOnly = markSigned || setEmail || setStart || reserve || linkId;

if (!rosterPath && !ledgerOnly) {
  console.error(
    'Usage: node scripts/onboarding/onboard.mjs <roster.json> [--commit] [--seed] [--links] [--email] [--mark-signed <peopleId>]\n' +
      '       node scripts/onboarding/onboard.mjs <roster.json> --draft --commit [--resend]\n' +
      '       node scripts/onboarding/onboard.mjs --reserve "Alex Rivera" [--team samurai]\n' +
      '       node scripts/onboarding/onboard.mjs --link TDS-27-009=6801234'
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

// Ledger-only commands take no roster; there is nothing to check.
if (rosterPath) assertOutsideRepo(rosterPath, 'read roster data from');

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
 * Returned as a list of blocks rather than a finished string, because this one
 * message goes out two ways: as HTML that a family reads, and as plain text
 * that `--email` prints. Two hand-written templates would drift the first time
 * someone edited one and not the other, and the version a family reads is the
 * one that must not be the stale one. packet-email.mjs renders both from this.
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

  const blocks = [
    { type: 'p', text: `Hi ${parent},` },
    {
      type: 'p',
      text: `Welcome to ${cfg.label}! We're glad to have ${kid} joining us for the ${SEASON_LABEL} ${cfg.program} season.`,
    },
    {
      type: 'p',
      text:
        `Your registration link is below. It's already filled in with what we have on file, ` +
        `so it should take about five minutes:`,
    },
    { type: 'cta', href: link, label: 'Open your registration' },
    { type: 'eyebrow', text: 'A few notes before you start' },
    {
      type: 'bullets',
      items: [
        `A parent or guardian completes this, not the student — but your student does need to be with you ` +
          `at the end to sign their own acknowledgment of our safety rules. Easiest to do it together in one sitting.`,
        `The media permission is optional and doesn't affect ${kid}'s participation. Either answer is fine.`,
        `Our Privacy Notice explains what we do with the information you provide: ${POLICIES.privacy}`,
      ],
    },
    {
      type: 'docs',
      label: 'Before you sign',
      intro: `Please read both documents before you sign them. They're linked in the form, and also here:`,
      items: [
        { name: 'Student & Family Team Agreement', url: POLICIES.teamAgreement },
        {
          name: 'Consent, Assumption of Risk, Release & Emergency Authorization',
          url: POLICIES.consentRelease,
        },
      ],
      note:
        `The second one describes real hazards — power tools, machine-shop equipment, heavy robots, ` +
        `travel — and it affects legal rights. It's worth ten minutes of your time.`,
    },
    {
      type: 'p',
      text:
        `What happens next: once you've submitted, we'll make sure you and ${kid} are in our team Slack — ` +
        `that's where schedules, announcements, and shop access details live. If you're already in there, ` +
        `nothing changes; if not, you'll get an invitation.`,
    },
    {
      type: 'p',
      text:
        `Everything else you need — meeting schedule, season timeline, dues, what to wear in the shop, ` +
        `how to help — is here: ${cfg.welcomeUrl}`,
    },
    {
      type: 'p',
      text:
        `Questions about anything, including dues, just reply to this email. We'd always rather answer ` +
        `than have a family guess.`,
    },
    { type: 'p', text: `Welcome to the Tie Dye family.` },
    { type: 'signoff', signature: cfg.signature },
  ];

  return {
    subject,
    body: renderText(blocks),
    html: renderHtml(blocks, { participantId, subject }),
    to: guardian.email,
    participantId,
  };
}

// ---------------------------------------------------------------- dues

/**
 * The payment dates for a season: the 1st of each month from the first
 * payment through the last, inclusive.
 */
function paymentDates(dues) {
  const out = [];
  const [fy, fm] = dues.firstPayment.split('-').map(Number);
  const [ly, lm] = dues.lastPayment.split('-').map(Number);
  let y = fy;
  let m = fm;
  for (let guard = 0; guard < 36; guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    if (y === ly && m === lm) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * What a student owes, given when they started.
 *
 * A family joining in October is charged from October, not from July — same
 * monthly amount, fewer payments. Anyone starting on or before the first
 * payment owes the full season.
 */
function duesFor(startDate, dues) {
  const all = paymentDates(dues);
  const start = String(startDate ?? '').slice(0, 7); // YYYY-MM
  const owed = start ? all.filter((d) => d.slice(0, 7) >= start) : all;
  const today = new Date().toISOString().slice(0, 10);
  return {
    payments: owed.length,
    total: owed.length * dues.monthly,
    fullSeason: owed.length === all.length,
    due: owed.filter((d) => d <= today),          // already fallen due
    next: owed.find((d) => d > today) ?? null,    // next one coming
    schedule: owed,
  };
}

const money = (n) => `$${n.toLocaleString('en-US')}`;

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

/**
 * Announce a completed registration in the student channel.
 *
 * Uses the student's preferred name rather than their legal one — the
 * signature line needs the legal name, a welcome does not.
 */
async function announce(channelId, name, teamLabel) {
  await slack(
    'chat.postMessage',
    {
      channel: channelId,
      text: `🎉 Welcome to ${teamLabel}, ${name} — paperwork's all done and you're officially on the ${SEASON_LABEL} roster.`,
    },
    true
  );
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

/**
 * Correct an email locally, without touching FIRST.
 *
 * FIRST's copy is sometimes wrong and sometimes uncorrectable — an address
 * already tied to another FIRST account cannot simply be reused, so a family
 * registers under whatever worked that day. Re-reading the roster each run
 * would otherwise mean looking up a known-wrong address forever.
 *
 *   --set-email TDS-27-002:student=theiractual@example.com
 */
if (setEmail) {
  const m = /^([A-Za-z]+-\d+-\d+):(student|parent)=(.+)$/.exec(setEmail.trim());
  if (!m) {
    console.error('\nExpected --set-email TDS-27-002:student=someone@example.com\n');
    process.exit(1);
  }
  const [, pid, role, addr] = m;
  const hit = Object.entries(state.participants).find(([, v]) => v.participantId === pid.toUpperCase());
  if (!hit) {
    console.error(`\nNo ledger entry for ${pid}. Run --seed --commit first.\n`);
    process.exit(1);
  }
  const [, entry] = hit;
  entry.emails = { ...(entry.emails ?? {}), [role]: addr };
  saveState(state);
  console.log(`${pid}: ${role} email overridden to ${addr}`);
  console.log('FIRST still has its own value; this only affects what we use.');
  process.exit(0);
}

/**
 * Record when a student started, which is what their dues are prorated from.
 *
 * No system knows this reliably. FIRST does not expose an acceptance date, the
 * Jotform submission is often weeks after a student started attending, and the
 * ledger only knows when this script first noticed them. So it is set by hand,
 * defaulting to the season start for anyone who was here from the beginning.
 *
 *   --set-start TDS-27-004=2026-10-01
 */
if (setStart) {
  const m = /^([A-Za-z]+-\d+-\d+)=(\d{4}-\d{2}-\d{2})$/.exec(setStart.trim());
  if (!m) {
    console.error('\nExpected --set-start TDS-27-004=2026-10-01\n');
    process.exit(1);
  }
  const [, pid, date] = m;
  const hit = Object.entries(state.participants).find(([, v]) => v.participantId === pid.toUpperCase());
  if (!hit) {
    console.error(`\nNo ledger entry for ${pid}. Run --seed --commit first.\n`);
    process.exit(1);
  }
  hit[1].startDate = date;
  saveState(state);
  console.log(`${pid}: start date set to ${date}`);
  process.exit(0);
}

/**
 * Mint an id for a student who is on the team but not yet registered with FIRST.
 *
 * Students turn up before their paperwork does. They start attending, they start
 * paying, and only later does a parent get through the FIRST registration. The
 * budget needs to bill them from day one, and billing needs an id.
 *
 * The alternative — assigning ids by hand in the spreadsheet — breaks quietly:
 * this ledger allocates the next id as max+1, so a hand-assigned TDS-27-009
 * would be handed out again to the next student who registers. Two students,
 * one id, and payments landing on the wrong person. So the ledger stays the
 * only thing that mints ids, and reserving one goes through here.
 *
 * The entry is keyed 'reserved:<slug>' because there is no PeopleID yet. When
 * the student does register, --link swaps that for the real key rather than
 * minting a second id.
 *
 *   --reserve "Alex Rivera" [--team samurai]
 */
if (reserve) {
  const name = reserve.trim();
  if (!name) {
    console.error('\nExpected --reserve "Alex Rivera"\n');
    process.exit(1);
  }
  const team = val('team', 'samurai');
  if (!TEAMS[team]) {
    console.error(`\nUnknown team ${team}. Expected one of: ${Object.keys(TEAMS).join(', ')}\n`);
    process.exit(1);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const key = `reserved:${slug}`;
  if (state.participants[key]) {
    console.error(`\n${name} already has ${state.participants[key].participantId} reserved.\n`);
    process.exit(1);
  }

  const pid = nextParticipantId(state, team);
  // The name is kept only for as long as the reservation exists — it is the
  // one thing that lets --link find this entry later. It is removed when the
  // FIRST record arrives, so the ledger goes back to holding no names.
  state.participants[key] = {
    participantId: pid,
    team,
    reservedName: name,
    reservedAt: new Date().toISOString().slice(0, 10),
  };
  saveState(state);

  console.log(`Reserved ${pid} for ${name} (${TEAMS[team].label}).`);
  console.log('Add them to the Roster sheet with that id and bill from their start month.');
  console.log(`When FIRST registration comes through:  --link ${pid}=<peopleId>`);
  process.exit(0);
}

/**
 * Attach a FIRST record to an id that was already reserved.
 *
 * Re-keys the entry from 'reserved:<slug>' to the PeopleID, so from here on the
 * student is indistinguishable from one who registered before they started —
 * and keeps the id their payments are already filed under.
 *
 *   --link TDS-27-009=6801234
 */
if (linkId) {
  const m = /^([A-Za-z]+-\d+-\d+)=(\d+)$/.exec(linkId.trim());
  if (!m) {
    console.error('\nExpected --link TDS-27-009=6801234\n');
    process.exit(1);
  }
  const [, rawPid, peopleId] = m;
  const pid = rawPid.toUpperCase();

  const hit = Object.entries(state.participants).find(([, v]) => v.participantId === pid);
  if (!hit) {
    console.error(`\nNo ledger entry for ${pid}. Reserve it first with --reserve.\n`);
    process.exit(1);
  }
  const [oldKey, entry] = hit;
  if (!oldKey.startsWith('reserved:')) {
    console.error(`\n${pid} is already linked to PeopleID ${oldKey}. Nothing to do.\n`);
    process.exit(1);
  }
  if (state.participants[peopleId]) {
    console.error(
      `\nPeopleID ${peopleId} already holds ${state.participants[peopleId].participantId}.\n` +
        'Linking would give one student two ids. Sort that out by hand.\n'
    );
    process.exit(1);
  }

  const who = entry.reservedName ?? pid;
  delete entry.reservedName;
  delete entry.reservedAt;
  entry.linkedAt = new Date().toISOString().slice(0, 10);
  state.participants[peopleId] = entry;
  delete state.participants[oldKey];
  saveState(state);

  console.log(`Linked ${pid} (${who}) to FIRST PeopleID ${peopleId}.`);
  console.log('Their id and payment history are unchanged; they now flow through the normal run.');
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
      packetDraftedAt: null,
      packetSentAt: null,
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

// Person shape, shared by the link builder and the Slack step. A ledger
// override wins over FIRST — see --set-email.
const people = (s) => {
  const o = state.participants[String(s.PeopleID)]?.emails ?? {};
  return {
    student: {
      first: s.nickname_first || s.name_first || '',
      // Legal name on the signature line; the preferred name is for contact cards.
      legalFirst: s.name_first || '',
      last: s.name_last || '',
      email: o.student || s.email || '',
      emailOverridden: Boolean(o.student && o.student !== s.email),
      phone: s.phone || '',
    },
    guardian: {
      legalFirst: s.parent_name_first || '',
      last: s.parent_name_last || '',
      email: o.parent || s.parent_email || '',
      emailOverridden: Boolean(o.parent && o.parent !== s.parent_email),
      phone: s.parent_phone || '',
    },
  };
};

// --dues: what each family owes, given when they started.
if (duesOnly) {
  const dues = cfg.dues;
  if (!dues) {
    console.error(`\nNo dues configured for ${cfg.label}. Set TEAMS.${team}.dues in this script.\n`);
    process.exit(1);
  }
  const all = paymentDates(dues);
  console.log(
    `\n${cfg.label} — ${all.length} payments of ${money(dues.monthly)}, ` +
      `${all[0]} to ${all[all.length - 1]}, or ${money(dues.inFull)} in full\n`
  );
  const unset = [];
  for (const s of accepted) {
    const entry = state.participants[String(s.PeopleID)];
    const who = `${s.name_first} ${s.name_last}`.trim();
    const start = entry.startDate ?? null;
    const d = duesFor(start ?? dues.firstPayment, dues);
    if (!start) unset.push(entry.participantId);
    console.log(
      `  ${entry.participantId}  ${who.padEnd(22)}` +
        `start ${(start ?? dues.firstPayment + ' (assumed)').padEnd(22)}` +
        `${String(d.payments).padStart(2)} payments  ${money(d.total).padStart(7)}`
    );
    console.log(
      `${' '.repeat(14)}${String(d.due.length).padStart(2)} due so far (${money(d.due.length * dues.monthly)})` +
        `${d.next ? `, next ${d.next}` : ', season fully invoiced'}`
    );
  }
  if (unset.length) {
    console.log(
      `\n${unset.length} student(s) have no start date and are assumed to have ` +
        `started at the season opening.\nIf that is wrong, set it:\n` +
        `  node scripts/onboarding/onboard.mjs <roster> --set-start ${unset[0]}=2026-10-01`
    );
  }
  console.log(
    `\nThis answers "what does this student owe", nothing more.\n\n` +
      `The Dues Status sheet in FRC Budget 2026-2027.xlsx is the authority on\n` +
      `dues: it tracks paid, owed, months behind, and reminders, fed by\n` +
      `tools/zeffy_import.py and the Zeffy Map for buyer attribution. Use it,\n` +
      `not this, to find who is behind. This is for the narrower question of\n` +
      `what to charge someone joining mid-season.\n`
  );
  process.exit(0);
}

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

// --draft / --send: put the packet email in the mailbox, or deliver it.
//
// Both use exactly what --email prints. packetEmail() stays the single copy of
// the message, so what a family receives cannot drift from what you reviewed.
if (draftOnly || sendOnly) {
  if (draftOnly && sendOnly) {
    console.error('\n--draft and --send are two ways to do the same job; pick one.\n');
    process.exit(1);
  }
  if (!formId) {
    console.error(`\n${cfg.formEnv} is not set — cannot build packet links.\n`);
    process.exit(1);
  }
  // A null signature means this team's head coach was never filled in. Sending
  // anyway would sign their families' mail with another team's coach, so stop.
  if (!cfg.signature) {
    console.error(
      `\n${cfg.label} has no coach signature set, so these would go out signed by\n` +
        `the wrong person. Fill in \`signature\` for ${team} in TEAMS near the top of\n` +
        `this file, then re-run. --email still prints them in the meantime.\n`
    );
    process.exit(1);
  }

  const { createDraft, sendMail, graphEnv } = await import('./graph-mail.mjs');
  // A dry run creates nothing, so it must not demand credentials: previewing
  // who would get mail is most useful *before* Graph is set up, not after.
  const sender = commit ? graphEnv().sender : process.env.MS_SENDER || '(MS_SENDER not set)';
  const mailbox = cfg.mailbox || sender;
  const foreign = Boolean(cfg.mailbox) && cfg.mailbox.toLowerCase() !== sender.toLowerCase();

  // Drafting into another coach's mailbox is the point: they read it and press
  // send. Sending *as* them without their ever seeing it is a different act —
  // their name on mail they never read, and replies landing on a conversation
  // they did not know had started. Refuse it and let them press send.
  if (sendOnly && foreign) {
    console.error(
      `\n${cfg.label} sends from ${cfg.mailbox}, which is not you.\n\n` +
        `--send would put their name on mail they have never read. Use --draft:\n` +
        `it leaves the packets in their Drafts and they press send.\n`
    );
    process.exit(1);
  }

  console.log(
    `Mail:   ${sendOnly ? 'deliver' : 'draft'} into ${mailbox}` +
      (foreign ? ` (signed ${cfg.signature.name}, not you)` : '') +
      (cfg.cc.length ? `, cc ${cfg.cc.join(', ')}` : '') +
      (commit ? '' : ' — dry run, nothing will be created') +
      '\n'
  );

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of accepted) {
    const entry = state.participants[String(s.PeopleID)];
    const { student, guardian } = people(s);
    const who = `${entry.participantId} ${student.legalFirst} ${student.last}`;

    if (!guardian.email) {
      console.log(`  skip   ${who} — no guardian email in FIRST`);
      skipped++;
      continue;
    }

    // Steps 3–6 are documented as safe to repeat, so this path has to be too.
    // Without this stamp a second run mails every family their packet twice.
    const already = entry.packetSentAt || entry.packetDraftedAt;
    if (already && !resend) {
      const what = entry.packetSentAt ? 'sent' : 'drafted';
      console.log(`  skip   ${who} — packet ${what} ${already.slice(0, 10)} (--resend to repeat)`);
      skipped++;
      continue;
    }

    const link = packetLink({ formId, participantId: entry.participantId, student, guardian, team });
    const mail = packetEmail({ team, participantId: entry.participantId, student, guardian, link });

    if (!commit) {
      console.log(`  would ${sendOnly ? 'send ' : 'draft'} ${who} → ${mail.to}`);
      continue;
    }

    try {
      if (sendOnly) {
        await sendMail({ mailbox, to: mail.to, cc: cfg.cc, subject: mail.subject, body: mail.body, html: mail.html });
        entry.packetSentAt = new Date().toISOString();
        console.log(`  sent   ${who} → ${mail.to}`);
      } else {
        const draft = await createDraft({ mailbox, to: mail.to, cc: cfg.cc, subject: mail.subject, body: mail.body, html: mail.html });
        entry.packetDraftedAt = new Date().toISOString();
        console.log(`  draft  ${who} → ${mail.to}`);
        console.log(`         ${draft.webLink}`);
      }
      done++;
      // Written per family rather than once at the end: if the run dies on
      // family six, the five already mailed must not be mailed again.
      saveState(state);
    } catch (err) {
      failed++;
      console.log(`  FAIL   ${who} → ${mail.to}: ${err.message}`);
    }
  }

  console.log(
    commit
      ? `\n${done} ${sendOnly ? 'sent' : 'drafted'}, ${skipped} skipped, ${failed} failed\n` +
          (sendOnly || !done ? '' : `Review them in Drafts, then send.\n`)
      : `\nDry run — pass --commit to ${sendOnly ? 'send' : 'create drafts'}.\n`
  );
  process.exit(failed ? 1 : 0);
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

  // ── 0. Already submitted? ────────────────────────────────────────────
  //
  // Checked before anything else, because a submission is the fact that
  // matters and it can exist without us having recorded issuing a link — the
  // link may have been sent by other means, the ledger may have been reset, or
  // every run so far may have been a dry run. Gating the submission check
  // behind linkIssuedAt meant a completed packet went unnoticed indefinitely.
  const existing = submissions.get(entry.participantId.toUpperCase());
  if (existing && !entry.signedAt) {
    if (commit) {
      entry.signedAt = existing.created_at ?? new Date().toISOString();
      entry.linkIssuedAt = entry.linkIssuedAt ?? entry.signedAt;
    }
    actions.push(`${tag}: packet completed`);
  }

  // ── 1. Issue the packet link ─────────────────────────────────────────
  if (!entry.linkIssuedAt && !entry.signedAt && !existing) {
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

  // ── 2. Still waiting? ────────────────────────────────────────────────
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
  if (!entry.signedAt && !existing) {
    worklist.push(`${tag}: packet issued, not yet submitted`);
    continue;
  }
  if (!commit && existing) {
    // Dry run: nothing is persisted, so report what a --commit would actually
    // do — which for someone already through the whole flow is nothing. Saying
    // "would add to Slack" about a student who was added last week reads as a
    // pipeline that has lost track of itself.
    const pending = [
      !entry.slack.parent && 'parent',
      !entry.slack.student && 'student',
    ].filter(Boolean);
    if (!entry.signedAt) {
      actions.push(`${tag}: would record as signed`);
    }
    if (pending.length) {
      actions.push(`${tag}: would add ${pending.join(' and ')} to Slack`);
    } else if (!entry.slack.announced && ANNOUNCE) {
      actions.push(`${tag}: would welcome in #${cfg.studentChannel}`);
    } else if (entry.signedAt) {
      actions.push(`${tag}: nothing to do — already signed and in Slack`);
    }
    continue;
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
    if (person.emailOverridden) {
      actions.push(`${tag}: using corrected ${role} email ${person.email} (FIRST has a different one)`);
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

  // ── 4. Tell the team ─────────────────────────────────────────────────
  //
  // Only once the student is actually reachable in the channel — announcing
  // someone who cannot see the message is just noise for everyone else.
  if (ANNOUNCE && entry.signedAt && entry.slack.student && !entry.slack.announced) {
    const who = student.first || student.legalFirst;
    if (!commit) {
      actions.push(`${tag}: would welcome ${who} in #${cfg.studentChannel}`);
    } else {
      await announce(channels.get(cfg.studentChannel), who, cfg.label);
      entry.slack.announced = new Date().toISOString();
      actions.push(`${tag}: welcomed ${who} in #${cfg.studentChannel}`);
    }
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
