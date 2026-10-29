import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeItemBrief } from '../team-sdlc-pack/src/item-brief.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { rank, alerts } from '../team-sdlc-pack/src/planner.mjs';
import { TOOLS } from '../team-sdlc-pack/src/tools.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const material = {
  startInstruction: 'Run the supplied verifier.', minimumVerificationScenarios: [{ id: 'CR-07-TC-01', evidence: 'result.json' }],
  submitTemplate: { backlogId: 'CR-07', status: 'DRAFT' },
  files: { 'qa/data.json': '{"input":7}\r\n', 'qa/run-checks.mjs': "import data from './data.json';\n", 'qa/schema.json': { type: 'object' } },
};
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-brief-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  const matchRoot = path.join(root, 'assigned');
  fs.mkdirSync(matchRoot);
  return { checkoutRoot: root, matchRoot, item: { id: 'CR-07', type: 'CR', title: 'Export', description: 'Export all rows.', acceptanceCriteria: ['All rows'] }, material };
}

test('brief writer keeps item, MVS, template and exact organizer contents inside matchRoot', t => {
  const args = setup(t);
  const result = writeItemBrief(args);
  const brief = JSON.parse(fs.readFileSync(result.briefFile, 'utf8'));
  assert.deepEqual(brief.item, args.item);
  for (const key of ['startInstruction', 'minimumVerificationScenarios', 'submitTemplate']) assert.deepEqual(brief[key], material[key]);
  for (const [name, file] of Object.entries(result.files)) {
    assert.ok(file.startsWith(args.matchRoot + path.sep));
    assert.equal(fs.readFileSync(file, 'utf8'), typeof material.files[name] === 'string' ? material.files[name] : JSON.stringify(material.files[name], null, 2));
    assert.ok(git(args.checkoutRoot, 'check-ignore', file));
  }
  assert.ok(git(args.checkoutRoot, 'check-ignore', result.briefFile));
  assert.equal(git(args.checkoutRoot, 'status', '--short'), '');
});

test('brief writer rejects escaping paths and missing Start Work material', t => {
  const args = setup(t);
  for (const name of ['../escape', 'nested/../../escape', '..\\escape', '/absolute', 'C:\\escape', '\\\\host\\share', 'nested/./file']) {
    assert.throws(() => writeItemBrief({ ...args, material: { ...material, files: { [name]: 'bad' } } }), /Unsafe brief path/);
  }
  assert.throws(() => writeItemBrief({ ...args, material: null }), /Start Work material is missing/);
  assert.throws(() => writeItemBrief({ ...args, item: { id: '../escape' } }), /Unsafe brief path/);
  assert.equal(fs.existsSync(path.join(args.checkoutRoot, 'escape')), false);
});

test('worktree create returns ignored, readable child paths and moves only the draft answer', async t => {
  const args = setup(t);
  git(args.checkoutRoot, 'config', 'user.name', 'Fixture');
  git(args.checkoutRoot, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(args.matchRoot, 'app.txt'), 'baseline');
  git(args.checkoutRoot, 'add', 'assigned');
  git(args.checkoutRoot, 'commit', '-qm', 'baseline');
  const s = new RuntimeSession({ teamWorkspace: args.checkoutRoot });
  s.checkoutRoot = args.checkoutRoot; s.matchRoot = args.matchRoot;
  s.repository = { folder: 'assigned' }; s.materialCache = { 'CR-07': material };
  s.items.set('CR-07', { ...args.item, local: { startedAt: Date.now() } });
  const draft = path.join(args.matchRoot, 'answers', 'CR-07');
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'checklist.md'), 'Check every row');
  const out = await s.worktree({ action: 'create', backlogItemKey: 'CR-07' });
  assert.equal(out.ok, true);
  assert.equal(out.checkoutRoot, out.worktreeRoot);
  assert.equal(out.folder, 'assigned');
  assert.ok(out.brief.briefFile.startsWith(out.matchRoot + path.sep));
  assert.equal(fs.readFileSync(path.join(out.answer.dir, 'checklist.md'), 'utf8'), 'Check every row');
  assert.equal(fs.existsSync(draft), false);
  assert.ok(git(out.worktreeRoot, 'check-ignore', out.brief.briefFile));
  assert.doesNotMatch(git(out.worktreeRoot, 'status', '--short', '--untracked-files=all'), /mtm-briefs/);
  assert.match(out.next, /fork_turns:"none"/);
  assert.ok(out.next.includes(out.brief.briefFile));
  assert.ok(out.next.includes(out.brief.filesDir));
  assert.deepEqual(JSON.parse(fs.readFileSync(out.brief.briefFile, 'utf8')).submitTemplate, material.submitTemplate);
});

async function startFixture(t) {
  const args = setup(t);
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ backlogType: 'CR', ...material, replay: requests.length > 1 }));
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const s = new RuntimeSession({ teamWorkspace: args.checkoutRoot });
  s.checkoutRoot = args.checkoutRoot; s.matchRoot = args.matchRoot; s.repository = { folder: 'assigned' };
  s.phase = 'GAME'; s.bearer = 'synthetic-token'; s.match.uuid = '11111111-2222-4333-8444-555555555555';
  s.match.status = 'IN_PROGRESS'; s.apiBase = origin; s.allowedApiOrigins = [origin];
  s.now = () => 1_000_000; s.match.endsAt = s.now() + 40 * 60000;
  s.items.set(args.item.id, { ...args.item, description: 'SYNTHETIC_DESCRIPTION '.repeat(1000), maxPoints: 150,
    deadlineAt: s.now() + 18 * 60000, local: {} });
  s.commands = { test: 'node --test', build: 'npm run build' }; s.appPath = path.join(args.matchRoot, 'src');
  return { args, s, requests };
}

test('start_work defaults compact and writes complete briefs without leaking item material', async t => {
  const { args, s, requests } = await startFixture(t);
  const result = await s.start_work({ backlogItemKey: args.item.id });
  assert.equal(result.ok, true); assert.equal(result.id, args.item.id); assert.equal(result.points, 150);
  // 18 minutes left: a quarter (4.5) is kept for integration and submission.
  assert.equal(result.workerStopAt, s.now() + 13.5 * 60000);
  assert.ok(result.summary.length <= 5);
  assert.ok(JSON.stringify(result).length < 2500);
  for (const key of ['description', 'startInstruction', 'submitTemplate', 'minimumVerificationScenarios', 'files', 'checklist']) assert.equal(key in result, false, key);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_DESCRIPTION|Run the supplied verifier|DRAFT/);
  assert.ok(path.isAbsolute(result.playbook)); assert.ok(result.playbook.endsWith(path.join('backlog-cr', 'SKILL.md')));
  const brief = JSON.parse(fs.readFileSync(result.briefFile, 'utf8'));
  assert.equal(brief.item.description, s.items.get(args.item.id).description);
  assert.deepEqual(brief.item.acceptanceCriteria, args.item.acceptanceCriteria);
  assert.deepEqual(result.requiredEvidence, [{ name: 'result.json', before: false, strict: false }]);
  assert.deepEqual(brief.requiredEvidence, result.requiredEvidence);
  assert.equal(brief.startInstruction, material.startInstruction);
  assert.deepEqual(brief.minimumVerificationScenarios, material.minimumVerificationScenarios);
  assert.deepEqual(brief.submitTemplate, material.submitTemplate);
  assert.deepEqual(brief.commands, s.commands);
  assert.ok(fs.existsSync(result.answer.submitJson)); assert.ok(fs.existsSync(result.checklistFile));
  assert.equal(fs.readFileSync(brief.files['qa/data.json'], 'utf8'), material.files['qa/data.json']);
  assert.deepEqual(requests, [{ backlogItemKey: args.item.id }]);
  assert.equal(TOOLS.find(t => t.name === 'start_work').inputSchema.properties.compact.default, true);
  const replay = await s.start_work({ backlogItemKey: args.item.id, compact: true });
  assert.equal(replay.briefFile, result.briefFile);
});

test('start_work full mode retains description, template, checklist and supplied files', async t => {
  const { args, s } = await startFixture(t);
  const result = await s.start_work({ backlogItemKey: args.item.id, compact: false });
  assert.equal(result.ok, true); assert.match(result.description, /SYNTHETIC_DESCRIPTION/);
  assert.deepEqual(result.submitTemplate, material.submitTemplate);
  assert.deepEqual(result.minimumVerificationScenarios, material.minimumVerificationScenarios);
  assert.equal(result.files['qa/data.json'], material.files['qa/data.json']);
  assert.ok(result.checklist.length); assert.ok(result.providedRunners.length);
  assert.deepEqual(result.requiredEvidence, [{ name: 'result.json', before: false, strict: false }]);
});

test('compact start and worktree brief retain raw MCP material from differently named HTTP tools; follow-ups append', async t => {
  const { args, s } = await startFixture(t);
  const calls = [];
  const large = 'synthetic material '.repeat(2000);
  const offered = [
    { name: 'retrieve_case_inputs', description: 'Get test data for a backlog item', inputSchema: { type: 'object', properties: { backlog_item_key: { type: 'string' } }, required: ['backlog_item_key'] } },
    { name: 'find_reference_pages', description: 'Search documentation and knowledge base', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'read_reference_page', description: 'Get a document by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  ];
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body); calls.push(msg);
    if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = msg.method === 'initialize' ? { serverInfo: { name: 'synthetic-mcp' }, capabilities: {} }
      : msg.method === 'tools/list' ? { tools: offered }
        : { content: [{ type: 'text', text: large }], structuredContent: { rows: [7, 9] } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  s.adapter.matchView.mcpUrl = `${origin}/mcp`; s.allowedMatchOrigins = [origin];
  s.items.get(args.item.id).description += '\nCapture before the change as panel-original.png.';
  const out = await s.start_work({ backlogItemKey: args.item.id });
  assert.ok(out.requiredEvidence.some(e => e.name === 'panel-original.png' && e.before));
  let brief = JSON.parse(fs.readFileSync(out.briefFile, 'utf8'));
  assert.deepEqual(brief.mcpMaterial.map(e => e.purpose).slice(0, 3), ['discovery', 'data', 'search']);
  const raw = JSON.parse(fs.readFileSync(brief.mcpMaterial[1].file, 'utf8'));
  assert.equal(raw.raw.content[0].text, large);
  assert.deepEqual([...new Set(calls.filter(c => c.method === 'tools/call').map(c => c.params.name))], ['retrieve_case_inputs', 'find_reference_pages', 'read_reference_page']);
  assert.deepEqual(calls.find(c => c.params?.name === 'retrieve_case_inputs').params.arguments, { backlog_item_key: args.item.id });
  assert.match(calls.find(c => c.params?.name === 'find_reference_pages').params.arguments.query, /CR-07 Export/);
  const checklist = fs.readFileSync(out.checklistFile, 'utf8');
  assert.ok(checklist.indexOf('BEFORE source edits: answers/CR-07/evidence/panel-original.png') < checklist.indexOf('## Acceptance criteria'));
  git(args.checkoutRoot, 'config', 'user.name', 'Synthetic'); git(args.checkoutRoot, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(args.matchRoot, 'app.txt'), 'baseline');
  git(args.checkoutRoot, 'add', 'assigned/app.txt'); git(args.checkoutRoot, 'commit', '-qm', 'baseline');
  const wt = await s.worktree({ action: 'create', backlogItemKey: args.item.id });
  brief = JSON.parse(fs.readFileSync(wt.brief.briefFile, 'utf8'));
  assert.ok(brief.baseSha); assert.ok(brief.mcpMaterial.length >= 3);
  const initialMaterial = brief.mcpMaterial.length;
  for (const entry of brief.mcpMaterial) {
    assert.ok(entry.file.startsWith(wt.matchRoot + path.sep)); assert.ok(fs.existsSync(entry.file));
    assert.ok(git(wt.worktreeRoot, 'check-ignore', entry.file));
  }
  await s.match_mcp({ action: 'call', name: 'read_reference_page', args: { id: 'DOC-SYNTHETIC' }, backlogItemKey: args.item.id });
  brief = JSON.parse(fs.readFileSync(wt.brief.briefFile, 'utf8'));
  assert.equal(brief.mcpMaterial.at(-1).purpose, 'follow-up');
  assert.equal(JSON.parse(fs.readFileSync(brief.mcpMaterial.at(-1).file, 'utf8')).content[0].text, large);
  const replay = await s.start_work({ backlogItemKey: args.item.id });
  assert.equal(JSON.parse(fs.readFileSync(replay.briefFile, 'utf8')).mcpMaterial.length, initialMaterial + 1);
  assert.equal(calls.filter(c => c.method === 'tools/list').length, 1);
});

function worktreeSession(t, adapter) {
  const args = setup(t);
  git(args.checkoutRoot, 'config', 'user.name', 'Synthetic');
  git(args.checkoutRoot, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(args.matchRoot, 'app.txt'), 'baseline\n');
  fs.writeFileSync(path.join(args.matchRoot, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(args.matchRoot, '.env'), 'TEST_DATABASE_URL="postgresql://localhost/synthetic_test"\n');
  git(args.checkoutRoot, 'add', 'assigned'); git(args.checkoutRoot, 'commit', '-qm', 'baseline');
  const s = new RuntimeSession({ teamWorkspace: args.checkoutRoot, adapter });
  s.checkoutRoot = args.checkoutRoot; s.matchRoot = args.matchRoot; s.repository = { folder: 'assigned' };
  s.materialCache = {};
  const create = async (id, type = 'TASK') => {
    if (!s.items.has(id)) s.items.set(id, { id, type, local: { startedAt: Date.now() } });
    s.materialCache[id] = { files: {}, submitTemplate: { backlogId: id } };
    return s.worktree({ action: 'create', backlogItemKey: id });
  };
  return { s, args, create };
}

test('three workers and one PI get distinct persistent ports, private test DBs and remapped paths', async t => {
  const { s, args, create } = worktreeSession(t);
  const outputs = await Promise.all(['TASK-91', 'BUG-92', 'CR-93'].map(id => create(id)));
  assert.ok(outputs.every(o => o.ok));
  assert.equal((await create('TASK-94')).error, 'TOO_MANY_WORKERS');
  outputs.push(await create('PI-95', 'PI'));
  assert.equal(outputs[3].ok, true);
  assert.equal((await create('PI-96', 'PI')).error, 'TOO_MANY_WORKERS');
  const ports = outputs.flatMap(o => Object.values(o.ports)); assert.equal(new Set(ports).size, 8);
  assert.deepEqual(ports, [3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107]);
  for (const out of outputs) {
    const brief = JSON.parse(fs.readFileSync(out.brief.briefFile, 'utf8'));
    assert.deepEqual(brief.ports, out.ports); assert.equal(brief.checkoutRoot, out.worktreeRoot);
    assert.equal(brief.matchRoot, out.matchRoot); assert.equal(brief.answer.submitJson, out.answer.submitJson);
    const env = fs.readFileSync(path.join(out.matchRoot, '.env'), 'utf8');
    assert.match(env, /synthetic_test_wt_/); assert.equal(s.items.get(path.basename(out.worktreeRoot)).local.worktree.envIsolated, true);
  }
  const repeat = await create('TASK-91'); assert.deepEqual(repeat.ports, outputs[0].ports);
  assert.equal(fs.readFileSync(path.join(args.matchRoot, '.env'), 'utf8'), 'TEST_DATABASE_URL="postgresql://localhost/synthetic_test"\n');
  await s.worktree({ action: 'remove', backlogItemKey: 'TASK-91' });
  await s.worktree({ action: 'remove', backlogItemKey: 'PI-95' });
  const replacement = await create('TASK-94'); assert.deepEqual(replacement.ports, { dev: 3108, production: 3109 });
});

test('helper worker cap and port base are configurable', async t => {
  const { s, create } = worktreeSession(t, { parallel: { maxWorkers: 1, portBase: 4200 } });
  assert.deepEqual((await create('TASK-91')).ports, { dev: 4200, production: 4201 });
  assert.equal((await create('TASK-92')).error, 'TOO_MANY_WORKERS');
  assert.deepEqual((await create('PI-93', 'PI')).ports, { dev: 4202, production: 4203 });
  assert.equal(s.view().maxWorkers, 1);
});

test('integration requires worker commits, preserves multiple commits, replays and supports fix-ups', async t => {
  const { s, args, create } = worktreeSession(t);
  const out = await create('TASK-91');
  const integrate = () => s.worktree({ action: 'integrate', backlogItemKey: 'TASK-91' });
  assert.equal((await integrate()).error, 'WORKER_DIRTY', 'draft answer must be committed by worker');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'answer');
  fs.writeFileSync(path.join(out.matchRoot, 'app.txt'), 'implemented\n');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'implementation');
  const result = await integrate(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(args.matchRoot, 'app.txt'), 'utf8'), 'implemented\n');
  assert.ok(fs.existsSync(path.join(args.matchRoot, 'answers/TASK-91/submit.json')));
  assert.equal((await integrate()).replay, true);
  const before = git(args.checkoutRoot, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(out.matchRoot, 'app.txt'), 'verified fix-up\n');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'fix-up');
  assert.equal((await integrate()).ok, true);
  assert.equal(git(args.checkoutRoot, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.equal(fs.readFileSync(path.join(args.matchRoot, 'app.txt'), 'utf8'), 'verified fix-up\n');
});

test('conflict aborts without changing main and delegates repair', async t => {
  const { s, args, create } = worktreeSession(t);
  const out = await create('TASK-91');
  fs.writeFileSync(path.join(out.matchRoot, 'app.txt'), 'worker\n');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'worker');
  fs.writeFileSync(path.join(args.matchRoot, 'app.txt'), 'main\n');
  git(args.checkoutRoot, 'add', 'assigned'); git(args.checkoutRoot, 'commit', '-qm', 'main');
  const before = git(args.checkoutRoot, 'rev-parse', 'HEAD');
  const result = await s.worktree({ action: 'integrate', backlogItemKey: 'TASK-91' });
  assert.equal(result.error, 'CONFLICT'); assert.match(result.next, /Send the worker a fix-up/);
  assert.equal(git(args.checkoutRoot, 'rev-parse', 'HEAD'), before);
  assert.equal(git(args.checkoutRoot, 'status', '--short'), '');
});

test('red gate rollback restores main and permits a complete worker retry', async t => {
  const { s, args, create } = worktreeSession(t);
  const out = await create('TASK-91');
  fs.writeFileSync(path.join(out.matchRoot, 'app.txt'), 'candidate\n');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'candidate');
  assert.equal((await s.worktree({ action: 'integrate', backlogItemKey: 'TASK-91' })).ok, true);
  assert.equal((await s.worktree({ action: 'rollback', backlogItemKey: 'TASK-91' })).ok, true);
  assert.equal(fs.readFileSync(path.join(args.matchRoot, 'app.txt'), 'utf8'), 'baseline\n');
  fs.writeFileSync(path.join(out.matchRoot, 'app.txt'), 'fixed candidate\n');
  git(out.worktreeRoot, 'add', 'assigned'); git(out.worktreeRoot, 'commit', '-qm', 'repair');
  assert.equal((await s.worktree({ action: 'integrate', backlogItemKey: 'TASK-91' })).ok, true);
  assert.equal(fs.readFileSync(path.join(args.matchRoot, 'app.txt'), 'utf8'), 'fixed candidate\n');
  s.state.submissions['TASK-91'] = { state: 'UNCERTAIN' };
  assert.equal((await s.worktree({ action: 'rollback', backlogItemKey: 'TASK-91' })).error, 'INTEGRATION_ALREADY_SENT');
});

test('dispatch order is PI, nearest deadline, then points per minute, including late items', () => {
  const now = 1_000_000;
  const item = (id, type, maxPoints, extra = {}) => ({ id, type, maxPoints, ...extra });
  const items = [item('TASK-91', 'TASK', 80), item('CR-92', 'CR', 200), item('BUG-93', 'BUG', 20, { deadlineAt: now + 30 * 60000 }),
    item('TASK-94', 'TASK', 10, { deadlineAt: now + 60000 }), item('PI-95', 'PI', 10),
    item('CR-96', 'CR', 1000, { local: { startedAt: now, worktree: {} } })];
  assert.deepEqual(rank(items, now, now + 40 * 60000).ranked.map(r => r.id), ['PI-95', 'TASK-94', 'BUG-93', 'CR-92', 'TASK-91']);
  assert.match(alerts(items, now, now + 40 * 60000).join('\n'), /Dispatch a worker now/);
});
