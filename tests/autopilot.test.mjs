// v6: the kit ships committed work by itself (ready handshake, deadline/match-end/stale sweeps) and keeps threads for
// urgent items after a flood of ordinary ones. Evidence: TMNXWBA9 (532/1000) lost CR-08 110, PI-04 90, CR-07 70,
// TASK-07 45 and CR-05 45 points with most of that work committed when the orchestrator ran out of Codex usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeSession, legacyMergeTreeConflicts, emptyAnswerFields } from '../team-sdlc-pack/src/runtime-session.mjs';
import { exhaustiveLogSearch } from '../team-sdlc-pack/src/mcp-material.mjs';
import { dispatchPolicy, workerDirtyFiles } from '../team-sdlc-pack/src/dispatch.mjs';
import { sendQuery, readyText } from '../team-sdlc-pack/src/ready-ping.mjs';

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const gb = 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } throw new Error('timed out'); };
const TEST_LOG = ' ✓ src/x.test.ts (4 tests)\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n';

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-auto-'));
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
    fs.writeFileSync(path.join(d, file), file === 'tsc' ? `const fs = require('fs'); const f = ${JSON.stringify(path.join(app, 'node_modules', 'types-mode'))};
const m = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : 'ok';
if (m.startsWith('fail:')) { console.log(m.slice(5) + "(1,7): error TS2322: Type 'string' is not assignable to type 'number'."); process.exit(2); }
console.log('ok');` : `import fs from 'node:fs'; const m=fs.readFileSync(${JSON.stringify(modeFile)},'utf8').trim();
if(m==='fail'){console.log(' FAIL x\\n      Tests  1 failed | 2 passed (3)');process.exit(1)}
console.log(' Test Files  1 passed (1)\\n      Tests  4 passed (4)');`);
  }
  const mode = (m) => fs.writeFileSync(modeFile, m);
  const typesMode = (m) => fs.writeFileSync(path.join(app, 'node_modules', 'types-mode'), m);
  const ws = path.join(tmp, 'team-workspace'); fs.mkdirSync(ws, { recursive: true }); // the query queue lives outside the match checkout
  const s = new RuntimeSession({ teamWorkspace: ws });
  s.checkoutRoot = root; s.matchRoot = path.join(root, 'assigned'); s.appPath = app; s.repository = { folder: 'assigned', branch: 'main' };
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 25 * 60000; s.freeMemory = () => 8 * gb;
  s.readUsage = () => null; s.materialCache = {};
  s.report_progress = async ({ event }) => { s.lastTests = { ...(s.lastTests || {}), [event.backlogId]: event }; return { ok: true }; };
  const submits = [];
  s.submit_work = async (a) => { submits.push(a); s.items.get(a.backlogItemKey).local.receiptId = `r${submits.length}`; return { ok: true, outcome: 'SUBMITTED', receipt: { receiptId: `r${submits.length}` }, gitRevision: a.gitRevision }; };
  t.after(async () => { await s.shipChain?.catch(() => {}); await sleep(50); fs.rmSync(tmp, { recursive: true, force: true }); });
  const answer = (c, id) => {
    const ans = path.join(c.matchRoot, 'answers', id); fs.mkdirSync(path.join(ans, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(ans, 'evidence', 'test.log'), TEST_LOG);
    fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify({ backlogId: id, status: 'DONE', evidenceFiles: ['evidence/test.log'] }));
  };
  const mk = async (id, { type = 'BUG', mins = 10, evidence = true, commit = true } = {}) => {
    s.items.set(id, { id, type, maxPoints: 70, deadlineAt: mins == null ? null : Date.now() + mins * 60000, local: { startedAt: Date.now() } });
    s.materialCache[id] = { files: {}, submitTemplate: { backlogId: id } };
    const c = await s.worktree({ action: 'create', backlogItemKey: id });
    assert.equal(c.ok, true, JSON.stringify(c));
    fs.writeFileSync(path.join(c.matchRoot, 'src', `${id.toLowerCase()}.ts`), `export const a = '${id}';\n`);
    fs.mkdirSync(path.join(c.matchRoot, 'src', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(c.matchRoot, 'src', 'tests', `${id.toLowerCase()}.test.ts`), 'x');
    if (evidence) answer(c, id);
    if (commit) { git(c.worktreeRoot, 'add', '-A'); git(c.worktreeRoot, 'commit', '-qm', `${id}: fix`); }
    return c;
  };
  const ready = async (c, id, extra = {}) => {
    const auth = JSON.parse(fs.readFileSync(path.join(path.dirname(c.brief.briefFile), 'query-token.json'), 'utf8'));
    const p = sendQuery(auth, { item: id, kind: 'ready', ...extra }, { timeoutMs: 30000, pollMs: 20 });
    for (let i = 0; i < 400; i += 1) { await s.drainQueryQueue({ only: 'ready' }); const done = await Promise.race([p, sleep(40).then(() => null)]); if (done) return done; }
    return p;
  };
  return { s, root, mode, typesMode, mk, answer, submits, ready };
}

test('kit-owned files never make a worker copy dirty (TMNXWBA9 TASK-07, CR-08)', () => {
  assert.deepEqual(workerDirtyFiles([
    '?? TMNXWBA9/answers/TASK-07/checklist.md', '?? TMNXWBA9/.mtm-notes/build.log', '?? node_modules', '?? app/node_modules/x/y.js',
    ' M TMNXWBA9/src/a.ts', '?? TMNXWBA9/answers/TASK-07/evidence/new.png',
  ]), [' M TMNXWBA9/src/a.ts', '?? TMNXWBA9/answers/TASK-07/evidence/new.png']);
});

test('flood guard: ordinary work leaves urgent threads free, deadline code items get extra code slots, usage trims ordinary work', () => {
  const p = { maxWorkerThreads: 12, urgentThreadReserve: 4, maxCodeWorkers: 6, urgentCodeExtra: 2, maxAnswerWorkers: 20 };
  const live = (n, answer = false) => Array.from({ length: n }, (_, i) => ({ id: `TASK-${i + 1}`, type: 'TASK', local: { worktree: {}, startedAt: 1, answerOnly: answer } }));
  const task = { id: 'TASK-99', type: 'TASK', local: { answerOnly: true } };
  const pi = { id: 'PI-99', type: 'PI', local: {} };
  const cr = { id: 'CR-99', type: 'CR', deadlineAt: Date.now() + 600000, local: { answerOnly: false } };
  const bug = { id: 'BUG-98', type: 'BUG', local: { answerOnly: false } };
  assert.equal(dispatchPolicy(task, live(8, true), p, 10 * gb).reason, 'THREAD_LIMIT', '12 threads - 4 reserved');
  assert.equal(dispatchPolicy(task, live(7, true), p, 10 * gb).allowed, true);
  assert.equal(dispatchPolicy(pi, live(11, true), p, 10 * gb).allowed, true, 'PI uses a reserved thread');
  assert.equal(dispatchPolicy(cr, live(6), p, 10 * gb).allowed, true, 'deadline code item past the ordinary code cap');
  assert.equal(dispatchPolicy(cr, live(8), p, 10 * gb).reason, 'CODE_WORKER_LIMIT', 'but not past cap + urgentCodeExtra');
  assert.equal(dispatchPolicy(bug, live(6), p, 10 * gb).reason, 'CODE_WORKER_LIMIT', 'ordinary code keeps the ordinary cap');
  assert.equal(dispatchPolicy(task, live(5, true), { ...p, usageTier: 1 }, 10 * gb).reason, 'THREAD_LIMIT', 'tight usage: 5 ordinary workers');
  assert.equal(dispatchPolicy(task, live(3, true), { ...p, usageTier: 2 }, 10 * gb).reason, 'THREAD_LIMIT', 'critical usage: 3');
  assert.equal(dispatchPolicy(pi, live(9, true), { ...p, usageTier: 2 }, 10 * gb).allowed, true, 'urgent work is never usage-capped');
});

test('a PI revealed after a flood takes a thread from the lowest-value ordinary worker', async () => {
  const s = new RuntimeSession(); const now = Date.now(); s.now = () => now; s.match.endsAt = now + 30 * 60000; s.phase = 'GAME';
  s.readUsage = () => null; s.freeMemory = () => 8 * gb;
  s.adapter.parallel = { ...s.adapter.parallel, maxWorkerThreads: 4, urgentThreadReserve: 0 };
  for (const [id, pts] of [['TASK-1', 110], ['TASK-2', 30], ['BUG-3', 70], ['CR-4', 90]]) {
    s.items.set(id, { id, type: id.split('-')[0], maxPoints: pts, local: { worktree: { worktreeRoot: path.join(os.tmpdir(), `v6-none-${id}`) }, startedAt: now - 60000, dispatchedAt: now - 60000 } });
  }
  s.items.set('PI-5', { id: 'PI-5', type: 'PI', deadlineAt: now + 10 * 60000, local: {} });
  const p = await s.preemptForDeadline(s.items.get('PI-5'));
  assert.equal(p?.id, 'TASK-2', JSON.stringify(p));
  assert.equal(s.items.get('TASK-2').local.preemptRequested, true);
  assert.equal(await s.preemptForDeadline(s.items.get('PI-5')), null, 'one victim is enough');
});

test('ready handshake over the file queue: NOT_READY lists what the worker can fix, READY ships at once', async (t) => {
  const { s, mk, mode, answer, submits } = fixture(t);
  mode('green');
  const c = await mk('BUG-81', { evidence: false });
  assert.doesNotMatch(git(c.worktreeRoot, 'status', '--porcelain', '--untracked-files=all'), /checklist\.md/, 'the kit checklist is git-excluded');
  const auth = JSON.parse(fs.readFileSync(path.join(path.dirname(c.brief.briefFile), 'query-token.json'), 'utf8'));
  const ask = async () => {
    const p = sendQuery(auth, { item: 'BUG-81', kind: 'ready' }, { timeoutMs: 20000, pollMs: 20 });
    for (let i = 0; i < 200; i += 1) { await s.drainQueryQueue(); const done = await Promise.race([p, sleep(40).then(() => null)]); if (done) return done; }
    return p;
  };
  const first = await ask();
  assert.equal(first.error, 'NOT_READY', JSON.stringify(first));
  assert.ok(first.errors.some(e => /needs MVS evidence/.test(e)), first.errors.join('\n'));
  assert.ok(first.errors.some(e => /no evidence file holds the output of a test run/.test(e)), first.errors.join('\n'));
  assert.ok(!first.errors.some(e => /not on origin|no test run reported/.test(e)), 'only worker-fixable errors');
  assert.match(readyText(first), /^NOT READY/);
  assert.equal(submits.length, 0);
  answer(c, 'BUG-81'); git(c.worktreeRoot, 'add', '-A'); git(c.worktreeRoot, 'commit', '-qm', 'BUG-81: evidence');
  const second = await ask();
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(second.shipping, true);
  assert.match(readyText(second), /READY CHECK PASSED: the kit is shipping/);
  await waitFor(() => submits.length === 1).catch(() => { throw new Error(JSON.stringify(s.pendingEvents.filter(e => e.id === 'BUG-81'))); });
  assert.equal(s.items.get('BUG-81').local.autoShip.reason, 'ready');
  assert.ok(s.pendingEvents.some(e => e.kind === 'AUTO_SHIP' && e.id === 'BUG-81'));
});

test('deadline sweep ships the latest commit at the cutoff while the worker is still editing', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('green'); s.bearer = 'test';
  const c = await mk('CR-82', { type: 'CR', mins: 1.2 });
  fs.appendFileSync(path.join(c.matchRoot, 'src', 'cr-82.ts'), '// still editing\n');
  const due = await s.autopilotSweep();
  assert.deepEqual(due.map(d => [d.id, d.reason]), [['CR-82', 'deadline']]);
  await waitFor(() => submits.length === 1);
  assert.equal(submits[0].allowUntested, true, 'gate skipped under 90 s');
  assert.match(s.pendingEvents.find(e => e.kind === 'AUTO_SHIP' && e.id === 'CR-82').text, /tell it to stop/);
  assert.deepEqual(await s.autopilotSweep(), [], 'submitted: nothing more to ship');
});

test('deadline sweep waits for a short item worker\'s own stop time', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('green'); s.bearer = 'test';
  await mk('TASK-89', { type: 'TASK', mins: 1.6 });
  const it = s.items.get('TASK-89');
  it.local.workerStopAt = it.deadlineAt - 1.5 * 60000; // a 6-minute item: its worker may work until 1.5 min before the deadline
  assert.deepEqual(await s.autopilotSweep(), [], '1.6 min left: the worker is still inside its time box');
  it.deadlineAt = Date.now() + 1.2 * 60000;
  it.local.workerStopAt = it.deadlineAt - 1.5 * 60000;
  assert.deepEqual((await s.autopilotSweep()).map(d => d.reason), ['deadline'], 'past the stop time: ship the latest commit');
  await waitFor(() => submits.length === 1);
});

test('sweep skips uncommitted work, a commit that failed the gate and a worker still editing after an orchestrator silence', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('green'); s.bearer = 'test';
  await mk('BUG-83', { mins: 1, commit: false });
  const c84 = await mk('BUG-84', { mins: 1 });
  s.items.get('BUG-84').local.failedShip = { workerSha: git(c84.worktreeRoot, 'rev-parse', 'HEAD'), verdict: 'CODE_FAILURE' };
  const c85 = await mk('BUG-85', { mins: null });
  s.lastToolCallAt = Date.now() - 5 * 60000;
  fs.writeFileSync(path.join(c85.matchRoot, 'src', 'wip.ts'), 'x');
  assert.deepEqual(await s.autopilotSweep(), []);
  fs.rmSync(path.join(c85.matchRoot, 'src', 'wip.ts'));
  assert.deepEqual(await s.autopilotSweep(), [], 'a fresh commit is not idle yet');
  s.adapter.autopilot = { idleCommitSec: 0 };
  assert.deepEqual((await s.autopilotSweep()).map(d => [d.id, d.reason]), [['BUG-85', 'stale']]);
  await waitFor(() => submits.length === 1);
});

test('match-end sweep ships every committed item in the last minutes', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('green'); s.bearer = 'test';
  await mk('TASK-86', { type: 'TASK', mins: null });
  s.match.endsAt = Date.now() + 2.5 * 60000;
  assert.deepEqual((await s.autopilotSweep()).map(d => d.reason), ['match-end']);
  await waitFor(() => submits.length === 1);
});

test('an autopilot ship never re-gates a commit that already failed the gate', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('fail');
  await mk('BUG-87', { mins: 20 });
  const r1 = await s.ship({ backlogItemKey: 'BUG-87', waitMs: 600000 });
  assert.equal(r1.verdict, 'CODE_FAILURE', JSON.stringify(r1).slice(0, 400));
  const r2 = await s.ship({ backlogItemKey: 'BUG-87', waitMs: 600000, autopilot: 'deadline' });
  assert.equal(r2.error, 'SAME_COMMIT_FAILED', JSON.stringify(r2).slice(0, 400));
  assert.equal(submits.length, 0);
});

test('a deadline about to pass interrupts a PI gate; a later deadline waits for it', async () => {
  const s = new RuntimeSession(); const now = Date.now(); s.now = () => now; s.match.endsAt = now + 30 * 60000;
  s.items.set('PI-5', { id: 'PI-5', type: 'PI', local: {} });
  s.items.set('CR-9', { id: 'CR-9', type: 'CR', deadlineAt: now + 2 * 60000, local: {} });
  s.items.set('CR-10', { id: 'CR-10', type: 'CR', deadlineAt: now + 4 * 60000, local: {} });
  let aborted = 0;
  s.activeGate = { id: 'PI-5', controller: { abort: () => { aborted += 1; } } };
  s.withAutoDispatch = async r => r; s.shipOne = async () => ({ ok: true, stage: 'submitted' });
  await s.ship({ backlogItemKey: 'CR-10', waitMs: 1000 });
  assert.equal(aborted, 0, 'a deadline 4 min out waits for the PI gate');
  await s.ship({ backlogItemKey: 'CR-9', waitMs: 1000 });
  assert.equal(aborted, 1, 'a deadline 2 min out interrupts it');
});

test('relay budget: with live workers the orchestrator gets 5 match_mcp reads per 2 minutes', () => {
  const s = new RuntimeSession(); s.phase = 'GAME';
  s.items.set('PI-1', { id: 'PI-1', type: 'PI', local: { worktree: {}, queryToken: 't' } });
  for (let i = 0; i < 5; i += 1) assert.equal(s.relayBudget('PI-1'), null);
  const r = s.relayBudget('PI-1');
  assert.equal(r.error, 'RELAY_BUDGET'); assert.match(r.next, /mtm-query/);
  s.items.get('PI-1').local.receiptId = 'r';
  assert.equal(s.relayBudget('PI-1'), null, 'no live worker: no budget');
});

test('ready requests have their own drain: a hung MCP read never delays a READY check', async (t) => {
  const { s, mk, mode, submits } = fixture(t);
  mode('green');
  const c = await mk('BUG-88');
  const auth = JSON.parse(fs.readFileSync(path.join(path.dirname(c.brief.briefFile), 'query-token.json'), 'utf8'));
  let release = null; s.materialTools = () => new Promise((r) => { release = () => r([]); });
  const read = sendQuery(auth, { item: 'BUG-88', tool: 'search_logs', args: {} }, { timeoutMs: 20000, pollMs: 20 });
  const ticker = setInterval(() => { s.processQueryQueue().catch(() => {}); }, 25);
  try {
    await waitFor(() => release);
    const r = await sendQuery(auth, { item: 'BUG-88', kind: 'ready' }, { timeoutMs: 20000, pollMs: 20 });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.shipping, true);
    release();
    assert.equal((await read).error, 'TOOL_NOT_READ_ONLY');
    await waitFor(() => submits.length === 1);
  } finally { clearInterval(ticker); }
});

// A log server like the match MCP: every query word must appear in the entry, newest 20 first, with the total.
function logServer(entries, { tokens = false } = {}) {
  const tok = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const text = entries.map(e => JSON.stringify(e).toLowerCase());
  const toks = entries.map(e => new Set(tok(JSON.stringify(e))));
  let calls = 0;
  const call = async ({ query = '', service = null }) => {
    calls += 1;
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hit = entries.map((e, i) => i).filter(i => (!service || entries[i].service === service)
      && words.every(w => tokens ? tok(w).every(t => toks[i].has(t)) : text[i].includes(w)));
    hit.sort((a, b) => entries[b].ts.localeCompare(entries[a].ts));
    const page = hit.slice(0, 20).map(i => entries[i]);
    return { ok: true, raw: { content: [{ type: 'text', text: JSON.stringify({ total: hit.length, returned: page.length, entries: page }) }] } };
  };
  return { call, calls: () => calls };
}
const LOG_TOOL = { name: 'search_logs', inputSchema: { properties: { query: { type: 'string' }, service: { type: 'string' } } } };
function scheduleLogs() {
  const out = []; let seq = 0;
  for (let day = 1; day <= 30; day += 1) {
    for (let k = 0; k < 9; k += 1) {
      seq += 1;
      const d = `2025-11-${String(day).padStart(2, '0')}`;
      out.push({ ts: `${d}T${String(6 + k).padStart(2, '0')}:13:00.000Z`, service: 'schedules', level: k % 4 ? 'INFO' : 'WARN', requestId: `req-${seq.toString(36)}x`,
        message: k % 3 ? 'schedule.posted' : 'schedule.post_failed', context: { release: day < 12 ? '2025.11.3' : '2025.11.4', scheduleId: `SCH-${1001 + (seq % 6)}`, dueDate: d, postedMinor: -1000 * seq } });
    }
  }
  for (let i = 0; i < 60; i += 1) out.push({ ts: `2025-12-${String(1 + (i % 20)).padStart(2, '0')}T21:00:${String(i % 60).padStart(2, '0')}.000Z`, service: 'schedules', level: 'INFO', requestId: `dec-${i}z`, message: 'schedule.posted', context: { release: '2025.12.5', scheduleId: `SCH-${1001 + (i % 6)}`, dueDate: '2025-11-30', postedMinor: -5 } });
  return out;
}

test('--all collects every matching log entry by splitting on words from the entries (substring server)', async () => {
  const srv = logServer(scheduleLogs());
  const r = await exhaustiveLogSearch(LOG_TOOL, srv.call, { service: 'schedules', query: '2025.11.4 schedule.posted', callCap: 80, budgetMs: 20000 });
  const want = scheduleLogs().filter(e => e.context.release === '2025.11.4' && e.message === 'schedule.posted').length;
  assert.equal(r.total, want);
  assert.equal(r.complete, true, JSON.stringify({ fetched: r.fetched, total: r.total, calls: r.calls, reason: r.reason }));
  assert.equal(r.fetched, want);
  assert.ok(r.entries[0].ts < r.entries.at(-1).ts, 'oldest first');
});

test('--all also works on a whole-word server, and reports what it could not reach', async () => {
  // Whole-word matching splits "2025-11-13" into 2025/11/13, and every entry here has those words somewhere, so some
  // days cannot narrow at all; the value splits still reach almost everything within the call cap.
  const srv = logServer(scheduleLogs(), { tokens: true });
  const r = await exhaustiveLogSearch(LOG_TOOL, srv.call, { service: 'schedules', query: 'schedule.post_failed', callCap: 120, budgetMs: 20000 });
  assert.equal(r.total, scheduleLogs().filter(e => e.message === 'schedule.post_failed').length);
  assert.ok(r.fetched >= r.total * 0.95, JSON.stringify({ fetched: r.fetched, total: r.total, calls: r.calls, reason: r.reason }));
  assert.equal(r.complete, r.fetched >= r.total);
  const capped = await exhaustiveLogSearch(LOG_TOOL, logServer(scheduleLogs(), { tokens: true }).call, { service: 'schedules', query: '', callCap: 3, budgetMs: 20000 });
  assert.equal(capped.complete, false); assert.equal(capped.reason, 'CALL_CAP'); assert.ok(capped.fetched > 20);
});

test('legacy merge-tree output: only sections with conflict markers count', () => {
  const out = ['changed in both', '  base   100644 de98 f.txt', '  our    100644 0978 f.txt', '  their  100644 42ef f.txt', '@@ -1,3 +1,7 @@', ' a', '+<<<<<<< .our', ' B-main', '+=======', '+B-worker', '+>>>>>>> .their', ' c',
    'merged', '  result 100644 b77b g.txt', '  our    100644 587b g.txt', '@@ -1 +1,2 @@', ' x', '+y'].join('\n');
  assert.deepEqual(legacyMergeTreeConflicts(out), ['f.txt']);
});

test('ready handshake: a conflict with main and a type error in the item are sent back to the worker', async (t) => {
  const { s, mk, mode, typesMode, submits, ready, root } = fixture(t);
  mode('green'); typesMode('ok');
  const a = await mk('BUG-90');
  const b = await mk('BUG-91', { commit: false });
  for (const c of [a, b]) fs.writeFileSync(path.join(c.matchRoot, 'src', 'a.ts'), `export const a = '${c === a ? 'A' : 'B'}';\n`);
  git(a.worktreeRoot, 'add', '-A'); git(a.worktreeRoot, 'commit', '-qm', 'BUG-90: shared file');
  git(b.worktreeRoot, 'add', '-A'); git(b.worktreeRoot, 'commit', '-qm', 'BUG-91: shared file');
  const ra = await ready(a, 'BUG-90');
  assert.equal(ra.ok, true, JSON.stringify(ra));
  await waitFor(() => submits.length === 1);
  const rb = await ready(b, 'BUG-91');
  assert.equal(rb.error, 'NOT_READY', JSON.stringify(rb));
  assert.ok(rb.errors.some(e => /^CONFLICT_WITH_MAIN: .*a\.ts/.test(e)), rb.errors.join('\n'));
  assert.equal(submits.length, 1);
  const c = await mk('BUG-92');
  typesMode('fail:src/bug-92.ts');
  const rc = await ready(c, 'BUG-92');
  assert.equal(rc.error, 'NOT_READY', JSON.stringify(rc));
  assert.ok(rc.errors.some(e => /^TYPECHECK: src\/bug-92\.ts\(1,7\): error TS2322/.test(e)), rc.errors.join('\n'));
  typesMode('fail:src/elsewhere.ts');
  const rd = await ready(c, 'BUG-92');
  assert.equal(rd.ok, true, 'an error in a file the item did not touch is not the worker\'s');
  await waitFor(() => submits.length === 2).catch(() => {});
  assert.ok(fs.existsSync(path.join(root, '.mtm-notes', 'ready-BUG-92-types.log')));
});

test('PI handshake asks once for empty answer fields, then lets the same commit through', async (t) => {
  const { s, mk, mode, submits, ready } = fixture(t);
  mode('green');
  const c = await mk('PI-93', { type: 'PI', mins: 20, evidence: false, commit: false });
  const ans = path.join(c.matchRoot, 'answers', 'PI-93');
  fs.mkdirSync(path.join(ans, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ans, 'evidence', 'test.log'), TEST_LOG);
  fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify({ backlogId: 'PI-93', status: 'DONE', evidenceFiles: ['evidence/test.log'], firstWrongPostingTs: '', affectedSchedules: [], incidentRecord: { rootCause: 'x', impact: '' } }));
  git(c.worktreeRoot, 'add', '-A'); git(c.worktreeRoot, 'commit', '-qm', 'PI-93: answer');
  s.items.get('PI-93').local.workerStopAt = Date.now() + 10 * 60000;
  const first = await ready(c, 'PI-93');
  assert.equal(first.error, 'NOT_READY', JSON.stringify(first));
  assert.ok(first.errors.some(e => /ANSWER_FIELDS_EMPTY: firstWrongPostingTs, affectedSchedules, incidentRecord\.impact/.test(e)), first.errors.join('\n'));
  const again = await ready(c, 'PI-93');
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.ok(again.warnings.some(w => /ANSWER_FIELDS_EMPTY/.test(w)));
  await waitFor(() => submits.length === 1);
  assert.deepEqual(emptyAnswerFields({ backlogId: 'X', status: '', evidenceFiles: [], a: 0, b: { c: null, d: 'ok' } }), ['b.c']);
});
