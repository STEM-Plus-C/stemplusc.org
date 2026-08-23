#!/usr/bin/env node
/**
 * Preflight the Microsoft Graph side of onboarding.
 *
 * Verifies the app can mint a token, that the permissions it needs were
 * actually consented, that the sender's mailbox is reachable — and, most
 * importantly, that an access policy stops the app reaching anybody else's.
 *
 * Every one of these fails in a way that is hard to read at the moment you
 * need it to work. A 403 from Graph names an error code, not the checkbox you
 * missed in Entra.
 *
 * Reads only. It never drafts or sends anything.
 *
 * Usage:
 *   node scripts/onboarding/graph-check.mjs
 *   node scripts/onboarding/graph-check.mjs --probe someone-else@stemplusc.org
 *   node scripts/onboarding/graph-check.mjs --mailbox rob@stemplusc.org
 *
 * Environment:
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER
 */

import { graphEnv, graphToken, tokenRoles, graph, mailboxReachable, NEEDED_ROLES } from './graph-mail.mjs';

// A mailbox in the tenant that is NOT the sender, to prove the app cannot
// reach other people's mail. Optional, and has to be: finding one
// automatically would need directory permissions this app should not have.
const probeArg = process.argv.indexOf('--probe');
const probeAddress = probeArg >= 0 ? process.argv[probeArg + 1] : null;

// Extra mailboxes this setup drafts *into* — a team whose head coach is not
// the person running the script. Repeatable. These must be reachable, which is
// the opposite of what --probe asserts, so they are separate flags on purpose.
const extraMailboxes = process.argv.reduce(
  (acc, a, i) => (a === '--mailbox' && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc),
  []
);

let ok = true;
const fail = (msg) => { ok = false; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

// ── 1. Settings ─────────────────────────────────────────────────────────────
console.log('\nSettings');
const { tenantId, clientId, sender } = graphEnv(); // exits with instructions if unset
pass(`tenant ${tenantId}`);
pass(`client ${clientId}`);
pass(`sending as ${sender}`);

// ── 2. Token ────────────────────────────────────────────────────────────────
console.log('\nToken');
let token;
try {
  token = await graphToken();
  pass('client credentials accepted');
} catch (err) {
  fail(String(err.message));
  console.log(
    '\n  AADSTS7000215 means the secret is wrong — you may have copied the\n' +
      '  Secret ID instead of the Value, which is only shown once.\n' +
      '  AADSTS700016 means the client id is not an app in this tenant.\n' +
      '  AADSTS7000222 means the secret expired; make a new one.\n'
  );
  process.exit(1);
}

// ── 3. Consented permissions ────────────────────────────────────────────────
// The token's roles claim is the authority. A permission added in Entra but
// never admin-consented is absent here, which is the failure this catches.
console.log('\nPermissions');
const roles = new Set(tokenRoles(token));
for (const [role, why] of Object.entries(NEEDED_ROLES)) {
  roles.has(role) ? pass(`${role} — ${why}`) : fail(`${role} — not consented (${why})`);
}
if (!roles.size) {
  console.log(
    '\n  The token carries no application roles at all. Either the permissions\n' +
      '  were added as *Delegated* rather than *Application*, or nobody clicked\n' +
      '  "Grant admin consent" afterwards. Both look fine on the permissions\n' +
      '  page until you read the Status column.\n'
  );
}

// ── 4. The sender's mailbox ─────────────────────────────────────────────────
// Probed through a mail endpoint, not /users/{id}. The directory object needs
// User.Read.All, which this app deliberately does not have — so a 403 from the
// directory says nothing about whether mail works, while looking exactly like
// a mail failure. Asking the Drafts folder asks the question we actually mean.
console.log('\nMailbox');
try {
  await mailboxReachable(sender);
  pass(`${sender} — Drafts reachable, so --draft and --send will work`);
} catch (err) {
  fail(`${sender}: ${err.message}`);
  if (err.status === 404 || err.code === 'ResourceNotFound') {
    console.log('\n  No mailbox at that address — check MS_SENDER.\n');
  } else if (err.code === 'ErrorAccessDenied' || err.status === 403) {
    console.log(
      '\n  If you have just created an ApplicationAccessPolicy, check that it\n' +
        '  names this mailbox — one scoped to the wrong address locks the app\n' +
        '  out of everything. Propagation can take up to an hour.\n'
    );
  }
}

for (const box of extraMailboxes) {
  try {
    await mailboxReachable(box);
    pass(`${box} — Drafts reachable, so its team's packets can be drafted there`);
  } catch (err) {
    fail(`${box}: ${err.code ?? err.message}`);
    if (err.code === 'ErrorAccessDenied' || err.status === 403) {
      console.log(
        `\n  The access policy does not cover ${box}. Scope it to a group\n` +
          '  holding every mailbox you draft into, rather than to one address.\n'
      );
    }
  }
}

// ── 5. Is anyone else reachable? ────────────────────────────────────────────
// Mail.Send as an application permission covers every mailbox in the tenant.
// An ApplicationAccessPolicy is what narrows it, and nothing in Entra shows
// whether one exists — the only honest test is to try another mailbox and be
// refused. That needs an address to try, which must be supplied.
console.log('\nScope');
if (!probeAddress) {
  warn('not verified — needs a second mailbox to try, and this app has no');
  console.log('      directory permission to find one (which is as it should be).');
  console.log('      Re-run naming any other mailbox in the tenant:');
  console.log('        node scripts/onboarding/graph-check.mjs --probe someone-else@stemplusc.org');
  console.log('      Or ask Exchange directly:');
  console.log(`        Test-ApplicationAccessPolicy -Identity someone-else@stemplusc.org -AppId ${clientId}`);
} else if (probeAddress.toLowerCase() === sender.toLowerCase()) {
  warn(`--probe must name a mailbox other than ${sender}; it proves nothing otherwise`);
} else {
  try {
    await mailboxReachable(probeAddress);
    fail(`this app can read ${probeAddress} — it is NOT restricted to ${sender}`);
    console.log(
      '\n  The secret in .env can currently send as, and read, every mailbox in\n' +
        '  the tenant. Restrict it:\n\n' +
        `    Connect-ExchangeOnline -UserPrincipalName ${sender}\n` +
        `    New-ApplicationAccessPolicy -AppId ${clientId} \\\n` +
        `      -PolicyScopeGroupId ${sender} \\\n` +
        '      -AccessRight RestrictAccess -Description "STEM+C onboarding mailer"\n'
    );
  } catch (err) {
    if (err.code === 'ErrorAccessDenied' || err.status === 403) {
      pass(`restricted to ${sender} — ${probeAddress} is correctly denied`);
    } else if (err.status === 404 || err.code === 'ResourceNotFound') {
      warn(`${probeAddress} has no mailbox, so this proves nothing — try a real one`);
    } else {
      warn(`probe of ${probeAddress} was inconclusive: ${err.code ?? err.message}`);
    }
  }
}

console.log(
  ok
    ? '\nGraph is ready. onboard.mjs can draft and send packet emails.\n'
    : '\nFix the items marked ✗, then re-run.\n'
);
process.exit(ok ? 0 : 1);
