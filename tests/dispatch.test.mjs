import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOnly, dispatchPolicy, integrationGate, BuildQueue, mapBounded } from '../team-sdlc-pack/src/dispatch.mjs';
import { buildChecklist } from '../team-sdlc-pack/src/checklist.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';

test('classify PI and answer TASKs without putting code or runnable MVS on the fast path', () => {
  assert.equal(answerOnly({ type: 'PI' }), true);
  for (const description of ['Question: calculate the total.', 'Return answer values; no code changes required.', 'Report-only: identify the total.']) {
    assert.equal(answerOnly({ type: 'TASK', description }), true, description);
  }
  for (const item of [{ type: 'BUG', description: 'Answer why this fails.' }, { type: 'TASK', description: 'Question: implement a function to calculate values.' }, { type: 'TASK', description: 'Update the page and report values.' }, { type: 'TASK', description: 'Fix the answer calculation.' }, { type: 'TASK' }]) assert.equal(answerOnly(item), false);
  assert.equal(answerOnly({ type: 'TASK', title: 'Question' }, { minimumVerificationScenarios: [{ id: 'case-a', command: 'node verify.mjs' }] }), false);
  assert.equal(answerOnly({ type: 'TASK', title: 'Question' }, { minimumVerificationScenarios: 'No tests to run' }), true);
  const checklist = buildChecklist({ id: 'TASK-91', type: 'TASK', answerOnly: true, commands: { test: 'npm test', typecheck: 'tsc' } });
  assert.match(checklist.text, /shipped schema/);
  assert.doesNotMatch(checklist.text, /run npm test|Run tsc|test\.log/);
});

test('dispatch gates code on current RAM and active code count, never answer workers', () => {
  const running = Array.from({ length: 5 }, (_, n) => ({ id: `BUG-${n}`, type: 'BUG', local: { worktree: {} } }));
  const code = { id: 'CR-91', type: 'CR' };
  const gb = 1024 ** 3;
  assert.equal(dispatchPolicy(code, running, {}, 10 * gb).reason, 'CODE_WORKER_LIMIT');
  running[0].local.ready = true;
  assert.equal(dispatchPolicy(code, running, {}, 2.5 * gb).allowed, true);
  assert.equal(dispatchPolicy(code, running, {}, 2.5 * gb - 1).reason, 'LOW_RAM');
  running[1].local.parked = { remainingStep: 'verify' };
  assert.equal(dispatchPolicy(code, running, { maxCodeWorkers: 4 }, 3 * gb).codeWorkers, 3);
  for (const item of [{ id: 'PI-91', type: 'PI' }, { id: 'TASK-91', type: 'TASK', title: 'Question: answer values' }]) assert.equal(dispatchPolicy(item, running, { maxCodeWorkers: 1 }, 0).allowed, true);
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
  assert.equal(integrationGate({ type: 'PI', deadlineAt: 123 }), 'schema only');
  assert.equal(integrationGate({ type: 'TASK', local: { answerOnly: true } }), 'schema only');
  assert.equal(integrationGate({ type: 'TASK', title: 'Question', local: { answerOnly: false }, deadlineAt: 123 }), "item's own tests + typecheck");
  assert.equal(integrationGate({ type: 'BUG', deadlineAt: 123 }), "item's own tests + typecheck");
  assert.equal(integrationGate({ type: 'BUG' }), 'full suite + typecheck; build if needed');
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
