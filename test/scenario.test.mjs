// The demo scenario must be fair: every hidden suite fails on the shipped code and passes
// once the item is done correctly (reference fixes below), independently of the other items.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIDDEN = path.join(KIT, 'mock', 'scenarios', 'demo', 'hidden');
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && k !== 'NODE_TEST_CONTEXT'));

const FIXES = {
  'BUG-01': [['src/vouchers.js', 'return now >= expiry;', 'return now.getTime() >= expiry.getTime() + 86400000;']],
  'PI-01': [['src/redeem.js', 'voucher.tags.includes', 'voucher.tags?.includes']],
  'CR-01': [
    ['src/vouchers.js', "tags: ['VIP'] },", "tags: ['VIP'] },\n  { code: 'MEGA30', kind: 'percent', value: 30, maxDiscount: 100000, expiresOn: '2027-03-31' },"],
    ['src/vouchers.js', 'if (voucher.kind === \'percent\') return Math.round((subtotal * voucher.value) / 100);\n  return voucher.value;',
      'let d = voucher.kind === \'percent\' ? Math.round((subtotal * voucher.value) / 100) : voucher.value;\n  if (voucher.maxDiscount != null) d = Math.min(d, voucher.maxDiscount);\n  return Math.min(d, subtotal);'],
  ],
  'TASK-01': [
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok', version: '1.4.0' } };\n    if (method === 'POST' && path === '/redeem')"],
    ['README.md', '- `GET /vouchers/:code`', '- `GET /health` returns `{ status, version }`.\n- `GET /vouchers/:code`'],
  ],
};

let root;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-scn-'));
  execFileSync(process.execPath, [path.join(KIT, 'mock', 'setup-rehearsal.mjs'), path.join(root, 'r')], { env });
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function checkout(name) {
  const dir = path.join(root, name);
  execFileSync('git', ['clone', '--quiet', path.join(root, 'r', 'remote.git'), dir], { env });
  return dir;
}

function apply(dir, id) {
  for (const [file, from, to] of FIXES[id]) {
    const p = path.join(dir, file);
    const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(s.includes(from), `${id}: ${file} has the expected snippet`);
    fs.writeFileSync(p, s.replace(from, to));
  }
}

function hidden(dir, id) {
  fs.mkdirSync(path.join(dir, '.grader'), { recursive: true });
  fs.copyFileSync(path.join(HIDDEN, `${id}.test.mjs`), path.join(dir, '.grader', `${id}.test.mjs`));
  // Pin TAP: Node 24 changed the default reporter, so parsing the implicit human reporter
  // made passing scenarios look as if no tests had run.
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `.grader/${id}.test.mjs`], { cwd: dir, env, encoding: 'utf8' });
  return { ok: r.status === 0 && /^# tests [1-9]/m.test(r.stdout), out: r.stdout };
}

for (const id of Object.keys(FIXES)) {
  test(`${id}: fails on shipped code, passes with only its own fix`, () => {
    const dir = checkout(id);
    assert.equal(hidden(dir, id).ok, false, 'shipped code must fail');
    apply(dir, id);
    const r = hidden(dir, id);
    assert.ok(r.ok, r.out.slice(-1500));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.equal(spawnSync(npm, ['test'], { cwd: dir, env }).status, 0, 'existing tests still pass');
  });
}
