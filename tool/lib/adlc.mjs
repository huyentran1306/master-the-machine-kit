// ADLC artifacts for one backlog item, kept small enough for a 40-minute match:
//   Task Contract (Specify & Plan): outcome, acceptance, scope, stop conditions, assumptions
//   review pack   (Validate): the contract checked against the diff, for a read-only reviewer
//   retro         (Observe): what the match showed, to tune the kit between rounds

// The template's placeholders all contain a space, so code such as List<Voucher> never counts.
const PLACEHOLDER = /<[^<>\n]*\s[^<>\n]*>/;

/** MVS as a list of one-line scenarios, whatever shape the Start working reply used. */
export function mvsLines(mvs) {
  if (mvs == null || mvs === '') return [];
  if (Array.isArray(mvs)) {
    return mvs.map((s) => (typeof s === 'string' ? s : (s && (s.name || s.title || s.scenario || s.description)) || JSON.stringify(s)))
      .map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);
  }
  if (typeof mvs === 'object') return mvsLines(mvs.scenarios || mvs.items || Object.values(mvs));
  return String(mvs).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^#/.test(l)).slice(0, 15);
}

const HINTS = {
  PI: ['- repro: <the failing test that proves the incident, named>'],
  BUG: ['- hidden: <the same defect through another input, boundary or caller>', '- hidden: <behaviour next to the fix that must not change>'],
  CR: ['- hidden: <a boundary of a new rule: exactly at the limit, just over, zero, rounding>', '- hidden: <old behaviour the spec does not change>'],
  TASK: ['- deliverable: <each concrete thing the brief asks for: code, endpoint, config, doc line>'],
};

export function contractTemplate({ id, type, points, mvs }) {
  const acc = mvsLines(mvs).map((s, i) => `- MVS ${i + 1}: ${s}`);
  const instruction = type === 'PI'
    ? `Before coding, fill outcome and the repro line. Finish the remaining <...> before MTM review ${id}.`
    : `Fill every <...> before coding (2 minutes, one short line each). MTM review ${id} checks the diff against it.`;
  return [
    `# Task Contract ${id} | ${type} | ${points ?? '?'} pts`,
    instruction,
    '',
    '- outcome: <what the customer sees when this is done, one line>',
    '- acceptance:',
    ...acc.map((l) => `  ${l}`),
    ...(HINTS[type] || HINTS.TASK).map((l) => `  ${l}`),
    '- scope.allowed: <files or folders you expect to change, comma separated (tests are always allowed)>',
    '- scope.excluded: <what must not change: public API shape, DB schema, other features>',
    '- stop_conditions: <when to ship the core or park instead, e.g. it needs a schema change or a new dependency>',
    '- verification: <the evidence command>',
    '- assumptions: <what the brief leaves open and what you chose (repeat these in the submission)>',
    '',
  ].join('\n');
}

const KEYS = ['outcome', 'acceptance', 'scope.allowed', 'scope.excluded', 'stop_conditions', 'verification', 'assumptions'];

/** Fields of a contract; `open` lists the required fields that still hold a <placeholder> or nothing. */
export function parseContract(text, type) {
  const fields = {};
  const acceptance = [];
  let inAcc = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*-?\s*([a-z_.]+)\s*:\s*(.*)$/i);
    if (m && KEYS.includes(m[1].toLowerCase()) && !/^\s{2,}-/.test(raw)) {
      const key = m[1].toLowerCase();
      inAcc = key === 'acceptance';
      if (!inAcc) fields[key] = m[2].trim();
      else if (m[2].trim()) acceptance.push(m[2].trim());
      continue;
    }
    if (inAcc && /^\s+[-*]\s+\S/.test(raw)) acceptance.push(raw.replace(/^\s+[-*]\s+/, '').trim());
    else if (inAcc && raw.trim()) inAcc = false;
  }
  const required = type === 'PI' ? ['outcome', 'acceptance'] : ['outcome', 'acceptance', 'scope.allowed'];
  const open = required.filter((k) => (k === 'acceptance'
    ? !acceptance.some((a) => !PLACEHOLDER.test(a))
    : !fields[k] || PLACEHOLDER.test(fields[k])));
  const openAcceptance = acceptance.filter((a) => PLACEHOLDER.test(a)).length;
  return { fields, acceptance, open, openAcceptance };
}

export function isTestFile(file) {
  const f = String(file).replace(/\\/g, '/');
  return /(^|\/)(tests?|__tests__|specs?|e2e|cypress)(\/|$)/i.test(f)
    || /[._-](test|tests|spec|specs|e2e)\.[a-z0-9]+$/i.test(f)
    || /Tests?\.(java|cs|kt|scala|groovy)$/.test(f)
    || /(_test\.(go|py|rb)|(^|\/)test_[^/]+\.py)$/i.test(f);
}

function globToRegex(pattern) {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(p)) {
    const esc = p.replace(/[.+^${}()|[\]]/g, '\\$&');
    return new RegExp(`^${esc}(\\/.*|\\.[^/]+)?$`, 'i');
  }
  p = p.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${p}(\\/.*)?$`, 'i');
}

/**
 * Files outside the contract's scope.allowed (tests never count). Patterns: comma or semicolon
 * separated paths, folders or globs. A plain name also matches the same name with an extension.
 */
export function scopeCheck(files, allowedText) {
  const pats = String(allowedText || '').split(/[,;]/).map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter((s) => s && !PLACEHOLDER.test(s));
  if (!pats.length) return { checked: false, outOfScope: [] };
  const res = pats.map(globToRegex);
  const outOfScope = files.filter((f) => !isTestFile(f) && !res.some((r) => r.test(f.replace(/\\/g, '/'))));
  return { checked: true, outOfScope };
}

export const REVIEW_INSTRUCTIONS = `You are an independent, read-only reviewer (ADLC Validate: the builder is not the reviewer).
Never edit files, never run a git command that changes anything, never run MTM start, fill or submit.
You may read files and run tests. Answer in at most 10 lines, one finding per line:
GAP | <acceptance line or scenario> | <file:line> | <test or change needed>
or the single word OK. Check, in this order:
1. Each acceptance line of the contract: which test proves it? Name it, or report a GAP.
2. Scenarios the Grader likely runs beyond MVS that no test covers: exact boundaries, just before and after,
   empty, null or missing input, case and whitespace, other callers of the changed code, old behaviour that must stay.
3. Root cause: does the change fix every path through that code, or only the reported example?
4. Changes outside scope.allowed or touching scope.excluded (public API shape, schema, other features),
   debug leftovers, scratch files, a deleted or weakened test.
5. Tests that were not run, and why.`;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Observe: one page per match from the ledger and the last snapshot. Signals over assumptions:
 * real minutes against the planner's estimates, FAILED items next to what was checked, refusals.
 */
export function buildRetro({ matchId, ledger, items, estMinutes, score, typeOf }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = [...new Set([...Object.keys(ledger), ...byId.keys()])].filter((id) => id !== 'BASELINE').sort();
  const rows = [];
  const per = {};
  const signals = [];
  for (const id of ids) {
    const l = ledger[id] || {};
    const s = byId.get(id) || {};
    const type = s.type || l.type || typeOf(id);
    const mins = l.submittedAt && l.startedAt ? (l.activeMs > 0 ? l.activeMs : l.submittedAt - l.startedAt) / 60000 : null;
    if (mins != null) (per[type] = per[type] || []).push(mins);
    const runs = (l.evidence || []).length;
    const passRuns = (l.evidence || []).filter((e) => e.exit === 0 && !e.timedOut).length;
    const result = s.result ? `${s.result}${s.score != null ? ` ${s.score}` : ''}` : (l.submittedAt ? 'submitted' : l.parkedAt ? 'parked' : l.startedAt ? 'not submitted' : 'not started');
    rows.push(`| ${id} | ${type} | ${s.maxPoints ?? '-'} | ${result} | ${mins == null ? '-' : mins.toFixed(1)} | ${estMinutes[type] ?? '-'} | ${passRuns}/${runs} | ${l.reviews?.length ? 'yes' : 'no'} | ${l.contractOpen == null ? '-' : l.contractOpen.length ? `open: ${l.contractOpen.join(' ')}` : 'filled'} |`);
    if (/FAILED/.test(s.result || '')) signals.push(`- ${id} FAILED: review ${l.reviews?.length ? 'ran' : 'did NOT run'}; contract ${l.contractOpen?.length ? 'left open' : 'filled'}. Compare its contract and tests with the scenarios the organizers publish, then add the missed kind of scenario to the ${type} playbook.`);
    if (!l.startedAt && s.maxPoints) signals.push(`- ${id} (${type}, ${s.maxPoints} pts) never started.`);
    if (l.parkedAt) signals.push(`- ${id} parked: ${l.parkReason || 'no reason given'}.`);
    if (l.submitRejections) signals.push(`- ${id}: ${l.submitRejections} submit refusals from the server.`);
    if (l.startRefusals) signals.push(`- ${id}: ${l.startRefusals} Start working refusals.`);
    if (l.startedAt && !l.submittedAt && !l.parkedAt) signals.push(`- ${id} started but not submitted: time lost.`);
  }
  const tune = Object.entries(per).map(([t, xs]) => {
    const med = median(xs);
    const est = estMinutes[t];
    const off = est ? Math.abs(med - est) / est : 1;
    return `- ${t}: median ${med.toFixed(1)} min over ${xs.length} (estMinutes ${est ?? '-'})${off > 0.3 ? ` -> set planner.estMinutes.${t} to ${Math.round(med)}` : ' -> keep'}`;
  });
  return [
    `# Retro, match ${matchId ?? '?'}${score != null ? ` (score ${score})` : ''}`,
    'ADLC Observe: what the match showed. Humans turn each repeated mistake into one rule in codex/AGENTS.md or a playbook, run npm test, reinstall.',
    '',
    '| ID | type | pts | result | active min | est min | passing evidence/runs | reviewed | contract |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Signals',
    ...(signals.length ? signals : ['- none']),
    '',
    '## Tune the planner (tool/gm.config.json, planner.estMinutes)',
    ...(tune.length ? tune : ['- no submitted items yet']),
    '',
  ].join('\n');
}
