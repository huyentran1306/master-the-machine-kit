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
    { name: 'home-after.png', before: false, strict: true },
    { name: 'run.log', before: false, strict: true },
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
  // The search is asked again with the title alone; a long query dilutes semantic search.
  assert.equal(calls.length, 4);
  assert.equal(calls[3].name, 'lookup_handbook'); assert.equal(calls[3].args.searchText, 'TASK-91 Synthetic rounding');
});

test('MCP timeouts are nonfatal and leave an explicit brief failure record', async () => {
  const result = await collectMcpMaterial({ id: 'TASK-91' }, () => new Promise(() => {}), 10);
  assert.equal(result[0].ok, false); assert.ok(result[0].error);
});

test('required lines, sections and tables are strict; incidental evidence stays a warning', async t => {
  for (const description of ['Required evidence: panel.png.', 'Required artifacts: panel.png.', '## Required evidence\n| File |\n|---|\n| panel.png |', 'Required artifacts:\n- panel.png', '| Required evidence |\n|---|\n| panel.png |']) {
    assert.equal(extractWithStrictness({ description })[0].strict, true, description);
  }
  const f = fixture(t);
  f.s.items.get('TASK-91').description = 'Evidence example: optional.png.';
  const r = await f.submit();
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.includes('CHECK_EVIDENCE')));
});

test('only anchored evidence paths normalize; source asset paths never become outputs', () => {
  assert.deepEqual(extractWithStrictness({ description: 'Capture a screenshot after editing assets/evidence/logo.png. Save answers/X-9/evidence/result.png and evidence/local.png.' }).map(e => e.name), ['result.png', 'local.png']);
});

test('explicit evidence paths bypass the prose extension heuristic', () => {
  const result = extractWithStrictness({ description: 'Required evidence: evidence/session.yaml, answers/X-9/evidence/stream.jsonl, evidence/events.ndjson, evidence/custom.xyz. Record data.steps.' });
  assert.deepEqual(result.map(e => e.name), ['session.yaml', 'stream.jsonl', 'events.ndjson', 'custom.xyz']);
  assert.ok(result.every(e => e.strict));
});

test('preflight migrates old cached evidence and enforces freshly extracted requirements', async t => {
  const f = fixture(t);
  f.s.items.get('TASK-91').description = 'Record data.steps. Required evidence: panel.png.';
  f.s.materialCache['TASK-91'].requiredEvidence = [{ name: 'data.steps', before: false }];
  const r = await f.submit();
  assert.ok(r.errors.some(e => e.includes('panel.png')));
  assert.ok(r.errors.every(e => !e.includes('data.steps')));
  assert.deepEqual(f.s.readMaterial('TASK-91').requiredEvidence, [{ name: 'panel.png', before: false, strict: true }]);
});

test('logs and optional discovery require read-only names or annotations and reject action verbs', async () => {
  const verbs = 'restart send deploy reset notify trigger run execute apply approve cancel create update delete write submit mutate post pay void issue email toggle enable disable set'.split(' ');
  const advertised = [
    ...verbs.map(v => ({ name: `${v}_service`, description: 'Read logs', annotations: { readOnlyHint: true } })),
    { name: 'mystery_logs' }, { name: 'mystery' }, { name: 'get_logs', annotations: { readOnlyHint: false } },
    { name: 'fetch_logs' }, { name: 'show_inventory' }, { name: 'inventory', annotations: { readOnlyHint: true } },
  ];
  const calls = [];
  await collectMcpMaterial({ id: 'X-9' }, async req => {
    if (req.action === 'tools') return { ok: true, tools: advertised };
    calls.push(req.name); return { ok: true };
  });
  assert.deepEqual(calls, ['fetch_logs', 'show_inventory', 'inventory']);
});

test('MCP first attempts precede title retries and optional discovery', async () => {
  const calls = [];
  const tools = ['fetch_test_data', 'search_docs', 'get_logs', 'get_inventory'].map(name => ({ name, inputSchema: { properties: { query: { type: 'string' } } } }));
  await collectMcpMaterial({ id: 'X-9', title: 'Synthetic', description: 'Details' }, async req => {
    if (req.action === 'tools') return { ok: true, tools };
    calls.push(req); if (req.name === 'search_docs') throw new Error('synthetic failure');
    return { ok: true };
  });
  assert.deepEqual(calls.map(c => c.name), ['fetch_test_data', 'search_docs', 'get_logs', 'search_docs', 'get_logs', 'get_inventory']);
  assert.equal(calls[3].args.query, 'X-9 Synthetic');
});

test('slow first attempts leave time for logs; optional tools share a smaller budget', async () => {
  const calls = [];
  const tools = ['fetch_test_data', 'search_docs', 'get_logs'].map(name => ({ name }));
  const start = Date.now();
  await collectMcpMaterial({ id: 'X-9' }, req => {
    if (req.action === 'tools') return Promise.resolve({ ok: true, tools });
    calls.push(req.name); return new Promise(() => {});
  }, 180);
  assert.deepEqual(calls, tools.map(t => t.name));
  assert.ok(Date.now() - start < 1500);
  const optionalStart = Date.now();
  const optionalCalls = [];
  await collectMcpMaterial({ id: 'X-9' }, req => {
    if (req.action === 'tools') return Promise.resolve({ ok: true, tools: [{ name: 'get_inventory' }, { name: 'get_catalog' }] });
    optionalCalls.push(req.name); return new Promise(() => {});
  });
  assert.deepEqual(optionalCalls, ['get_inventory']);
  assert.ok(Date.now() - optionalStart < 4000);
});
