import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBaselineDefect, resolvedBaselineTests, dropGateDatabase } from '../team-sdlc-pack/src/runtime-session.mjs';

const CASCADE = 'tests/cascade.test.ts > deletion cascades (spec §4) > deleting a company with invoices is RESTRICTED (financial history is protected)';
const STATUS = 'tests/accounting.test.ts > double-entry accounting core (spec §4.2) > issuing an invoice posts DR AR / CR Revenue; payment posts DR Bank / CR AR and flips status';
const RULE = 'The grader runs the whole test suite. `tests/cascade.test.ts` is the only original test you may correct.';

test('a test the item text names as correctable is a shared BASELINE-FIX', () => {
  const d = classifyBaselineDefect({ test: CASCADE, file: 'tests/cascade.test.ts', descriptions: RULE,
    items: [{ id: 'BUG-02', text: 'Amounts for VND clients are 100 times too large' }, { id: 'CR-01', text: 'Export the filtered invoice list as CSV' }] });
  assert.equal(d.likelyOwner, 'BASELINE-FIX');
  assert.match(d.reason, /correctable/);
});

test('without the organizer sentence a schema rule in test and DECISIONS.md still counts', () => {
  const d = classifyBaselineDefect({ test: CASCADE, file: 'tests/cascade.test.ts', source: 'rejects RESTRICT', decisions: 'Invoices/payments use RESTRICT' });
  assert.equal(d.likelyOwner, 'BASELINE-FIX');
});

test('a red test owned by a backlog item stays with that item', () => {
  const d = classifyBaselineDefect({ test: STATUS, file: 'tests/accounting.test.ts', descriptions: RULE,
    items: [{ id: 'BUG-03', text: 'Payment status never flips for invoices\nbody' }] });
  assert.equal(d.likelyOwner, 'BACKLOG_ITEM');
  assert.equal(d.owner, 'BUG-03');
});

test('an unrelated red test that is not correctable is not assigned as BASELINE-FIX', () => {
  const d = classifyBaselineDefect({ test: STATUS, file: 'tests/accounting.test.ts', descriptions: RULE, items: [] });
  assert.equal(d.likelyOwner, 'BACKLOG_ITEM');
  assert.equal(d.owner, null);
});

test('defects resolve per test, as soon as a fresh-DB gate no longer fails them', () => {
  const defects = [{ test: CASCADE }, { test: STATUS }];
  const gate = ` FAIL  ${STATUS}\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 11 passed (12)\n`;
  assert.deepEqual(resolvedBaselineTests(defects, gate), [CASCADE]);
});

test('a crashed run without a summary resolves nothing', () => {
  assert.deepEqual(resolvedBaselineTests([{ test: CASCADE }], 'Error: connect ECONNREFUSED'), []);
});

test('only per-gate databases are dropped, in the app folder, without waiting', () => {
  const calls = [];
  const run = (cmd, args, opts) => calls.push({ cmd, args, opts });
  assert.equal(dropGateDatabase('/app', 'postgresql://u:p@127.0.0.1:5433/freelanceos_test_qx9_gate_bug_02_1', run), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, '/app');
  assert.match(calls[0].opts.env.MTM_DROP_URL, /_gate_bug_02_1$/);
  assert.match(calls[0].args[1], /DROP DATABASE IF EXISTS/);
  assert.equal(dropGateDatabase('/app', 'postgresql://u:p@127.0.0.1:5433/freelanceos_test', run), false);
  assert.equal(calls.length, 1);
});
