#!/usr/bin/env node
/**
 * Check a built Jotform form against the field spec the other scripts rely on.
 *
 * The forms are built by hand — Jotform's API is, in their own words, "mostly
 * read only", and creating a form through an undocumented request shape is not
 * worth it for a once-a-season setup task. But the failure it invites is nasty
 * and silent: one mistyped unique name and `onboard.mjs` stops matching
 * submissions, with no error until a family has already filled the thing in.
 *
 * So: build by hand, verify here. This reads the form's questions through a
 * documented read-only endpoint and reports anything missing, misspelled, or
 * the wrong control type. It changes nothing.
 *
 * Usage:
 *   node scripts/jotform-check.mjs                 # both forms, from env
 *   node scripts/jotform-check.mjs <formId>        # one specific form
 *
 * Environment:
 *   JOTFORM_API_KEY, JOTFORM_FORM_SAMURAI, JOTFORM_FORM_JEDI
 */

const JOTFORM = 'https://api.jotform.com';

/**
 * The contract. `types` lists acceptable Jotform control types; an unexpected
 * type is a warning rather than a failure, because a phone captured in a plain
 * textbox still works — except for `media_choice`, where the consent agreement
 * requires a genuine either/or choice and a checkbox will not do.
 */
const SPEC = [
  { name: 'participant_id', required: true, types: ['control_textbox'], note: 'prefilled by the packet link; read-only or hidden' },
  { name: 'team', required: true, types: ['control_dropdown', 'control_textbox'] },
  { name: 'student_first', required: true, types: ['control_textbox'] },
  { name: 'student_last', required: true, types: ['control_textbox'] },
  { name: 'student_grade', required: true, types: ['control_dropdown'], note: 'drives the COPPA conditional rule' },
  { name: 'student_email', required: false, types: ['control_email', 'control_textbox'], note: 'must be hidden for grades 6-7' },
  { name: 'student_phone', required: false, types: ['control_phone', 'control_textbox'], note: 'must be hidden for grades 6-7' },
  { name: 'parent1_first', required: true, types: ['control_textbox'] },
  { name: 'parent1_last', required: true, types: ['control_textbox'] },
  { name: 'parent1_email', required: true, types: ['control_email', 'control_textbox'], note: 'prefilled by the packet link' },
  { name: 'parent1_phone', required: true, types: ['control_phone', 'control_textbox'] },
  { name: 'parent1_relationship', required: true, types: ['control_dropdown'] },
  { name: 'parent2_first', required: false, types: ['control_textbox'] },
  { name: 'parent2_last', required: false, types: ['control_textbox'] },
  { name: 'parent2_email', required: false, types: ['control_email', 'control_textbox'] },
  { name: 'parent2_phone', required: false, types: ['control_phone', 'control_textbox'] },
  { name: 'parent2_relationship', required: false, types: ['control_dropdown'] },
  { name: 'medical_notes', required: false, types: ['control_textarea', 'control_textbox'] },
  { name: 'media_choice', required: true, types: ['control_radio'], strictType: true, note: 'must be a radio group, never a checkbox — see consent agreement §7' },
];

/** Names the packet link prefills; these must exist or prefilling silently no-ops. */
const PREFILLED = ['participant_id', 'student_first', 'student_last', 'parent1_email'];

async function jotform(path) {
  const key = process.env.JOTFORM_API_KEY;
  if (!key) {
    console.error('\nJOTFORM_API_KEY is not set.\n');
    process.exit(1);
  }
  const res = await fetch(`${JOTFORM}${path}`, { headers: { APIKEY: key, accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jotform ${path} → ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.responseCode && json.responseCode !== 200) {
    throw new Error(`Jotform ${path} → ${json.responseCode}: ${json.message ?? 'unknown'}`);
  }
  return json.content;
}

/** Levenshtein distance, for "did you mean" on a near-miss. */
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

async function checkForm(label, formId) {
  console.log(`\n${'='.repeat(60)}\n${label} — form ${formId}\n${'='.repeat(60)}`);

  let questions;
  try {
    questions = await jotform(`/form/${encodeURIComponent(formId)}/questions`);
  } catch (err) {
    console.error(`  Could not read the form: ${err.message}`);
    return false;
  }

  const fields = Object.values(questions ?? {}).map((q) => ({
    name: q.name ?? '',
    type: q.type ?? '',
    text: q.text ?? '',
    required: String(q.required ?? 'No').toLowerCase() === 'yes',
  }));
  const byName = new Map(fields.map((f) => [f.name, f]));

  const problems = [];
  const warnings = [];

  for (const spec of SPEC) {
    const found = byName.get(spec.name);

    if (!found) {
      // A near-miss is far more likely than a genuinely absent field — but a
      // name that is itself in the spec is a different field, not a typo of
      // this one. parent1_email is not a misspelling of parent2_email.
      const specNames = new Set(SPEC.map((s) => s.name));
      const candidates = fields
        .map((f) => ({ name: f.name, d: distance(spec.name, f.name) }))
        .filter((c) => c.name && c.d <= 3 && !specNames.has(c.name))
        .sort((a, b) => a.d - b.d);
      const hint = candidates.length ? `  ← did you mean this? found "${candidates[0].name}"` : '';
      const line = `missing unique name "${spec.name}"${hint}`;
      (spec.required ? problems : warnings).push(line);
      continue;
    }

    if (!spec.types.includes(found.type)) {
      const line = `"${spec.name}" is ${found.type}, expected ${spec.types.join(' or ')}`;
      (spec.strictType ? problems : warnings).push(
        spec.strictType ? `${line} — ${spec.note}` : line
      );
    }

    if (spec.required && !found.required) {
      warnings.push(`"${spec.name}" is not marked required on the form`);
    }
  }

  for (const name of PREFILLED) {
    if (!byName.has(name)) {
      problems.push(`"${name}" is prefilled by the packet link but does not exist — prefilling will silently do nothing`);
    }
  }

  const known = new Set(SPEC.map((s) => s.name));
  const extra = fields.filter((f) => f.name && !known.has(f.name) && !f.type.startsWith('control_head'));
  if (extra.length) {
    console.log(`\n  Fields not in the spec (fine, just noting them):`);
    for (const f of extra) console.log(`    · ${f.name} (${f.type})`);
  }

  console.log(`\n  ${fields.length} field(s) on the form, ${SPEC.length} in the spec`);

  if (problems.length) {
    console.log(`\n  MUST FIX (${problems.length}):`);
    for (const p of problems) console.log(`    ✗ ${p}`);
  }
  if (warnings.length) {
    console.log(`\n  Worth a look (${warnings.length}):`);
    for (const w of warnings) console.log(`    ! ${w}`);
  }
  if (!problems.length && !warnings.length) {
    console.log(`\n  ✓ Every field matches the spec.`);
  }

  console.log(
    `\n  Not checkable from here — verify by hand in the form builder:\n` +
      `    · the conditional rule hiding student_email and student_phone for grades 6-7\n` +
      `    · both signers configured (parent signs the agreements, student signs the safety acknowledgment)\n` +
      `    · media_choice has neither option preselected and does not block submission`
  );

  return problems.length === 0;
}

const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'));
const targets = explicit
  ? [['Form', explicit]]
  : [
      ['Tie Dye Samurai', process.env.JOTFORM_FORM_SAMURAI],
      ['Tie Dye Jedi', process.env.JOTFORM_FORM_JEDI],
    ].filter(([, id]) => id);

if (!targets.length) {
  console.error(
    '\nNo form to check. Set JOTFORM_FORM_SAMURAI / JOTFORM_FORM_JEDI,\n' +
      'or pass a form id: node scripts/jotform-check.mjs 250123456789\n'
  );
  process.exit(1);
}

let allClean = true;
for (const [label, id] of targets) {
  const clean = await checkForm(label, id);
  allClean = allClean && clean;
}

console.log(
  allClean
    ? '\nAll checked forms are ready for onboard.mjs.\n'
    : '\nFix the items marked MUST FIX, then re-run.\n'
);
process.exit(allClean ? 0 : 1);
