// Append-only writer for <matchId>.progress.ndjson: the only channel mtm-player reads.
// One UTF-8 JSON object per line; envelope = schemaVersion 1 + current playerSessionId + type.
// No timestamps or extra fields (the schema forbids them). Invalid events are refused, never written.
import fs from 'node:fs';
import path from 'node:path';
import { validateProgressEvent } from './schema.mjs';

// mtm-player refuses to read a progress log larger than 256 KiB (PROGRESS_LOG_TOO_LARGE) and ignores
// any single line over 4 KiB. The dashboard, readiness and monitoring all go through that reader, so
// the budget is a hard contract, not a nicety: optional telemetry is dropped before it can push the
// file over. A 40-minute match that logs every poll would otherwise reach ~260 KiB.
export const LOG_HARD_LIMIT = 256 * 1024;
export const LOG_SOFT_LIMIT = 180 * 1024;
export const LINE_LIMIT = 4 * 1024;

/**
 * Rules mtm-player applies on top of the published JSON schema. An event that breaks one of them is
 * silently ignored by the Player, so the helper refuses to write it instead.
 */
export function playerRuleErrors(e) {
  const errors = [];
  if (e.type === 'BACKLOG_TESTS') {
    const { required, executed, passed, failed, skipped, status } = e;
    if (executed !== passed + failed + skipped) errors.push(`executed (${executed}) must equal passed + failed + skipped (${passed + failed + skipped})`);
    if (status === 'NOT_RUN' && executed !== 0) errors.push('NOT_RUN requires executed = 0');
    if (status === 'PASSED' && !(executed > 0 && failed === 0 && executed >= required)) errors.push(`PASSED requires executed > 0, failed = 0 and executed >= required (${executed} >= ${required})`);
    if (status === 'FAILED' && !(failed > 0)) errors.push('FAILED requires failed > 0');
  }
  if (e.type === 'GAME_MASTER_API') {
    if (e.phase === 'REQUESTED' && e.httpStatus !== null) errors.push('REQUESTED requires httpStatus null');
    if (e.phase === 'SUCCEEDED' && !(e.httpStatus >= 200 && e.httpStatus < 300)) errors.push(`SUCCEEDED requires a 2xx httpStatus (got ${e.httpStatus})`);
    if (e.phase === 'FAILED' && e.httpStatus !== null && e.httpStatus < 400) errors.push(`FAILED requires httpStatus null or >= 400 (got ${e.httpStatus})`);
  }
  if (e.type === 'NETWORK_ACTIVITY' && (e.method === null || e.origin === null || e.path === null)) {
    errors.push('NETWORK_ACTIVITY requires method, origin and path (none may be null)');
  }
  if (e.type === 'BACKLOG_STATUS' && e.status === 'SUBMITTED' && (e.revision === null || e.receiptId === null)) {
    // The Player ignores such a line, so the item would keep its previous status on the dashboard
    // even though the submission went through. Refuse to write it and make the caller pass both.
    errors.push('SUBMITTED requires both revision and receiptId');
  }
  if (e.type === 'MODEL_USAGE') {
    if (e.cachedInputTokens > e.inputTokens) errors.push(`cachedInputTokens (${e.cachedInputTokens}) may not exceed inputTokens (${e.inputTokens})`);
    if (e.reasoningTokens > e.outputTokens) errors.push(`reasoningTokens (${e.reasoningTokens}) may not exceed outputTokens (${e.outputTokens})`);
  }
  if (e.type === 'GAME_MASTER_API' || e.type === 'NETWORK_ACTIVITY') {
    // The Player wants a bare origin — https (or loopback http), no credentials, no path/query.
    if (typeof e.origin === 'string') {
      let u = null;
      try {
        u = new URL(e.origin);
      } catch {
        errors.push(`origin is not a URL: ${e.origin}`);
      }
      if (u) {
        const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
        if (u.protocol !== 'https:' && !loopback) errors.push(`origin must be https or loopback http (got ${u.protocol}//${u.hostname})`);
        if (u.username || u.password) errors.push('origin may not carry credentials');
        if (u.origin !== e.origin) errors.push(`origin must be the bare origin (expected ${u.origin})`);
      }
    }
    if (typeof e.path === 'string' && (!e.path.startsWith('/') || /[?#\\]/.test(e.path))) {
      errors.push('path must start with / and carry no query, fragment or backslash');
    }
  }
  return errors;
}

// The Player drops any event whose text looks like a leaked credential.
const CREDENTIAL_LIKE = /(?:authorization\s*:\s*bearer\s+\S{8,}|\b(?:password|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*\S{8,}|\b(?:gm|gh[pousr])_[A-Za-z0-9_-]{12,})/i;

export function scrubSummary(text) {
  let s = String(text ?? '');
  if (!CREDENTIAL_LIKE.test(s)) return s;
  // The placeholder must stay under 8 characters: the Player's pattern matches any 8+ run after the label.
  s = s.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1***')
    .replace(/((?:password|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*)\S+/gi, '$1***')
    .replace(/\b(?:gm|gh[pousr])_[A-Za-z0-9_-]{12,}/g, '***');
  return CREDENTIAL_LIKE.test(s) ? 'Details omitted (looked like a credential).' : s;
}

export class ProgressLog {
  constructor({ file, playerSessionId, maxQueue = 500 }) {
    if (!file) throw new Error('progress log file is required');
    if (!playerSessionId) throw new Error('playerSessionId is required');
    this.file = file;
    this.playerSessionId = playerSessionId;
    this.queue = [];
    this.maxQueue = maxQueue;
    this.lastError = null;
    this.written = 0;
    this.dropped = 0;
    try {
      this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      this.bytes = 0;
    }
  }

  /** Bytes already in the file plus everything queued. */
  get size() {
    return this.bytes + this.queue.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
  }

  get pressure() {
    const size = this.size;
    if (size >= LOG_HARD_LIMIT) return 'OVER';
    if (size >= LOG_SOFT_LIMIT) return 'HIGH';
    return 'OK';
  }

  /** Builds the envelope in canonical key order. */
  envelope(event) {
    const { schemaVersion, playerSessionId, type, ...rest } = event;
    return { schemaVersion: 1, playerSessionId: this.playerSessionId, type, ...rest };
  }

  /**
   * Validate + append. `optional: true` marks telemetry the Player can live without (poll/refresh
   * pairs, network/tool activity): it is dropped once the file approaches the Player's 256 KiB wall.
   * Returns { ok, queued, dropped, event } or throws on schema / Player-rule errors.
   */
  append(event, { optional = false } = {}) {
    const full = this.envelope(event);
    // The Player ignores any line whose text looks like a leaked credential, so a mandatory event
    // must never be lost to one: scrub the free-text fields instead of refusing the event.
    for (const field of ['summary', 'title']) {
      if (typeof full[field] === 'string') full[field] = scrubSummary(full[field]);
    }
    const errors = [...validateProgressEvent(full), ...playerRuleErrors(full)];
    if (errors.length) {
      const err = new Error(`progress event rejected: ${errors.slice(0, 5).join('; ')}`);
      err.code = 'PROGRESS_SCHEMA';
      err.errors = errors;
      throw err;
    }
    const line = `${JSON.stringify(full)}\n`;
    if (Buffer.byteLength(line, 'utf8') > LINE_LIMIT) {
      const err = new Error(`progress event is ${Buffer.byteLength(line, 'utf8')} bytes; mtm-player ignores any line over ${LINE_LIMIT}`);
      err.code = 'PROGRESS_LINE_TOO_LARGE';
      throw err;
    }
    if (optional && this.size + Buffer.byteLength(line, 'utf8') > LOG_SOFT_LIMIT) {
      this.dropped += 1;
      return { ok: true, queued: false, dropped: true, event: full };
    }
    this.queue.push(line);
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    const flushed = this.flush();
    return { ok: flushed, queued: !flushed, event: full };
  }

  /** Writes queued lines in order; keeps the rest on failure. */
  flush() {
    if (!this.queue.length) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = this.queue.join('');
      fs.appendFileSync(this.file, payload, { encoding: 'utf8' });
      this.written += this.queue.length;
      this.bytes += Buffer.byteLength(payload, 'utf8');
      this.queue = [];
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  get unavailable() {
    return this.queue.length > 0;
  }

  /** All parsed events in the file (any session), malformed lines skipped. */
  static read(file) {
    if (!file || !fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }
}
