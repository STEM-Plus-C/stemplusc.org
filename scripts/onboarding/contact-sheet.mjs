#!/usr/bin/env node
/**
 * Build a printable contact sheet — every student with their guardians on one
 * page, sorted by surname.
 *
 * Different job from `vcards.mjs`. Contact cards go into a phone, one person
 * at a time; this is the sheet you want on a clipboard at a competition, or
 * open on a laptop when something happens in the shop and you need a parent
 * now. Each student's guardians sit directly under them, because at the moment
 * you need them you are looking up the student, not the adult.
 *
 * Reads the same inputs as the other scripts — a saved FIRST roster page, its
 * JSON, or a Jotform CSV export — detected from the contents.
 *
 * Usage:
 *   node scripts/onboarding/contact-sheet.mjs <roster.json|page.html|export.csv>
 *   node scripts/onboarding/contact-sheet.mjs <file> --open      # open when written
 *   node scripts/onboarding/contact-sheet.mjs <file> --out <path>
 *
 * Output defaults to ~/STEMC-contact-sheets/<timestamp>.html — outside any git
 * working tree. The script refuses to read from or write into this repository.
 *
 * The result is a single self-contained HTML file: no network, no assets, safe
 * to keep on a laptop and print. It still holds minors' names, emails, and
 * phone numbers — delete it when the season ends.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

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

// --------------------------------------------------------------- input

/** Brace-counted extraction; the page holds other similar-looking variables. */
function extractRosterFromHtml(html) {
  const m = /var\s+ContactRosterModel\s*=\s*/.exec(html);
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
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(i, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const normalizePhone = (raw) => {
  if (!raw) return '';
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return String(raw).trim();
};

/** Normalize every supported source into one shape. */
function loadPeople(path) {
  const raw = readFileSync(resolve(path), 'utf8');
  const trimmed = raw.trimStart();

  if (trimmed.startsWith('<') || /var\s+ContactRosterModel/.test(raw)) {
    const model = extractRosterFromHtml(raw);
    if (!model) return null;
    return { source: 'FIRST roster page', team: model.TeamNumber ? `Team ${model.TeamNumber}` : '', rows: fromFirst(model) };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(raw);
    const model = data?.ContactRoster ?? data;
    return { source: 'FIRST roster', team: model.TeamNumber ? `Team ${model.TeamNumber}` : '', rows: fromFirst(model) };
  }
  return { source: 'Jotform export', team: '', rows: fromCsv(parseCsv(raw)) };
}

function fromFirst(model) {
  const students = Array.isArray(model) ? model : model?.TeamStudents;
  if (!Array.isArray(students)) return null;
  return students.map((s) => ({
    first: s.nickname_first || s.name_first || '',
    last: s.name_last || '',
    grade: '',
    email: s.email || '',
    phone: normalizePhone(s.phone),
    status: s.ApplicationStatus || '',
    consent: s.ConsentReleaseStatus === true,
    guardians: [
      {
        name: [s.parent_name_first, s.parent_name_last].filter(Boolean).join(' '),
        relationship: 'Parent/Guardian',
        email: s.parent_email || '',
        phone: normalizePhone(s.parent_phone),
      },
    ].filter((g) => g.name),
    medical: '',
  }));
}

function fromCsv(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const rec = {};
    headers.forEach((h, i) => (rec[h] = (r[i] ?? '').trim()));
    return {
      first: rec.student_first || '',
      last: rec.student_last || '',
      grade: rec.student_grade || '',
      email: rec.student_email || '',
      phone: normalizePhone(rec.student_phone),
      status: '',
      consent: null,
      guardians: [1, 2]
        .map((n) => ({
          name: [rec[`parent${n}_first`], rec[`parent${n}_last`]].filter(Boolean).join(' '),
          relationship: rec[`parent${n}_relationship`] || 'Parent/Guardian',
          email: rec[`parent${n}_email`] || '',
          phone: normalizePhone(rec[`parent${n}_phone`]),
        }))
        .filter((g) => g.name),
      medical: rec.medical_notes || '',
    };
  });
}

// -------------------------------------------------------------- render

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function render({ people, team, source, generated }) {
  const card = (p) => {
    const contacts = [
      p.phone && `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`,
      p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`,
    ].filter(Boolean).join(' · ');

    const guardians = p.guardians.length
      ? p.guardians.map((g) => `
          <div class="g">
            <div class="gn">${esc(g.name)} <span class="rel">${esc(g.relationship)}</span></div>
            <div class="gc">${[
              g.phone && `<a href="tel:${esc(g.phone)}">${esc(g.phone)}</a>`,
              g.email && `<a href="mailto:${esc(g.email)}">${esc(g.email)}</a>`,
            ].filter(Boolean).join(' · ') || '<span class="missing">no contact on file</span>'}</div>
          </div>`).join('')
      : '<div class="g"><span class="missing">No guardian on file</span></div>';

    return `
      <article>
        <h2>${esc(p.last)}, ${esc(p.first)}${p.grade ? ` <span class="grade">grade ${esc(p.grade)}</span>` : ''}</h2>
        ${contacts ? `<div class="sc">${contacts}</div>` : '<div class="sc missing">no student contact on file</div>'}
        ${p.medical ? `<div class="med"><strong>Medical:</strong> ${esc(p.medical)}</div>` : ''}
        ${guardians}
      </article>`;
  };

  const missing = people.filter((p) => !p.guardians.some((g) => g.phone)).length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Contact sheet${team ? ` — ${esc(team)}` : ''}</title>
<style>
  :root { --ink:#111; --muted:#666; --rule:#e5e5e5; --flag:#b45309; }
  * { box-sizing:border-box; }
  body { font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:var(--ink); margin:0; padding:32px; background:#fff; }
  header { border-bottom:2px solid var(--ink); padding-bottom:12px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .meta { color:var(--muted); font-size:12px; }
  .warn { margin-top:10px; color:var(--flag); font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; }
  article { border:1px solid var(--rule); border-radius:8px; padding:12px 14px; break-inside:avoid; }
  h2 { font-size:15px; margin:0 0 4px; }
  .grade { font-weight:400; color:var(--muted); font-size:12px; }
  .sc { font-size:13px; margin-bottom:8px; }
  .med { font-size:12px; background:#fef3c7; border-radius:4px; padding:6px 8px; margin:6px 0 8px; }
  .g { border-top:1px solid var(--rule); padding-top:6px; margin-top:6px; }
  .gn { font-size:13px; font-weight:600; }
  .rel { font-weight:400; color:var(--muted); font-size:11px; }
  .gc { font-size:13px; }
  .missing { color:var(--flag); font-style:italic; }
  a { color:inherit; }
  @media print {
    body { padding:0; font-size:11px; }
    .grid { grid-template-columns:repeat(2,1fr); gap:8px; }
    a { text-decoration:none; }
  }
  @page { margin:0.5in; }
</style></head><body>
<header>
  <h1>Contact sheet${team ? ` — ${esc(team)}` : ''}</h1>
  <div class="meta">${people.length} student${people.length === 1 ? '' : 's'} · from ${esc(source)} · generated ${esc(generated)}</div>
  ${missing ? `<div class="warn">${missing} student${missing === 1 ? ' has' : 's have'} no guardian phone on file — worth chasing before you need it.</div>` : ''}
</header>
<div class="grid">${people.map(card).join('')}</div>
</body></html>`;
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const input = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

if (!input) {
  console.error('Usage: node scripts/onboarding/contact-sheet.mjs <roster.json|page.html|export.csv> [--out <path>] [--open]');
  process.exit(1);
}
assertOutsideRepo(input, 'read participant data from');

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const out = resolve(val('out', join(homedir(), 'STEMC-contact-sheets', `contact-sheet-${stamp}.html`)));
assertOutsideRepo(out, 'write a contact sheet');

const loaded = loadPeople(input);
if (!loaded?.rows) {
  console.error('\nCould not find a roster in that file. See scripts/onboarding/README.md.\n');
  process.exit(1);
}

// Only people actually on the team; a declined application is not a contact.
const people = loaded.rows
  .filter((p) => (p.first || p.last) && (!p.status || p.status === 'Accepted'))
  .sort((a, b) => (a.last || '').localeCompare(b.last || '') || (a.first || '').localeCompare(b.first || ''));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, render({ people, team: loaded.team, source: loaded.source, generated: new Date().toLocaleString() }), 'utf8');

console.log(`Source: ${loaded.source}`);
console.log(`Wrote a contact sheet for ${people.length} student(s):\n  ${out}`);
const noPhone = people.filter((p) => !p.guardians.some((g) => g.phone)).length;
if (noPhone) console.log(`\n${noPhone} student(s) have no guardian phone on file — flagged on the sheet.`);
console.log('\nOpen it and print, or save as PDF. It holds minors\' contact details —');
console.log('delete it at the end of the season.');

if (argv.includes('--open')) spawn('open', [out], { stdio: 'ignore', detached: true }).unref();
