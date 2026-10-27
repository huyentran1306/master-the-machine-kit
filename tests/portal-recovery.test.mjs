import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { login } from '../team-sdlc-pack/src/portal.mjs';
import { CookieJar } from '../team-sdlc-pack/src/http.mjs';
import * as L from './support/lifecycle-inputs.mjs';

const MATCH = 'CASE1234';
const ID = '11111111-2222-4333-8444-555555555555';
const shell = `<html><body><h1>Match ${MATCH}</h1><p>Loading match…</p></body></html>`;

async function fixture(t) {
  const state = { requests: [], mode: 'ready', loginCount: 0, token: '', status: 'PREPARING', hideUuidInPreparation: false };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    state.requests.push({ method: req.method, path: req.url, origin: req.headers.origin });
    const json = (status, data, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra });res.end(JSON.stringify(data)); };
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.method === 'POST' ? shell : '<form action="/login" method="post"><input name="username"><input name="password" type="password"></form>');return;
    }
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers.referer !== origin + '/login') return json(403, { error: { code: 'ORIGIN_REQUIRED' } });
      const body = JSON.parse(raw);
      if (body.username !== 'team' || body.password !== 'fake-password') return json(401, { error: { code: 'BAD_LOGIN' } });
      state.loginCount++;state.token = `fake-cookie-${state.loginCount}`;
      if (state.mode === 'expired') state.mode = 'ready';
      return json(200, { ok: true }, { 'set-cookie': `session=${state.token}; Path=/; HttpOnly` });
    }
    if (req.url === `/match/${MATCH}`) { res.writeHead(200, { 'content-type': 'text/html' });res.end(shell);return; }
    if (req.url === `/api/v1/match/${MATCH}`) {
      if (req.headers.cookie !== `session=${state.token}` || !state.token || state.mode === 'expired') return json(401, { error: { code: 'UNAUTHORIZED' } });
      if (state.mode === 'loading') return json(200, { loading: true });
      if (state.mode === 'broken') return json(503, { error: { code: 'UNAVAILABLE' } });
      const hidden = state.hideUuidInPreparation && state.status === 'PREPARING';
      return json(200, { match: { publicId: MATCH, ...(hidden ? {} : { id: ID }), status: state.status, remainingSec: 2400, repository: { url: 'https://github.com/example/repo.git', branch: 'main', folder: MATCH } }, backlog: state.status === 'PREPARING' ? [] : [{ key: 'BUG-01', title: 'Fix invoice totals', status: 'OPEN', maxPoints: 100 }], ...(hidden ? {} : { api: { startEndpoint: `${origin}/api/v1/matches/${ID}/backlogs/start`, submissionEndpoint: `${origin}/api/v1/matches/${ID}/submissions` } }) });
    }
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => new Promise(resolve => srv.close(resolve)));
  return { state, origin };
}

function context(origin, adapter = {}) {
  return { origin, matchUrl: origin + '/match/' + MATCH, matchId: MATCH, username: 'team', password: 'fake-password', jar: new CookieJar(), allowedOrigins: [origin], adapter };
}

test('loading HTML never authenticates a form POST; JSON login sends browser Origin/Referer and verifies match data', async t => {
  const { origin, state } = await fixture(t);
  const c = context(origin, { login: { strategies: ['form', 'json'], jsonLoginPaths: ['/api/v1/auth/login'] }, matchView: { extraJsonPaths: ['/api/v1/match/{matchId}'] } });
  const r = await login(c);
  assert.equal(r.strategy, 'json');
  assert.equal(state.loginCount, 1);
  assert.ok(state.requests.some(r => r.path === `/api/v1/match/${MATCH}`));
});

test('an authenticated account with only loading data still fails login verification', async t => {
  const { origin, state } = await fixture(t); state.mode = 'loading';
  const c = context(origin, { login: { strategy: 'json', jsonLoginPaths: ['/api/v1/auth/login'] }, matchView: { extraJsonPaths: ['/api/v1/match/{matchId}'] } });
  await assert.rejects(login(c), { code: 'LOGIN_FAILED' });
});

async function session(t, origin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-portal-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meta = { workspace: root, folder: MATCH, teamId: 'T01', teamName: 'Team One', repoUrl: 'https://github.com/example/repo.git', branch: 'main' };
  const s = new RuntimeSession({ teamWorkspace: root });
  const prep = L.prepareGame(meta, { playerSessionId: 'portal-session', origin, username: 'team', password: 'fake-password' });
  assert.equal((await s.configure({ raw: L.wire(prep) })).ok, true);
  t.after(() => s.stopPoller());
  return { s, meta };
}

test('SSR loading shell plus the public JSON view discovers the UUID and backlog after START_GAME', async t => {
  const { origin, state } = await fixture(t);
  const { s, meta } = await session(t, origin);
  const logged = await s.login_match();
  assert.equal(logged.ok, true, JSON.stringify(logged));
  assert.equal(logged.matchUuid, ID);
  assert.equal(s.items.size, 0, 'preparation legitimately has no revealed items');
  state.status = 'IN_PROGRESS';
  const start = L.startGame(meta, { playerSessionId: 'portal-session', origin, apiKey: 'fake-bearer-key', teamUuid: '22222222-2222-4222-8222-222222222222', environmentRevision: 'a'.repeat(40) });
  const r = await s.configure({ raw: L.wire(start) });
  assert.equal(r.results[0].sync, 'COMPLETED', JSON.stringify(r));
  assert.equal(s.items.get('BUG-01').title, 'Fix invoice totals');
  assert.equal(s.match.uuid, ID);
  assert.ok(!JSON.stringify(r).includes('fake-password'));
  assert.ok(!JSON.stringify(r).includes(state.token));
});

test('unavailable match data cannot mark BACKLOG_SYNC complete or the environment ready', async t => {
  const { origin, state } = await fixture(t);
  const { s, meta } = await session(t, origin);
  assert.equal((await s.login_match()).ok, true);
  state.mode = 'loading';state.status = 'IN_PROGRESS';
  const start = L.startGame(meta, { playerSessionId: 'portal-session', origin, apiKey: 'fake-bearer-key', teamUuid: '22222222-2222-4222-8222-222222222222', environmentRevision: 'a'.repeat(40) });
  const r = await s.configure({ raw: L.wire(start) });
  assert.match(r.results[0].sync, /^FAILED:/, JSON.stringify(r));
  assert.match(r.next, /NOT synchronized/);
  assert.notEqual(s.syncDone, true);
  const events = fs.readFileSync(s.progressLogFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.some(e => e.type === 'GAME_START_STATUS' && e.stage === 'BACKLOG_SYNC' && e.status === 'FAILED'));
  assert.ok(!events.some(e => e.type === 'GAME_START_STATUS' && e.stage === 'BACKLOG_SYNC' && e.status === 'COMPLETED'));
  s.phase = 'PREPARATION';
  for (const name of ['GIT_AUTH', 'REPOSITORY', 'ENVIRONMENT', 'BUILD', 'MATCH_LOGIN']) s.prep[name] = 'COMPLETED';
  assert.equal((await s.report_ready()).error, 'MATCH_DATA_UNAVAILABLE');
});

test('JSON unauthorized after a shell response triggers a bounded re-login and recovers', async t => {
  const { origin, state } = await fixture(t);
  const { s } = await session(t, origin);
  assert.equal((await s.login_match()).ok, true);
  const before = state.loginCount;
  state.mode = 'expired';
  const r = await s.doRefresh();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(state.loginCount, before + 1);
  assert.equal(s.portalReady, true);
  assert.ok(!s.blockers.has('MATCH_PORTAL_LOADING'));
});

test('preparation accepts authenticated match metadata before the server reveals operation UUIDs', async t => {
  const { origin, state } = await fixture(t);
  state.hideUuidInPreparation = true;
  const { s, meta } = await session(t, origin);
  assert.equal((await s.login_match()).ok, true);
  assert.equal(s.portalReady, true);
  assert.equal(s.match.uuid, null);
  assert.ok(!s.blockers.has('MATCH_UUID_UNKNOWN'));
  state.status = 'IN_PROGRESS';
  const start = L.startGame(meta, { playerSessionId: 'portal-session', origin, apiKey: 'fake-bearer-key', teamUuid: '22222222-2222-4222-8222-222222222222', environmentRevision: 'a'.repeat(40) });
  const r = await s.configure({ raw: L.wire(start) });
  assert.equal(r.results[0].sync, 'COMPLETED');
  assert.equal(s.match.uuid, ID);
  assert.equal(s.items.size, 1);
});
