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
  for (const it of items) {
    const l = it.local || {};
    if (isSubmitted(it) || isClosed(it, now) || l.worktree) continue;
    if (l.parked || l.notOpenRefused || ['LOCKED', 'HIDDEN', 'UPCOMING'].includes(it.availability)) {
      skipped.push({ id: it.id, why: l.parked ? 'parked: resume only when feasible' : 'not open yet' });
      continue;
    }
    const { left } = effectiveLeft(it, now, endsAt);
    const tier = it.type === 'PI' ? 0 : it.deadlineAt != null ? 1 : 2;
    const why = tier === 0 ? 'PI race: dispatch now, cap +1 allowed'
      : tier === 1 ? 'nearest deadline; reserve 5 minutes to integrate and submit'
      : String(it.maxPoints ?? '?') + ' pts / ~' + est(it) + 'm';
    ranked.push({ id: it.id, type: it.type, tier, why, left: left == null ? null : Math.round(left * 10) / 10,
      deadline: it.deadlineAt ?? Infinity, value: (Number(it.maxPoints) || 0) / est(it), started: !!l.startedAt, maxPoints: it.maxPoints ?? null });
  }
  ranked.sort((a, b) => a.tier - b.tier
    || (a.tier === 1 ? a.deadline - b.deadline : 0)
    || b.value - a.value || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { ranked: ranked.map(({ value, deadline, ...r }) => r), skipped };
}

/** Short orders/notes for the model. `current` = the most recently started item before dispatch. */
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
      if (l.startedAt && !isSubmitted(it) && isClosed(it, now) ) out.push(`!! ABANDON ${it.id}: closed/deadline passed, cannot be submitted. Stop its worker, preserve the commit and take NEXT.`);
      continue;
    }
    if (it.type === 'PI' && !l.startedAt) {
      const ago = it.revealedAt ? ` ${((now - it.revealedAt) / 60000).toFixed(1)}m ago` : '';
      out.push(`!! PI ${it.id} revealed${ago} and not started: it is a race. Dispatch a worker now; PI may exceed the worker cap by one.`);
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
      out.push(`${isCur ? '!!' : 'note:'} WRAP UP ${it.id}: ${Math.max(0, left).toFixed(1)}m left (${by}). Tell the worker to stop and return what passes; integrate and submit READY immediately.`);
      continue;
    }
    if (l.startedAt) {
      const spent = (now - l.startedAt) / 60000;
      const estM = o.estMinutes[it.type] ?? 10;
      if (it.type === 'PI' && spent > estM) out.push(`!! PI SPRINT ${it.id}: ${spent.toFixed(1)}m spent (target ${estM}m). Ship the verified fix now.`);
      else if (it.type !== 'PI' && spent > estM * o.budgetFactor) out.push(`!! OVER BUDGET ${it.id}: ${spent.toFixed(1)}m spent (budget ${(estM * o.budgetFactor).toFixed(0)}m). Submit what passes now, or park its worker and take NEXT.`);
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
