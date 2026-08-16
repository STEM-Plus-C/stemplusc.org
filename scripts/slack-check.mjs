#!/usr/bin/env node
/**
 * Preflight the Slack side of onboarding.
 *
 * Verifies the token works, every channel exists, the bot is a member of each,
 * and the scopes needed are actually granted — before a real family depends on
 * it. `onboard.mjs` aborts on a missing channel, but it cannot discover a
 * missing scope or a channel the bot was never invited to until it is
 * mid-onboarding someone.
 *
 * Reads only. It never invites anyone or changes anything.
 *
 * Usage:
 *   node scripts/slack-check.mjs
 *
 * Environment:
 *   SLACK_BOT_TOKEN   xoxb-… from the app's OAuth & Permissions page
 */

const SLACK = 'https://slack.com/api';

/** Must match the channels in onboard.mjs. */
const CHANNELS = [
  { name: 'parents', why: 'Tie Dye Samurai guardians' },
  { name: 'all-tie-dye-samurai', why: 'Tie Dye Samurai students' },
  { name: 'jedi-parents', why: 'Tie Dye Jedi guardians' },
  { name: 'tie-dye-jedi-general', why: 'Tie Dye Jedi students' },
];

const NEEDED_SCOPES = ['users:read', 'users:read.email', 'channels:read'];
/** One of these is needed to add anyone to a channel. */
const INVITE_SCOPES = ['channels:manage', 'groups:write'];

async function slack(method, params = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('\nSLACK_BOT_TOKEN is not set. Did you `source .env`?\n');
    process.exit(1);
  }
  const res = await fetch(`${SLACK}/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  // Scopes come back in a header, not the body.
  json._scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return json;
}

if (!process.env.SLACK_BOT_TOKEN) {
  console.error(
    '\nSLACK_BOT_TOKEN is not set.\n\n' +
      '  cd /Volumes/Development/stemplusc.org\n' +
      '  set -a; source .env; set +a\n'
  );
  process.exit(1);
}

let ok = true;
const fail = (msg) => { ok = false; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

// ── 1. Token ────────────────────────────────────────────────────────────────
console.log('\nToken');
const auth = await slack('auth.test');
if (!auth.ok) {
  fail(`auth.test failed: ${auth.error}`);
  console.log(
    auth.error === 'invalid_auth' || auth.error === 'not_authed'
      ? '\n  The token is wrong or was revoked. Copy it again from the app\'s\n  OAuth & Permissions page — it starts xoxb-.\n'
      : ''
  );
  process.exit(1);
}
pass(`authenticated as ${auth.user} in ${auth.team}`);

// ── 2. Scopes ───────────────────────────────────────────────────────────────
console.log('\nScopes');
const granted = new Set(auth._scopes);
for (const s of NEEDED_SCOPES) {
  granted.has(s) ? pass(s) : fail(`${s} — missing`);
}
if (INVITE_SCOPES.some((s) => granted.has(s))) {
  pass(INVITE_SCOPES.filter((s) => granted.has(s)).join(' / '));
} else {
  fail(`need ${INVITE_SCOPES.join(' or ')} — without one, the bot cannot add anyone to a channel`);
}
if (!granted.size) {
  console.log('  (Slack did not report scopes on this response; check them on the app page.)');
}

// ── 3. Channels ─────────────────────────────────────────────────────────────
console.log('\nChannels');
const found = new Map();
let cursor;
do {
  const page = await slack('conversations.list', {
    limit: '200',
    exclude_archived: 'true',
    types: 'public_channel,private_channel',
    ...(cursor ? { cursor } : {}),
  });
  if (!page.ok) {
    fail(`conversations.list failed: ${page.error}`);
    break;
  }
  for (const c of page.channels ?? []) found.set(c.name, c);
  cursor = page.response_metadata?.next_cursor || undefined;
} while (cursor);

for (const { name, why } of CHANNELS) {
  const c = found.get(name);
  if (!c) {
    fail(`#${name} not found — create it, or the bot cannot see it (${why})`);
    continue;
  }
  if (!c.is_member) {
    fail(`#${name} exists but the bot is NOT a member — run: /invite @${auth.user}`);
    continue;
  }
  pass(`#${name}${c.is_private ? ' (private)' : ''} — bot is a member · ${why}`);
}

// ── 4. Lookup path ──────────────────────────────────────────────────────────
// The most common runtime outcome is "this person is not in the workspace",
// which is a worklist item rather than a failure — but the call itself has to
// work, and it needs a scope people routinely forget.
console.log('\nEmail lookup');
const probe = await slack('users.lookupByEmail', { email: 'preflight-probe@example.invalid' });
if (probe.ok || probe.error === 'users_not_found') {
  pass('users.lookupByEmail works (probe address correctly not found)');
} else if (probe.error === 'missing_scope') {
  fail('users.lookupByEmail needs users:read.email — reinstall the app after adding it');
} else {
  fail(`users.lookupByEmail failed: ${probe.error}`);
}

console.log(
  ok
    ? '\nSlack is ready. onboard.mjs can add families to channels.\n'
    : '\nFix the items marked ✗, then re-run.\n'
);
process.exit(ok ? 0 : 1);
