import { until } from './deadline.mjs';

const words = text => String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
function purpose(tool) {
  const text = words(`${tool.name} ${tool.description}`);
  if (tool.annotations?.readOnlyHint === false || /\b(create|delete|update|submit|mutate|write)\b/.test(words(tool.name))) return null;
  if (/\b(test data|fixtures?|scenario data|test cases)\b/.test(text) && /\b(get|fetch|read|load|retrieve|return|provide)\w*\b/.test(text)) return 'data';
  if (/\b(search|find|lookup|query)\w*\b/.test(text) && /\b(docs?|documents?|documentation|knowledge|kb)\b/.test(text)) return 'search';
  const action = /\b(restart|send|deploy|reset|notify|trigger|run|execute|apply|approve|cancel|create|update|delete|write|submit|mutate|post|pay|void|issue|email|toggle|enable|disable|set)\b/;
  if (action.test(text) || (tool.annotations?.readOnlyHint !== true && !/\b(get|list|search|read|fetch|query|lookup|find|describe|show)\b/.test(text))) return null;
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

/** Bounded, read-only discovery. Retain raw responses, including errors, for the worker. */
export async function collectMcpMaterial(item, call, budgetMs = 30000) {
  const entries = [];
  const deadline = Date.now() + Math.min(budgetMs, 30000);
  const invoke = async (request, purpose, cutoff = deadline) => {
    const entry = { purpose, tool: request.name || 'tools-list', args: request.args || {} };
    try {
      entry.result = await until(call({ ...request, raw: true }), Math.min(cutoff, Date.now() + 10000));
      entry.ok = entry.result?.ok === true;
    } catch (e) { entry.ok = false; entry.error = e.message; }
    entries.push(entry);
    return entry;
  };
  const listing = await invoke({ action: 'tools' }, 'discovery');
  if (!listing.ok) return entries;
  const selected = (listing.result.tools || []).map(tool => ({ tool, kind: purpose(tool) })).filter(x => x.kind);
  for (const kind of ['data', 'search']) {
    if (!selected.some(x => x.kind === kind)) entries.push({ purpose: kind, ok: false, error: `No matching read-only ${kind} tool advertised; request NEED_INFO if material is still missing.` });
  }
  const attempt = async ({ tool, kind }, cutoff = deadline, retry = false) => {
    if (Date.now() >= cutoff) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: 'MCP material time budget exhausted.' }); return; }
    try {
      const args = argumentsFor(tool, retry ? { ...item, description: '', startInstruction: '' } : item, kind);
      if (retry && JSON.stringify(args) === JSON.stringify(argumentsFor(tool, item, kind))) return;
      await invoke({ action: 'call', name: tool.name, args }, kind, cutoff);
    } catch (e) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: e.message }); }
  };
  const needed = ['data', 'search', 'logs'].map(kind => selected.find(x => x.kind === kind)).filter(Boolean);
  // Divide remaining time so slow data/search cannot starve the first log attempt.
  for (let i = 0; i < needed.length; i++) {
    await attempt(needed[i], Date.now() + Math.max(0, deadline - Date.now()) / (needed.length - i));
  }
  for (const candidate of selected.filter(x => x.kind !== 'other' && !needed.includes(x))) await attempt(candidate);
  for (const candidate of selected.filter(x => x.kind === 'search' || x.kind === 'logs')) {
    if (item.title) await attempt(candidate, deadline, true);
  }
  const optionalDeadline = Math.min(deadline, Date.now() + 2000);
  for (const candidate of selected.filter(x => x.kind === 'other')) await attempt(candidate, optionalDeadline);
  return entries;
}
