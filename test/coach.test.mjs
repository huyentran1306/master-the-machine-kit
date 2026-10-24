import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoachReport, renderCoachHtml } from '../tool/lib/coach.mjs';

const minute = 60_000;

test('coach uses server-clock item timestamps and exposes failed readiness gates', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const report = buildCoachReport({
    match: { matchId: 'm1', readyAt: 'yes' },
    hookProbe: { event: 'Stop' },
    estimates: { BUG: 6, TASK: 5 },
    ledger: {
      BASELINE: { evidence: [{ exit: 0, timedOut: false }] },
      'BUG-01': { startedServerAt: start + 2 * minute, submittedServerAt: start + 7 * minute, evidence: [{ exit: 0 }], reviews: [{}] },
      'TASK-01': { startedServerAt: start + 3 * minute, submittedServerAt: start + 11 * minute },
    },
    snapshot: {
      status: 'FINISHED', score: 200,
      items: [
        { id: 'BUG-01', type: 'BUG', maxPoints: 200, result: 'PASSED', score: 200, revealedAt: new Date(start).toISOString(), deadlineAt: new Date(start + 10 * minute).toISOString() },
        { id: 'TASK-01', type: 'TASK', maxPoints: 100, result: 'FAILED', score: 0, revealedAt: new Date(start).toISOString() },
      ],
    },
  });
  const bug = report.items.find((item) => item.id === 'BUG-01');
  assert.equal(bug.responseMin, 2);
  assert.equal(bug.workMin, 5);
  assert.equal(bug.slackMin, 3);
  assert.equal(report.status, 'TRAIN AGAIN');
  assert.ok(report.gates.some((gate) => gate.label === 'No submit failure' && !gate.pass));
  assert.match(renderCoachHtml(report), /Server-clock timeline/);
  assert.match(renderCoachHtml(report), /BUG-01/);
});

test('coach declines readiness when timing samples are insufficient', () => {
  const report = buildCoachReport({
    match: { matchId: 'm2', readyAt: 'yes' }, hookProbe: { event: 'Stop' }, estimates: { TASK: 5 },
    ledger: { BASELINE: { evidence: [{ exit: 0 }] } },
    snapshot: { status: 'FINISHED', score: 100, items: [{ id: 'TASK-01', type: 'TASK', maxPoints: 100, result: 'PASSED', score: 100 }] },
  });
  assert.equal(report.status, 'TRAIN AGAIN');
  assert.match(report.reasons.join('\n'), /at least two completed items/);
});
