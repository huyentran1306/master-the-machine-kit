import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from '../team-sdlc-pack/src/schema.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import * as G from '../team-sdlc-pack/src/git.mjs';
import { install } from '../team-sdlc-pack/scripts/install.mjs';
import { check } from '../team-sdlc-pack/scripts/check-distribution.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/organizer-schemas/', import.meta.url));
const pack = fileURLToPath(new URL('../team-sdlc-pack/', import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function write(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-windows-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function git(cwd, ...args) {
  const r = await G.git(cwd, args);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function completed(id) {
  const answer = read(path.join(fixtures, `${id}-submit.json`));
  answer.status = 'DONE';
  answer.evidenceFiles = ['evidence/test.log'];
  if ('position' in answer) answer.position = '123';
  for (const row of answer.testResults || []) {
    row.result = 'PASS'; row.evidence = ['evidence/test.log'];
  }
  if (answer.engineeringRecord) Object.assign(answer.engineeringRecord, {
    analysis: 'Fixed the reported defect.', changes: ['src/app.ts'], tests: ['pnpm test'],
    risks: [], aiCollaboration: 'Orchestrator implemented and verified.'
  });
  return answer;
}

for (const file of fs.readdirSync(fixtures).filter(f => f.endsWith('.schema.json'))) {
  const id = file.replace('-submit.schema.json', '');
  const schema = read(path.join(fixtures, file));
  test(`${id}: completed organizer template validates; invalid fields give exact errors`, () => {
    const answer = completed(id);
    assert.deepEqual(validate(schema, answer), []);
    const mutations = [
      [a => { a.status = 'SUBMITTED'; }, '$.status: must be one of DONE|PARTIAL|BLOCKED'],
      [a => { delete a.backlogId; }, '$.backlogId: required'],
      [a => { a.extra = true; }, '$.extra: not allowed'],
      [a => { a.evidenceFiles.push(a.evidenceFiles[0]); }, '$.evidenceFiles: items must be unique'],
      [a => { a.evidenceFiles = ['../test.log']; }, '$.evidenceFiles[0]: does not match ^evidence/[A-Za-z0-9][A-Za-z0-9._-]*$'],
    ];
    if (answer.testResults) mutations.push(
      [a => { a.testResults[0].id = 'renamed'; }, `$.testResults[0].id: must be "${id}-TC-01"`],
      [a => { a.testResults[0].evidence = []; }, '$.testResults[0].evidence: fewer than 1 items'],
      [a => { a.testResults.push(a.testResults[0]); }, `$.testResults[${answer.testResults.length}]: not allowed`],
    );
    for (const [mutate, expected] of mutations) {
      const copy = structuredClone(answer); mutate(copy);
      assert.deepEqual(validate(schema, copy), [expected]);
    }
    if (answer.testResults) {
      answer.testResults[0].result = 'NOT_RUN'; answer.testResults[0].evidence = [];
      assert.deepEqual(validate(schema, answer), [], 'conditional evidence applies only to PASS');
    }
  });

  test(`${id}: submit and dryRun refuse committed schema violations, even with a valid working copy`, async t => {
    const root = temp(t);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Fixture');
    await git(root, 'config', 'user.email', 'fixture@example.invalid');
    const answerPath = path.join(root, 'assigned', 'answers', id, 'submit.json');
    write(answerPath, completed(id));
    write(path.join(path.dirname(answerPath), 'evidence', 'test.log'), 'pnpm test\nTests: 3 passed, 3 total\n');
    await git(root, 'add', 'assigned'); await git(root, 'commit', '-m', 'baseline');
    const baseline = await G.revParse(root, 'HEAD');
    const s = new RuntimeSession({ teamWorkspace: root });
    s.checkoutRoot = root; s.matchRoot = path.join(root, 'assigned');
    s.repository = { branch: 'main', folder: 'assigned' };
    s.environmentRevision = baseline; s.phase = 'GAME'; s.bearer = 'fake-bearer';
    s.match.uuid = '11111111-2222-4333-8444-555555555555'; s.match.status = 'IN_PROGRESS';
    s.items.set(id, { id, type: id.split('-')[0], local: { startedAt: Date.now() } });
    s.lastTests = { [id]: { status: 'PASSED', executed: 3, passed: 3, failed: 0 } };
    // Same persisted material shape written by start_work; a restart reads it from disk.
    write(path.join(s.stateDir, 'items', id, 'start.json'), { files: { [`challenge/${file}`]: JSON.stringify(schema) } });
    await git(root, 'update-ref', 'refs/remotes/origin/main', baseline);
    assert.equal((await s.submit_work({ backlogItemKey: id, dryRun: true })).ok, true);
    const mutations = [a => { a.status = 'WRONG'; }, a => { delete a.backlogId; }, a => { a.extra = 1; }];
    if (completed(id).testResults) mutations.push(a => { a.testResults[0].id = 'renamed'; });
    for (const mutate of mutations) {
      const answer = completed(id); mutate(answer); write(answerPath, answer);
      await git(root, 'add', 'assigned'); await git(root, 'commit', '-m', 'invalid answer');
      await git(root, 'update-ref', 'refs/remotes/origin/main', await G.revParse(root, 'HEAD'));
      write(answerPath, completed(id));
      for (const dryRun of [true, false]) {
        const result = await s.submit_work({ backlogItemKey: id, dryRun });
        assert.equal(result.refused, true);
        assert.deepEqual(result.errors, validate(schema, answer).map(e => `challenge/${file}: ${e}`));
        assert.deepEqual(s.state.submissions, {}, 'no request queued');
      }
    }
    // Legacy matches without delivered schemas retain existing checks.
    write(path.join(s.stateDir, 'items', id, 'start.json'), { files: {} });
    assert.equal((await s.submit_work({ backlogItemKey: id, dryRun: true })).ok, true);
  });
}

test('sparse blob-filtered clone supports folder trees, ancestry, committed reads and push', async t => {
  const root = temp(t);
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  await git(root, 'init', '--bare', origin);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  write(path.join(seed, 'assigned', 'src', 'app.txt'), 'current');
  write(path.join(seed, 'previous', 'solution.txt'), 'other match');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'seed matches');
  const baseline = await G.revParse(seed, 'HEAD');
  await git(seed, 'remote', 'add', 'origin', origin); await git(seed, 'push', 'origin', 'main');
  await git(origin, 'config', 'uploadpack.allowFilter', 'true');
  await git(root, 'clone', '--filter=blob:none', '--sparse', '--branch', 'main', '--single-branch', pathToFileURL(origin).href, checkout);
  await git(checkout, 'sparse-checkout', 'set', 'assigned');
  assert.equal(fs.existsSync(path.join(checkout, 'previous')), false);
  assert.equal(await git(checkout, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
  assert.match(await git(checkout, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'assigned/'), /assigned\/src\/app.txt/);
  assert.equal(await G.fileAt(checkout, 'HEAD', 'assigned/src/app.txt'), 'current');
  await git(checkout, 'config', 'user.name', 'Fixture');
  await git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  write(path.join(checkout, 'assigned', 'src', 'app.txt'), 'fixed');
  await git(checkout, 'add', 'assigned'); await git(checkout, 'commit', '-m', 'fix assigned');
  const sha = await G.revParse(checkout, 'HEAD');
  assert.equal(await G.isAncestor(checkout, baseline, sha), true);
  await git(checkout, 'push', 'origin', 'main');
  assert.equal((await G.pushedState(checkout, sha, 'main')).pushed, true);
});

test('fresh temporary installation is READY with 2.7.4 identity and top-level compaction setting', async t => {
  const workspace = path.join(temp(t), 'fresh workspace');
  await install({ teamWorkspace: workspace });
  const result = await check({ teamWorkspace: workspace, source: pack });
  assert.equal(result.ready, true, result.lines.join('\n'));
  const infoPath = path.join(workspace, '.mtm', 'team-pack-info.json');
  assert.equal(read(infoPath).teamName, '[FHM] Bá Khí');
  assert.equal(read(infoPath).version, '2.7.4');
  for (const file of ['package.json', 'team-runtime.json', 'team-pack-info.json']) assert.equal(read(path.join(pack, file)).version, '2.7.4');
  assert.notEqual(fs.readFileSync(infoPath)[0], 0xef, 'no UTF-8 BOM');
  const configPath = path.join(workspace, '.codex', 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /^model_auto_compact_token_limit = 120000\s+\[mcp_servers/);
  write(configPath, config.replace('120000', '99999'));
  assert.equal((await check({ teamWorkspace: workspace, source: pack, mcp: false })).ready, false);
});
