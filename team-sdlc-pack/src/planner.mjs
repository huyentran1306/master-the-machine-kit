// Work-order planner and time-box alerts, computed in code so the model does not spend tokens on it.
// Time always comes from the Game Master clock (HTTP Date header), never the local clock.

export const PLANNER_DEFAULTS = {
  estMinutes: { PI: 10, BUG: 10, TASK: 8, CR: 14 },
  minFeasibleMinutes: { PI: 4, BUG: 5, CR: 7, TASK: 4 },
  urgentMinutes: 12,
  wrapUpMinutes: 5,
  budgetFactor: 1.5,
  stuckAfter: 3, // failing test runs on one item before the planner says to change approach
  typeOrder: { PI: 0, BUG: 1, TASK: 2, CR: 3 },
};

export function plannerOptions(o = {}) {
  return {
    ...PLANNER_DEFAULTS,
    ...o,
    estMinutes: { ...PLANNER_DEFAULTS.estMinutes, ...(o.estMinutes || {}) },
    minFeasibleMinutes: { ...PLANNER_DEFAULTS.minFeasibleMinutes, ...(o.minFeasibleMinutes || {}) },
    typeOrder: { ...PLANNER_DEFAULTS.typeOrder, ...(o.typeOrder || {}) },
  };
}

const TERMINAL = new Set(['CLOSED', 'EXPIRED', 'REMOVED', 'CANCELLED']);

export function isSubmitted(it) {
  return !!(it.local?.receiptId || it.local?.submittedAt || ['SUBMITTED', 'GRADING', 'GRADED'].includes(it.teamStatus) || it.result);
}

export function isClosed(it, now) {
  return TERMINAL.has(it.availability) || (it.deadlineAt != null && it.deadlineAt <= now);
}

/** Minutes left for an item: the earlier of its deadline and the match end. */
export function effectiveLeft(it, now, endsAt) {
  const d = it.deadlineAt != null ? (it.deadlineAt - now) / 60000 : null;
  const m = endsAt ? (endsAt - now) / 60000 : null;
  if (d == null) return { left: m, by: m == null ? null : 'match end' };
  if (m == null || d <= m) return { left: d, by: 'deadline' };
  return { left: m, by: 'match end' };
}

/**
 * items: normalized items with .local { startedAt, submittedAt, receiptId, parked, startRefusals, notOpenRefused, owner }
 * Returns { ranked: [{ id, tier, why, left }], skipped: [{ id, why }] }.
 */
export function rank(items, now, endsAt, opts = {}) {
  const o = plannerOptions(opts);
  const est = (it) => o.estMinutes[it.type] ?? 10;
  const ranked = [];
  const skipped = [];
  const piActive = items.some((it) => it.type === 'PI' && it.local?.startedAt && !isSubmitted(it) && !isClosed(it, now));
  for (const it of items) {
    const l = it.local || {};
    if (isSubmitted(it)) continue;
    if (isClosed(it, now)) {
      if (l.startedAt) skipped.push({ id: it.id, why: `${it.availability || 'deadline passed'}: cannot be submitted any more` });
      continue;
    }
    const { left } = effectiveLeft(it, now, endsAt);
    const started = !!l.startedAt;
    if (!started && left != null && left < (o.minFeasibleMinutes[it.type] ?? 4)) {
      skipped.push({ id: it.id, why: `only ${Math.max(0, left).toFixed(1)}m left: not worth starting` });
      continue;
    }
    let tier;
    let why;
    const dl = it.deadlineAt != null ? (it.deadlineAt - now) / 60000 : null;
    if (l.notOpenRefused && !started) { tier = 7; why = 'server said not OPEN yet; retry when its state changes'; }
    else if (l.parked) { tier = 6; why = `parked${l.parkReason ? `: ${l.parkReason}` : ''}`; }
    else if (!started && (l.startRefusals || 0) >= 2) { tier = 6; why = 'start refused twice'; }
    else if (it.type === 'PI') { tier = 0; why = started ? 'PI in progress: finish it' : 'PI race: points decay with finishing rank'; }
    else if (started && !piActive && dl != null && dl >= 2 && dl < est({ type: 'PI' }) + 2) { tier = -1; why = `finish first: ${dl.toFixed(1)}m to its deadline`; }
    else if (started) { tier = 1; why = l.owner && l.owner !== 'orchestrator' ? `in progress (${l.owner})` : 'in progress: finish it'; }
    else if (dl != null && dl <= o.urgentMinutes) { tier = 2; why = `deadline in ${Math.max(0, dl).toFixed(1)}m`; }
    else { tier = 3; why = `${it.maxPoints ?? '?'} pts / ~${est(it)}m`; }
    const minF = o.minFeasibleMinutes[it.type] ?? 4;
    const tightAt = tier === 2 ? Math.max(minF + 2, est(it) * 0.6) : est(it);
    if (!started && (tier === 2 || tier === 3) && left != null && left < tightAt) {
      tier = 3.5;
      why += `; tight (${left.toFixed(1)}m left)`;
    }
    ranked.push({ id: it.id, type: it.type, tier, why, left: left == null ? null : Math.round(left * 10) / 10, value: (Number(it.maxPoints) || 0) / est(it), started, maxPoints: it.maxPoints ?? null });
  }
  ranked.sort((a, b) => a.tier - b.tier
    || (a.tier === 0 ? Number(b.started) - Number(a.started) : 0)
    || (a.tier === 2 ? (a.left ?? 1e9) - (b.left ?? 1e9) : 0)
    || (a.tier >= 3 && a.tier < 4 ? b.value - a.value : 0)
    || (b.maxPoints || 0) - (a.maxPoints || 0)
    || (o.typeOrder[a.type] ?? 9) - (o.typeOrder[b.type] ?? 9)
    || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { ranked: ranked.map(({ value, ...r }) => r), skipped };
}

/** Short orders/notes for the model. `current` = the item the orchestrator is working on. */
export function alerts(items, now, endsAt, { current, paused, status } = {}, opts = {}) {
  const o = plannerOptions(opts);
  const out = [];
  if (status === 'FINISHED') return ['!! MATCH FINISHED: stop all work, call final_result with end=true, then reply with its JSON.'];
  if (paused || status === 'PAUSED') out.push('!! MATCH PAUSED: no start/submit; keep local work safe; wait_for_update until IN_PROGRESS.');
  if (endsAt) {
    const m = (endsAt - now) / 60000;
    if (m <= 6 && m > 0) out.push(`!! ${m.toFixed(1)}m left in the match: ship what is tested now; start nothing new that cannot finish.`);
  }
  for (const it of items) {
    const l = it.local || {};
    if (isSubmitted(it) || isClosed(it, now)) {
      if (l.startedAt && !isSubmitted(it) && isClosed(it, now) && it.id === current) out.push(`!! ABANDON ${it.id}: closed/deadline passed, cannot be submitted. Stash its changes (git stash push -u -m "DEAD ${it.id}") and take NEXT.`);
      continue;
    }
    if (it.type === 'PI' && !l.startedAt) {
      const ago = it.revealedAt ? ` ${((now - it.revealedAt) / 60000).toFixed(1)}m ago` : '';
      out.push(`!! PI ${it.id} revealed${ago} and not started: it is a race. Commit-or-stash current work and start it now (unless NEXT says finish-first).`);
    }
    if (!l.startedAt || paused) continue;
    // Attempt-based, alongside the time boxes below: three failing runs on one item means the
    // approach is wrong, and that can happen well inside the time budget.
    if ((l.failedRuns || 0) >= (o.stuckAfter ?? 3)) {
      const same = (l.sameFailure || 0) >= 2 ? ' (same failure each time)' : '';
      out.push(`${it.id === current ? '!!' : 'note:'} STUCK ${it.id}: ${l.failedRuns} failing test runs${same}. Change approach or park it; do not patch a fourth time.`);
    }
    const { left, by } = effectiveLeft(it, now, endsAt);
    const isCur = it.id === current;
    if (left != null && left <= o.wrapUpMinutes) {
      out.push(`${isCur ? '!!' : 'note:'} WRAP UP ${it.id}: ${Math.max(0, left).toFixed(1)}m left (${by}). Stop adding scope; evidence, commit, push, submit.`);
      continue;
    }
    if (isCur && l.startedAt) {
      const spent = (now - l.startedAt) / 60000;
      const estM = o.estMinutes[it.type] ?? 10;
      if (it.type === 'PI' && spent > estM) out.push(`!! PI SPRINT ${it.id}: ${spent.toFixed(1)}m spent (target ${estM}m). Ship the verified fix now.`);
      else if (it.type !== 'PI' && spent > estM * o.budgetFactor) out.push(`!! OVER BUDGET ${it.id}: ${spent.toFixed(1)}m spent (budget ${(estM * o.budgetFactor).toFixed(0)}m). Submit what passes now, or stash + park it and take NEXT.`);
    }
  }
  return out;
}

/** Diff two snapshots (Map id->item summary) into short event strings. */
export function diffItems(prev, cur) {
  const ev = [];
  const before = new Map(prev || []);
  for (const [id, it] of cur) {
    const p = before.get(id);
    before.delete(id);
    if (!p) {
      ev.push({ kind: 'NEW', id, text: `NEW ${id} ${it.type} ${it.maxPoints ?? '?'}pts${it.deadlineAt ? ' (deadline)' : ''}: ${it.title || ''}`.trim() });
      continue;
    }
    if (p.availability !== it.availability && it.availability) ev.push({ kind: 'STATE', id, text: `STATE ${id} ${p.availability || '?'} -> ${it.availability}` });
    if (p.specHash && it.specHash && p.specHash !== it.specHash) ev.push({ kind: 'EDITED', id, text: `EDITED ${id}: title/points/deadline/description changed; re-read it` });
    if (p.result !== it.result && it.result) ev.push({ kind: 'RESULT', id, text: `RESULT ${id} ${it.result}${it.score != null ? ` ${it.score}pts` : ''}` });
  }
  for (const [id] of before) ev.push({ kind: 'REMOVED', id, text: `REMOVED ${id} (no longer on the match page)` });
  return ev;
}
