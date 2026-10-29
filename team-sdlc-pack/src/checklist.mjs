// A per-item checklist, handed back by start_work at the moment the work begins.
//
// Why: in a 40-minute match the orchestrator reads its skill once, at startup, and then runs for
// dozens of turns. Long-horizon agents drift from instructions they were given early ("instruction
// fade-out"), so rules like "run the whole suite" and "check every acceptance criterion" fade exactly
// when they matter — at submission time. A short checklist delivered at the decision point survives
// that drift far better than a longer skill read 30 minutes earlier.
//
// The checklist is built from the item's own material (the organizer's acceptance criteria and
// minimum verification scenarios), not from a generic template, so it says what THIS item needs.

const MAX_CRITERIA = 12;
const MAX_LINE = 220;

/**
 * Does this evidence file hold the output of a real test run?
 * Judged by content, not by file name: a team may call it `BUG-11-TC-01.md` and still have pasted
 * the runner output into it. Refusing a correct submission mid-match because a file is named
 * differently would cost far more than it saves, so the name is only one of several signals.
 */
export function looksLikeTestOutput(text) {
  if (typeof text !== 'string' || text.trim().length < 12) return false;
  if (/\bNOT_RUN\b/.test(text)) return false;
  const signals = [
    /\b\d+\s+(?:tests?\s+)?(?:passed|passing|failed|failing|ok|skipped)\b/i, // "6 passed", "2 failing"
    /\bTests?\s*[:=]\s*\d+/i, //  "Tests: 6"
    /\b(?:Test Files|Suites?|Assertions?)\b.*\d+/i,
    /\b(?:vitest|jest|mocha|pytest|phpunit|rspec|junit|go test|cargo test|dotnet test|gradle(?:w)? test|mvn .*test)\b/i,
    /^(?:PASS|FAIL|ok|not ok)\b/im, // TAP / jest per-file lines
    /✓|✗|√|×/,
  ];
  return signals.filter((re) => re.test(text)).length >= 1;
}

/** Lines that read like a requirement rather than prose. */
function criteriaFrom(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > MAX_LINE * 2) continue;
    const bullet = /^([-*•]|\d+[.)])\s+/.test(line);
    // "must/should/returns/expects" catch requirement sentences written as prose.
    const imperative = /\b(must|should|shall|required|returns?|responds?|expects?|rejects?|validates?|ensures?)\b/i.test(line);
    if (!bullet && !imperative) continue;
    const cleaned = line.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
    if (cleaned.length < 8) continue;
    out.push(cleaned.length > MAX_LINE ? `${cleaned.slice(0, MAX_LINE)}…` : cleaned);
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}

/** Scenario names out of the organizer's minimumVerificationScenarios, whatever shape it arrives in. */
export function scenarioNames(mvs) {
  if (!mvs) return [];
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim().slice(0, MAX_LINE));
    else if (v && typeof v === 'object') {
      const label = v.name ?? v.scenario ?? v.title ?? v.id ?? null;
      if (typeof label === 'string' && label.trim()) out.push(label.trim().slice(0, MAX_LINE));
    }
  };
  if (Array.isArray(mvs)) mvs.forEach(push);
  else if (typeof mvs === 'string') criteriaFrom(mvs).forEach(push);
  else if (typeof mvs === 'object') for (const v of Object.values(mvs)) (Array.isArray(v) ? v : [v]).forEach(push);
  return out.slice(0, MAX_CRITERIA);
}

const BY_TYPE = {
  BUG: ['Write the reproduction test first; RUN IT ON THE UNFIXED CODE. Save exact commands and failing before/passing after output in evidence/<ID>-repro.md. Cite the introducing commit from folder-scoped history in analysis; stop searching after 2 minutes and record it as unconfirmed.',
    'Fix the cause, not the symptom; keep the change inside the smallest file set that fixes it.'],
  CR: ['Find the authoritative spec for this change (the match MCP server often holds it: call match_mcp before assuming it is unavailable).',
    'Follow the spec exactly — field names, order, formats. A CR is graded against the spec, not against what looks reasonable.'],
  PI: ['PI is scored by finishing order: take the shortest correct path and submit as soon as it passes.',
    'Do not polish. Correct and early beats complete and late.'],
  TASK: ['Implement exactly what is asked, no extra scope.'],
};

/**
 * Builds the checklist for one item.
 * Returns { criteria, scenarios, steps, text } — `steps` is what the agent works through, `text` is
 * the markdown copy written next to the answer so it survives a context reset or an agent restart.
 */
export function buildChecklist({ id, type, startInstruction = '', description = '', minimumVerificationScenarios = null, requiredScenarios = 0, commands = {}, appPath = null } = {}) {
  const criteria = criteriaFrom(startInstruction).length ? criteriaFrom(startInstruction) : criteriaFrom(description);
  const scenarios = scenarioNames(minimumVerificationScenarios);
  const kind = BY_TYPE[type] ? type : 'TASK';
  const where = appPath ? ` (from ${appPath})` : '';
  const test = commands.test || 'the repo test command';
  const typecheck = commands.typecheck || null;

  const steps = [
    `Turn the acceptance criteria below into the definition of done for ${id}; nothing else counts.`,
    ...BY_TYPE[kind],
    `Implement, then run ${test}${where}. Save the full output as evidence/test.log — submit_work refuses an item with no test evidence.`,
    ...(typecheck ? [`Run ${typecheck} as well; a type error is a failed item even when tests pass.`] : []),
    requiredScenarios > 0
      ? `Cover all ${requiredScenarios} required verification scenario(s), plus the hidden cases the criteria imply.`
      : 'Cover the stated scenarios plus the hidden cases the criteria imply.',
    'Before submitting, walk the criteria one by one and point each at the evidence line that proves it. A criterion with no evidence is not done.',
    'Self-review every criterion inline; commit code, tests, evidence and answer, then return READY/PARKED with SHA and counts. The orchestrator integrates, pushes and submits.',
  ];

  const lines = [`# ${id} — checklist`, '', '## Acceptance criteria'];
  if (criteria.length) criteria.forEach((c, i) => lines.push(`- [ ] ${i + 1}. ${c}`));
  else lines.push('- [ ] (no criteria parsed — read startInstruction in full and write them here yourself)');
  if (scenarios.length) {
    lines.push('', '## Required verification scenarios');
    scenarios.forEach((s) => lines.push(`- [ ] ${s}`));
  }
  lines.push('', '## Steps', ...steps.map((s) => `- [ ] ${s}`), '',
    '> Tick each box only once you can name the evidence that proves it.');

  return { criteria, scenarios, steps, text: `${lines.join('\n')}\n` };
}
