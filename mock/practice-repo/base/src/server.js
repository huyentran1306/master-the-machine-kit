import http from 'node:http';
import { route } from './router.js';

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const out = route(req.method, req.url, body);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});

server.listen(Number(process.env.PORT || 3000), () => {
  console.log(`voucher-service listening on ${server.address().port}`);
});
