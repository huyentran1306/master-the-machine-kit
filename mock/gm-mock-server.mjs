#!/usr/bin/env node
// Local stand-in for the Game Master Server, for rehearsals and tests only.
// It follows the published rules (waves, deadlines, start before submit, one submit,
// MVS only after start, PI ranked by finishing order) with the API shape in tool/gm.config.json.
//
// node gm-mock-server.mjs --remote <bare repo> [--scenario scenarios/demo/scenario.json]
//   [--port 4010] [--time-scale 1] [--token secret] [--autostart]
// Admin (mock only): POST /admin/start | /admin/pause | /admin/resume | /admin/reveal/<ID>
//   | /admin/edit/<ID> {title?, description?, maxPoints?} | /admin/state
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true;
  }
  return o;
}

const opt = args(process.argv.slice(2));
const scenarioFile = path.resolve(opt.scenario || path.join(HERE, 'scenarios', 'demo', 'scenario.json'));
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const scenarioDir = path.dirname(scenarioFile);
const remote = opt.remote ? path.resolve(opt.remote) : null;
const scale = Number(opt['time-scale'] || 1);
const port = Number(opt.port ?? 4010);
const token = opt.token || null;
const MIN = 60000;

// Child env without inherited GIT_CONFIG_* overrides (they can break bare-repo access) and without
// NODE_TEST_CONTEXT (set when this server itself runs under node --test; it hides the TAP summary).
const gitEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && k !== 'NODE_TEST_CONTEXT'));

const S = {
  status: 'WAITING',
  clockMs: 0,          // active match time, in match ms (scaled)
  lastTick: null,
  forced: new Set(),
  items: new Map(scenario.items.map((d) => [d.id, { def: d, revealClock: null, startedAt: null, submission: null }])),
  log: [],
};

function clock() {
  if (S.status === 'RUNNING') return S.clockMs + (Date.now() - S.lastTick) * scale;
  return S.clockMs;
}

function freeze() { S.clockMs = clock(); S.lastTick = Date.now(); }

// Every timestamp the mock reports (serverTime, revealedAt, deadlineAt, endsAt) is on a virtual
// clock that runs in match time, so --time-scale keeps "minutes left" in match minutes for the
// client. The clock stands still while WAITING or PAUSED, which is what deadlines do too.
const T0 = Date.now();
function wallFromClock(c) { return T0 + c; }
function serverNow() { return T0 + clock(); }

function tick() {
  if (S.status === 'RUNNING' && clock() >= scenario.durationMin * MIN) {
    freeze();
    S.clockMs = scenario.durationMin * MIN;
    S.status = 'FINISHED';
    S.log.push('match finished');
  }
  if (S.status === 'WAITING') return;
  const c = clock();
  for (const it of S.items.values()) {
    if (it.revealClock == null && (S.forced.has(it.def.id) || c >= it.def.revealAtMin * MIN)) {
      it.revealClock = S.forced.has(it.def.id) ? c : it.def.revealAtMin * MIN;
    }
  }
}

function deadlineClock(it) {
  return it.def.deadlineMin != null ? it.revealClock + it.def.deadlineMin * MIN : null;
}

function itemState(it) {
  const d = deadlineClock(it);
  if (S.status === 'FINISHED') return 'CLOSED';
  return d != null && clock() >= d ? 'CLOSED' : 'OPEN';
}

function totalScore() {
  let s = 0;
  for (const it of S.items.values()) if (it.submission?.score) s += it.submission.score;
  return s;
}

function publicItem(it) {
  const d = deadlineClock(it);
  return {
    id: it.def.id,
    type: it.def.type,
    title: it.def.title,
    description: it.def.description,
    state: itemState(it),
    maxPoints: it.def.maxPoints,
    revealedAt: new Date(wallFromClock(it.revealClock)).toISOString(),
    deadlineAt: d == null ? null : new Date(wallFromClock(d)).toISOString(),
    submission: it.submission
      ? { status: it.submission.status, result: it.submission.result, score: it.submission.score, detail: it.submission.detail ?? null }
      : null,
  };
}

function templateFor(def) {
  const t = { itemId: def.id, gitRevision: '', summary: '<what changed and why>' };
  if (def.type === 'BUG' || def.type === 'PI') t.rootCause = '<root cause>';
  if (def.type === 'PI') t.impact = '<who was affected and how>';
  t.evidence = '<how it was verified: MVS results, extra cases, test command and result>';
  return t;
}

function run(cmd, argv, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env: gitEnv });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 1, out: String(e) }); });
  });
}

async function grade(it, payload) {
  const sub = it.submission;
  const fail = (why) => { sub.result = 'FAILED'; sub.score = 0; sub.detail = why; S.log.push(`${it.def.id} FAILED: ${why}`); };
  const rev = payload.gitRevision;
  if (!/^[0-9a-f]{7,40}$/i.test(String(rev || ''))) return fail('missing gitRevision');
  if (['CR', 'BUG'].includes(it.def.type) && !String(payload.evidence || '').trim()) return fail('missing evidence');
  if (!remote) { sub.result = 'PASSED'; sub.score = it.def.maxPoints; return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-grade-'));
  try {
    let r = await run('git', ['clone', '--quiet', remote, dir], os.tmpdir());
    if (r.code !== 0) return fail(`clone failed: ${r.out.slice(0, 300)}`);
    r = await run('git', ['checkout', '--quiet', rev], dir);
    if (r.code !== 0) return fail(`revision ${rev} not found on the remote`);
    const hidden = path.join(scenarioDir, it.def.hidden);
    fs.mkdirSync(path.join(dir, '.grader'), { recursive: true });
    const target = path.join(dir, '.grader', path.basename(hidden));
    fs.copyFileSync(hidden, target);
    // Relative forward-slash path: node --test treats arguments as globs, where "\" is an escape.
    // The grader parses TAP counters. Never depend on Node's version-specific default reporter.
    r = await run(process.execPath, ['--test', '--test-reporter=tap', `.grader/${path.basename(target)}`], dir);
    sub.output = r.out.slice(-4000);
    const ran = Number((r.out.match(/^# tests (\d+)/m) || [])[1] || 0);
    if (r.code !== 0) return fail('hidden scenarios failed');
    if (ran === 0) return fail('grader ran no tests');
    sub.result = 'PASSED';
    if (it.def.type === 'PI') {
      const tookMin = (sub.submitClock - it.revealClock) / MIN;
      const rank = (it.def.rivalsPassAfterMin || []).filter((m) => m < tookMin).length;
      const factor = [1, 0.9, 0.75, 0.6][Math.min(rank, 3)];
      sub.score = Math.round(it.def.maxPoints * factor);
      sub.detail = `PI took ${tookMin.toFixed(1)} match-min, rank ${rank + 1}, x${factor}`;
    } else {
      sub.score = it.def.maxPoints;
    }
    S.log.push(`${it.def.id} PASSED ${sub.score}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  tick();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p.startsWith('/admin/')) {
    const [, , action, id] = p.split('/');
    // The browser issues GET requests. State-changing admin routes are deliberately
    // POST-only so opening a copied URL never starts or alters a rehearsal.
    if (action !== 'state' && req.method !== 'POST') {
      return send(res, 405, { message: 'admin state changes require POST' });
    }
    if (action === 'start' && S.status === 'WAITING') { S.status = 'RUNNING'; S.lastTick = Date.now(); }
    else if (action === 'pause' && S.status === 'RUNNING') { freeze(); S.status = 'PAUSED'; }
    else if (action === 'resume' && S.status === 'PAUSED') { S.status = 'RUNNING'; S.lastTick = Date.now(); }
    else if (action === 'reveal' && id) S.forced.add(id);
    else if (action === 'edit' && id && S.items.has(id)) {
      // The customer revises an item mid-match: body {title?, description?, maxPoints?}.
      const patch = (await readBody(req)) || {};
      const def = S.items.get(id).def;
      for (const k of ['title', 'description', 'maxPoints']) if (patch[k] !== undefined) def[k] = patch[k];
      S.log.push(`${id} edited`);
    }
    else if (action === 'state') return send(res, 200, { status: S.status, clockMin: clock() / MIN, log: S.log, score: totalScore() });
    tick();
    return send(res, 200, { status: S.status, clockMin: +(clock() / MIN).toFixed(2) });
  }

  if (token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'unauthorized' });
  const m = p.match(/^\/api\/matches\/([^/]+)(?:\/(ready)|\/items\/([^/]+)\/(start|submissions))?$/);
  if (!m || m[1] !== scenario.matchId) return send(res, 404, { message: 'not found' });
  const [, , ready, itemId, action] = m;

  if (req.method === 'GET' && !ready && !itemId) {
    const visible = [...S.items.values()].filter((it) => it.revealClock != null);
    return send(res, 200, {
      id: scenario.matchId,
      status: S.status,
      serverTime: new Date(serverNow()).toISOString(),
      endsAt: S.status === 'WAITING' ? null : new Date(wallFromClock(scenario.durationMin * MIN)).toISOString(),
      score: totalScore(),
      items: visible.map(publicItem),
    });
  }
  if (req.method === 'POST' && ready) { S.log.push('team ready'); return send(res, 200, { status: 'READY' }); }
  if (req.method !== 'POST' || !itemId) return send(res, 405, { message: 'method not allowed' });

  const it = S.items.get(itemId);
  if (!it || it.revealClock == null) return send(res, 404, { message: `${itemId} not found` });
  if (S.status === 'PAUSED') return send(res, 409, { status: 'REJECTED', message: 'match is paused' });

  if (action === 'start') {
    if (itemState(it) === 'CLOSED') return send(res, 409, { status: 'REJECTED', message: 'item closed' });
    if (!it.startedAt) { it.startedAt = Date.now(); S.log.push(`${itemId} started`); }
    return send(res, 200, {
      itemId,
      startedAt: new Date(it.startedAt).toISOString(),
      template: templateFor(it.def),
      mvs: it.def.mvs ?? null,
    });
  }

  const payload = await readBody(req);
  if (!payload) return send(res, 400, { status: 'REJECTED', message: 'body must be JSON' });
  if (!it.startedAt) return send(res, 409, { status: 'REJECTED', message: 'start working first' });
  if (it.submission) return send(res, 409, { status: 'REJECTED', message: 'already submitted' });
  if (itemState(it) === 'CLOSED') return send(res, 409, { status: 'REJECTED', message: 'item closed' });
  it.submission = { status: 'ACCEPTED', result: null, score: null, submitClock: clock(), payload };
  S.log.push(`${itemId} submitted ${String(payload.gitRevision).slice(0, 10)}`);
  grade(it, payload).catch((e) => { it.submission.result = 'FAILED'; it.submission.score = 0; S.log.push(`grader error ${e}`); });
  return send(res, 202, { status: 'ACCEPTED', provisionalScore: it.def.maxPoints, message: 'queued for grading' });
});

server.listen(port, '127.0.0.1', () => {
  if (opt.autostart) { S.status = 'RUNNING'; S.lastTick = Date.now(); tick(); }
  console.log(`gm-mock listening on http://127.0.0.1:${server.address().port} match=${scenario.matchId} scale=${scale} remote=${remote ?? '(none: auto-pass)'}`);
});
