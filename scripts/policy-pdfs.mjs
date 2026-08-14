#!/usr/bin/env node
/**
 * Render the /policies documents to branded PDFs.
 *
 * These are the files families actually sign — uploaded into Jotform Sign as
 * the documents, with the registration fields collected around them. Producing
 * them from the same Astro pages that publish on the site means the signed
 * document and the published one cannot drift apart, which matters when the
 * published version is what a family reads before signing.
 *
 * Rendering goes through headless Chrome so the output respects the print
 * stylesheet in global.css — site chrome stripped, logo shown, links spelled
 * out, sensible page breaks.
 *
 * Usage:
 *   npm run policies:pdf          # build, serve, render, stop
 *   node scripts/policy-pdfs.mjs  # same, assuming dist/ is current
 *
 * Re-run whenever a policy page changes. A stale PDF circulating for signature
 * while the site shows different wording is the failure this guards against.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'policies');
const PORT = 4399; // deliberately not 4321, so a dev server can stay running

/** Documents to render. `slug` is the route; `file` is the PDF name. */
const DOCS = [
  { slug: 'policies/team-agreement', file: 'stemplusc-team-agreement.pdf' },
  { slug: 'policies/consent-release', file: 'stemplusc-consent-release.pdf' },
  { slug: 'policies/privacy', file: 'stemplusc-privacy-notice.pdf' },
];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error(
    '\nNo Chrome-family browser found. Install Google Chrome, or render by hand:\n' +
      '  open each /policies page, File → Print → Save as PDF.\n' +
      'The print stylesheet does the rest.\n'
  );
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('\nNo build found. Run `npm run build` first.\n');
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

/** Poll until the preview server answers, rather than sleeping and hoping. */
async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Server did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

mkdirSync(OUT, { recursive: true });

console.log('Starting preview server…');
const server = spawn('npx', ['astro', 'preview', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: false,
});

let failed = false;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  console.log(`Rendering ${DOCS.length} document(s) with ${chrome.split('/').pop()}…\n`);

  for (const doc of DOCS) {
    const url = `http://localhost:${PORT}/${doc.slug}`;
    const out = join(OUT, doc.file);
    await run(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      // Backgrounds off: the title block is navy on screen and white in print,
      // and printing backgrounds would fight the print stylesheet.
      `--print-to-pdf=${out}`,
      url,
    ]);
    console.log(`  ✓ ${doc.file}`);
  }
} catch (err) {
  failed = true;
  console.error(`\n${err.message}\n`);
} finally {
  server.kill('SIGTERM');
}

if (!failed) {
  console.log(`\nWrote ${DOCS.length} PDF(s) to public/policies/`);
  console.log('They deploy with the site, so families can download them, and');
  console.log('they are what you upload into Jotform Sign as the documents.');
  console.log('\nRe-run after any change to a policy page.');
}

process.exit(failed ? 1 : 0);
