import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request } from '../team-sdlc-pack/src/http.mjs';
import { McpHttpClient } from '../team-sdlc-pack/src/mcp-http.mjs';

test('Game Master reads retry once on transient failure; POST mutations do not retry', async t => {
  let gets = 0, posts = 0;
  const server = http.createServer((req, res) => {
    const n = req.method === 'GET' ? ++gets : ++posts;
    res.writeHead(n === 1 ? 503 : 200); res.end('synthetic');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(url, { allowedOrigins: [url] })).status, 200);
  assert.equal(gets, 2);
  assert.equal((await request(url, { method: 'POST', allowedOrigins: [url] })).status, 503);
  assert.equal(posts, 1);
});

test('MCP reads retry once; unannotated mutation calls never replay', async () => {
  const client = new McpHttpClient({ url: 'https://synthetic.invalid' });
  assert.equal(client.timeoutMs, 45000);
  let calls = 0;
  client.sendOnce = async () => { calls++; throw Object.assign(new Error('synthetic'), { code: 'NETWORK' }); };
  await assert.rejects(client.send('tools/list', {}));
  assert.equal(calls, 2);
  calls = 0; client.ready = true;
  client.toolCatalog = [{ name: 'restart_service' }];
  await assert.rejects(client.call('restart_service'));
  assert.equal(calls, 1);
  calls = 0;
  client.toolCatalog = [{ name: 'search_logs', annotations: { readOnlyHint: true } }];
  await assert.rejects(client.call('search_logs'));
  assert.equal(calls, 2);
});
