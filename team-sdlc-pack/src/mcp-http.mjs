// Minimal MCP client over Streamable HTTP, for a server the match itself advertises (the organizers'
// "match MCP server" that exposes the customer's internal material: standards, fixtures, tickets, docs).
// Same guardrails as every other call: allow-listed origin, bearer from the helper, bounded time and
// size, no redirects to another origin. The helper never guesses a URL; it uses one the match page
// shows or the adapter declares.
import { purpose } from './mcp-material.mjs';
import { request, httpError } from './http.mjs';

const PROTOCOL = '2025-06-18';
const ACCEPT = 'application/json, text/event-stream';

/** Streamable HTTP answers either JSON or an SSE stream; take the first JSON-RPC response in it. */
function parseBody(res) {
  if (res.json !== undefined) return res.json;
  const ct = res.headers.get('content-type') || '';
  if (!/event-stream/.test(ct) && !/^\s*(event|data):/m.test(res.text)) return undefined;
  for (const block of res.text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      const value = JSON.parse(data);
      if (value && (value.result !== undefined || value.error !== undefined)) return value;
    } catch { /* keep looking */ }
  }
  return undefined;
}

export class McpHttpClient {
  constructor({ url, bearer, allowedOrigins, log = async () => {}, timeoutMs = 45000, maxBytes = 2_000_000 }) {
    this.url = url;
    this.bearer = bearer;
    this.allowedOrigins = allowedOrigins;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.sessionId = null;
    this.nextId = 1;
    this.serverInfo = null;
    this.ready = false;
  }

  headers(extra = {}) {
    return {
      accept: ACCEPT,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL,
      ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...extra,
    };
  }

  async send(method, params, options = {}) {
    const read = ['tools/list', 'resources/list', 'resources/read'].includes(method) || options.readOnly;
    for (let attempt = 0; ; attempt++) {
      try { return await this.sendOnce(method, params, options); }
      catch (e) {
        if (!read || attempt !== 0 || !/^(?:TIMEOUT|NETWORK|MCP_HTTP_(?:408|429|500|502|503|504))$/.test(e.code || '')) throw e;
      }
    }
  }

  async sendOnce(method, params, { notification = false } = {}) {
    const payload = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const req = { method: 'POST', url: this.url, operation: method };
    await this.log('REQUESTED', req);
    let res;
    try {
      res = await request(this.url, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(payload),
        allowedOrigins: this.allowedOrigins, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes,
      });
    } catch (e) {
      await this.log('FAILED', req, null, e);
      throw e;
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || notification) {
      await this.log('SUCCEEDED', req, res);
      return undefined;
    }
    if (res.status >= 400) {
      await this.log('FAILED', req, res);
      throw httpError(`MCP_HTTP_${res.status}`, `${method}: HTTP ${res.status} ${String(res.text || '').slice(0, 200)}`, { status: res.status });
    }
    const msg = parseBody(res);
    if (!msg) {
      await this.log('FAILED', req, res);
      throw httpError('MCP_BAD_RESPONSE', `${method}: no JSON-RPC response in the reply (content-type ${res.headers.get('content-type') || 'none'})`);
    }
    if (msg.error) {
      await this.log('FAILED', req, res);
      throw httpError('MCP_ERROR', `${method}: ${msg.error.message || JSON.stringify(msg.error).slice(0, 200)}`, { data: msg.error });
    }
    await this.log('SUCCEEDED', req, res);
    return msg.result;
  }

  async init() {
    if (this.ready) return this.serverInfo;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async initialize() {
    const r = await this.send('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'mtm-team-runtime', version: '1.0.0' },
    });
    this.serverInfo = r?.serverInfo || null;
    this.instructions = r?.instructions || null;
    try {
      await this.send('notifications/initialized', {}, { notification: true });
    } catch { /* some servers answer 202 or nothing */ }
    this.ready = true;
    return this.serverInfo;
  }

  async tools() {
    await this.init();
    const out = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const r = await this.send('tools/list', cursor ? { cursor } : {});
      out.push(...(r?.tools || []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.toolCatalog = out;
    return out;
  }

  async call(name, args = {}) {
    await this.init();
    return this.send('tools/call', { name, arguments: args }, { readOnly: !!purpose(this.toolCatalog?.find(t => t.name === name) || { name: '' }) });
  }

  async resources() {
    await this.init();
    const r = await this.send('resources/list', {});
    return r?.resources || [];
  }

  async readResource(uri) {
    await this.init();
    return this.send('resources/read', { uri });
  }
}

/** Flattens an MCP tool/resource result into readable text for the model. */
export function resultText(result, max = 20000) {
  if (result == null) return '';
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (v.type === 'text' && typeof v.text === 'string') parts.push(v.text);
    else if (v.type === 'resource' && v.resource) push(v.resource.text ?? v.resource.blob ?? v.resource.uri);
    else if (v.text) parts.push(v.text);
    else parts.push(JSON.stringify(v));
  };
  for (const key of ['content', 'contents']) if (Array.isArray(result[key])) result[key].forEach(push);
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  if (!parts.length) parts.push(JSON.stringify(result));
  const text = parts.join('\n');
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}
