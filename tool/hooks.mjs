#!/usr/bin/env node
// Codex lifecycle hooks of the Digital Project Team (install.mjs writes them into <CODEX_HOME>/hooks.json).
// ADLC "Govern": rules enforced by the harness, not only asked for in the prompt.
//   Stop          keeps the agent playing while the match runs: the reason becomes its next prompt
//   PreToolUse    denies moves that lose work or break the match rules (force push, reset --hard, ledger edits...)
//   SessionStart  after a restart or a compaction, tells the agent where the match stands
// Outside a match (no .mtm/match.json in the repo) every hook is a no-op, and any error fails open.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TOOL_DIR } from './lib/config.mjs';
import { readJson, writeJson, fmtMin } from './lib/util.mjs';

const KIT_DIR = path.dirname(TOOL_DIR);
const MTM = `node "${path.join(TOOL_DIR, 'mtm.mjs').replace(/\\/g, '/')}"`;
const MAX_CONTINUES = Number(process.env.MTM_KEEPALIVE_MAX || 300);
const FINISHED = ['FINISHED', 'ENDED', 'COMPLETED', 'CLOSED', 'OVER'];
const WAITING = ['WAITING', 'NOT_STARTED', 'READY', 'PENDING', 'CREATED', 'SCHEDULED'];

function matchState(cwd) {
  const cfg = loadConfig(process.env, cwd);
  const dir = cfg.runtimeDir;
  const match = readJson(path.join(dir, 'match.json'), null);
  if (!match?.matchId) return null;
  const finished = readJson(path.join(dir, 'finished.json'), null);
  const snap = readJson(path.join(dir, 'snapshot.json'), null);
  const finishedStates = cfg.states?.finishedStates || FINISHED;
  const now = Date.now() + (snap?.offsetMs || 0);
  const over = (finished && String(finished.matchId).toLowerCase() === String(match.matchId).toLowerCase())
    || (snap?.status && finishedStates.includes(snap.status))
    || (snap?.endsAt && now > snap.endsAt + 60000);
  const running = !!snap && !over && !!snap.status && !WAITING.includes(snap.status) && (snap.items?.length > 0 || !!snap.endsAt);
  return { cfg, dir, match, snap, over, running, armed: !!(match.armedAt || match.readyAt) || running, leftMin: snap?.endsAt ? (snap.endsAt - now) / 60000 : null };
}

const allow = () => ({});

function recordProbe(s, event) {
  try {
    writeJson(path.join(s.dir, 'hook-probe.json'), {
      matchId: s.match.matchId,
      event,
      at: new Date().toISOString(),
      pid: process.pid,
    });
  } catch { /* hooks are guardrails: a probe failure must not block normal work */ }
}

export function onStop(input, cwd) {
  if (process.env.MTM_KEEPALIVE === '0' || process.env.MTM_ROLE) return allow();
  const s = matchState(cwd);
  if (!s) return allow();
  recordProbe(s, 'Stop');
  if (s.over || !s.armed) return allow();
  const last = String(input.last_assistant_message || '').trim();
  if (!s.running && /^BLOCKED\b/.test(last)) return allow();
  const file = path.join(s.dir, 'stop-hook.json');
  const st = readJson(file, {});
  const count = st.matchId === s.match.matchId ? (st.count || 0) + 1 : 1;
  writeJson(file, { matchId: s.match.matchId, count, at: new Date().toISOString() });
  if (count > MAX_CONTINUES) return allow();
  const cur = s.match.current ? ` Current item: ${s.match.current}.` : '';
  const reason = s.running
    ? `MTM keep-alive: match ${s.match.matchId} is still running${s.leftMin != null ? ` (about ${fmtMin(s.leftMin)} left on the server clock)` : ''}. Do not end your turn, do not summarize.${cur} Run ${MTM} status and take NEXT; when nothing is actionable run ${MTM} watch --timeout 240. Only MATCH FINISHED ends the match.${/^BLOCKED\b/.test(last) ? ' BLOCKED is not allowed mid-match: note the problem in .mtm/notes.md and keep playing.' : ''}`
    : `MTM keep-alive: setup is done and match ${s.match.matchId} has not started yet. Do not end your turn: run ${MTM} watch --timeout 240 until it starts, then play.`;
  return { decision: 'block', reason };
}

// Each rule: [pattern on the command or patch text, reason shown to the agent]. Reading is never denied.
const WRITE = /((?<![0-9&])>|Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|WriteAll|\brm\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|\bmv\b|\bcp\b|\bmove\b|\bcopy\b|\*\*\* (Update|Add|Delete) File:)/i;
const RULES = [
  [/\bgit\b[^\n|;]*\bpush\b[^\n|;]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i,
    'Never force-push or rewrite pushed history. If the push is rejected: git pull --rebase, rerun MTM evidence, push, submit the new HEAD.'],
  [/\bgit\b[^\n|;]*\breset\b[^\n|;]*--hard\b/i,
    'git reset --hard destroys work. To drop the current item\'s changes: git stash push -u -m "DEAD <ID>". To pause it: git stash push -u -m "WIP <ID>".'],
  [/\bgit\b[^\n|;]*\bclean\b[^\n|;]*\s-[a-z]*x/i, 'git clean -x deletes .mtm/ (the match ledger). Use git clean -fd without -x, or stash.'],
  [/\bgit\b[^\n|;]*\b(checkout|restore)\b\s+(--\s+)?\.(\s|$|["'])/i, 'This discards every uncommitted change, including other paused work. Stash instead: git stash push -u -m "DEAD <ID>".'],
  [/\bgit\b[^\n|;]*\bstash\s+clear\b/i, 'git stash clear deletes the paused work of other items. Drop one entry: git stash drop \'stash@{N}\'.'],
  [/\bgit\b[^\n|;]*\b(rebase|add|commit|checkout|reset)\b[^\n|;]*\s(-i|--interactive|-p|--patch)\b/i, 'Interactive git waits for a human who is not there. Use the non-interactive form.'],
  [/(curl|wget|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|fetch\()[^\n]*\/(admin|grader)\b/i, 'Never call Admin or Grader APIs. Use MTM for every match action.'],
];

function commandText(input) {
  const ti = input.tool_input;
  if (ti == null) return '';
  if (typeof ti === 'string') return ti;
  const parts = [];
  for (const k of ['command', 'cmd', 'input', 'patch', 'chars', 'script', 'file_path', 'path', 'content']) {
    const v = ti[k];
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.join(' '));
  }
  return parts.length ? parts.join('\n') : JSON.stringify(ti);
}

export function onPreToolUse(input, cwd) {
  const s = matchState(cwd);
  if (!s) return allow();
  recordProbe(s, 'PreToolUse');
  if (s.over) return allow();
  const text = commandText(input);
  if (!text) return allow();
  const deny = (reason) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `MTM guard: ${reason}` },
  });
  for (const [re, reason] of RULES) if (re.test(text)) return deny(reason);
  const flat = text.replace(/\\\\/g, '/').replace(/\\/g, '/');
  if (WRITE.test(text)) {
    if (/\.mtm\/+(ledger|match|snapshot|session|finished|stop-hook|hook-probe)\.json/i.test(flat)) return deny('mtm owns .mtm/*.json. Change the match state only through MTM commands.');
    if (/(Remove-Item|\brm\b|\brmdir\b|\brd\b|\bdel\b)[^\n|;]*\.mtm(\/?["'\s]|\/?$)/im.test(flat)) return deny('.mtm/ holds the match ledger; never delete it.');
    // Running MTM itself names the kit folder too: only other mentions of the kit count as edits.
    const kit = KIT_DIR.replace(/\\/g, '/').toLowerCase();
    if (flat.toLowerCase().split(`${kit}/tool/mtm.mjs`).join('').includes(kit)) return deny('Never edit the kit during a match.');
    if (/\.codex\/+(hooks\.json|config\.toml|AGENTS(\.override)?\.md|skills\/mtm-)/i.test(flat)) return deny('The Codex settings of the kit are fixed during a match.');
  }
  return allow();
}

export function onSessionStart(input, cwd) {
  const s = matchState(cwd);
  if (!s) return allow();
  recordProbe(s, 'SessionStart');
  if (s.over || !s.armed) return allow();
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `MTM: match ${s.match.matchId} is in progress (current item: ${s.match.current || 'none'}). First run ${MTM} doctor and follow "Resume after a restart" in AGENTS.md, then keep playing until MATCH FINISHED.`,
    },
  };
}

const HANDLERS = { Stop: onStop, PreToolUse: onPreToolUse, SessionStart: onSessionStart };

async function main() {
  let out = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    const input = raw ? JSON.parse(raw) : {};
    const fn = HANDLERS[input.hook_event_name];
    if (fn) out = fn(input, input.cwd || process.cwd()) || {};
  } catch {
    out = {};
  }
  process.stdout.write(JSON.stringify(out));
}

main();
