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
console.log('db=' + (process.env.TEST_DATABASE_URL || 'none'));
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
  fs.writeFileSync(path.join(app, '.env'), 'TEST_DATABASE_URL="postgresql://localhost/freelanceos_match_test"\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
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
  const gateLog = fs.readFileSync(path.join(s.checkoutRoot, '.mtm-notes', 'gate-BUG-91-tests.log'), 'utf8');
  assert.match(gateLog, /ran run tests\/bug-91\.test\.ts/);
  assert.match(gateLog, /freelanceos_match_test_match_gate_bug_91_1/);
  assert.equal(g.testDatabase, 'fresh isolated database');
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

test('an urgent deadline ship interrupts a running non-deadline gate without a code-failure rollback', async t => {
  const { s, mode } = fixture(t);
  s.items.get('BUG-91').deadlineAt = null;
  mode('hang');
  const running = s.gate({ backlogItemKey: 'BUG-91', budgetSec: 30 });
  while (!s.activeGate) await new Promise(resolve => setImmediate(resolve));
  s.items.set('BUG-99', { id: 'BUG-99', type: 'BUG', deadlineAt: Date.now() + 2 * 60000, local: {} });
  s.phase = 'IDLE'; // the trigger is independent of auto-dispatch in this focused test
  await s.ship({ backlogItemKey: 'BUG-99' });
  const out = await running;
  assert.equal(out.verdict, 'INTERRUPTED');
  assert.match(out.next, /Do not roll back BUG-91/);
  assert.ok(out.seconds < 5, JSON.stringify(out));
});

test('gate helpers', () => {
  assert.deepEqual(itemTestFiles(['assigned/src/tests/x.test.ts', 'assigned/src/lib/x.ts', 'other/y.test.ts', 'assigned/src/challenge/z.test.ts'], 'assigned/src'), ['tests/x.test.ts']);
  assert.equal(assertionFailure({ exit: 1, text: 'error TS2322: nope' }, 'types'), true);
  assert.equal(assertionFailure({ exit: 1, timedOut: true, text: 'Tests 1 failed' }, 'tests'), false);
});

test('validate-answer checks schema, status, backlogId and evidence without installs', async (t) => {
  const { checkSubmit } = await import('../team-sdlc-pack/src/validate-answer.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-va-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ans = path.join(dir, 'answers', 'PI-07'); fs.mkdirSync(ans, { recursive: true });
  const schema = path.join(dir, 'PI-07-submit.schema.json');
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', required: ['backlogId', 'status', 'rootCause'], properties: { backlogId: { const: 'PI-07' }, status: { enum: ['DONE', 'PARTIAL', 'BLOCKED'] }, rootCause: { type: 'string', minLength: 1 } } }));
  fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify({ backlogId: 'PI-07', status: 'NOT_STARTED', rootCause: '', evidenceFiles: ['evidence/x.log'] }));
  const bad = checkSubmit(path.join(ans, 'submit.json'), schema);
  assert.ok(bad.some((p) => /NOT_STARTED/.test(p))); assert.ok(bad.some((p) => /schema/.test(p))); assert.ok(bad.some((p) => /missing evidence\/x\.log/.test(p)));
  fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify({ backlogId: 'PI-07', status: 'DONE', rootCause: 'cache' }));
  assert.deepEqual(checkSubmit(path.join(ans, 'submit.json'), schema), []);
});

test('ship goes READY -> integrate -> gate -> BACKLOG_TESTS -> push -> submit -> remove in one call and stops on refusals', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-ship-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const remote = path.join(tmp, 'remote.git'); const root = path.join(tmp, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root]);
  git(root, 'config', 'user.name', 'F'); git(root, 'config', 'user.email', 'f@example.invalid'); git(root, 'checkout', '-q', '-b', 'main');
  const app = path.join(root, 'assigned', 'src'); fs.mkdirSync(path.join(app, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), '{}'); fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base'); git(root, 'push', '-q', '-u', 'origin', 'main');
  for (const [dir, file] of [['vitest', 'vitest.mjs'], ['typescript/bin', 'tsc']]) {
    const d = path.join(app, 'node_modules', dir); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), `import fs from 'node:fs'; const m=fs.readFileSync(${JSON.stringify(path.join(app, 'node_modules', 'mode'))},'utf8').trim(); if(m==='fail'){console.log(' FAIL x\\n      Tests  1 failed | 2 passed (3)');process.exit(1)} console.log(' Test Files  1 passed (1)\\n      Tests  4 passed (4)');`);
    if (file === 'tsc') fs.writeFileSync(path.join(d, file), `console.log('ok')`);
  }
  const mode = (m) => fs.writeFileSync(path.join(app, 'node_modules', 'mode'), m);
  const s = new RuntimeSession({ teamWorkspace: root });
  s.checkoutRoot = root; s.matchRoot = path.join(root, 'assigned'); s.appPath = app; s.repository = { folder: 'assigned', branch: 'main' };
  s.phase = 'GAME'; s.match.status = 'IN_PROGRESS'; s.match.endsAt = Date.now() + 25 * 60000; s.freeMemory = () => 8 * 1024 ** 3;
  s.materialCache = {};
  const events = []; s.report_progress = async ({ event }) => { events.push(event); s.lastTests = { ...(s.lastTests || {}), [event.backlogId]: event }; return { ok: true }; };
  const submits = []; s.submit_work = async (a) => { submits.push(a); s.items.get(a.backlogItemKey).local.receiptId = 'r' + submits.length; return { ok: true, outcome: 'SUBMITTED', receipt: { receiptId: 'r1' }, gitRevision: a.gitRevision }; };
  const mk = async (id) => {
    s.items.set(id, { id, type: 'BUG', deadlineAt: Date.now() + 10 * 60000, local: { startedAt: Date.now() } });
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
  await mk('BUG-71');
  mode('green');
  const r = await s.ship({ backlogItemKey: 'BUG-71' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps.map((x) => x.step), ['integrate', 'gate', 'push', 'submit', 'remove']);
  assert.equal(git(remote, 'rev-parse', 'main'), s.items.get('BUG-71').local.worktree?.integratedSha ?? git(root, 'rev-parse', 'HEAD'));
  assert.equal(submits[0].gitRevision, git(root, 'rev-parse', 'HEAD'));
  assert.equal(events[0]?.type, 'BACKLOG_TESTS', JSON.stringify(r.gate)); assert.equal(events[0].passed, 4);
  assert.equal(s.items.get('BUG-71').local.worktree, undefined, 'worker copy removed');

  await mk('BUG-72'); mode('fail');
  const f = await s.ship({ backlogItemKey: 'BUG-72' });
  assert.equal(f.ok, false); assert.equal(f.stage, 'gate', JSON.stringify(f).slice(0, 600)); assert.equal(f.verdict, 'CODE_FAILURE');
  assert.equal(submits.length, 1, 'nothing submitted on a red gate');
  assert.notEqual(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'), 'nothing pushed on a red gate');
  // Remote moved outside the assigned match: ship safely rebases it, never force-pushes.
  mode('green');
  const other = path.join(tmp, 'other'); execFileSync('git', ['clone', '-q', remote, other]);
  git(other, 'config', 'user.name', 'O'); git(other, 'config', 'user.email', 'o@example.invalid');
  fs.writeFileSync(path.join(other, 'x.txt'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'other'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  const pr = await s.ship({ backlogItemKey: 'BUG-72' });
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.equal(pr.steps.find((x) => x.step === 'remote-rebase')?.ok, true, JSON.stringify(pr.steps));
  assert.equal(submits.length, 2);
});

test('validate-answer catches the preflight refusals seen in rehearsal set3 before READY', async (t) => {
  const { checkSubmit } = await import('../team-sdlc-pack/src/validate-answer.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-va2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ans = path.join(dir, 'answers', 'BUG-01'); fs.mkdirSync(path.join(ans, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ans, 'evidence', 'due_summary_before_fix.log'), 'x'); fs.writeFileSync(path.join(ans, 'evidence', 'mvs.log'), 'x');
  fs.writeFileSync(path.join(ans, 'submit.json'), JSON.stringify({ backlogId: 'BUG-01', status: 'DONE', evidenceFiles: ['evidence/mvs.log'], engineeringRecord: { analysis: 'answers/BUG-01/evidence: logs' } }));
  const p = checkSubmit(path.join(ans, 'submit.json'), null, { required: ['due_summary_before_fix.log'] });
  assert.ok(p.some((x) => /relative to answers\/BUG-01/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /REQUIRED_EVIDENCE_UNREFERENCED/.test(x)));
});
