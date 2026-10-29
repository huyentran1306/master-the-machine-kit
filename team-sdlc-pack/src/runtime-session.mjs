// The MCP Helper's session: lifecycle input, credentials (memory only), Game API, progress log,
// planner, answer/evidence contract and recovery state. Tool handlers live here; bin/runtime-server.mjs
// only speaks JSON-RPC.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ProgressLog, scrubSummary, playerRuleErrors } from './progress.mjs';
import { parseLifecycleText, validateDescriptor, publicDescriptor } from './lifecycle.mjs';
import { CookieJar, request } from './http.mjs';
import { login, parseMatchPage, looksLikeLogin, textBlockFor, loadMatchData } from './portal.mjs';
import { startWork, submit, operationUrl } from './game-api.mjs';
import * as G from './git.mjs';
import { materializeAnswer, answerPaths, countScenarios, checkAnswer } from './answers.mjs';
import { rank, alerts as plannerAlerts, diffItems, isSubmitted, isClosed, effectiveLeft } from './planner.mjs';
import { recon } from './recon.mjs';
import { ensureRepoMap } from './repo-map.mjs';
import { guardBaseline } from './baseline-guard.mjs';
import { validate, validateFinalResult } from './schema.mjs';
import { McpHttpClient, resultText } from './mcp-http.mjs';
import { buildChecklist, looksLikeTestOutput } from './checklist.mjs';
import { writeItemBrief } from './item-brief.mjs';
import { until, SUBMIT_LIMITS } from './deadline.mjs';
import {
  oneLine, safeId, uuid, sleep, readJson, writeJson, loggableOrigin, loggablePath, originOf, redact, truncate, minutes, SHA_RE, ITEM_KEY_RE, sha256, isInside, nowIso, repoKey,
} from './util.mjs';

const PREP_STAGES = ['GIT_AUTH', 'REPOSITORY', 'ENVIRONMENT', 'BUILD', 'MATCH_LOGIN'];
const HELPER_ONLY_TYPES = new Set(['ORCHESTRATOR_STARTED', 'ORCHESTRATOR_RESTARTED', 'ENVIRONMENT_READY', 'GAME_MASTER_API', 'ORCHESTRATOR_ENDED']);
const PLAYBOOK = { PI: 'backlog-pi', BUG: 'backlog-bug', CR: 'backlog-cr', TASK: 'backlog-task' };

export const DEFAULT_ADAPTER = {
  login: { strategy: 'auto', strategies: ['nextauth', 'form', 'json'] },
  matchView: { pagePathTemplate: '{matchPageUrl}/{matchId}', extraJsonPaths: ['/api/v1/match/{matchId}'], assignmentCheck: 'block', repoHostAliases: {}, mcpUrl: null },
  // maxWaitMs is a ceiling, not a sleep: wait_for_update returns the moment the page changes,
  // so a longer ceiling costs no reaction time and removes agent turns. Each idle turn re-reads
  // the whole conversation, which is where this match's tokens actually go.
  polling: { successMs: 5000, errorMs: 10000, backgroundMs: 20000, maxWaitMs: 170000 },
  submit: { acceptedStatuses: ['ACCEPTED', 'RECEIVED'], retryBudgetMs: SUBMIT_LIMITS.retryMs },
  planner: {},
  parallel: { maxWorkers: 2 },
};

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  return out;
}

export class RuntimeSession {
  /** Failing test rounds on one item before the helper tells the agent to change approach. */
  static STUCK_AFTER = 3;

  constructor({ teamWorkspace, packRoot, adapter, identity } = {}) {
    this.teamWorkspace = teamWorkspace || null;
    this.packRoot = packRoot;
    this.adapter = deepMerge(DEFAULT_ADAPTER, adapter || {});
    this.identity = identity || null; // team-pack-info.json
    this.phase = 'IDLE';
    this.jar = new CookieJar();
    this.account = null;
    this.bearer = null;
    this.items = new Map();
    this.snapshot = null;
    this.match = { status: null, endsAt: null, serverOffsetMs: 0, lastRefreshAt: null, pageTextHash: null, uuid: null };
    this.prep = {};
    this.blockers = new Map();
    this.pendingEvents = [];
    this.logProblems = [];
    this.state = { submissions: {}, items: {}, loginPreferred: null, envReady: null, current: null };
    this.lock = Promise.resolve();
    this.submissionsInFlight = new Set();
    this.poller = null;
    this.lastPollError = null;
  }

  // ---------- infrastructure ----------
  now() {
    return Date.now() + (this.match.serverOffsetMs || 0);
  }

  secrets() {
    const pw = this.account?.password;
    return [pw && pw.length >= 6 && !['true', 'false', 'null'].includes(pw) ? pw : null, this.bearer, ...this.jar.secrets().filter((v) => v.length >= 16)].filter(Boolean);
  }

  /** Redacts credentials from anything returned to the model. */
  clean(value) {
    // The match being over is the one thing the agent must not miss: mtm-player needs
    // ORCHESTRATOR_ENDED as the final event, and a round left open looks unfinished to the
    // organizer. A planner alert proved easy to scroll past, so this rides on EVERY tool result
    // until the end event is actually in the log.
    if (value && typeof value === 'object' && !Array.isArray(value)
        && this.phase === 'GAME' && this.match?.status === 'FINISHED' && !this.endedLogged) {
      value = { ...value, mustEnd: 'The match is FINISHED. Call final_result {"end":true} NOW: it writes ORCHESTRATOR_ENDED, the last event mtm-player waits for. Nothing else you do can score.' };
    }
    const text = JSON.stringify(value);
    const red = redact(text, this.secrets());
    if (red === text) return value;
    try {
      return JSON.parse(red);
    } catch {
      return { redactedText: red };
    }
  }

  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  get stateFile() {
    if (!this.checkoutRoot || !fs.existsSync(path.join(this.checkoutRoot, '.git'))) return null;
    return path.join(this.checkoutRoot, '.git', 'mtm-team', 'state.json');
  }

  get stateDir() {
    return this.stateFile ? path.dirname(this.stateFile) : null;
  }

  saveState() {
    const f = this.stateFile;
    if (!f) return;
    const items = {};
    for (const [id, it] of this.items) items[id] = { local: it.local, firstSeenAt: it.firstSeenAt ?? null, title: it.title ?? null, type: it.type };
    this.state.items = items;
    this.state.matchId = this.matchId;
    this.state.roundKey = this.roundKey;
    this.state.matchUuid = this.match.uuid;
    this.state.teamUuid = this.teamUuid || null;
    try {
      writeJson(f, this.state);
    } catch (e) {
      this.logProblems.push(`state not saved: ${e.message}`);
    }
  }

  loadState({ fresh }) {
    const f = this.stateFile;
    if (!f || !fs.existsSync(f)) return false;
    const st = readJson(f, null);
    if (!st || st.matchId !== this.matchId) return false;
    if (fresh) {
      // New round in an existing checkout: archive the previous round's helper state.
      try {
        fs.renameSync(f, f.replace(/\.json$/, `.${Date.now()}.prev.json`));
      } catch { /* ignore */ }
      return false;
    }
    this.state = { submissions: {}, items: {}, ...st };
    if (st.recon) {
      this.stackSkill = st.recon.stackSkill || null;
      this.appPath = st.recon.appPath || null;
      this.commands = st.recon.commands || {};
    }
    if (st.matchUuid) this.match.uuid = st.matchUuid;
    for (const [id, v] of Object.entries(st.items || {})) {
      const it = this.items.get(id) || { id, type: v.type || id.split('-')[0], title: v.title, local: {} };
      it.local = { ...(v.local || {}), ...(it.local || {}) };
      it.firstSeenAt = v.firstSeenAt;
      this.items.set(id, it);
    }
    return true;
  }

  /**
   * Append one event; schema problems are reported, never thrown into a tool flow.
   * `optional` marks telemetry the Player can live without: it is dropped near the 256 KiB wall.
   */
  event(ev, { optional = false } = {}) {
    if (!this.log) {
      this.logProblems.push(`no progress log yet for ${ev.type}`);
      return false;
    }
    const safe = typeof ev.summary === 'string' ? { ...ev, summary: oneLine(scrubSummary(ev.summary)) } : ev;
    try {
      const r = this.log.append(safe, { optional });
      if (r.queued) this.raiseLocalAlert('PROGRESS_LOG_UNAVAILABLE', `progress log append failed (${this.log.lastError}); events are queued and retried in order`);
      else this.clearLocalAlert('PROGRESS_LOG_UNAVAILABLE');
      if (this.log.pressure !== 'OK') {
        this.raiseLocalAlert('PROGRESS_LOG_PRESSURE', `progress log is ${Math.round(this.log.size / 1024)} KiB of the 256 KiB mtm-player reads; optional telemetry is being dropped (${this.log.dropped} so far). Keep summaries short.`);
      }
      return r.ok;
    } catch (e) {
      this.logProblems.push(e.message);
      return false;
    }
  }

  raiseLocalAlert(id, text) {
    this.localAlerts ||= new Map();
    this.localAlerts.set(id, text);
  }

  clearLocalAlert(id) {
    this.localAlerts?.delete(id);
  }

  /**
   * GAME_MASTER_API pairs. mtm-player only accepts SUCCEEDED with a 2xx status and FAILED with null
   * or >= 400, so a 3xx is reported as FAILED without a status rather than silently ignored.
   * `optional` is used for the poll/refresh pairs: the match page is read every few seconds and a
   * 40-minute match would otherwise blow past the Player's 256 KiB log limit.
   */
  apiLogger(operation, backlogId = null, { optional = false } = {}) {
    return async (phase, req, res, err) => {
      const status = res ? res.status : null;
      const ok = status !== null && status >= 200 && status < 300;
      const realPhase = phase === 'SUCCEEDED' && !ok ? 'FAILED' : phase;
      const httpStatus = realPhase === 'REQUESTED' || (realPhase === 'FAILED' && status !== null && status < 400) ? null : status;
      const summary = realPhase === 'REQUESTED' ? 'Calling mtm-game-server.'
        : realPhase === 'SUCCEEDED' ? 'Received the mtm-game-server result.'
          : `Failed: ${res ? `HTTP ${res.status} ${res.json?.error?.code || ''}`.trim() : `${err?.code || ''} ${err?.message || ''}`.trim()}`;
      this.event({
        type: 'GAME_MASTER_API', operation, backlogId: safeId(backlogId ?? req?.backlogId ?? null), method: req?.method || null,
        origin: loggableOrigin(req?.url), path: loggablePath(req?.url), phase: realPhase, httpStatus,
        requestId: realPhase === 'REQUESTED' ? null : safeId(res?.requestId), summary,
      }, { optional });
    };
  }

  /** Blockers are informational for mtm-player; they never stop the loop on their own. */
  openBlocker(blockerId, backlogId, summary) {
    const id = safeId(blockerId) || 'BLOCKER';
    if (this.blockers.has(id)) return;
    this.blockers.set(id, { backlogId, summary });
    this.event({ type: 'BLOCKER_OPENED', blockerId: id, backlogId: safeId(backlogId), summary: oneLine(summary) });
  }

  resolveBlocker(blockerId, summary) {
    const id = safeId(blockerId);
    if (!id || !this.blockers.has(id)) return;
    this.blockers.delete(id);
    this.event({ type: 'BLOCKER_RESOLVED', blockerId: id, summary: oneLine(summary || 'Resolved.') });
  }

  titleOf(id) {
    return oneLine(this.items.get(id)?.title || id, 160, id);
  }

  backlogStatus(id, status, summary, { revision = null, receiptId = null } = {}) {
    const it = this.items.get(id);
    if (it) {
      it.local ||= {};
      it.local.reported = status;
    }
    this.event({ type: 'BACKLOG_STATUS', backlogId: id, title: this.titleOf(id), status, summary: oneLine(summary || 'Work status updated.'), revision, receiptId: safeId(receiptId) });
  }

  // ---------- lifecycle ----------
  async configure(args = {}) {
    let inputs = [];
    let modelPolicy = args.modelPolicy || null;
    const warnings = [];
    if (args.raw) {
      const parsed = parseLifecycleText(args.raw);
      inputs = parsed.inputs;
      modelPolicy ||= parsed.modelPolicy;
      warnings.push(...parsed.warnings);
    }
    if (args.descriptor) inputs.push({ marker: null, type: args.descriptor.type, descriptor: args.descriptor });
    if (Array.isArray(args.descriptors)) for (const d of args.descriptors) inputs.push({ marker: null, type: d.type, descriptor: d });
    if (!inputs.length && !modelPolicy) return { ok: false, error: 'NO_LIFECYCLE_INPUT', message: 'Pass raw (the full lifecycle text with its marker) or descriptor.' };
    if (modelPolicy) this.modelPolicy = modelPolicy;
    const results = [];
    for (const input of inputs) {
      const d = input.descriptor;
      const v = validateDescriptor(d, { teamWorkspace: this.teamWorkspace, teamId: this.identity?.teamId, session: this.matchId ? { playerSessionId: this.playerSessionId, matchId: this.matchId, repository: this.repository } : null });
      warnings.push(...v.warnings);
      if (v.errors.length) {
        results.push({ type: d?.type, accepted: false, errors: v.errors });
        continue;
      }
      const applied = await this.applyDescriptor(d);
      results.push({ type: d.type, accepted: applied.ok !== false, ...applied });
    }
    const accepted = results.filter((r) => r.accepted);
    return {
      ok: accepted.length === results.length,
      phase: this.phase,
      results,
      warnings,
      modelPolicy: this.modelPolicy ? { orchestratorModel: this.modelPolicy.orchestratorModel ?? null, allowedModels: this.modelPolicy.allowedModels ?? null, enforcement: this.modelPolicy.enforcement ?? null } : null,
      paths: { checkoutRoot: this.checkoutRoot, matchRoot: this.matchRoot, progressLogFile: this.progressLogFile },
      next: results.find((r) => r.next)?.next || this.nextHint(),
    };
  }

  setCommon(d) {
    this.playerSessionId = d.playerSessionId;
    this.matchId = d.matchId;
    if (d.teamId) this.teamId = String(d.teamId);
    if (d.teamName) this.teamName = String(d.teamName);
    if (d.repository) this.repository = { url: d.repository.url, branch: d.repository.branch, folder: d.repository.folder };
    if (d.checkoutRoot) this.checkoutRoot = path.resolve(d.checkoutRoot);
    if (d.matchRoot) this.matchRoot = path.resolve(d.matchRoot);
    if (d.teamWorkspace && !this.teamWorkspace) this.teamWorkspace = path.resolve(d.teamWorkspace);
    // Last resort: <TeamWorkspace>/matches/<matchId> is the documented checkout location.
    if (!this.teamWorkspace && this.checkoutRoot && path.basename(path.dirname(this.checkoutRoot)) === 'matches') this.teamWorkspace = path.dirname(path.dirname(this.checkoutRoot));
    if (d.username) this.account = { username: d.username, password: d.password };
    if (d.matchPageUrl) this.matchPageUrl = d.matchPageUrl.replace(/\/+$/, '');
    if (d.allowedMatchOrigins) this.allowedMatchOrigins = d.allowedMatchOrigins;
    if (d.apiKeySecret) {
      this.bearer = d.apiKeySecret;
      this.apiBase = d.gameMasterApiUrl;
      this.allowedApiOrigins = d.allowedApiOrigins;
      this.apiOperations = d.hostAuthorization?.apiOperations || null;
      this.apiKeyScopes = d.apiKeyScopes || [];
      this.teamUuid = d.teamUuid || null;
      this.gitPolicy = d.gitPolicy || null;
      this.environmentRevision = d.environmentRevision || null;
    }
    const logFile = d.progressLogFile || (this.teamWorkspace ? path.join(this.teamWorkspace, 'team-sdlc-pack', 'logs', `${d.matchId}.progress.ndjson`) : null);
    if (logFile && (!this.log || this.log.file !== logFile || this.log.playerSessionId !== d.playerSessionId)) {
      this.progressLogFile = logFile;
      this.log = new ProgressLog({ file: logFile, playerSessionId: d.playerSessionId });
    }
  }

  isAlreadyPrepared(d) {
    const file = d.progressLogFile || (this.teamWorkspace ? path.join(this.teamWorkspace, 'team-sdlc-pack', 'logs', `${d.matchId}.progress.ndjson`) : null);
    return ProgressLog.read(file).some((e) => e.type === 'ENVIRONMENT_READY' && e.playerSessionId === d.playerSessionId && e.requestId === d.requestId);
  }

  /** Events of the current round: everything after the last ORCHESTRATOR_STARTED. */
  roundEvents() {
    const all = ProgressLog.read(this.progressLogFile);
    let start = 0;
    all.forEach((e, i) => { if (e.type === 'ORCHESTRATOR_STARTED') start = i; });
    return all.slice(start);
  }

  reconcileFromLog() {
    const evs = this.roundEvents();
    for (const e of evs) {
      if (e.type === 'BACKLOG_STATUS' && ITEM_KEY_RE.test(e.backlogId || '')) {
        const it = this.items.get(e.backlogId) || { id: e.backlogId, type: e.backlogId.split('-')[0], title: e.title, local: {} };
        it.local ||= {};
        it.local.reported = e.status;
        if (e.status === 'IN_PROGRESS' && !it.local.startedAt) it.local.startedAt = this.now();
        if (e.status === 'SUBMITTED' && e.receiptId) {
          it.local.receiptId = e.receiptId;
          it.local.revision = e.revision;
          it.local.submittedAt ||= this.now();
        }
        if (!it.title && e.title) it.title = e.title;
        this.items.set(e.backlogId, it);
      }
      if (e.type === 'ENVIRONMENT_READY') this.state.envReady = { revision: e.revision, requestId: e.requestId };
      if (e.type === 'PREPARATION_STATUS') this.prep[e.stage] = e.status;
      if (e.type === 'GAME_START_STATUS' && e.status === 'COMPLETED') this.syncDone = true;
      if (e.type === 'BLOCKER_OPENED') this.blockers.set(e.blockerId, { backlogId: e.backlogId, summary: e.summary });
      if (e.type === 'BLOCKER_RESOLVED') this.blockers.delete(e.blockerId);
    }
    return evs.length;
  }

  async applyDescriptor(d) {
    const type = d.type;
    if (type === 'MATCH_PAUSED') {
      this.phase = 'PAUSED';
      this.stopPoller();
      this.saveState();
      return { message: 'Paused: stop API/Git/tool/worker activity now; keep source and evidence. Do not log ORCHESTRATOR_ENDED. Reply with final_result status BLOCKED and end the turn.' };
    }
    if (type === 'MATCH_ENDED') {
      this.phase = 'ENDED';
      this.stopPoller();
      const fin = this.finalResult({ end: true, status: 'COMPLETED' });
      return { message: 'Match ended: no further submissions. Reply with the final JSON below and stop.', final: fin.final };
    }
    if (type === 'PREPARE_GAME' && this.isAlreadyPrepared(d)) {
      // The same PREPARE input again (helper restarted between turns): restore the account only.
      this.setCommon(d);
      this.prepareRequestId = d.requestId;
      this.roundKey = `${d.playerSessionId}:${d.requestId}`;
      if (this.phase === 'IDLE') this.phase = 'PREPARATION';
      this.loadState({ fresh: false });
      this.reconcileFromLog();
      const pending = this.pendingStart;
      if (pending) {
        // A START/RESUME input arrived before the login was restored. Replay it now so the
        // caller gets the backlog view from this one call. Never fail the restore because
        // the replay failed: the account is back either way, and the agent can retry.
        this.pendingStart = null;
        try {
          const resumed = await this.applyDescriptor(pending.d);
          return {
            ...resumed,
            message: `Login restored in helper memory, and ${pending.type === 'RESUME_GAME' ? 'the round was resumed' : 'the round was started'} from the input you had already sent. ${resumed.message || ''}`.trim(),
            resupplied: true,
          };
        } catch (e) {
          return {
            message: 'Preparation already completed for this request: account restored in helper memory (no new round).',
            resupplied: true,
            replayError: String(e && e.message ? e.message : e),
            next: 'The login is restored. Call configure_session again with the START_GAME_V4 input to enter the round.',
          };
        }
      }
      return { message: 'Preparation already completed for this request: account restored in helper memory (no new round).', resupplied: true };
    }
    if (type === 'PREPARE_GAME' || type === 'RESUME_PREPARATION') {
      const fresh = type === 'PREPARE_GAME';
      this.setCommon(d);
      this.roundKey = fresh ? `${d.playerSessionId}:${d.requestId}` : this.roundKey;
      this.prepareRequestId = d.requestId;
      this.phase = 'PREPARATION';
      if (fresh) {
        this.items.clear();
        this.state = { submissions: {}, items: {}, loginPreferred: this.state.loginPreferred, envReady: null, current: null };
        this.prep = {};
        this.syncDone = false;
        this.loadState({ fresh: true });
        const already = ProgressLog.read(this.progressLogFile).some((e) => e.type === 'ORCHESTRATOR_STARTED' && e.playerSessionId === d.playerSessionId);
        if (!already) this.event({ type: 'ORCHESTRATOR_STARTED', summary: 'Orchestrator started.' });
      } else {
        this.loadState({ fresh: false });
        this.reconcileFromLog();
        this.event({ type: 'ORCHESTRATOR_RESTARTED', attempt: Math.max(1, Number(d.restartAttempt) || 1), phase: 'PREPARATION', reason: safeId(d.reason) || 'OPERATOR_RESUME', summary: 'Reconciled preparation state before continuing.' });
      }
      return { message: fresh ? 'Preparation started. Follow the game-preparation skill.' : 'Preparation resumed. Re-run only the stages not COMPLETED.', prep: this.prep, checkoutExists: fs.existsSync(path.join(this.checkoutRoot, '.git')) };
    }
    if (type === 'START_GAME' || type === 'RESUME_GAME') {
      const resume = type === 'RESUME_GAME';
      const samePrep = this.matchId === d.matchId && this.account;
      this.setCommon(d);
      this.phase = 'GAME';
      this.loadState({ fresh: false });
      this.reconcileFromLog();
      if (resume) {
        this.event({ type: 'ORCHESTRATOR_RESTARTED', attempt: Math.max(1, Number(d.restartAttempt) || 1), phase: 'GAME', reason: safeId(d.reason) || 'OPERATOR_RESUME', summary: 'Reconciled Git, receipts and progress before continuing.' });
      }
      const out = { message: resume ? 'Game resumed.' : 'Game started.' };
      if (!this.account) {
        // START_GAME carries no account: the helper process restarted since preparation.
        this.saveState();
        // Remember what we were asked to do. Feeding the PREPARE input back is enough:
        // the restore path below replays this START for us, so the agent spends one turn
        // on recovery instead of three, and reaches the first start_work sooner.
        this.pendingStart = { type, d };
        return {
          ...out, ok: false, error: 'NEED_PREPARE_INPUT',
          next: 'The helper restarted and lost the match login. Call configure_session ONCE with raw = the PREPARE_GAME_V2 input from earlier in this conversation (marker + JSON line). That restores the login and resumes this round in the same call: the result carries the backlog view, so do not start a new round and do not call refresh_match or session_status afterwards.',
        };
      }
      if (!samePrep) out.note = 'Account from an earlier input is reused.';
      this.startPoller();
      // Backlog sync: BACKLOG_SYNC IN_PROGRESS -> refresh -> COMPLETED with DISCOVERED events.
      if (!this.syncDone || resume) {
        this.event({ type: 'GAME_START_STATUS', stage: 'BACKLOG_SYNC', status: 'IN_PROGRESS', summary: 'Synchronizing the backlog.' });
        const r = await this.withLock(() => this.doRefresh({ reason: 'sync' }));
        if (r.ok) {
          this.syncDone = true;
          this.event({ type: 'GAME_START_STATUS', stage: 'BACKLOG_SYNC', status: 'COMPLETED', summary: oneLine(`Retrieved the current backlog: ${this.items.size} item(s).`) });
        } else {
          this.syncDone = false;
          this.event({ type: 'GAME_START_STATUS', stage: 'BACKLOG_SYNC', status: 'FAILED', summary: oneLine(`Backlog sync failed: ${r.error}`) });
        }
        out.sync = r.ok ? 'COMPLETED' : `FAILED: ${r.error}`;
      }
      out.view = this.view({ includeEvents: true });
      // The view is here. Two extra round trips before the first start_work cost real match
      // minutes, so make it explicit rather than leaving the agent to be cautious.
      out.next = `The backlog view is in this result; it is current. Go straight to start_work on NEXT - do not call refresh_match or session_status first. ${this.nextHint()}`;
      if (out.sync?.startsWith('FAILED:')) out.next = 'Backlog data was NOT synchronized. Call login_match once to restore the contestant session, then refresh_match. Do not mark BACKLOG_SYNC complete or interpret the loading shell as an empty backlog.';
      if (resume) out.recovery = await this.recoveryReport();
      this.saveState();
      return out;
    }
    return { message: `Unhandled descriptor type ${type}` };
  }

  nextHint() {
    switch (this.phase) {
      case 'PREPARATION': return 'Preparation: GIT_AUTH -> REPOSITORY -> ENVIRONMENT -> BUILD (report_progress each start/end), login_match, report_ready, then reply with its final JSON and end the turn.';
      case 'GAME': return 'Game: take NEXT from the view (start_work -> implement/test -> evidence -> commit/push -> submit_work). Never end the turn while the match runs; when idle call wait_for_update.';
      case 'PAUSED': return 'Paused: stop work and end the turn with final_result status BLOCKED.';
      case 'ENDED': return 'Ended: reply with the final JSON and stop.';
      default: return 'Call configure_session with the lifecycle input (raw text including its marker line).';
    }
  }

  // ---------- portal ----------
  matchUrl() {
    const tpl = this.adapter.matchView.pagePathTemplate || '{matchPageUrl}/{matchId}';
    return tpl.replace('{matchPageUrl}', this.matchPageUrl).replace('{matchId}', encodeURIComponent(this.matchId));
  }

  async loginInternal() {
    if (!this.account) {
      const e = new Error('no account in helper memory');
      e.code = 'NO_ACCOUNT';
      throw e;
    }
    const origin = new URL(this.matchPageUrl).origin;
    this.jar.clear();
    const res = await login({
      origin, matchUrl: this.matchUrl(), matchId: this.matchId, username: this.account.username, password: this.account.password, jar: this.jar,
      allowedOrigins: this.allowedMatchOrigins, adapter: this.adapter, preferred: this.state.loginPreferred, log: this.apiLogger('LOGIN'),
    });
    this.state.loginPreferred = res;
    this.loggedIn = true;
    return res;
  }

  async login_match() {
    if (!this.matchPageUrl) return { ok: false, error: 'NOT_CONFIGURED', next: this.nextHint() };
    const inPrep = this.phase === 'PREPARATION';
    if (inPrep) this.event({ type: 'PREPARATION_STATUS', stage: 'MATCH_LOGIN', status: 'IN_PROGRESS', summary: 'Logging in and opening the assigned match page.' });
    try {
      const how = await this.withLock(() => this.loginInternal());
      const r = await this.withLock(() => this.doRefresh({ reason: 'login', noRelogin: true }));
      if (!r.ok) throw Object.assign(new Error(r.error), { code: 'MATCH_PAGE' });
      const check = this.verifyAssignment();
      if (!check.ok) throw Object.assign(new Error(`assignment check failed: ${check.errors.join('; ')}`), { code: 'ASSIGNMENT_MISMATCH', check });
      if (inPrep) {
        this.prep.MATCH_LOGIN = 'COMPLETED';
        this.event({ type: 'PREPARATION_STATUS', stage: 'MATCH_LOGIN', status: 'COMPLETED', summary: oneLine(`Logged in; match ${this.matchId} page verified (${check.notes.join(', ')}).`) });
      }
      this.resolveBlocker('MATCH_LOGIN_FAILED', 'Match login recovered.');
      this.saveState();
      return { ok: true, strategy: how.strategy, matchStatus: this.match.status, matchUuid: this.match.uuid, items: this.items.size, verification: check, next: inPrep ? 'Call report_ready when GIT_AUTH, REPOSITORY, ENVIRONMENT and BUILD are COMPLETED.' : 'Continue the match loop.' };
    } catch (e) {
      if (inPrep) {
        this.prep.MATCH_LOGIN = 'FAILED';
        this.event({ type: 'PREPARATION_STATUS', stage: 'MATCH_LOGIN', status: 'FAILED', summary: oneLine(`Match login failed: ${e.code || ''} ${e.message}`) });
      }
      this.openBlocker('MATCH_LOGIN_FAILED', null, `Match login failed: ${e.code || e.message}`);
      return this.clean({ ok: false, error: e.code || 'LOGIN_FAILED', message: e.message, tried: e.tried?.slice(-8), verification: e.check, next: 'Retry login_match once. If it still fails during preparation, report BLOCKED with this message (a human can still help before the match starts).' });
    }
  }

  /**
   * Guide step 5: the page must be the assigned match and agree with the mtm-player input.
   * A value the page shows that contradicts the input blocks MATCH_LOGIN. Per field, structured page data
   * wins; labelled values on a plain page ("Team T01", "branch main", "Repository <url>") are read only
   * from the match header (before the first backlog item), never from backlog descriptions. A value the
   * page does not show at all is only noted. Repositories match on host + path (https / ssh / .git
   * spellings normalize); another host or another owner/name is a contradiction.
   * game-adapter.json matchView.assignmentCheck = "warn" turns contradictions into notes (practice-day
   * escape hatch if the real page labels things in a way this parser misreads).
   */
  /** Keeps what verifyAssignment reads from the last parsed match page. */
  rememberPage(parsed) {
    this.lastPageText = parsed.pageText;
    this.lastAssignment = { matchIdShown: parsed.matchIdShown, ...(parsed.assignment || {}), text: parsed.textAssignment || null };
    if (parsed.mcpUrls?.length && !this.adapter.matchView?.mcpUrl) {
      const base = this.matchUrl();
      const seen = new Set(this.pageMcpUrls || []);
      for (const u of parsed.mcpUrls) {
        try {
          const abs = new URL(u, base).toString();
          if (this.allowedOrigins().includes(originOf(abs))) seen.add(abs);
        } catch { /* not a URL */ }
      }
      this.pageMcpUrls = [...seen];
    }
  }

  allowedOrigins() {
    return [...new Set([...(this.allowedMatchOrigins || []), ...(this.allowedApiOrigins || [])])];
  }

  /**
   * The match MCP server, when the organizers provide one: the customer's internal material
   * (standards, fixtures, tickets, documentation) that a backlog item may refer to. The URL comes from
   * game-adapter.json (matchView.mcpUrl) or from the match page itself - never from a guess.
   */
  matchMcpUrl() {
    const configured = this.adapter.matchView?.mcpUrl;
    if (configured) {
      const abs = new URL(configured.replace('{matchId}', encodeURIComponent(this.matchId || '')).replace('{matchUuid}', this.match.uuid || ''), this.matchPageUrl || 'https://invalid.local').toString();
      return abs;
    }
    const urls = this.pageMcpUrls || [];
    if (!urls.length) return null;
    const id = String(this.matchId || '').toLowerCase();
    return urls.find((u) => id && u.toLowerCase().includes(id)) || urls.find((u) => this.match.uuid && u.toLowerCase().includes(this.match.uuid)) || urls[0];
  }

  mcpLogger(operation) {
    return async (phase, req, res, err) => {
      this.event({
        type: 'NETWORK_ACTIVITY', operation: safeId(operation) || 'MATCH_MCP', backlogId: safeId(this.state.current),
        method: req?.method || 'POST', origin: loggableOrigin(req?.url) || loggableOrigin(this.matchPageUrl) || 'https://invalid.local',
        path: loggablePath(req?.url) || '/', phase, httpStatus: res ? res.status : null, requestId: safeId(res?.requestId),
        summary: phase === 'REQUESTED' ? oneLine(`Calling the match MCP server (${req?.operation || operation}).`)
          : phase === 'SUCCEEDED' ? 'Received the match MCP result.' : oneLine(`Match MCP failed: ${res ? `HTTP ${res.status}` : `${err?.code || ''} ${err?.message || ''}`}`),
      }, { optional: true });
    };
  }

  async match_mcp({ action = 'tools', name, args = {}, uri } = {}) {
    if (this.phase === 'IDLE') return { ok: false, error: 'NOT_CONFIGURED', next: this.nextHint() };
    const url = this.matchMcpUrl();
    if (!url) {
      return {
        ok: false, error: 'NO_MATCH_MCP',
        message: 'The match page advertises no MCP server, and game-adapter.json matchView.mcpUrl is not set.',
        next: 'Work from the repository and the brief. If an item refers to an internal standard, fixture or ticket you cannot reach, state the assumption you used in the answer and ship; never wait for it.',
      };
    }
    if (!this.allowedOrigins().includes(originOf(url))) {
      return { ok: false, error: 'ORIGIN_NOT_ALLOWED', message: `${originOf(url)} is not in the origins mtm-player allowed.` };
    }
    this.mcp ||= new McpHttpClient({ url, bearer: this.bearer, allowedOrigins: this.allowedOrigins(), log: this.mcpLogger('MATCH_MCP') });
    if (this.mcp.url !== url) this.mcp = new McpHttpClient({ url, bearer: this.bearer, allowedOrigins: this.allowedOrigins(), log: this.mcpLogger('MATCH_MCP') });
    if (this.bearer && this.mcp.bearer !== this.bearer) this.mcp.bearer = this.bearer;
    try {
      if (action === 'tools') {
        const tools = await this.mcp.tools();
        let resources = [];
        try {
          resources = await this.mcp.resources();
        } catch { /* resources are optional */ }
        return this.clean({
          ok: true, url, server: this.mcp.serverInfo, instructions: this.mcp.instructions ? truncate(this.mcp.instructions, 2000) : null,
          tools: tools.map((t) => ({ name: t.name, description: truncate(t.description || '', 300), input: Object.keys(t.inputSchema?.properties || {}), required: t.inputSchema?.required || [] })),
          resources: resources.slice(0, 50).map((r) => ({ uri: r.uri, name: r.name, description: truncate(r.description || '', 160) })),
          next: 'Call one with action "call" (name + args), or read a resource with action "resource" (uri). Quote what you used in the answer.',
        });
      }
      if (action === 'call') {
        if (!name) return { ok: false, error: 'NAME_REQUIRED', next: 'action "tools" lists the names.' };
        const r = await this.mcp.call(name, args);
        return this.clean({ ok: !r?.isError, url, tool: name, isError: !!r?.isError, text: resultText(r), structured: r?.structuredContent ?? null });
      }
      if (action === 'resource') {
        if (!uri) return { ok: false, error: 'URI_REQUIRED' };
        const r = await this.mcp.readResource(uri);
        return this.clean({ ok: true, url, uri, text: resultText(r) });
      }
      return { ok: false, error: 'BAD_ACTION', message: 'action is tools | call | resource' };
    } catch (e) {
      this.mcp.ready = false;
      return this.clean({
        ok: false, error: e.code || 'MATCH_MCP_FAILED', message: e.message, url,
        next: 'The match MCP server is not answering. Do not retry in a loop: work from the repository and the brief, write the assumption you used into the answer, and ship.',
      });
    }
  }

  verifyAssignment() {
    const text = this.lastPageText || '';
    const a = this.lastAssignment || {};
    const t = a.text || { teamIds: [], branches: [], folders: [], repoUrls: [] };
    let errors = [];
    const notes = [];
    const lc = (v) => String(v ?? '').trim().toLowerCase();
    const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = (v) => !!v && new RegExp(`(^|[^A-Za-z0-9])${esc(v)}($|[^A-Za-z0-9])`, 'i').test(text);
    if (a.matchIdShown) notes.push(`match id ${this.matchId} shown`);
    else errors.push(`the page does not show match id ${this.matchId}: it is not the assigned match page`);
    const want = this.repository || {};
    const got = a.repository || {};
    // Structured page data wins per field; labelled plain-text values (match header only) are the fallback.
    for (const [name, wanted, structured, labelled] of [['folder', want.folder, got.folder, t.folders], ['branch', want.branch, got.branch, t.branches]]) {
      if (!wanted) continue;
      if (structured) {
        if (lc(structured) !== lc(wanted)) errors.push(`page ${name} ${structured} != assigned ${name} ${wanted}`);
        else notes.push(`${name} shown`);
      } else if (labelled.length && !labelled.some((v) => lc(v) === lc(wanted))) errors.push(`page shows ${name} ${labelled.join('/')}, assigned ${name} is ${wanted}`);
      else if (labelled.length || token(wanted)) notes.push(`${name} shown`);
    }
    if (want.url) {
      // Same repository = same host and same path. https / ssh / scp-like / .git spellings normalize;
      // a different host (github.com vs gitlab.com) is another repository unless the adapter declares
      // the alias (matchView.repoHostAliases, e.g. {"ssh.github.com": "github.com"}).
      const aliases = this.adapter.matchView?.repoHostAliases || {};
      const host = (k) => {
        const h = k.host.replace(/^www\./, '');
        return lc(aliases[h] || h);
      };
      const w = repoKey(want.url);
      const shown = got.url ? [got.url] : t.repoUrls;
      const same = shown.filter((u) => repoKey(u).path === w.path && host(repoKey(u)) === host(w));
      const otherHost = shown.filter((u) => repoKey(u).path === w.path && host(repoKey(u)) !== host(w));
      if (shown.length && !same.length) {
        errors.push(otherHost.length
          ? `page repository ${otherHost[0]} is on another host than the assigned ${want.url} (if it is the same server, declare it in game-adapter.json matchView.repoHostAliases)`
          : `page repository ${shown.join(' / ')} is not the assigned repository ${want.url}`);
      } else if (same.length) notes.push('repository shown');
    }
    const teamId = this.teamId || this.identity?.teamId;
    const teamName = this.teamName || this.identity?.teamName;
    if (teamId) {
      const ours = (v) => lc(v) === lc(teamId);
      const nameShown = !!teamName && lc(text).includes(lc(teamName));
      if (a.teamId) {
        if (!ours(a.teamId)) errors.push(`page team ${a.teamId} != assigned team ${teamId}`);
        else notes.push('team shown');
      } else if (t.teamIds.length && !t.teamIds.some(ours) && !token(teamId) && !nameShown) errors.push(`page shows team ${t.teamIds.join('/')}, assigned team is ${teamId}${teamName ? ` (${teamName})` : ''}`);
      else if (t.teamIds.some(ours) || token(teamId) || nameShown) notes.push('team shown');
    }
    if (errors.length && this.adapter.matchView?.assignmentCheck === 'warn') {
      notes.push(...errors.map((e) => `NOT BLOCKING (assignmentCheck=warn): ${e}`));
      errors = [];
    }
    return { ok: !errors.length, errors, notes };
  }

  ingest(parsed) {
    const now = this.now();
    for (const p of parsed.items) {
      const prev = this.items.get(p.id);
      const it = { ...(prev || {}), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)), local: prev?.local || {} };
      if (!it.firstSeenAt) it.firstSeenAt = now;
      if (!it.revealedAt) it.revealedAt = it.firstSeenAt;
      if (!it.deadlineAt && it.deadlineMinutes != null) it.deadlineAt = it.revealedAt + it.deadlineMinutes * 60000;
      this.items.set(p.id, it);
    }
    if (parsed.matchUuid) this.match.uuid = parsed.matchUuid;
    if (parsed.status) this.match.status = parsed.status;
    if (parsed.endsAt) this.match.endsAt = parsed.endsAt;
    if (this.match.endsAt && this.match.endsAt <= now && this.match.status !== 'PAUSED') this.match.status = 'FINISHED';
  }

  /** One page fetch (call under lock). */
  async doRefresh({ reason = 'refresh', noRelogin = false } = {}) {
    if (!this.matchPageUrl) return { ok: false, error: 'NOT_CONFIGURED' };
    const url = this.matchUrl();
    // A poll that changes nothing is routine: log it as optional telemetry (dropped under pressure)
    // and in full only now and then, so the audit trail stays readable inside the Player's budget.
    const routine = reason === 'refresh' || reason === 'poll' || reason === 'status-check';
    const sinceLogged = this.lastLoggedRefreshAt ? Date.now() - this.lastLoggedRefreshAt : Infinity;
    const log = this.apiLogger(reason === 'login' ? 'LOGIN' : 'REFRESH_MATCH', null, { optional: routine && sinceLogged < 60000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.loggedIn && !noRelogin) {
        try {
          await this.loginInternal();
        } catch (e) {
          this.lastPollError = e.message;
          if (e.code === 'NO_ACCOUNT') return { ok: false, error: 'NO_ACCOUNT: call configure_session with the PREPARE_GAME (or RESUME_GAME) input again' };
          this.openBlocker('MATCH_LOGIN_FAILED', null, `Re-login failed: ${e.code || e.message}`);
          return { ok: false, error: `login failed: ${e.message}` };
        }
      }
      const req = { method: 'GET', url };
      await log('REQUESTED', req);
      let res;
      try {
        res = await request(url, { jar: this.jar, allowedOrigins: this.allowedMatchOrigins, headers: { accept: 'text/html,application/xhtml+xml' } });
      } catch (e) {
        await log('FAILED', req, null, e);
        this.lastPollError = e.message;
        return { ok: false, error: `${e.code || 'NETWORK'}: ${e.message}` };
      }
      if (res.serverDate) this.match.serverOffsetMs = res.serverDate - Date.now();
      if (looksLikeLogin(res)) {
        await log('FAILED', req, res);
        this.loggedIn = false;
        if (noRelogin || attempt === 1) return { ok: false, error: 'session not accepted by the match page (login page returned)' };
        continue;
      }
      await log(res.status < 400 ? 'SUCCEEDED' : 'FAILED', req, res);
      if (res.status >= 400) {
        this.lastPollError = `HTTP ${res.status}`;
        return { ok: false, error: `match page HTTP ${res.status}` };
      }
      const view = await loadMatchData(res.text, {
        url, matchId: this.matchId, matchUuid: this.match.uuid,
        requireUuid: this.phase === 'GAME',
        extraJsonPaths: this.adapter.matchView.extraJsonPaths || [], serverNow: this.now(),
        call: async (jurl, opts) => {
          const req = { method: 'GET', url: jurl };
          await log('REQUESTED', req);
          try {
            const result = await request(jurl, { jar: this.jar, allowedOrigins: this.allowedMatchOrigins, ...opts });
            await log(result.status < 400 ? 'SUCCEEDED' : 'FAILED', req, result);
            return result;
          } catch (e) { await log('FAILED', req, null, e);throw e; }
        },
      });
      const parsed = view.parsed;
      this.portalReady = view.readable;
      if (!view.readable) {
        this.rememberPage(parsed);
        this.lastParse = { structured: parsed.structured, warnings: parsed.warnings };
        if (view.authRejected) {
          this.loggedIn = false;
          if (!noRelogin && attempt === 0) continue;
        }
        this.lastPollError = view.authRejected ? 'MATCH_DATA_UNAUTHORIZED' : 'MATCH_DATA_UNAVAILABLE';
        this.openBlocker('MATCH_PORTAL_LOADING', null, 'Match data is unavailable: the HTML is only a loading shell, or the contestant JSON view was rejected. Readiness and backlog sync are not verified.');
        return { ok: false, error: this.lastPollError, details: view.errors, next: 'Retry login_match once. If preparation still cannot read match status and UUID, report BLOCKED before the clock starts; do not mark BACKLOG_SYNC complete.' };
      }
      this.itemLinks = { ...(this.itemLinks || {}), ...parsed.itemLinks };
      const hash = sha256(parsed.pageText).slice(0, 16);
      this.pageChanged = hash !== this.match.pageTextHash;
      this.match.pageTextHash = hash;
      this.rememberPage(parsed);
      this.lastParse = { structured: parsed.structured, warnings: parsed.warnings };
      const before = this.snapshotMap();
      this.ingest(parsed);
      const after = this.snapshotMap();
      const evs = diffItems(this.snapshot ? before : null, after);
      const statusChanged = this.lastStatus && this.lastStatus !== this.match.status;
      if (statusChanged) evs.unshift({ kind: 'MATCH', id: null, text: `MATCH ${this.lastStatus} -> ${this.match.status}` });
      this.lastStatus = this.match.status;
      this.snapshot = after;
      this.match.lastRefreshAt = this.now();
      this.lastPollError = null;
      if (!routine || sinceLogged >= 60000 || evs.length) this.lastLoggedRefreshAt = Date.now();
      if (this.phase === 'GAME') this.emitDiscovered();
      if (evs.length) this.pendingEvents.push(...evs.map((e) => e.text));
      if (!this.match.uuid && this.phase === 'GAME') this.openBlocker('MATCH_UUID_UNKNOWN', null, 'Match UUID for Start/Submit not found on the match page.');
      else this.resolveBlocker('MATCH_UUID_UNKNOWN', 'Match UUID found.');
      this.resolveBlocker('MATCH_LOGIN_FAILED', 'Match page readable again.');
      this.resolveBlocker('MATCH_PORTAL_LOADING', 'Authenticated match status and UUID verified.');
      this.saveState();
      return { ok: true, events: evs };
    }
    return { ok: false, error: 'unreachable' };
  }

  snapshotMap() {
    return new Map([...this.items].map(([id, it]) => [id, { type: it.type, title: it.title, maxPoints: it.maxPoints, availability: it.availability, specHash: it.specHash, result: it.result, score: it.score, deadlineAt: it.deadlineAt }]));
  }

  emitDiscovered() {
    for (const [id, it] of this.items) {
      if (it.local?.reported) continue;
      this.backlogStatus(id, 'DISCOVERED', 'Work status updated.');
    }
  }

  async refresh_match({ includePageText = false } = {}) {
    if (!this.matchPageUrl) return { ok: false, error: 'NOT_CONFIGURED', next: this.nextHint() };
    const r = await this.withLock(() => this.doRefresh());
    const firstGameView = this.phase === 'GAME' && !this.shownPageText;
    const needText = includePageText || !this.lastParse?.structured || firstGameView;
    if (needText) this.shownPageText = true;
    return this.clean({ ok: r.ok, error: r.error, view: this.view({ includeEvents: true, pageText: needText }) });
  }

  /** Compact state for the model; every tool result carries alerts and NEXT. */
  view({ includeEvents = false, pageText = false } = {}) {
    const now = this.now();
    const items = [...this.items.values()];
    const { ranked, skipped } = rank(items, now, this.match.endsAt, this.adapter.planner);
    const current = this.state.current;
    const al = [
      ...plannerAlerts(items, now, this.match.endsAt, { current, paused: this.phase === 'PAUSED', status: this.match.status }, this.adapter.planner),
      ...[...(this.localAlerts?.values() || [])].map((t) => `!! ${t}`),
      ...this.logProblems.splice(0).map((t) => `!! progress log: ${t}`),
    ];
    const table = items.map((it) => {
      const { left } = effectiveLeft(it, now, this.match.endsAt);
      return {
        id: it.id, type: it.type, pts: it.maxPoints ?? null, title: it.title ? truncate(it.title, 90) : null, avail: it.availability || null,
        ours: isSubmitted(it) ? 'SUBMITTED' : it.local?.startedAt ? (it.local.owner && it.local.owner !== 'orchestrator' ? `WORKING(${it.local.owner})` : 'WORKING') : isClosed(it, now) ? 'CLOSED' : 'NOT_STARTED',
        left: left == null ? null : Math.round(left * 10) / 10, result: it.result || null,
      };
    });
    const out = {
      phase: this.phase,
      match: { id: this.matchId, status: this.match.status, remainingMin: this.match.endsAt ? minutes(this.match.endsAt - now) : null, uuidKnown: !!this.match.uuid, lastRefreshSecAgo: this.match.lastRefreshAt ? Math.round((now - this.match.lastRefreshAt) / 1000) : null },
      items: table,
      next: ranked[0] ? `${ranked[0].id} (${ranked[0].why})` : (this.match.status === 'FINISHED' ? 'MATCH FINISHED: final_result end=true' : 'nothing actionable: call wait_for_update'),
      queue: ranked.slice(1, 5).map((r) => `${r.id}: ${r.why}`),
      skipped: skipped.slice(0, 5),
      current,
      alerts: al,
      blockers: [...this.blockers.keys()],
    };
    if (includeEvents && this.pendingEvents.length) out.events = this.pendingEvents.splice(0, 30);
    if (this.lastPollError) out.pollError = this.lastPollError;
    if (this.lastParse && !this.lastParse.structured) out.parse = `page structure unknown (${this.lastParse.warnings.join('; ')}): read pageText; pass matchUuid to start_work if needed`;
    if (pageText && this.lastPageText) out.pageText = truncate(this.lastPageText, 12000);
    if (this.phase === 'GAME' && this.match.status !== 'FINISHED') out.keepAlive = 'Match running: do not end your turn. Act on NEXT, or call wait_for_update with no timeoutMs - it returns the instant anything changes, so waiting long is free and waking up often is not.';
    return out;
  }

  async wait_for_update({ timeoutMs } = {}) {
    const ceiling = this.adapter.polling.maxWaitMs || 55000;
    const max = Math.min(Number(timeoutMs) || ceiling, ceiling);
    const until = Date.now() + max;
    let lastErr = null;
    if (this.pendingEvents.length) return this.clean({ ok: true, changed: true, view: this.view({ includeEvents: true }) });
    const startStatus = this.match.status;
    while (Date.now() < until) {
      const r = await this.withLock(() => this.doRefresh());
      lastErr = r.ok ? null : r.error;
      const changed = r.ok && !!r.events?.some((e) => e.kind !== 'RESULT'); // grading results do not wake the agent
      const newlyPaused = this.match.status === 'PAUSED' && startStatus !== 'PAUSED'; // a pause that persists is waited out, not spun on
      if (changed || this.match.status === 'FINISHED' || newlyPaused || this.phase !== 'GAME' && this.phase !== 'PREPARATION') {
        return this.clean({ ok: true, changed, view: this.view({ includeEvents: true, pageText: !!r.events?.some((e) => e.kind === 'NEW' || e.kind === 'EDITED') && !this.lastParse?.structured }) });
      }
      const wait = r.ok ? this.adapter.polling.successMs : this.adapter.polling.errorMs;
      if (Date.now() + wait >= until) break;
      await sleep(wait);
    }
    return this.clean({ ok: !lastErr, changed: false, error: lastErr, view: this.view({ includeEvents: true }) });
  }

  startPoller() {
    this.stopPoller();
    const ms = this.adapter.polling.backgroundMs;
    if (!ms || ms < 3000) return;
    this.poller = setInterval(() => {
      if (this.phase !== 'GAME') return;
      if (this.match.lastRefreshAt && this.now() - this.match.lastRefreshAt < ms - 500) return;
      this.withLock(() => this.doRefresh()).catch(() => {});
    }, ms);
    this.poller.unref?.();
  }

  stopPoller() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  // ---------- backlog work ----------
  /** Item detail page, when the match page links to one and has no description itself. */
  async fetchItemDetail(id) {
    const it = this.items.get(id);
    if (!it || it.description || it.detailFetched || !this.itemLinks?.[id] || !this.matchPageUrl) return;
    it.detailFetched = true;
    const url = new URL(this.itemLinks[id], this.matchUrl()).toString();
    const log = this.apiLogger('REFRESH_MATCH', id, { optional: true });
    const req = { method: 'GET', url, backlogId: id };
    await log('REQUESTED', req);
    try {
      const res = await request(url, { jar: this.jar, allowedOrigins: this.allowedMatchOrigins });
      await log(res.status < 400 ? 'SUCCEEDED' : 'FAILED', req, res);
      if (res.status < 400 && !looksLikeLogin(res)) {
        const p = parseMatchPage(res.text, { matchId: this.matchId, serverNow: this.now() });
        const found = p.items.find((x) => x.id === id);
        it.description = found?.description || textBlockFor(p.pageText, id) || p.pageText.slice(0, 8000);
      }
    } catch (e) {
      await log('FAILED', req, null, e);
    }
  }

  async get_backlog_item({ backlogItemKey } = {}) {
    const id = backlogItemKey;
    const it = this.items.get(id);
    if (!it) return { ok: false, error: 'UNKNOWN_ITEM', message: `${id} is not on the match page (yet). refresh_match first.` };
    await this.withLock(() => this.fetchItemDetail(id));
    const mat = this.readMaterial(id);
    const desc = it.description || textBlockFor(this.lastPageText || '', id) || null;
    const now = this.now();
    const { left, by } = effectiveLeft(it, now, this.match.endsAt);
    return this.clean({
      ok: true, id, type: it.type, title: it.title, maxPoints: it.maxPoints, availability: it.availability, deadlineLeftMin: left == null ? null : minutes(left * 60000), deadlineBy: by,
      description: desc ? truncate(desc, 12000) : null,
      started: !!it.local?.startedAt, submitted: isSubmitted(it), receiptId: it.local?.receiptId || null,
      startInstruction: mat?.startInstruction ?? null, submitTemplate: mat?.submitTemplate ?? null, minimumVerificationScenarios: mat?.minimumVerificationScenarios ?? null,
      files: mat?.files ? Object.keys(mat.files) : [],
      answer: this.matchRoot ? answerPaths(this.itemMatchRoot(id), id) : null,
      playbook: PLAYBOOK[it.type] || null,
      alerts: this.view().alerts,
    });
  }

  itemMatchRoot(id) {
    const wt = this.items.get(id)?.local?.worktree;
    return wt?.matchRoot || this.matchRoot;
  }

  readMaterial(id) {
    if (!this.stateDir) return this.materialCache?.[id] || null;
    return readJson(path.join(this.stateDir, 'items', id, 'start.json'), this.materialCache?.[id] || null);
  }

  async start_work({ backlogItemKey, matchUuid } = {}) {
    const id = String(backlogItemKey || '').trim();
    if (!ITEM_KEY_RE.test(id) && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/.test(id)) return { ok: false, error: 'BAD_KEY' };
    if (this.phase !== 'GAME') return { ok: false, error: 'NOT_IN_GAME', message: `phase is ${this.phase}`, next: this.nextHint() };
    if (!this.bearer) return { ok: false, error: 'NO_BEARER', next: 'call configure_session with the START_GAME / RESUME_GAME input' };
    if (matchUuid && /^[0-9a-f-]{36}$/i.test(matchUuid)) this.match.uuid = matchUuid.toLowerCase();
    if (!this.match.uuid) {
      await this.withLock(() => this.doRefresh());
      if (!this.match.uuid) return { ok: false, error: 'MATCH_UUID_UNKNOWN', message: 'Start/Submit URLs not found on the match page. Read pageText (refresh_match includePageText=true) and pass matchUuid.' };
    }
    const it = this.items.get(id) || { id, type: id.split('-')[0], local: {} };
    it.local ||= {};
    this.items.set(id, it);
    const url = operationUrl(this.apiBase, this.apiOperations, 'START_WORK', this.match.uuid);
    const r = await startWork({ url, bearer: this.bearer, allowedOrigins: this.allowedApiOrigins, backlogItemKey: id, log: this.apiLogger('START_WORK', id), beforeRetry: () => this.retryGate() });
    if (!r.ok) {
      const code = r.code || r.error?.code;
      it.local.startRefusals = (it.local.startRefusals || 0) + 1;
      if (code === 'BACKLOG_ITEM_NOT_OPEN' || code === 'BACKLOG_ITEM_NOT_VISIBLE') it.local.notOpenRefused = true;
      if (code === 'BACKLOG_ITEM_CLOSED') it.availability = 'CLOSED';
      const matchStatus = code === 'MATCH_NOT_ACCEPTING_SUBMISSIONS' ? await this.recheckMatchStatus() : undefined;
      if (['INVALID_API_KEY', 'API_KEY_REVOKED', 'API_KEY_SCOPE_FORBIDDEN', 'TEAM_NOT_IN_MATCH', 'FORBIDDEN'].includes(code)) this.openBlocker('BEARER_REJECTED', id, `Start Work rejected the team key: ${code}`);
      this.saveState();
      const next = r.halted ? `Retries stopped (${r.halted}): call start_work again once the match is IN_PROGRESS (it is idempotent).`
        : r.uncertain ? 'Network trouble: call start_work again (it is idempotent).' : matchStatus ? this.notAcceptingHint(matchStatus) : 'Take NEXT from the view.';
      return this.clean({ ok: false, error: code, httpStatus: r.httpStatus, message: r.message || r.error?.message, uncertain: !!r.uncertain, halted: r.halted, matchStatus, view: this.view(), next });
    }
    this.resolveBlocker('BEARER_REJECTED', 'Team key accepted.');
    const data = r.data || {};
    if (data.backlogType && /^(TASK|CR|BUG|PI)$/.test(data.backlogType)) it.type = data.backlogType;
    const firstStart = !it.local.startedAt;
    if (firstStart) it.local.startedAt = this.now();
    if (it.local.notOpenRefused) delete it.local.notOpenRefused;
    delete it.local.parked;
    await this.withLock(() => this.fetchItemDetail(id));
    const material = { backlogId: data.backlogId || id, backlogType: data.backlogType || it.type, startInstruction: data.startInstruction ?? '', submitTemplate: data.submitTemplate ?? null, minimumVerificationScenarios: data.minimumVerificationScenarios ?? null, files: data.files || {}, receivedAt: nowIso(), replay: !!data.replay };
    this.materialCache = { ...(this.materialCache || {}), [id]: material };
    if (this.stateDir) {
      writeJson(path.join(this.stateDir, 'items', id, 'start.json'), material);
      for (const [rel, content] of Object.entries(material.files)) {
        const target = path.join(this.stateDir, 'items', id, 'files', rel);
        if (isInside(target, path.join(this.stateDir, 'items', id, 'files'))) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
        }
      }
    }
    const root = this.itemMatchRoot(id);
    let notesFile = null;
    if (this.checkoutRoot && fs.existsSync(path.join(this.checkoutRoot, '.git'))) {
      G.ensureExcluded(this.checkoutRoot, '/.mtm-notes/');
      notesFile = path.join(this.checkoutRoot, '.mtm-notes', `${id}.md`);
    }
    let answer = null;
    if (root && fs.existsSync(root)) answer = materializeAnswer(root, id, material.submitTemplate);
    const required = countScenarios(material.minimumVerificationScenarios);
    // The checklist goes out with the material and is also written beside the answer, so it survives
    // an agent restart or a context reset mid-item (see src/checklist.mjs for why this exists).
    const checklist = buildChecklist({
      id, type: it.type, startInstruction: material.startInstruction, description: it.description || '',
      minimumVerificationScenarios: material.minimumVerificationScenarios, requiredScenarios: required,
      commands: this.commands || {}, appPath: this.appPath || null,
    });
    let checklistFile = null;
    if (answer?.evidenceDir) {
      try {
        const target = path.join(path.dirname(answer.submitJson), 'checklist.md');
        if (!fs.existsSync(target)) fs.writeFileSync(target, checklist.text);
        checklistFile = target;
      } catch { /* the checklist is also in this result; a write failure must not block the item */ }
    }
    if (it.local.reported !== 'IN_PROGRESS' && it.local.reported !== 'SUBMITTED') {
      this.backlogStatus(id, 'IN_PROGRESS', 'Start Work accepted; implementation started.');
      this.event({ type: 'BACKLOG_TESTS', backlogId: id, status: 'NOT_RUN', required, executed: 0, passed: 0, failed: 0, skipped: 0, summary: 'Tests have not run.' });
    }
    if (!it.local.worktree) this.state.current = id;
    this.saveState();
    const filesOut = {};
    for (const [rel, content] of Object.entries(material.files)) {
      const s = typeof content === 'string' ? content : JSON.stringify(content);
      filesOut[rel] = s.length <= 4000 ? s : `${s.slice(0, 4000)}…[full copy in .git/mtm-team/items/${id}/files/${rel}]`;
    }
    // Files Start Work ships are not reference reading: an organizer sends a check runner together
    // with the official QA data, and the item is graded on ITS output. A team that writes its own
    // equivalent produces numbers that cannot match the expected results, and loses the item while
    // believing it passed. So name the files on disk, and point at the ones that look runnable.
    const providedFiles = {};
    const providedRunners = [];
    if (this.stateDir) {
      for (const rel of Object.keys(material.files)) {
        const abs = path.join(this.stateDir, 'items', id, 'files', rel);
        if (!fs.existsSync(abs)) continue;
        providedFiles[rel] = abs;
        if (/(run[-_]?checks?|runner|verify|validate|check)[\w.-]*\.(mjs|cjs|js|ts|ps1|sh|py)$/i.test(rel)) providedRunners.push(abs);
      }
    }
    const now = this.now();
    const { left, by } = effectiveLeft(it, now, this.match.endsAt);
    return this.clean({
      ok: true, id, type: it.type, replay: material.replay, httpStatus: r.httpStatus,
      title: it.title || null, maxPoints: it.maxPoints ?? null, timeLeftMin: left == null ? null : minutes(left * 60000), timeLeftBy: by,
      description: it.description ? truncate(it.description, 10000) : (textBlockFor(this.lastPageText || '', id) ? truncate(textBlockFor(this.lastPageText || '', id), 6000) : null),
      startInstruction: material.startInstruction,
      submitTemplate: material.submitTemplate,
      minimumVerificationScenarios: material.minimumVerificationScenarios,
      requiredScenarios: required,
      files: filesOut,
      providedFiles,
      providedRunners,
      providedRunnersNote: providedRunners.length
        ? 'Run these exactly as shipped and keep their output as the evidence. They load the official QA data; your own script or data cannot produce the expected results.'
        : undefined,
      answer: answer ? { submitJson: answer.submitJson, evidenceDir: answer.evidenceDir, created: answer.created, refsLookLike: 'evidence/<file>' } : { note: 'matchRoot not found; create answers/<ID>/submit.json from submitTemplate yourself' },
      playbook: `.agents/skills/${PLAYBOOK[it.type] || 'backlog-task'}/SKILL.md`,
      stackSkill: this.stackSkill ? `.agents/skills/${this.stackSkill}/SKILL.md` : null,
      appPath: this.appPath || null,
      notesFile,
      checklist: checklist.steps,
      acceptanceCriteria: checklist.criteria,
      requiredScenarioNames: checklist.scenarios,
      checklistFile,
      next: 'Work the checklist in order. Fill the contract (outcome, MVS + hidden scenarios, scope), implement, test, then point every acceptance criterion at the evidence that proves it. Report BACKLOG_TESTS RUNNING/PASSED/FAILED with real counts.',
      alerts: this.view().alerts,
    });
  }

  /** Phase/status reasons that forbid any submission request, new or replayed. */
  submitGateErrors() {
    const errors = [];
    if (this.phase !== 'GAME') errors.push(`phase is ${this.phase}: submissions only during the game`);
    if (this.match.status === 'PAUSED') errors.push('match is PAUSED: submissions are refused by default');
    if (this.match.status === 'FINISHED') errors.push('match is FINISHED / time over');
    return errors;
  }

  /**
   * Before every Start/Submit retry: re-read the official match status (a 5xx or a dropped connection is
   * often the moment the match pauses or ends), then apply the same gate as a first send. Returns a
   * reason to stop, or null to retry. A MATCH_PAUSED/MATCH_ENDED input that arrived meanwhile counts too.
   */
  async retryGate() {
    if (!this.submitGateErrors().length) await this.withLock(() => this.doRefresh({ reason: 'status-check' })).catch(() => null);
    const errors = this.submitGateErrors();
    return errors.length ? errors.join('; ') : null;
  }

  /**
   * The API answers MATCH_NOT_ACCEPTING_SUBMISSIONS both while the match is paused and after it ended.
   * Read the official match page before concluding anything; an unconfirmed state never becomes FINISHED.
   * Returns 'PAUSED' | 'FINISHED' | 'UNCONFIRMED'.
   */
  async recheckMatchStatus() {
    const r = await this.withLock(() => this.doRefresh({ reason: 'status-check' })).catch((e) => ({ ok: false, error: e.message }));
    const s = this.match.status;
    if (r.ok && (s === 'PAUSED' || s === 'FINISHED')) return s;
    return 'UNCONFIRMED';
  }

  notAcceptingHint(status) {
    if (status === 'PAUSED') return 'The official match page says PAUSED: nothing was accepted. Stop start/submit/push, keep local work, follow MATCH_PAUSED_V1 / RESUME_GAME_V1 from mtm-player (wait_for_update meanwhile).';
    if (status === 'FINISHED') return 'The official match page says FINISHED: final_result end=true.';
    return 'The server is not accepting submissions right now (pause or end) and the match page did not confirm which. Nothing was accepted. Do not end the match on this alone: call wait_for_update and follow the status it shows.';
  }

  async preflight(id, gitRevision, opts = {}) {
    const errors = [];
    const warnings = [];
    let touchedBaseline = { revision: null, tests: [], migrations: [] };
    const it = this.items.get(id);
    errors.push(...this.submitGateErrors());
    if (!it) errors.push(`${id} is unknown: refresh_match`);
    else {
      if (!it.local?.startedAt) errors.push(`${id} was not started: call start_work first`);
      if (isSubmitted(it)) errors.push(`${id} is already submitted (receipt ${it.local?.receiptId || 'from server'}); one submission per item`);
      if (isClosed(it, this.now() - 30000)) errors.push(`${id} is closed or past its deadline`);
    }
    const cwd = this.checkoutRoot;
    const sha = (gitRevision && gitRevision !== 'HEAD' ? String(gitRevision).trim().toLowerCase() : await G.revParse(cwd, 'HEAD')) || '';
    if (!SHA_RE.test(sha)) errors.push(`gitRevision must be a full 40/64-hex SHA (got "${sha}")`);
    let answer = null;
    let check = { errors: [], warnings: [], evidenceRefs: [] };
    if (SHA_RE.test(sha)) {
      if (!(await G.revParse(cwd, sha))) errors.push(`commit ${sha} does not exist locally`);
      else {
        const pushed = await G.pushedState(cwd, sha, this.repository.branch);
        if (!pushed.pushed) errors.push(`commit ${sha.slice(0, 12)} is not on origin/${this.repository.branch}: ${pushed.reason || 'push it first'}`);
        const folder = this.repository.folder;
        const rel = `${folder}/answers/${id}/submit.json`;
        const raw = await G.fileAt(cwd, sha, rel);
        if (raw == null) errors.push(`${rel} is not in commit ${sha.slice(0, 12)}: commit the answer together with the code`);
        else {
          try {
            answer = JSON.parse(raw.replace(/^\uFEFF/, ''));
            const schemaPath = `challenge/${id}-submit.schema.json`;
            const delivered = this.readMaterial(id)?.files?.[schemaPath];
            const schemaRaw = delivered ?? await G.fileAt(cwd, sha, `${folder}/${schemaPath}`);
            if (schemaRaw != null) {
              try {
                const schema = typeof schemaRaw === 'string' ? JSON.parse(schemaRaw) : schemaRaw;
                errors.push(...validate(schema, answer).map((error) => `${schemaPath}: ${error}`));
              } catch (e) {
                errors.push(`${schemaPath}: cannot validate organizer schema: ${e.message}`);
              }
            }
          } catch (e) {
            errors.push(`${rel} is not valid JSON: ${e.message}`);
          }
        }
        if (answer) {
          check = checkAnswer(answer, id, it?.type || id.split('-')[0]);
          if (opts.allowNoEvidence) check.errors = check.errors.filter((e) => !/needs MVS evidence/.test(e));
          errors.push(...check.errors);
          warnings.push(...check.warnings);
          for (const ref of check.evidenceRefs) {
            if (!(await G.existsAt(cwd, sha, `${folder}/answers/${id}/${ref}`))) errors.push(`evidence file ${ref} is not in commit ${sha.slice(0, 12)} (expected ${folder}/answers/${id}/${ref})`);
          }
        }
        // Compare against the revision the match started from, not the moving branch head.
        const baseline = this.environmentRevision || this.state.envReady?.revision;
        const guarded = await guardBaseline({ cwd, folder, sha, baseline, answer });
        const { errors: guardErrors, ...touched } = guarded;
        touchedBaseline = touched;
        errors.push(...guardErrors);
        const base = guarded.revision;
        if (base) {
          const changed = (await G.git(cwd, ['diff', '--name-only', `${base}...${sha}`, '--', folder])).stdout.split('\n').filter(Boolean);
          const forbidden = changed.filter((f) => new RegExp(`^${folder}/(exam-info\\.json|env-require/|challenge/)`).test(f));
          if (forbidden.length) errors.push(`the commit changes files that must stay untouched: ${forbidden.slice(0, 4).join(', ')} (revert them: git checkout ${base.slice(0, 12)} -- <path>, then commit again)`);
          const junk = changed.filter((f) => /(^|\/)(\.env(\.|$)|node_modules\/|\.next\/|dist\/|coverage\/)/.test(f));
          if (junk.length) warnings.push(`the commit includes local/build files: ${junk.slice(0, 4).join(', ')}`);
        }
        for (const bad of [`${folder}/evidence`, `${folder}/challenge/evidence`]) {
          if (await G.existsAt(cwd, sha, bad)) errors.push(`${bad}/ exists in the commit: evidence belongs only in ${folder}/answers/<ID>/evidence/ — move it (git mv) and recommit`);
        }
        const dirty = await G.statusPorcelain(cwd, `${folder}/answers/${id}`);
        if (dirty?.length) warnings.push(`uncommitted changes under answers/${id}: they will NOT be submitted (${dirty.slice(0, 3).join(', ')})`);
      }
    }
    // Verification gate. Across agentic coding work the bottleneck is not writing the change, it is
    // proving it; an item submitted without the suite having run is the single cheapest way to lose
    // points. So "tests ran and passed" is a refusal, not a warning. opts.allowUntested is the escape
    // hatch for an item that genuinely has no runnable test (a pure UI tweak): it downgrades to a
    // warning and the reason is recorded in the log.
    const tests = this.lastTests?.[id];
    const testErrors = [];
    if (it && SHA_RE.test(sha)) {
      if (!tests || tests.status === 'NOT_RUN') testErrors.push(`no test run reported for ${id}: run the suite and report BACKLOG_TESTS before submitting`);
      else if (tests.status === 'RUNNING') testErrors.push(`the last BACKLOG_TESTS for ${id} is still RUNNING: report the final counts first`);
      else if (tests.status === 'FAILED') testErrors.push(`the last BACKLOG_TESTS for ${id} is FAILED (${tests.failed} failing): fix it or submit a different item`);
      else if (tests.executed === 0) testErrors.push(`BACKLOG_TESTS for ${id} reports 0 tests executed: that is not a test run`);
      const folder = this.repository.folder;
      // Any referenced evidence file may carry the run output; judge by content, not by file name.
      let found = null;
      let placeholder = null;
      for (const ref of (check.evidenceRefs || []).slice(0, 8)) {
        const body = await G.fileAt(cwd, sha, `${folder}/answers/${id}/${ref}`);
        if (body == null) continue;
        if (/\bNOT_RUN\b/.test(body)) placeholder = ref;
        if (looksLikeTestOutput(body)) { found = ref; break; }
      }
      if (!found) {
        testErrors.push(placeholder
          ? `${placeholder} still says NOT_RUN and no other evidence holds a test run: paste the real output (evidence/test.log) and reference it from submit.json`
          : 'no evidence file holds the output of a test run: save the full command output as evidence/test.log and reference it from submit.json');
      }
    }
    if (opts.allowUntested) warnings.push(...testErrors.map((e) => `allowUntested: ${e}`));
    else errors.push(...testErrors);
    // Parallel lanes have put one item's evidence into another item's folder before (a worker, or a
    // worktree integration, copying the whole evidence tree). The grader then reads a dependency
    // task illustrated with CSV screenshots. This is a warning, never a refusal: a wrong refusal
    // near the deadline costs the whole item, while a warning costs nothing and is usually right.
    try {
      const mine = path.join(this.matchRoot || '', 'answers', id, 'evidence');
      if (this.matchRoot && fs.existsSync(mine)) {
        const digest = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
        const mineFiles = new Map();
        for (const f of fs.readdirSync(mine)) { const d = digest(path.join(mine, f)); if (d) mineFiles.set(d, f); }
        const foreign = [];
        for (const other of fs.readdirSync(path.join(this.matchRoot, 'answers'))) {
          if (other === id) continue;
          const dir = path.join(this.matchRoot, 'answers', other, 'evidence');
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
          for (const f of fs.readdirSync(dir)) {
            const d = digest(path.join(dir, f));
            // Same bytes under both items, and not one of the per-run logs that legitimately repeat.
            if (d && mineFiles.has(d) && !/^(test|build|typecheck|install|audit)[\w.-]*\.(log|txt)$/i.test(f)) foreign.push(`${mineFiles.get(d)} (also in ${other})`);
          }
        }
        if (foreign.length >= 2) {
          warnings.push(`${foreign.length} evidence file(s) under answers/${id}/evidence are byte-identical to another item's evidence: ${foreign.slice(0, 3).join(', ')}. Remove what does not belong to ${id} before submitting - a grader reading someone else's screenshots counts against the evidence, and it usually means a worktree lane copied the wrong folder.`);
        }
      }
    } catch { /* an evidence cross-check must never block a submission */ }
    return { errors, warnings, sha, answer, touchedBaseline, evidenceRefs: check.evidenceRefs, testStatus: tests?.status || 'NOT_REPORTED' };
  }

  async submit_work(args = {}) {
    const id = String(args.backlogItemKey || '').trim();
    if (this.submissionsInFlight.has(id)) {
      return { ok: false, error: 'SUBMIT_IN_PROGRESS', next: `Wait for the running submit_work for ${id}, then replay without changing the commit.` };
    }
    this.submissionsInFlight.add(id);
    try {
      return await this.submitItem({ ...args, backlogItemKey: id });
    } finally {
      this.submissionsInFlight.delete(id);
    }
  }

  // At most 20s preflight + 60s submit (including retry refreshes) + 5s final refresh.
  // Only read-only waits may be abandoned. The POST itself finishes or aborts before
  // this method returns and releases the per-item lock.
  async submitItem({ backlogItemKey, gitRevision, dryRun = false, allowNoEvidence = false, allowUntested = false } = {}) {
    const id = String(backlogItemKey || '').trim();
    if (!this.bearer) return { ok: false, error: 'NO_BEARER' };
    if (!this.match.uuid) return { ok: false, error: 'MATCH_UUID_UNKNOWN' };
    const it = this.items.get(id);
    const rec = this.state.submissions[id];
    let body;
    let note = null;
    if (rec && ['PENDING', 'UNCERTAIN'].includes(rec.state)) {
      // A replay is a real network send: the phase/status gates and dryRun apply to it as well.
      const blocked = this.submitGateErrors();
      if (blocked.length || dryRun) {
        return this.clean({
          ok: !blocked.length, dryRun, refused: blocked.length > 0, errors: blocked, warnings: rec.warnings || [], gitRevision: rec.body.gitRevision,
          pendingSubmission: { clientSubmissionId: rec.body.clientSubmissionId, state: rec.state },
          next: blocked.length
            ? 'Nothing was sent. The unresolved submission is kept unchanged: replay it with submit_work once the match is IN_PROGRESS again (same body, same clientSubmissionId).'
            : 'Nothing was sent. submit_work without dryRun replays the unresolved submission with the identical body (same clientSubmissionId).',
        });
      }
      body = rec.body;
      note = `replaying the unresolved submission ${rec.body.clientSubmissionId} with the identical body (sha ${rec.body.gitRevision.slice(0, 12)})`;
    } else {
      let pf;
      try {
        pf = await until(this.preflight(id, gitRevision, { allowNoEvidence, allowUntested }), Date.now() + SUBMIT_LIMITS.preflightMs);
      } catch (e) {
        if (e.code !== 'DEADLINE_EXCEEDED') throw e;
        return { ok: false, error: 'PREFLIGHT_TIMEOUT', next: 'Nothing was sent. Retry submit_work with the same commit after checking local Git access.' };
      }
      if (pf.errors.length || dryRun) {
        return this.clean({ ok: !pf.errors.length, dryRun, refused: pf.errors.length > 0, errors: pf.errors, warnings: pf.warnings, gitRevision: pf.sha, touchedBaseline: pf.touchedBaseline, evidenceRefs: pf.evidenceRefs, next: pf.errors.length ? 'Fix every error, commit, push, then call submit_work again. Nothing was sent.' : 'Preflight passed: call submit_work without dryRun.' });
      }
      const answer = { ...pf.answer };
      if (Object.hasOwn(answer, 'gitRevision')) answer.gitRevision = pf.sha;
      body = { clientSubmissionId: uuid(), backlogItemKey: id, gitRevision: pf.sha, answer };
      this.state.submissions[id] = { state: 'PENDING', body, createdAt: nowIso(), warnings: pf.warnings };
      this.saveState();
      note = pf.warnings.length ? `warnings: ${pf.warnings.join(' | ')}` : null;
    }
    const url = operationUrl(this.apiBase, this.apiOperations, 'SUBMIT', this.match.uuid);
    const r = await submit({ url, bearer: this.bearer, allowedOrigins: this.allowedApiOrigins, body, log: this.apiLogger('SUBMIT', id), budgetMs: this.adapter.submit.retryBudgetMs, acceptedStatuses: this.adapter.submit.acceptedStatuses, beforeRetry: () => this.retryGate() });
    const record = this.state.submissions[id];
    if (r.outcome === 'ACCEPTED') {
      record.state = 'ACCEPTED';
      record.receipt = r.receipt;
      const item = this.items.get(id) || { id, type: id.split('-')[0], local: {} };
      item.local ||= {};
      item.local.receiptId = r.receipt.receiptId;
      item.local.revision = body.gitRevision;
      item.local.submittedAt = this.now();
      this.items.set(id, item);
      this.backlogStatus(id, 'SUBMITTED', 'Official acceptance receipt received; scoring pending.', { revision: body.gitRevision, receiptId: r.receipt.receiptId });
      if (this.state.current === id) this.state.current = null;
      this.saveState();
      const refreshed = await until(this.withLock(() => this.doRefresh()), Date.now() + SUBMIT_LIMITS.refreshMs).catch(() => null);
      return this.clean({ ok: true, outcome: 'SUBMITTED', receipt: r.receipt, replay: r.replay, gitRevision: body.gitRevision, note, refreshed: !!refreshed?.ok, view: this.view({ includeEvents: true }), next: 'Do not wait for grading. Take NEXT.' });
    }
    if (r.outcome === 'UNCERTAIN') {
      record.state = 'UNCERTAIN';
      record.lastError = r.error;
      this.saveState();
      if (r.halted) {
        return this.clean({ ok: false, outcome: 'UNCERTAIN', halted: r.halted, error: r.error, note, next: `Retries stopped (${r.halted}). The submission is kept unchanged (same clientSubmissionId and body): call submit_work for this item once the match is IN_PROGRESS again. Do not change the commit.` });
      }
      return this.clean({ ok: false, outcome: 'UNCERTAIN', error: r.error, note, next: 'Outcome unknown. Do not change the commit. Call submit_work again for this item: it replays the same clientSubmissionId and body.' });
    }
    // REJECTED
    const code = r.error?.code;
    record.state = code === 'ALREADY_SUBMITTED' ? 'ALREADY_SUBMITTED' : 'REJECTED';
    record.lastError = r.error;
    if (code === 'ALREADY_SUBMITTED' && it) {
      it.local.submittedAt ||= this.now();
      if (this.state.current === id) this.state.current = null;
    }
    if (code === 'BACKLOG_ITEM_CLOSED' && it) it.availability = 'CLOSED';
    const matchStatus = code === 'MATCH_NOT_ACCEPTING_SUBMISSIONS'
      ? await until(this.recheckMatchStatus(), Date.now() + SUBMIT_LIMITS.refreshMs).catch(() => 'UNCONFIRMED') : undefined;
    this.saveState();
    const hint = {
      BACKLOG_NOT_STARTED: 'Call start_work for this item, then submit_work again.',
      ALREADY_SUBMITTED: 'The server already holds a submission for this item: take NEXT.',
      BACKLOG_ITEM_CLOSED: 'The item closed: take NEXT.',
      VALIDATION_ERROR: 'Fix the body problem in details (answer/gitRevision), commit, push, submit again.',
      INVALID_SUBMISSION: 'Fix the field named in details and submit again.',
      PAYLOAD_TOO_LARGE: 'Shrink submit.json (move long text into evidence files) and submit again.',
      MATCH_NOT_ACCEPTING_SUBMISSIONS: this.notAcceptingHint(matchStatus),
    }[code] || 'Read the error; fix and submit again only if nothing was accepted.';
    return this.clean({ ok: false, outcome: 'REJECTED', httpStatus: r.httpStatus, error: r.error, matchStatus, next: hint });
  }

  // ---------- progress, readiness, results ----------
  report_progress({ event } = {}) {
    if (!event || typeof event !== 'object') return { ok: false, error: 'event object required (without schemaVersion/playerSessionId)' };
    if (!this.log) return { ok: false, error: 'NOT_CONFIGURED', next: this.nextHint() };
    const ev = { ...event };
    delete ev.schemaVersion;
    delete ev.playerSessionId;
    if (HELPER_ONLY_TYPES.has(ev.type)) return { ok: false, error: 'HELPER_OWNED', message: `${ev.type} is written by the helper (configure_session / report_ready / final_result / API calls).` };
    if (ev.type === 'PREPARATION_STATUS' && ev.stage === 'PREPARE_COMPLETE') return { ok: false, error: 'PLAYER_OWNED', message: 'PREPARE_COMPLETE belongs to mtm-player.' };
    if (ev.type === 'BACKLOG_STATUS' && ev.status === 'SUBMITTED') return { ok: false, error: 'HELPER_OWNED', message: 'SUBMITTED is logged by submit_work with the official receipt.' };
    if (ev.type === 'BACKLOG_STATUS' && ev.status === 'DISCOVERED') return { ok: false, error: 'HELPER_OWNED', message: 'DISCOVERED is logged by refresh_match.' };
    if (typeof ev.summary === 'string') ev.summary = oneLine(ev.summary);
    if (ev.type === 'BACKLOG_STATUS') {
      ev.title = ev.title ? oneLine(ev.title, 160) : this.titleOf(ev.backlogId);
      ev.revision ??= null;
      ev.receiptId ??= null;
    }
    if (ev.type === 'BLOCKER_OPENED') ev.backlogId ??= null;
    const ruleErrors = playerRuleErrors({ ...ev, schemaVersion: 1, playerSessionId: this.playerSessionId });
    if (ruleErrors.length) {
      return { ok: false, error: 'PLAYER_RULE', message: `mtm-player would ignore this event: ${ruleErrors.join('; ')}`, next: 'Report the real counts and try again.' };
    }
    try {
      const r = this.log.append(ev);
      if (ev.type === 'PREPARATION_STATUS') this.prep[ev.stage] = ev.status;
      if (ev.type === 'PREPARATION_STATUS' && ev.stage === 'REPOSITORY' && ev.status === 'COMPLETED' && this.checkoutRoot && fs.existsSync(path.join(this.checkoutRoot, '.git'))) {
        G.ensureExcluded(this.checkoutRoot, '/.mtm-notes/');
      }
      if (ev.type === 'BACKLOG_TESTS') {
        this.lastTests = { ...(this.lastTests || {}), [ev.backlogId]: ev };
        this.noteTestAttempt(ev);
      }
      if (ev.type === 'BACKLOG_STATUS' && this.items.get(ev.backlogId)) this.items.get(ev.backlogId).local.reported = ev.status;
      if (ev.type === 'BLOCKER_OPENED') this.blockers.set(ev.blockerId, { backlogId: ev.backlogId, summary: ev.summary });
      if (ev.type === 'BLOCKER_RESOLVED') this.blockers.delete(ev.blockerId);
      const stuck = ev.type === 'BACKLOG_TESTS' ? this.stuckAdvice(ev.backlogId) : null;
      return this.clean({ ok: true, queued: r.queued, stuck, next: stuck || undefined, alerts: this.view().alerts });
    } catch (e) {
      return { ok: false, error: 'SCHEMA', message: e.message };
    }
  }

  /**
   * Counts failing test rounds per item so a stuck agent is stopped by attempts, not only by the
   * clock. An agent that has failed the same way three times is not converging: a 12-minute time box
   * lets it burn the rest of the budget on the same wrong idea, while the item next to it is still
   * untouched. After STUCK_AFTER failures the planner and every tool result say so, and the advice
   * is to change approach or park the item — in a 40-minute match, parking a hard item early is
   * usually worth more than finishing it late.
   */
  noteTestAttempt(ev) {
    const it = this.items.get(ev.backlogId);
    if (!it) return;
    it.local ||= {};
    if (ev.status === 'FAILED') {
      it.local.failedRuns = (it.local.failedRuns || 0) + 1;
      // A different failure count means something moved; the same count twice means it did not.
      const sig = `${ev.failed}/${ev.executed}`;
      it.local.sameFailure = sig === it.local.lastFailureSig ? (it.local.sameFailure || 1) + 1 : 1;
      it.local.lastFailureSig = sig;
    } else if (ev.status === 'PASSED') {
      it.local.failedRuns = 0;
      it.local.sameFailure = 0;
      delete it.local.lastFailureSig;
    }
    this.saveState();
  }

  /** null, or an instruction to stop looping on this item. */
  stuckAdvice(id) {
    const it = this.items.get(id);
    const failed = it?.local?.failedRuns || 0;
    if (failed < RuntimeSession.STUCK_AFTER) return null;
    const same = (it.local.sameFailure || 0) >= 2 ? ' The failure has not changed between runs, so the current approach is not converging.' : '';
    return `${id} has failed its tests ${failed} times in a row.${same} Stop patching: re-read the acceptance criteria and the failing assertion, and either take a different approach or park this item (worktree park / move to the next item) and come back only if time is left.`;
  }

  async report_ready({ summary } = {}) {
    if (this.phase !== 'PREPARATION') return { ok: false, error: 'NOT_PREPARING', message: `phase is ${this.phase}` };
    const missing = ['GIT_AUTH', 'REPOSITORY', 'ENVIRONMENT', 'BUILD'].filter((s) => this.prep[s] !== 'COMPLETED');
    if (missing.length) return { ok: false, error: 'STAGES_NOT_COMPLETED', missing, message: 'Report each stage COMPLETED (report_progress PREPARATION_STATUS) only after real success.' };
    if (this.prep.MATCH_LOGIN !== 'COMPLETED') return { ok: false, error: 'LOGIN_NOT_VERIFIED', next: 'call login_match' };
    if (!this.portalReady) return { ok: false, error: 'MATCH_DATA_UNAVAILABLE', next: 'Call login_match and verify match status and UUID before reporting readiness.' };
    const head = await G.revParse(this.checkoutRoot, 'HEAD');
    if (!head) return { ok: false, error: 'NO_CHECKOUT', message: `no Git checkout at ${this.checkoutRoot}` };
    G.ensureExcluded(this.checkoutRoot, '/.mtm-notes/');
    const tracking = await G.remoteTrackingHead(this.checkoutRoot, this.repository.branch);
    if (tracking && tracking !== head) return { ok: false, error: 'REVISION_MISMATCH', message: `HEAD ${head.slice(0, 12)} differs from origin/${this.repository.branch} ${tracking.slice(0, 12)}: preparation must not commit or push; reset the branch to origin/${this.repository.branch}` };
    if (!fs.existsSync(this.matchRoot)) return { ok: false, error: 'MATCH_ROOT_MISSING', message: `${this.matchRoot} does not exist in the checkout` };
    // mtm-player reads every ENVIRONMENT_READY line in the file and fails with ENVIRONMENT_READY_CONFLICT
    // when two differ. Writing the same one twice is harmless; writing a different one breaks preparation.
    const wanted = { schemaVersion: 1, playerSessionId: this.playerSessionId, type: 'ENVIRONMENT_READY', requestId: safeId(this.prepareRequestId) || 'prepare', repository: { ...this.repository }, revision: head, build: 'PASS', matchLogin: 'PASS' };
    const previous = ProgressLog.read(this.progressLogFile).filter((e) => e.type === 'ENVIRONMENT_READY');
    const conflicting = previous.find((e) => JSON.stringify({ ...e }) !== JSON.stringify(wanted));
    if (conflicting) {
      return {
        ok: false, error: 'ENVIRONMENT_READY_CONFLICT',
        message: `the log already has a different ENVIRONMENT_READY (revision ${String(conflicting.revision).slice(0, 12)}, requestId ${conflicting.requestId}); mtm-player refuses a log with two different ones`,
        next: 'The checkout moved since the first readiness report. Reset the checkout to that revision (git checkout <revision>) and call report_ready again, or report BLOCKED to the operator.',
      };
    }
    if (previous.length) {
      this.state.envReady = { revision: head, requestId: wanted.requestId };
      const same = { schemaVersion: 1, status: 'SUBMITTED', backlogs: [], summary: oneLine(summary || `ENVIRONMENT_READY already logged for ${this.matchId} at ${head.slice(0, 12)}.`, 2000) };
      return { ok: true, revision: head, replay: true, final: same, reply: JSON.stringify(same), next: 'Readiness was already reported for this round. Reply with the `reply` JSON and end the turn.' };
    }
    const ok = this.event(wanted);
    if (!ok) return { ok: false, error: 'LOG_APPEND_FAILED', message: 'ENVIRONMENT_READY was not written; mtm-player has NOT received readiness. Fix the log problem and call report_ready again.', alerts: this.view().alerts };
    this.state.envReady = { revision: head, requestId: this.prepareRequestId };
    this.saveState();
    const fin = { schemaVersion: 1, status: 'SUBMITTED', backlogs: [], summary: oneLine(summary || `ENVIRONMENT_READY logged for ${this.matchId} at ${head.slice(0, 12)}; waiting for mtm-player START_GAME input.`, 2000) };
    return { ok: true, revision: head, final: fin, reply: JSON.stringify(fin), next: 'Preparation done. Reply with exactly the `reply` JSON and end the turn; START_GAME input will arrive as a new message.' };
  }

  finalResult({ status, summary, end = false } = {}) {
    const backlogs = [...this.items.values()].map((it) => ({
      backlogId: it.id, title: it.title || null, status: isSubmitted(it) ? 'SUBMITTED' : it.local?.startedAt ? 'IN_PROGRESS' : 'NOT_STARTED',
      revision: it.local?.revision || null, receiptId: it.local?.receiptId || null,
    })).slice(0, 64);
    const submitted = backlogs.filter((b) => b.status === 'SUBMITTED').length;
    const resultStatus = ['SUBMITTED', 'BLOCKED', 'FAILED'].includes(status) ? status : this.phase === 'PAUSED' ? 'BLOCKED' : submitted ? 'SUBMITTED' : 'BLOCKED';
    const final = { schemaVersion: 1, status: resultStatus, backlogs, summary: oneLine(summary || `${submitted}/${backlogs.length} backlog item(s) submitted with receipts.`, 2000) };
    const errs = validateFinalResult(final);
    let endNote = null;
    if (end) {
      // mtm-player rejects ORCHESTRATOR_ENDED COMPLETED while a blocker is still open.
      const open = [...this.blockers.keys()];
      let endStatus = ['COMPLETED', 'BLOCKED', 'FAILED'].includes(status) ? status : 'COMPLETED';
      if (endStatus === 'COMPLETED' && open.length) {
        endStatus = 'BLOCKED';
        endNote = `${open.length} blocker(s) still open (${open.join(', ')}): the log records ORCHESTRATOR_ENDED BLOCKED, because mtm-player rejects COMPLETED with an open blocker. Resolve them with report_progress BLOCKER_RESOLVED first if they are actually cleared.`;
      }
      if (!this.endedLogged) {
        this.event({ type: 'ORCHESTRATOR_ENDED', status: endStatus, summary: endStatus === 'COMPLETED' ? 'The match has ended; all activity has stopped.' : oneLine(summary || 'Stopped.') });
        this.endedLogged = true;
      }
      this.phase = 'ENDED';
      this.stopPoller();
      this.saveState();
    }
    return { ok: errs.length === 0, final, reply: JSON.stringify(final), schemaErrors: errs, ...(endNote ? { endNote } : {}) };
  }

  final_result(args = {}) {
    return this.clean(this.finalResult(args));
  }

  recon_repo() {
    if (!this.matchRoot || !fs.existsSync(this.matchRoot)) return { ok: false, error: 'NO_MATCH_ROOT', message: 'Check out the repository first.' };
    const map = recon(this.matchRoot);
    Object.assign(map, ensureRepoMap({ checkoutRoot: this.checkoutRoot, matchRoot: this.matchRoot, recon: map }));
    this.stackSkill = map.stackSkill || null;
    this.appPath = map.app?.path && map.app.path !== '.' ? path.join(this.matchRoot, map.app.path) : this.matchRoot;
    // Keep the commands: start_work names the real test command in each item's checklist.
    this.commands = { test: map.app?.test || null, typecheck: map.app?.typecheck || null, build: map.app?.build || null, oneTest: map.app?.oneTest || null };
    if (this.stateDir) writeJson(path.join(this.stateDir, 'repo-map.json'), map);
    this.state.recon = { stackSkill: this.stackSkill, appPath: this.appPath, commands: this.commands };
    this.saveState();
    return { ok: true, map, repoMapPath: map.repoMapPath, next: map.stackSkill ? `Read .agents/skills/${map.stackSkill}/SKILL.md once; run app commands from ${this.appPath}.` : undefined };
  }

  async recoveryReport() {
    const out = { started: [], pending: [], dirty: null, stashes: null };
    for (const it of this.items.values()) {
      if (it.local?.startedAt && !isSubmitted(it)) out.started.push(it.id);
    }
    for (const [id, rec] of Object.entries(this.state.submissions || {})) if (['PENDING', 'UNCERTAIN'].includes(rec.state)) out.pending.push(`${id}: unresolved submission ${rec.body.clientSubmissionId} — call submit_work for it to replay`);
    if (this.checkoutRoot && fs.existsSync(path.join(this.checkoutRoot, '.git'))) {
      out.dirty = (await G.statusPorcelain(this.checkoutRoot))?.slice(0, 20) || [];
      out.stashes = (await G.git(this.checkoutRoot, ['stash', 'list'])).stdout.split('\n').filter(Boolean).slice(0, 10);
      out.head = await G.revParse(this.checkoutRoot, 'HEAD');
    }
    out.current = this.state.current;
    return out;
  }

  async session_status() {
    return this.clean({
      ok: true, phase: this.phase, matchId: this.matchId, playerSessionId: this.playerSessionId, prep: this.prep, envReady: this.state.envReady,
      account: !!this.account, bearer: !!this.bearer, loggedIn: !!this.loggedIn, progressLogFile: this.progressLogFile, checkoutRoot: this.checkoutRoot, matchRoot: this.matchRoot,
      repository: this.repository, recovery: this.checkoutRoot ? await this.recoveryReport() : null, view: this.view({ includeEvents: true }),
    });
  }

  // ---------- parallel lane (worktrees) ----------
  /** Moves an untracked draft answers/<ID>/ from the main checkout into the worktree. Returns true if moved. */
  async moveDraftAnswer(id, wtMatchRoot) {
    if (!this.matchRoot || !this.checkoutRoot) return false;
    const from = answerPaths(this.matchRoot, id).dir;
    const to = answerPaths(wtMatchRoot, id).dir;
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    const rel = path.relative(this.checkoutRoot, from).split(path.sep).join('/');
    const tracked = (await G.git(this.checkoutRoot, ['ls-files', '--', rel])).stdout.trim();
    if (tracked) return false; // committed answers are already in the worktree's HEAD
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return true;
  }

  async worktree({ action, backlogItemKey, message } = {}) {
    const id = backlogItemKey;
    if (!this.checkoutRoot) return { ok: false, error: 'NOT_CONFIGURED' };
    const base = path.join(this.checkoutRoot, '.mtm-wt');
    if (action === 'list') {
      return { ok: true, worktrees: [...this.items.values()].filter((i) => i.local?.worktree).map((i) => ({ id: i.id, ...i.local.worktree })) };
    }
    const it = this.items.get(id);
    if (!it) return { ok: false, error: 'UNKNOWN_ITEM' };
    if (action === 'create') {
      if (!it.local?.startedAt || !this.readMaterial(id)) return { ok: false, error: 'NOT_STARTED', next: 'Call start_work before worktree create.' };
      const active = [...this.items.values()].filter((i) => i.local?.worktree && !isSubmitted(i)).length;
      if (active >= (this.adapter.parallel.maxWorkers || 2)) return { ok: false, error: 'TOO_MANY_WORKERS', message: `at most ${this.adapter.parallel.maxWorkers} parallel worktrees` };
      G.ensureExcluded(this.checkoutRoot, '/.mtm-wt/');
      const wtRoot = path.join(base, id);
      if (!fs.existsSync(wtRoot)) {
        const r = await G.worktreeAdd(this.checkoutRoot, wtRoot, `mtm-wt/${id}`, 'HEAD');
        if (r.code !== 0) return { ok: false, error: 'WORKTREE_FAILED', message: (r.stderr || r.stdout).trim().slice(0, 400) };
      }
      const wtMatchRoot = path.join(wtRoot, this.repository.folder);
      const brief = writeItemBrief({
        checkoutRoot: this.checkoutRoot, worktreeRoot: wtRoot, matchRoot: wtMatchRoot,
        item: { ...it, description: it.description || textBlockFor(this.lastPageText || '', id) || '' },
        material: this.readMaterial(id), commands: this.commands,
      });
      const linked = linkDependencies(this.matchRoot, wtMatchRoot, { envSuffix: `_wt_${id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}` });
      it.local.worktree = { worktreeRoot: wtRoot, matchRoot: wtMatchRoot, branch: `mtm-wt/${id}`, envIsolated: linked.some((l) => l.includes('TEST_DATABASE_URL')) };
      it.local.owner = 'team_feature_worker';
      if (this.state.current === id) this.state.current = null;
      // start_work before create leaves an untracked answers/<ID>/ in the main checkout: it would block
      // integrate (MAIN_DIRTY) or collide with the cherry-pick. The worktree owns the answer from now on.
      const movedDraftAnswer = await this.moveDraftAnswer(id, wtMatchRoot);
      if (it.local.startedAt) materializeAnswer(wtMatchRoot, id, this.readMaterial(id)?.submitTemplate ?? null);
      this.saveState();
      return {
        ok: true, worktreeRoot: wtRoot, checkoutRoot: wtRoot, folder: this.repository.folder, matchRoot: wtMatchRoot, linked, movedDraftAnswer, brief,
        answer: it.local.startedAt ? answerPaths(wtMatchRoot, id) : undefined,
        note: linked.some((l) => l.includes('TEST_DATABASE_URL')) ? 'This copy got its own TEST_DATABASE_URL (tests truncate between cases, so copies must not share one).' : undefined,
        next: `Spawn team_feature_worker with fork_turns:"none". Pass paths, not pasted material: item ${id}, checkoutRoot/worktreeRoot ${wtRoot}, folder ${this.repository.folder}, matchRoot ${wtMatchRoot}, briefFile ${brief.briefFile}, filesDir ${brief.filesDir}, and the returned answer paths. Add scope, test commands and a time box. The worker stays inside matchRoot and never delegates, commits, pushes or calls Game APIs.`,
      };
    }
    if (action === 'integrate') {
      const wt = it.local.worktree;
      if (!wt) return { ok: false, error: 'NO_WORKTREE' };
      const ident = await G.userIdentity(this.checkoutRoot);
      const c = await G.commitAll(wt.worktreeRoot, message || `${id}: implement`, ident);
      if (!c.ok && c.error !== 'nothing to commit') return { ok: false, error: 'COMMIT_FAILED', message: c.error };
      const sha = c.ok ? c.sha : await G.revParse(wt.worktreeRoot, 'HEAD');
      const mainDirty = (await G.statusPorcelain(this.checkoutRoot))?.filter((l) => !l.includes('.mtm-wt/')) || [];
      if (mainDirty.length) return { ok: false, error: 'MAIN_DIRTY', message: `commit or stash your own work in the main checkout first: ${mainDirty.slice(0, 5).join(', ')}`, worktreeCommit: sha };
      const p = await G.cherryPick(this.checkoutRoot, sha);
      if (!p.ok) return { ok: false, error: 'CONFLICT', conflicts: p.conflicts, message: p.error, worktreeCommit: sha, next: 'Cherry-pick aborted; main is unchanged. Resolve by hand (git cherry-pick <sha>, fix, git cherry-pick --continue) or redo the change in main.' };
      it.local.owner = 'orchestrator';
      return { ok: true, integratedSha: p.sha, next: `Run the tests for ${id} in the main checkout, report BACKLOG_TESTS, git push, then submit_work ${id}.` };
    }
    if (action === 'remove') {
      const wt = it.local.worktree;
      if (!wt) return { ok: true, removed: false };
      unlinkDependencies(wt.matchRoot);
      const r = await G.worktreeRemove(this.checkoutRoot, wt.worktreeRoot);
      delete it.local.worktree;
      this.saveState();
      return { ok: r.code === 0, removed: true, message: r.stderr.trim().slice(0, 300) || undefined };
    }
    return { ok: false, error: 'BAD_ACTION', message: 'action is create | integrate | remove | list' };
  }
}

/**
 * Per-worktree .env: the same app database, but a test database of its own. Suites that truncate
 * between cases destroy each other's data when two working copies share TEST_DATABASE_URL.
 */
function isolateEnvFile(file, suffix) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let changed = false;
    const out = text.replace(/^(\s*(?:export\s+)?)(TEST_DATABASE_URL|TEST_DB_NAME|TEST_DB_URL)(\s*=\s*)(.*)$/gm, (line, pre, key, eq, value) => {
      const quote = /^["']/.test(value.trim()) ? value.trim()[0] : '';
      const raw = value.trim().replace(/^["']|["']$/g, '');
      let next = raw;
      if (/^[a-z]+:\/\//i.test(raw)) {
        try {
          const u = new URL(raw);
          const db = u.pathname.replace(/^\//, '');
          if (!db || db.endsWith(suffix)) return line;
          u.pathname = `/${db}${suffix}`;
          next = u.toString();
        } catch {
          return line;
        }
      } else if (raw && !raw.endsWith(suffix)) next = `${raw}${suffix}`;
      else return line;
      changed = true;
      return `${pre}${key}${eq}${quote}${next}${quote}`;
    });
    if (changed) fs.writeFileSync(file, out);
    return changed;
  } catch {
    return false;
  }
}

/** Junction/symlink node_modules (ignored by Git) from the main checkout into a worktree. */
function linkDependencies(srcRoot, dstRoot, { envSuffix } = {}) {
  const linked = [];
  const visit = (rel, depth) => {
    if (depth > 3) return;
    const dir = path.join(srcRoot, rel);
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.name === 'node_modules') {
        const target = path.join(dstRoot, r);
        if (!fs.existsSync(target) && fs.existsSync(path.dirname(target))) {
          try {
            fs.symlinkSync(path.join(srcRoot, r), target, process.platform === 'win32' ? 'junction' : 'dir');
            linked.push(r);
          } catch { /* ignore */ }
        }
        continue;
      }
      if (['.next', 'dist', 'build', 'coverage', '.turbo'].includes(e.name)) continue;
      visit(r, depth + 1);
    }
  };
  visit('', 0);
  // Env files are per-copy: copy them, then give this copy its own test database.
  for (const dir of ['', ...new Set(linked.map((l) => path.dirname(l)).filter((d) => d !== '.'))]) {
    for (const f of ['.env', '.env.local', '.env.test', '.env.development.local', '.env.test.local']) {
      const rel = dir ? path.join(dir, f) : f;
      const from = path.join(srcRoot, rel);
      const to = path.join(dstRoot, rel);
      if (!fs.existsSync(path.dirname(to))) continue;
      try {
        // The env file may already be in the worktree (if it is tracked); isolate it either way.
        if (!fs.existsSync(to)) {
          if (!fs.existsSync(from)) continue;
          fs.copyFileSync(from, to);
        }
        linked.push(rel + (envSuffix && isolateEnvFile(to, envSuffix) ? ' (own TEST_DATABASE_URL)' : ''));
      } catch { /* ignore */ }
    }
  }
  return linked;
}

function unlinkDependencies(root) {
  const visit = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink() && e.name === 'node_modules') {
        try {
          fs.unlinkSync(p);
        } catch {
          try { fs.rmdirSync(p); } catch { /* ignore */ }
        }
      } else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') visit(p, depth + 1);
    }
  };
  visit(root, 0);
}
