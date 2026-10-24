import test from 'node:test';
import assert from 'node:assert/strict';
import { rankItems, diffSnapshots, computeAlerts, isDone, isLoud, effectiveLeft, nextSnapshot } from '../tool/lib/planner.mjs';

const NOW = Date.parse('2026-10-28T09:00:00Z');
const min = (m) => NOW + m * 60000;
const item = (id, extra = {}) => ({ id, type: id.split('-')[0], state: 'OPEN', maxPoints: 100, revealedAt: min(-10), deadlineAt: null, ...extra });
const ids = (r) => r.ranked.map((x) => x.item.id);

test('PI beats started work that is not close to its deadline', () => {
  const r = rankItems([item('CR-01', { maxPoints: 300 }), item('PI-01')], { 'CR-01': { startedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['PI-01', 'CR-01']);
});

test('a started item that a PI would make miss its deadline ships first', () => {
  // CR-01 has 4 minutes left; an 8-minute PI now would lose the whole CR.
  const r = rankItems([item('CR-01', { maxPoints: 300, deadlineAt: min(4) }), item('PI-01', { maxPoints: 400 })], { 'CR-01': { startedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['CR-01', 'PI-01']);
  assert.match(r.ranked[0].why, /finish first/);
});

test('the guard does not pull the agent off a PI already in progress', () => {
  const r = rankItems([item('CR-01', { deadlineAt: min(4) }), item('PI-01')], { 'CR-01': { startedAt: 1 }, 'PI-01': { startedAt: 2 } }, NOW);
  assert.deepEqual(ids(r), ['PI-01', 'CR-01']);
});

test('a PI in progress stays ahead of a newer, bigger PI', () => {
  const r = rankItems([item('PI-01', { maxPoints: 200 }), item('PI-02', { maxPoints: 400 })], { 'PI-01': { startedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['PI-01', 'PI-02']);
});

test('plain items rank by points per estimated minute', () => {
  const r = rankItems([item('CR-01', { maxPoints: 300 }), item('BUG-01', { maxPoints: 200 }), item('TASK-01', { maxPoints: 100 })], {}, NOW);
  assert.deepEqual(ids(r), ['BUG-01', 'CR-01', 'TASK-01']); // 33, 25, 20 points per minute
});

test('urgent items: earliest deadline first while all fit, most valuable first when they cannot', () => {
  const fit = rankItems([item('BUG-01', { deadlineAt: min(12) }), item('BUG-02', { deadlineAt: min(7), maxPoints: 50 })], {}, NOW);
  assert.deepEqual(ids(fit), ['BUG-02', 'BUG-01']); // 6 + 6 minutes fit before 12
  const tight = rankItems([item('CR-01', { maxPoints: 100, deadlineAt: min(9) }), item('CR-02', { maxPoints: 400, deadlineAt: min(11) })], {}, NOW);
  assert.deepEqual(ids(tight), ['CR-02', 'CR-01']); // 12 + 12 minutes cannot both fit: value wins
});

test('near the end of the match: skip what cannot start, demote what is tight', () => {
  const r = rankItems([item('CR-03', { maxPoints: 500 }), item('BUG-03'), item('TASK-02'), item('PI-01')], {}, NOW, { matchEndsAt: min(10) });
  // CR needs ~12m (tight at 10m) and sorts after the items that fit, despite its 500 points.
  assert.deepEqual(ids(r), ['PI-01', 'TASK-02', 'BUG-03', 'CR-03']);
  const late = rankItems([item('BUG-01'), item('CR-01', { maxPoints: 300 }), item('TASK-02')], { 'CR-01': { startedAt: 1 } }, NOW, { matchEndsAt: min(4.5) });
  assert.deepEqual(ids(late), ['CR-01', 'TASK-02']); // started CR stays; BUG needs 5m
  assert.deepEqual(late.skipped.map((s) => s.item.id), ['BUG-01']);
});

test('done, closed, expired and parked items', () => {
  const items = [
    item('BUG-01', { submissionStatus: 'ACCEPTED' }),
    item('BUG-02', { state: 'CLOSED' }),
    item('CR-01', { deadlineAt: min(-1) }),
    item('CR-02', { deadlineAt: min(3) }),
    item('TASK-01'),
    item('TASK-02', { submissionStatus: 'REJECTED' }),
    item('TASK-03'),
  ];
  const r = rankItems(items, { 'TASK-01': { submittedAt: 1 }, 'TASK-03': { startedAt: 1, parkedAt: 2 } }, NOW);
  assert.deepEqual(ids(r), ['TASK-02', 'TASK-03']); // a REJECTED attempt can be redone; parked goes last
  assert.match(r.ranked[1].why, /parked/);
  assert.deepEqual(r.skipped.map((s) => s.item.id).sort(), ['BUG-02', 'CR-01', 'CR-02']);
});

test('a started item survives an unknown in-progress state; a closed one does not', () => {
  const r = rankItems([item('CR-01', { state: 'IN_PROGRESS' }), item('CR-02', { state: 'CLOSED' })], { 'CR-01': { startedAt: 1 }, 'CR-02': { startedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['CR-01']);
});

test('VISIBLE items whose start was refused rank after all open work, PIs included', () => {
  const r = rankItems([item('PI-01', { state: 'VISIBLE' }), item('BUG-01'), item('TASK-01')], { 'TASK-01': { startedAt: 1 }, 'PI-01': { startRefusedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['TASK-01', 'BUG-01', 'PI-01']);
});

test('an estimated deadline (minutes, pauses ignored) never drops a started item', () => {
  const r = rankItems([item('CR-01', { deadlineAt: min(-2), deadlineEstimated: true })], { 'CR-01': { startedAt: 1 } }, NOW);
  assert.deepEqual(ids(r), ['CR-01']);
});

test('isDone only for done statuses', () => {
  assert.equal(isDone(item('A-1', { submissionStatus: 'NOT_SUBMITTED' })), false);
  assert.equal(isDone(item('A-1', { submissionStatus: 'REJECTED' })), false);
  assert.equal(isDone(item('A-1', { submissionStatus: 'GRADING' })), true);
  assert.equal(isDone(item('A-1', { result: 'FAILED' })), true);
});

test('effective time left is the earlier of deadline and match end', () => {
  assert.deepEqual(effectiveLeft(item('X-1', { deadlineAt: min(20) }), NOW, min(6)), { left: 6, by: 'match end' });
  assert.deepEqual(effectiveLeft(item('X-1', { deadlineAt: min(3) }), NOW, min(6)), { left: 3, by: 'deadline' });
  assert.deepEqual(effectiveLeft(item('X-1'), NOW, null), { left: null, by: null });
});

test('alerts: orders only for the current item, notes for waiting ones, none of the time-box alerts while paused', () => {
  const m = {
    serverNow: NOW,
    paused: false,
    items: [item('PI-01', { revealedAt: min(-1.5) }), item('CR-01'), item('BUG-01'), item('BUG-02', { state: 'CLOSED' })],
  };
  const led = { 'CR-01': { startedAt: 1 }, 'BUG-01': { startedAt: 1, activeMs: 15 * 60000 }, 'BUG-02': { startedAt: 1 } };
  const a = computeAlerts(m, led, { matchEndsAt: min(30), current: 'BUG-01', currentSince: Date.now() - 5 * 60000 });
  assert.ok(a.some((x) => /^!! PI PI-01 revealed 1\.5m ago/.test(x)), a.join('\n'));
  assert.ok(a.some((x) => /^!! OVER BUDGET BUG-01: 20\.0m of work, budget 9m/.test(x)), a.join('\n'));
  assert.ok(a.some((x) => /^!! ABANDON BUG-02: it is CLOSED\. It is not your current item: do not stash anything/.test(x)), a.join('\n'));
  assert.ok(!a.some((x) => /CR-01/.test(x)), 'a stashed item far from its end gets nothing');

  const wrap = computeAlerts(m, led, { matchEndsAt: min(4), current: 'CR-01', currentSince: Date.now() });
  assert.ok(wrap.some((x) => /^!! WRAP UP CR-01: 4\.0m left \(match end\)/.test(x)), wrap.join('\n'));
  assert.ok(wrap.some((x) => /^note: BUG-01 is waiting/.test(x)), 'a stashed item near its end is only a note');
  assert.ok(!wrap.some((x) => /^!! (WRAP UP|OVER BUDGET) BUG-01/.test(x)));

  const paused = computeAlerts({ ...m, paused: true }, led, { matchEndsAt: min(4), current: 'BUG-01', currentSince: Date.now() - 5 * 60000 });
  assert.ok(paused.some((x) => /MATCH PAUSED/.test(x)));
  assert.ok(!paused.some((x) => /OVER BUDGET|WRAP UP/.test(x)), paused.join('\n'));
});

test('the finish-first guard uses the item deadline only, never the match end', () => {
  const late = rankItems([item('TASK-03'), item('PI-02', { maxPoints: 400 })], { 'TASK-03': { startedAt: 1 } }, NOW, { matchEndsAt: min(9) });
  assert.deepEqual(ids(late), ['PI-02', 'TASK-03']);
  const uncertain = rankItems([item('BUG-04', { deadlineAt: min(8) })], { 'BUG-04': { startedAt: 1, submitUncertainAt: 2 } }, NOW);
  assert.match(uncertain.ranked[0].why, /submit uncertain/);
});

test('an item refused twice at start goes to the end of the queue', () => {
  const r = rankItems([item('TASK-02', { maxPoints: 500 }), item('BUG-03')], { 'TASK-02': { startRefusals: 2 } }, NOW);
  assert.deepEqual(ids(r), ['BUG-03', 'TASK-02']);
  assert.match(r.ranked[1].why, /start refused twice/);
});

test('a pending result is not done', () => {
  assert.equal(isDone(item('A-1', { result: 'PENDING' })), false);
  assert.equal(isDone(item('A-1', { result: 'PASSED' })), true);
});

test('diff: new, state, edited, result with reason, removed; grading noise is quiet', () => {
  const prev = { status: 'RUNNING', items: [
    { id: 'BUG-01', state: 'OPEN', result: null, specHash: 'a', maxPoints: 200 },
    { id: 'CR-01', state: 'OPEN', specHash: 'b', maxPoints: 300 },
    { id: 'TASK-01', state: 'OPEN', specHash: 'c', maxPoints: 100 },
  ] };
  const cur = { status: 'RUNNING', items: [
    { id: 'BUG-01', state: 'OPEN', result: 'FAILED', score: 0, failReason: 'hidden scenarios failed', specHash: 'a', maxPoints: 200 },
    { id: 'CR-01', state: 'CLOSED', specHash: 'b2', maxPoints: 250 },
    { id: 'PI-01', type: 'PI', maxPoints: 400, state: 'OPEN' },
  ] };
  const ev = diffSnapshots(prev, cur);
  assert.deepEqual(ev.map((e) => e.text), [
    'RESULT BUG-01 FAILED 0pts (hidden scenarios failed)',
    'STATE CR-01 OPEN -> CLOSED',
    'EDITED CR-01 (spec, points)',
    'NEW PI-01 PI 400pts',
    'REMOVED TASK-01 (no longer on the match page)',
  ]);
  assert.deepEqual(ev.find((e) => e.kind === 'EDITED').edits, ['spec', 'points']);
  assert.deepEqual(diffSnapshots(cur, cur), []);
  assert.equal(isLoud({ kind: 'SUBMISSION' }), false);
  assert.equal(isLoud({ kind: 'NEW' }), true);
});

test('a backlog hidden during a pause is not "withdrawn", and comes back without NEW events', () => {
  const prev = { status: 'RUNNING', items: [{ id: 'CR-01', state: 'OPEN' }, { id: 'BUG-01', state: 'OPEN' }] };
  const hiddenMatch = { status: 'PAUSED', items: [] };
  const ev = diffSnapshots(prev, hiddenMatch);
  assert.deepEqual(ev.map((e) => e.kind), ['MATCH', 'HIDDEN']);
  const kept = nextSnapshot(prev, hiddenMatch);
  assert.deepEqual(kept.items.map((i) => i.id).sort(), ['BUG-01', 'CR-01']);
  const back = diffSnapshots(kept, { status: 'RUNNING', items: prev.items });
  assert.deepEqual(back.map((e) => e.text), ['MATCH PAUSED -> RUNNING']);
});

test('VISIBLE counts as workable until a start is refused; then it goes below parked work', () => {
  const r = rankItems([item('PI-01', { state: 'VISIBLE' }), item('BUG-01')], {}, NOW);
  assert.deepEqual(ids(r), ['PI-01', 'BUG-01']);
  const m = { serverNow: NOW, items: [item('PI-01', { state: 'VISIBLE', revealedAt: min(-1) })] };
  assert.ok(computeAlerts(m, {}, {}).some((x) => /^!! PI PI-01/.test(x)), 'a VISIBLE PI still alerts');
  const refused = rankItems([item('PI-01', { state: 'VISIBLE' }), item('TASK-02')], { 'PI-01': { startRefusedAt: 1, startRefusals: 1 }, 'TASK-02': { startedAt: 1, parkedAt: 2 } }, NOW);
  assert.deepEqual(ids(refused), ['TASK-02', 'PI-01']);
  assert.equal(computeAlerts(m, { 'PI-01': { startRefusedAt: 1 } }, {}).length, 0);
});

test('urgent items: the most valuable set that fits, in deadline order', () => {
  const r = rankItems([
    item('TASK-04', { maxPoints: 100, deadlineAt: min(5) }),
    item('BUG-05', { maxPoints: 50, deadlineAt: min(11) }),
    item('BUG-06', { maxPoints: 600, deadlineAt: min(12) }),
  ], {}, NOW);
  assert.deepEqual(ids(r), ['TASK-04', 'BUG-06', 'BUG-05']); // 700 points instead of 600
  assert.match(r.ranked[2].why, /would not fit/);
});

test('a tight urgent item ranks below comfortable work', () => {
  const r = rankItems([item('CR-05', { maxPoints: 100, deadlineAt: min(9) }), item('BUG-05', { maxPoints: 300 }), item('TASK-05', { maxPoints: 200 })], {}, NOW);
  assert.deepEqual(ids(r), ['BUG-05', 'TASK-05', 'CR-05']);
});

test('no PI alert for a PI too late to start; no WRAP UP from a passed estimated deadline', () => {
  const m = { serverNow: NOW, items: [item('PI-03', { revealedAt: min(-10) }), item('CR-02', { deadlineAt: min(-3), deadlineEstimated: true })] };
  const a = computeAlerts(m, { 'CR-02': { startedAt: 1 } }, { matchEndsAt: min(3), current: 'CR-02', currentSince: Date.now() });
  assert.ok(!a.some((x) => /PI-03/.test(x)), a.join('\n'));
  assert.ok(a.some((x) => /^!! WRAP UP CR-02: 3\.0m left \(match end\)/.test(x)), a.join('\n'));
});

test('over-budget uses the Game Master clock, including accelerated rehearsals', () => {
  const serverNow = min(20);
  const m = { serverNow, items: [item('BUG-09')] };
  const alerts = computeAlerts(m, {
    'BUG-09': { startedAt: Date.now(), startedServerAt: min(2), activeServerMs: 0 },
  }, {
    current: 'BUG-09',
    currentSince: Date.now(),
    currentServerSince: min(2),
    estMinutes: { BUG: 6 },
    budgetFactor: 1.5,
  });
  assert.ok(alerts.some((x) => /^!! OVER BUDGET BUG-09: 18\.0m of work, budget 9m\. Stop changing code now\./.test(x)), alerts.join('\n'));
});
