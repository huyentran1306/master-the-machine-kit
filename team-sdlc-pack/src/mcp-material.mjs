import { until } from './deadline.mjs';

const words = text => String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
function purpose(tool) {
  const text = words(`${tool.name} ${tool.description}`);
  if (tool.annotations?.readOnlyHint === false || /\b(create|delete|update|submit|mutate|write)\b/.test(words(tool.name))) return null;
  if (/\b(test data|fixtures?|scenario data|test cases)\b/.test(text) && /\b(get|fetch|read|load|retrieve|return|provide)\w*\b/.test(text)) return 'data';
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

/** Bounded, read-only discovery. Retain raw responses, including errors, for the worker. */
export async function collectMcpMaterial(item, call, budgetMs = 30000) {
  const entries = [];
  const deadline = Date.now() + budgetMs;
  const invoke = async (request, purpose) => {
    const entry = { purpose, tool: request.name || 'tools-list', args: request.args || {} };
    try {
      entry.result = await until(call({ ...request, raw: true }), Math.min(deadline, Date.now() + 10000));
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
  // Each advertised purpose is attempted; a timeout or unfamiliar schema cannot block dispatch.
  // Data and docs first: they decide most items; logs and other tools follow within the budget.
  const order = { data: 0, search: 1, logs: 2, other: 3 };
  selected.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const { tool, kind } of selected) {
    if (Date.now() >= deadline) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: 'MCP material time budget exhausted.' }); continue; }
    try { await invoke({ action: 'call', name: tool.name, args: argumentsFor(tool, item, kind) }, kind); }
    catch (e) { entries.push({ purpose: kind, tool: tool.name, ok: false, error: e.message }); continue; }
    // A long query dilutes a semantic search; also ask with the title alone.
    if ((kind === 'search' || kind === 'logs') && item.title && Date.now() < deadline) {
      try {
        const args = argumentsFor(tool, { ...item, description: '', startInstruction: '' }, kind);
        if (JSON.stringify(args) !== JSON.stringify(argumentsFor(tool, item, kind))) await invoke({ action: 'call', name: tool.name, args }, kind);
      } catch { /* the first call already recorded what this tool accepts */ }
    }
  }
  return entries;
}
