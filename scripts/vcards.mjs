#!/usr/bin/env node
/**
 * Turn a roster export into vCard contact cards.
 *
 * Reads either source, detected from the file contents:
 *
 *   1. **FIRST Dashboard JSON** — the `ContactRosterModel` object embedded in
 *      the Team Roster page. FIRST offers no CSV export ("Printable Roster" is
 *      a print view), but the page carries the whole roster as JSON. See
 *      scripts/README.md for the one-line console snippet that saves it.
 *   2. **BoldSign CSV** — the form-data export, which adds the phone numbers
 *      and second guardians FIRST does not collect.
 *
 * Deliberately a local script and not a web service. The registration data is
 * personal information about minors; running the conversion on your own
 * machine means it never reaches a server, a third party, or this repository —
 * which is public on GitHub, where a single committed export would be permanent.
 *
 * Usage:
 *   node scripts/vcards.mjs <roster.json|export.csv> [--out <dir>] [--team "Tie Dye Jedi"]
 *   node scripts/vcards.mjs <file> --single      # one combined .vcf
 *   node scripts/vcards.mjs <file> --dry-run     # report, write nothing
 *
 * Output defaults to ~/STEMC-vcards/<timestamp>/ — outside any git working
 * tree. The script refuses to read from or write into this repository.
 *
 * Expected CSV columns (BoldSign form field IDs — see scripts/README.md):
 *   student_first, student_last, student_grade, student_email, student_phone,
 *   parent1_first, parent1_last, parent1_email, parent1_phone, parent1_relationship,
 *   parent2_* (same shape, optional), team
 * Missing optional columns are skipped rather than emitted empty.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------- guards

/** Walk up from `start` looking for a .git directory. */
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
      `\nRefusing to ${what} inside a git repository.\n` +
        `  path: ${resolve(path)}\n` +
        `  repo: ${repo}\n\n` +
        `This data identifies minors and this repository is public. Move the\n` +
        `file somewhere outside the repo (your Desktop is fine) and re-run.\n`
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------- csv parsing

/**
 * RFC 4180 parser. Written out rather than split(',') because exported names
 * and addresses legitimately contain commas, quotes, and newlines, and a
 * naive split silently shifts every later column.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM; Excel adds one and it corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // handled by the \n branch
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function toRecords(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const rec = {};
    headers.forEach((h, i) => {
      rec[h] = (r[i] ?? '').trim();
    });
    return rec;
  });
}

// ------------------------------------------------------------ first json

/**
 * Normalize a phone number for display. FIRST stores whatever the family
 * typed, which in practice includes bare digit strings and malformed
 * separators, so 10- and 11-digit runs get reformatted and anything else is
 * passed through untouched rather than mangled.
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
 * Map the FIRST Dashboard's roster shape onto the same record shape the CSV
 * path produces, so everything downstream stays identical.
 *
 * Accepts the whole `ContactRosterModel`, a bare `TeamStudents` array, or the
 * wizard model that wraps it.
 */
function recordsFromFirstJson(data) {
  const model = data?.ContactRoster ?? data;
  const students = Array.isArray(model) ? model : model?.TeamStudents;
  if (!Array.isArray(students)) return null;

  const teamName = model?.TeamNumber ? `Team ${model.TeamNumber}` : '';

  return students.map((s) => ({
    student_first: s.nickname_first || s.name_first || '',
    student_last: s.name_last || '',
    student_grade: '',
    student_email: s.email || '',
    student_phone: normalizePhone(s.phone),
    parent1_first: s.parent_name_first || '',
    parent1_last: s.parent_name_last || '',
    parent1_email: s.parent_email || '',
    parent1_phone: normalizePhone(s.parent_phone),
    parent1_relationship: 'Parent/Guardian',
    team: teamName,
    // Carried through for the status report; not written to the cards.
    _status: s.ApplicationStatus || '',
    _consent: s.ConsentReleaseStatus === true,
  }));
}

// ---------------------------------------------------------------- vcard

/** Escape per RFC 6350 §3.4: backslash, comma, semicolon, newline. */
const esc = (v) =>
  String(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/**
 * Fold to 75 octets per line with a leading space on continuations (RFC 6350
 * §3.2). Folding counts bytes, not characters, so a name with an accent does
 * not silently produce an over-long line.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Do not split a multi-byte sequence: back off to a lead byte.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((start === 0 ? '' : ' ') + bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join('\r\n');
}

function vcard({ first, last, email, phone, org, title, note, categories }) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${esc(last)};${esc(first)};;;`,
    `FN:${esc([first, last].filter(Boolean).join(' '))}`,
  ];
  if (org) lines.push(`ORG:${esc(org)}`);
  if (title) lines.push(`TITLE:${esc(title)}`);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${esc(email)}`);
  if (phone) lines.push(`TEL;TYPE=CELL:${esc(phone)}`);
  if (note) lines.push(`NOTE:${esc(note)}`);
  if (categories?.length) lines.push(`CATEGORIES:${categories.map(esc).join(',')}`);
  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n');
}

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'contact';

// ----------------------------------------------------------------- main

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const input = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--team');
if (!input) {
  console.error('Usage: node scripts/vcards.mjs <export.csv> [--out <dir>] [--team <name>] [--single] [--dry-run]');
  process.exit(1);
}

assertOutsideRepo(input, 'read participant data from');

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const outDir = value('out', join(homedir(), 'STEMC-vcards', stamp));
const dryRun = flag('dry-run');
if (!dryRun) assertOutsideRepo(outDir, 'write contact cards');

const defaultTeam = value('team', '');
const raw = readFileSync(resolve(input), 'utf8');

// Detect the source by content rather than extension — the FIRST roster is
// usually saved by hand and may land with any name.
let records;
let source;
const trimmed = raw.trimStart();
if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`\nThat file starts like JSON but does not parse: ${err.message}\n`);
    process.exit(1);
  }
  records = recordsFromFirstJson(parsed);
  if (!records) {
    console.error(
      '\nJSON parsed, but no roster found. Expected a ContactRosterModel object\n' +
        'with a TeamStudents array (see scripts/README.md).\n'
    );
    process.exit(1);
  }
  source = 'FIRST Dashboard JSON';
} else {
  records = toRecords(parseCsv(raw));
  source = 'BoldSign CSV';
}
console.log(`Source: ${source}`);

const cards = [];
let skipped = 0;

for (const r of records) {
  const team = r.team || defaultTeam || 'STEM+C';
  const studentName = [r.student_first, r.student_last].filter(Boolean).join(' ');

  if (!r.student_first && !r.student_last) {
    skipped++;
    continue;
  }

  const guardians = [1, 2]
    .map((n) => ({
      first: r[`parent${n}_first`],
      last: r[`parent${n}_last`],
      email: r[`parent${n}_email`],
      phone: r[`parent${n}_phone`],
      relationship: r[`parent${n}_relationship`] || 'Parent/Guardian',
    }))
    .filter((g) => g.first || g.last);

  const guardianSummary = guardians
    .map((g) => {
      const bits = [`${g.relationship}: ${[g.first, g.last].filter(Boolean).join(' ')}`];
      if (g.phone) bits.push(g.phone);
      if (g.email) bits.push(g.email);
      return bits.join(' · ');
    })
    .join('\n');

  cards.push({
    name: `${slug(studentName)}-student`,
    body: vcard({
      first: r.student_first,
      last: r.student_last,
      email: r.student_email,
      phone: r.student_phone,
      org: `STEM+C — ${team}`,
      title: r.student_grade ? `Student, grade ${r.student_grade}` : 'Student',
      note: guardianSummary,
      categories: ['STEM+C', team, 'Student'],
    }),
  });

  for (const g of guardians) {
    cards.push({
      name: `${slug([g.first, g.last].join(' '))}-guardian`,
      body: vcard({
        first: g.first,
        last: g.last,
        email: g.email,
        phone: g.phone,
        org: `STEM+C — ${team}`,
        title: g.relationship,
        note: studentName ? `${g.relationship} of ${studentName}` : '',
        categories: ['STEM+C', team, 'Parent/Guardian'],
      }),
    });
  }
}

console.log(`Parsed ${records.length} row(s) → ${cards.length} contact card(s)`);
if (skipped) console.log(`Skipped ${skipped} row(s) with no student name`);

// Exception report. These are the gaps that cost a student their season, so
// they are printed every run rather than hidden behind a flag.
const gaps = [];
for (const r of records) {
  const who = [r.student_first, r.student_last].filter(Boolean).join(' ');
  if (!who) continue;
  if (r._status && r._status !== 'Accepted') gaps.push(`${who}: application ${r._status}`);
  if (r._consent === false) gaps.push(`${who}: FIRST Consent & Release not on record`);
  if (!r.parent1_email) gaps.push(`${who}: no parent/guardian email`);
  if (!r.parent1_phone) gaps.push(`${who}: no parent/guardian phone`);
}
if (gaps.length) {
  console.log(`\nNeeds attention (${gaps.length}):`);
  for (const g of gaps) console.log(`  • ${g}`);
} else if (records.some((r) => r._status !== undefined)) {
  console.log('\nNo gaps found — every student accepted, C&R on record, guardians reachable.');
}

if (dryRun) {
  console.log('\n--dry-run: nothing written. Cards that would be created:');
  for (const c of cards) console.log(`  ${c.name}.vcf`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

if (flag('single')) {
  const file = join(outDir, 'stemplusc-contacts.vcf');
  writeFileSync(file, cards.map((c) => c.body).join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote ${file}`);
} else {
  const used = new Map();
  for (const c of cards) {
    // Two students can share a name; disambiguate rather than overwrite.
    const n = (used.get(c.name) ?? 0) + 1;
    used.set(c.name, n);
    const file = join(outDir, `${c.name}${n > 1 ? `-${n}` : ''}.vcf`);
    writeFileSync(file, c.body + '\r\n', 'utf8');
  }
  console.log(`\nWrote ${cards.length} file(s) to ${outDir}${sep}`);
}

console.log(
  '\nThis output contains personal information about minors. Import it, then\n' +
    'delete the CSV export and this folder when you no longer need them.'
);
