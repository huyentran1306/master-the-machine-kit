import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Pages macOS can hand out right now. os.freemem() on macOS counts only "Pages free" and leaves out the
 * inactive/speculative cache the kernel reclaims instantly, so a healthy 16 GB Mac often reports <1 GB
 * and every code item would wait on LOW_RAM forever. Same idea as Activity Monitor's available memory.
 */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text || '')?.[1]) || 4096;
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text || '')?.[1]) || 0;
  const avail = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
  return avail > 0 ? avail * size : 0;
}

let memCache = { at: 0, bytes: 0 };
export function availableMemory({ platform = process.platform, readVmStat = () => execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000 }), now = Date.now() } = {}) {
  if (platform !== 'darwin') return os.freemem(); // Linux: MemAvailable; Windows: available physical memory.
  if (now - memCache.at < 5000 && memCache.bytes) return memCache.bytes;
  try {
    const bytes = parseVmStat(readVmStat());
    if (bytes) { memCache = { at: now, bytes }; return bytes; }
  } catch { /* fall back below */ }
  return os.freemem();
}

export function answerOnly(item, material = {}) {
  if (item.type === 'PI') return true;
  if (item.type !== 'TASK') return false;
  const text = [item.title, item.description, item.acceptanceCriteria, material.startInstruction].map(v => typeof v === 'string' ? v : JSON.stringify(v || '')).join(' ');
  const prose = text.replace(/\b(?:no|without|do not|don't)\s+(?:source\s+|code\s+)?(?:changes?|edits?|modifications?|implementation)(?:\s+(?:needed|required))?/gi, '');
  if (/\b(?:implement|fix|refactor|repair|debug)\b/i.test(prose)) return false;
  if (/\b(?:build|add|modify|change|update)\b.{0,50}\b(?:code|component|endpoint|function|feature|route|page|schema|test|app)\b/i.test(prose)) return false;
  const mvs = material.minimumVerificationScenarios;
  const hasMvs = mvs != null && !['', '[]', '{}', 'null', '""'].includes(JSON.stringify(mvs)) && !/^(?:none|n\/a|no (?:runnable )?(?:mvs|tests|scenarios)(?: to run)?)[.!]?$/i.test(String(mvs).trim());
  return !hasMvs && /\b(?:question|answer|values?|report[ -]only|calculate|compute|identify)\b/i.test(text);
}

export function dispatchPolicy(item, items, parallel = {}, freeBytes = availableMemory()) {
  const codeWorkers = items.filter(i => i.id !== item.id && i.local?.worktree && !(i.local?.answerOnly ?? answerOnly(i)) && !i.local?.parked && !i.local?.ready && !i.local?.submittedAt && !i.local?.receiptId).length;
  const maxCodeWorkers = Math.max(1, Math.floor(Number(parallel.maxCodeWorkers) || 5));
  const freeRamGB = freeBytes / 1024 ** 3;
  const reason = (item.local?.answerOnly ?? answerOnly(item)) ? null : codeWorkers >= maxCodeWorkers ? 'CODE_WORKER_LIMIT' : freeRamGB < 2.5 ? 'LOW_RAM' : null;
  return { allowed: !reason, reason, codeWorkers, maxCodeWorkers, freeRamGB, minFreeRamGB: 2.5 };
}

export function integrationGate(item) {
  return (item.local?.answerOnly ?? answerOnly(item)) ? 'schema only' : item.deadlineAt != null ? "item's own tests + typecheck" : 'full suite + typecheck; build if needed';
}

/** Promise pool: independent items overlap without unbounded network fan-out. */
export async function mapBounded(values, limit, fn) {
  const results = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, limit)) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= values.length) return;
      try { results[i] = await fn(values[i]); }
      catch (e) { results[i] = { ok: false, error: e.message }; }
    }
  }));
  return results;
}

/** Nonblocking FIFO leases. Keep one queue in the orchestrator's helper session. */
export class BuildQueue {
  constructor(max = 2) { this.max = Math.max(1, Math.floor(Number(max) || 2)); this.active = new Set(); this.waiting = []; }
  update(action, id) {
    if (action === 'release') { this.active.delete(id); this.waiting = this.waiting.filter(x => x !== id); }
    else if (action === 'acquire' && !this.active.has(id) && !this.waiting.includes(id)) this.waiting.push(id);
    while (this.active.size < this.max && this.waiting.length) this.active.add(this.waiting.shift());
    return { ok: true, granted: this.active.has(id), active: [...this.active], queue: [...this.waiting], maxBuilds: this.max };
  }
}
