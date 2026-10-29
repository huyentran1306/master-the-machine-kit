import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractRequiredEvidence as extractWithStrictness } from '../team-sdlc-pack/src/required-evidence.mjs';
// Most cases check names and before flags; strictness has its own test below.
const extractRequiredEvidence = (...args) => extractWithStrictness(...args).map(({ name, before }) => ({ name, before }));
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { collectMcpMaterial } from '../team-sdlc-pack/src/mcp-material.mjs';

test('extract named evidence from prose, backticks, paths, template and MVS with before flags', () => {
  assert.deepEqual(extractRequiredEvidence({
    description: 'Capture a screenshot BEFORE fixing as `panel-original.png` and commit it to evidence/.\nSave as panel-final.png.\nAttach evidence/nested/check.json.',
    acceptanceCriteria: ['Record baseline in `baseline.txt`.'],
  }, {
    startInstruction: 'Save a screenshot before the change as initial.png.\nCommit evidence/nested/check.json.',
    submitTemplate: { testResults: [{ evidence: ['evidence/report.log'] }] },
    minimumVerificationScenarios: [{ evidence: 'trace.json' }],
  }), [
    { name: 'panel-original.png', before: true }, { name: 'panel-final.png', before: false },
    { name: 'nested/check.json', before: false }, { name: 'baseline.txt', before: true },
    { name: 'initial.png', before: true }, { name: 'report.log', before: false }, { name: 'trace.json', before: false },
  ]);
});

test('extractor ignores fenced/inline code, URLs, source paths and ordinary file mentions', () => {
  const description = [
    'Read `settings.json` and src/view.ts.',
    'Screenshot help: https://synthetic.invalid/evidence/remote.png',
    'Capture guide [sample](https://synthetic.invalid/guide.png).',
    'Example: `record("not-evidence.json")`.',
    'Capture the page rendered by `src/view.ts` and `view.ts`.',
    '```js', 'save("example.png"); // evidence/fake.json', '```',
    '    save("indented.png"); // evidence/also-fake.json',
  ].join('\n');
  assert.deepEqual(extractRequiredEvidence({ description }), []);
});

test('wrapped requirements, indented evidence lists and serialized templates preserve named artifacts', () => {
  assert.deepEqual(extractRequiredEvidence({ description: 'Capture a screenshot before fixing and save as\n`wrapped.png`.\n\nRequired evidence:\n    - `listed.json`' }, {
    submitTemplate: JSON.stringify({ testResults: [{ evidence: ['evidence/serialized.log'] }] }, null, 2),
  }), [{ name: 'wrapped.png', before: true }, { name: 'listed.json', before: false }, { name: 'serialized.log', before: false }]);
});

test('answer file, organizer templates/schemas, verification specs and provided files are not evidence', () => {
  const description = [
    '## Submission',
    'Create `answers/X-9/` with `submit.json` (copied from `challenge/X-9-submit.json`) and an `evidence/` child folder.',
    'Follow the evidence rules and file names in `X-9-minimum-verification-scenarios.md`. Validate against `X-9-submit.schema.json`.',
    'Record the output of `X-9-fixture.csv` and capture `home_before_change.png` before changing the page.',
  ].join('\n');
  assert.deepEqual(extractRequiredEvidence({ description }, { files: { 'challenge/X-9-fixture.csv': 'a,b' } }),
    [{ name: 'home_before_change.png', before: true }]);
});

test('only unambiguous names block submission; other mentions are reminders', () => {
  const description = [
    '## Required evidence', '| File | Content |', '|---|---|',
    '| `home-before.png` | Home page before the change |',
    '| `home-after.png` | Same page after the change |',
    '| `run.log` | Written by the provided runner |',
    'Capture a screenshot of the list as `list.png` and save the data as `evidence/x-9-data.json`.',
  ].join('\n');
  assert.deepEqual(extractWithStrictness({ description }), [
    { name: 'home-before.png', before: true, strict: true },
    { name: 'home-after.png', before: false, strict: false },
    { name: 'run.log', before: false, strict: false },
    { name: 'list.png', before: false, strict: true },
    { name: 'x-9-data.json', before: false, strict: true },
  ]);
});

test('full answers/<ID>/evidence paths count; JSON field references do not', () => {
  const description = 'Obtain the official data and save it unchanged as `answers/X-9/evidence/x-9-data.json`. `data.rows` lists the values to enter; record each case.';
  assert.deepEqual(extractRequiredEvidence({ description }), [{ name: 'x-9-data.json', before: false }]);
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-material-'));
  t.after(() => { assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(cwd, { recursive: true, force: true }); });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Synthetic'); git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  const write = (name, value) => { const file = path.join(cwd, 'assigned', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const commit = () => { git(cwd, 'add', 'assigned'); git(cwd, 'commit', '-qm', 'synthetic change'); const sha = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'update-ref', 'refs/remotes/origin/main', sha); return sha; };
  write('app.txt', 'baseline'); const baseline = commit();
  const s = new RuntimeSession({ teamWorkspace: cwd });
  s.checkoutRoot = cwd; s.matchRoot = path.join(cwd, 'assigned'); s.repository = { branch: 'main', folder: 'assigned' };
  s.state.envReady = { revision: baseline }; s.phase = 'GAME'; s.bearer = 'synthetic-token';
  s.match.uuid = '11111111-2222-4333-8444-555555555555'; s.match.status = 'IN_PROGRESS';
  s.items.set('TASK-91', { id: 'TASK-91', type: 'TASK', description: 'Capture before fixing as panel-original.png.', local: { startedAt: Date.now() } });
  s.lastTests = { 'TASK-91': { status: 'PASSED', executed: 1, passed: 1, failed: 0 } };
  s.materialCache = { 'TASK-91': { files: {}, requiredEvidence: [{ name: 'panel-original.png', before: true }] } };
  const answer = { backlogId: 'TASK-91', status: 'DONE', testResults: [{ id: 'case-a', result: 'PASS', evidence: ['evidence/test.log'] }] };
  write('answers/TASK-91/evidence/test.log', 'Tests: 1 passed, 1 total');
  write('answers/TASK-91/submit.json', answer); commit();
  return { cwd, s, answer, write, commit, submit: opts => s.submit_work({ backlogItemKey: 'TASK-91', dryRun: true, ...opts }) };
}

test('submit and dryRun refuse missing committed evidence despite files in the working tree or broad waivers', async t => {
  const f = fixture(t);
  f.write('answers/TASK-91/evidence/panel-original.png', 'synthetic image bytes');
  for (const dryRun of [true, false]) {
    const result = await f.submit({ dryRun, allowNoEvidence: true, allowUntested: true });
    assert.equal(result.refused, true);
    assert.ok(result.errors.includes(`REQUIRED_EVIDENCE_MISSING: assigned/answers/TASK-91/evidence/panel-original.png is not a regular file in commit ${git(f.cwd, 'rev-parse', 'HEAD').slice(0, 12)}; add answers/TASK-91/evidence/panel-original.png and commit it.`));
    assert.deepEqual(f.s.state.submissions, {});
  }
});

test('present evidence must be in an evidence array; passing preflight reads the selected commit', async t => {
  const f = fixture(t);
  f.write('answers/TASK-91/evidence/panel-original.png', 'synthetic image bytes');
  f.answer.note = 'evidence/panel-original.png';
  f.write('answers/TASK-91/submit.json', f.answer); const unreferenced = f.commit();
  for (const dryRun of [true, false]) {
    const r = await f.submit({ dryRun });
    assert.deepEqual(r.errors, ['REQUIRED_EVIDENCE_UNREFERENCED: add "evidence/panel-original.png" to at least one evidence array in answers/TASK-91/submit.json and commit it.']);
  }
  f.answer.testResults[0].evidence.push('evidence/panel-original.png');
  f.write('answers/TASK-91/submit.json', f.answer); f.commit();
  assert.equal((await f.submit()).ok, true);
  assert.equal((await f.submit({ gitRevision: unreferenced })).refused, true);
});

test('exact-name extraction override requires a reason and records it without waiving other names', async t => {
  const f = fixture(t);
  assert.equal((await f.submit({ allowMissingEvidence: ['panel-original.png'] })).refused, true);
  assert.equal((await f.submit({ allowMissingEvidence: ['unknown.png'], reason: 'synthetic mistake' })).refused, true);
  const r = await f.submit({ allowMissingEvidence: ['panel-original.png'], reason: 'The name appears only in an optional example.' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.includes('allowMissingEvidence: panel-original.png; reason: The name appears only in an optional example.'));
});

test('BLOCKED, all unrun/failed and all-zero answers require allowBlocked with recorded reason', async t => {
  const f = fixture(t);
  f.s.materialCache['TASK-91'].requiredEvidence = [];
  for (const answer of [
    { ...f.answer, status: 'BLOCKED' },
    { ...f.answer, testResults: [{ result: 'NOT_RUN', evidence: ['evidence/test.log'] }, { result: 'FAIL' }] },
    { ...f.answer, testCases: [{ score: 0 }, { score: 0 }], testResults: [] },
  ]) {
    f.write('answers/TASK-91/submit.json', { ...answer, evidence: ['evidence/test.log'] }); f.commit();
    for (const dryRun of [true, false]) assert.match((await f.submit({ dryRun })).errors[0], /^UNSCORABLE_ANSWER:/);
    assert.equal((await f.submit({ allowBlocked: true })).refused, true);
    const result = await f.submit({ allowBlocked: true, reason: 'Final minute; no better verified result remains.' });
    assert.equal(result.ok, true); assert.ok(result.warnings.some(w => w.startsWith('allowBlocked: Final minute;')));
  }
  f.write('answers/TASK-91/submit.json', { ...f.answer, status: 'PARTIAL', testResults: [...f.answer.testResults, { result: 'FAIL' }] }); f.commit();
  assert.equal((await f.submit()).ok, true);
});

test('MCP discovery matches purpose and schemas, records failures, skips mutations', async () => {
  const calls = [];
  const tools = [
    { name: 'fetch_fixture_bundle', description: 'Retrieve test data for an item', inputSchema: { properties: { itemKey: { type: 'string' } }, required: ['itemKey'] } },
    { name: 'lookup_handbook', description: 'Search knowledge documents', inputSchema: { properties: { searchText: { type: 'string' }, limit: { type: 'integer' } }, required: ['searchText', 'limit'] } },
    { name: 'load_scenarios', description: 'Return scenario data', inputSchema: { properties: { unknown: { type: 'string' } }, required: ['unknown'] } },
    { name: 'delete_fixture', description: 'Retrieve test data and delete it', inputSchema: {} },
  ];
  const result = await collectMcpMaterial({ id: 'TASK-91', title: 'Synthetic rounding', description: 'Rounding totals' }, async req => {
    calls.push(req);
    if (req.action === 'tools') return { ok: true, tools };
    if (req.name === 'lookup_handbook') throw new Error('synthetic outage');
    return { ok: true, raw: { content: [{ type: 'text', text: '{"rows":[7]}' }] } };
  });
  assert.deepEqual(calls[1].args, { itemKey: 'TASK-91' });
  assert.match(calls[2].args.searchText, /TASK-91 Synthetic rounding Rounding totals/);
  assert.equal(calls[2].args.limit, 5);
  assert.ok(result.some(e => e.error === 'synthetic outage'));
  assert.ok(result.some(e => /Cannot infer required argument/.test(e.error || '')));
  assert.equal(calls.length, 3);
});

test('MCP timeouts are nonfatal and leave an explicit brief failure record', async () => {
  const result = await collectMcpMaterial({ id: 'TASK-91' }, () => new Promise(() => {}), 10);
  assert.equal(result[0].ok, false); assert.ok(result[0].error);
});
