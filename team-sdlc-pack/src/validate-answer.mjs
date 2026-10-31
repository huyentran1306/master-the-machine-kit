#!/usr/bin/env node
// Answer check for workers: node <pack>/src/validate-answer.mjs <answers/ID/submit.json> [<ID>-submit.schema.json]
// Same validator the helper uses at submit_work. No installs (no pip/ajv): set2 rehearsal, PI-01 spent
// 2.4 of its 6.4 minutes installing jsonschema and writing a validator before READY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';

export function checkSubmit(answerFile, schemaFile) {
  const problems = [];
  let raw;
  try { raw = fs.readFileSync(answerFile, 'utf8'); } catch { return [`cannot read ${answerFile}`]; }
  if (raw.charCodeAt(0) === 0xfeff) problems.push('submit.json starts with a BOM');
  let ans;
  try { ans = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { return [...problems, `not JSON: ${e.message}`]; }
  const id = path.basename(path.dirname(answerFile));
  if (ans.backlogId && ans.backlogId !== id) problems.push(`backlogId is ${ans.backlogId}, folder is ${id}`);
  if (['NOT_STARTED', 'DRAFT'].includes(ans.status)) problems.push(`status is still ${ans.status}`);
  if (schemaFile) {
    try { for (const e of validate(JSON.parse(fs.readFileSync(schemaFile, 'utf8')), ans).slice(0, 20)) problems.push(`schema: ${e}`); }
    catch (e) { problems.push(`schema unreadable: ${e.message}`); }
  }
  for (const ref of new Set((JSON.stringify(ans).match(/"evidence\/[^"]+"/g) || []).map((r) => JSON.parse(r)))) {
    if (!fs.existsSync(path.join(path.dirname(answerFile), ref))) problems.push(`missing ${ref}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [answer, schema] = process.argv.slice(2);
  if (!answer) { console.error('usage: validate-answer.mjs <submit.json> [schema.json]'); process.exit(2); }
  const p = checkSubmit(answer, schema);
  if (p.length) { console.log(`ANSWER INVALID (${p.length}):\n- ${p.join('\n- ')}`); process.exit(1); }
  console.log(`ANSWER OK${schema ? ' (schema valid)' : ' (no schema given)'}: ${answer}`);
}
