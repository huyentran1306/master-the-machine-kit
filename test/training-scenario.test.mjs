// Training scenario 02 must obey the published item rules and every hidden suite must
// fail on shipped code, then pass with only that item's independent reference fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_DIR = path.join(KIT, 'mock', 'scenarios', 'training-02');
const HIDDEN = path.join(SCENARIO_DIR, 'hidden');
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && k !== 'NODE_TEST_CONTEXT'));

const FIXES = {
  'TASK-11': [
    ['src/router.js', "import { findVoucher } from './vouchers.js';",
      "import { findVoucher } from './vouchers.js';\nimport fs from 'node:fs';\n\nconst pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));"],
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'GET' && path === '/version') return { status: 200, body: { name: pkg.name, version: pkg.version } };\n    if (method === 'POST' && path === '/redeem')"],
    ['README.md', '- `GET /vouchers/:code`', '- `GET /version` returns the package name and version.\n- `GET /vouchers/:code`'],
  ],
  'BUG-11': [
    ['src/router.js', '  } catch (err) {\n    console.error', "  } catch (err) {\n    if (err instanceof URIError) return { status: 400, body: { error: 'INVALID_VOUCHER_CODE' } };\n    console.error"],
  ],
  'CR-11': [
    ['src/vouchers.js', "tags: ['VIP'] },", "tags: ['VIP'] },\n  { code: 'START15', kind: 'percent', value: 15, minSubtotal: 200000, maxDiscount: 75000, expiresOn: '2027-12-31', tags: [] },"],
    ['src/vouchers.js', "if (voucher.kind === 'percent') return Math.round((subtotal * voucher.value) / 100);\n  return voucher.value;",
      "let discount = voucher.kind === 'percent' ? Math.round((subtotal * voucher.value) / 100) : voucher.value;\n  if (voucher.maxDiscount != null) discount = Math.min(discount, voucher.maxDiscount);\n  return discount;"],
    ['src/redeem.js', "if (isExpired(voucher, now)) return { status: 410, body: { error: 'VOUCHER_EXPIRED' } };",
      "if (isExpired(voucher, now)) return { status: 410, body: { error: 'VOUCHER_EXPIRED' } };\n  if (voucher.minSubtotal != null && subtotal < voucher.minSubtotal) {\n    return { status: 422, body: { error: 'MINIMUM_SUBTOTAL', minimum: voucher.minSubtotal } };\n  }"],
  ],
  'TASK-12': [
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'POST' && path === '/vouchers/lookup') {\n      const codes = body?.codes;\n      if (!Array.isArray(codes) || codes.length < 1 || codes.length > 20) return { status: 400, body: { error: 'INVALID_CODES' } };\n      return { status: 200, body: { vouchers: codes.map((code) => findVoucher(code)) } };\n    }\n    if (method === 'POST' && path === '/redeem')"],
  ],
  'PI-11': [['src/redeem.js', 'voucher.tags.includes', 'voucher.tags?.includes']],
  'BUG-12': [['src/vouchers.js', '  return voucher.value;', '  return Math.min(voucher.value, subtotal);']],
  'TASK-13': [
    ['src/router.js', "import { findVoucher } from './vouchers.js';", "import { findVoucher, VOUCHERS } from './vouchers.js';"],
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'GET' && path === '/vouchers') return { status: 200, body: { vouchers: VOUCHERS } };\n    if (method === 'POST' && path === '/redeem')"],
    ['README.md', '- `GET /vouchers/:code`', '- `GET /vouchers` returns every voucher in repository order.\n- `GET /vouchers/:code`'],
  ],
  'BUG-13': [
    ['src/router.js', 'const m = path.match(/^\\/vouchers\\/([^/]+)$/);', 'const m = path.match(/^\\/vouchers\\/([^/]+)\\/?$/);'],
  ],
  'CR-12': [
    ['src/router.js', "import { findVoucher } from './vouchers.js';", "import { findVoucher, VOUCHERS } from './vouchers.js';"],
    ['src/router.js', "const path = url.split('?')[0];", "const parsed = new URL(url, 'http://voucher.local');\n    const path = parsed.pathname;"],
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'GET' && path === '/vouchers') {\n      const kinds = parsed.searchParams.getAll('kind');\n      if (kinds.length > 1 || (kinds.length === 1 && !['percent', 'fixed'].includes(kinds[0]))) {\n        return { status: 400, body: { error: 'INVALID_KIND' } };\n      }\n      const vouchers = kinds.length ? VOUCHERS.filter((voucher) => voucher.kind === kinds[0]) : VOUCHERS;\n      return { status: 200, body: { vouchers } };\n    }\n    if (method === 'POST' && path === '/redeem')"],
  ],
  'TASK-14': [
    ['src/router.js', "if (method === 'POST' && path === '/redeem')", "if (method === 'POST' && path === '/redeem')"],
    ['src/router.js', "const m = path.match(/^\\/vouchers\\/([^/]+)$/);", "const summary = path.match(/^\\/vouchers\\/([^/]+)\\/summary$/);\n    if (method === 'GET' && summary) {\n      const voucher = findVoucher(decodeURIComponent(summary[1]));\n      return voucher\n        ? { status: 200, body: { code: voucher.code, kind: voucher.kind, value: voucher.value, expiresOn: voucher.expiresOn } }\n        : { status: 404, body: { error: 'VOUCHER_NOT_FOUND' } };\n    }\n    const m = path.match(/^\\/vouchers\\/([^/]+)$/);"],
    ['README.md', '- `GET /vouchers/:code`', '- `GET /vouchers/:code/summary` returns `{ code, kind, value, expiresOn }`.\n- `GET /vouchers/:code`'],
  ],
};

let root;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-training-02-'));
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
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `.grader/${id}.test.mjs`], { cwd: dir, env, encoding: 'utf8' });
  return { ok: r.status === 0 && /^# tests [1-9]/m.test(r.stdout), out: `${r.stdout}\n${r.stderr}` };
}

test('scenario follows the published MVS and 1,000-point rules', () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, 'scenario.json'), 'utf8'));
  assert.equal(scenario.durationMin, 40);
  assert.equal(scenario.items.reduce((n, it) => n + it.maxPoints, 0), 1000);
  assert.deepEqual(new Set(scenario.items.map((it) => it.type)), new Set(['TASK', 'CR', 'BUG', 'PI']));
  for (const item of scenario.items) {
    assert.match(item.id, /^(TASK|CR|BUG|PI)-\d+$/);
    if (['CR', 'BUG'].includes(item.type)) assert.ok(item.mvs?.length, `${item.id} requires MVS`);
    else assert.equal(item.mvs, undefined, `${item.id} must not publish MVS`);
    assert.ok(fs.existsSync(path.join(SCENARIO_DIR, item.hidden)), `${item.id} has a hidden grader`);
  }
});

for (const id of Object.keys(FIXES)) {
  test(`${id}: shipped code fails, its independent reference fix passes`, () => {
    const dir = checkout(id);
    assert.equal(hidden(dir, id).ok, false, 'shipped code must fail');
    apply(dir, id);
    const r = hidden(dir, id);
    assert.ok(r.ok, r.out.slice(-1800));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.equal(spawnSync(npm, ['test'], { cwd: dir, env }).status, 0, 'existing tests still pass');
  });
}
