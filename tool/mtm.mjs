#!/usr/bin/env node
// mtm: the Digital Project Team's hands for a Master the Machine match.
// Talks to Game Master, keeps a per-match ledger in <repo>/.mtm/, prints state-based alerts on
// every command, and refuses unsafe moves (submit before start, double submit, unpushed or
// off-branch commit, untested content, unfilled template).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, KIT_VERSION } from './lib/config.mjs';
import { GmClient, GmError, normalizeMatch } from './lib/gm-client.mjs';
import {
  rankItems, minutesLeft, toSnapshot, nextSnapshot, diffSnapshots, isLoud, computeAlerts, plannerOptions, isDone,
} from './lib/planner.mjs';
import {
  git, resolveRev, treeOf, dirtyFiles, isPushed, ensureExcluded, workingTreeHash, upstreamOf, hasCommits,
  aheadBehind, pushDryRun, writeProbe,
} from './lib/git.mjs';
import { buildRepoMap, detectModules } from './lib/recon.mjs';
import { runCommand } from './lib/run.mjs';
import {
  contractTemplate, parseContract, scopeCheck, isTestFile, buildRetro, REVIEW_INSTRUCTIONS,
} from './lib/adlc.mjs';
import { buildCoachReport, renderCoachHtml } from './lib/coach.mjs';
import {
  readJson, writeJson, writeText, fmtMin, tailLines, clip, stripHtml, setPath, findPlaceholders,
  sleep, parseDuration, renameWithRetry, hashText, decodeText,
} from './lib/util.mjs';

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_FINISHED = 3;

const HELP = `mtm ${KIT_VERSION} <command>
  init --base-url URL --match ID [--token T]  save match settings (a new match id archives the old state)
  doctor                       check config, git write/push rights, toolchains, Game Master
  recon                        write and print .mtm/repo-map.md (modules, install/build/test commands)
  ready                        report ready (if the ready endpoint is configured)
  status [--raw]               events, alerts, item table, NEXT
  next | poll                  NEXT only | one fetch with events since last look
  watch [--timeout 240] [--interval 5]   wait until something changes (prints MATCH FINISHED at the end)
  show <ID>                    saved brief, MVS and template of an item
  start <ID>                   Start working: brief, template, MVS and a Task Contract into .mtm/items/<ID>/
  evidence <ID> [--timeout-min 6] [--tail 25] -- <command> [args...]
                               run a check (CI=true, tree-killed on timeout), log it, tie it to the code
  fill <ID> 'field=text' 'field=@file' 'list:=[...]'   fill submission.json without hand-editing JSON
  submit <ID> [--dry-run]      one-shot submit with every guard
  review <ID>                  check the diff against the Task Contract; write a pack for a read-only reviewer
  park <ID> [--reason TEXT]    put an item aside (NEXT ranks it last); "start" picks it up again
  mark <ID> --started|--submitted [--rev SHA]   record an action done through the organizers' own tool
  report                       minutes per item and per type, for tuning estMinutes
  coach                        write .mtm/coach.html: read-only timing, quality and readiness dashboard
  retro                        after the match: .mtm/retro.md with signals and planner tuning (ADLC Observe)`;

// Allowed flags per command. Unknown flags and bad values are refused before any network call.
const FLAGS = {
  init: { 'base-url': 'string', match: 'string', token: 'string' },
  doctor: {}, recon: {}, ready: {}, next: {}, poll: {}, show: {}, fill: {}, report: {}, coach: {}, review: {}, retro: {},
  start: { refetch: 'bool' },
  status: { raw: 'bool' },
  watch: { timeout: 'duration', interval: 'duration' },
  evidence: { 'timeout-min': 'number', tail: 'number', cwd: 'string' },
  submit: { file: 'string', rev: 'string', 'dry-run': 'bool' },
  park: { reason: 'string' },
  mark: { started: 'bool', submitted: 'bool', rev: 'string' },
};

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  let rest = [];
  const name = argv.find((a) => !a.startsWith('--'));
  const spec = FLAGS[name] || {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (/^-[A-Za-z]/.test(a)) throw new Error(`unknown flag ${a}: flags take two dashes (-${a}). See: mtm --help`);
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === 'help') { flags.help = true; continue; }
    const type = spec[key];
    if (!type) throw new Error(`unknown flag --${key} for "${name ?? ''}". See: mtm --help`);
    if (type === 'bool') {
      if (val != null && !/^(true|1|yes)$/i.test(val)) throw new Error(`--${key} takes no value`);
      flags[key] = true;
      continue;
    }
    if (val == null) {
      val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
      i++;
    }
    if (type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number, got "${val}"`);
      flags[key] = n;
    } else if (type === 'duration') {
      const s = parseDuration(val);
      if (s == null || s <= 0) throw new Error(`--${key} must be a duration like 240, 90s or 4m, got "${val}"`);
      flags[key] = s;
    } else flags[key] = val;
  }
  return { pos, flags, rest };
}

const STATE_FILES = ['ledger.json', 'snapshot.json', 'journal.md', 'items', 'repo-map.md', 'match.json', 'finished.json',
  'stop-hook.json', 'hook-probe.json', 'degraded.json', 'retro.md'];
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

class Ctx {
  constructor() {
    this.notices = [];
    this.load();
  }

  load() {
    this.cfg = loadConfig();
    this.client = new GmClient(this.cfg);
    this.dir = this.cfg.runtimeDir;
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.cfg.isRepo && !ensureExcluded(this.cfg.repo)) this.notices.push('WARN could not add .mtm/ to .git/info/exclude');
    this.matchGuard();
  }

  /** One match per .mtm/: a different match id moves the previous match's state to .mtm/archive/. */
  matchGuard() {
    const id = this.cfg.matchId;
    const file = this.p('match.json');
    const cur = readJson(file, null);
    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    if (!id || (cur && same(cur.matchId, id))) { this.match = cur || { matchId: id }; return; }
    const present = STATE_FILES.filter((f) => f !== 'match.json' && fs.existsSync(this.p(f)));
    if (present.length) {
      const old = cur?.matchId || 'unknown';
      const dest = this.p('archive', `${safeName(old)}-${stamp()}`);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of STATE_FILES) if (fs.existsSync(this.p(f))) renameWithRetry(this.p(f), path.join(dest, f));
      this.notices.push(`NEW MATCH ${id}: state of match ${old} moved to ${rel(this, dest)}`);
      const stashList = (this.cfg.isRepo && git(this.cfg.repo, ['stash', 'list'], { allowFail: true })) || '';
      const stale = stashList.split(/\r?\n/).filter((l) => /(WIP|PARKED|DEAD) /.test(l));
      if (stale.length) this.notices.push(`NOTE ${stale.length} stash entries from earlier matches (${stale.map((l) => l.split(':')[0]).join(', ')}): never pop them in this match`);
    }
    this.match = { matchId: id, since: new Date().toISOString(), current: null };
    writeJson(file, this.match);
  }

  saveMatch(patch) {
    this.match = { ...(this.match || {}), matchId: this.cfg.matchId, ...patch };
    writeJson(this.p('match.json'), this.match);
  }

  /** The item worked on now. Time spent on an item counts only while it is current (not while stashed). */
  setCurrent(id, serverNow = null) {
    const now = Date.now();
    const prev = this.match?.current || null;
    if (prev === id) return;
    if (prev && this.match.currentSince) {
      const l = this.ledger()[prev];
      if (l) {
        const activeMs = (l.activeMs || 0) + Math.max(0, now - this.match.currentSince);
        const currentServerSince = this.match.currentServerSince;
        const activeServerMs = currentServerSince != null && serverNow != null
          ? (l.activeServerMs || 0) + Math.max(0, serverNow - currentServerSince)
          : l.activeServerMs;
        this.updateLedger(prev, { activeMs, ...(activeServerMs != null ? { activeServerMs } : {}) });
      }
    }
    // Remember the item that was interrupted (for example by a PI), to make it current again after the submit.
    const unfinished = prev && !this.ledger()[prev]?.submittedAt && !this.ledger()[prev]?.parkedAt;
    this.saveMatch({
      current: id,
      currentSince: id ? now : null,
      currentServerSince: id && serverNow != null ? serverNow : null,
      previous: id && unfinished ? prev : (id ? this.match?.previous ?? null : null),
    });
  }

  p(...parts) { return path.join(this.dir, ...parts); }
  itemDir(id) { return this.p('items', id); }
  ledger() { return readJson(this.p('ledger.json'), {}); }
  updateLedger(id, patch) {
    const l = this.ledger();
    l[id] = { ...(l[id] || {}), ...patch };
    writeJson(this.p('ledger.json'), l);
    return l[id];
  }
  journal(text) {
    fs.appendFileSync(this.p('journal.md'), `- ${new Date().toISOString()} ${text}\n`);
  }
  saveSnapshot(match) { writeJson(this.p('snapshot.json'), nextSnapshot(this.loadSnapshot(), match)); }
  loadSnapshot() { return readJson(this.p('snapshot.json'), null); }
  plannerOpts(m) {
    return {
      ...this.cfg.planner,
      ...(this.cfg.states || {}),
      matchEndsAt: m?.endsAt,
      current: this.match?.current || null,
      currentSince: this.match?.currentSince || null,
      currentServerSince: this.match?.currentServerSince ?? null,
    };
  }

  /** One quick look at the match without retries, for alerts on commands that do not need the match. */
  async peekMatch() {
    try {
      const quick = new GmClient(this.cfg, { timeoutMs: 4000 });
      const r = await quick.call('match');
      if (r.status >= 400) return null;
      const m = normalizeMatch(r, this.cfg.map, Date.now(), quick.api);
      return m.unparsed || m.mapErrors.length ? null : m;
    } catch {
      return null;
    }
  }

  /** Prints state-based alerts; an ABANDON alert is printed once per item. */
  printAlerts(m) {
    if (!m || m.unparsed) return;
    const led = this.ledger();
    const alerts = computeAlerts(m, led, this.plannerOpts(m));
    for (const a of alerts) {
      console.log(a);
      const ab = a.match(/^!! ABANDON (\S+):/);
      if (ab) this.updateLedger(ab[1], { abandonNotified: true });
    }
  }

  printNotices() {
    for (const n of this.notices) console.log(n);
    this.notices = [];
  }
}

function rel(ctx, file) {
  return path.relative(ctx.cfg.repo, file).replace(/\\/g, '/');
}

function localLabel(item, local = {}, o) {
  if (item.result) return `${item.result}${item.score != null ? ` ${item.score}` : ''}`;
  if (local.submittedAt || (item.submissionStatus && isDone(item, {}, o))) return `submitted${item.submissionStatus ? ` (${item.submissionStatus})` : ''}, grading`;
  if (local.submitUncertainAt) return 'submit uncertain: check';
  if (local.parkedAt) return 'parked';
  if (local.startedAt) return `started ${((Date.now() - local.startedAt) / 60000).toFixed(1)}m ago`;
  return '';
}

function matchHeader(ctx, m) {
  const ends = m.endsAt ? ` | ends in ${fmtMin((m.endsAt - m.serverNow) / 60000)}` : '';
  const score = m.score != null ? ` | score ${m.score}` : '';
  const t = new Date(m.serverNow).toISOString().slice(11, 19);
  const clock = m.clock === 'server' ? 'server' : m.clock === 'http-date' ? 'server (Date header)' : 'LOCAL clock: no serverTime';
  return `MATCH ${ctx.cfg.matchId ?? '?'} ${m.status}${ends}${score} | ${clock} ${t}Z`;
}

function nextLines(ctx, m) {
  const { ranked, skipped } = rankItems(m.items, ctx.ledger(), m.serverNow, ctx.plannerOpts(m));
  const lines = [];
  if (!ranked.length) lines.push('NEXT: nothing actionable. Run: mtm watch');
  else {
    const top = ranked[0];
    const more = ranked.slice(1, 4).map((r) => r.item.id).join(', ');
    lines.push(`NEXT: ${top.item.id} (${top.why})${more ? `  then: ${more}` : ''}`);
  }
  if (skipped.length) lines.push(`skipped: ${skipped.slice(0, 5).map((s) => `${s.item.id} (${s.why})`).join(', ')}`);
  return lines;
}

function printTable(ctx, m) {
  const led = ctx.ledger();
  const o = plannerOptions(ctx.plannerOpts(m));
  const rows = m.items.map((it) => {
    const left = minutesLeft(it, m.serverNow);
    return [it.id, it.type, it.state ?? '-', it.maxPoints ?? '-', `${fmtMin(left)}${it.deadlineEstimated && left != null ? '~' : ''}`, localLabel(it, led[it.id], o)];
  });
  const head = ['ID', 'TYPE', 'STATE', 'PTS', 'LEFT', 'PROGRESS'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  console.log(fmt(head));
  rows.forEach((r) => console.log(fmt(r)));
}

function printUnparsed(m) {
  if (m.unparsed) {
    console.log('MATCH PAGE NOT JSON: items cannot be tracked automatically (DEGRADED mode: start/submit');
    console.log('still work for ids shown on the page; the server does the checks). Page text:');
    console.log(clip(stripHtml(m.rawText), 3000));
  } else {
    console.log(`MAPPING PROBLEM: ${m.mapErrors.join('; ')}. Response keys: ${Object.keys(m.raw || {}).join(', ')}`);
    console.log('Work in DEGRADED mode: use MTM start/submit with the ids in this response. The map in gm.config.json is fixed by the team before Start, never during the match.');
  }
}

function printEvents(m, events) {
  for (const e of events) {
    console.log(`  ${e.text}`);
    if (e.kind === 'NEW') {
      const it = m.items.find((i) => i.id === e.id);
      if (it) console.log(`    ${clip(it.title || it.description, 160)}`);
    }
  }
}

/** Refreshes the brief of a started item whose spec changed, so the agent works on the new text. */
function handleEvents(ctx, m, events) {
  const led = ctx.ledger();
  for (const e of events) {
    const local = led[e.id];
    if (!local?.startedAt || local.submittedAt) continue;
    if (e.kind === 'EDITED') {
      const it = m.items.find((i) => i.id === e.id);
      const d = ctx.itemDir(e.id);
      const brief = path.join(d, 'brief.md');
      if (it && fs.existsSync(brief)) {
        if (!fs.existsSync(path.join(d, 'brief.orig.md'))) fs.copyFileSync(brief, path.join(d, 'brief.orig.md'));
        fs.copyFileSync(brief, path.join(d, 'brief.prev.md'));
        const startJson = readJson(path.join(d, 'start-response.json'), null);
        writeText(brief, renderBrief(it, startJson, `${(e.edits || []).join(', ')} changed at ${new Date().toISOString()}; previous text: brief.prev.md, original: brief.orig.md`));
      }
      if ((e.edits || ['spec']).includes('spec')) {
        console.log(`!! SPEC CHANGED ${e.id}: the customer changed the request; re-read .mtm/items/${e.id}/brief.md before you commit`);
      } else {
        console.log(`note: ${e.id} ${(e.edits || []).join(' and ')} changed; the request text is the same (mtm status shows LEFT)`);
      }
    }
    if (e.kind === 'REMOVED') {
      console.log(ctx.match?.current === e.id
        ? `!! REMOVED ${e.id}: the customer withdrew it; stash its changes: git stash push -u -m "DEAD ${e.id}", then take NEXT`
        : `!! REMOVED ${e.id}: withdrawn. It is not your current item: after the current item, drop its WIP/PARKED stash entry instead of popping it`);
    }
  }
}

const MAPPED_ITEM_KEYS = new Set(['id', 'type', 'title', 'description', 'state', 'maxPoints', 'revealedAt',
  'deadlineAt', 'deadlineMinutes', 'submission']);

function otherFields(obj, skip) {
  if (!obj || typeof obj !== 'object') return [];
  const lines = [];
  let total = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || v == null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const line = `- ${k}: ${s.length > 1500 ? `${s.slice(0, 1500)}...` : s}`;
    total += line.length;
    if (total > 6000) { lines.push('- (more fields in the raw response)'); break; }
    lines.push(line);
  }
  return lines;
}

function renderBrief(item, startJson, note) {
  const deadline = item.deadlineAt
    ? `deadline ${new Date(item.deadlineAt).toISOString()}${item.deadlineEstimated ? ' (estimated from minutes; pauses extend it)' : ''} on the server clock`
    : 'no deadline';
  const out = [
    `# ${item.id} ${item.type} | ${item.maxPoints ?? '?'} pts | ${deadline}. Time left: mtm status (LEFT).`,
    note ? `> ${note}` : '',
    item.title ? `## ${item.title}` : '',
    typeof item.description === 'string' ? item.description || '(no description; check the template and other fields)' : JSON.stringify(item.description, null, 2),
  ];
  const fromPage = otherFields(item.raw, MAPPED_ITEM_KEYS);
  if (fromPage.length) out.push('## Other fields on the match page', ...fromPage);
  const fromStart = otherFields(startJson, new Set(['template', 'mvs', 'itemId', 'startedAt']));
  if (fromStart.length) out.push('## Other fields in the Start working reply', ...fromStart);
  return out.filter(Boolean).join('\n\n');
}

function renderMvs(mvs) {
  if (mvs == null || mvs === '' || (Array.isArray(mvs) && !mvs.length)) return null;
  if (typeof mvs === 'string') return mvs;
  if (Array.isArray(mvs)) return mvs.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
  return JSON.stringify(mvs, null, 2);
}

function printItemFiles(ctx, id) {
  const d = ctx.itemDir(id);
  for (const f of ['brief.md', 'mvs.md', 'contract.md']) {
    const p = path.join(d, f);
    if (fs.existsSync(p)) console.log(fs.readFileSync(p, 'utf8').trim(), '\n');
  }
  const tpl = ['template.json', 'template.txt'].map((f) => path.join(d, f)).find((p) => fs.existsSync(p));
  if (tpl) console.log(`## Submit template (${rel(ctx, tpl)})\n${clip(fs.readFileSync(tpl, 'utf8'), 4000)}\n`);
  const sub = path.join(d, 'submission.json');
  if (fs.existsSync(sub)) console.log(`Fill: MTM fill ${id} 'field=text' ... (lists: 'field:=[...]', long text: 'field=@file'); gitRevision is set by MTM submit`);
}

/** Writes the Task Contract skeleton once (never over the agent's edits). */
function ensureContract(ctx, id, type, points, mvs) {
  const file = path.join(ctx.itemDir(id), 'contract.md');
  if (!fs.existsSync(file)) writeText(file, contractTemplate({ id, type, points, mvs }));
  return file;
}

function pageMentions(m, id) {
  const text = m.unparsed ? stripHtml(m.rawText) : JSON.stringify(m.raw ?? '');
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`).test(text);
}

function typeOfId(id) {
  const p = String(id).split('-')[0].toUpperCase();
  return ['PI', 'BUG', 'CR', 'TASK'].includes(p) ? p : 'TASK';
}

// ---------------------------------------------------------------- commands

async function cmdInit(ctx, { flags }) {
  const file = ctx.p('session.json');
  const s = readJson(file, {});
  if (typeof flags['base-url'] === 'string') s.baseUrl = flags['base-url'];
  if (typeof flags.match === 'string') s.matchId = flags.match;
  if (typeof flags.token === 'string') s.token = flags.token;
  writeJson(file, s);
  // session.json may contain the bearer token. Restrict it on platforms with POSIX modes.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* doctor reports the token source without printing it */ }
  }
  ctx.load(); // a new match id archives the previous match's state now
  ctx.printNotices();
  console.log(`saved ${rel(ctx, file)}: baseUrl=${s.baseUrl ?? '-'} matchId=${s.matchId ?? '-'} token=${s.token ? 'stored in .mtm/session.json (git-ignored)' : (ctx.cfg.tokenSource || 'none')}`);
  for (const v of ctx.cfg.envOverrides) console.log(`WARN environment variable ${v} overrides the value you just saved`);
  return EXIT_OK;
}

function where(bin) {
  const r = process.platform === 'win32'
    ? spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0;
}

// Each entry: stack pattern -> groups of alternatives; one binary per group must work.
const TOOLCHAINS = [
  [/^Node/, [['node'], ['npm', 'pnpm', 'yarn']]], [/Maven/, [['mvn', 'MVNW'], ['java']]], [/Gradle/, [['java']]], [/^\.NET/, [['dotnet']]],
  [/Python/, [['py', 'python', 'python3']]], [/^Go$/, [['go']]], [/Rust/, [['cargo']]], [/PHP/, [['php'], ['composer']]],
];

function runs(bin) {
  // "where" also finds the Microsoft Store python shim; asking for a version proves the tool works.
  return spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000, shell: process.platform === 'win32' }).status === 0;
}

function missingTools(repo, mod) {
  const out = [];
  for (const s of mod.stack) {
    for (const [re, groups] of TOOLCHAINS) {
      if (!re.test(s)) continue;
      for (const alts of groups) {
        const ok = alts.some((b) => (b === 'MVNW' ? ['mvnw', 'mvnw.cmd'].some((w) => fs.existsSync(path.join(repo, mod.dir, w))) : where(b) && runs(b)));
        if (!ok) out.push(alts.filter((b) => b !== 'MVNW').join(' or '));
      }
    }
  }
  return out;
}

async function cmdDoctor(ctx) {
  const c = ctx.cfg;
  const problems = [];
  const warns = [];
  let resuming = false;
  console.log(`mtm ${KIT_VERSION} | node ${process.version} | repo ${c.repo}`);
  if (!c.isRepo) problems.push('not inside a git repository: run mtm from the team repo (or set MTM_REPO)');
  console.log(`match ${c.matchId ?? 'MISSING'} | baseUrl ${c.baseUrl ?? 'MISSING'} | token ${c.tokenSource || 'none'} | config ${path.basename(c.configFile)}`);
  if (!c.matchId) problems.push('matchId missing: mtm init --base-url <url> --match <id> (from the launch prompt)');
  if (!c.baseUrl && !Object.values(c.endpoints || {}).every((e) => e.exec)) problems.push('baseUrl missing: mtm init --base-url <url>');
  const localBase = c.baseUrl && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(c.baseUrl);
  if (localBase) warns.push('baseUrl is localhost: that is the rehearsal mock, not the real Game Master');
  if (c.adapterStatus !== 'VERIFIED' && !localBase) problems.push(`Game Master adapter is ${c.adapterStatus || 'UNVERIFIED'}: map the organizer's real API/CLI in gm.config.json, rehearse it, then set adapterStatus to VERIFIED`);
  for (const v of c.envOverrides) warns.push(`environment variable ${v} overrides .mtm/session.json`);

  if (c.isRepo) {
    const branch = git(c.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
    const up = upstreamOf(c.repo);
    const remote = git(c.repo, ['remote', 'get-url', 'origin'], { allowFail: true });
    const graded = c.submit?.gradedBranch || up?.branch || null;
    console.log(`git branch ${branch ?? 'NONE'} | upstream ${up ? `${up.remote}/${up.branch}` : 'none'} | graded branch ${graded ?? 'unknown'} | origin ${remote ? 'configured' : 'MISSING'}`);
    if (!remote) problems.push('no git remote "origin"');
    if (branch === 'HEAD') problems.push('detached HEAD: check out the branch Game Master grades');
    if (graded && !ctx.match?.branch) ctx.saveMatch({ branch: graded });
    if (!git(c.repo, ['config', 'user.email'], { allowFail: true }) || !git(c.repo, ['config', 'user.name'], { allowFail: true })) {
      problems.push('git user.name / user.email not set: commits will fail');
    }
    if (!hasCommits(c.repo)) {
      const heads = git(c.repo, ['ls-remote', '--heads', 'origin'], { allowFail: true, timeoutMs: 30000 });
      problems.push(heads ? 'the clone has no commits yet but origin has some: git pull (or clone again)' : 'the repo has no commits yet: Game Master may not have pushed the source; wait and pull');
    } else if (!writeProbe(c.repo)) problems.push('cannot write to .git (sandbox?): commits and stashes will fail');
    if (remote) {
      if (git(c.repo, ['ls-remote', '--heads', 'origin'], { allowFail: true, timeoutMs: 30000 }) === null) problems.push('origin not reachable (network, proxy or credentials)');
      else if (graded) {
        const pd = pushDryRun(c.repo, 'origin', graded);
        if (!pd.ok) problems.push(`push to origin/${graded} would fail: ${pd.message}`);
        else console.log(`git push rights on origin/${graded}: OK`);
      }
      if (up) {
        git(c.repo, ['fetch', '--quiet', up.remote], { allowFail: true, timeoutMs: 60000 });
        const ab = aheadBehind(c.repo, `${up.remote}/${up.branch}`);
        if (ab && ab.behind > 0 && ab.ahead > 0) problems.push(`local branch diverged from ${up.remote}/${up.branch} (ahead ${ab.ahead}, behind ${ab.behind}): use a fresh clone of the new source`);
        else if (ab && ab.behind > 0) problems.push(`behind ${up.remote}/${up.branch} by ${ab.behind}: git pull --ff-only`);
      }
    }
    if (process.platform === 'win32' && git(c.repo, ['config', 'core.longpaths'], { allowFail: true }) !== 'true') warns.push('core.longpaths is off: deep Java/Node paths can fail (git config core.longpaths true)');
    const led = ctx.ledger();
    const ids = Object.keys(led);
    resuming = ids.some((id) => id !== 'BASELINE');
    if (resuming) {
      const open = ids.filter((id) => led[id].startedAt && !led[id].submittedAt).sort((a, b) => led[b].startedAt - led[a].startedAt);
      const stashes = git(c.repo, ['stash', 'list'], { allowFail: true }) || '';
      console.log(`RESUMING match ${c.matchId}: ${ids.length} items in the ledger | current ${ctx.match?.current ?? 'none'} | started, not submitted (newest first): ${open.join(', ') || 'none'} | ready ${ctx.match?.readyAt ? 'sent' : 'NOT sent'}`);
      console.log(`  uncommitted files: ${dirtyFiles(c.repo).length} | stashes: ${stashes ? stashes.split(/\r?\n/).map((s) => s.replace(/^(stash@\{\d+\}): (On [^:]+: )?/, "'$1' ")).join('; ') : 'none'}`);
    }
    const mods = detectModules(c.repo);
    // The main module (the root, or the first one found) must be runnable; helper folders only warn.
    mods.forEach((m, i) => {
      const miss = missingTools(c.repo, m);
      if (!miss.length) return;
      const main = m.dir === '.' || (i === 0 && !mods.some((x) => x.dir === '.'));
      (main ? problems : warns).push(`toolchain missing for ${m.dir === '.' ? 'the repo' : m.dir}: ${miss.join(', ')}${main ? ' (install before the match)' : ''}`);
    });
    console.log(`modules: ${mods.map((m) => `${m.dir} (${m.stack.map((s) => s.split(':')[0]).join('+')})`).join(', ') || 'none detected'}`);
  }
  if (!where('rg')) warns.push('ripgrep (rg) not found: use "git grep -n" to search');
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const agents = path.join(home, 'AGENTS.md');
  const installed = fs.existsSync(agents) && fs.readFileSync(agents, 'utf8').includes('MTM:BEGIN');
  if (!installed) warns.push(`kit instructions not found in ${agents}: run node install.mjs for this Codex home`);
  const globalOverride = path.join(home, 'AGENTS.override.md');
  if (fs.existsSync(globalOverride)) problems.push(`${globalOverride} overrides the global AGENTS.md, so the MTM match instructions are not loaded`);
  if (c.isRepo) {
    const cwd = path.resolve(process.cwd());
    const relCwd = path.relative(c.repo, cwd);
    const dirs = [c.repo];
    if (relCwd && !relCwd.startsWith('..') && !path.isAbsolute(relCwd)) {
      let d = c.repo;
      for (const part of relCwd.split(path.sep)) { d = path.join(d, part); dirs.push(d); }
    }
    const projectInstructions = dirs.map((d) => ['AGENTS.override.md', 'AGENTS.md']
      .map((n) => path.join(d, n)).find((f) => fs.existsSync(f))).filter(Boolean);
    if (projectInstructions.length) warns.push(`project instructions load after the global kit and may override it: ${projectInstructions.join(', ')}. The Game Player launch prompt must explicitly preserve the MTM match loop and safety rules`);
  }
  const hooksFile = path.join(home, 'hooks.json');
  const hooksConfigured = fs.existsSync(hooksFile) && fs.readFileSync(hooksFile, 'utf8').includes('tool/hooks.mjs');
  if (!hooksConfigured) {
    warns.push(`keep-alive and guard hooks not found in ${hooksFile}: run node install.mjs, then trust them once in Codex (/hooks)`);
  } else {
    const probe = readJson(ctx.p('hook-probe.json'), null);
    const age = probe?.at ? Date.now() - Date.parse(probe.at) : Infinity;
    if (probe?.matchId === c.matchId && Number.isFinite(age) && age < 10 * 60000) console.log(`Codex hook probe: OK (${probe.event}, ${Math.round(age / 1000)}s ago)`);
    else warns.push('hooks are configured but were not observed in this match session: run doctor through Codex after /hooks shows the MTM hooks as trusted');
  }
  const codexConfig = path.join(home, 'config.toml');
  if (fs.existsSync(codexConfig)) {
    const raw = fs.readFileSync(codexConfig, 'utf8');
    const features = raw.split(/\r?\n(?=\s*\[)/).find((section) => /^\s*\[features\]\s*$/mi.test(section)) || '';
    if (/^\s*hooks\s*=\s*false\s*(?:#.*)?$/mi.test(features)) problems.push(`${codexConfig} disables hooks; enable [features].hooks before the match`);
    if (/^\s*allow_managed_hooks_only\s*=\s*true\s*(?:#.*)?$/mi) warns.push(`${codexConfig} allows only managed hooks; verify the locally installed MTM hooks actually run`);
  }
  try {
    const m = await ctx.client.getMatch();
    if (m.unparsed || m.mapErrors.length) { printUnparsed(m); problems.push('Game Master response not understood'); }
    else {
      console.log(`${matchHeader(ctx, m)} | ${m.items.length} items visible`);
      if (m.finished) problems.push(`match ${c.matchId} is already ${m.status}: wrong match id?`);
      if (m.clock === 'local') warns.push('no serverTime in the response: deadlines use the local clock');
      const known = ['WAITING', 'RUNNING', 'PAUSED', 'FINISHED', 'READY', 'NOT_STARTED', 'STARTED'];
      if (!known.includes(m.status) && !m.finished && !m.paused) warns.push(`match status "${m.status}" is not a known value: check map.matchStatus / states`);
      const types = [...new Set(m.items.map((i) => i.type))].filter((t) => !['PI', 'BUG', 'CR', 'TASK'].includes(t));
      if (types.length) warns.push(`unknown item types: ${types.join(', ')}`);
    }
  } catch (e) {
    problems.push(`Game Master: ${e.message}`);
  }
  ctx.printNotices();
  warns.forEach((w) => console.log(`WARN ${w}`));
  if (resuming) {
    // Mid-match nobody may help: report, never block. The agent notes these and keeps playing.
    problems.forEach((p) => console.log(`WARN (mid-match) ${p}`));
    console.log(problems.length
      ? `doctor: RESUMING with ${problems.length} warnings: write them into .mtm/notes.md and keep playing; never reply BLOCKED mid-match`
      : 'doctor: OK (RESUMING)');
    return EXIT_OK;
  }
  problems.forEach((p) => console.log(`PROBLEM ${p}`));
  console.log(problems.length ? `doctor: PROBLEMS FOUND (${problems.length})` : 'doctor: OK');
  return problems.length ? EXIT_REFUSED : EXIT_OK;
}

async function cmdRecon(ctx) {
  const map = buildRepoMap(ctx.cfg.repo);
  writeText(ctx.p('repo-map.md'), map);
  console.log(map);
  console.log('(saved to .mtm/repo-map.md; no need to open it again)');
  return EXIT_OK;
}

async function cmdReady(ctx) {
  // Setup is over: from now on the keep-alive hook keeps the agent playing until MATCH FINISHED.
  if (!ctx.match?.armedAt) ctx.saveMatch({ armedAt: new Date().toISOString() });
  if (!ctx.cfg.endpoints?.ready) {
    console.log('ready endpoint not configured: report ready the way the launch prompt or Game Player asks for it.');
    return EXIT_OK;
  }
  const r = await ctx.client.ready();
  console.log(r.ok ? `READY sent (${r.status})` : `READY failed: HTTP ${r.status} ${r.message}`);
  if (r.ok) { ctx.journal('ready reported'); ctx.saveMatch({ readyAt: new Date().toISOString() }); }
  return r.ok ? EXIT_OK : EXIT_REFUSED;
}

function finishedLine(m) {
  if (m.finished) console.log(`MATCH FINISHED (${m.status}): stop now.`);
  return m.finished ? EXIT_FINISHED : EXIT_OK;
}

/**
 * DEGRADED mode (page not understood): poll and watch compare a hash of the page text, so the
 * agent can still wait cheaply and see changes; a finished pattern on the page ends the match.
 */
function degradedLook(ctx, m) {
  const text = m.unparsed ? stripHtml(m.rawText) : JSON.stringify(m.raw ?? '');
  const h = hashText(text);
  const prev = readJson(ctx.p('degraded.json'), null);
  const re = new RegExp(ctx.cfg.states?.finishedPagePattern || '\\bmatch\\s+(is\\s+)?(finished|ended|over)\\b', 'i');
  return { changed: !prev || prev.h !== h, finished: re.test(text), save: () => writeJson(ctx.p('degraded.json'), { h, at: Date.now() }) };
}

function degradedReport(ctx, m, look, quietIfSame) {
  look.save();
  if (look.changed || !quietIfSame) printUnparsed(m);
  else console.log('no change (DEGRADED: match page not understood; use the ids shown on it)');
  if (look.finished) { console.log('MATCH FINISHED (seen on the page): stop now.'); return EXIT_FINISHED; }
  return EXIT_OK;
}

/** After the match end time, an unreachable Game Master means the match is over. */
function endedWhileUnreachable(ctx) {
  const snap = ctx.loadSnapshot();
  return !!(snap?.endsAt && Date.now() + (snap.offsetMs || 0) > snap.endsAt + 60000);
}

async function cmdStatus(ctx, { flags }) {
  const m = await ctx.client.getMatch();
  ctx.printNotices();
  if (flags.raw) {
    console.log(m.unparsed ? clip(m.rawText, 6000) : JSON.stringify(m.raw, null, 1).slice(0, 6000));
    return EXIT_OK;
  }
  if (m.unparsed || m.mapErrors.length) return degradedReport(ctx, m, degradedLook(ctx, m), false);
  const events = diffSnapshots(ctx.loadSnapshot(), toSnapshot(m));
  ctx.saveSnapshot(m);
  console.log(matchHeader(ctx, m));
  if (events.length) { printEvents(m, events); handleEvents(ctx, m, events); }
  ctx.printAlerts(m);
  printTable(ctx, m);
  nextLines(ctx, m).forEach((l) => console.log(l));
  return finishedLine(m);
}

async function cmdNext(ctx) {
  const m = await ctx.client.getMatch();
  if (m.unparsed || m.mapErrors.length) return degradedReport(ctx, m, degradedLook(ctx, m), false);
  ctx.printAlerts(m);
  nextLines(ctx, m).forEach((l) => console.log(l));
  return finishedLine(m);
}

async function cmdPoll(ctx) {
  const m = await ctx.client.getMatch();
  ctx.printNotices();
  if (m.unparsed || m.mapErrors.length) return degradedReport(ctx, m, degradedLook(ctx, m), true);
  const events = diffSnapshots(ctx.loadSnapshot(), toSnapshot(m));
  ctx.saveSnapshot(m);
  console.log(`${events.length ? '' : 'no change | '}${matchHeader(ctx, m)}`);
  if (events.length) { printEvents(m, events); handleEvents(ctx, m, events); }
  ctx.printAlerts(m);
  nextLines(ctx, m).forEach((l) => console.log(l));
  return finishedLine(m);
}

async function cmdWatch(ctx, { flags }) {
  const timeoutS = flags.timeout ?? 240;
  const intervalS = Math.max(2, flags.interval ?? 5);
  const until = Date.now() + timeoutS * 1000;
  ctx.printNotices();
  for (;;) {
    try {
      const m = await ctx.client.getMatch();
      if (m.unparsed || m.mapErrors.length) {
        const look = degradedLook(ctx, m);
        if (look.changed || look.finished || Date.now() >= until) return degradedReport(ctx, m, look, true);
        await sleep(intervalS * 1000);
        continue;
      }
      const events = diffSnapshots(ctx.loadSnapshot(), toSnapshot(m));
      if (events.some(isLoud) || m.finished || Date.now() >= until) {
        ctx.saveSnapshot(m);
        console.log(`${events.length ? '' : `no change in ${timeoutS}s | `}${matchHeader(ctx, m)}`);
        if (events.length) { printEvents(m, events); handleEvents(ctx, m, events); }
        ctx.printAlerts(m);
        if (!m.finished) nextLines(ctx, m).forEach((l) => console.log(l));
        return finishedLine(m);
      }
    } catch (e) {
      if (endedWhileUnreachable(ctx)) {
        console.log('MATCH FINISHED (the match end time has passed and Game Master does not answer): stop now.');
        return EXIT_FINISHED;
      }
      if (Date.now() >= until) {
        console.log(`watch: Game Master unreachable for ${timeoutS}s: ${e.message}. Keep working on the current item and retry.`);
        return EXIT_REFUSED;
      }
    }
    await sleep(intervalS * 1000);
  }
}

async function cmdShow(ctx, { pos }) {
  const id = pos[1];
  if (!id) { console.log('usage: mtm show <ID>'); return EXIT_REFUSED; }
  if (!fs.existsSync(ctx.itemDir(id))) { console.log(`${id}: no local files. Run mtm start ${id}`); return EXIT_REFUSED; }
  printItemFiles(ctx, id);
  console.log('Time left: mtm status (LEFT column).');
  return EXIT_OK;
}

/** Stash entries holding paused work of an item ("WIP <ID>" or "PARKED <ID>"), as pop commands. */
function stashesOf(ctx, id) {
  const list = git(ctx.cfg.repo, ['stash', 'list'], { allowFail: true }) || '';
  return list.split(/\r?\n/).filter((l) => new RegExp(`(WIP|PARKED) ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(l))
    .map((l) => l.match(/^(stash@\{\d+\})/)?.[1]).filter(Boolean);
}

async function cmdStart(ctx, { pos, flags }) {
  const id = pos[1];
  if (!id) { console.log('usage: mtm start <ID> [--refetch]'); return EXIT_REFUSED; }
  const refuse = (msg) => { console.log(`START REFUSED ${id}: ${msg}`); return EXIT_REFUSED; };
  const local = ctx.ledger()[id] || {};
  if (local.submittedAt) return refuse('already submitted in this match. Take NEXT.');
  ctx.printNotices();

  // Already started in this match: never send Start working twice (a strict server may refuse it).
  if (local.startedAt && fs.existsSync(path.join(ctx.itemDir(id), 'brief.md')) && !flags.refetch) {
    const wasParked = !!local.parkedAt;
    const live = await ctx.peekMatch();
    ctx.updateLedger(id, { parkedAt: null, parkReason: null, ...(wasParked ? { activeMs: 0, activeServerMs: 0 } : {}) });
    ctx.setCurrent(id, live?.serverNow ?? null);
    ctx.journal(`resume ${id}${wasParked ? ' (from park)' : ''}`);
    console.log(`RESUMED ${id}: Start working was sent ${((Date.now() - local.startedAt) / 60000).toFixed(1)}m ago; not sent again. Saved material:\n`);
    const mvsFile = path.join(ctx.itemDir(id), 'mvs.md');
    ensureContract(ctx, id, local.type || typeOfId(id), null, fs.existsSync(mvsFile) ? fs.readFileSync(mvsFile, 'utf8') : null);
    printItemFiles(ctx, id);
    const st = stashesOf(ctx, id);
    if (st.length) console.log(`Its paused work is in ${st.join(', ')}: run git stash pop '${st[0]}' now.`);
    console.log(`Playbook: skill mtm-${(local.type || typeOfId(id)).toLowerCase()}${wasParked ? ' (back from park: a fresh time budget starts now)' : ''}`);
    ctx.printAlerts(live);
    return EXIT_OK;
  }

  const m = await ctx.client.getMatch();
  if (m.paused) return refuse('match is PAUSED: keep working locally; start when mtm watch shows RUNNING.');
  const degraded = m.unparsed || m.mapErrors.length > 0;
  const item = degraded ? null : m.items.find((i) => i.id === id);
  if (degraded) {
    if (!pageMentions(m, id)) return refuse('not on the match page. Do not guess unrevealed items.');
    console.log('DEGRADED: match page not understood; starting by id, the server does the checks.');
  } else if (!item) return refuse('not visible on the match page. Do not guess unrevealed items.');
  const o = plannerOptions(ctx.plannerOpts(m));
  if (item?.state && o.terminalStates.includes(item.state)) return refuse(`it is ${item.state}. Take NEXT.`);

  const r = await ctx.client.start(id);
  if (!r.ok && !r.alreadyStarted) {
    const n = (local.startRefusals || 0) + 1;
    ctx.updateLedger(id, { startRefusedAt: Date.now(), startRefusals: n });
    ctx.journal(`start ${id} refused (${n}): ${r.status} ${clip(r.message, 120)}`);
    const hint = item?.state === 'VISIBLE'
      ? ' It is VISIBLE, not OPEN yet: take NEXT, and retry only when its state changes.'
      : n >= 2 ? ' Refused twice: NEXT now ranks it last. Take NEXT.' : ' Retry at most once; then take NEXT.';
    return refuse(`HTTP ${r.status} ${r.message}.${hint}`);
  }
  const d = ctx.itemDir(id);
  const type = item?.type || typeOfId(id);
  const shown = item || { id, type, title: '', description: '(match page not understood: read the page text above and the Start working reply)', maxPoints: null, raw: null };
  const replyJson = r.raw.json && typeof r.raw.json === 'object' ? r.raw.json : null;
  // An "already started" reply without material must not replace the first reply (evidence format, MVS...).
  const keepFirst = r.alreadyStarted && !r.template && !r.mvs && fs.existsSync(path.join(d, 'start-response.json'));
  const startJson = keepFirst ? readJson(path.join(d, 'start-response.json'), null) : replyJson;
  writeText(path.join(d, 'brief.md'), renderBrief(shown, startJson));
  const mvs = renderMvs(r.mvs);
  if (mvs) writeText(path.join(d, 'mvs.md'), `## MVS (all must pass; Grader also checks other scenarios)\n${mvs}`);
  if (r.template && typeof r.template === 'object') {
    writeJson(path.join(d, 'template.json'), r.template);
    if (!fs.existsSync(path.join(d, 'submission.json'))) writeJson(path.join(d, 'submission.json'), r.template);
  } else if (r.template) {
    writeText(path.join(d, 'template.txt'), String(r.template));
  }
  if (!keepFirst) writeJson(path.join(d, 'start-response.json'), replyJson ?? { text: r.raw.text });
  const savedMvs = fs.existsSync(path.join(d, 'mvs.md')) ? fs.readFileSync(path.join(d, 'mvs.md'), 'utf8') : null;
  ensureContract(ctx, id, type, item?.maxPoints, r.mvs ?? savedMvs);
  const resumed = !!local.startedAt || r.alreadyStarted;
  const baseRev = local.baseRev ?? (ctx.cfg.isRepo ? git(ctx.cfg.repo, ['rev-parse', 'HEAD'], { allowFail: true }) : null);
  ctx.updateLedger(id, {
    startedAt: local.startedAt ?? Date.now(),
    // Keep server-clock timing separate from local wall time. This matters for rehearsals that
    // accelerate the match clock and for real hosts whose clock is authoritative.
    startedServerAt: local.startedServerAt ?? m.serverNow,
    type, baseRev, parkedAt: null, parkReason: null,
  });
  ctx.setCurrent(id, m.serverNow);
  ctx.journal(`${resumed ? 'resume' : 'start'} ${id} (${type}, ${item?.maxPoints ?? '?'} pts)`);
  console.log(`${resumed ? 'STARTED (again)' : 'STARTED'} ${id}\n`);
  printItemFiles(ctx, id);
  const hasTemplate = fs.existsSync(path.join(d, 'template.json')) || fs.existsSync(path.join(d, 'template.txt'));
  if (!hasTemplate) console.log(`WARN no submit template received: check ${rel(ctx, path.join(d, 'start-response.json'))}`);
  if (['CR', 'BUG'].includes(type) && !fs.existsSync(path.join(d, 'mvs.md'))) console.log('WARN a CR/BUG without MVS in the Start working reply: check start-response.json');
  console.log(type === 'PI'
    ? `Task Contract: fill outcome and repro in ${rel(ctx, path.join(d, 'contract.md'))} now; finish the rest before review.`
    : `Task Contract: fill every <...> in ${rel(ctx, path.join(d, 'contract.md'))} before coding (2 minutes).`);
  console.log(`Playbook: skill mtm-${type.toLowerCase()}`);
  ctx.printAlerts(m);
  return EXIT_OK;
}

async function cmdEvidence(ctx, { pos, rest, flags }) {
  const id = pos[1];
  if (!id || !rest.length) { console.log('usage: mtm evidence <ID> [--cwd <module>] -- <command> [args...]'); return EXIT_REFUSED; }
  const repo = ctx.cfg.repo;
  const cwd = typeof flags.cwd === 'string' ? path.resolve(repo, flags.cwd) : repo;
  if (!fs.existsSync(cwd) || path.relative(repo, cwd).startsWith('..')) { console.log(`evidence: --cwd ${flags.cwd} is not a folder inside the repo`); return EXIT_REFUSED; }
  const d = ctx.itemDir(id);
  fs.mkdirSync(d, { recursive: true });
  const n = fs.readdirSync(d).filter((f) => f.startsWith('evidence-')).length + 1;
  const file = path.join(d, `evidence-${n}.log`);
  const timeoutMin = flags['timeout-min'] ?? ctx.cfg.evidence?.timeoutMinutes ?? 6;
  const sha = git(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true });
  const tree = workingTreeHash(repo);
  const dirty = dirtyFiles(repo).length > 0;
  const r = await runCommand(rest, { cwd, timeoutMs: timeoutMin * 60000 });
  const secs = (r.ms / 1000).toFixed(1);
  writeText(file, `$ ${cwd === repo ? '' : `(in ${rel(ctx, cwd)}) `}${r.line}\n# at ${new Date().toISOString()} HEAD ${sha} tree ${tree ?? '?'}${dirty ? ' (uncommitted changes included)' : ''} exit=${r.code}${r.timedOut ? ' TIMEOUT' : ''} (${secs}s)\n\n${r.output}`);
  const led = ctx.ledger()[id] || {};
  ctx.updateLedger(id, {
    evidence: [...(led.evidence || []), { cmd: r.line, exit: r.code, timedOut: r.timedOut, file: rel(ctx, file), sha, tree, dirty, at: Date.now(), secs: Number(secs) }],
  });
  console.log(`exit=${r.code}${r.timedOut ? ' TIMEOUT' : ''} (${secs}s) log: ${rel(ctx, file)}`);
  console.log(tailLines(r.output, flags.tail ?? 25));
  if (r.timedOut) console.log(`HINT the command ran ${timeoutMin} min: a test runner in watch mode, or a test waiting on a service? Use a one-shot form (see .mtm/repo-map.md) or a narrower command.`);
  ctx.printAlerts(await ctx.peekMatch());
  return r.code === 0 ? EXIT_OK : EXIT_REFUSED;
}

async function cmdFill(ctx, { pos }) {
  const id = pos[1];
  const pairs = pos.slice(2);
  if (!id || !pairs.length) { console.log('usage: mtm fill <ID> field=value [field.sub=value ...]'); return EXIT_REFUSED; }
  const d = ctx.itemDir(id);
  const file = path.join(d, 'submission.json');
  const tplFile = path.join(d, 'template.json');
  let payload;
  try {
    payload = fs.existsSync(file) ? readJson(file) : (fs.existsSync(tplFile) ? readJson(tplFile) : {});
  } catch {
    console.log('submission.json was not valid JSON: rebuilt it from the template');
    payload = fs.existsSync(tplFile) ? readJson(tplFile) : {};
  }
  for (const p of pairs) {
    // field=text | field=@file (UTF-8 text from a file, for quotes and backticks) | field:=JSON (lists, numbers)
    const typed = p.match(/^([^=:]+):=([\s\S]*)$/);
    const eq = p.indexOf('=');
    if (typed) {
      try { setPath(payload, typed[1], JSON.parse(typed[2])); } catch (e) { console.log(`not valid JSON for ${typed[1]}: ${e.message}`); return EXIT_REFUSED; }
      continue;
    }
    if (eq <= 0) { console.log(`not field=value: ${p}`); return EXIT_REFUSED; }
    const key = p.slice(0, eq);
    let val = p.slice(eq + 1);
    if (val.startsWith('@') && val.length > 1) {
      const src = path.resolve(ctx.cfg.repo, val.slice(1));
      if (!fs.existsSync(src)) { console.log(`no such file for ${key}: ${val.slice(1)}`); return EXIT_REFUSED; }
      val = decodeText(fs.readFileSync(src)).trim();
    }
    setPath(payload, key, val);
  }
  writeJson(file, payload);
  const template = fs.existsSync(tplFile) ? readJson(tplFile) : undefined;
  const holes = findPlaceholders(payload, [ctx.cfg.submit?.revisionField || 'gitRevision'], template);
  console.log(`saved ${rel(ctx, file)}${holes.length ? `; still empty: ${holes.join(', ')}` : '; all fields filled'}`);
  return EXIT_OK;
}

async function cmdSubmit(ctx, { pos, flags }) {
  const id = pos[1];
  if (!id) { console.log('usage: mtm submit <ID>'); return EXIT_REFUSED; }
  const refuse = (msg) => { console.log(`SUBMIT REFUSED ${id}: ${msg}`); return EXIT_REFUSED; };
  const local = ctx.ledger()[id] || {};
  if (!local.startedAt) return refuse(`not started. Run: mtm start ${id} (started through the organizers' tool? mtm mark ${id} --started)`);
  if (local.submittedAt) return refuse('already submitted; one submission per item. Take NEXT.');

  const m = await ctx.client.getMatch();
  ctx.printNotices();
  if (m.paused) return refuse('match is PAUSED: keep the work committed and pushed; submit when mtm watch shows RUNNING.');
  const degraded = m.unparsed || m.mapErrors.length > 0;
  const item = degraded ? null : m.items.find((i) => i.id === id);
  const o = plannerOptions(ctx.plannerOpts(m));
  if (degraded) console.log('DEGRADED: match page not understood; the server does the item checks.');
  else if (!item) return refuse('no longer on the match page (withdrawn?). Take NEXT.');
  if (item) {
    if (isDone(item, {}, o)) {
      ctx.updateLedger(id, { submittedAt: Date.now(), serverStatus: item.submissionStatus || item.result });
      return refuse(`the server already has a submission (${item.submissionStatus || item.result}). Take NEXT.`);
    }
    if (item.state && o.terminalStates.includes(item.state)) return refuse(`it is ${item.state}.`);
    const left = minutesLeft(item, m.serverNow);
    if (left != null && left <= 0) {
      if (!item.deadlineEstimated) return refuse('deadline passed on the server clock.');
      console.log('WARN the estimated deadline has passed, but pauses extend it and the item is not CLOSED: submitting.');
    }
  }

  const repo = ctx.cfg.repo;
  const rev = resolveRev(repo, typeof flags.rev === 'string' ? flags.rev : 'HEAD');
  const dirty = dirtyFiles(repo);
  if (dirty.length) {
    return refuse(`uncommitted changes would NOT be graded:\n  ${dirty.slice(0, 10).join('\n  ')}\nCommit and push this item's files; stash anything else (git stash push -u -m "WIP <ID>").`);
  }
  const remote = ctx.cfg.submit?.remote || 'origin';
  const branch = ctx.cfg.submit?.gradedBranch || ctx.match?.branch || upstreamOf(repo)?.branch || null;
  if (!isPushed(repo, rev, { branch, remote })) {
    return refuse(branch
      ? `commit ${rev.slice(0, 10)} is not on ${remote}/${branch} (the graded branch). Run: git push ${remote} HEAD:${branch}`
      : `commit ${rev.slice(0, 10)} is not on the remote. Run: git push`);
  }

  // Commits of other started-but-unsubmitted items would be graded inside this item's SHA.
  const led = ctx.ledger();
  const lastRev = Object.values(led).filter((e) => e.submittedAt && e.rev).sort((a, b) => b.submittedAt - a.submittedAt)[0]?.rev;
  if (lastRev) {
    const others = Object.entries(led).filter(([k, v]) => k !== id && v.startedAt && !v.submittedAt).map(([k]) => k);
    const subjects = (git(repo, ['log', '--format=%s', `${lastRev}..${rev}`], { allowFail: true }) || '').split(/\r?\n/).filter(Boolean);
    const leaks = subjects.filter((s) => others.some((o) => new RegExp(`(^|[^A-Za-z0-9-])${o}([^0-9]|$)`).test(s)));
    if (leaks.length) console.log(`WARN commits of unsubmitted items are inside this submit: ${leaks.slice(0, 3).join(' | ')}. Their code is graded with ${id}.`);
  }

  const file = typeof flags.file === 'string' ? path.resolve(flags.file) : path.join(ctx.itemDir(id), 'submission.json');
  if (!fs.existsSync(file)) return refuse(`no submission file at ${rel(ctx, file)}: the Start working reply had no JSON template. Build it from template.txt with mtm fill.`);
  let payload;
  try { payload = readJson(file); } catch { return refuse(`submission.json is not valid JSON: rebuild it with MTM fill ${id} 'field=text' ... (it starts again from the template)`); }
  const sub = ctx.cfg.submit || {};
  const revField = sub.revisionField || 'gitRevision';
  setPath(payload, revField, rev);
  if (sub.itemIdField) setPath(payload, sub.itemIdField, id);

  const type = item?.type || local.type || typeOfId(id);
  const needEvidence = (sub.evidenceRequiredFor || ['CR', 'BUG']).includes(type);
  let evidenceNote = '';
  if (needEvidence) {
    const passing = (local.evidence || []).filter((e) => e.exit === 0 && !e.timedOut);
    if (!passing.length) return refuse(`${type} needs evidence: mtm evidence ${id} -- <test command> must exit 0.`);
    const revTree = treeOf(repo, rev);
    const match = passing.filter((e) => e.tree && revTree && e.tree === revTree);
    // A run whose content could not be fingerprinted proves nothing: it does not count.
    if (!match.length) {
      return refuse(passing.some((e) => e.tree) && revTree
        ? 'the commit differs from the code your last passing evidence run tested (a later edit, or a commit hook that reformatted files). Run MTM evidence again on the committed code, then submit.'
        : 'the passing evidence run could not be tied to this commit. Run MTM evidence again on the committed code, then submit.');
    }
    const best = match.slice(-1)[0];
    evidenceNote = ` | evidence ${best.file} (${best.cmd.slice(0, 60)})`;
  }
  const tplFile = path.join(ctx.itemDir(id), 'template.json');
  const template = fs.existsSync(tplFile) ? readJson(tplFile) : undefined;
  const holes = findPlaceholders(payload, [revField], template);
  if (holes.length) return refuse(`fill these fields: ${holes.join(', ')} (mtm fill ${id} '${holes[0]}=...'; lists: '${holes[0]}:=[...]')`);
  if (flags['dry-run']) {
    console.log(`DRY RUN ${id} rev ${rev}${evidenceNote}\n${JSON.stringify(payload, null, 2)}`);
    return EXIT_OK;
  }

  const r = await ctx.client.submit(id, payload);
  if (r.accepted || r.duplicate) {
    ctx.updateLedger(id, {
      submittedAt: Date.now(),
      submittedServerAt: m.serverNow,
      rev,
      serverStatus: r.duplicate ? 'DUPLICATE' : r.serverStatus,
      submitUncertainAt: null,
    });
    // After a PI (or any item that interrupted another), the interrupted item becomes current again.
    const back = ctx.match?.current === id ? ctx.match?.previous : null;
    const ledNow = ctx.ledger();
    const resumeBack = back && back !== id && !ledNow[back]?.submittedAt && !ledNow[back]?.parkedAt;
    if (ctx.match?.current === id) {
      ctx.setCurrent(resumeBack ? back : null, m.serverNow);
      ctx.saveMatch({ previous: null });
    }
    ctx.journal(`submit ${id} rev ${rev.slice(0, 10)} -> ${r.duplicate ? 'already had a submission' : (r.serverStatus ?? r.status)}`);
    console.log(r.duplicate
      ? `SUBMITTED ${id}: the server already had this item's submission (${r.message}). Treating as submitted.`
      : `SUBMITTED ${id} rev ${rev.slice(0, 10)}: ${r.serverStatus ?? `HTTP ${r.status}`} ${r.message ?? ''}${evidenceNote}`.trim());
    console.log('Final for this item. The score is provisional until Grader runs; results appear in MTM status.');
    if (resumeBack) {
      const st = stashesOf(ctx, back);
      console.log(`CURRENT is ${back} again (it was interrupted).${st.length ? ` Pop its paused work: git stash pop '${st[0]}'.` : ''} Then check NEXT with MTM status.`);
    } else console.log('Take NEXT now.');
    ctx.printAlerts(await ctx.peekMatch());
    return EXIT_OK;
  }
  if (r.unknown) {
    ctx.updateLedger(id, { submitUncertainAt: Date.now(), rev });
    ctx.journal(`submit ${id} uncertain: HTTP ${r.status} without JSON`);
    console.log(`SUBMIT UNCERTAIN ${id}: HTTP ${r.status} without a JSON answer. Do not change this item. Run mtm status: if it shows a submission for ${id}, it counted; if not, run mtm submit ${id} once more.`);
    return EXIT_REFUSED;
  }
  ctx.updateLedger(id, { submitRejections: (local.submitRejections || 0) + 1 });
  ctx.journal(`submit ${id} rejected: ${r.status} ${clip(r.message, 160)}`);
  const tries = (local.submitRejections || 0) + 1;
  return refuse(`server rejected (HTTP ${r.status}${r.serverStatus ? ` ${r.serverStatus}` : ''}): ${r.message}. Nothing was recorded: fix the cause and submit again${tries >= 2 ? '; after a third refusal, park the item' : ''}.`);
}

async function cmdPark(ctx, { pos, flags }) {
  const id = pos[1];
  if (!id) { console.log('usage: mtm park <ID> [--reason TEXT]'); return EXIT_REFUSED; }
  ctx.updateLedger(id, { parkedAt: Date.now(), parkReason: flags.reason || null });
  if (ctx.match?.current === id) ctx.setCurrent(null);
  ctx.journal(`park ${id}${flags.reason ? `: ${flags.reason}` : ''}`);
  const dirty = ctx.cfg.isRepo ? dirtyFiles(ctx.cfg.repo).length : 0;
  console.log(`PARKED ${id}: NEXT ranks it last. ${dirty ? `Stash its ${dirty} changed files first: git stash push -u -m "PARKED ${id}"` : 'Working tree is clean.'} Take NEXT.`);
  return EXIT_OK;
}

async function cmdMark(ctx, { pos, flags }) {
  const id = pos[1];
  if (!id || (!flags.started && !flags.submitted)) { console.log('usage: mtm mark <ID> --started|--submitted [--rev SHA]'); return EXIT_REFUSED; }
  const patch = {};
  if (flags.started) {
    patch.startedAt = ctx.ledger()[id]?.startedAt ?? Date.now();
    patch.type = typeOfId(id);
    patch.baseRev = ctx.ledger()[id]?.baseRev ?? (ctx.cfg.isRepo ? git(ctx.cfg.repo, ['rev-parse', 'HEAD'], { allowFail: true }) : null);
    ensureContract(ctx, id, patch.type, null, null);
  }
  if (flags.submitted) { patch.submittedAt = Date.now(); patch.rev = typeof flags.rev === 'string' ? flags.rev : null; patch.serverStatus = 'MARKED'; }
  ctx.updateLedger(id, patch);
  if (flags.started) ctx.setCurrent(id);
  ctx.journal(`mark ${id}${flags.started ? ' started' : ''}${flags.submitted ? ' submitted' : ''} (done through another tool)`);
  console.log(`MARKED ${id}${flags.started ? ' started' : ''}${flags.submitted ? ' submitted' : ''}`);
  return EXIT_OK;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function cmdReport(ctx) {
  const led = ctx.ledger();
  const snap = ctx.loadSnapshot() || { items: [] };
  const byId = new Map(snap.items.map((i) => [i.id, i]));
  const ids = [...new Set([...Object.keys(led), ...byId.keys()])].filter((id) => id !== 'BASELINE').sort();
  const per = {};
  console.log('ID       TYPE  PTS   START->SUBMIT  RESULT');
  for (const id of ids) {
    const l = led[id] || {};
    const s = byId.get(id) || {};
    const type = s.type || l.type || typeOfId(id);
    const work = l.startedAt && l.submittedAt ? (l.submittedAt - l.startedAt) / 60000 : null;
    if (work != null) (per[type] = per[type] || []).push(work);
    console.log(`${id.padEnd(8)} ${String(type).padEnd(5)} ${String(s.maxPoints ?? '-').padEnd(5)} ${(work == null ? (l.parkedAt ? 'parked' : l.startedAt ? 'open' : '-') : `${work.toFixed(1)}m`).padEnd(14)} ${s.result || (l.submittedAt ? 'submitted' : '-')}${s.score != null ? ` ${s.score}` : ''}`);
  }
  const cur = plannerOptions(ctx.cfg.planner).estMinutes;
  const lines = Object.entries(per).map(([t, xs]) => `${t}: median ${median(xs).toFixed(1)}m over ${xs.length} (estMinutes now ${cur[t] ?? '-'})`);
  console.log(lines.length ? `per type: ${lines.join(' | ')}` : 'per type: no submitted items yet');
  return EXIT_OK;
}

async function cmdCoach(ctx) {
  const report = buildCoachReport({
    match: ctx.match,
    ledger: ctx.ledger(),
    snapshot: ctx.loadSnapshot() || {},
    hookProbe: readJson(ctx.p('hook-probe.json'), null),
    estimates: plannerOptions(ctx.cfg.planner).estMinutes,
  });
  writeJson(ctx.p('coach.json'), report);
  writeText(ctx.p('coach.html'), renderCoachHtml(report));
  console.log(`COACH ${report.status} | ${report.summary.submitted}/${report.summary.visible} submitted | ${report.earnedPoints}/${report.visiblePoints || '?'} pts`);
  for (const gate of report.gates.filter((gate) => !gate.pass)) console.log(`GAP ${gate.label}: ${gate.detail}`);
  console.log(`dashboard: ${rel(ctx, ctx.p('coach.html'))}`);
  return EXIT_OK;
}

/** Files this item changed: its commits since its start (or commits naming no other item) plus uncommitted work. */
function itemChanges(repo, id, base) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mineRe = new RegExp(`(^|[^A-Za-z0-9-])${esc}([^0-9]|$)`, 'i');
  const otherRe = /(^|[^A-Za-z0-9-])(PI|BUG|CR|TASK)-\d+/i;
  const log = (base && git(repo, ['log', '--format=%x00%s', '--name-only', `${base}..HEAD`], { allowFail: true })) || '';
  const files = new Set();
  for (const chunk of log.split('\0').filter((c) => c.trim())) {
    const [subject, ...names] = chunk.split(/\r?\n/);
    if (mineRe.test(subject) || !otherRe.test(subject)) names.filter(Boolean).forEach((n) => files.add(n.trim()));
  }
  const untracked = [];
  for (const line of dirtyFiles(repo)) {
    const p = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    files.add(p);
    if (line.startsWith('??')) untracked.push(p);
  }
  return { files: [...files].filter(Boolean).sort(), untracked };
}

async function cmdReview(ctx, { pos }) {
  const id = pos[1];
  if (!id) { console.log('usage: mtm review <ID>'); return EXIT_REFUSED; }
  const local = ctx.ledger()[id] || {};
  if (!local.startedAt) { console.log(`REVIEW ${id}: not started. Run: mtm start ${id}`); return EXIT_REFUSED; }
  const repo = ctx.cfg.repo;
  const d = ctx.itemDir(id);
  const type = local.type || typeOfId(id);
  const contractFile = ensureContract(ctx, id, type, null, null);
  const contractText = fs.readFileSync(contractFile, 'utf8');
  const c = parseContract(contractText, type);
  const base = local.baseRev || git(repo, ['rev-parse', 'HEAD'], { allowFail: true });
  const { files, untracked } = itemChanges(repo, id, base);
  const tests = files.filter(isTestFile);
  const scope = scopeCheck(files, c.fields['scope.allowed']);
  const diffArgs = ['diff', base, '--', ...files.filter((f) => !untracked.includes(f)).slice(0, 200)];
  const diff = files.length > untracked.length ? (git(repo, diffArgs, { allowFail: true }) || '') : '';
  const diffLines = diff.split(/\r?\n/);
  const read = (f) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), 'utf8').trim() : '(none)');
  const pack = [
    `# Review pack ${id} (${type}), built ${new Date().toISOString()}`,
    REVIEW_INSTRUCTIONS,
    '',
    '## Task Contract', contractText.trim(),
    '', '## MVS', read('mvs.md'),
    '', '## Brief', clip(read('brief.md'), 4000),
    '', `## Changed files since ${String(base).slice(0, 10)}`,
    ...files.map((f) => `- ${f}${isTestFile(f) ? ' [test]' : ''}${scope.outOfScope.includes(f) ? ' [OUT OF scope.allowed]' : ''}${untracked.includes(f) ? ' [new file, not in the diff: open it]' : ''}`),
    '', '## Diff', '```diff', ...diffLines.slice(0, 600), diffLines.length > 600 ? `... ${diffLines.length - 600} more lines: run git diff ${String(base).slice(0, 10)}` : '', '```', '',
  ].join('\n');
  const packFile = path.join(d, 'review-pack.md');
  writeText(packFile, pack);
  ctx.updateLedger(id, { reviews: [...(local.reviews || []), { at: Date.now(), files: files.length, tests: tests.length, outOfScope: scope.outOfScope }], contractOpen: c.open });
  ctx.journal(`review ${id}: ${files.length} files, ${tests.length} tests, out of scope ${scope.outOfScope.length}, contract open ${c.open.join(' ') || 'none'}`);

  console.log(`REVIEW PACK ${id}: ${rel(ctx, packFile)} | ${files.length} changed files (${tests.length} tests) since ${String(base).slice(0, 10)}`);
  if (c.open.length) console.log(`!! CONTRACT OPEN ${id}: fill ${c.open.join(', ')} in ${rel(ctx, contractFile)}; without acceptance lines nobody can tell what "done" means.`);
  else if (c.openAcceptance) console.log(`note: ${c.openAcceptance} acceptance lines still hold a <placeholder>: replace or delete them.`);
  if (scope.outOfScope.length) console.log(`!! OUT OF SCOPE ${id}: ${scope.outOfScope.slice(0, 8).join(', ')}. Revert these, or add each to scope.allowed with a reason (a hidden scenario may cover them).`);
  else if (!scope.checked && type !== 'PI') console.log('note: scope.allowed is empty, so the scope check did not run.');
  if (!tests.length && type !== 'TASK') console.log(`!! NO TEST CHANGED ${id}: write ${type === 'PI' ? 'the repro test' : 'one test per MVS and per hidden scenario in the contract'} before you commit.`);
  if (!files.length) console.log(`note: no change found for ${id} since its start.`);
  console.log(type === 'CR' || type === 'BUG'
    ? `Next: with more than 8 min LEFT and sub-agents available, spawn ONE read-only reviewer with this prompt: "You are the MTM reviewer. Read ${packFile.replace(/\\/g, '/')} and follow its instructions. Never edit files." Otherwise answer the pack's 5 checks yourself in at most 8 lines. Fix every GAP (test first), then commit.`
    : 'Next: answer the pack\'s 5 checks yourself in at most 8 lines (no sub-agent: speed matters here). Fix every GAP, then commit.');
  return EXIT_OK;
}

async function cmdRetro(ctx) {
  const snap = ctx.loadSnapshot() || { items: [] };
  const text = buildRetro({
    matchId: ctx.cfg.matchId,
    ledger: ctx.ledger(),
    items: snap.items || [],
    estMinutes: plannerOptions(ctx.cfg.planner).estMinutes,
    score: snap.score ?? null,
    typeOf: typeOfId,
  });
  writeText(ctx.p('retro.md'), text);
  console.log(text);
  console.log(`(saved to ${rel(ctx, ctx.p('retro.md'))})`);
  return EXIT_OK;
}

const COMMANDS = {
  init: cmdInit, doctor: cmdDoctor, recon: cmdRecon, ready: cmdReady, status: cmdStatus, next: cmdNext,
  poll: cmdPoll, watch: cmdWatch, show: cmdShow, start: cmdStart, evidence: cmdEvidence, fill: cmdFill,
  submit: cmdSubmit, park: cmdPark, mark: cmdMark, report: cmdReport, coach: cmdCoach, review: cmdReview, retro: cmdRetro,
};

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(`mtm: ${e.message}`);
    return EXIT_REFUSED;
  }
  const name = args.pos[0];
  const fn = COMMANDS[name];
  if (!fn || args.flags.help) { console.log(HELP); return name && !fn ? EXIT_REFUSED : EXIT_OK; }
  try {
    const ctx = new Ctx();
    const code = await fn(ctx, args);
    // The keep-alive hook lets the agent stop only after this file exists for the current match.
    if (code === EXIT_FINISHED && ctx.cfg.matchId) writeJson(ctx.p('finished.json'), { matchId: ctx.cfg.matchId, at: new Date().toISOString() });
    return code;
  } catch (e) {
    console.log(`mtm ${name}: ${e instanceof GmError ? '' : 'error: '}${e.message}`);
    return EXIT_REFUSED;
  }
}

main().then((code) => { process.exitCode = code; });
