// Append-only writer for <matchId>.progress.ndjson: the only channel mtm-player reads.
// One UTF-8 JSON object per line; envelope = schemaVersion 1 + current playerSessionId + type.
// No timestamps or extra fields (the schema forbids them). Invalid events are refused, never written.
import fs from 'node:fs';
import path from 'node:path';
import { validateProgressEvent } from './schema.mjs';

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
  }

  /** Builds the envelope in canonical key order. */
  envelope(event) {
    const { schemaVersion, playerSessionId, type, ...rest } = event;
    return { schemaVersion: 1, playerSessionId: this.playerSessionId, type, ...rest };
  }

  /** Validate + append. Returns { ok, queued, event } or throws on schema errors. */
  append(event) {
    const full = this.envelope(event);
    const errors = validateProgressEvent(full);
    if (errors.length) {
      const err = new Error(`progress event rejected by schema: ${errors.slice(0, 5).join('; ')}`);
      err.code = 'PROGRESS_SCHEMA';
      err.errors = errors;
      throw err;
    }
    const line = `${JSON.stringify(full)}\n`;
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
      fs.appendFileSync(this.file, this.queue.join(''), { encoding: 'utf8' });
      this.written += this.queue.length;
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
