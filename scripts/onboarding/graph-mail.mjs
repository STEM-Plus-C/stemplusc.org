#!/usr/bin/env node
/**
 * Send mail as the STEM+C mailbox through Microsoft Graph.
 *
 * stemplusc.org mail is Microsoft 365 (the MX is
 * stemplusc-org.mail.protection.outlook.com), so the packet email either gets
 * pasted into Outlook by hand or goes out through Graph. This is the second.
 *
 * ## Why app-only rather than a signed-in user
 *
 * onboard.mjs runs from a terminal with no browser. A delegated flow would
 * need an interactive sign-in whenever the refresh token lapsed, which is
 * exactly the kind of thing that breaks on the one evening you are trying to
 * get a packet out. Client credentials hold indefinitely — until the secret
 * expires, which is a date you can put on a calendar.
 *
 * ## The blast radius, and what contains it
 *
 * Mail.Send as an *application* permission lets the app send as any mailbox in
 * the tenant, not just the sender configured here. That is far more authority
 * than this script needs, sitting in a .env file. An Exchange
 * ApplicationAccessPolicy restricts the app to one mailbox and is not
 * optional — graph-check.mjs probes for it and complains if it is missing.
 *
 * Reads nothing but the sender's own mailbox metadata. Never touches a roster.
 *
 * Environment:
 *   MS_TENANT_ID       Directory (tenant) ID from the app's Overview page
 *   MS_CLIENT_ID       Application (client) ID from the same page
 *   MS_CLIENT_SECRET   the secret *Value* — not the Secret ID beside it
 *   MS_SENDER          the mailbox to send as, e.g. steven@stemplusc.org
 */

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Application permissions this module actually uses, for the preflight. */
export const NEEDED_ROLES = {
  'Mail.Send': 'deliver a packet email',
  'Mail.ReadWrite': 'leave a packet email in Drafts for review',
};

// ------------------------------------------------------------------ env

/**
 * Read the four settings, or explain precisely which one is missing.
 *
 * Bundled rather than read at each use site so a misconfiguration fails before
 * any mail moves, not partway through a roster.
 */
export function graphEnv() {
  const env = {
    tenantId: process.env.MS_TENANT_ID,
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    sender: process.env.MS_SENDER,
  };
  const VARS = {
    tenantId: 'MS_TENANT_ID',
    clientId: 'MS_CLIENT_ID',
    clientSecret: 'MS_CLIENT_SECRET',
    sender: 'MS_SENDER',
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => VARS[k]);

  if (missing.length) {
    console.error(
      `\n${missing.join(', ')} not set.\n\n` +
        '  cd /Volumes/Development/stemplusc.org\n' +
        '  set -a; source .env; set +a\n\n' +
        'If they are not in .env yet, see the Microsoft Graph section of\n' +
        'scripts/onboarding/README.md for how to obtain them.\n'
    );
    process.exit(1);
  }
  return env;
}

// ---------------------------------------------------------------- token

/**
 * Cached for the life of the process. A thirty-family run should mint one
 * token, not thirty. Expiry is honoured with a minute of slack so a token
 * cannot lapse between the check and the call that uses it.
 */
let cached = null;

export async function graphToken() {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const { tenantId, clientId, clientSecret } = graphEnv();
  const res = await fetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // AADSTS codes are the only part of this response worth reading; the
    // description carries the actual remedy.
    throw new Error(
      `Token request failed (${res.status}): ${json.error ?? 'unknown'}\n` +
        `  ${(json.error_description ?? '').split('\n')[0]}`
    );
  }

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

/**
 * The consented application permissions, read out of the token itself.
 *
 * Adding a permission in Entra and forgetting to grant admin consent is the
 * single most common setup mistake, and it is invisible until a call fails
 * with a 403 that names nothing useful. The token's `roles` claim is the
 * authority on what was actually granted.
 */
export function tokenRoles(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).roles ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- graph

/**
 * One call against Graph. Returns parsed JSON, or null for the empty 202 that
 * sendMail answers with — calling res.json() on that throws.
 */
export async function graph(path, { method = 'GET', body } = {}) {
  const token = await graphToken();
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204 || res.status === 202) return null;

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    const e = new Error(`${method} ${path} failed (${res.status}): ${err.code ?? 'unknown'} — ${err.message ?? ''}`);
    e.status = res.status;
    e.code = err.code;
    throw e;
  }
  return json;
}

// ----------------------------------------------------------------- mail

/**
 * A Graph message.
 *
 * HTML when there is an html rendering, plain text otherwise. Graph carries a
 * single body, not a multipart alternative, so this is a choice rather than a
 * pairing — and every mail client a parent is realistically using renders
 * HTML. The text rendering is what `--email` prints, and stays the fallback
 * for anything that has no html.
 */
function message({ to, cc = [], replyTo = [], subject, body, html }) {
  return {
    subject,
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
    // The packet says "just reply to this email", so where a reply lands is
    // part of the message, not a detail. It goes to the team's own coach —
    // never to whichever mailbox happened to send it.
    replyTo: replyTo.map((address) => ({ emailAddress: { address } })),
  };
}

/**
 * Leave the message in Drafts. Returns its webLink, so the console can hand
 * you a URL that opens the draft rather than telling you to go find it.
 *
 * `mailbox` is whose Drafts it lands in, defaulting to MS_SENDER. A team whose
 * head coach is not the person running the script drafts into *that coach's*
 * mailbox, so the packet goes out from the coach the family will be replying
 * to. Reaching another mailbox needs the access policy to include it.
 */
export async function createDraft({ mailbox, ...mail }) {
  const box = mailbox || graphEnv().sender;
  const created = await graph(`/users/${encodeURIComponent(box)}/messages`, {
    method: 'POST',
    body: message(mail),
  });
  return { id: created.id, webLink: created.webLink };
}

/**
 * Deliver the message, keeping a copy in Sent Items.
 *
 * `mailbox` is who it is sent *as*. onboard.mjs will not point this at anyone
 * but MS_SENDER — see the guard there for why.
 */
export async function sendMail({ mailbox, ...mail }) {
  const box = mailbox || graphEnv().sender;
  await graph(`/users/${encodeURIComponent(box)}/sendMail`, {
    method: 'POST',
    body: { message: message(mail), saveToSentItems: true },
  });
}

/**
 * Confirm a mailbox is reachable, for the preflight.
 *
 * Probes a *mail* endpoint rather than /users/{id}. Reading the directory
 * object needs User.Read.All, which this app deliberately does not have — so a
 * 403 from the directory would say nothing about whether mail works, while
 * looking exactly like a mail failure.
 */
export async function mailboxReachable(address) {
  return graph(`/users/${encodeURIComponent(address)}/mailFolders/drafts?$select=displayName`);
}
