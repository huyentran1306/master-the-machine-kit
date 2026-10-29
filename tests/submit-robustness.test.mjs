import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { RuntimeSession, DEFAULT_ADAPTER } from '../team-sdlc-pack/src/runtime-session.mjs';
import { submit } from '../team-sdlc-pack/src/game-api.mjs';
import { SUBMIT_LIMITS } from '../team-sdlc-pack/src/deadline.mjs';
import { serializeToolValue, MAX_RESULT_CHARS } from '../team-sdlc-pack/src/tool-result.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  return `http://127.0.0.1:${srv.address().port}`;
}
const body = { clientSubmissionId: 'fixed-key', backlogItemKey: 'BUG-07', gitRevision: 'a'.repeat(40), answer: {} };
const options = origin => ({ url: origin + '/submit', allowedOrigins: [origin], bearer: 'fixture', body, log: async () => {} });
function session(origin = 'http://127.0.0.1:1') {
  const s = new RuntimeSession();
  s.phase = 'GAME'; s.match = { uuid: 'fixture', status: 'IN_PROGRESS' }; s.bearer = 'fixture';
  s.apiBase = origin; s.allowedApiOrigins = [origin];
  s.items.set('BUG-07', { id: 'BUG-07', type: 'BUG', local: { startedAt: Date.now() } });
  s.preflight = async () => ({ errors: [], warnings: [], sha: body.gitRevision, answer: {} });
  s.saveState = () => {}; s.view = () => ({}); s.doRefresh = async () => ({ ok: true });
  return s;
}

test('same item is refused concurrently, other items proceed, and success releases the lock', async () => {
  const s = new RuntimeSession();
  const jobs = new Map();
  s.submitItem = ({ backlogItemKey }) => {
    const job = deferred(); jobs.set(backlogItemKey, job); return job.promise;
  };
  const first = s.submit_work({ backlogItemKey: ' BUG-07 ' });
  assert.equal((await s.submit_work({ backlogItemKey: 'BUG-07' })).error, 'SUBMIT_IN_PROGRESS');
  const other = s.submit_work({ backlogItemKey: 'CR-08' });
  assert.equal(jobs.size, 2);
  jobs.get('BUG-07').resolve({ ok: true }); jobs.get('CR-08').resolve({ ok: true });
  await Promise.all([first, other]);
  const next = s.submit_work({ backlogItemKey: 'BUG-07' });
  jobs.get('BUG-07').resolve({ ok: true });
  assert.equal((await next).ok, true);
  assert.equal(s.submissionsInFlight.size, 0);
});

test('per-item lock releases on rejection and exceptions', async () => {
  const s = new RuntimeSession();
  s.submitItem = async () => { throw new Error('fixture failure'); };
  await assert.rejects(s.submit_work({ backlogItemKey: 'BUG-07' }), /fixture failure/);
  s.submitItem = async () => ({ ok: false, outcome: 'REJECTED' });
  assert.equal((await s.submit_work({ backlogItemKey: 'BUG-07' })).outcome, 'REJECTED');
  assert.equal(s.submissionsInFlight.size, 0);
});

test('preflight timeout cannot later send or create a pending submission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = session();
  const pf = deferred(); s.preflight = () => pf.promise;
  const pending = s.submit_work({ backlogItemKey: 'BUG-07' });
  t.mock.timers.tick(SUBMIT_LIMITS.preflightMs + 1);
  assert.equal((await pending).error, 'PREFLIGHT_TIMEOUT');
  pf.resolve({ errors: [], warnings: [], sha: body.gitRevision, answer: {} });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(s.state.submissions, {});
  assert.equal(s.submissionsInFlight.size, 0);
});

test('an uncertain call replays identical stored body/key and records the eventual receipt', async t => {
  const received = [];
  const origin = await server(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ raw, key: req.headers['idempotency-key'] });
    res.writeHead(received.length === 1 ? 503 : 201, { 'content-type': 'application/json', 'retry-after': '3600' });
    res.end(JSON.stringify(received.length === 1 ? { error: { code: 'BUSY' } } : { receiptId: 'receipt-1', status: 'ACCEPTED' }));
  });
  const s = session(origin);
  const args = { backlogItemKey: 'BUG-07' };
  assert.equal((await s.submit_work(args)).outcome, 'UNCERTAIN');
  const original = structuredClone(s.state.submissions['BUG-07'].body);
  s.preflight = () => { throw new Error('replay must not re-preflight'); };
  const dry = await s.submit_work({ ...args, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(received.length, 1);
  assert.equal((await s.submit_work(args)).outcome, 'SUBMITTED');
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(s.state.submissions['BUG-07'].body, original);
  assert.equal(s.state.submissions['BUG-07'].receipt.receiptId, 'receipt-1');
});

test('a slow POST is aborted within the total budget, not its per-request timeout', async t => {
  const origin = await server(t, () => {});
  const start = Date.now();
  const result = await submit({ ...options(origin), budgetMs: 100, timeoutMs: 30000 });
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.ok(Date.now() - start < 1500, '100ms budget must not become a 30s wait');
});

test('redirects and response bodies share the submit deadline', async t => {
  const origin = await server(t, (req, res) => {
    if (req.url === '/submit') {
      res.writeHead(307, { location: '/slow' }); res.end();
    } else {
      res.writeHead(201, { 'content-type': 'application/json' }); res.write('{');
    }
  });
  const start = Date.now();
  const result = await submit({ ...options(origin), budgetMs: 100 });
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.ok(Date.now() - start < 1500);
});

test('retry status refresh is bounded and cannot send a late POST after returning', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => {
    calls++; res.writeHead(503, { 'retry-after': '0.001' }); res.end('busy');
  });
  const gate = deferred();
  const result = await submit({ ...options(origin), budgetMs: 150, beforeRetry: () => gate.promise });
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.match(result.halted, /Status refresh/);
  gate.resolve(null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('retry gates preserve pause refusal and idempotency across transient failures', async t => {
  const received = [];
  const origin = await server(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ raw, key: req.headers['idempotency-key'] });
    res.writeHead(received.length < 3 ? 503 : 201, { 'content-type': 'application/json', 'retry-after': '0.001' });
    res.end(JSON.stringify(received.length < 3 ? {} : { receiptId: 'ok', status: 'ACCEPTED' }));
  });
  const paused = await submit({ ...options(origin), budgetMs: 1000, beforeRetry: async () => 'PAUSED' });
  assert.equal(paused.halted, 'PAUSED'); assert.equal(received.length, 1);
  const result = await submit({ ...options(origin), budgetMs: 1000, beforeRetry: async () => null });
  assert.equal(result.outcome, 'ACCEPTED');
  assert.deepEqual(received, Array(3).fill(received[0]));
});

test('accepted receipt survives a stuck post-submit refresh', async t => {
  const origin = await server(t, (req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"receiptId":"accepted","status":"ACCEPTED"}');
  });
  const s = session(origin); s.doRefresh = () => new Promise(() => {});
  const start = Date.now();
  const result = await s.submit_work({ backlogItemKey: 'BUG-07' });
  assert.equal(result.outcome, 'SUBMITTED'); assert.equal(result.refreshed, false);
  assert.equal(s.state.submissions['BUG-07'].state, 'ACCEPTED');
  assert.ok(Date.now() - start < SUBMIT_LIMITS.refreshMs + 1500);
});

test('submit time allocations leave 35 seconds below the helper timeout', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../team-sdlc-pack/config/game-adapter.json', import.meta.url)));
  assert.equal(config.submit.retryBudgetMs, DEFAULT_ADAPTER.submit.retryBudgetMs);
  assert.equal(SUBMIT_LIMITS.preflightMs + SUBMIT_LIMITS.retryMs + SUBMIT_LIMITS.refreshMs, 85000);
});

test('oversized tool values stay valid bounded JSON even after escaping, with control fields', () => {
  const normal = { ok: true, answer: 'small' };
  assert.deepEqual(JSON.parse(serializeToolValue(normal)), normal);
  for (const data of ['x', '"\\\n', '\u0000', '😀']) {
    const value = { ok: true, outcome: 'SUBMITTED', receipt: { receiptId: 'r1' }, mustEnd: 'Finish now', data: data.repeat(MAX_RESULT_CHARS) };
    const text = serializeToolValue(value);
    assert.ok(text.length <= MAX_RESULT_CHARS);
    const parsed = JSON.parse(text);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.originalLength, JSON.stringify(value).length);
    assert.equal(parsed.outcome, 'SUBMITTED'); assert.equal(parsed.mustEnd, 'Finish now');
    assert.deepEqual(parsed.receipt, value.receipt);
  }
});
