// File-queue request from a worker's shell to the orchestrator's runtime (the process that issued the item token).
// Used by bin/mtm-query.mjs (read tools and --ready) and by finish-answer.mjs --ready-token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function sendQuery(auth, body, { timeoutMs = 30000, pollMs = 100 } = {}) {
  fs.mkdirSync(auth.queueDir, { recursive: true });
  const id = crypto.randomUUID();
  const req = path.join(auth.queueDir, `${id}.request.json`);
  const res = path.join(auth.queueDir, `${id}.response.json`);
  fs.writeFileSync(req, JSON.stringify({ ...body, token: auth.token }) + '\n', { flag: 'wx' });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !fs.existsSync(res)) await new Promise((r) => setTimeout(r, pollMs));
  if (!fs.existsSync(res)) return { ok: false, error: 'QUERY_TIMEOUT' };
  const out = JSON.parse(fs.readFileSync(res, 'utf8'));
  try { fs.unlinkSync(res); } catch { /* already consumed */ }
  return out;
}

const warn = (out) => (out?.warnings?.length ? `\nWarnings:\n- ${out.warnings.join('\n- ')}` : '');

/** What the worker reads after the ready handshake. */
export function readyText(out = {}) {
  if (out.ok && out.shipping) return `READY CHECK PASSED: the kit is shipping ${String(out.sha || '').slice(0, 12)}.${warn(out)}\n${out.next || 'Reply STATUS READY and stop.'}`;
  if (out.ok) return `READY CHECK PASSED.${warn(out)}\n${out.next || 'Reply STATUS READY.'}`;
  if (out.error === 'NOT_READY') return `NOT READY (${(out.errors || []).length}):\n- ${(out.errors || []).join('\n- ')}${warn(out)}\n${out.next || 'Fix, commit and run this command again.'}`;
  if (out.error === 'QUERY_TIMEOUT') return 'READY CHECK TIMEOUT: the kit did not answer in time. Reply STATUS READY with your commit; the orchestrator ships it.';
  return `READY CHECK ERROR ${out.error || ''}${out.message ? `: ${out.message}` : ''}\nReply STATUS READY with your commit; the orchestrator ships it.`;
}
