import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { itemTestFiles, assertionFailure } from '../team-sdlc-pack/src/gate.mjs';
import { acquire, release, slotDirFor } from '../team-sdlc-pack/src/build-lock.mjs';

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
  s.items.get('BUG-91').type = 'PI'; s.items.get('BUG-91').local.answerOnly = true;
  mode('green');
  const g = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(g.verdict, 'GREEN'); assert.equal(g.scope, 'item'); assert.equal(g.codeChanged, true); assert.deepEqual(g.files, ['tests/bug-91.test.ts']);
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

test('an answer-first PI uses schema gate when its integrated diff changes only answers', async t => {
  const { s, mode } = fixture(t); mode('green');
  const base = git(s.checkoutRoot, 'rev-parse', 'HEAD');
  const dir = path.join(s.matchRoot, 'answers', 'PI-01'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'submit.json'), '{"backlogId":"PI-01","status":"DONE"}\n');
  git(s.checkoutRoot, 'add', '-A'); git(s.checkoutRoot, 'commit', '-qm', 'PI-01: answer');
  s.items.set('PI-01', { id: 'PI-01', type: 'PI', description: 'Then fix the fault in the application source.', local: { startedAt: Date.now(), answerOnly: true,
    worktree: { mainBefore: base, integrationBase: base, integratedSha: git(s.checkoutRoot, 'rev-parse', 'HEAD') } } });
  const out = await s.gate({ backlogItemKey: 'PI-01' });
  assert.equal(out.verdict, 'GREEN'); assert.equal(out.scope, 'schema'); assert.equal(out.codeChanged, false);
  assert.match(out.note, /only the answer contract/);
});

test('integration gate waits briefly for heavy capacity, then runs anyway so shipping never stalls', async t => {
  const { s, mode } = fixture(t); mode('green');
  s.adapter.parallel.maxHeavySteps = 1; s.adapter.parallel.heavyStepWaitMs = 100;
  const held = await acquire(slotDirFor(s.checkoutRoot), 1); t.after(() => release(held));
  const r = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(r.verdict, 'GREEN'); assert.equal(s.state.gateWithoutSlot, 1);
  assert.equal(fs.existsSync(path.join(s.checkoutRoot, '.mtm-notes', 'gate-BUG-91-tests.log')), true);
  release(held);
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).verdict, 'GREEN');
  assert.equal(s.state.gateWithoutSlot, 1, 'a free slot is used when there is one');
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

test('a READY PI interrupts a running ordinary gate, but not an imminent deadline gate', async t => {
  const { s, mode } = fixture(t);
  s.items.get('BUG-91').deadlineAt = null; mode('hang');
  let running = s.gate({ backlogItemKey: 'BUG-91', budgetSec: 30 });
  while (!s.activeGate) await new Promise(resolve => setImmediate(resolve));
  s.items.set('PI-03', { id: 'PI-03', type: 'PI', local: { ready: true } });
  s.phase = 'IDLE';
  await s.ship({ backlogItemKey: 'PI-03' });
  let out = await running;
  assert.equal(out.verdict, 'INTERRUPTED');
  assert.match(out.next, /higher-priority READY item/);

  s.items.get('BUG-91').deadlineAt = Date.now() + 2 * 60000;
  running = s.gate({ backlogItemKey: 'BUG-91', budgetSec: 1 });
  while (!s.activeGate) await new Promise(resolve => setImmediate(resolve));
  await s.ship({ backlogItemKey: 'PI-03' });
  out = await running;
  assert.notEqual(out.verdict, 'INTERRUPTED', 'a gate inside its own three-minute deadline is kept ahead of PI');
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
  s.items.get('BUG-71').local.answerOnly = true; // starting hint must not suppress reporting for a code diff
  mode('green');
  const r = await s.ship({ backlogItemKey: 'BUG-71' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.gate.scope, 'item');
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

test('monorepo gate: a root vitest config with projects runs each affected project from its own folder', async (t) => {
  const { projectTestSpecs, runProjects } = await import('../team-sdlc-pack/src/gate.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('vitest.config.ts', "export default { test: { projects: ['packages/*/vitest.config.ts'] } };");
  w('packages/core/vitest.config.ts', 'export default {};');
  w('packages/core/package.json', JSON.stringify({ scripts: { 'test:web': 'ENV=web vitest --run -c vitest.web.config.ts', 'test:node': 'ENV=node vitest --run' } }));
  w('packages/core/src/a.ts', 'export const a = 1;'); w('packages/core/src/a.test.ts', '');
  w('packages/sync/vitest.config.ts', 'export default {};'); w('packages/sync/src/b.ts', '');
  w('packages/web/src/c.tsx', '');
  // a fake vitest binary that prints its cwd, args and ENV
  w('node_modules/vitest/vitest.mjs', "console.log('RAN', process.cwd().split('/').pop(), process.argv.slice(2).join(' '), process.env.ENV || '-'); console.log(' Test Files  1 passed (1)'); console.log('      Tests  3 passed (3)');");
  const full = projectTestSpecs(root, { codeFiles: ['app/packages/core/src/a.ts', 'app/packages/web/src/c.tsx'], appRel: 'app', baselineText: ` RUN  v5.0.4 ${path.join(root, 'packages', 'sync')}\n` });
  assert.deepEqual(full.map(s => [path.basename(s.cwd), s.env, s.spec.args.slice(1)]), [['core', { ENV: 'node' }, ['run']], ['sync', {}, ['run']]], 'changed project + baseline project; web has no project');
  const item = projectTestSpecs(root, { files: ['packages/core/src/a.test.ts'] });
  assert.deepEqual(item.map(s => [path.basename(s.cwd), s.spec.args.slice(1)]), [['core', ['run', 'src/a.test.ts']]]);
  const log = path.join(root, 'gate.log');
  const r = await runProjects(full, { env: { ...process.env, ENV: '' }, timeoutMs: 20000, logFile: log });
  assert.equal(r.exit, 0); assert.match(r.text, /RAN core run node/); assert.match(r.text, /RAN sync run -/);
  assert.ok(fs.existsSync(log) && !fs.existsSync(`${log}.0`));
  fs.writeFileSync(path.join(root, 'vitest.config.ts'), 'export default { test: {} };');
  assert.equal(projectTestSpecs(root, { codeFiles: ['packages/core/src/a.ts'] }), null, 'not a projects monorepo: keep the single root command');
});

test('long suites: the main gate runs the item tests; PI always item scope; repo-wide type errors in other files are not the item\'s', async t => {
  const { solutionTsconfig, withRepoYarn } = await import('../team-sdlc-pack/src/gate.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsref-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{\n  // comment\n  "references": [{ "path": "./packages/a" }],\n  "include": ["bin/*.mts"]\n}');
  assert.equal(solutionTsconfig(dir), true);
  fs.mkdirSync(path.join(dir, '.yarn', 'releases'), { recursive: true }); fs.writeFileSync(path.join(dir, '.yarn', 'releases', 'yarn-9.cjs'), '');
  fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-9.cjs\n');
  assert.match(withRepoYarn(dir, 'yarn typecheck'), /yarn-9\.cjs" typecheck$/);
  assert.equal(withRepoYarn(dir, 'pnpm test'), 'pnpm test');
});

test('gate scope: a baseline suite over 60 s runs the item tests on main; PI always item scope; otherwise full', async t => {
  const { s, mode } = fixture(t); mode('green');
  const it = s.items.get('BUG-91'); it.deadlineAt = null;
  const notes = path.join(s.checkoutRoot, '.mtm-notes'); fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'test.log'), ' Test Files  88 passed\n      Tests  1385 passed\n   Duration  20.5s (setup 80%)\n');
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full', 'short suite, no deadline: full');
  it.type = 'PI';
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'item', 'PI: item scope');
  it.type = 'BUG';
  fs.writeFileSync(path.join(notes, 'test.log'), ' Test Files  88 passed\n      Tests  1385 passed (1385)\n   Duration  104.07s (setup 83%)\n');
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full', 'long suite but no proof the worker ran it: full suite here');
  const ev = path.join(s.matchRoot, 'answers', 'BUG-91', 'evidence'); fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'full-suite.log'), ' Test Files  89 passed\n      Tests  1390 passed (1390)\n');
  const g = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(g.scope, 'item', 'worker full-suite run on the same base stands'); assert.equal(it.local.gate.workerFullSuite.ok, true);
  fs.writeFileSync(path.join(ev, 'full-suite.log'), ' Test Files  1 failed | 88 passed\n FAIL  src/x.test.ts > new break\n      Tests  1 failed | 1389 passed (1390)\n');
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full', 'a new failure in the worker run is not proof');
  fs.writeFileSync(path.join(ev, 'full-suite.log'), '      Tests  12 passed (12)\n');
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full', 'a partial run is not proof');
  fs.writeFileSync(path.join(ev, 'full-suite.log'), '      Tests  1390 passed (1390)\n');
  // main gained other code since the worker's base: its run no longer stands
  const fx = path.join(s.appPath, 'b.ts'); fs.writeFileSync(fx, 'export const b = 1;\n');
  git(s.checkoutRoot, 'add', '-A'); git(s.checkoutRoot, 'commit', '-qm', 'other item');
  const wt = it.local.worktree; wt.mainBefore = git(s.checkoutRoot, 'rev-parse', 'HEAD');
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full'); assert.match(it.local.gate.workerFullSuite.reason, /main gained other code/);
  delete wt.mainBefore; s.match.endsAt = Date.now() + 2.5 * 60000;
  const late = await s.gate({ backlogItemKey: 'BUG-91' });
  assert.equal(late.scope, 'item', 'no time for a full run: item tests rather than none ' + JSON.stringify({ v: late.verdict, e: late.error, n: late.next }).slice(0, 300));
});

test('a worker full-suite log older than its last code edit is not proof', async t => {
  const { s, mode } = fixture(t); mode('green');
  const it = s.items.get('BUG-91'); it.deadlineAt = null;
  const notes = path.join(s.checkoutRoot, '.mtm-notes'); fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'test.log'), '      Tests  1385 passed (1385)\n   Duration  104.07s\n');
  // the worker's worktree: the evidence log was written before the last code edit
  const wtRoot = s.checkoutRoot; const wtMatch = s.matchRoot;
  Object.assign(it.local.worktree, { worktreeRoot: wtRoot, matchRoot: wtMatch });
  const ev = path.join(wtMatch, 'answers', 'BUG-91', 'evidence'); fs.mkdirSync(ev, { recursive: true });
  const log = path.join(ev, 'baseline-suite.log'); fs.writeFileSync(log, '      Tests  1390 passed (1390)\n');
  const old = new Date(Date.now() - 60000); fs.utimesSync(log, old, old);
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'full');
  fs.utimesSync(log, new Date(), new Date());
  assert.equal((await s.gate({ backlogItemKey: 'BUG-91' })).scope, 'item');
});

test('0OD2WHNM: a long ship goes to the background; an urgent PI interrupts it and the interrupted item ships again', async () => {
  const s = new RuntimeSession(); s.phase = 'IDLE'; s.match.endsAt = Date.now() + 30 * 60000;
  s.items.set('TASK-08', { id: 'TASK-08', type: 'TASK', local: {} });
  s.items.set('PI-02', { id: 'PI-02', type: 'PI', deadlineAt: Date.now() + 2 * 60000, local: {} });
  const order = []; const calls = {};
  s.withAutoDispatch = async r => r;
  s.shipOne = async ({ backlogItemKey: id }) => {
    calls[id] = (calls[id] || 0) + 1; order.push(id);
    if (id === 'TASK-08' && calls[id] === 1) {
      const controller = new AbortController(); s.activeGate = { id, controller };
      await new Promise(done => controller.signal.addEventListener('abort', done));
      s.activeGate = null;
      return { ok: false, stage: 'gate', verdict: 'INTERRUPTED', next: 'rerun' };
    }
    return { ok: true, stage: 'submitted', next: 'done' };
  };
  const first = await s.ship({ backlogItemKey: 'TASK-08', waitMs: 50 });
  assert.equal(first.background, true, 'the orchestrator is not blocked by a long gate');
  assert.equal((await s.ship({ backlogItemKey: 'TASK-08', waitMs: 50 })).stage, 'shipping', 'no second queue entry for the same item');
  const pi = await s.ship({ backlogItemKey: 'PI-02', waitMs: 5000 });
  assert.equal(pi.ok, true);
  for (let i = 0; i < 200 && !s.pendingEvents.some(e => e.kind === 'SHIP_RESULT' && e.id === 'TASK-08'); i += 1) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(order, ['TASK-08', 'PI-02', 'TASK-08']);
  const ev = s.pendingEvents.find(e => e.kind === 'SHIP_RESULT' && e.id === 'TASK-08');
  assert.equal(ev.result.ok, true);
  assert.ok(!s.pendingEvents.some(e => e.kind === 'SHIP_RESULT' && /INTERRUPTED/.test(e.text)), 'an interruption is re-queued, not reported');
});
