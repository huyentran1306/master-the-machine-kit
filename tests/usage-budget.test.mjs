import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexUsage, usageTier } from '../team-sdlc-pack/src/usage-budget.mjs';

test('reads the newest 5-hour sample from Codex rollouts and projects it to the end of the match', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const now = Date.UTC(2026, 10, 9, 14, 0);
  const d = new Date(now); const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const line = (ts, pct) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000) }, secondary: { used_percent: 16 } } } });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), [line(now - 120000, 30), line(now - 60000, 41), '{"type":"other"}'].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), line(now - 300000, 20) + '\n');
  const u = readCodexUsage({ home, now });
  assert.equal(u.usedPercent, 41); assert.equal(u.weekPercent, 16);
  assert.equal(readCodexUsage({ home: path.join(home, 'missing'), now }), null);
  assert.equal(usageTier({ usage: u, base: { pct: 1, at: now - 10 * 60000 }, now, endsAt: now + 30 * 60000 }).tier, 1, '40% in 10 min -> 160% at the end');
  assert.equal(usageTier({ usage: { usedPercent: 20 }, base: { pct: 10, at: now - 10 * 60000 }, now, endsAt: now + 30 * 60000 }).tier, 0, '10% in 10 min -> 50% at the end');
  assert.equal(usageTier({ usage: { usedPercent: 93 } }).tier, 2);
  assert.equal(usageTier({ usage: { usedPercent: 50 }, base: { pct: 49, at: now - 60000 }, now, endsAt: now + 30 * 60000 }).tier, 0, 'too early for a rate: no projection yet');
});
