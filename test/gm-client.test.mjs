import test from 'node:test';
import assert from 'node:assert/strict';
import { GmClient, ConfigError } from '../tool/lib/gm-client.mjs';
import { findPlaceholders, parseTime, parseDuration, decodeText } from '../tool/lib/util.mjs';

function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes(url, init);
    return {
      status: r.status ?? 200,
      headers: { get: (h) => (h === 'date' ? r.date ?? null : null) },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
}

const base = { baseUrl: 'http://x', matchId: 'a', endpoints: { match: { path: '/m/{matchId}' }, start: { method: 'POST', path: '/s/{itemId}' }, submit: { method: 'POST', path: '/u/{itemId}' } } };

test('custom field map: nested items, epoch seconds as strings, deadline from minutes, type from the id prefix', async () => {
  const cfg = {
    baseUrl: 'https://gm.example/', matchId: 'm 1', token: 'tkn', auth: { header: 'X-Team-Key' },
    endpoints: { match: { path: '/v1/match/{matchId}' } },
    map: {
      matchStatus: 'data.phase', serverTime: 'data.now', items: 'data.backlog',
      item: { id: 'code', type: 'kind', state: 'status', maxPoints: 'points', revealedAt: 'shownAt', deadlineMinutes: 'deadline', result: 'grade' },
    },
  };
  const calls = [];
  const c = new GmClient(cfg, {
    fetchImpl: fakeFetch(() => ({ body: { data: { phase: 'running', now: '1790000000', backlog: [
      { code: 'CR-02', kind: 'Change Request', status: 'open', points: 300, shownAt: 1789999400, deadline: '20' },
    ] } } }), calls),
  });
  const m = await c.getMatch();
  assert.equal(calls[0].url, 'https://gm.example/v1/match/m%201');
  assert.equal(calls[0].init.headers['X-Team-Key'], 'tkn');
  assert.equal(m.status, 'RUNNING');
  assert.equal(m.clock, 'server');
  assert.equal(m.serverNow, 1790000000 * 1000);
  const [it] = m.items;
  assert.equal(it.type, 'CR', 'the ID prefix wins over a free-text type');
  assert.equal(it.deadlineAt, (1789999400 + 20 * 60) * 1000);
  assert.equal(it.deadlineEstimated, true);
  assert.deepEqual(m.mapErrors, []);
});

test('a JSON response in an unmapped shape is a mapping error, not an empty backlog', async () => {
  const c = new GmClient(base, { fetchImpl: fakeFetch(() => ({ body: { data: { status: 'RUNNING', items: [{ id: 'BUG-01' }] } } })) });
  const m = await c.getMatch();
  assert.equal(m.mapErrors.length, 2);
  assert.match(m.mapErrors[0], /items path "items" not found/);
});

test('items as an object map and the HTTP Date header as the server clock', async () => {
  const c = new GmClient(base, { fetchImpl: fakeFetch(() => ({ date: 'Wed, 28 Oct 2026 09:00:00 GMT', body: { status: 'RUNNING', items: { a: { id: 'PI-01' } } } })) });
  const m = await c.getMatch();
  assert.equal(m.items[0].type, 'PI');
  assert.equal(m.clock, 'http-date');
  assert.equal(m.serverNow, Date.parse('2026-10-28T09:00:00Z'));
});

test('non-JSON match page is reported as unparsed instead of crashing', async () => {
  const c = new GmClient(base, { fetchImpl: fakeFetch(() => ({ body: '<html><body><h1>Match a</h1></body></html>' })) });
  const m = await c.getMatch();
  assert.equal(m.unparsed, true);
  assert.match(m.rawText, /Match a/);
});

test('submit outcomes: accepted, rejected, duplicate, unknown', async () => {
  const cases = [
    [{ status: 202, body: { status: 'ACCEPTED' } }, 'accepted'],
    [{ status: 200, body: { status: 'SUBMITTED' } }, 'accepted'],
    [{ status: 200, body: { provisionalScore: 100 } }, 'accepted'],
    [{ status: 200, body: { status: 'NOT_ACCEPTED' } }, 'rejected'],
    [{ status: 200, body: { success: false, error: 'late' } }, 'rejected'],
    [{ status: 409, body: { status: 'REJECTED', message: 'already submitted' } }, 'duplicate'],
    [{ status: 409, body: { status: 'REJECTED', message: 'item closed' } }, 'rejected'],
    [{ status: 200, body: '<!doctype html><p>login</p>' }, 'unknown'],
    [{ status: 302, body: '' }, 'rejected'],
    [{ status: 400, body: { status: 'REJECTED', message: 'Missing field rootCause. Please fix and resubmit.' } }, 'rejected'],
    [{ status: 403, body: { message: 'Submissions are accepted only once the item is started' } }, 'rejected'],
    [{ status: 400, body: { message: 'duplicate key "summary" in payload' } }, 'rejected'],
    [{ status: 409, body: { message: 'This item has already been submitted' } }, 'duplicate'],
    [{ status: 400, body: { status: 'ALREADY_SUBMITTED' } }, 'duplicate'],
  ];
  for (const [resp, want] of cases) {
    const calls = [];
    const c = new GmClient(base, { fetchImpl: fakeFetch(() => resp, calls) });
    const r = await c.submit('BUG-01', {});
    const got = r.accepted ? 'accepted' : r.duplicate ? 'duplicate' : r.unknown ? 'unknown' : 'rejected';
    assert.equal(got, want, JSON.stringify(resp));
    assert.equal(calls.length, 1, 'an HTTP answer is never retried');
    assert.equal(calls[0].init.redirect, 'manual');
  }
});

test('a submit that times out is UNCERTAIN and is never sent twice', async () => {
  let calls = 0;
  const hang = (url, init) => new Promise((resolve, reject) => {
    calls++;
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const c = new GmClient(base, { fetchImpl: hang, timeoutMs: 150 });
  const r = await c.submit('BUG-01', {});
  assert.equal(r.unknown, true);
  assert.equal(r.accepted, false);
  assert.equal(calls, 1);
});

test('setPath and getPath understand list indexes', async () => {
  const { setPath, getPath } = await import('../tool/lib/util.mjs');
  const o = { checks: [{ name: '' }] };
  setPath(o, 'checks[0].name', 'MVS 1');
  setPath(o, 'checks.1.result', 'PASS');
  setPath(o, 'files.0', 'a.js');
  assert.deepEqual(o, { checks: [{ name: 'MVS 1' }, { result: 'PASS' }], files: ['a.js'] });
  assert.equal(getPath(o, 'checks[1].result'), 'PASS');
});

test('start outcomes: confirmed, explicit failure, already started', async () => {
  const run = async (resp) => new GmClient(base, { fetchImpl: fakeFetch(() => resp) }).start('BUG-01');
  let r = await run({ body: { template: { a: '' }, mvs: ['x'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mvs, ['x']);
  r = await run({ body: { success: false, message: 'match not running yet' } });
  assert.equal(r.ok, false);
  assert.equal(r.alreadyStarted, false);
  r = await run({ status: 409, body: { message: 'already started' } });
  assert.equal(r.ok, false);
  assert.equal(r.alreadyStarted, true);
  r = await run({ status: 409, body: { message: 'item already closed' } });
  assert.equal(r.alreadyStarted, false, '"already closed" is not "already started"');
});

test('exec adapter passes the JSON body on stdin and parses stdout', async () => {
  let seen;
  const c = new GmClient({ matchId: 'z', endpoints: { submit: { exec: 'game-player submit {matchId} {itemId}' } } }, {
    execImpl: async (cmd, body) => { seen = { cmd, body }; return { code: 0, stdout: '{"status":"ACCEPTED"}' }; },
  });
  const r = await c.submit('BUG-01', { gitRevision: 'abc1234' });
  assert.equal(seen.cmd, 'game-player submit z BUG-01');
  assert.deepEqual(seen.body, { gitRevision: 'abc1234' });
  assert.equal(r.accepted, true);
});

test('a configuration error is not retried', async () => {
  const c = new GmClient({ matchId: 'a', endpoints: {} });
  const t0 = Date.now();
  await assert.rejects(() => c.getMatch(), ConfigError);
  assert.ok(Date.now() - t0 < 400, 'no retry sleeps');
});

test('placeholders: brackets, empty and template prose; domain words and prefilled ids are fine', () => {
  const template = { itemId: 'BUG-01', summary: 'Describe what changed', rootCause: '<root cause>', steps: [] };
  const holes = findPlaceholders({
    itemId: 'BUG-01', gitRevision: '', summary: 'Describe what changed', rootCause: 'TODO list endpoint returned 500',
    evidence: ['ok', '{{x}}'], note: '[summary of the change]', steps: [], status: 'TBD',
  }, ['gitRevision'], template);
  assert.deepEqual(holes, ['summary', 'evidence[1]', 'note', 'steps']);
});

test('time, duration and text decoding helpers', () => {
  assert.equal(parseTime('1790000000'), 1790000000000);
  assert.equal(parseTime('2026-10-28T09:00:00Z'), Date.parse('2026-10-28T09:00:00Z'));
  assert.equal(parseTime('garbage'), null);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('4m'), 240);
  assert.equal(parseDuration('240'), 240);
  assert.equal(parseDuration('5 sec'), null);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":"ư"}', 'utf16le')]);
  assert.equal(JSON.parse(decodeText(utf16)).a, 'ư');
});
