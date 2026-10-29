// HTTP client with the guardrails from the technical guide: origin allowlist, no cross-origin
// redirects, bounded time and response size, cookies held only in memory.
import { originOf } from './util.mjs';

export class CookieJar {
  constructor() {
    this.cookies = []; // { name, value, host, path, expires }
  }

  setFrom(url, headers) {
    const host = new URL(url).host;
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : splitSetCookie(headers.get('set-cookie'));
    for (const raw of list) {
      const parts = raw.split(';').map((s) => s.trim());
      const [nv, ...attrs] = parts;
      const eq = nv.indexOf('=');
      if (eq <= 0) continue;
      const c = { name: nv.slice(0, eq), value: nv.slice(eq + 1), host, path: '/', expires: null };
      for (const a of attrs) {
        const [k, v = ''] = a.split('=');
        const key = k.toLowerCase();
        if (key === 'path' && v) c.path = v;
        else if (key === 'max-age') c.expires = Date.now() + Number(v) * 1000;
        else if (key === 'expires' && c.expires == null) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) c.expires = t;
        }
      }
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.host === c.host && x.path === c.path));
      if (c.expires == null || c.expires > Date.now()) this.cookies.push(c);
    }
  }

  header(url) {
    const u = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires == null || c.expires > now);
    const parts = this.cookies.filter((c) => c.host === u.host && u.pathname.startsWith(c.path)).map((c) => `${c.name}=${c.value}`);
    return parts.length ? parts.join('; ') : null;
  }

  get size() {
    return this.cookies.length;
  }

  clear() {
    this.cookies = [];
  }

  /** Values only, so they can be redacted from any output. */
  secrets() {
    return this.cookies.map((c) => c.value);
  }
}

function splitSetCookie(v) {
  if (!v) return [];
  // Split on commas that start a new cookie (not the comma inside Expires dates).
  return v.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
}

export function checkOriginAllowed(url, allowedOrigins) {
  const origin = originOf(url);
  if (!origin) throw httpError('BAD_URL', `invalid URL ${url}`);
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    throw httpError('ORIGIN_NOT_ALLOWED', `plain HTTP is allowed only for loopback mock servers: ${origin}`);
  }
  if (!allowedOrigins?.includes(origin)) throw httpError('ORIGIN_NOT_ALLOWED', `origin ${origin} is not in the allowlist`);
  return origin;
}

export function httpError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * request(url, opts) -> { status, headers, text, json, url, requestId, serverDate }
 * opts: method, headers, body (string), jar, allowedOrigins, timeoutMs, maxBytes, maxRedirects
 */
/**
 * Explicit HTTP telemetry for mtm-player's dashboard. The Player counts only telemetry a team
 * reports through `structuredContent.networkActivity` on an MCP tool result (src/cli-activity.mjs:
 * `{url, method, httpStatus}`, first 100 entries, http/https only) — a URL that merely appears in a
 * command or an argument proves nothing to it, and with no telemetry the dashboard's
 * "Network & API activity" panel reads UNAVAILABLE. Reporting every request keeps the organizer's
 * own view of our traffic complete, which is the point: all of it goes to allowed origins.
 * Queries are dropped here, never recorded, matching what the Player keeps.
 */
const MAX_TELEMETRY = 100;
const telemetry = [];

export function recordNetwork(url, method, httpStatus) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return;
    if (telemetry.length >= MAX_TELEMETRY) telemetry.shift();
    telemetry.push({ url: `${u.origin}${u.pathname}`, method: String(method || 'GET').toUpperCase(), httpStatus: Number.isInteger(httpStatus) ? httpStatus : null });
  } catch { /* an unparseable URL is not evidence of a request */ }
}

/** Takes the requests made since the last call, for the next tool result. */
export function drainNetwork() {
  return telemetry.splice(0, telemetry.length);
}

export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, jar, allowedOrigins, timeoutMs = 20000, maxBytes = 3_000_000, maxRedirects = 5, deadlineAt = Infinity,
  } = opts;
  let current = url;
  let m = method;
  let b = body;
  const hdrs = { ...headers };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw httpError('TIMEOUT', 'HTTP deadline exceeded');
    checkOriginAllowed(current, allowedOrigins);
    const h = { ...hdrs };
    const cookie = jar?.header(current);
    if (cookie) h.cookie = cookie;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, remaining));
    let res;
    try {
      res = await fetch(current, { method: m, headers: h, body: b, redirect: 'manual', signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      recordNetwork(current, m, null);
      throw httpError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', `${m} ${new URL(current).pathname}: ${e.name === 'AbortError' ? 'timed out' : e.cause?.code || e.message}`);
    }
    recordNetwork(current, m, res.status);
    if (jar) jar.setFrom(current, res.headers);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      clearTimeout(timer);
      const next = new URL(res.headers.get('location'), current).toString();
      if (originOf(next) !== originOf(current)) {
        throw httpError('CROSS_ORIGIN_REDIRECT', `redirect to another origin blocked: ${originOf(next)}`, { status: res.status });
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
        m = 'GET';
        b = undefined;
        delete hdrs['content-type'];
      }
      current = next;
      continue;
    }
    let text = '';
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) {
            ac.abort();
            throw httpError('TOO_LARGE', `response larger than ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      }
    } catch (e) {
      clearTimeout(timer);
      if (e.code) throw e;
      throw httpError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', `reading ${new URL(current).pathname}: ${e.message}`);
    }
    clearTimeout(timer);
    let json;
    if ((res.headers.get('content-type') || '').includes('json') || /^\s*[{[]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const dateHeader = res.headers.get('date');
    return {
      status: res.status,
      headers: res.headers,
      text,
      json,
      url: current,
      redirected: hop > 0,
      requestId: res.headers.get('x-request-id') || json?.error?.requestId || null,
      serverDate: dateHeader ? Date.parse(dateHeader) : null,
    };
  }
  throw httpError('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`);
}
