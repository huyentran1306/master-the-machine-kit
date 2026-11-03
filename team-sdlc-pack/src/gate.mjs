// Integration gate run BY THE HELPER, not typed by the model: direct vitest / tsc binaries (no pnpm),
// pnpm's verify-deps-before-run disabled for anything that still goes through pnpm, a hard time box
// tied to the item's deadline, and a verdict that separates a code failure from an environment one.
//
// Why (rehearsal 2026-10-31, solova-set2, kit 2.8.1): BUG-03 was READY at 11.5' (deadline 23'). The
// orchestrator's own gate `pnpm test <2 files>` took 118 s, printed 15/15 passed and still exited
// ELIFECYCLE; `pnpm typecheck` then hung. The gate was read as red, the item rolled back, re-verified,
// and pushed at 23.16': 10 s after the item closed. The same files with node_modules/vitest directly: 1.9 s.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const PNPM_SAFE_ENV = Object.freeze({ npm_config_verify_deps_before_run: 'false', pnpm_config_verify_deps_before_run: 'false' });
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Test files an integrated item range touched, relative to the app folder. */
export function itemTestFiles(changed, appRel) {
  const pre = appRel && appRel !== '.' ? appRel.replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
  return changed.map((f) => f.replace(/\\/g, '/')).filter((f) => TEST_FILE.test(f) && (!pre || f.startsWith(pre)))
    .map((f) => f.slice(pre.length)).filter((f) => !/(^|\/)(node_modules|\.mtm-briefs|challenge)\//.test(f));
}

/** Direct binaries when installed; the recon command with pnpm made safe otherwise. */
export function gateCommands(appDir, { files = [], recon = {} } = {}) {
  const vitest = path.join(appDir, 'node_modules', 'vitest', 'vitest.mjs');
  const tsc = path.join(appDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const jest = path.join(appDir, 'node_modules', 'jest', 'bin', 'jest.js');
  const test = fs.existsSync(vitest) ? { cmd: process.execPath, args: [vitest, 'run', ...files], label: `vitest run ${files.join(' ') || '(full suite)'}` }
    : fs.existsSync(jest) ? { cmd: process.execPath, args: [jest, ...files], label: `jest ${files.join(' ') || '(full suite)'}` }
    : recon.test ? { shell: `${recon.test} ${files.join(' ')}`.trim(), label: recon.test } : null;
  const types = fs.existsSync(tsc) && fs.existsSync(path.join(appDir, 'tsconfig.json')) ? { cmd: process.execPath, args: [tsc, '--noEmit'], label: 'tsc --noEmit' }
    : recon.typecheck ? { shell: recon.typecheck, label: recon.typecheck } : null;
  return { test, types };
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Runs one command with a hard timeout; output to logFile. Resolves { exit, timedOut, ms, tail }. */
export function runBounded(spec, { cwd, env, timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ ${spec.label}\n`);
    const opts = { cwd, env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: true };
    const child = spec.shell ? spawn(spec.shell, { ...opts, shell: true }) : spawn(spec.cmd, spec.args, opts);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1000, timeoutMs));
    const done = (exit) => {
      clearTimeout(timer); try { fs.closeSync(out); } catch { /* closed */ }
      const text = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      resolve({ exit, timedOut, ms: Date.now() - t0, text, tail: text.split('\n').filter((l) => l.trim()).slice(-12) });
    };
    child.on('exit', (code, sig) => done(code ?? (sig ? 1 : 0)));
    child.on('error', (e) => { fs.appendFileSync(logFile, String(e)); done(127); });
  });
}

/** A red result caused by real failing tests/type errors, as opposed to a hang, a timeout or pnpm noise. */
export function assertionFailure(r, kind) {
  if (!r || r.exit === 0 || r.timedOut) return false;
  const t = r.text || '';
  if (kind === 'types') return /error TS\d+/.test(t);
  if (/Tests?\s+\d+ failed|\b\d+ failed\b|✗|×\s|FAIL\s|AssertionError|not ok \d+/.test(t)) return true;
  return false;
}

/** Names of failing tests in a vitest/jest run ("FAIL  file > suite > name" / "● suite › name"). */
export function failingTests(text = '') {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    const v = line.match(/^\s*FAIL\s+(\S.*?>.*?)\s*$/);
    if (v) out.add(v[1].replace(/\s+\d+ms$/, '').replace(/\s+/g, ' ').trim());
    const j = line.match(/^\s*●\s+(.+›.+?)\s*$/);
    if (j) out.add(j[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Summary line of a vitest/jest/node --test run. */
export function testSummary(text = '') {
  const pick = (re) => (text.match(re) || [])[0];
  return [pick(/Test Files .*/), pick(/Tests:?\s+.*/), pick(/# pass \d+/), pick(/# fail \d+/)].filter(Boolean).join(' · ') || null;
}
