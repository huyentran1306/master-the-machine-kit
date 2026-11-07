import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMcpMaterial, logServices, parseLogResult } from '../team-sdlc-pack/src/mcp-material.mjs';

const LOGS = [
  ...Array.from({ length: 25 }, (_, i) => ({ timestamp: `2026-10-27T08:${String(i).padStart(2, '0')}:00Z`, level: i % 5 ? 'INFO' : 'WARN', service: 'reminder-worker', message: `Reminder sent INV-${i}` })),
  { timestamp: '2026-10-27T07:00:00+07:00', level: 'INFO', service: 'deploy', message: 'rel-1 deployed' },
  { timestamp: '2026-10-27T09:00:00Z', level: 'ERROR', service: 'status-cache', message: 'stale' },
];
const text = data => ({ ok: true, raw: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
const tools = [
  { name: 'kb_search', description: 'Internal standards and knowledge base search, incident report rules.', inputSchema: { properties: { query: { type: 'string' } }, required: [] } },
  { name: 'search_logs', description: 'Search production logs (services: deploy, reminder-worker, status-cache). Returns at most 20 per call.', inputSchema: { properties: { query: { type: 'string' }, service: { type: 'string' } }, required: [] } },
];
function server(calls) {
  return async req => {
    calls.push(req);
    if (req.action === 'tools') return { ok: true, tools };
    if (req.name === 'kb_search') return text({ articles: [{ id: 'KB-INC', q: req.args.query }] });
    const words = String(req.args.query || '').split(/\s+/).filter(Boolean);
    const hit = LOGS.filter(e => (!req.args.service || e.service === req.args.service) && words.every(w => JSON.stringify(e).includes(w)));
    const out = hit.slice().reverse().slice(0, 20);
    return text({ total: hit.length, returned: out.length, entries: out });
  };
}

test('logServices reads the service list from the description', () => {
  assert.deepEqual(logServices(tools[1]), ['deploy', 'reminder-worker', 'status-cache']);
  assert.deepEqual(logServices({ description: 'no list here' }), []);
});

test('logServices accepts services include phrasing used by match tools', () => {
  const tool = { description: 'Search production logs (services include api-gateway, sync-server, web, payments, import, rules, rule-engine, schedules, status-cache, deploy) at most 20 per call.' };
  assert.deepEqual(logServices(tool), ['api-gateway', 'sync-server', 'web', 'payments', 'import', 'rules', 'rule-engine', 'schedules', 'status-cache', 'deploy']);
});

test('parseLogResult reads total/returned/entries', () => {
  assert.deepEqual(parseLogResult(text({ total: 3, returned: 1, entries: [{ a: 1 }] })), { total: 3, returned: 1, entries: [{ a: 1 }] });
  assert.equal(parseLogResult({ raw: { content: [{ type: 'text', text: 'nope' }] } }), null);
});

test('PI items get one merged, deduplicated, oldest-first log file covering every service', async () => {
  const calls = [];
  const item = { id: 'PI-01', type: 'PI', title: 'Clients receive reminders', description: 'Follow the incident report rules. Logs are in production.' };
  const entries = await collectMcpMaterial(item, server(calls));
  const merged = entries.find(e => e.tool === 'search_logs-merged');
  assert.ok(merged?.ok);
  assert.equal(merged.result.unique, LOGS.length);
  assert.deepEqual(merged.result.truncated, []);
  assert.equal(merged.result.entries[0].service, 'deploy', 'UTC-normalised oldest first (07:00+07:00 = 00:00Z)');
  assert.ok(calls.some(c => c.name === 'kb_search' && c.args.query === 'incident report rules'));
  assert.ok(calls.some(c => c.args?.service === 'reminder-worker' && c.args.query === 'INFO'), 'truncated service is split by level');
  assert.equal(entries.filter(e => e.tool === 'search_logs').length <= 2, true, 'sweep calls are not one brief file each');
});

test('non-incident items do not sweep logs', async () => {
  const calls = [];
  await collectMcpMaterial({ id: 'CR-01', type: 'CR', title: 'Export', description: 'Add a CSV export.' }, server(calls));
  assert.equal(calls.some(c => c.args?.service), false);
});

test('log sweep retries HTTP 429 and marks services that still fail as missing', async () => {
  const advertised = [{ name: 'search_logs', description: 'Search production logs (services: payment-api, deploy).',
    inputSchema: { properties: { service: { type: 'string' } }, required: [] } }];
  let deployAttempts = 0;
  const entries = await collectMcpMaterial({ id: 'PI-02', type: 'PI', description: 'Investigate production logs.' }, async req => {
    if (req.action === 'tools') return { ok: true, tools: advertised };
    if (req.args?.service === 'payment-api') return { ok: false, httpStatus: 503, error: 'temporary' };
    if (req.args?.service === 'deploy' && ++deployAttempts === 1) return { ok: false, httpStatus: 429, error: 'rate limited' };
    return text({ total: 1, returned: 1, entries: [{ timestamp: '2026-11-04T10:00:00Z', service: req.args?.service || 'deploy', message: 'ok' }] });
  }, 10000);
  const merged = entries.find(e => e.tool === 'search_logs-merged');
  assert.ok(deployAttempts >= 2, `deploy attempts: ${deployAttempts}`);
  assert.deepEqual(merged.result.truncated, [{ service: 'payment-api', reason: 'FAILED' }]);
});

test('log sweep follows an advertised generic page contract until total is covered', async () => {
  const all = Array.from({ length: 57 }, (_, i) => ({ timestamp: `2026-11-04T10:${String(i).padStart(2, '0')}:00Z`, message: `entry-${i}` }));
  const advertised = [{ name: 'search_logs', description: 'Search production logs, 20 per page.',
    inputSchema: { properties: { page: { type: 'integer', default: 1 }, limit: { type: 'integer', default: 20 } }, required: [] } }];
  const entries = await collectMcpMaterial({ id: 'PI-57', type: 'PI', description: 'Investigate production logs.' }, async req => {
    if (req.action === 'tools') return { ok: true, tools: advertised };
    const page = Number(req.args?.page || 1); const limit = Number(req.args?.limit || 20);
    const slice = all.slice((page - 1) * limit, page * limit);
    return text({ total: all.length, returned: slice.length, entries: slice });
  }, 10000);
  const merged = entries.find(e => e.tool === 'search_logs-merged');
  assert.equal(merged.result.unique, 57);
  assert.deepEqual(merged.result.truncated, []);
});

test('log sweep reports the exact missing count when no paging shape is advertised', async () => {
  const advertised = [{ name: 'search_logs', description: 'Search production logs.', inputSchema: { properties: {}, required: [] } }];
  const entries = await collectMcpMaterial({ id: 'PI-MISSING', type: 'PI', description: 'Investigate production logs.' }, async req => {
    if (req.action === 'tools') return { ok: true, tools: advertised };
    return text({ total: 57, returned: 20, entries: Array.from({ length: 20 }, (_, i) => ({ timestamp: i, message: `entry-${i}` })) });
  }, 10000);
  const merged = entries.find(e => e.tool === 'search_logs-merged');
  assert.deepEqual(merged.result.truncated, [{ service: '*', total: 57, fetched: 20 }]);
});
