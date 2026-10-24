import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendProgress, readProgress, validateProgress } from '../official-team-pack/progress-log.mjs';

test('official team-pack keeps append-only environment and discovery progress', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-pack-')), 'progress.ndjson');
  appendProgress(file, { event: 'ENVIRONMENT_READY', status: 'ENVIRONMENT_READY', requestId: 'r1', repository: 'assigned.git', revision: 'abc123', build: 'PASS', matchLogin: 'PASS' }, new Date('2026-10-23T07:00:00Z'));
  appendProgress(file, { event: 'BACKLOG_SYNC', status: 'DISCOVERED', backlogId: 'TASK-01', title: 'Public task', revision: null, receiptId: null }, new Date('2026-10-23T07:01:00Z'));
  const events = readProgress(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'ENVIRONMENT_READY');
  assert.equal(events[1].status, 'DISCOVERED');
});

test('official team-pack rejects an incomplete official event', () => {
  assert.throws(() => validateProgress({ event: 'ENVIRONMENT_READY', status: 'ENVIRONMENT_READY' }), /requestId/);
  assert.throws(() => validateProgress({ event: 'NOT_A_PHASE', status: 'PASS' }), /unsupported/);
});
