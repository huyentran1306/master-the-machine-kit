import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquire, release, slotDirFor } from '../team-sdlc-pack/src/build-lock.mjs';

const LOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'team-sdlc-pack', 'src', 'build-lock.mjs');

test('build slots: at most N holders, stale owners are reclaimed, a full queue never blocks past maxWait', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = await acquire(dir, 2); const b = await acquire(dir, 2);
  assert.ok(a && b && a !== b);
  assert.equal(await acquire(dir, 2, { maxWaitMs: 300, pollMs: 50 }), null, 'full: gives up instead of blocking');
  release(a);
  const c = await acquire(dir, 2, { maxWaitMs: 1000, pollMs: 50 });
  assert.ok(c);
  fs.writeFileSync(path.join(b, 'owner'), '999999999\n'); // owner process gone
  const d = await acquire(dir, 2, { maxWaitMs: 1000, pollMs: 50 });
  assert.equal(d, b, 'a dead owner\'s slot is reclaimed');
});

test('slot directory is shared by a checkout and its worktrees; the CLI runs the command and frees the slot', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'main');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.email=x@x', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'b']);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', path.join(root, '.mtm-wt', 'BUG-1')]);
  const expect = path.join(fs.realpathSync(root), '.mtm-notes', 'build-slots');
  assert.equal(slotDirFor(root), expect);
  assert.equal(slotDirFor(path.join(root, '.mtm-wt', 'BUG-1')), expect, 'a worktree uses the main checkout\'s slots');
  const r = spawnSync(process.execPath, [LOCK, '--', process.execPath, '-e', 'process.exit(3)'], { cwd: path.join(root, '.mtm-wt', 'BUG-1'), encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /\[build-lock\] slot slot-0/);
  assert.deepEqual(fs.readdirSync(slotDirFor(root)), [], 'slot freed after the command exits');
});

test('CLI fails closed when capacity stays full instead of starting an unbounded heavy command', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-full-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', tmp]);
  const dir = slotDirFor(tmp); const held = await acquire(dir, 1);
  t.after(() => release(held));
  const marker = path.join(tmp, 'should-not-run');
  const r = spawnSync(process.execPath, [LOCK, '--slots', '1', '--max-wait-ms', '100', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /command not started/);
  assert.equal(fs.existsSync(marker), false);
});
