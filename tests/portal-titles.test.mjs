import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchPage, usableTitle } from '../team-sdlc-pack/src/portal.mjs';

// Entirely invented text. Mimic a React flight projection, contestant view and API sample block.
const row = { key: 'TASK-91', backlogId: 'TASK-91', title: 'Add shelf labels', backlogTitle: 'Add shelf labels' };
const view = { match: { publicId: 'SYNTHETIC', status: 'IN_PROGRESS' }, backlog: [row] };
const command = 'curl -X POST https://example.invalid/api/v1/matches/demo/backlogs/start';
const sample = `<section><p>TASK-91</p><pre>${command}\n-d '{"backlogItemKey":"TASK-91"}'</pre></section>`;
const jsonScript = value => `<script type="application/json">${JSON.stringify(value)}</script>`;

test('flight and contestant backlog titles beat API samples and richer text rows', () => {
  const flight = '8:' + JSON.stringify({ initialProjection: view });
  const html = `<p>TASK-91 | Incorrect text heading | 100 points | Open | Working | Passed</p>` + sample + `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
  assert.equal(parseMatchPage(html).items[0].title, row.title);
  assert.equal(parseMatchPage(sample + jsonScript(view)).items[0].title, row.title);
  assert.equal(parseMatchPage(jsonScript({ ...view, events: [{ backlogId: row.key, title: 'An event headline' }] })).items[0].title, row.title);
});

test('descriptionMd and minimumVerificationMd from the contestant view reach the item description', () => {
  const md = { key: 'TASK-91', title: 'Add shelf labels', descriptionMd: '# Add shelf labels\n\nInvented requirement text.', minimumVerificationMd: '# Scenarios\n\nRequired evidence: `shelf.png`.' };
  const description = parseMatchPage(jsonScript({ backlog: [md] })).items[0].description;
  assert.match(description, /Invented requirement text\./);
  assert.match(description, /minimumVerificationMd: # Scenarios/);
});

test('backlogTitle alias is accepted and code samples alone never supply a title', () => {
  assert.equal(parseMatchPage(sample + jsonScript({ backlog: [{ key: 'TASK-91', backlogTitle: 'Rename shelf markers' }] })).items[0].title, 'Rename shelf markers');
  assert.equal(parseMatchPage(sample).items[0].title, null);
  const html = `<pre>TASK-91\nInvented code label</pre><article><h2>TASK-91: Add shelf labels</h2></article>`;
  assert.equal(parseMatchPage(html).items[0].title, row.title);
});

test('command lines, URLs, endpoint text and React props are never titles', () => {
  for (const bad of [command, 'curl -X POST', 'https://example.invalid/items', 'POST /items', 'API endpoint: submit', 'npm run checks', 'Invoke-RestMethod -Method Post', 'GET /api/items']) {
    assert.equal(usableTitle(bad), null, bad);
    assert.equal(parseMatchPage(`<p>TASK-91</p><p>${bad}</p>`).items[0].title, null, bad);
  }
  assert.equal(parseMatchPage(jsonScript({ children: 'TASK-91', title: 'This is a React tooltip' })).items[0].title, null);
  assert.equal(parseMatchPage('<article><h2>TASK-91</h2><h3>Add shelf labels</h3></article>').items[0].title, row.title);
  assert.equal(parseMatchPage('<article><h2>TASK-91</h2></article><section><h2>Unrelated heading</h2></section>').items[0].title, null);
});
