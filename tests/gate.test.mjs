import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { itemTestFiles, assertionFailure } from '../team-sdlc-pack/src/gate.mjs';

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
// Fake vitest/tsc: behaviour chosen by the GATE_MODE file next to them.
const FAKE = `import fs from 'node:fs';
const mode = fs.readFileSync(new URL('./mode', import.meta.url), 'utf8').trim();
const args = process.argv.slice(2).join(' ');
console.log('ran ' + args);
if (mode === 'green') { console.log(' Test Files  1 passed (1)\\n      Tests  3 passed (3)'); process.exit(0); }
if (mode === 'fail') { console.log(' FAIL  tests/bug-91.test.ts > rounds\\n      Tests  1 failed | 2 passed (3)'); process.exit(1); }
if (mode === 'noise') { console.log('      Tests  3 passed (3)\\n[ELIFECYCLE] Test failed. See above for more details.'); process.exit(1); }
if (mode === 'hang') setInterval(() => {}, 1000);`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'F'); git(root, 'config', 'user.email', 'f@example.invalid');
  const app = path.join(root, 'assigned', 'src');
  fs.mkdirSync(path.join(app, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(app, 'tests', 'bug-91.test.ts'), 'test');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'BUG-91: fix');
  for (const [dir, file] of [['vitest', 'vitest.mjs'], ['typescript/bin', 'tsc']]) {
    const d = path.join(app, 'node_modules', dir); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), FAKE.replace("'./mode'", "'" + path.relative(d, path.join(app, 'node_modules', 'mode')).split(path.sep).join('/').replace(/^(?!\.)/, './') + "'"));
  }
  const s = new RuntimeSession({ teamWorkspace: root });
  s.checkoutRoot = root; s.matchRoot = path.join(root, 'assigned'); s.appPath = app; s.repository = { folder: 'assigned' };
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 20 * 60000;
  s.items.set('BUG-91', { id: 'BUG-91', type: 'BUG', deadlineAt: Date.now() + 6 * 60000, local: { startedAt: Date.now(), answerOnly: false, worktree: { integrationBase: base, integratedSha: git(root, 'rev-parse', 'HEAD') } } });
  const mode = (m) => fs.writeFileSync(path.join(app, 'node_modules', 'mode'), m);
  return { s, app, mode };
}

test('gate runs the item\'s own tests with direct binaries and tells code failures from environment trouble', async (t) => {
  const { s, app, mode } = fixture(t);
  mode('green');
  const g = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(g.verdict, 'GREEN'); assert.equal(g.scope, 'item'); assert.deepEqual(g.files, ['tests/bug-91.test.ts']);
  assert.match(fs.readFileSync(path.join(s.checkoutRoot, '.mtm-notes', 'gate-BUG-91-tests.log'), 'utf8'), /ran run tests\/bug-91\.test\.ts/);
  assert.match(g.tests.summary, /3 passed/); assert.match(g.next, /push now, then submit_work BUG-91/);
  mode('fail');
  const f = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(f.verdict, 'CODE_FAILURE'); assert.match(f.next, /worktree rollback BUG-91/);
  mode('noise');
  const n = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(n.verdict, 'ENVIRONMENT'); assert.match(n.next, /do NOT roll back/);
  mode('hang');
  const h = await s.gate({ backlogItemKey: 'BUG-91', budgetSec: 2 });
  assert.equal(h.verdict, 'ENVIRONMENT'); assert.equal(h.tests.timedOut, true); assert.ok(h.seconds < 10);
  s.items.get('BUG-91').deadlineAt = Date.now() + 2 * 60000;
  const late = await s.gate({ backlogItemKey: 'BUG-91', budgetSec: 2 });
  assert.match(late.next, /Push and submit_work BUG-91 NOW/);
  assert.equal((await s.gate({ backlogItemKey: 'NOPE-1' })).error, 'UNKNOWN_ITEM');
});

test('gate helpers', () => {
  assert.deepEqual(itemTestFiles(['assigned/src/tests/x.test.ts', 'assigned/src/lib/x.ts', 'other/y.test.ts', 'assigned/src/challenge/z.test.ts'], 'assigned/src'), ['tests/x.test.ts']);
  assert.equal(assertionFailure({ exit: 1, text: 'error TS2322: nope' }, 'types'), true);
  assert.equal(assertionFailure({ exit: 1, timedOut: true, text: 'Tests 1 failed' }, 'tests'), false);
});
