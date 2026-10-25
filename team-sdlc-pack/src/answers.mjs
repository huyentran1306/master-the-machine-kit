// Canonical submission paths (technical guide, step 10):
//   <repository.folder>/answers/<ID>/submit.json        (copied from the Start Work template)
//   <repository.folder>/answers/<ID>/evidence/<file>    (referenced in JSON as "evidence/<file>")
// Never <folder>/evidence/ or <folder>/challenge/evidence/; challenge/<ID>-submit.json is source only.
import fs from 'node:fs';
import path from 'node:path';
import { collectStrings } from './util.mjs';

export function answerPaths(matchRoot, id) {
  const dir = path.join(matchRoot, 'answers', id);
  return { dir, submitJson: path.join(dir, 'submit.json'), evidenceDir: path.join(dir, 'evidence') };
}

/** Writes answers/<ID>/submit.json from the template if it does not exist yet. */
export function materializeAnswer(matchRoot, id, template) {
  const p = answerPaths(matchRoot, id);
  fs.mkdirSync(p.evidenceDir, { recursive: true });
  let created = false;
  if (!fs.existsSync(p.submitJson)) {
    let value = template;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = null;
      }
    }
    if (!value || typeof value !== 'object') value = { backlogId: id, status: 'DRAFT', summary: '' };
    fs.writeFileSync(p.submitJson, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    created = true;
  }
  // Keep the evidence folder in Git even before the first evidence file exists.
  const keep = path.join(p.evidenceDir, '.gitkeep');
  if (!fs.readdirSync(p.evidenceDir).length) fs.writeFileSync(keep, '');
  return { ...p, created };
}

/** Count MVS scenarios in whatever shape the server returned. */
export function countScenarios(mvs) {
  if (!mvs) return 0;
  if (Array.isArray(mvs)) return mvs.length;
  if (typeof mvs === 'object') {
    for (const k of ['scenarios', 'testCases', 'cases', 'tests', 'minimumVerificationScenarios', 'items']) if (Array.isArray(mvs[k])) return mvs[k].length;
    const ids = new Set(collectStrings(mvs).flatMap((s) => s.match(/\b[A-Z]+-\d+-TC-\d+\b|\bTC-\d+\b/g) || []));
    return ids.size;
  }
  if (typeof mvs === 'string') return new Set(mvs.match(/\b[A-Z]+-\d+-TC-\d+\b|\bTC-\d+\b/g) || []).size;
  return 0;
}

const UNFINISHED = new Set(['DRAFT', 'NOT_STARTED', 'TODO', 'TEMPLATE', '']);

/** Static checks on the answer object. Returns { errors, warnings, evidenceRefs }. */
export function checkAnswer(answer, id, type) {
  const errors = [];
  const warnings = [];
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { errors: ['submit.json must contain a JSON object'], warnings, evidenceRefs: [] };
  if (answer.backlogId != null && answer.backlogId !== id) errors.push(`answer.backlogId is ${answer.backlogId}, expected ${id}`);
  if (typeof answer.status === 'string' && UNFINISHED.has(answer.status.trim().toUpperCase())) errors.push(`answer.status is still "${answer.status}": set the final status the template expects`);
  const strings = collectStrings(answer);
  const evidenceRefs = [...new Set(strings.filter((s) => /^evidence\/[^\s]+$/.test(s.trim())).map((s) => s.trim()))];
  const badRefs = strings.filter((s) => new RegExp(`(^|/)answers/${id}/`).test(s) || /^(\.\/)?(challenge\/)?evidence\//.test(s) && !/^evidence\//.test(s));
  if (badRefs.length) errors.push(`evidence references must be relative to answers/${id}/ (use "evidence/<file>"): ${badRefs.slice(0, 3).join(', ')}`);
  for (const ref of evidenceRefs) if (ref.includes('..')) errors.push(`evidence reference escapes the folder: ${ref}`);
  if ((type === 'CR' || type === 'BUG') && evidenceRefs.length === 0) errors.push(`${type} needs MVS evidence: put files in answers/${id}/evidence/ and reference them as "evidence/<file>"`);
  const empty = Object.entries(answer).filter(([, v]) => v === '' || (Array.isArray(v) && v.length === 0)).map(([k]) => k);
  if (empty.length) warnings.push(`empty fields: ${empty.join(', ')}`);
  const results = Array.isArray(answer.testResults) ? answer.testResults : [];
  const notPassed = results.filter((r) => r && typeof r === 'object' && r.result && !/^PASS/i.test(String(r.result))).map((r) => `${r.id || '?'}=${r.result}`);
  if (notPassed.length) warnings.push(`testResults not passed: ${notPassed.join(', ')}`);
  const size = JSON.stringify(answer).length;
  if (size > 190000) errors.push(`answer is ${size} chars; the server limit is about 200000`);
  return { errors, warnings, evidenceRefs };
}
