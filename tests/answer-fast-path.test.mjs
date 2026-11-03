import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { finishAnswer } from '../team-sdlc-pack/src/finish-answer.mjs';
import { answerDigest } from '../team-sdlc-pack/src/item-brief.mjs';

const pack = path.resolve('team-sdlc-pack/src');
const schema = { type: 'object', required: ['backlogId', 'status', 'rootCauseRelease'], properties: { backlogId: { type: 'string' }, status: { enum: ['DONE', 'PARTIAL', 'BLOCKED'] }, rootCauseRelease: { type: 'string', minLength: 1 } } };

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  const dir = path.join(root, 'M', 'answers', 'PI-01');
  fs.mkdirSync(dir, { recursive: true });
  const schemaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sch-')), 'PI-01-submit.schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  return { root, dir, file: path.join(dir, 'submit.json'), schemaFile };
}

test('validate-answer checks the schema given as the second positional argument', () => {
  const r = repo();
  fs.writeFileSync(r.file, JSON.stringify({ backlogId: 'PI-01', status: 'DONE', rootCauseRelease: '' }));
  let out = '';
  try { execFileSync('node', [path.join(pack, 'validate-answer.mjs'), r.file, r.schemaFile], { encoding: 'utf8' }); } catch (e) { out = e.stdout; }
  assert.match(out, /ANSWER INVALID/);
  fs.writeFileSync(r.file, JSON.stringify({ backlogId: 'PI-01', status: 'DONE', rootCauseRelease: 'rel-1' }));
  out = execFileSync('node', [path.join(pack, 'validate-answer.mjs'), r.file, r.schemaFile], { encoding: 'utf8' });
  assert.match(out, /ANSWER OK \(schema valid\): .*submit\.json/);
  out = execFileSync('node', [path.join(pack, 'validate-answer.mjs'), '--schema', r.schemaFile, r.file], { encoding: 'utf8' });
  assert.match(out, /schema valid\): .*submit\.json/);
});

test('finish-answer refuses an invalid answer and commits a valid one', () => {
  const r = repo();
  fs.writeFileSync(r.file, JSON.stringify({ backlogId: 'PI-01', status: 'NOT_STARTED', rootCauseRelease: 'x' }));
  const bad = finishAnswer(r.file, r.schemaFile);
  assert.equal(bad.ok, false);
  assert.match(bad.block, /ANSWER INVALID/);
  fs.writeFileSync(r.file, JSON.stringify({ backlogId: 'PI-01', status: 'DONE', rootCauseRelease: 'rel-1' }));
  const ok = finishAnswer(r.file, r.schemaFile, { message: 'PI-01: answer' });
  assert.equal(ok.ok, true);
  assert.match(ok.block, /^STATUS: READY\nCOMMIT: [0-9a-f]{40}/);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: r.root, encoding: 'utf8' }).trim(), 'PI-01: answer');
  assert.deepEqual(ok.dirty, []);
});

test('answer digest has item, template, KB once, and one UTC line per log entry', () => {
  const kbText = { ok: true, raw: { content: [{ type: 'text', text: JSON.stringify({ articles: [{ id: 'KB-INC-01', title: 'Incident report rules', body: 'Use names exactly as logged.' }] }) }] } };
  const md = answerDigest({
    item: { id: 'PI-01', description: 'Clients receive reminders.' },
    material: {
      submitTemplate: { backlogId: 'PI-01', status: 'NOT_STARTED' },
      mcpMaterial: [
        { purpose: 'discovery', tool: 'tools-list', ok: true, result: {} },
        { purpose: 'search', tool: 'kb_search', ok: true, result: kbText },
        { purpose: 'search', tool: 'kb_search', ok: true, result: kbText },
        { purpose: 'logs', tool: 'search_logs', ok: true, result: { raw: { content: [{ type: 'text', text: '{"total":0,"returned":0,"entries":[]}' }] } } },
        { purpose: 'logs', tool: 'search_logs-merged', ok: true, result: { unique: 2, truncated: [{ service: 'api', total: 37, fetched: 27, levelsOverLimit: ['INFO'] }], entries: [
          { timestamp: '2026-10-27T07:00:00+07:00', level: 'INFO', service: 'deploy', requestId: 'd-1', message: 'rel-1 deployed', flag: 'x.y' },
          { timestamp: '2026-10-27T08:00:00Z', level: 'WARN', service: 'reminder-worker', requestId: 'rem-1', message: 'Reminder sent' },
        ] } },
      ],
    },
  });
  assert.match(md, /Clients receive reminders/);
  assert.match(md, /"status": "NOT_STARTED"/);
  assert.equal(md.match(/KB-INC-01/g).length, 1);
  assert.match(md, /2026-10-27T00:00:00Z \(logged 2026-10-27T07:00:00\+07:00\) \| INFO \| deploy \| d-1 \| rel-1 deployed \| \{"flag":"x.y"\}/);
  assert.match(md, /Not complete for: api \(27\/37, over limit: INFO\)/);
});

test('failingTests reads vitest and jest failure names, so baseline-only failures can be told apart', async () => {
  const { failingTests } = await import('../team-sdlc-pack/src/gate.mjs');
  const vitest = ' FAIL  tests/accounting.test.ts > double-entry core > payment flips status\nAssertionError: expected PARTIAL\n      Tests  1 failed | 22 passed (23)';
  assert.deepEqual([...failingTests(vitest)], ['tests/accounting.test.ts > double-entry core > payment flips status']);
  assert.deepEqual([...failingTests('  ● invoices › rounds VND\n')], ['invoices › rounds VND']);
  assert.equal(failingTests('Tests 3 passed').size, 0);
});
