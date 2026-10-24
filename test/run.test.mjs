// The evidence runner: arguments arrive intact through cmd.exe, CI=true is set, and a hung
// command (with a grandchild) is killed as a tree and returns promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../tool/lib/run.mjs';

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-run-'));
  // process.stdout.write, not console.log: console.log treats %O in its first argument as a format.
  fs.writeFileSync(path.join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + " CI=" + process.env.CI)');
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('arguments with spaces, pipes, ampersands and quotes arrive intact', async () => {
  const args = ['-t', 'expiry boundary', '--filter', 'Name~A|Name~B', 'x"y', 'a&b', '>out', 'discount for %USERNAME% applies', '--name=%OS%'];
  const r = await runCommand(['node', path.join(dir, 'print.js'), ...args], { cwd: dir });
  assert.equal(r.code, 0, r.output);
  const [json, ci] = r.output.trim().split(' CI=');
  assert.deepEqual(JSON.parse(json), args);
  assert.equal(ci, 'true');
  assert.deepEqual(fs.readdirSync(dir), ['print.js'], 'no stray redirection file');
});

test('exit codes are signed', async () => {
  const r = await runCommand(['node', '-e', 'process.exit(-1)'], { cwd: dir });
  assert.equal(r.code, process.platform === 'win32' ? -1 : 255);
});

test('a hung command and its grandchild are killed at the timeout', async () => {
  const marker = path.join(dir, 'alive.txt');
  fs.writeFileSync(path.join(dir, 'gc.js'), `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 5000)`);
  fs.writeFileSync(path.join(dir, 'parent.js'), `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(dir, 'gc.js'))}], { stdio: 'inherit' }); setTimeout(() => {}, 60000)`);
  const t0 = Date.now();
  const r = await runCommand(['node', path.join(dir, 'parent.js')], { cwd: dir, timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t0 < 6000, `returned after ${Date.now() - t0} ms`);
  await new Promise((res) => setTimeout(res, 5000));
  assert.equal(fs.existsSync(marker), false, 'the grandchild was killed too');
});
