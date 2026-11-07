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

const meaningfulMvs = value => value != null && !['', '[]', '{}', 'null', '""'].includes(JSON.stringify(value))
  && !/^(?:none|n\/a|no (?:runnable )?(?:mvs|tests|scenarios)(?: to run)?)[.!]?$/i.test(String(value).trim());
const objectKeys = value => {
  const out = [];
  const walk = v => { if (!v || typeof v !== 'object') return; for (const [k, child] of Object.entries(v)) { out.push(k.toLowerCase().replace(/[^a-z0-9]/g, '')); walk(child); } };
  walk(value); return out;
};

/** Starting-lane hint only. The worker reads the full item; the integration gate later trusts the diff. */
export function answerClassification(item, material = {}) {
  if (meaningfulMvs(material.minimumVerificationScenarios)) return { answerOnly: false, classifiedBy: 'structure', reason: 'minimumVerificationScenarios' };
  const contractKeys = objectKeys(material.submitTemplate);
  for (const [name, raw] of Object.entries(material.files || {})) {
    if (!/submit.*schema\.json$/i.test(name)) continue;
    try { contractKeys.push(...objectKeys(typeof raw === 'string' ? JSON.parse(raw) : raw)); } catch { /* malformed schema is handled elsewhere */ }
  }
  if (contractKeys.some(k => ['testresults', 'evidence', 'evidencerows'].includes(k))) return { answerOnly: false, classifiedBy: 'structure', reason: 'submit contract carries verification rows' };
  const required = material.requiredEvidence || [];
  if (required.some(e => e?.strict !== false && /\.(?:log|png|jpe?g|webp|gif)$/i.test(String(e?.name || e)))) return { answerOnly: false, classifiedBy: 'structure', reason: 'required verification artifact' };
  if (Object.entries(material.files || {}).some(([name, body]) => /\.(?:mjs|cjs|sh|ps1)$/i.test(name) && (typeof body === 'string' && (/^#!/.test(body) || /\b(?:process\.exit|assert\s*\()/i.test(body))))) {
    return { answerOnly: false, classifiedBy: 'structure', reason: 'shipped runner script' };
  }
  if (item.type === 'PI') return { answerOnly: true, classifiedBy: 'hint', reason: 'PI starts in answer lane; worker and diff decide scope' };
  if (item.type !== 'TASK') return { answerOnly: false, classifiedBy: 'hint', reason: 'code-item type' };
  const text = [item.title, item.description, item.acceptanceCriteria, material.startInstruction].map(v => typeof v === 'string' ? v : JSON.stringify(v || '')).join(' ');
  const prose = text.replace(/\b(?:no|without|do not|don't)\s+(?:source\s+|code\s+)?(?:changes?|edits?|modifications?|implementation)(?:\s+(?:needed|required))?/gi, '');
  const answerHint = /\b(?:question|answer|values?|report[ -]only|calculate|compute|identify)\b/i.test(text);
  const codeHint = /\b(?:implement|fix|refactor|repair|debug)\b/i.test(prose)
    || /\b(?:build|add|modify|change|update)\b.{0,50}\b(?:code|component|endpoint|function|feature|route|page|schema|test|app)\b/i.test(prose);
  return { answerOnly: answerHint || !codeHint && /\bno code changes required\b/i.test(text), classifiedBy: 'hint', reason: answerHint ? 'answer wording' : codeHint ? 'code wording' : 'no answer hint' };
}

export function answerOnly(item, material = {}) { return answerClassification(item, material).answerOnly; }

export function dispatchPolicy(item, items, parallel = {}, freeBytes = availableMemory()) {
  const codeWorkers = items.filter(i => i.id !== item.id && i.local?.worktree && !(i.local?.answerOnly ?? answerOnly(i)) && !i.local?.parked && !i.local?.ready && !i.local?.submittedAt && !i.local?.receiptId).length;
  const maxCodeWorkers = Math.max(1, Math.floor(Number(parallel.maxCodeWorkers) || 6));
  const freeRamGB = freeBytes / 1024 ** 3;
  const isAnswer = item.local?.answerOnly ?? answerOnly(item);
  const answerWorkers = items.filter(i => i.id !== item.id && i.type !== 'PI' && (i.local?.answerOnly ?? answerOnly(i)) && i.local?.worktree && !i.local?.parked && !i.local?.ready && !i.local?.submittedAt && !i.local?.receiptId).length;
  const maxAnswerWorkers = Math.max(1, Math.floor(Number(parallel.maxAnswerWorkers) || 6));
  const minFreeRamGB = item.deadlineAt != null || item.local?.parked || item.local?.orphaned ? 1.5 : 2.5;
  // Codex caps open threads per session (config/codex.toml max_concurrent_threads_per_session, root included).
  // Past it spawn_agent fails and the item waits for a retry after the next wait_agent, in no particular
  // order. Queue here instead, by rank, and keep the last 2 threads for PI, deadline items and resumes.
  const liveWorkers = items.filter(i => i.id !== item.id && i.local?.worktree && !i.local?.parked && !i.local?.ready && !i.local?.submittedAt && !i.local?.receiptId).length;
  const maxWorkerThreads = Math.max(2, Math.floor(Number(parallel.maxWorkerThreads) || 14));
  const urgent = item.type === 'PI' || item.deadlineAt != null || !!item.local?.parked || !!item.local?.orphaned;
  const threadCap = urgent ? maxWorkerThreads : maxWorkerThreads - 2;
  const reason = liveWorkers >= threadCap ? 'THREAD_LIMIT'
    : item.type === 'PI' ? null : isAnswer ? answerWorkers >= maxAnswerWorkers ? 'ANSWER_WORKER_LIMIT' : null : codeWorkers >= maxCodeWorkers ? 'CODE_WORKER_LIMIT' : freeRamGB < minFreeRamGB ? 'LOW_RAM' : null;
  return { allowed: !reason, reason, codeWorkers, maxCodeWorkers, answerWorkers, maxAnswerWorkers, liveWorkers, maxWorkerThreads, freeRamGB, minFreeRamGB };
}

export function integrationGate(item, { codeChanged } = {}) {
  if (codeChanged === false) return 'schema only';
  if (codeChanged === true) return item.deadlineAt != null ? "item's own tests + typecheck" : 'full suite + typecheck; build if needed';
  return 'schema only unless the worker diff changes the app; then tests + typecheck';
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
