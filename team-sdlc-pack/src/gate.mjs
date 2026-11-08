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

/** `yarn …` through the repository's own Yarn release (.yarnrc.yml yarnPath) when one is bundled: no global yarn needed. */
export function withRepoYarn(appDir, command) {
  if (!command || !/^yarn(?:\s|$)/.test(command)) return command;
  try {
    const rc = fs.readFileSync(path.join(appDir, '.yarnrc.yml'), 'utf8').match(/^\s*yarnPath:\s*["']?([^"'\n]+?)["']?\s*$/m);
    const bin = rc && path.resolve(appDir, rc[1]);
    if (bin && fs.existsSync(bin)) return `"${process.execPath}" "${bin}"${command.slice(4)}`;
  } catch { /* no rc */ }
  return command;
}

/**
 * A root tsconfig with project `references` checks only its own few files: `tsc --noEmit` there passed in 0.4 s in
 * 41B6BCM3 without checking a single package (a false green). Use the repository's typecheck script instead.
 */
export function solutionTsconfig(appDir) {
  try {
    const text = fs.readFileSync(path.join(appDir, 'tsconfig.json'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /"references"\s*:\s*\[\s*\{/.test(text);
  } catch { return false; }
}

/** Direct binaries when installed; the recon command with pnpm made safe otherwise. */
export function gateCommands(appDir, { files = [], recon = {} } = {}) {
  const vitest = path.join(appDir, 'node_modules', 'vitest', 'vitest.mjs');
  const tsc = path.join(appDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const jest = path.join(appDir, 'node_modules', 'jest', 'bin', 'jest.js');
  const reconTest = withRepoYarn(appDir, recon.test); const reconTypes = withRepoYarn(appDir, recon.typecheck);
  const test = fs.existsSync(vitest) ? { cmd: process.execPath, args: [vitest, 'run', ...files], label: `vitest run ${files.join(' ') || '(full suite)'}` }
    : fs.existsSync(jest) ? { cmd: process.execPath, args: [jest, ...files], label: `jest ${files.join(' ') || '(full suite)'}` }
    : reconTest ? { shell: `${reconTest} ${files.join(' ')}`.trim(), label: recon.test } : null;
  const types = reconTypes && solutionTsconfig(appDir) ? { shell: reconTypes, label: `${recon.typecheck} (project references)` }
    : fs.existsSync(tsc) && fs.existsSync(path.join(appDir, 'tsconfig.json')) ? { cmd: process.execPath, args: [tsc, '--noEmit'], label: 'tsc --noEmit' }
    : reconTypes ? { shell: reconTypes, label: recon.typecheck } : null;
  return { test, types };
}

const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cts', 'vitest.config.cjs'];

/**
 * Monorepo with a root vitest config that lists `projects` (or a vitest.workspace file): a root `vitest run`
 * can die before running anything (UDLWEWFR and 41B6BCM3: "Projects ... have different 'maxWorkers' but
 * same 'sequence.groupOrder'"), so every code gate there ended as ENVIRONMENT and shipped unchecked.
 * Run each affected project from its own folder instead: the projects of the changed code files (item scope:
 * of the item's test files) plus the folder the preparation baseline ran in (`RUN vX <dir>` in test.log).
 * The env prefix of the project's own vitest script (e.g. "test:node": "ENV=node vitest --run") is reused.
 * Returns null when the app is not such a monorepo; the single root command then stays as before.
 */
export function projectTestSpecs(appDir, { files = [], codeFiles = [], appRel = '', baselineText = '' } = {}) {
  const root = path.resolve(appDir);
  const rootCfg = VITEST_CONFIGS.map((n) => path.join(root, n)).find((f) => fs.existsSync(f));
  const workspace = fs.readdirSync(root).some((n) => /^vitest\.workspace\.(?:[cm]?[jt]s|json)$/.test(n));
  let projects = workspace;
  if (!projects && rootCfg) { try { projects = /\b(?:projects|workspace)\s*:/.test(fs.readFileSync(rootCfg, 'utf8')); } catch { /* unreadable */ } }
  if (!projects) return null;
  const projectOf = (abs) => {
    for (let dir = path.dirname(abs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      if (VITEST_CONFIGS.some((n) => fs.existsSync(path.join(dir, n)))) return dir;
    }
    return null;
  };
  const pre = appRel && appRel !== '.' ? `${appRel.replace(/\/$/, '')}/` : '';
  const rel = (f) => { const x = String(f).replace(/\\/g, '/'); return pre && x.startsWith(pre) ? x.slice(pre.length) : x; };
  const groups = new Map();
  const add = (dir, file) => { if (!dir) return; if (!groups.has(dir)) groups.set(dir, []); if (file) groups.get(dir).push(path.relative(dir, file).split(path.sep).join('/')); };
  if (files.length) for (const f of files) add(projectOf(path.join(root, rel(f))), path.join(root, rel(f)));
  else {
    for (const f of codeFiles) add(projectOf(path.join(root, rel(f))), null);
    const m = String(baselineText).match(/^\s*RUN\s+v[\d.]+\s+(.+?)\s*$/m);
    if (m) { const dir = path.resolve(m[1].trim()); if (dir.startsWith(root + path.sep) && fs.existsSync(dir)) add(dir, null); }
  }
  if (!groups.size) return null;
  const vitestBin = (dir) => [path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'), path.join(root, 'node_modules', 'vitest', 'vitest.mjs')].find((f) => fs.existsSync(f));
  const envOf = (dir) => {
    let scripts = {}; try { scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {}; } catch { /* none */ }
    for (const cmd of Object.values(scripts)) {
      const m = String(cmd).match(/^((?:[A-Z_][A-Z0-9_]*=\S+\s+)*)vitest\b(.*)$/);
      if (!m || /(?:^|\s)(?:-c|--config)\b/.test(m[2])) continue;
      return Object.fromEntries([...m[1].matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)].map((x) => [x[1], x[2].replace(/^['"]|['"]$/g, '')]));
    }
    return {};
  };
  return [...groups].map(([dir, list]) => {
    const bin = vitestBin(dir); if (!bin) return null;
    const label = `vitest run ${list.join(' ') || '(project suite)'} [${path.relative(root, dir).split(path.sep).join('/')}]`;
    return { cwd: dir, env: envOf(dir), spec: { cmd: process.execPath, args: [bin, 'run', ...list], label } };
  }).filter(Boolean);
}

/** Runs project specs one after another inside one budget and merges them into one runBounded-like result. */
export async function runProjects(specs, { env, timeoutMs, logFile, signal }) {
  const t0 = Date.now(); const parts = [];
  for (const [i, s] of specs.entries()) {
    const left = timeoutMs - (Date.now() - t0); if (left < 1000) { parts.push({ exit: 1, timedOut: true, interrupted: false, ms: 0, text: `$ ${s.spec.label}\n(skipped: gate budget used up)\n`, tail: [] }); break; }
    parts.push(await runBounded(s.spec, { cwd: s.cwd, env: { ...env, ...s.env }, timeoutMs: left, logFile: `${logFile}.${i}`, signal }));
    if (parts.at(-1).interrupted) break;
  }
  const text = parts.map((p) => p.text).join('\n');
  try { fs.writeFileSync(logFile, text); for (const [i] of parts.entries()) fs.rmSync(`${logFile}.${i}`, { force: true }); } catch { /* best effort */ }
  return { exit: parts.reduce((m, p) => Math.max(m, p.exit || 0), 0), timedOut: parts.some((p) => p.timedOut), interrupted: parts.some((p) => p.interrupted),
    ms: Date.now() - t0, text, tail: text.split('\n').filter((l) => l.trim()).slice(-12) };
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Runs one command with a hard timeout; output to logFile. Resolves { exit, timedOut, ms, tail }. */
export function runBounded(spec, { cwd, env, timeoutMs, logFile, signal }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ ${spec.label}\n`);
    const opts = { cwd, env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: true };
    const child = spec.shell ? spawn(spec.shell, { ...opts, shell: true }) : spawn(spec.cmd, spec.args, opts);
    let timedOut = false; let interrupted = false; let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1000, timeoutMs));
    const abort = () => { interrupted = true; killTree(child); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const done = (exit) => {
      if (settled) return; settled = true;
      clearTimeout(timer); try { fs.closeSync(out); } catch { /* closed */ }
      signal?.removeEventListener('abort', abort);
      const text = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      resolve({ exit, timedOut, interrupted, ms: Date.now() - t0, text, tail: text.split('\n').filter((l) => l.trim()).slice(-12) });
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
