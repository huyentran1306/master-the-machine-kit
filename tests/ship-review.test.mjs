import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { testSummary } from '../team-sdlc-pack/src/gate.mjs';
import { evidenceArrayRefs } from '../team-sdlc-pack/src/required-evidence.mjs';

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function shipFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-ship-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const remote = path.join(tmp, 'remote.git'); const root = path.join(tmp, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root]);
  git(root, 'config', 'user.name', 'F'); git(root, 'config', 'user.email', 'f@example.invalid'); git(root, 'checkout', '-q', '-b', 'main');
  const app = path.join(root, 'assigned', 'src'); fs.mkdirSync(path.join(app, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), '{}'); fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base'); git(root, 'push', '-q', '-u', 'origin', 'main');
  const modeFile = path.join(app, 'node_modules', 'mode');
  for (const [dir, file] of [['vitest', 'vitest.mjs'], ['typescript/bin', 'tsc']]) {
    const d = path.join(app, 'node_modules', dir); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), file === 'tsc' ? `console.log('ok')` : `import fs from 'node:fs'; const m=fs.readFileSync(${JSON.stringify(modeFile)},'utf8').trim();
if(m==='fail'){console.log(' FAIL x\\n      Tests  1 failed | 2 passed (3)');process.exit(1)}
if(m==='hang'){setInterval(()=>{},1000)} else console.log(' Test Files  1 passed (1)\\n      Tests  4 passed (4)');`);
  }
  const mode = (m) => fs.writeFileSync(modeFile, m);
  const s = new RuntimeSession({ teamWorkspace: root });
  s.checkoutRoot = root; s.matchRoot = path.join(root, 'assigned'); s.appPath = app; s.repository = { folder: 'assigned', branch: 'main' };
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 25 * 60000; s.freeMemory = () => 8 * 1024 ** 3;
  s.materialCache = {};
  const events = []; s.report_progress = async ({ event }) => { events.push(event); s.lastTests = { ...(s.lastTests || {}), [event.backlogId]: event }; return { ok: true }; };
  const mk = async (id, mins = 10) => {
    s.items.set(id, { id, type: 'BUG', deadlineAt: mins == null ? null : Date.now() + mins * 60000, local: { startedAt: Date.now() } });
    s.materialCache[id] = { files: {}, submitTemplate: { backlogId: id } };
    const c = await s.worktree({ action: 'create', backlogItemKey: id });
    assert.equal(c.ok, true, JSON.stringify(c));
    const wapp = path.join(c.matchRoot, 'src');
    fs.writeFileSync(path.join(wapp, `${id.toLowerCase()}.ts`), `export const a = '${id}';\n`);
    fs.mkdirSync(path.join(wapp, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(wapp, 'tests', `${id.toLowerCase()}.test.ts`), 'x');
    git(c.worktreeRoot, 'add', '-A'); git(c.worktreeRoot, 'commit', '-qm', `${id}: fix`);
    s.items.get(id).local.ready = true;
    return c;
  };
  return { s, root, remote, app, mode, mk, events };
}


test('ship after a submit refusal integrates the worker fix-up and submits the new commit', async (t) => {
  const { s, mode, mk } = shipFixture(t);
  const submits = [];
  s.submit_work = async (a) => { submits.push(a.gitRevision); return { ok: false, error: 'SUBMIT_REFUSED', errors: ['REQUIRED_EVIDENCE_MISSING'] }; };
  const c = await mk('BUG-71'); mode('green');
  const r1 = await s.ship({ backlogItemKey: 'BUG-71' });
  assert.equal(r1.stage, 'submit');
  fs.writeFileSync(path.join(c.matchRoot, 'fixed.txt'), 'evidence'); git(c.worktreeRoot, 'add', '-A'); git(c.worktreeRoot, 'commit', '-qm', 'fix-up');
  const r2 = await s.ship({ backlogItemKey: 'BUG-71' });
  const integ = r2.steps.find((x) => x.step === 'integrate');
  assert.ok(integ && integ.ok && !integ.replay, JSON.stringify(r2.steps));
  assert.notEqual(submits[0], submits[1]);
  // Unchanged worker HEAD: ship again is a replay of the same integration.
  const r3 = await s.ship({ backlogItemKey: 'BUG-71' });
  assert.equal(r3.steps.find((x) => x.step === 'integrate').replay, true);
  assert.equal(submits[2], submits[1]);
});

test('ship force:true after an ENVIRONMENT gate submits with allowUntested instead of being refused after the push', async (t) => {
  const { s, mode, mk } = shipFixture(t);
  let args;
  s.submit_work = async (a) => { args = a; const pf = await s.preflight(a.backlogItemKey, a.gitRevision, { allowUntested: a.allowUntested, reason: a.reason }); return { ok: !pf.errors.length, errors: pf.errors, warnings: pf.warnings }; };
  await mk('BUG-72', 1.4); mode('hang');
  const r = await s.ship({ backlogItemKey: 'BUG-72', force: true });
  assert.equal(args.allowUntested, true);
  assert.match(args.reason, /ENVIRONMENT/);
  assert.ok(!(r.errors || []).some((e) => /no test run reported/.test(e)), JSON.stringify(r.errors));
});

test('a CODE_FAILURE gate rolls the item back so the next ship never pushes failing code', async (t) => {
  const { s, mode, mk, remote, root } = shipFixture(t);
  s.submit_work = async (a) => { s.items.get(a.backlogItemKey).local.receiptId = 'r'; return { ok: true, outcome: 'SUBMITTED' }; };
  await mk('BUG-73', null);
  mode('fail');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const a = await s.ship({ backlogItemKey: 'BUG-73' });
  assert.equal(a.verdict, 'CODE_FAILURE');
  assert.equal(a.rolledBack, true, JSON.stringify(a));
  assert.equal(git(root, 'diff', '--name-only', headBefore, 'HEAD'), '', 'main content restored');
  await mk('BUG-74'); mode('green');
  const b = await s.ship({ backlogItemKey: 'BUG-74' });
  assert.equal(b.ok, true, JSON.stringify(b));
  const files = git(remote, 'ls-tree', '-r', '--name-only', 'main');
  assert.ok(files.includes('bug-74.ts') && !files.includes('bug-73.ts'), files);
});

test('jest test summaries are recognised', () => {
  const jest = 'PASS tests/x.test.ts\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total\nSnapshots:   0 total';
  assert.match(testSummary(jest), /Tests:\s+3 passed/);
});

test('validate-answer requires required evidence inside an "evidence" array, like the preflight', async (t) => {
  const { checkSubmit } = await import('../team-sdlc-pack/src/validate-answer.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-va-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ans = path.join(dir, 'answers', 'BUG-05'); fs.mkdirSync(path.join(ans, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ans, 'evidence', 'before.log'), 'x');
  const write = (body) => fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify(body));
  write({ backlogId: 'BUG-05', status: 'DONE', evidenceFiles: ['evidence/before.log'] });
  assert.ok(checkSubmit(path.join(ans, 'submit.json'), null, { required: ['before.log'] }).some((p) => /REQUIRED_EVIDENCE_UNREFERENCED/.test(p)));
  write({ backlogId: 'BUG-05', status: 'DONE', evidence: ['evidence/before.log'] });
  assert.ok(!checkSubmit(path.join(ans, 'submit.json'), null, { required: ['before.log'] }).some((p) => /REQUIRED_EVIDENCE/.test(p)));
  assert.equal(evidenceArrayRefs({ evidence: ['evidence/before.log'] }).has('evidence/before.log'), true);
});

test('a dispatched worktree with no change for 4 min is re-offered once per check; any change marks it active', async (t) => {
  const { s } = shipFixture(t);
  const add = async (id) => {
    s.items.set(id, { id, type: 'BUG', deadlineAt: null, local: { startedAt: Date.now() } });
    s.materialCache[id] = { files: {}, submitTemplate: { backlogId: id } };
    const c = await s.worktree({ action: 'create', backlogItemKey: id });
    assert.equal(c.ok, true, JSON.stringify(c));
    s.items.get(id).local.spawnEntry = { taskName: id.toLowerCase().replace('-', ''), message: `Item ${id}`, at: s.now(), respawns: 0, ...(await s.worktreeFingerprint(c.worktreeRoot)) };
    return c;
  };
  const idle = await add('BUG-81');
  const busy = await add('BUG-82');
  fs.writeFileSync(path.join(busy.matchRoot, 'answers-note.txt'), 'worker was here');
  assert.equal((await s.idleWorkers()).length, 0, 'nothing before 4 minutes');
  const real = s.now.bind(s); s.now = () => real() + 4.5 * 60000;
  assert.equal(s.hasDispatchAction(), true, 'idle candidates wake the loop');
  const r = await s.idleWorkers();
  assert.deepEqual(r.map(e => e.id), ['BUG-81']);
  assert.equal(r[0].previousTaskName, 'bug81');
  assert.equal(r[0].taskName, 'bug81w1');
  assert.match(r[0].message, /^NO-WORKER RESPAWN/);
  assert.equal(s.items.get('BUG-82').local.spawnEntry.active, true);
  assert.equal(await s.idleWorkers().then(x => x.length), 0, 'timer restarted after a re-offer');
  s.items.get('BUG-81').local.ready = true;
  s.now = () => real() + 10 * 60000;
  assert.equal(await s.idleWorkers().then(x => x.length), 0, 'READY items are never re-offered');
});

test('worker reasoning effort: low for answer-only, medium for code, high for a retry with time left', () => {
  const s = Object.create(RuntimeSession.prototype);
  s.adapter = { parallel: {} }; s.match = { endsAt: Date.now() + 30 * 60000 }; s.now = () => Date.now();
  const it = (over = {}) => ({ id: 'X-1', type: 'TASK', deadlineAt: null, local: { dispatches: 1 }, ...over });
  assert.equal(s.workerEffort(it(), { answerOnly: true }), 'low');
  assert.equal(s.workerEffort(it({ type: 'BUG' }), {}), 'medium');
  assert.equal(s.workerEffort(it({ deadlineAt: Date.now() + 3 * 60000 }), { answerOnly: true }), 'medium', 'no time for a second try');
  assert.equal(s.workerEffort(it({ local: { dispatches: 2 } }), {}), 'high');
  assert.equal(s.workerEffort(it({ local: { dispatches: 2 }, deadlineAt: Date.now() + 6 * 60000 }), {}), 'medium');
  s.adapter = { parallel: { workerEffort: { answerOnly: 'medium' } } };
  assert.equal(s.workerEffort(it(), { answerOnly: true }), 'medium', 'adapter override');
});

test('a node_modules symlink in the worker copy is not WORKER_DIRTY even when .gitignore says node_modules/', async (t) => {
  const { s, root, mode, mk } = shipFixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'dir-only ignore'); git(root, 'push', '-q', 'origin', 'main');
  s.submit_work = async (a) => { s.items.get(a.backlogItemKey).local.receiptId = 'r'; return { ok: true, outcome: 'SUBMITTED' }; };
  const c = await mk('BUG-75', null); mode('green');
  const link = path.join(c.matchRoot, 'src', 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, 'assigned', 'src', 'node_modules'), link);
  const r = await s.ship({ backlogItemKey: 'BUG-75' });
  assert.notEqual(r.error, 'WORKER_DIRTY', JSON.stringify(r));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('wait_for_update auto-dispatch re-offers a missed spawn once without caching the re-offer', async (t) => {
  const { s } = shipFixture(t);
  s.start_work = async ({ backlogItemKey }) => { const it = s.items.get(backlogItemKey); it.local.startedAt = Date.now(); return { ok: true }; };
  s.doRefresh = async () => ({ ok: true, events: [] });
  s.items.set('TASK-41', { id: 'TASK-41', type: 'TASK', revealedAt: Date.now(), local: {} });
  s.materialCache['TASK-41'] = { files: {}, submitTemplate: { backlogId: 'TASK-41' } };
  const w = await s.wait_for_update({ timeoutMs: 1000 });
  assert.equal(w.spawn?.[0]?.id, 'TASK-41', JSON.stringify(w).slice(0, 400));
  assert.match(w.next, /^SPAWN NOW/);
  s.pendingEvents.push({ kind: 'BACKLOG_UPDATED', id: 'TASK-41' });
  const again = await s.wait_for_update({ timeoutMs: 1000 });
  assert.equal(again.alreadyReturned, true);
  assert.equal(again.spawn[0].id, 'TASK-41');
  assert.match(again.next, /^REOFFER ONLY/);
  assert.equal(s.recentSpawn, null, 'the cautious re-offer is not cached again');
  s.pendingEvents.push({ kind: 'BACKLOG_UPDATED', id: 'TASK-41' });
  const third = await s.wait_for_update({ timeoutMs: 1000 });
  assert.equal(third.spawn?.length || 0, 0, 'offered once only');
});
