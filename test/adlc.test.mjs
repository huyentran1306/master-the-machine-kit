// Task Contract, scope check and retro (the ADLC artifacts of one item).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTemplate, parseContract, scopeCheck, isTestFile, mvsLines, buildRetro } from '../tool/lib/adlc.mjs';

test('the contract is prefilled with the MVS and stays open until the agent fills it', () => {
  const t = contractTemplate({ id: 'BUG-01', type: 'BUG', points: 200, mvs: ['GET /v/A on its last day returns 200', { name: 'the day after returns 410' }] });
  assert.match(t, /# Task Contract BUG-01 \| BUG \| 200 pts/);
  assert.match(t, / {2}- MVS 1: GET \/v\/A on its last day returns 200/);
  assert.match(t, / {2}- MVS 2: the day after returns 410/);
  let c = parseContract(t, 'BUG');
  assert.deepEqual(c.open, ['outcome', 'scope.allowed'], 'MVS lines alone already make acceptance concrete');
  assert.equal(c.openAcceptance, 2, 'the two hidden-scenario hints are still placeholders');

  const filled = t.replace('- outcome: <what the customer sees when this is done, one line>', '- outcome: vouchers work through their last day (UTC)')
    .replace(/- scope\.allowed: <[^>]+>/, '- scope.allowed: src/vouchers.js, docs/')
    .replace('<the same defect through another input, boundary or caller>', 'expiry at 23:59:59 UTC still valid');
  c = parseContract(filled, 'BUG');
  assert.deepEqual(c.open, []);
  assert.equal(c.fields['scope.allowed'], 'src/vouchers.js, docs/');
  assert.equal(c.acceptance.length, 4);
  assert.equal(c.openAcceptance, 1);
});

test('a PI contract needs only outcome and a repro; code such as List<Voucher> is not a placeholder', () => {
  const t = contractTemplate({ id: 'PI-01', type: 'PI', points: 400, mvs: null });
  assert.deepEqual(parseContract(t, 'PI').open, ['outcome', 'acceptance']);
  const filled = t.replace('<what the customer sees when this is done, one line>', 'redeem works for List<Voucher> without tags')
    .replace('<the failing test that proves the incident, named>', 'redeem.test.js "voucher without tags"');
  assert.deepEqual(parseContract(filled, 'PI').open, []);
});

test('MVS in every shape becomes one line per scenario', () => {
  assert.deepEqual(mvsLines('## MVS (all must pass)\n1. first case\n2) second case\n- third'), ['first case', 'second case', 'third']);
  assert.deepEqual(mvsLines({ scenarios: [{ title: 'a' }, 'b'] }), ['a', 'b']);
  assert.deepEqual(mvsLines(null), []);
});

test('scope check: folders, globs and same-name files; tests never count as out of scope', () => {
  const files = ['src/vouchers.js', 'src/redeem.js', 'docs/api.md', 'test/vouchers.test.js', 'src/Billing/PriceTests.cs', 'README.md', 'src/lib/x.ts'];
  const r = scopeCheck(files, 'src/vouchers, docs/, src/**/*.ts');
  assert.ok(r.checked);
  assert.deepEqual(r.outOfScope, ['src/redeem.js', 'README.md']);
  assert.equal(scopeCheck(files, '<files or folders you expect to change>').checked, false);
  assert.ok(isTestFile('src/test/java/com/acme/FooTest.java'));
  assert.ok(isTestFile('pkg/handler_test.go'));
  assert.ok(isTestFile('tests/test_api.py'));
  assert.ok(!isTestFile('src/latest.js'));
});

test('retro: real minutes against estimates, FAILED items, never started work', () => {
  const now = Date.now();
  const text = buildRetro({
    matchId: 'm1',
    score: 500,
    estMinutes: { BUG: 8, CR: 12 },
    typeOf: (id) => id.split('-')[0],
    items: [
      { id: 'BUG-01', type: 'BUG', maxPoints: 200, result: 'PASSED', score: 200 },
      { id: 'CR-01', type: 'CR', maxPoints: 300, result: 'FAILED', score: 0 },
      { id: 'TASK-02', type: 'TASK', maxPoints: 100 },
    ],
    ledger: {
      BASELINE: { evidence: [] },
      'BUG-01': { startedAt: now - 9e5, submittedAt: now - 3e5, activeMs: 5e5, reviews: [{}], contractOpen: [], evidence: [{ exit: 0 }] },
      'CR-01': { startedAt: now - 2e6, submittedAt: now - 1e5, contractOpen: ['scope.allowed'], evidence: [{ exit: 1 }, { exit: 0 }] },
    },
  });
  assert.match(text, /# Retro, match m1 \(score 500\)/);
  assert.match(text, /\| BUG-01 \| BUG \| 200 \| PASSED 200 \| 8\.3 \| 8 \| 1\/1 \| yes \| filled \|/);
  assert.match(text, /CR-01 FAILED: review did NOT run; contract left open/);
  assert.match(text, /TASK-02 \(TASK, 100 pts\) never started/);
  assert.match(text, /CR: median 31\.7 min over 1 \(estMinutes 12\) -> set planner\.estMinutes\.CR to 32/);
  assert.match(text, /BUG: median 8\.3 min over 1 \(estMinutes 8\) -> keep/);
  assert.doesNotMatch(text, /BASELINE/);
});
