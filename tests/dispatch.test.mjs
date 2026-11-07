import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOnly, answerClassification, dispatchPolicy, integrationGate, BuildQueue, mapBounded } from '../team-sdlc-pack/src/dispatch.mjs';
import { buildChecklist } from '../team-sdlc-pack/src/checklist.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { detectHeavy } from '../team-sdlc-pack/src/planner.mjs';

test('only an explicit heavy label defers; inferred size is logged as a hint', () => {
  const peers = [{ type: 'CR', maxPoints: 100 }, { type: 'BUG', maxPoints: 140 }];
  assert.deepEqual(detectHeavy({ type: 'CR', title: '[Heavy Task] migrate reports', local: {} }, peers), { heavy: true, reason: 'title prefix' });
  assert.equal(detectHeavy({ type: 'CR', title: 'Normal export', maxPoints: 140, description: 'Add one export.', local: {} }, peers).heavy, false);
  const inferred = detectHeavy({ type: 'CR', title: 'Platform update', maxPoints: 300, description: 'large migration '.repeat(700), local: {} }, peers);
  assert.equal(inferred.heavy, false); assert.match(inferred.hint, /high points.*long description/);
  assert.equal(detectHeavy({ type: 'PI', title: '[Heavy Task] incident', maxPoints: 500, local: {} }, peers).heavy, false);
  assert.equal(detectHeavy({ type: 'TASK', title: '[Heavy Task] analyse logs', local: { answerOnly: true } }, peers).heavy, true,
    'an explicit organizer label overrides the answer-only fast-path exclusion');
  assert.equal(detectHeavy({ type: 'CR', title: '[Heavy Task] x', local: {} }, peers, { mode: 'normal' }).heavy, false);
  const s = new RuntimeSession();
  s.items.set('CR-HINT', { id: 'CR-HINT', type: 'CR', title: 'Large item', maxPoints: 300, description: 'large migration '.repeat(700), local: {} });
  s.items.set('BUG-PEER', { id: 'BUG-PEER', type: 'BUG', maxPoints: 100, local: {} });
  s.refreshHeavyFlags();
  assert.equal(s.items.get('CR-HINT').local.heavy, false);
  assert.match(s.pendingEvents.find(e => e.kind === 'HEAVY_HINT')?.text || '', /not deferred without an explicit label/);
});

test('structural verification selects code while wording only hints at the starting lane', () => {
  assert.equal(answerOnly({ type: 'PI' }), true);
  assert.equal(answerOnly({ type: 'PI', description: 'Then fix the fault in the application source.' }), true);
  assert.equal(answerOnly({ type: 'PI' }, { minimumVerificationScenarios: [{ id: 'PI-TC-01' }] }), false);
  for (const description of ['Question: calculate the total.', 'Return answer values; no code changes required.', 'Report-only: identify the total.', 'Update the component documentation table in the answer.']) {
    assert.equal(answerOnly({ type: 'TASK', description }), true, description);
  }
  for (const item of [{ type: 'BUG', description: 'Answer why this fails.' }, { type: 'TASK', description: 'Fix the calculation.' }, { type: 'TASK' }]) assert.equal(answerOnly(item), false);
  assert.equal(answerOnly({ type: 'TASK', title: 'Question' }, { minimumVerificationScenarios: [{ id: 'case-a', command: 'node verify.mjs' }] }), false);
  assert.equal(answerOnly({ type: 'TASK', title: 'Question' }, { minimumVerificationScenarios: 'No tests to run' }), true);
  assert.deepEqual(answerClassification({ type: 'TASK', title: 'Question' }, { minimumVerificationScenarios: [{ id: 'case-a' }] }), { answerOnly: false, classifiedBy: 'structure', reason: 'minimumVerificationScenarios' });
  assert.equal(answerClassification({ type: 'TASK', title: 'Question' }, { submitTemplate: { testResults: [] } }).classifiedBy, 'structure');
  assert.equal(answerClassification({ type: 'TASK', title: 'Question' }, { requiredEvidence: [{ name: 'run.log', strict: true }] }).classifiedBy, 'structure');
  assert.equal(answerClassification({ type: 'TASK', title: 'Question' }, { files: { 'qa/check.mjs': 'import assert from "node:assert"; assert(1);' } }).classifiedBy, 'structure');
  assert.equal(answerClassification({ type: 'TASK', title: 'Question' }).classifiedBy, 'hint');
  const checklist = buildChecklist({ id: 'TASK-91', type: 'TASK', answerOnly: true, commands: { test: 'npm test', typecheck: 'tsc' } });
  assert.match(checklist.text, /shipped schema/);
  assert.doesNotMatch(checklist.text, /run npm test|Run tsc|test\.log/);
});

test('dispatch gates code on current RAM and active code count; answer workers only on the machine floor', () => {
  const running = Array.from({ length: 6 }, (_, n) => ({ id: `BUG-${n}`, type: 'BUG', local: { worktree: {} } }));
  const code = { id: 'CR-91', type: 'CR' };
  const gb = 1024 ** 3;
  assert.equal(dispatchPolicy(code, running, {}, 10 * gb).reason, 'CODE_WORKER_LIMIT');
  running[0].local.ready = true;
  assert.equal(dispatchPolicy(code, running, {}, 2.5 * gb).allowed, true);
  assert.equal(dispatchPolicy(code, running, {}, 2.5 * gb - 1).reason, 'LOW_RAM');
  running[1].local.parked = { remainingStep: 'verify' };
  running[2].local.ready = true;
  assert.equal(dispatchPolicy(code, running, { maxCodeWorkers: 4 }, 3 * gb).codeWorkers, 3);
  assert.equal(dispatchPolicy({ id: 'PI-91', type: 'PI' }, running, { maxCodeWorkers: 1 }, 0).allowed, true);
  assert.equal(dispatchPolicy({ id: 'TASK-91', type: 'TASK', title: 'Question: answer values' }, running, { maxCodeWorkers: 1 }, 1.1 * gb).allowed, true, 'answer workers only need the 1 GB machine floor');
});

test('answer workers are capped, PI bypasses caps, and urgent/resume code uses 1.5 GB floor', () => {
  const answers = Array.from({ length: 6 }, (_, i) => ({ id: `TASK-${i}`, type: 'TASK', local: { answerOnly: true, worktree: {} } }));
  const q = { id: 'TASK-Q', type: 'TASK', local: { answerOnly: true } };
  assert.equal(dispatchPolicy(q, answers, { maxAnswerWorkers: 6 }, 10 * 1024 ** 3).reason, 'ANSWER_WORKER_LIMIT');
  assert.equal(dispatchPolicy({ id: 'PI-Q', type: 'PI', local: { answerOnly: true } }, answers, { maxAnswerWorkers: 1 }, 0).allowed, true);
  const urgent = { id: 'BUG-U', type: 'BUG', deadlineAt: Date.now() + 60000, local: {} };
  assert.equal(dispatchPolicy(urgent, [], {}, 1.6 * 1024 ** 3).allowed, true);
  assert.equal(dispatchPolicy({ id: 'BUG-N', type: 'BUG', local: {} }, [], {}, 1.6 * 1024 ** 3).reason, 'LOW_RAM');
});

test('view keepAlive caps agent waits at 20 seconds', () => {
  const s = new RuntimeSession(); s.phase = 'GAME'; s.match.status = 'IN_PROGRESS';
  assert.match(s.view().keepAlive, /wait_agent <=20s/);
});

test('shared build leases enforce configured concurrency, FIFO, idempotence and cancellation', () => {
  const queue = new BuildQueue();
  assert.equal(queue.update('acquire', 'BUG-91').granted, true);
  assert.equal(queue.update('acquire', 'BUG-92').granted, true);
  assert.equal(queue.update('acquire', 'BUG-93').granted, false);
  assert.equal(queue.update('acquire', 'BUG-94').granted, false);
  assert.deepEqual(queue.update('acquire', 'BUG-93').queue, ['BUG-93', 'BUG-94']);
  assert.deepEqual(queue.update('release', 'BUG-91').active, ['BUG-92', 'BUG-93']);
  queue.update('release', 'BUG-94');
  assert.deepEqual(queue.update('release', 'BUG-92').queue, []);
  const single = new BuildQueue(1);
  single.update('acquire', 'CR-91');
  assert.equal(single.update('acquire', 'CR-92').granted, false);
  assert.equal(single.update('acquire', 'CR-91').active.length, 1);
});

test('integration gates select schema only, deadline item tests, or ordinary regression checks', () => {
  assert.equal(integrationGate({ type: 'PI', deadlineAt: 123 }, { codeChanged: false }), 'schema only');
  assert.equal(integrationGate({ type: 'PI', deadlineAt: 123 }, { codeChanged: true }), "item's own tests + typecheck");
  assert.equal(integrationGate({ type: 'BUG' }, { codeChanged: true }), 'full suite + typecheck; build if needed');
  assert.match(integrationGate({ type: 'TASK' }), /unless the worker diff changes the app/);
});

test('bounded material pool overlaps work and isolates per-item errors', async () => {
  let running = 0, peak = 0;
  const values = await mapBounded([1, 2, 3, 4], 2, async n => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running--;
    if (n === 3) throw new Error('synthetic failure');
    return n;
  });
  assert.equal(peak, 2);
  assert.deepEqual(values, [1, 2, { ok: false, error: 'synthetic failure' }, 4]);
});

test('wait_for_update wakes immediately when a queued code item becomes dispatchable', async () => {
  const s = new RuntimeSession();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS';
  s.items.set('BUG-91', { id: 'BUG-91', type: 'BUG', local: { queued: true } });
  s.freeMemory = () => 2 * 1024 ** 3;
  assert.equal(s.hasDispatchAction(), false);
  assert.match(s.view().queue[0], /waiting for code slot\/RAM/);
  s.freeMemory = () => 3 * 1024 ** 3;
  s.doRefresh = () => { throw new Error('No network read should precede available dispatch'); };
  const result = await s.wait_for_update();
  assert.equal(result.changed, true);
  assert.match(result.view.next, /BUG-91/);
  s.match.status = 'PAUSED';
  assert.equal(s.hasDispatchAction(), false, 'pause must not cause an immediate dispatch loop');
});

test('a deferred heavy item does not wake dispatch while ordinary work is active', () => {
  const s = new RuntimeSession({ adapter: { heavyTask: { startAfter: 'othersDone' } } });
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 30 * 60000; s.freeMemory = () => 8 * 1024 ** 3;
  s.items.set('CR-HEAVY', { id: 'CR-HEAVY', type: 'CR', title: '[Heavy Task] rewrite module', maxPoints: 300, local: {} });
  s.items.set('BUG-1', { id: 'BUG-1', type: 'BUG', title: 'Normal bug', maxPoints: 100, local: { startedAt: Date.now(), worktree: {} } });
  assert.equal(s.hasDispatchAction(), false);
  const view = s.view();
  assert.equal(view.heavy.deferred[0].id, 'CR-HEAVY');
  assert.ok(!view.alerts.some(a => /DISPATCH NOW.*CR-HEAVY/.test(a)), JSON.stringify(view.alerts));
});

test('default heavy policy starts a heavy item once every other open item has a worker', () => {
  const s = new RuntimeSession();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 3 * 60000; s.freeMemory = () => 8 * 1024 ** 3;
  s.items.set('CR-HEAVY', { id: 'CR-HEAVY', type: 'CR', title: '[Heavy Task] rewrite module', maxPoints: 300, local: {} });
  s.items.set('BUG-1', { id: 'BUG-1', type: 'BUG', title: 'Normal bug', maxPoints: 100, local: { startedAt: Date.now(), worktree: {} } });
  assert.equal(s.hasDispatchAction(), true, 'no othersDone wait and no minimum time left by default');
});

test('two heavy items run in parallel, and a heavy item with its own deadline only yields to PI', () => {
  const s = new RuntimeSession();
  const now = Date.now();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = now + 30 * 60000; s.now = () => now;
  s.items.set('TASK-H1', { id: 'TASK-H1', type: 'TASK', title: '[Heavy Task] archive audit', maxPoints: 100, local: { heavy: true, worktree: { matchRoot: '/x' }, startedAt: now } });
  s.items.set('TASK-H2', { id: 'TASK-H2', type: 'TASK', title: '[Heavy Task] sync storm', maxPoints: 100, deadlineAt: now + 20 * 60000, local: {} });
  s.items.set('BUG-OPEN', { id: 'BUG-OPEN', type: 'BUG', local: {} });
  s.refreshHeavyFlags();
  assert.equal(s.heavyDispatchDecision(s.items.get('TASK-H2')).allowed, true, 'own deadline: does not wait for BUG-OPEN, second heavy allowed');
  s.items.set('PI-1', { id: 'PI-1', type: 'PI', title: 'Incident', local: {} });
  assert.equal(s.heavyDispatchDecision(s.items.get('TASK-H2')).allowed, false, 'an open PI still goes first');
});

test('heavy time, skip/normal modes and PI priority are enforced in code', () => {
  const make = (minutes, heavyTask) => {
    const s = new RuntimeSession({ adapter: { heavyTask } });
    s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + minutes * 60000; s.freeMemory = () => 8 * 1024 ** 3;
    s.items.set('CR-H', { id: 'CR-H', type: 'CR', title: '[Heavy Task] migration', maxPoints: 300, local: {} });
    return s;
  };
  assert.equal(make(14, { minMinutesLeft: 15 }).hasDispatchAction(), false, 'an explicit minMinutesLeft still applies');
  assert.equal(make(30, { mode: 'skip' }).hasDispatchAction(), false);
  assert.equal(make(30, { mode: 'normal' }).hasDispatchAction(), true);
  const pi = make(30);
  pi.items.set('PI-1', { id: 'PI-1', type: 'PI', title: 'Incident', local: {} });
  pi.refreshHeavyFlags();
  assert.equal(pi.heavyDispatchDecision(pi.items.get('CR-H')).allowed, false);
  assert.equal(pi.hasDispatchAction(), true, 'the open PI still wakes dispatch immediately');
});

test('future-wave and unfittable ordinary items do not starve an eligible heavy item', () => {
  const s = new RuntimeSession();
  const now = Date.now();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = now + 30 * 60000; s.now = () => now;
  s.items.set('CR-H', { id: 'CR-H', type: 'CR', title: '[Heavy Task] migration', maxPoints: 300, local: {} });
  s.items.set('CR-FUTURE', { id: 'CR-FUTURE', type: 'CR', availability: 'UPCOMING', local: {} });
  s.items.set('BUG-LATE', { id: 'BUG-LATE', type: 'BUG', local: { parked: { remainingStep: 'finish', remainingMinutes: 45 }, dispatchedAt: now } });
  s.refreshHeavyFlags();
  assert.deepEqual(s.heavyDispatchDecision(s.items.get('CR-H')), { allowed: true });
  s.items.set('PI-FUTURE', { id: 'PI-FUTURE', type: 'PI', availability: 'UPCOMING', local: {} });
  assert.deepEqual(s.heavyDispatchDecision(s.items.get('CR-H')), { allowed: true }, 'an unrevealed PI is not open');
});

test('a heavy item gives up after two red gates and cannot dispatch a third time', async () => {
  const s = new RuntimeSession();
  const it = { id: 'CR-H', type: 'CR', maxPoints: 300, local: { heavy: true, worktree: { integratedSha: 'abc' } } };
  s.items.set(it.id, it); s.match.endsAt = Date.now() + 30 * 60000;
  s.worktree = async ({ action }) => action === 'rollback' ? { ok: true, retryBaseSha: 'base' } : { ok: true };
  s.gate = async () => ({ ok: false, verdict: 'CODE_FAILURE', tests: {}, types: {} });
  const first = await s.shipOne({ backlogItemKey: it.id });
  assert.doesNotMatch(first.next, /HEAVY_GAVE_UP/);
  const second = await s.shipOne({ backlogItemKey: it.id });
  assert.match(second.next, /HEAVY_GAVE_UP after two red gates/);
  assert.equal(it.local.heavyGaveUp, true);
  assert.equal(s.heavyDispatchDecision(it).reason, 'HEAVY_GAVE_UP');
});

test('thread budget: ordinary items queue at maxWorkerThreads-2, PI/deadline/resume may use the last 2 threads', () => {
  const live = n => Array.from({ length: n }, (_, i) => ({ id: `TASK-${i}`, type: 'TASK', local: { worktree: {}, answerOnly: true } }));
  const gb = 1024 ** 3;
  const task = { id: 'TASK-99', type: 'TASK', local: { answerOnly: true } };
  const pi = { id: 'PI-99', type: 'PI', local: {} };
  const bug = { id: 'BUG-99', type: 'BUG', deadlineAt: Date.now() + 600000, local: { answerOnly: false } };
  const p = { maxWorkerThreads: 8, maxAnswerWorkers: 20 };
  assert.equal(dispatchPolicy(task, live(6), p, 10 * gb).reason, 'THREAD_LIMIT');
  assert.equal(dispatchPolicy(task, live(5), p, 10 * gb).allowed, true);
  assert.equal(dispatchPolicy(pi, live(7), p, 10 * gb).allowed, true, 'PI uses a reserved thread');
  assert.equal(dispatchPolicy(pi, live(8), p, 10 * gb).reason, 'THREAD_LIMIT', 'never past the Codex thread cap');
  assert.equal(dispatchPolicy(bug, live(7), { ...p, maxCodeWorkers: 20 }, 10 * gb).allowed, true, 'deadline item uses a reserved thread');
  const done = live(8).map(i => ({ ...i, local: { ...i.local, ready: true } }));
  assert.equal(dispatchPolicy(task, done, p, 10 * gb).allowed, true, 'READY workers have ended');
  assert.equal(dispatchPolicy(task, live(3), {}, 10 * gb).maxWorkerThreads, 14);
});

test('RAM floor: below 1 GB only PI starts, answer items included; running workers are not counted as stopped', () => {
  const gb = 1024 ** 3;
  const answer = { id: 'TASK-1', type: 'TASK', local: { answerOnly: true } };
  const pi = { id: 'PI-1', type: 'PI', local: {} };
  assert.equal(dispatchPolicy(answer, [], {}, 0.9 * gb).reason, 'LOW_RAM');
  assert.equal(dispatchPolicy(answer, [], {}, 1.2 * gb).allowed, true, 'answer workers need only the floor');
  assert.equal(dispatchPolicy(pi, [], {}, 0.3 * gb).allowed, true);
  assert.equal(dispatchPolicy(answer, [], { minFreeRamGBAll: 0.5 }, 0.9 * gb).allowed, true, 'configurable');
});

test('an ordinary item that cannot start (its own lane is full) does not hold a heavy item with a free slot', () => {
  const s = new RuntimeSession({ adapter: { parallel: { maxAnswerWorkers: 2, maxCodeWorkers: 6, maxWorkerThreads: 14 } } });
  const now = Date.now();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = now + 40 * 60000; s.now = () => now; s.freeMemory = () => 8 * 1024 ** 3;
  s.items.set('CR-H', { id: 'CR-H', type: 'CR', title: '[Heavy Task] migration', maxPoints: 300, local: {} });
  for (const id of ['TASK-1', 'TASK-2']) s.items.set(id, { id, type: 'TASK', local: { answerOnly: true, worktree: {}, startedAt: now } });
  s.items.set('TASK-3', { id: 'TASK-3', type: 'TASK', local: { answerOnly: true, queued: true } });
  s.refreshHeavyFlags();
  assert.deepEqual(s.heavyDispatchDecision(s.items.get('CR-H')), { allowed: true }, 'TASK-3 waits for an answer slot; CR-H uses a free code slot');
  s.items.get('TASK-2').local.worktree = null;
  s.items.set('TASK-2', { ...s.items.get('TASK-2'), local: { answerOnly: true, ready: true } });
  assert.equal(s.heavyDispatchDecision(s.items.get('CR-H')).allowed, false, 'once TASK-3 can start it goes before the heavy item');
});

test('a queued item comes back by itself: RAM recovers or a thread frees, and the next wait_for_update poll dispatches it', async () => {
  const s = new RuntimeSession({ adapter: { parallel: { maxWorkerThreads: 4, maxAnswerWorkers: 6, maxCodeWorkers: 6 } } });
  const now = Date.now();
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = now + 40 * 60000; s.now = () => now;
  let ram = 0.5 * 1024 ** 3; s.freeMemory = () => ram;
  s.items.set('TASK-Q', { id: 'TASK-Q', type: 'TASK', local: { answerOnly: true, startedAt: now, queued: true } });
  assert.equal(s.hasDispatchAction(), false, 'LOW_RAM: waits');
  ram = 4 * 1024 ** 3;
  assert.equal(s.hasDispatchAction(), true, 'RAM recovered: wait_for_update returns and auto-dispatches');
  for (const id of ['BUG-1', 'BUG-2']) s.items.set(id, { id, type: 'BUG', local: { worktree: {}, startedAt: now } });
  assert.equal(s.hasDispatchAction(), false, 'THREAD_LIMIT (4 - 2 reserved): waits');
  s.items.get('BUG-1').local.ready = true;
  assert.equal(s.hasDispatchAction(), true, 'a worker returned READY: its thread is free again');
  // wait_for_update re-checks on every poll, not only on page changes.
  s.items.get('BUG-1').local.ready = false; let polls = 0;
  s.doRefresh = async () => { polls += 1; if (polls === 2) s.items.get('BUG-1').local.ready = true; return { ok: true, events: [] }; };
  s.withLock = fn => fn(); s.adapter.polling = { ...s.adapter.polling, successMs: 10, maxWaitMs: 2000 };
  let dispatched = false; s.withAutoDispatch = async r => { dispatched = true; return r; };
  const r = await s.wait_for_update({ timeoutMs: 2000 });
  assert.equal(dispatched, true, JSON.stringify(r).slice(0, 200)); assert.equal(polls, 2);
});
