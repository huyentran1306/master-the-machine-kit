import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCodeIndex, ensureCodeIndex, loadCodeIndex, likelyFiles, renderLikelyFiles, itemTerms } from '../team-sdlc-pack/src/code-index.mjs';
import { writeItemBrief } from '../team-sdlc-pack/src/item-brief.mjs';

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['-C', root, 'init', '-q']);
  const m = path.join(root, 'app');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(m, rel)), { recursive: true }); fs.writeFileSync(path.join(m, rel), text); };
  w('packages/core/package.json', JSON.stringify({ name: '@acme/core', exports: { './shared/*': './src/shared/*.ts' } }));
  w('packages/web/package.json', JSON.stringify({ name: '@acme/web', imports: { '#hooks/*': './src/hooks/*.ts' } }));
  w('packages/core/src/shared/schedules.ts', 'export function getScheduleStatus(date, upcomingLength) {\n  return date <= upcomingLength ? "upcoming" : "scheduled";\n}\n');
  w('packages/core/src/shared/schedules.test.ts', "import { getScheduleStatus } from './schedules';\ntest('upcoming window', () => {});\n");
  w('packages/web/src/hooks/useUpcoming.ts', "import { getScheduleStatus } from '@acme/core/shared/schedules';\nexport const useUpcoming = () => getScheduleStatus;\n");
  w('packages/web/src/components/UpcomingLength.tsx', "import { useUpcoming } from '#hooks/useUpcoming';\nexport function UpcomingLength() { return useUpcoming(); }\n");
  // A large unrelated file that repeats many common words must not outrank the file that defines the subject.
  w('packages/web/src/big/everything.ts', Array.from({ length: 400 }, (_, i) => `export const status${i} = 'status window settings schedule evidence submit ${i}';`).join('\n'));
  w('packages/web/dist/bundle.js', 'getScheduleStatus upcoming window');
  w('packages/web/sw.js', "//#region ../../node_modules/workbox/x.js\nvar schedule = 'upcoming window status';\n");
  for (let i = 0; i < 30; i += 1) w(`packages/core/src/misc/m${i}.ts`, `export const m${i} = ${i};\n`);
  return { root, m };
}

test('code index: symbols, package exports/imports links, generated files skipped', t => {
  const { m } = repo(t);
  const idx = buildCodeIndex(m);
  const at = p => idx.files.findIndex(f => f.p === p);
  const sched = at('packages/core/src/shared/schedules.ts'); const hook = at('packages/web/src/hooks/useUpcoming.ts');
  assert.deepEqual(idx.files[sched].d, ['getScheduleStatus']);
  assert.ok(idx.files[hook].i.includes(sched), 'package "exports" wildcard resolved');
  assert.ok(idx.files[at('packages/web/src/components/UpcomingLength.tsx')].i.includes(hook), 'package "imports" (#hooks/*) resolved');
  assert.ok(idx.files[at('packages/core/src/shared/schedules.test.ts')].i.includes(sched), 'relative import resolved');
  assert.equal(at('packages/web/dist/bundle.js'), -1, 'build output skipped');
  assert.ok(!(idx.t.upcoming || []).includes(at('packages/web/sw.js')), 'bundled file keeps only path words');
});

test('likely files: ranked from the item words, joined word pairs, title, tests; boilerplate words from other items ignored', t => {
  const { m } = repo(t);
  const idx = buildCodeIndex(m);
  assert.ok(itemTerms('the upcoming length setting').has('upcominglength'));
  const corpus = ['Submit evidence for TASK-1', 'Submit evidence and schema', 'Answer: submit evidence', 'Status report with evidence'];
  const r = likelyFiles(idx, 'A schedule due on the last day of the window shows the wrong status. Submit evidence.', { title: 'Schedule status on the edge of the upcoming window', corpus });
  assert.equal(r.files[0].path, 'packages/core/src/shared/schedules.ts', JSON.stringify(r.files.slice(0, 3)));
  assert.ok(r.files[0].defs.includes('getScheduleStatus'));
  assert.deepEqual(r.files[0].tests, ['packages/core/src/shared/schedules.test.ts']);
  assert.ok(!r.terms.includes('evidence'), 'boilerplate shared by other items is not a code term');
  assert.ok(r.files.findIndex(f => f.path.endsWith('everything.ts')) !== 0);
  const explicit = likelyFiles(idx, 'Change `packages/web/src/components/UpcomingLength.tsx` only.');
  assert.equal(explicit.files[0].path, 'packages/web/src/components/UpcomingLength.tsx');
  const md = renderLikelyFiles(r, '/x/app');
  assert.match(md, /1\. packages\/core\/src\/shared\/schedules\.ts/); assert.match(md, /rg -n -m 20/);
  assert.equal(renderLikelyFiles(likelyFiles(idx, 'zzzz qqqq'), '/x'), '');
});

test('ensureCodeIndex builds once per match after the clone; every item brief gets likely-files.md and a digest', t => {
  const { root, m } = repo(t);
  const first = ensureCodeIndex({ checkoutRoot: root, matchRoot: m });
  assert.ok(first.codeIndexPath && first.files > 5);
  assert.equal(ensureCodeIndex({ checkoutRoot: root, matchRoot: m }).files, undefined, 'second call reuses the file');
  assert.ok(loadCodeIndex(root));
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /\/\.mtm-notes\//);
  const brief = writeItemBrief({ checkoutRoot: root, matchRoot: m, item: { id: 'BUG-09', type: 'BUG', title: 'Schedule status on the edge of the upcoming window', description: 'A schedule due on the last day of the window shows the wrong status.' },
    material: { files: {}, submitTemplate: { backlogId: 'BUG-09' }, mcpMaterial: [{ purpose: 'search', tool: 'kb_search', ok: true, result: { raw: { content: [{ type: 'text', text: JSON.stringify({ articles: [{ id: 'KB-SCH-1', title: 'Upcoming window', body: 'Inclusive of the last day.' }] }) }] } } }] },
    context: { answerOnly: false } });
  assert.match(fs.readFileSync(brief.likelyFilesPath, 'utf8'), /schedules\.ts/);
  assert.ok(brief.digestPath, 'code items get a digest too');
  assert.match(fs.readFileSync(brief.digestPath, 'utf8'), /KB-SCH-1 Upcoming window[\s\S]*Inclusive of the last day/);
});

test('a failed index build is not retried for every brief', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-noindex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.mtm-notes'), 'a file where the notes directory should be');
  const first = ensureCodeIndex({ checkoutRoot: root, matchRoot: root });
  assert.equal(first.codeIndexPath, null); assert.match(first.codeIndexWarning, /unavailable/);
  const started = Date.now();
  assert.equal(ensureCodeIndex({ checkoutRoot: root, matchRoot: root }).codeIndexWarning, first.codeIndexWarning);
  assert.ok(Date.now() - started < 50);
  const brief = writeItemBrief({ checkoutRoot: root, matchRoot: path.join(root, 'm'), item: { id: 'BUG-1', type: 'BUG', title: 'x' }, material: { files: {} } });
  assert.equal(brief.likelyFilesPath, null, 'brief still written without the index');
});
