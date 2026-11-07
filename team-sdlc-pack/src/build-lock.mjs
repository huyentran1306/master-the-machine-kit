#!/usr/bin/env node
// Build slots that workers take themselves: node <pack>/src/build-lock.mjs [--slots N] [--dir D] -- <command...>
// Waits for one of N slot directories under the main checkout's .mtm-notes/build-slots (mkdir is atomic on
// every OS), runs the command with inherited stdio, frees the slot on exit and exits with its code.
// Before this, a worker asked the orchestrator for build_slot and waited for the relayed grant: in the
// H6GGOXRM practice match CR-01 sat idle 11 minutes for a grant its build then used for 2.4 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const realPath = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };

/** Main checkout root of a worktree (or of the checkout itself): its git common dir's parent. */
export function slotDirFor(cwd) {
  let dir = realPath(cwd);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    if (fs.existsSync(dotgit)) {
      let common = realPath(dotgit);
      if (fs.statSync(dotgit).isFile()) {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
        if (m) {
          const gitdir = realPath(path.resolve(dir, m[1].trim()));
          const c = path.join(gitdir, 'commondir');
          common = fs.existsSync(c) ? realPath(path.resolve(gitdir, fs.readFileSync(c, 'utf8').trim())) : gitdir;
        }
      }
      return path.join(realPath(path.dirname(common)), '.mtm-notes', 'build-slots');
    }
    const up = path.dirname(dir);
    if (up === dir) return path.join(realPath(cwd), '.mtm-notes', 'build-slots');
    dir = up;
  }
}

/** Takes a free slot, or frees one whose owner died. Returns the slot path. Never waits past maxWaitMs. */
export async function acquire(dir, slots, { maxWaitMs = 60000, pollMs = 500, owner = process.pid } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const until = Date.now() + maxWaitMs;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const slot = path.join(dir, `slot-${i}`);
      try {
        fs.mkdirSync(slot);
        fs.writeFileSync(path.join(slot, 'owner'), `${owner}\n${new Date().toISOString()}\n`);
        return slot;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number((() => { try { return fs.readFileSync(path.join(slot, 'owner'), 'utf8').split('\n')[0]; } catch { return 0; } })());
        let age = 0; try { age = Date.now() - fs.statSync(slot).mtimeMs; } catch { /* just freed */ }
        if ((pid && !alive(pid)) || (!pid && age > 10000)) fs.rmSync(slot, { recursive: true, force: true }); // stale
      }
    }
    if (Date.now() >= until) return null; // never block a deadline on the lock: run without a slot
    await sleep(pollMs);
  }
}

export function release(slot) { if (slot) fs.rmSync(slot, { recursive: true, force: true }); }

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const opts = sep >= 0 ? argv.slice(0, sep) : [];
  const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
  if (!cmd.length) { console.error('usage: build-lock.mjs [--slots 2] [--max-wait-ms 120000] [--fail-closed] [--dir D] -- <command...>'); process.exit(2); }
  const get = (k, d) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : d; };
  const slots = Math.max(1, Number(get('--slots', process.env.MTM_MAX_BUILDS || 2)) || 2);
  const maxWaitMs = Math.max(0, Number(get('--max-wait-ms', process.env.MTM_BUILD_LOCK_WAIT_MS || 120000)) || 120000);
  const failClosed = opts.includes('--fail-closed');
  const dir = get('--dir', slotDirFor(process.cwd()));
  const t0 = Date.now();
  const slot = await acquire(dir, slots, { maxWaitMs });
  const waited = Math.round((Date.now() - t0) / 100) / 10;
  // Default: a worker never stalls on capacity. After the bounded wait it runs without a slot (the RAM
  // guard still stops new workers). --fail-closed keeps the strict behaviour (exit 75, nothing started).
  if (!slot && failClosed) {
    console.error(`[build-lock] no free slot after ${waited}s: command not started (capacity exit 75; retry later)`);
    process.exit(75);
  }
  console.error(slot ? `[build-lock] slot ${path.basename(slot)} after ${waited}s` : `[build-lock] no free slot after ${waited}s: running anyway so the item does not stall`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  const stop = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('exit', (code, signal) => { release(slot); process.exit(code ?? (signal ? 1 : 0)); });
  child.on('error', (e) => { release(slot); console.error(`[build-lock] ${e.message}`); process.exit(127); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
