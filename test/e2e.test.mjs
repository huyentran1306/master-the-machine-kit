// Full loop against the mock Game Master: doctor, recon, status, start, every submit guard,
// evidence tied to the committed code, fill, grading (PASSED and FAILED), park, the PI wave with
// its alert, resume info, report, and a new match archiving the old state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MTM = path.join(KIT, 'tool', 'mtm.mjs');
const env0 = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && k !== 'NODE_TEST_CONTEXT'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir; let ws; let server; let env;

function sh(cwd, cmd, argv) {
  return execFileSync(cmd, argv, { cwd, env: env0, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitc = (argv) => sh(ws, 'git', argv);

function mtm(...argv) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [MTM, ...argv], { cwd: ws, env });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

function edit(file, from, to) {
  const p = path.join(ws, file);
  const s = fs.readFileSync(p, 'utf8');
  assert.ok(s.includes(from), `${file} contains ${from}`);
  fs.writeFileSync(p, s.replace(from, to));
}

async function graderLog() {
  const res = await fetch(`${env.MTM_BASE_URL}/admin/state`, { method: 'POST' });
  return JSON.stringify((await res.json()).log);
}

async function expectResult(id, re, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await mtm('status');
    const line = r.out.split('\n').find((l) => l.startsWith(`${id} `)) || '';
    if (/PASSED|FAILED/.test(line)) {
      assert.match(line, re, `grader log: ${await graderLog()}`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`${id} not graded in time`);
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-'));
  sh(KIT, process.execPath, [path.join(KIT, 'mock', 'setup-rehearsal.mjs'), path.join(dir, 'r')]);
  ws = path.join(dir, 'r', 'workspace');
  // time-scale 30: one match minute per 2 real seconds, so PI-01 (minute 12) shows up after ~24 s
  // and the simulated rivals finish it 14 s and 22 s later.
  server = spawn(process.execPath, [path.join(KIT, 'mock', 'gm-mock-server.mjs'), '--remote', path.join(dir, 'r', 'remote.git'),
    '--port', '0', '--time-scale', '30', '--token', 's3cret', '--autostart'], { env: env0 });
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => { const m = String(b).match(/127\.0\.0\.1:(\d+)/); if (m) resolve(m[1]); });
    server.on('exit', () => reject(new Error('mock server exited')));
  });
  env = { ...env0, CODEX_HOME: path.join(dir, 'codex-home'), MTM_BASE_URL: `http://127.0.0.1:${port}`, MTM_MATCH_ID: 'demo', MTM_TOKEN: 's3cret', MTM_REPO: ws };
});

test.after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a full match loop with every guard', { timeout: 150000 }, async () => {
  let r = await mtm('watch', '--bogus', '1');
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown flag --bogus/);
  r = await mtm('submit', 'BUG-01', '--no-evidence');
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown flag --no-evidence/, 'competition build has no evidence bypass');
  r = await mtm('evidence', 'BUG-01', '--timeout-min', 'abc', '--', 'npm', 'test');
  assert.match(r.out, /must be a positive number/);

  r = await mtm('doctor');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /git push rights on origin\/main: OK/);
  assert.match(r.out, /modules: \. \(Node/);

  r = await mtm('recon');
  assert.match(r.out, /- test: npm test/);
  assert.equal(sh(ws, 'git', ['status', '--porcelain']), '', '.mtm/ stays out of git status');

  r = await mtm('status');
  assert.match(r.out, /NEW BUG-01 BUG 200pts/, 'status shows events instead of swallowing them');
  assert.match(r.out, /BUG-01\s+BUG\s+OPEN\s+200/);
  assert.match(r.out, /NEXT: BUG-01/);
  assert.doesNotMatch(r.out, /PI-01/);

  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /not started/);
  r = await mtm('start', 'PI-01');
  assert.equal(r.code, 1, 'cannot start an unrevealed item');

  r = await mtm('start', 'BUG-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2027-07-01T00:00:00Z returns 410/);
  assert.match(r.out, /Playbook: skill mtm-bug/);
  assert.match(r.out, /# Task Contract BUG-01 \| BUG \| 200 pts/);
  const cf = path.join(ws, '.mtm', 'items', 'BUG-01', 'contract.md');
  let ct = fs.readFileSync(cf, 'utf8');
  assert.match(ct, / {2}- MVS 1: \S/, 'MVS lines are prefilled');
  ct = ct.replace(/- outcome: <[^>]+>/, '- outcome: vouchers are valid through their last day (UTC)')
    .replace(/- scope\.allowed: <[^>]+>/, '- scope.allowed: src/vouchers.js');
  fs.writeFileSync(cf, ct);

  edit('src/vouchers.js', 'return now >= expiry;', 'return now.getTime() >= expiry.getTime() + 24 * 60 * 60 * 1000;');
  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /uncommitted changes/);
  gitc(['commit', '-qam', 'BUG-01: voucher valid through its last day']);
  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /is not on origin\/main \(the graded branch\)/);
  gitc(['push', '-q']);
  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /needs evidence/);

  r = await mtm('evidence', 'BUG-01', '--', 'npm', 'test');
  assert.equal(r.code, 0, r.out);
  // A change after the passing run must be tested again before it can be submitted.
  edit('README.md', 'Run tests:', 'Run the tests:');
  gitc(['commit', '-qam', 'BUG-01: wording']);
  gitc(['push', '-q']);
  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /differs from the code your last passing evidence run tested/);
  // Validate: the review checks the item's diff against its contract.
  r = await mtm('review', 'BUG-01');
  assert.match(r.out, /REVIEW PACK BUG-01: \.mtm\/items\/BUG-01\/review-pack\.md \| 2 changed files \(0 tests\)/);
  assert.match(r.out, /!! OUT OF SCOPE BUG-01: README\.md\./);
  assert.match(r.out, /!! NO TEST CHANGED BUG-01/);
  assert.doesNotMatch(r.out, /CONTRACT OPEN/);
  assert.match(r.out, /read-only reviewer/);
  const pack = fs.readFileSync(path.join(ws, '.mtm', 'items', 'BUG-01', 'review-pack.md'), 'utf8');
  assert.match(pack, /builder is not the reviewer/);
  assert.match(pack, /- README\.md \[OUT OF scope\.allowed\]/);
  assert.match(pack, /\+\s*return now\.getTime\(\) >= expiry\.getTime\(\)/);
  r = await mtm('evidence', 'BUG-01', '--', 'npm', 'test');
  assert.equal(r.code, 0, r.out);

  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /fill these fields: summary, rootCause, evidence/);
  r = await mtm('fill', 'BUG-01', 'summary=expiry is the end of expiresOn (UTC)', 'rootCause=expiry compared at 00:00', 'evidence=MVS 1-2 pass, npm test 7/7');
  assert.match(r.out, /all fields filled/);
  r = await mtm('submit', 'BUG-01', '--dry-run');
  assert.match(r.out, /"gitRevision": "[0-9a-f]{40}"/);
  r = await mtm('submit', 'BUG-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SUBMITTED BUG-01/);
  r = await mtm('submit', 'BUG-01');
  assert.match(r.out, /already submitted/);
  await expectResult('BUG-01', /PASSED 200/);

  // A submission that does not do the work is graded FAILED with 0 points (TASK needs no evidence).
  r = await mtm('start', 'TASK-01');
  assert.equal(r.code, 0, r.out);
  await mtm('fill', 'TASK-01', 'summary=nothing', 'evidence=none');
  r = await mtm('submit', 'TASK-01');
  assert.equal(r.code, 0, r.out);
  await expectResult('TASK-01', /FAILED 0/);

  // Park: a started item goes to the end of the queue and is no longer NEXT.
  let seenCr = false;
  for (let i = 0; i < 20 && !seenCr; i++) { seenCr = /CR-01/.test((await mtm('status')).out); if (!seenCr) await sleep(500); }
  assert.ok(seenCr, 'CR-01 revealed at match minute 5');
  r = await mtm('start', 'CR-01');
  assert.equal(r.code, 0, r.out);
  r = await mtm('park', 'CR-01', '--reason', 'testing park');
  assert.match(r.out, /PARKED CR-01/);
  r = await mtm('status');
  assert.match(r.out, /CR-01\s+CR\s+OPEN\s+300\s+\S+\s+parked/);
  assert.match(r.out, /NEXT: CR-01 \(parked: testing park/);
  // Back from park: no second Start working, and CR-01 is the current item again.
  r = await mtm('start', 'CR-01');
  assert.match(r.out, /RESUMED CR-01: Start working was sent .* not sent again/);
  assert.match(r.out, /back from park: a fresh time budget starts now/);

  // PI wave: watch wakes up on it, prints the alert and puts it first.
  r = await mtm('watch', '--timeout', '30s', '--interval', '1');
  while (!/NEW PI-01/.test(r.out)) {
    assert.equal(r.code, 0, r.out);
    r = await mtm('watch', '--timeout', '30s', '--interval', '1');
  }
  assert.match(r.out, /!! PI PI-01 revealed/);
  assert.match(r.out, /NEXT: PI-01/);

  r = await mtm('start', 'PI-01');
  assert.equal(r.code, 0, r.out);
  edit('src/redeem.js', 'voucher.tags.includes', 'voucher.tags?.includes');

  // A restarted session (e.g. after switching Codex accounts at the token cap) sees where it was.
  r = await mtm('doctor');
  assert.match(r.out, /RESUMING match demo: .*current PI-01 .*started, not submitted \(newest first\): PI-01, CR-01/);
  assert.match(r.out, /uncommitted files: 1/);

  gitc(['commit', '-qam', 'PI-01: vouchers without tags crashed redeem']);
  gitc(['push', '-q']);
  await mtm('fill', 'PI-01', 'summary=optional chaining on tags', 'rootCause=VIP release assumed every voucher has tags',
    'impact=all non-VIP vouchers returned 500', 'evidence=repro + npm test');
  r = await mtm('submit', 'PI-01', '--dry-run');
  assert.equal(r.code, 0, `PI has no mandatory evidence gate in the published rules: ${r.out}`);
  r = await mtm('evidence', 'PI-01', '--', 'npm', 'test');
  assert.equal(r.code, 0, r.out);
  r = await mtm('submit', 'PI-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CURRENT is CR-01 again \(it was interrupted\)/, 'the item the PI interrupted becomes current again');
  await expectResult('PI-01', /PASSED 400/);

  r = await mtm('report');
  assert.match(r.out, /BUG-01\s+BUG\s+200\s+\d+\.\dm\s+PASSED 200/);
  assert.match(r.out, /per type: .*PI: median/);
  const journal = fs.readFileSync(path.join(ws, '.mtm', 'journal.md'), 'utf8');
  assert.match(journal, /submit BUG-01/);
  assert.match(journal, /park CR-01: testing park/);
  assert.match(journal, /submit PI-01/);
  assert.match(journal, /review BUG-01: 2 files/);

  // Observe: the retro compares real minutes with the estimates and lists what to learn from.
  r = await mtm('retro');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# Retro, match demo/);
  assert.match(r.out, /\| BUG-01 \| BUG \| 200 \| PASSED 200 \| \d+\.\d \| \d+ \| 2\/2 \| yes \|/);
  assert.match(r.out, /TASK-01 FAILED: review did NOT run/);
  assert.ok(fs.existsSync(path.join(ws, '.mtm', 'retro.md')));

  // The next match on the same clone starts clean: the old state is archived, not reused.
  const envNext = { ...env };
  delete envNext.MTM_MATCH_ID;
  r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [MTM, 'init', '--match', 'round-2'], { cwd: ws, env: envNext });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.match(r.out, /NEW MATCH round-2: state of match demo moved to \.mtm\/archive\/demo-/);
  assert.equal(fs.existsSync(path.join(ws, '.mtm', 'ledger.json')), false);
  const archived = fs.readdirSync(path.join(ws, '.mtm', 'archive'));
  assert.ok(fs.existsSync(path.join(ws, '.mtm', 'archive', archived[0], 'ledger.json')));
});
