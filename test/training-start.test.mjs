// Smoke-test the new question pack through the same Start working API used by MTM.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(KIT, 'mock', 'gm-mock-server.mjs');
const SCENARIO = path.join(KIT, 'mock', 'scenarios', 'training-02', 'scenario.json');

test('training-02 reveals wave zero and Start returns MVS only for CR/BUG', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [SERVER, '--scenario', SCENARIO, '--port', '0', '--autostart']);
  t.after(() => child.kill());
  let logs = '';
  child.stderr.on('data', (b) => { logs += b; });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => {
      logs += b;
      const m = String(b).match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`mock exited ${code}: ${logs}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const json = async (url, init) => {
    const r = await fetch(`${base}${url}`, init);
    assert.ok(r.ok, `${r.status} ${url}`);
    return r.json();
  };

  const match = await json('/api/matches/training-02');
  assert.deepEqual(match.items.map((it) => it.id).sort(), ['BUG-11', 'TASK-11']);

  const task = await json('/api/matches/training-02/items/TASK-11/start', { method: 'POST' });
  assert.equal(task.mvs, null);
  const bug = await json('/api/matches/training-02/items/BUG-11/start', { method: 'POST' });
  assert.equal(bug.mvs.length, 2);

  await json('/admin/reveal/CR-11', { method: 'POST' });
  const cr = await json('/api/matches/training-02/items/CR-11/start', { method: 'POST' });
  assert.equal(cr.mvs.length, 4);

  await json('/admin/reveal/PI-11', { method: 'POST' });
  const pi = await json('/api/matches/training-02/items/PI-11/start', { method: 'POST' });
  assert.equal(pi.mvs, null);
  assert.ok(pi.template.rootCause);
  assert.ok(pi.template.impact);
});
