import { mapBounded } from './dispatch.mjs';
import { until } from './deadline.mjs';
import { sleep } from './util.mjs';

const words = text => String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
export function purpose(tool) {
  const text = words(`${tool.name} ${tool.description}`);
  const name = words(tool.name);
  const annotated = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
  const action = /\b(restart|send|deploy|reset|notify|trigger|run|execute|apply|approve|cancel|create|update|delete|write|submit|mutate|post|pay|void|issue|email|toggle|enable|disable|set)\b/;
  if (tool.annotations?.destructiveHint === true || !annotated && (tool.annotations?.readOnlyHint === false || action.test(name) || !/\b(get|list|search|read|fetch|query|lookup|find|describe|show|load|retrieve)\b/.test(name))) return null;
  if (/\b(test data|fixtures?|scenario data|test cases)\b/.test(text)) return 'data';
  if (/\b(search|find|lookup|query)\w*\b/.test(text) && /\b(docs?|documents?|documentation|knowledge|kb)\b/.test(text)) return 'search';
  // Incident items are answered from production logs; workers cannot query them, so fetch them up front.
  if (/\b(logs?|observability|traces?|events?|incidents?|audit|telemetry|metrics|requests?)\b/.test(text)) return 'logs';
  // Any other read-only company tool is still tried; an unfillable schema is recorded, not fatal.
  return 'other';
}

function argumentsFor(tool, item, kind) {
  const args = {};
  const schema = tool.inputSchema || {};
  const terms = [item.description, item.startInstruction].map(text => String(text || '').replace(/https?:\/\/\S+/g, '').slice(0, 200)).filter(Boolean).join(' ');
  const query = `${item.id} ${item.title || ''} ${terms}`.trim();
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const label = words(key);
    if (/^(?:q|query|search|search query|search text|search term|search terms|keywords|terms|text)$/.test(label)) args[key] = spec.type === 'array' ? query.split(/\s+/) : query;
    else if (/^(?:id|item|item id|item key|backlog id|backlog key|backlog item|backlog item id|backlog item key|ticket id|task id)$/.test(label)) args[key] = item.id;
    else if (spec.default !== undefined) args[key] = spec.default;
    else if ((schema.required || []).includes(key) && /^(?:limit|top k|count|max results)$/.test(label)) args[key] = 5;
    else if ((schema.required || []).includes(key)) throw new Error(`Cannot infer required argument ${key} for ${kind}; ask the orchestrator.`);
  }
  return args;
}

/** Services a log-search tool names in its description, e.g. "(services: web, api, payment-api)". */
export function logServices(tool) {
  const m = String(tool.description || '').match(/\bservices?\s*[:(]\s*([^)\n]+)/i);
  if (!m) return [];
  return [...new Set(m[1].split(/[,;]|\s+and\s+|\s+or\s+/).map(s => s.trim().replace(/^(?:e\.g\.|for example)\s*/i, '').replace(/[.\s]+$/, ''))
    .filter(s => /^[a-z0-9][\w.-]{0,40}$/i.test(s)))].slice(0, 16);
}

/** { total, returned, entries } from a raw MCP log-search result, or null. */
export function parseLogResult(result) {
  for (const part of result?.raw?.content || []) {
    if (part?.type !== 'text') continue;
    try {
      const data = JSON.parse(part.text);
      const entries = Array.isArray(data) ? data : data.entries || data.logs || data.results || data.items;
      if (Array.isArray(entries)) return { total: Number(data.total ?? entries.length), returned: Number(data.returned ?? entries.length), entries };
    } catch { /* not JSON */ }
  }
  return null;
}

const stamp = e => { const t = Date.parse(e?.timestamp ?? e?.time ?? e?.ts ?? e?.at ?? ''); return Number.isNaN(t) ? Infinity : t; };

/**
 * Incident items are answered from production logs that only the orchestrator can query. The item-text
 * query matches nothing when every word must appear, so in DZCZCBAT the PI-01 worker relayed ~10 log
 * searches through NEED_INFO and took 2.5 minutes. Sweep every service (and its levels when truncated)
 * up front and hand the worker one merged, deduplicated, oldest-first file.
 */
async function sweepLogs(tool, fetchOnly, cutoff) {
  const props = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];
  const key = re => Object.keys(props).find(k => re.test(words(k)));
  const queryKey = key(/^(?:q|query|search|search query|search text|search term|search terms|keywords|terms|text)$/);
  const serviceKey = key(/^(?:service|service name|services|source|component|app|application)$/);
  if (required.some(k => k !== queryKey && k !== serviceKey)) return null;
  const services = serviceKey ? logServices(tool) : [];
  const argsFor = (service, query) => {
    const args = {};
    if (service && serviceKey) args[serviceKey] = service;
    if (query && queryKey) args[queryKey] = query;
    else if (queryKey && required.includes(queryKey)) return null;
    return args;
  };
  const seen = new Map();
  const truncated = [];
  const run = async (service, query) => {
    const args = argsFor(service, query);
    if (!args) return { parsed: null, reason: 'FAILED' };
    if (Date.now() >= cutoff) return { parsed: null, reason: 'TIMEOUT' };
    const entry = await fetchOnly({ action: 'call', name: tool.name, args }, cutoff);
    const parsed = entry.ok ? parseLogResult(entry.result) : null;
    for (const e of parsed?.entries || []) seen.set(JSON.stringify(e), e);
    return { parsed, reason: parsed ? null : entry.reason || 'FAILED' };
  };
  const top = await mapBounded([null, ...services], 4, service => run(service, null));
  // A transiently missed service is more valuable than deeper level splits. Retry just those once,
  // sequentially, while the same sweep deadline still has room.
  for (let i = 0; i < services.length && Date.now() + 250 < cutoff; i += 1) {
    if (!top[i + 1]?.parsed) top[i + 1] = await run(services[i], null);
  }
  const levels = ['ERROR', 'WARN', 'INFO'];
  const deeper = services.filter((_, i) => top[i + 1]?.parsed && top[i + 1].parsed.total > top[i + 1].parsed.returned);
  const split = await mapBounded(deeper.flatMap(service => levels.map(level => ({ service, level }))), 4, ({ service, level }) => run(service, level).then(r => ({ service, level, r: r.parsed })));
  for (let i = 0; i < services.length; i += 1) if (!top[i + 1]?.parsed) truncated.push({ service: services[i], reason: top[i + 1]?.reason || (Date.now() >= cutoff ? 'TIMEOUT' : 'FAILED') });
  for (const service of deeper) {
    const t = top[services.indexOf(service) + 1].parsed;
    const parts = split.filter(x => x.service === service);
    const covered = parts.reduce((n, x) => n + (x.r?.returned || 0), 0);
    if (covered < t.total) truncated.push({ service, total: t.total, fetched: Math.min(t.total, covered || t.returned), levelsOverLimit: parts.filter(x => x.r && x.r.total > x.r.returned).map(x => x.level) });
  }
  if (!serviceKey && top[0]?.parsed && top[0].parsed.total > top[0].parsed.returned) truncated.push({ service: '*', total: top[0].parsed.total, fetched: top[0].parsed.returned });
  const entries = [...seen.values()].sort((a, b) => stamp(a) - stamp(b));
  return {
    purpose: 'logs', tool: `${tool.name}-merged`, args: { services }, ok: true,
    result: {
      note: 'Every production log entry the kit could fetch, deduplicated, oldest first. Answer from this file; NEED_INFO only for a service in truncated (narrow it by a word such as an invoice number or requestId).',
      unique: entries.length, services, truncated, entries,
    },
  };
}

/** Puts a plain query into the tool's own query property. */
function explicitArgs(tool, { query }) {
  const key = Object.keys(tool.inputSchema?.properties || {}).find(k => /^(?:q|query|search|search query|search text|search term|search terms|keywords|terms|text)$/.test(words(k))) || 'query';
  const spec = tool.inputSchema?.properties?.[key] || {};
  return { [key]: spec.type === 'array' ? query.split(/\s+/) : query };
}

/** Bounded, read-only discovery. Retain raw responses, including errors, for the worker. */
export async function collectMcpMaterial(item, call, budgetMs = 90000) {
  const entries = [];
  const deadline = Date.now() + Math.min(budgetMs, 90000);
  const invoke = async (request, purpose, cutoff = deadline) => {
    const entry = { purpose, tool: request.name || 'tools-list', args: request.args || {} };
    try {
      entry.result = await until(call({ ...request, raw: true }), cutoff);
      entry.ok = entry.result?.ok === true;
    } catch (e) { entry.ok = false; entry.error = e.message; }
    entries.push(entry);
    return entry;
  };
  // Sweep reads are merged into one file instead of one brief file per call.
  const fetchOnly = async (request, cutoff) => {
    let last;
    for (let attempt = 0; attempt < 3 && Date.now() < cutoff; attempt += 1) {
      try {
        const result = await until(call({ ...request, raw: true }), cutoff);
        last = { ok: result?.ok === true, result };
        if (last.ok) return last;
        const status = Number(result?.httpStatus || result?.status || result?.error?.httpStatus);
        if (status !== 429 && status < 500) return { ...last, reason: 'FAILED' };
      } catch (e) {
        last = { ok: false, error: e.message };
        if (/deadline|timeout/i.test(e.message) || Date.now() >= cutoff) return { ...last, reason: 'TIMEOUT' };
      }
      const delay = [300, 600, 1200][attempt] || 1200;
      if (Date.now() + delay >= cutoff) break;
      await sleep(delay);
    }
    return { ...(last || { ok: false }), reason: Date.now() >= cutoff ? 'TIMEOUT' : 'FAILED' };
  };
  const listing = await invoke({ action: 'tools' }, 'discovery');
  if (!listing.ok) return entries;
  const selected = (listing.result.tools || []).map(tool => ({ tool, kind: purpose(tool) })).filter(x => x.kind);
  for (const kind of ['data', 'search']) {
    if (!selected.some(x => x.kind === kind)) entries.push({ purpose: kind, ok: false, error: `No matching read-only ${kind} tool advertised; request NEED_INFO if material is still missing.` });
  }
  const attempt = async ({ tool, kind }, cutoff = deadline, retry = false, explicit = null) => {
    if (Date.now() >= cutoff) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: 'MCP material time budget exhausted.' }); return; }
    try {
      if (explicit) { await invoke({ action: 'call', name: tool.name, args: explicitArgs(tool, explicit) }, kind, cutoff); return; }
      const args = argumentsFor(tool, retry ? { ...item, description: '', startInstruction: '' } : item, kind);
      if (retry && JSON.stringify(args) === JSON.stringify(argumentsFor(tool, item, kind))) return;
      await invoke({ action: 'call', name: tool.name, args }, kind, cutoff);
    } catch (e) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: e.message }); }
  };
  const needed = ['data', 'search', 'logs'].map(kind => selected.find(x => x.kind === kind)).filter(Boolean);
  // First data/docs/log reads overlap; each keeps the whole remaining read budget.
  await mapBounded(needed, 3, candidate => attempt(candidate));
  await mapBounded(selected.filter(x => x.kind !== 'other' && !needed.includes(x)), 3, candidate => attempt(candidate));
  for (const candidate of selected.filter(x => x.kind === 'search' || x.kind === 'logs')) {
    if (item.title) await attempt(candidate, deadline, true);
  }
  // Standards commonly reference other authoritative articles (for example an export format points
  // at its money, date, status and access rules). Search APIs return only a few articles, so stopping
  // at the first response made workers guess the missing rules and pass MVS while losing hidden tests.
  // Follow one bounded layer of explicit KB IDs; exact-ID queries are deterministic and read-only.
  const kb = selected.find(x => x.kind === 'search');
  if (kb) {
    const followed = new Set();
    for (let depth = 0; depth < 2 && followed.size < 8 && Date.now() < deadline; depth += 1) {
      const text = `${item.description || ''}\n${item.startInstruction || ''}\n${JSON.stringify(entries)}`;
      const ids = [...new Set(text.match(/\bKB-[A-Z][A-Z0-9]*-\d+\b/g) || [])].filter(id => !followed.has(id)).slice(0, 8 - followed.size);
      if (!ids.length) break;
      ids.forEach(id => followed.add(id));
      await mapBounded(ids, 3, id => attempt(kb, deadline, false, { query: id }));
    }
  }
  const incident = item.type === 'PI' || /\b(incident|production logs?|observability)\b/i.test(String(item.description || ''));
  if (incident) {
    const sweepCutoff = Math.min(deadline, Date.now() + 25000);
    const kb = selected.find(x => x.kind === 'search');
    const rules = kb && /\bincident report\b/i.test(String(item.description || '')) ? attempt(kb, sweepCutoff, false, { query: 'incident report rules' }) : null;
    for (const { tool } of selected.filter(x => x.kind === 'logs')) {
      try { const merged = await sweepLogs(tool, fetchOnly, sweepCutoff); if (merged) entries.push(merged); }
      catch (e) { entries.push({ purpose: 'logs', tool: `${tool.name}-merged`, ok: false, error: e.message }); }
    }
    await rules;
  }
  const optionalDeadline = Math.min(deadline, Date.now() + 2000);
  for (const candidate of selected.filter(x => x.kind === 'other')) await attempt(candidate, optionalDeadline);
  return entries;
}
