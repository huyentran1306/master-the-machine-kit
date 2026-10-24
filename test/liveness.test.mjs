// Paths that used to stop or stall the agent: a DEGRADED page that made watch return at once,
// an unreachable Game Master after the match end, doctor blocking a restarted session,
// a resumed item re-sending Start working, and fill unable to write lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MTM = path.join(KIT, 'tool', 'mtm.mjs');
const env0 = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && k !== 'NODE_TEST_CONTEXT'));

let dir;
let repo;
let server;
let port;
let page = { type: 'html', body: '<html><body><h1>Match lv</h1><p>BUG-01 Fix expiry</p></body></html>' };
let starts = 0;

const git = (...a) => execFileSync('git', a, { cwd: repo, env: env0, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function mtm(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [MTM, ...args], { cwd: repo, env: { ...env0, CODEX_HOME: path.join(dir, 'codex-home'), MTM_REPO: repo, MTM_MATCH_ID: 'lv', MTM_BASE_URL: `http://127.0.0.1:${port}`, ...extraEnv } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-live-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  server = http.createServer((req, res) => {
    if (req.method === 'POST') { starts++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"template":{"summary":""}}'); return; }
    if (page.type === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page.body); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.after(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DEGRADED: watch really waits, and a finished page ends the match', async () => {
  let r = await mtm(['poll']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /MATCH PAGE NOT JSON/);
  r = await mtm(['watch', '--timeout', '3s', '--interval', '1']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ms >= 2500, `watch returned after ${r.ms} ms instead of waiting`);
  assert.match(r.out, /no change \(DEGRADED/);
  page.body = '<html><body><h1>Match lv</h1><p>The match is finished. Results soon.</p></body></html>';
  r = await mtm(['watch', '--timeout', '10s', '--interval', '1']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /MATCH FINISHED \(seen on the page\)/);
});

test('fill writes list items, JSON values and text from a file', async () => {
  const d = path.join(repo, '.mtm', 'items', 'TASK-03');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'template.json'), JSON.stringify({ summary: '', checks: [{ name: '', result: '' }], files: [] }));
  fs.writeFileSync(path.join(repo, 'ev.txt'), 'ran "npm test": `12 passed` for $price\n');
  const r = await mtm(['fill', 'TASK-03', 'summary=@ev.txt', 'checks[0].name=MVS 1', 'checks.0.result=PASS', 'files:=["src/a.js"]']);
  assert.match(r.out, /all fields filled/, r.out);
  const sub = JSON.parse(fs.readFileSync(path.join(d, 'submission.json'), 'utf8'));
  assert.equal(sub.summary, 'ran "npm test": `12 passed` for $price');
  assert.deepEqual(sub.checks, [{ name: 'MVS 1', result: 'PASS' }]);
  assert.deepEqual(sub.files, ['src/a.js']);
});

test('restart mid-match: doctor never blocks, start does not send Start working again, the stash is named', async () => {
  const m = path.join(repo, '.mtm');
  fs.writeFileSync(path.join(m, 'ledger.json'), JSON.stringify({ 'BUG-01': { startedAt: Date.now() - 6 * 60000, type: 'BUG' } }));
  const match = JSON.parse(fs.readFileSync(path.join(m, 'match.json'), 'utf8'));
  fs.writeFileSync(path.join(m, 'match.json'), JSON.stringify({ ...match, current: 'BUG-01', currentSince: Date.now() }));
  fs.mkdirSync(path.join(m, 'items', 'BUG-01'), { recursive: true });
  fs.writeFileSync(path.join(m, 'items', 'BUG-01', 'brief.md'), '# BUG-01 BUG | 200 pts\n\nFix expiry');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'work in progress\n');
  git('stash', 'push', '-u', '-m', 'WIP BUG-01');

  // Game Master down and no origin: before 0.2.1 this was PROBLEM + BLOCKED.
  let r = await mtm(['doctor'], { MTM_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESUMING match lv/);
  assert.match(r.out, /doctor: RESUMING with \d+ warnings: .* never reply BLOCKED mid-match/);
  assert.doesNotMatch(r.out, /^PROBLEM/m);

  const before = starts;
  r = await mtm(['start', 'BUG-01'], { MTM_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESUMED BUG-01: Start working was sent .* not sent again/);
  assert.match(r.out, /run git stash pop 'stash@\{0\}' now/);
  assert.equal(starts, before, 'no second Start working');
});

test('a single-dash flag is refused instead of being ignored (no accidental real submit)', async () => {
  const r = await mtm(['submit', 'BUG-01', '-dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown flag -dry-run: flags take two dashes/);
});

test('evidence runs inside a module folder with --cwd', async () => {
  fs.mkdirSync(path.join(repo, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'frontend', 'where.js'), 'process.stdout.write(process.cwd())');
  let r = await mtm(['evidence', 'BASELINE', '--cwd', 'frontend', '--', 'node', 'where.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /frontend/);
  r = await mtm(['evidence', 'BASELINE', '--cwd', '../outside', '--', 'node', 'where.js']);
  assert.equal(r.code, 1);
  assert.match(r.out, /not a folder inside the repo/);
});

test('Game Master unreachable after the match end: watch says the match is over', async () => {
  page = { type: 'json', body: { status: 'RUNNING', serverTime: new Date().toISOString(), endsAt: new Date(Date.now() - 2 * 60000).toISOString(), items: [] } };
  let r = await mtm(['poll']);
  assert.equal(r.code, 0, r.out);
  r = await mtm(['watch', '--timeout', '3s', '--interval', '1'], { MTM_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /MATCH FINISHED \(the match end time has passed/);
});
