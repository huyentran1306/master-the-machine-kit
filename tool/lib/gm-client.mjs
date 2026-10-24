import { spawn, spawnSync } from 'node:child_process';
import { getPath, parseTime, clip, sleep, hashText } from './util.mjs';

export class GmError extends Error {}
/** Wrong or missing configuration: retrying cannot help. */
export class ConfigError extends GmError {}

export const ITEM_TYPES = ['PI', 'BUG', 'CR', 'TASK'];

export const API_DEFAULTS = {
  // Match phases. The rules use WAITING/RUNNING/PAUSED/FINISHED; extend in gm.config.json "states".
  finishedStates: ['FINISHED', 'ENDED', 'COMPLETED', 'CLOSED', 'OVER'],
  pausedStates: ['PAUSED'],
  // A submission status in this list means the item is done (no second submit).
  doneStatuses: ['ACCEPTED', 'SUBMITTED', 'RECEIVED', 'QUEUED', 'GRADING', 'GRADED', 'PASSED', 'FAILED'],
  acceptedValues: ['ACCEPTED', 'SUBMITTED', 'RECEIVED', 'QUEUED', 'OK', 'SUCCESS'],
  // A duplicate is a 409 (or a 2xx) whose text says so, or an explicit status value. Validation
  // wording such as "fix and resubmit" must never count: that refusal recorded nothing.
  duplicatePattern: 'already (been )?submitted|duplicate submission|already has a submission',
  duplicateValues: ['ALREADY_SUBMITTED', 'DUPLICATE'],
  alreadyStartedPattern: 'already (started|working|in progress)',
};

function parseBody(text, status, headers) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: keep raw text */ }
  return { status, json, text, date: headers?.get?.('date') ?? null };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

function defaultExec(cmd, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error(`exec timed out after ${timeoutMs / 1000}s: ${cmd}`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    // A CLI that exits before reading its input must not crash mtm (EPIPE/EOF on stdin).
    child.stdin.on('error', () => {});
    if (body !== undefined) child.stdin.write(JSON.stringify(body));
    child.stdin.end();
  });
}

/** Explains the usual corporate-network failures instead of a bare "fetch failed". */
export function describeNetworkError(e) {
  const code = e?.cause?.code || e?.code || '';
  const host = e?.cause?.hostname || '';
  let hint = '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(code)) hint = ' (TLS inspection? set NODE_OPTIONS=--use-system-ca or NODE_EXTRA_CA_CERTS)';
  else if (code === 'ENOTFOUND') hint = ` (DNS: host ${host || 'name'} not found; check baseUrl or VPN)`;
  else if (code === 'ECONNREFUSED') hint = ' (nothing listening: wrong port, or the server is down)';
  else if (code === 'UND_ERR_CONNECT_TIMEOUT' || e?.name === 'AbortError') hint = ' (timed out: proxy or firewall?)';
  return `${e?.message || e}${code ? ` [${code}]` : ''}${hint}`;
}

async function retry(fn, attempts, shouldRetry) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (i < attempts - 1 && shouldRetry(null, r)) { last = r; await sleep(500 * (i + 1)); continue; }
      return r;
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !shouldRetry(e, null)) throw e;
      await sleep(500 * (i + 1));
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

const networkOnly = (e) => !!e && !(e instanceof ConfigError);
const networkOr5xx = (e, r) => (!!e && !(e instanceof ConfigError)) || (r && r.status >= 500);
const up = (v) => (v == null || v === '' ? null : String(v).toUpperCase());

export function normalizeItem(raw, m = {}) {
  const id = String(getPath(raw, m.id || 'id') ?? '');
  // The rules guarantee ids like {TYPE}-{number}; prefer the prefix over a free-text type field.
  const prefix = id.split('-')[0].toUpperCase();
  const field = up(getPath(raw, m.type || 'type'));
  const type = ITEM_TYPES.includes(prefix) ? prefix : (field || prefix);
  const revealedAt = parseTime(getPath(raw, m.revealedAt || 'revealedAt'));
  let deadlineAt = parseTime(getPath(raw, m.deadlineAt || 'deadlineAt'));
  let deadlineEstimated = false;
  const deadlineMinutes = Number.parseFloat(getPath(raw, m.deadlineMinutes || 'deadlineMinutes'));
  if (deadlineAt == null && Number.isFinite(deadlineMinutes) && revealedAt != null) {
    deadlineAt = revealedAt + deadlineMinutes * 60000; // estimate: ignores pauses, so never a hard refusal
    deadlineEstimated = true;
  }
  const title = getPath(raw, m.title || 'title') ?? '';
  const description = getPath(raw, m.description || 'description') ?? '';
  return {
    id,
    type,
    title,
    description,
    state: up(getPath(raw, m.state || 'state')),
    maxPoints: getPath(raw, m.maxPoints || 'maxPoints') ?? null,
    revealedAt,
    deadlineAt,
    deadlineEstimated,
    submissionStatus: up(getPath(raw, m.submissionStatus || 'submission.status')),
    result: up(getPath(raw, m.result || 'submission.result')),
    score: getPath(raw, m.score || 'submission.score') ?? null,
    failReason: getPath(raw, m.failReason || 'submission.detail') ?? null,
    specHash: hashText(`${title}\n${typeof description === 'string' ? description : JSON.stringify(description)}`),
    raw,
  };
}

export function normalizeMatch(resp, map = {}, localNow = Date.now(), states = API_DEFAULTS) {
  const j = resp.json;
  if (!j || typeof j !== 'object') {
    return { status: 'UNKNOWN', unparsed: true, rawText: resp.text, items: [], serverNow: localNow, offsetMs: 0, clock: 'local' };
  }
  const mapErrors = [];
  let rawItems = getPath(j, map.items ?? 'items');
  if (rawItems === undefined) { mapErrors.push(`items path "${map.items ?? 'items'}" not found`); rawItems = []; }
  if (rawItems && !Array.isArray(rawItems) && typeof rawItems === 'object') rawItems = Object.values(rawItems);
  const statusRaw = getPath(j, map.matchStatus ?? 'status');
  if (statusRaw === undefined) mapErrors.push(`status path "${map.matchStatus ?? 'status'}" not found`);
  let serverTime = parseTime(getPath(j, map.serverTime ?? 'serverTime'));
  let clock = 'server';
  if (serverTime == null && resp.date) { serverTime = parseTime(resp.date); clock = 'http-date'; }
  if (serverTime == null) clock = 'local';
  const status = String(statusRaw ?? 'UNKNOWN').toUpperCase();
  return {
    status,
    finished: states.finishedStates.includes(status),
    paused: states.pausedStates.includes(status),
    serverNow: serverTime ?? localNow,
    offsetMs: serverTime ? serverTime - localNow : 0,
    clock,
    endsAt: parseTime(getPath(j, map.endsAt ?? 'endsAt')),
    score: getPath(j, map.totalScore ?? 'score') ?? null,
    matchIdOnServer: getPath(j, map.matchId ?? 'id') ?? null,
    items: (Array.isArray(rawItems) ? rawItems : []).map((it) => normalizeItem(it, map.item)),
    mapErrors,
    unparsed: false,
    raw: j,
  };
}

export class GmClient {
  constructor(cfg, { fetchImpl = globalThis.fetch, execImpl = defaultExec, timeoutMs } = {}) {
    this.cfg = cfg;
    this.map = cfg.map || {};
    this.api = { ...API_DEFAULTS, ...(cfg.states || {}), ...(cfg.submit || {}) };
    this.fetchImpl = fetchImpl;
    this.execImpl = execImpl;
    this.timeoutMs = timeoutMs ?? cfg.http?.timeoutMs ?? 15000;
  }

  fill(template, vars, encode) {
    return template.replace(/\{(\w+)\}/g, (_, k) => {
      const v = vars[k] ?? '';
      return encode ? encodeURIComponent(v) : String(v);
    });
  }

  async call(name, vars = {}, body) {
    const ep = this.cfg.endpoints?.[name];
    if (!ep) throw new ConfigError(`endpoint '${name}' is not configured in ${this.cfg.configFile || 'gm.config.json'}`);
    const all = { matchId: this.cfg.matchId, ...vars };
    if (ep.exec) {
      const out = await this.execImpl(this.fill(ep.exec, all, false), body, ep.timeoutMs ?? 30000);
      return parseBody(out.stdout, out.code === 0 ? 200 : 500);
    }
    if (!this.cfg.baseUrl) throw new ConfigError('baseUrl is not set: run mtm init --base-url <url> --match <id>');
    if (!this.cfg.matchId && /\{matchId\}/.test(ep.path)) throw new ConfigError('matchId is not set: run mtm init --match <id>');
    const url = this.cfg.baseUrl.replace(/\/$/, '') + this.fill(ep.path, all, true);
    const headers = { accept: 'application/json', ...(this.cfg.headers || {}) };
    if (this.cfg.token) {
      const a = this.cfg.auth || {};
      headers[a.header || 'Authorization'] = a.scheme ? `${a.scheme} ${this.cfg.token}` : this.cfg.token;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const method = ep.method || (body === undefined ? 'GET' : 'POST');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ep.timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        // A redirected POST (login page, http->https) must not look like a success.
        redirect: method === 'GET' ? 'follow' : 'manual',
      });
      return parseBody(await res.text(), res.status, res.headers);
    } catch (e) {
      const err = new GmError(`${name}: ${describeNetworkError(e)}`);
      err.kind = e?.name === 'AbortError' ? 'timeout' : 'network';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMatch() {
    const r = await retry(() => this.call('match'), 3, networkOr5xx);
    if (r.status >= 400) throw new GmError(`match: HTTP ${r.status} ${clip(r.text, 200)}`);
    return normalizeMatch(r, this.map, Date.now(), this.api);
  }

  /** ok: the server confirmed Start working. alreadyStarted: it says this team started before. */
  async start(itemId) {
    const r = await retry(() => this.call('start', { itemId }, {}), 3, networkOnly);
    const msg = String(r.json?.message ?? r.json?.error ?? clip(r.text, 300));
    const st = up(getPath(r.json, this.map.startStatus || 'status'));
    const explicitFail = r.json && (r.json.success === false || r.json.ok === false || /REJECT|ERROR|FAIL|DENIED/.test(st || ''));
    const ok = r.status >= 200 && r.status < 300 && !!r.json && !explicitFail;
    const alreadyStarted = !ok && new RegExp(this.api.alreadyStartedPattern, 'i').test(msg);
    return {
      ok,
      alreadyStarted,
      status: r.status,
      template: getPath(r.json, this.map.startTemplate || 'template'),
      mvs: getPath(r.json, this.map.startMvs || 'mvs'),
      message: msg,
      raw: r,
    };
  }

  /**
   * accepted: 2xx JSON whose status is in acceptedValues (or no status and no error flag).
   * duplicate: the server says it already has this item's submission.
   * unknown: 2xx without a JSON body; nothing can be concluded, check the match page.
   * Retried only when no HTTP response arrived; a retry after a lost acceptance comes back as duplicate.
   */
  async submit(itemId, payload) {
    // Retry only when the request never reached the server. After a timeout the server may
    // have accepted it: report UNCERTAIN instead of sending a second submission.
    let r;
    try {
      r = await retry(() => this.call('submit', { itemId }, payload), 3, (e) => networkOnly(e) && e.kind !== 'timeout');
    } catch (e) {
      if (e.kind === 'timeout') return { accepted: false, duplicate: false, unknown: true, status: 0, serverStatus: null, message: 'no answer before the timeout' };
      throw e;
    }
    const st = up(getPath(r.json, this.map.submitStatus || 'status'));
    const msg = String(r.json?.message ?? r.json?.error ?? clip(r.text, 300));
    const two = r.status >= 200 && r.status < 300;
    const dupValue = (this.api.duplicateValues || []).map(up).includes(st);
    const dupText = new RegExp(this.api.duplicatePattern, 'i').test(`${msg} ${st || ''}`) && (r.status === 409 || two);
    let accepted = false;
    if (two && r.json) {
      const flaggedError = r.json.success === false || r.json.ok === false || (r.json.error && !r.json.status);
      accepted = !flaggedError && (st == null ? true : this.api.acceptedValues.map(up).includes(st));
    }
    return {
      accepted,
      duplicate: !accepted && (dupValue || dupText),
      unknown: two && !r.json,
      status: r.status,
      serverStatus: st,
      message: msg,
      raw: r,
    };
  }

  async ready() {
    const r = await retry(() => this.call('ready', {}, {}), 3, networkOnly);
    return { ok: r.status < 300, status: r.status, message: r.json?.message ?? clip(r.text, 200) };
  }
}
