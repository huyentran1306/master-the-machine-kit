// The live portal (M02UT89F, 26/10; reproduced by the devkit mock, page "rsc") sends each backlog row
// with descriptionMd:"$15" and the item text as a separate flight chunk "15:T<hex bytes>,<text>".
// 2.7.4 took the page as readable, never resolved the chunk and never read /api/v1/match/<id>, so
// BUG-01 was worked without its text and lost 100 points for dashboard_before_fixing.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchPage, loadMatchData, resolveRscTextRefs, rscTextChunks, isRscRef, usableDescription } from '../team-sdlc-pack/src/portal.mjs';

const UUID = '8c0e1b22-1111-4222-8333-444444444444';
const TEXT = '# Desktop sidebar obscures the main content\n\nAfter login the sidebar overlaps Dashboard (Vietnamese: lề trái bị che). Capture screenshot of Dashboard before fixing as dashboard_before_fixing.png and commit to `evidence/` folder. Every PASS result must reference an existing evidence file.';

function rscPage(text = TEXT) {
  const flight = { match: { publicId: 'IMXBID61', status: 'IN_PROGRESS' }, backlog: [{ key: 'BUG-01', title: 'Desktop sidebar obscures the main content', type: 'BUG', status: 'OPEN', maxPoints: 100, descriptionMd: '$10' }] };
  const lines = [`1:${JSON.stringify(flight)}\n`, `10:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`];
  const pushes = lines.map((l) => `<script>self.__next_f.push([1,${JSON.stringify(l)}])</script>`).join('');
  return `<html><body><h1>Match IMXBID61</h1><p>Status: IN_PROGRESS</p><table><tr><td>BUG-01</td><td>Desktop sidebar obscures the main content</td><td>BUG</td><td>100</td></tr></table>`
    + `<ul><li>Start work: <code>POST https://x/api/v1/matches/${UUID}/backlogs/start</code></li><li>Submit: <code>POST https://x/api/v1/matches/${UUID}/submissions</code></li></ul>${pushes}</body></html>`;
}

test('an RSC reference is never text; a text chunk is read by UTF-8 byte length', () => {
  assert.ok(isRscRef('$15') && isRscRef('$L1a') && !isRscRef('$15 per hour'));
  const stream = `1:{"a":"$10"}\n10:T${Buffer.byteLength('lề trái', 'utf8').toString(16)},lề trái`;
  assert.equal(rscTextChunks(stream).get('10'), 'lề trái');
  assert.match(resolveRscTextRefs(stream), /"a":"lề trái"/);
});

test('the $15 page yields the full item text, so the named evidence is visible', () => {
  const p = parseMatchPage(rscPage(), { matchId: 'IMXBID61' });
  const it = p.items.find((i) => i.id === 'BUG-01');
  assert.ok(usableDescription(it.description), it.description);
  assert.match(it.description, /dashboard_before_fixing\.png/);
  assert.match(it.description, /lề trái/);
});

test('a readable page without item text still reads the JSON view for the descriptions', async () => {
  const html = rscPage('').replace(/self\.__next_f\.push\(\[1,"10:T0,"\]\)/, '');
  let called = 0;
  const call = async () => { called++; return { status: 200, json: { match: { publicId: 'IMXBID61', status: 'IN_PROGRESS' }, backlog: [{ key: 'BUG-01', title: 'Desktop sidebar obscures the main content', type: 'BUG', descriptionMd: TEXT }] } }; };
  const r = await loadMatchData(html, { url: 'https://x/match/IMXBID61', matchId: 'IMXBID61', extraJsonPaths: ['/api/v1/match/{matchId}'], call });
  assert.equal(called, 1);
  assert.equal(r.readable, true);
  assert.match(r.parsed.items.find((i) => i.id === 'BUG-01').description, /dashboard_before_fixing\.png/);
});

test('a page that already carries the text does not call the JSON view', async () => {
  let called = 0;
  const r = await loadMatchData(rscPage(), { url: 'https://x/match/IMXBID61', matchId: 'IMXBID61', extraJsonPaths: ['/api/v1/match/{matchId}'], call: async () => { called++; return { status: 500 }; } });
  assert.equal(called, 0);
  assert.equal(r.readable, true);
});

test('a JSON view refused after a readable page keeps the page readable', async () => {
  const html = rscPage('').replace(/self\.__next_f\.push\(\[1,"10:T0,"\]\)/, '');
  const r = await loadMatchData(html, { url: 'https://x/match/IMXBID61', matchId: 'IMXBID61', extraJsonPaths: ['/api/v1/match/{matchId}'], call: async () => ({ status: 403 }) });
  assert.equal(r.readable, true);
  assert.equal(r.authRejected, false);
});
