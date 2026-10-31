import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { ProgressLog, LOG_SOFT_LIMIT } from '../team-sdlc-pack/src/progress.mjs';

// A session shell with a real ProgressLog: only the logging path is exercised.
function shell(file) {
  const s = Object.create(RuntimeSession.prototype);
  s.openPairs = new WeakMap();
  s.logProblems = [];
  s.log = new ProgressLog({ file, playerSessionId: 'sess-1' });
  return s;
}
const api = (phase, extra = {}) => ({ type: 'GAME_MASTER_API', operation: 'REFRESH_MATCH', backlogId: null, method: 'GET',
  origin: 'https://example.test', path: '/match/X', phase, httpStatus: phase === 'SUCCEEDED' ? 200 : null, requestId: null,
  summary: phase === 'REQUESTED' ? 'Calling mtm-game-server.' : 'Received the mtm-game-server result.', ...extra });

test('optional REQUESTED/outcome pairs are never split at the progress-log soft limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-'));
  const s = shell(path.join(dir, 'M.progress.ndjson'));
  const lineBytes = Buffer.byteLength(JSON.stringify(s.log.envelope(api('REQUESTED'))) + '\n');
  // Fill to just below the soft limit: the next REQUESTED fits, its outcome would not.
  s.log.bytes = LOG_SOFT_LIMIT - lineBytes - 1;
  const req1 = { method: 'GET', url: 'https://example.test/match/X' };
  s.pairEvent(api('REQUESTED'), req1, 'REQUESTED', true);
  assert.equal(s.lastEventDropped, false);
  s.pairEvent(api('SUCCEEDED'), req1, 'SUCCEEDED', true);
  assert.equal(s.lastEventDropped, false, 'outcome of a written REQUESTED is mandatory');
  // Now over the soft limit: both halves of the next optional pair are dropped together.
  const req2 = { method: 'GET', url: 'https://example.test/match/X' };
  const before = s.log.written;
  s.pairEvent(api('REQUESTED'), req2, 'REQUESTED', true);
  assert.equal(s.lastEventDropped, true);
  s.pairEvent(api('SUCCEEDED'), req2, 'SUCCEEDED', true);
  assert.equal(s.log.written, before, 'outcome of a dropped REQUESTED is dropped too');
  // Mandatory pairs are always written.
  const req3 = { method: 'GET', url: 'https://example.test/match/X' };
  s.pairEvent(api('REQUESTED'), req3, 'REQUESTED', false);
  s.pairEvent(api('SUCCEEDED'), req3, 'SUCCEEDED', false);
  const lines = fs.readFileSync(path.join(dir, 'M.progress.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l).phase);
  assert.deepEqual(lines, ['REQUESTED', 'SUCCEEDED', 'REQUESTED', 'SUCCEEDED']);
  assert.deepEqual(s.logProblems, []);
});

test('a retried request reopens its pair with the same request object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-'));
  const s = shell(path.join(dir, 'M.progress.ndjson'));
  const req = { method: 'POST', url: 'https://example.test/api' };
  s.pairEvent(api('REQUESTED'), req, 'REQUESTED', true);
  s.pairEvent(api('FAILED', { summary: 'Failed: NETWORK' }), req, 'FAILED', true);
  s.pairEvent(api('REQUESTED'), req, 'REQUESTED', true);
  s.pairEvent(api('SUCCEEDED'), req, 'SUCCEEDED', true);
  const phases = fs.readFileSync(path.join(dir, 'M.progress.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l).phase);
  assert.deepEqual(phases, ['REQUESTED', 'FAILED', 'REQUESTED', 'SUCCEEDED']);
});
