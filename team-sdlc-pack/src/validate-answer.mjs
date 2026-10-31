#!/usr/bin/env node
// Answer check for workers: node <pack>/src/validate-answer.mjs <answers/ID/submit.json> [<ID>-submit.schema.json]
// Same validator the helper uses at submit_work. No installs (no pip/ajv): set2 rehearsal, PI-01 spent
// 2.4 of its 6.4 minutes installing jsonschema and writing a validator before READY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';
import { checkAnswer } from './answers.mjs';
import { evidenceArrayRefs } from './required-evidence.mjs';

/** Same checks as submit_work's preflight that can run before commit: schema, checkAnswer, evidence files, required evidence. */
export function checkSubmit(answerFile, schemaFile, { required = [] } = {}) {
  const problems = [];
  let raw;
  try { raw = fs.readFileSync(answerFile, 'utf8'); } catch { return [`cannot read ${answerFile}`]; }
  if (raw.charCodeAt(0) === 0xfeff) problems.push('submit.json starts with a BOM');
  let ans;
  try { ans = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { return [...problems, `not JSON: ${e.message}`]; }
  const id = path.basename(path.dirname(answerFile));
  if (ans.backlogId && ans.backlogId !== id) problems.push(`backlogId is ${ans.backlogId}, folder is ${id}`);
  if (['NOT_STARTED', 'DRAFT'].includes(ans.status)) problems.push(`status is still ${ans.status}`);
  const chk = checkAnswer(ans, id, id.split('-')[0]); // the preflight's own rules (paths written as answers/<ID>/..., missing MVS evidence)
  for (const e of chk.errors) if (!problems.some((p) => p.includes(e.slice(0, 40)))) problems.push(e);
  const refs = evidenceArrayRefs(ans); // the submit preflight counts only arrays under an "evidence" key
  for (const name of required) {
    if (!fs.existsSync(path.join(path.dirname(answerFile), 'evidence', name))) problems.push(`required evidence evidence/${name} is missing`);
    else if (!refs.has(`evidence/${name}`)) problems.push(`REQUIRED_EVIDENCE_UNREFERENCED: add "evidence/${name}" to an evidence array`);
  }
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
  const args = process.argv.slice(2);
  const ri = args.indexOf('--required');
  const required = ri >= 0 ? String(args[ri + 1] || '').split(',').filter(Boolean) : [];
  const [answer, schema] = args.filter((a, i) => i !== ri && i !== ri + 1);
  if (!answer) { console.error('usage: validate-answer.mjs <submit.json> [schema.json] [--required a.log,b.png]'); process.exit(2); }
  const p = checkSubmit(answer, schema, { required });
  if (p.length) { console.log(`ANSWER INVALID (${p.length}):\n- ${p.join('\n- ')}`); process.exit(1); }
  console.log(`ANSWER OK${schema ? ' (schema valid)' : ' (no schema given)'}: ${answer}`);
}
