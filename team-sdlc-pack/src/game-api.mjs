// Digital Cuder API: Start work and Submit (bearer token, JSON, strict schemas).
// Every call is wrapped by the caller's log(phase, ...) so GAME_MASTER_API REQUESTED is written
// immediately before the request and SUCCEEDED/FAILED immediately after.
import { request } from './http.mjs';
import { sleep } from './util.mjs';
import { until, SUBMIT_LIMITS } from './deadline.mjs';

export const DEFAULT_PATHS = {
  START_WORK: '/api/v1/matches/{matchUuid}/backlogs/start',
  SUBMIT: '/api/v1/matches/{matchUuid}/submissions',
};

export function operationUrl(apiBase, operations, op, matchUuid) {
  const tpl = operations?.find((o) => o.operation === op)?.pathTemplate || DEFAULT_PATHS[op];
  const p = tpl.replace('{matchUuid}', encodeURIComponent(matchUuid)).replace('{matchId}', encodeURIComponent(matchUuid));
  return new URL(p, apiBase).toString();
}

function apiError(res) {
  const e = res.json?.error || {};
  return { httpStatus: res.status, code: e.code || `HTTP_${res.status}`, message: e.message || res.text?.slice(0, 300) || '', details: e.details || null, requestId: res.requestId };
}

/** POST start. Returns { ok, httpStatus, replay, data, error }. */
export async function startWork({ url, bearer, allowedOrigins, backlogItemKey, log, timeoutMs = 20000, beforeRetry = null }) {
  const reqInfo = { method: 'POST', url, backlogId: backlogItemKey };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1 && beforeRetry) {
      const stop = await beforeRetry(attempt);
      if (stop) return { ok: false, uncertain: true, halted: stop, ...lastErr, error: lastErr };
    }
    await log('REQUESTED', reqInfo);
    let res;
    try {
      res = await request(url, {
        method: 'POST', allowedOrigins, timeoutMs,
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ backlogItemKey }),
      });
    } catch (e) {
      await log('FAILED', reqInfo, null, e);
      lastErr = { httpStatus: null, code: e.code || 'NETWORK', message: e.message };
      if (attempt < 3) await sleep(1500 * attempt);
      continue;
    }
    const ok = res.status === 200 || res.status === 201;
    await log(ok ? 'SUCCEEDED' : 'FAILED', reqInfo, res);
    if (ok) return { ok: true, httpStatus: res.status, replay: !!res.json?.replay || res.status === 200, data: res.json || {}, requestId: res.requestId };
    lastErr = apiError(res);
    if (res.status >= 500 || res.status === 429) {
      if (attempt < 3) await sleep(Number(res.headers.get('retry-after')) * 1000 || 1500 * attempt);
      continue;
    }
    return { ok: false, ...lastErr, error: lastErr };
  }
  return { ok: false, uncertain: true, ...lastErr, error: lastErr };
}

/**
 * POST submission with a fixed Idempotency-Key = clientSubmissionId and a fixed body.
 * Retries timeouts/5xx/429 with the SAME key and body until budgetMs runs out.
 * beforeRetry(attempt) runs before every retry (not the first send); a non-empty return value
 * (a reason string) stops retrying: the outcome stays UNCERTAIN with `halted` set, body untouched.
 * Returns { outcome: 'ACCEPTED'|'REJECTED'|'UNCERTAIN', receipt, httpStatus, error, replay, halted? }.
 */
export async function submit({ url, bearer, allowedOrigins, body, log, budgetMs = SUBMIT_LIMITS.retryMs, acceptedStatuses = ['ACCEPTED', 'RECEIVED'], timeoutMs = 30000, beforeRetry = null }) {
  // One deadline covers retries, status refresh, backoff, redirects and response bodies.
  const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.min(budgetMs, SUBMIT_LIMITS.retryMs)) : SUBMIT_LIMITS.retryMs;
  const deadlineAt = Date.now() + budget;
  const reqInfo = { method: 'POST', url, backlogId: body.backlogItemKey };
  const bodyText = JSON.stringify(body);
  let last = { outcome: 'UNCERTAIN', httpStatus: null, error: { code: 'TIMEOUT', message: 'Submit deadline reached; replay the same body and key.' } };
  for (let attempt = 1; ; attempt++) {
    if (Date.now() >= deadlineAt) return last;
    if (attempt > 1 && beforeRetry) {
      let stop;
      try {
        stop = await until(Promise.resolve().then(() => beforeRetry(attempt)), Math.min(deadlineAt, Date.now() + SUBMIT_LIMITS.refreshMs));
      } catch {
        return { ...last, outcome: 'UNCERTAIN', halted: 'Status refresh did not finish; replay after checking match status.' };
      }
      if (stop) return { ...last, outcome: 'UNCERTAIN', halted: stop };
    }
    if (Date.now() >= deadlineAt) return last;
    await log('REQUESTED', reqInfo);
    let res;
    try {
      res = await request(url, {
        method: 'POST', allowedOrigins, timeoutMs, deadlineAt,
        headers: {
          authorization: `Bearer ${bearer}`, accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': body.clientSubmissionId,
        },
        body: bodyText,
      });
    } catch (e) {
      await log('FAILED', reqInfo, null, e);
      last = { outcome: 'UNCERTAIN', httpStatus: null, error: { code: e.code || 'NETWORK', message: e.message } };
      const wait = Math.min(8000, 1000 * 2 ** (attempt - 1));
      if (Date.now() + wait >= deadlineAt) return last;
      await sleep(wait);
      continue;
    }
    if (res.status === 201 || res.status === 200) {
      const sub = res.json?.submission || res.json || {};
      const receiptId = sub.id || res.json?.receiptId || sub.receiptId || null;
      const status = sub.status || res.json?.status || null;
      const replay = res.headers.get('idempotent-replay') === 'true';
      if (receiptId && (!status || acceptedStatuses.includes(String(status).toUpperCase()))) {
        await log('SUCCEEDED', reqInfo, res);
        return { outcome: 'ACCEPTED', httpStatus: res.status, replay, receipt: { receiptId: String(receiptId), status, scoreStatus: sub.scoreStatus || null, receivedAt: sub.receivedAt || null, attemptNo: sub.attemptNo ?? null, requestId: res.requestId } };
      }
      await log('FAILED', reqInfo, res);
      return { outcome: 'UNCERTAIN', httpStatus: res.status, error: { code: 'NO_RECEIPT', message: `HTTP ${res.status} without an acceptance receipt (status ${status ?? 'missing'})` } };
    }
    await log('FAILED', reqInfo, res);
    const err = apiError(res);
    if (res.status >= 500 || res.status === 429) {
      last = { outcome: 'UNCERTAIN', httpStatus: res.status, error: err };
      const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(8000, 1000 * 2 ** (attempt - 1));
      if (Date.now() + wait >= deadlineAt) return last;
      await sleep(wait);
      continue;
    }
    return { outcome: 'REJECTED', httpStatus: res.status, error: err };
  }
}
