import { API_DEFAULTS } from './gm-client.mjs';

export const PLANNER_DEFAULTS = {
  urgentMinutes: 12,
  // Below this many minutes left (item deadline or match end), an item not yet started is skipped.
  minFeasibleMinutes: { PI: 4, BUG: 5, CR: 8, TASK: 4 },
  // Rough minutes per item type. With ~10 items in 40 minutes not everything gets done,
  // so plain items are ranked by points per estimated minute. Tune from `mtm report`.
  estMinutes: { PI: 8, BUG: 6, TASK: 5, CR: 12 },
  // Time box: warn early enough to preserve time for another item. The alert is an
  // instruction to ship or park, never an invitation to keep debugging.
  budgetFactor: 1.5,
  // When time left (deadline or match end) on the item in progress drops to this, ship it.
  wrapUpMinutes: 5,
  // Smaller first when tiers and value tie: bugs are usually the quickest wins.
  typeOrder: { PI: 0, BUG: 1, TASK: 2, CR: 3 },
  // States in which a not-yet-started item can be started.
  actionableStates: ['OPEN', 'VISIBLE'],
  // States that may mean "shown but not open yet": ranked last only after the server refused a start.
  notOpenStates: ['VISIBLE'],
  // States that end an item for good, even when it was started.
  terminalStates: ['CLOSED', 'EXPIRED', 'CANCELLED', 'REMOVED'],
};

export function plannerOptions(options = {}) {
  return {
    ...PLANNER_DEFAULTS,
    ...options,
    minFeasibleMinutes: { ...PLANNER_DEFAULTS.minFeasibleMinutes, ...(options.minFeasibleMinutes || {}) },
    estMinutes: { ...PLANNER_DEFAULTS.estMinutes, ...(options.estMinutes || {}) },
    typeOrder: { ...PLANNER_DEFAULTS.typeOrder, ...(options.typeOrder || {}) },
    doneStatuses: options.doneStatuses || API_DEFAULTS.doneStatuses,
  };
}

/** Minutes until the item's own deadline (null when it has none). */
export function minutesLeft(item, serverNow) {
  return item.deadlineAt == null ? null : (item.deadlineAt - serverNow) / 60000;
}

/** Minutes the item really has: the earlier of its deadline and the match end. */
export function effectiveLeft(item, serverNow, matchEndsAt) {
  const d = minutesLeft(item, serverNow);
  const m = matchEndsAt ? (matchEndsAt - serverNow) / 60000 : null;
  if (d == null && m == null) return { left: null, by: null };
  if (d == null) return { left: m, by: 'match end' };
  if (m == null || d <= m) return { left: d, by: item.deadlineEstimated ? 'deadline (estimated)' : 'deadline' };
  return { left: m, by: 'match end' };
}

export function isDone(item, local = {}, o = plannerOptions()) {
  if (local.submittedAt) return true;
  if (item.result && ['PASSED', 'FAILED', 'GRADED', 'SCORED', ...o.doneStatuses].includes(item.result)) return true;
  return !!(item.submissionStatus && o.doneStatuses.includes(item.submissionStatus));
}

/**
 * Orders open work, most urgent first. Tiers:
 *  -1 started item that must ship before a PI would make it miss its deadline
 *   0 PI (a race; a PI already in progress before a new one)
 *   1 started, not submitted
 *   2 deadline within urgentMinutes: the set of urgent items worth most that still fits,
 *     in earliest-deadline order
 *   3 everything else by points per estimated minute
 *   3.5 "tight" (less time left than its estimate) or an urgent item that no longer fits
 *   6 parked, or start refused twice; 7 not open yet (a start was refused while not OPEN)
 */
export function rankItems(items, ledger = {}, serverNow = Date.now(), options = {}) {
  const o = plannerOptions(options);
  const matchLeft = o.matchEndsAt ? (o.matchEndsAt - serverNow) / 60000 : null;
  const est = (it) => o.estMinutes[it.type] ?? 8;
  const value = (r) => (Number(r.item.maxPoints) || 0) / est(r.item);
  const ranked = [];
  const skipped = [];
  // While a PI is in progress it keeps first place; the "finish first" guard is for the moment a PI arrives.
  const piInProgress = items.some((it) => it.type === 'PI' && ledger[it.id]?.startedAt && !isDone(it, ledger[it.id], o)
    && !(it.state && o.terminalStates.includes(it.state)));
  for (const item of items) {
    const local = ledger[item.id] || {};
    if (isDone(item, local, o)) continue;
    const started = !!local.startedAt;
    if (item.state && o.terminalStates.includes(item.state)) { skipped.push({ item, why: item.state }); continue; }
    if (!started && item.state && !o.actionableStates.includes(item.state)) { skipped.push({ item, why: item.state }); continue; }
    const left = minutesLeft(item, serverNow);
    if (left != null && left <= 0 && !item.deadlineEstimated) { skipped.push({ item, why: 'deadline passed' }); continue; }
    const eff = effectiveLeft(item, serverNow, o.matchEndsAt).left;
    const minNeeded = o.minFeasibleMinutes[item.type] ?? 4;
    if (!started && eff != null && eff < minNeeded) {
      skipped.push({ item, why: `only ${Math.max(0, eff).toFixed(1)}m left, not worth starting` });
      continue;
    }
    // A not-yet-open state (VISIBLE by default) is treated as workable until the server refuses
    // a start for it: the rules do not say when VISIBLE turns into OPEN.
    const notOpen = !started && o.notOpenStates.includes(item.state) && !!local.startRefusedAt;
    let tier;
    let why;
    if (notOpen) { tier = 7; why = `not open yet (${item.state}): a start was refused; retry when its state changes`; }
    else if (local.parkedAt) { tier = 6; why = `parked${local.parkReason ? `: ${local.parkReason}` : ''}; only when nothing else is left`; }
    else if (!started && (local.startRefusals || 0) >= 2) { tier = 6; why = 'start refused twice; only when nothing else is left'; }
    else if (item.type === 'PI') { tier = 0; why = started ? 'PI in progress, finish it' : 'PI race, rank decides points'; }
    else if (local.submitUncertainAt) { tier = 1; why = 'last submit uncertain: check mtm status; resubmit only if no submission is listed'; }
    // Only the item's own deadline counts here: the match end applies to a PI just the same.
    else if (started && !piInProgress && left != null && !item.deadlineEstimated && left >= 2 && left < est({ type: 'PI' }) + 2) {
      tier = -1; why = `finish first: ${left.toFixed(1)}m to its deadline`;
    }
    else if (started) { tier = 1; why = 'started, finish it'; }
    else if (left != null && left <= o.urgentMinutes) { tier = 2; why = `deadline in ${Math.max(0, left).toFixed(1)}m`; }
    else { tier = 3; why = `best points per minute (~${est(item)}m for ${item.maxPoints ?? '?'} pts)`; }
    if (!started && (tier === 2 || tier === 3) && eff != null && eff < est(item)) {
      tier = 3.5; why += `; tight: ${eff.toFixed(1)}m left vs ~${est(item)}m`;
    }
    ranked.push({ item, tier, left, eff, why, started, value: 0 });
  }
  for (const r of ranked) r.value = value(r);

  // Urgent tier: keep the most valuable set that still fits one after another in deadline order,
  // dropping the lowest points-per-minute item until everything left fits.
  let urgent = ranked.filter((r) => r.tier === 2).sort((a, b) => a.left - b.left);
  const fits = (list) => { let t = 0; return list.every((r) => { t += est(r.item); return t <= r.left; }); };
  while (urgent.length > 1 && !fits(urgent)) {
    const drop = urgent.reduce((lo, r) => (r.value < lo.value ? r : lo));
    drop.tier = 3.5;
    drop.why += '; would not fit with the other urgent items';
    urgent = urgent.filter((r) => r !== drop);
  }

  ranked.sort((a, b) =>
    a.tier - b.tier
    || (a.tier === 0 ? Number(b.started) - Number(a.started) : 0)
    || (a.tier === 2 ? a.left - b.left : 0)
    || (a.tier >= 3 && a.tier < 4 ? b.value - a.value : 0)
    || (Number(b.item.maxPoints) || 0) - (Number(a.item.maxPoints) || 0)
    || (o.typeOrder[a.item.type] ?? 9) - (o.typeOrder[b.item.type] ?? 9)
    || (a.item.revealedAt ?? 0) - (b.item.revealedAt ?? 0)
    || a.item.id.localeCompare(b.item.id));
  return { ranked, skipped, matchLeft };
}

/**
 * State-based alerts printed by every mtm command, so the agent sees them whatever it ran.
 * Orders (lines starting with "!!") are only given about the item the agent is working on now
 * (options.current); a stashed or parked item gets a plain note, so the agent never stashes its
 * current work under another item's name. No time-box alerts while the match is paused.
 */
export function computeAlerts(match, ledger = {}, options = {}, nowLocal = Date.now()) {
  const o = plannerOptions(options);
  const out = [];
  const serverNow = match.serverNow;
  const current = options.current || null;
  if (match.paused) out.push('!! MATCH PAUSED: keep coding and testing locally; do not start or submit; run mtm watch until RUNNING');
  for (const it of match.items) {
    const local = ledger[it.id] || {};
    if (isDone(it, local, o)) continue;
    const terminal = it.state && o.terminalStates.includes(it.state);
    const notOpen = o.notOpenStates.includes(it.state) && !!local.startRefusedAt;
    const piEff = effectiveLeft(it, serverNow, o.matchEndsAt).left;
    const piSkipped = piEff != null && piEff < (o.minFeasibleMinutes.PI ?? 4);
    if (it.type === 'PI' && !local.startedAt && !terminal && !notOpen && !piSkipped) {
      const ago = it.revealedAt ? ` ${((serverNow - it.revealedAt) / 60000).toFixed(1)}m ago` : '';
      out.push(`!! PI ${it.id} revealed${ago}, not started: follow NEXT (it says whether the current item ships first)`);
    }
    if (!local.startedAt) continue;
    const isCurrent = current === it.id;
    const left = minutesLeft(it, serverNow);
    if (terminal || (left != null && left <= 0 && !it.deadlineEstimated)) {
      if (!local.abandonNotified) {
        out.push(isCurrent
          ? `!! ABANDON ${it.id}: it is ${terminal ? it.state : 'past its deadline'} and cannot be submitted. Keep its changes out of the next item: git stash push -u -m "DEAD ${it.id}", then take NEXT`
          : `!! ABANDON ${it.id}: it is ${terminal ? it.state : 'past its deadline'}. It is not your current item: do not stash anything for it now; after the current item, drop its WIP/PARKED stash entry (git stash list, then git stash drop 'stash@{N}')`);
      }
      continue;
    }
    if (match.paused) continue;
    // An estimated deadline that has passed was extended by a pause: only the match end counts then.
    const { left: eff, by } = left != null && left <= 0 && it.deadlineEstimated
      ? effectiveLeft({ ...it, deadlineAt: null }, serverNow, o.matchEndsAt)
      : effectiveLeft(it, serverNow, o.matchEndsAt);
    if (!isCurrent) {
      if (!local.parkedAt && eff != null && eff <= o.wrapUpMinutes * 2) {
        out.push(`note: ${it.id} is waiting (not your current item) with ${Math.max(0, eff).toFixed(1)}m left (${by}); finish the current item first, then follow NEXT`);
      }
      continue;
    }
    if (eff != null && eff <= o.wrapUpMinutes) {
      out.push(`!! WRAP UP ${it.id}: ${Math.max(0, eff).toFixed(1)}m left (${by}). Stop adding scope: run evidence once, commit, push, submit`);
    } else if (it.type !== 'PI' && !local.parkedAt) {
      // Prefer the Game Master's clock. Local wall-clock time undercounts accelerated
      // rehearsals, which otherwise lets a task consume most of a virtual match before
      // its time-box fires. Fall back for older ledgers and hosts without server time.
      const serverSince = options.currentServerSince ?? local.startedServerAt;
      const serverSpent = serverNow != null && serverSince != null
        ? (local.activeServerMs || 0) + Math.max(0, serverNow - serverSince)
        : null;
      const since = options.currentSince || local.startedAt;
      const spent = (serverSpent ?? ((local.activeMs || 0) + Math.max(0, nowLocal - since))) / 60000;
      const budget = (o.estMinutes[it.type] ?? 8) * o.budgetFactor;
      if (spent > budget) {
        out.push(`!! OVER BUDGET ${it.id}: ${spent.toFixed(1)}m of work, budget ${budget}m. Stop changing code now. If evidence is already passing, commit/push/submit; otherwise immediately: git stash push -u -m "PARKED ${it.id}" then mtm park ${it.id}. Take NEXT.`);
      }
    }
  }
  return out;
}

function snap(item) {
  return {
    id: item.id, type: item.type, state: item.state, result: item.result,
    submissionStatus: item.submissionStatus, score: item.score, maxPoints: item.maxPoints,
    deadlineAt: item.deadlineAt, revealedAt: item.revealedAt, specHash: item.specHash, failReason: item.failReason,
  };
}

export function toSnapshot(match) {
  return { status: match.status, items: match.items.map(snap), endsAt: match.endsAt ?? null, offsetMs: match.offsetMs ?? 0, score: match.score ?? null };
}

const QUIET = new Set(['SUBMISSION', 'SCORE', 'HIDDEN']);

/** True when an event should wake an idle agent (grading noise does not). */
export function isLoud(e) {
  return !QUIET.has(e.kind);
}

/** Missing items count as withdrawn only when the match status did not change and the list is not empty. */
function hiddenBacklog(prev, cur) {
  if (!prev || !prev.items?.length) return false;
  const missing = prev.items.filter((p) => !cur.items.some((c) => c.id === p.id));
  return missing.length > 0 && (prev.status !== cur.status || cur.items.length === 0);
}

/** Events between two snapshots (prev may be null on the first look): { kind, id, text, edits? }. */
export function diffSnapshots(prev, cur) {
  const events = [];
  const ev = (kind, id, text, extra = {}) => events.push({ kind, id, text, ...extra });
  if (prev && prev.status !== cur.status) ev('MATCH', null, `MATCH ${prev.status} -> ${cur.status}`);
  const before = new Map((prev?.items || []).map((i) => [i.id, i]));
  for (const it of cur.items) {
    const p = before.get(it.id);
    before.delete(it.id);
    if (!p) {
      ev('NEW', it.id, `NEW ${it.id} ${it.type} ${it.maxPoints ?? '?'}pts${it.deadlineAt ? ' (has deadline)' : ''}`);
      continue;
    }
    if (p.state !== it.state) ev('STATE', it.id, `STATE ${it.id} ${p.state} -> ${it.state}`);
    const edits = [];
    if (p.specHash && it.specHash && p.specHash !== it.specHash) edits.push('spec');
    if (p.maxPoints !== it.maxPoints) edits.push('points');
    if ((p.deadlineAt ?? null) !== (it.deadlineAt ?? null) && !(p.deadlineAt && it.deadlineAt && Math.abs(p.deadlineAt - it.deadlineAt) < 30000)) edits.push('deadline');
    if (edits.length) ev('EDITED', it.id, `EDITED ${it.id} (${edits.join(', ')})`, { edits });
    if (p.submissionStatus !== it.submissionStatus && it.submissionStatus) ev('SUBMISSION', it.id, `SUBMISSION ${it.id} ${it.submissionStatus}`);
    if (p.result !== it.result && it.result) {
      ev('RESULT', it.id, `RESULT ${it.id} ${it.result}${it.score != null ? ` ${it.score}pts` : ''}${it.failReason ? ` (${String(it.failReason).slice(0, 160)})` : ''}`);
    } else if (p.score !== it.score && it.score != null) ev('SCORE', it.id, `SCORE ${it.id} ${it.score}pts`);
  }
  if (hiddenBacklog(prev, cur)) {
    ev('HIDDEN', null, `BACKLOG HIDDEN: ${before.size} items not listed right now (match ${cur.status}); nothing is treated as withdrawn`);
  } else {
    for (const [id] of before) ev('REMOVED', id, `REMOVED ${id} (no longer on the match page)`);
  }
  return events;
}

/** The snapshot to keep: while the backlog is hidden, remember the items that disappeared. */
export function nextSnapshot(prev, match) {
  const cur = toSnapshot(match);
  if (!hiddenBacklog(prev, cur)) return cur;
  const keep = prev.items.filter((p) => !cur.items.some((c) => c.id === p.id));
  return { ...cur, items: [...cur.items, ...keep] };
}
