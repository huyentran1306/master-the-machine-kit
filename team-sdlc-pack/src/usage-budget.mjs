// Codex usage budget: read the account's 5-hour window from Codex's own rollout files and project it to the end
// of the match. 0OD2WHNM (ChatGPT Plus, every lane on gpt-6.1-sol) used 100% of the 5-hour window 22 minutes into a
// 40-minute match; every agent stopped and 12 of 14 items were lost. The projection lets dispatch move new workers to
// cheaper models before the window runs out instead of after. Read-only: nothing here calls a model or the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;

function sessionDirs(home, now) {
  const root = path.join(home, 'sessions');
  const dirs = [];
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86400000);
    const ymd = [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
    dirs.push(path.join(root, ...ymd));
  }
  return dirs;
}

function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/**
 * The newest rate-limit sample Codex wrote into any recent rollout, or null.
 * { usedPercent, windowMinutes, resetsAt (ms), weekPercent, observedAt (ms) }
 */
export function readCodexUsage({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), now = Date.now(), maxFiles = 6 } = {}) {
  const files = [];
  for (const dir of sessionDirs(home, now)) {
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try { files.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* gone */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let best = null;
  for (const { file } of files.slice(0, maxFiles)) {
    const lines = tail(file).split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"primary"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const rl = d?.payload?.rate_limits; const p = rl?.primary;
      if (!p || typeof p.used_percent !== 'number') continue;
      const observedAt = Date.parse(d.timestamp || '') || 0;
      if (!best || observedAt > best.observedAt) {
        best = { usedPercent: p.used_percent, windowMinutes: p.window_minutes ?? null, resetsAt: p.resets_at ? p.resets_at * 1000 : null,
          weekPercent: typeof rl.secondary?.used_percent === 'number' ? rl.secondary.used_percent : null, observedAt };
      }
      break;
    }
  }
  return best;
}

/**
 * Budget tier from the current sample and the sample taken when the game started.
 * 0 = normal, 1 = tight (projected over softPct by the end of the match), 2 = critical (already over hardPct).
 */
export function usageTier({ usage, base, now = Date.now(), endsAt, softPct = 85, hardPct = 92, minElapsedMs = 180000 } = {}) {
  if (!usage) return { tier: 0, projected: null, reason: 'no usage sample' };
  const used = usage.usedPercent;
  if (used >= hardPct) return { tier: 2, projected: used, reason: `5-hour window at ${used}%` };
  let projected = used;
  if (base && endsAt && now - base.at >= minElapsedMs && used >= base.pct) {
    const rate = (used - base.pct) / (now - base.at); // percent per ms
    const resetsAt = usage.resetsAt && usage.resetsAt > now ? usage.resetsAt : null;
    if (resetsAt && resetsAt < endsAt) projected = Math.max(used + rate * (resetsAt - now), rate * (endsAt - resetsAt));
    else projected = used + rate * Math.max(0, endsAt - now);
  }
  projected = Math.round(projected);
  if (projected > softPct || used > softPct) return { tier: 1, projected, reason: `5-hour window at ${used}%, projected ${projected}% by the end of the match` };
  return { tier: 0, projected, reason: `5-hour window at ${used}%, projected ${projected}%` };
}
