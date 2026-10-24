import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const MAX_KEEP = 4 * 1024 * 1024; // keep at most the last 4 MB of output in memory

/**
 * Quotes one argument for a cmd.exe command line (the target program then parses it CRT-style).
 * Plain double quotes protect spaces and & | < > ^. An argument that itself contains a double
 * quote would toggle cmd's quote state, so it is caret-escaped as a whole instead.
 */
export function quoteWinArg(a) {
  const s = String(a);
  if (s === '') return '""';
  if (/^[\w\-.:/\\=@+,]+$/.test(s)) return s;
  const crt = `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  // cmd.exe expands %NAME% even inside double quotes, and before it handles carets. Caret mode
  // escapes embedded quotes; a caret right after each % turns %NAME% into the unknown variable
  // %^NAME%, which cmd leaves alone, and the caret is removed afterwards.
  if (!s.includes('"') && !s.includes('%')) return crt;
  return crt.replace(/([()\][!^"`<>&|;, *?])/g, '^$1').replace(/%(?=[^\s%^"])/g, '%^');
}

function quotePosixArg(a) {
  const s = String(a);
  return /^[\w\-.:/=@+,%]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command line mtm runs: one string is used as-is, several arguments are quoted one by one. */
export function commandLine(argv) {
  if (argv.length === 1) return String(argv[0]);
  return argv.map(IS_WIN ? quoteWinArg : quotePosixArg).join(' ');
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

/**
 * Runs a check the way a CI job would: no stdin, CI=true (test runners leave watch mode),
 * no colours, and on timeout the whole process tree is killed, so a hung runner cannot
 * block the agent. Resolves with { code, output, timedOut, ms, line }.
 */
/**
 * On Windows, the full path of a program when it is a real .exe/.com on PATH (or in cwd).
 * Such a program is started directly with its arguments, so cmd.exe never touches them
 * (no %VAR% expansion, no quote games). .cmd/.bat scripts (npm, mvn, gradlew.bat) need cmd.exe.
 */
export function resolveExe(cmd, cwd, env = process.env) {
  if (!IS_WIN) return null;
  const exts = ['.exe', '.com'];
  const hasExt = /\.[A-Za-z0-9]+$/.test(cmd);
  const names = hasExt ? [cmd] : exts.map((e) => cmd + e);
  const dirs = /[\\/]/.test(cmd) ? [cwd || process.cwd()] : [cwd || process.cwd(), ...String(env.PATH || env.Path || '').split(';').filter(Boolean)];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.resolve(d, n);
      if (exts.includes(path.extname(p).toLowerCase()) && fs.existsSync(p)) return p;
    }
    // A .cmd/.bat found before any .exe means the shell is needed.
    if (!hasExt && ['.cmd', '.bat'].some((e) => fs.existsSync(path.resolve(d, cmd + e)))) return null;
  }
  return null;
}

export function runCommand(argv, { cwd, timeoutMs = 6 * 60000, env = {} } = {}) {
  const line = commandLine(argv);
  const t0 = Date.now();
  const fullEnv = { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', ...env };
  const exe = argv.length > 1 ? resolveExe(String(argv[0]), cwd, fullEnv) : null;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timedOut = false;
    const opts = {
      cwd,
      detached: !IS_WIN,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: fullEnv,
    };
    const child = exe
      ? spawn(exe, argv.slice(1).map(String), opts)
      : IS_WIN || argv.length === 1
        ? spawn(line, { ...opts, shell: true })
        : spawn(String(argv[0]), argv.slice(1).map(String), opts);
    const add = (b) => {
      out += b;
      if (out.length > MAX_KEEP) out = `[mtm] earlier output dropped\n${out.slice(-MAX_KEEP)}`;
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, output: out, timedOut, ms: Date.now() - t0, line });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      out += `\n[mtm] timeout after ${Math.round(timeoutMs / 1000)}s: killed the process tree\n`;
      killTree(child);
      // Do not wait for grandchildren to close the pipes: give them a moment, then return.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(124);
      }, 1500);
    }, timeoutMs);
    // Windows reports some exit codes as unsigned 32-bit numbers (npm ENOENT: 4294963238 = -4058).
    child.on('close', (c) => finish(timedOut ? 124 : c == null ? 1 : c > 0x7fffffff ? c - 0x100000000 : c));
    child.on('error', (e) => { add(String(e)); finish(1); });
  });
}
