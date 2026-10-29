import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { guardBaseline } from '../team-sdlc-pack/src/baseline-guard.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-guard-'));
  t.after(() => { assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(cwd, { recursive: true, force: true }); });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Synthetic'); git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  const write = (name, value) => { const f = path.join(cwd, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); };
  const commit = () => { git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'synthetic change'); return git(cwd, 'rev-parse', 'HEAD'); };
  write('outside/tests/foreign.test.js', 'outside'); commit();
  for (const file of ['src/math.test.js', 'src/math.spec.ts', '__tests__/unit.js', 'tests/spaced name.js', 'db/migrations/001/init.sql']) write(`assigned/${file}`, 'baseline');
  const baseline = commit();
  const answer = { backlogId: 'TASK-91', status: 'DONE', evidenceFiles: ['evidence/test.log'], engineeringRecord: { analysis: 'Verified synthetic behavior.', risks: [] } };
  return { cwd, write, commit, baseline, answer, check: async (a = answer, base = baseline) => guardBaseline({ cwd, folder: 'assigned', sha: git(cwd, 'rev-parse', 'HEAD'), baseline: base, answer: a }) };
}

test('baseline tests require a per-path committed citation; new tests and other folders are allowed', async t => {
  const f = setup(t);
  f.write('assigned/src/math.test.js', 'changed');
  fs.unlinkSync(path.join(f.cwd, 'assigned/tests/spaced name.js'));
  f.write('assigned/tests/new.test.js', 'new'); f.write('outside/tests/foreign.test.js', 'changed'); f.commit();
  const result = await f.check();
  assert.deepEqual(result.tests, [{ path: 'assigned/src/math.test.js', status: 'M' }, { path: 'assigned/tests/spaced name.js', status: 'D' }]);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0], `BASELINE_TEST_CHANGED: assigned/src/math.test.js (M); revert this path to baseline ${f.baseline}, or add a line "TEST-CHANGE assigned/src/math.test.js: <source>" to the existing answer analysis/risks field and commit again. Cite the item ID, a knowledge-base document ID (KB-<id>), or a design record (DECISIONS.md, specs/<path>, or design record: <id>) that explicitly requires the behavior change; use a real source, never add template keys.`);
  f.answer.engineeringRecord.analysis += '\nTEST-CHANGE assigned/src/math.test.js: TASK-91 changes the rounding rule';
  assert.equal((await f.check()).errors.length, 1);
  for (const source of ['KB-SYNTHETIC-7', 'DECISIONS.md section 2', 'specs/rounding.md', 'design record: SYN-8']) {
    f.answer.engineeringRecord.risks = [`TEST-CHANGE tests/spaced name.js: ${source}`];
    assert.deepEqual((await f.check()).errors, []);
  }
  f.answer.engineeringRecord.risks = ['TEST-CHANGE tests/spaced name.js: because it failed'];
  assert.equal((await f.check()).errors.length, 1);
});

test('modified, deleted and renamed baseline migrations are refused even with annotations', async t => {
  const f = setup(t);
  const file = 'assigned/db/migrations/001/init.sql';
  f.answer.engineeringRecord.analysis = `TEST-CHANGE ${file}: TASK-91`;
  f.write(file, 'modified'); f.commit();
  let result = await f.check();
  assert.deepEqual(result.migrations, [{ path: file, status: 'M' }]);
  assert.deepEqual(result.errors, [`BASELINE_MIGRATION_CHANGED: ${file} (M); revert this path to baseline ${f.baseline} and commit again. Add a new migration for the intended change; existing migrations cannot be waived.`]);
  git(f.cwd, 'mv', file, 'assigned/db/migrations/001/renamed.sql'); f.commit();
  result = await f.check();
  assert.deepEqual(result.migrations, [{ path: file, status: 'D' }]);
  assert.match(result.errors[0], /cannot be waived/);
});

test('first folder addition is the fallback baseline; all common test patterns and new migrations work', async t => {
  const f = setup(t);
  f.write('assigned/src/math.spec.ts', 'changed'); f.write('assigned/__tests__/unit.js', 'changed');
  f.write('assigned/db/migrations/002/new.sql', 'new migration'); f.commit();
  for (const base of [null, 'f'.repeat(40)]) {
    const result = await f.check(f.answer, base);
    assert.equal(result.revision, f.baseline);
    assert.deepEqual(result.tests.map(x => x.path), ['assigned/__tests__/unit.js', 'assigned/src/math.spec.ts']);
    assert.deepEqual(result.migrations, []);
  }
});

test('new tests alone are allowed and returning a baseline file to its original contents clears the guard', async t => {
  const f = setup(t);
  f.write('assigned/tests/new.test.js', 'new'); f.commit();
  assert.deepEqual((await f.check()).errors, []);
  f.write('assigned/src/math.test.js', 'changed'); f.commit();
  f.write('assigned/src/math.test.js', 'baseline'); f.commit();
  assert.deepEqual((await f.check()).tests, []);
});

test('submit and dryRun enforce the guard on the selected commit, ignoring a working-copy waiver', async t => {
  const f = setup(t);
  const answerPath = 'assigned/answers/TASK-91/submit.json';
  f.write(answerPath, f.answer); f.write('assigned/answers/TASK-91/evidence/test.log', 'Tests: 1 passed, 1 total');
  f.write('assigned/src/math.test.js', 'changed');
  let sha = f.commit(); git(f.cwd, 'update-ref', 'refs/remotes/origin/main', sha);
  const s = new RuntimeSession({ teamWorkspace: f.cwd });
  s.checkoutRoot = f.cwd; s.matchRoot = path.join(f.cwd, 'assigned'); s.repository = { branch: 'main', folder: 'assigned' };
  s.state.envReady = { revision: f.baseline }; s.phase = 'GAME'; s.bearer = 'synthetic';
  s.match.uuid = '11111111-2222-4333-8444-555555555555'; s.match.status = 'IN_PROGRESS';
  s.items.set('TASK-91', { id: 'TASK-91', type: 'TASK', local: { startedAt: Date.now() } });
  s.lastTests = { 'TASK-91': { status: 'PASSED', executed: 1, passed: 1, failed: 0 } };
  f.answer.engineeringRecord.analysis += '\nTEST-CHANGE src/math.test.js: TASK-91 explicitly changes behavior';
  f.write(answerPath, f.answer);
  for (const dryRun of [true, false]) {
    const result = await s.submit_work({ backlogItemKey: 'TASK-91', dryRun });
    assert.equal(result.refused, true);
    assert.equal(result.touchedBaseline.tests.length, 1);
    assert.match(result.errors[0], /^BASELINE_TEST_CHANGED:/);
    assert.deepEqual(s.state.submissions, {});
  }
  sha = f.commit(); git(f.cwd, 'update-ref', 'refs/remotes/origin/main', sha);
  assert.equal((await s.submit_work({ backlogItemKey: 'TASK-91', dryRun: true })).ok, true);
  f.write('assigned/db/migrations/001/init.sql', 'changed'); sha = f.commit(); git(f.cwd, 'update-ref', 'refs/remotes/origin/main', sha);
  for (const dryRun of [true, false]) {
    const result = await s.submit_work({ backlogItemKey: 'TASK-91', dryRun });
    assert.equal(result.refused, true); assert.equal(result.touchedBaseline.migrations.length, 1);
  }
});
