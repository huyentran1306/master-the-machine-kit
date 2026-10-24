// Read-only rehearsal analytics. The player records server-clock observations through mtm;
// the coach reads only .mtm state and never contacts Game Master itself.

const asMs = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(n) ? n : null;
};

const median = (xs) => {
  const values = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

const typeOf = (id) => String(id || '').split('-')[0] || 'UNKNOWN';

function itemRow(item, local, estimates) {
  const type = item.type || local.type || typeOf(item.id);
  const revealAt = asMs(item.revealedAt);
  const deadlineAt = asMs(item.deadlineAt);
  // These are server-clock timestamps captured by mtm at the actual Start/submit calls.
  // Older ledgers do not have them, and must not compare local wall time to a scaled mock clock.
  const startedAt = Number.isFinite(local.startedServerAt) ? local.startedServerAt : null;
  const submittedAt = Number.isFinite(local.submittedServerAt) ? local.submittedServerAt : null;
  const responseMin = revealAt != null && startedAt != null ? (startedAt - revealAt) / 60000 : null;
  const workMin = startedAt != null && submittedAt != null ? (submittedAt - startedAt) / 60000 : null;
  const slackMin = deadlineAt != null && submittedAt != null ? (deadlineAt - submittedAt) / 60000 : null;
  const evidence = local.evidence || [];
  const passingEvidence = evidence.filter((run) => run.exit === 0 && !run.timedOut).length;
  return {
    id: item.id,
    type,
    maxPoints: item.maxPoints ?? 0,
    result: item.result || (local.submittedAt ? 'SUBMITTED' : local.parkedAt ? 'PARKED' : local.startedAt ? 'IN PROGRESS' : 'NOT STARTED'),
    score: item.score ?? null,
    revealAt,
    deadlineAt,
    startedAt,
    submittedAt,
    responseMin,
    workMin,
    slackMin,
    estimatedMin: estimates[type] ?? null,
    evidenceRuns: evidence.length,
    passingEvidence,
    reviewed: (local.reviews || []).length > 0,
    startRefusals: local.startRefusals || 0,
    submitRejections: local.submitRejections || 0,
  };
}

/** Build a coaching view without inferring measurements that the ledger did not record. */
export function buildCoachReport({ match = {}, ledger = {}, snapshot = {}, hookProbe = null, estimates = {} }) {
  const itemMap = new Map((snapshot.items || []).map((item) => [item.id, item]));
  for (const [id, local] of Object.entries(ledger)) {
    if (id === 'BASELINE' || itemMap.has(id)) continue;
    itemMap.set(id, { id, type: local.type || typeOf(id) });
  }
  const items = [...itemMap.values()].map((item) => itemRow(item, ledger[item.id] || {}, estimates))
    .filter((item) => item.id && item.id !== 'BASELINE').sort((a, b) => a.id.localeCompare(b.id));
  const visiblePoints = items.reduce((total, item) => total + Number(item.maxPoints || 0), 0);
  const earnedPoints = items.reduce((total, item) => total + Number(item.score || 0), 0);
  const submitted = items.filter((item) => item.submittedAt != null || ['PASSED', 'FAILED', 'SUBMITTED'].includes(item.result));
  const failed = items.filter((item) => item.result === 'FAILED');
  const late = items.filter((item) => item.slackMin != null && item.slackMin < 0);
  const evidenceGaps = items.filter((item) => ['BUG', 'CR'].includes(item.type) && submitted.includes(item) && item.passingEvidence === 0);
  const reviewGaps = items.filter((item) => ['BUG', 'CR'].includes(item.type) && submitted.includes(item) && !item.reviewed);
  const timing = items.filter((item) => item.workMin != null && item.estimatedMin != null).map((item) => ({
    ...item,
    deviation: Math.abs(item.workMin - item.estimatedMin) / item.estimatedMin,
  }));
  const baselinePass = (ledger.BASELINE?.evidence || []).some((run) => run.exit === 0 && !run.timedOut);
  const gates = [
    { label: 'Baseline test', pass: baselinePass, detail: baselinePass ? 'passing evidence recorded' : 'run MTM evidence BASELINE first' },
    { label: 'Ready sent', pass: !!match.readyAt, detail: match.readyAt ? 'Game Master acknowledged readiness' : 'MTM ready has not succeeded' },
    { label: 'Hooks observed', pass: !!hookProbe?.event, detail: hookProbe?.event ? `${hookProbe.event} observed in this match` : 'trust MTM hooks, then run a Codex turn' },
    { label: 'No submit failure', pass: failed.length === 0, detail: failed.length ? `${failed.map((item) => item.id).join(', ')} failed` : 'no failed submission observed' },
    { label: 'No missed deadline', pass: late.length === 0, detail: late.length ? `${late.map((item) => item.id).join(', ')} submitted late` : 'no late submission observed' },
    { label: 'CR/BUG proof', pass: evidenceGaps.length === 0 && reviewGaps.length === 0,
      detail: evidenceGaps.length || reviewGaps.length
        ? `${[...evidenceGaps, ...reviewGaps].map((item) => item.id).filter((id, index, xs) => xs.indexOf(id) === index).join(', ')} lacks evidence or review`
        : 'every submitted CR/BUG has evidence and review' },
  ];
  const final = String(snapshot.status || '').toUpperCase() === 'FINISHED';
  const scoreRate = visiblePoints ? earnedPoints / visiblePoints : null;
  const timingStable = timing.length >= 2 && median(timing.map((item) => item.deviation)) <= 0.3;
  const finalReady = final && gates.every((gate) => gate.pass) && (scoreRate == null || scoreRate >= 0.8) && timingStable;
  const status = final ? (finalReady ? 'READY TO COMPETE' : 'TRAIN AGAIN') : 'COLLECTING REHEARSAL DATA';
  const reasons = final
    ? [
      ...gates.filter((gate) => !gate.pass).map((gate) => `${gate.label}: ${gate.detail}`),
      ...(scoreRate != null && scoreRate < 0.8 ? [`points: ${(scoreRate * 100).toFixed(0)}% of visible points; target 80%`] : []),
      ...(!timingStable ? ['timing: need at least two completed items with median deviation ≤30% from the plan'] : []),
    ]
    : ['Run a full rehearsal; the coach will grade readiness only after MATCH FINISHED.'];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    matchId: match.matchId || null,
    matchStatus: snapshot.status || 'UNKNOWN',
    status,
    reasons,
    gates,
    items,
    visiblePoints,
    earnedPoints,
    scoreRate,
    timing,
    summary: { submitted: submitted.length, visible: items.length, failed: failed.length, late: late.length },
  };
}

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const min = (value) => value == null ? '—' : `${value.toFixed(1)}m`;

/** Standalone report: it is intentionally data-only and never fetches Game Master. */
export function renderCoachHtml(report) {
  const allTimes = report.items.flatMap((item) => [item.revealAt, item.startedAt, item.submittedAt, item.deadlineAt]).filter(Number.isFinite);
  const left = allTimes.length ? Math.min(...allTimes) : 0;
  const right = allTimes.length > 1 ? Math.max(...allTimes) : left + 1;
  const span = Math.max(right - left, 1);
  const gateRows = report.gates.map((gate) => `<li class="${gate.pass ? 'pass' : 'gap'}"><b>${gate.pass ? 'PASS' : 'GAP'}</b><span>${esc(gate.label)}</span><small>${esc(gate.detail)}</small></li>`).join('');
  const lanes = report.items.map((item) => {
    const at = (time) => time == null ? null : Math.max(0, Math.min(100, ((time - left) / span) * 100));
    const reveal = at(item.revealAt); const start = at(item.startedAt); const submit = at(item.submittedAt); const deadline = at(item.deadlineAt);
    const bar = start != null && submit != null ? `<i class="work" style="left:${start}%;width:${Math.max(1, submit - start)}%"></i>` : '';
    const marker = (kind, value, title) => value == null ? '' : `<i class="marker ${kind}" style="left:${value}%" title="${esc(title)}"></i>`;
    return `<div class="lane"><span>${esc(item.id)}</span><div class="track">${bar}${marker('reveal', reveal, 'revealed')}${marker('start', start, 'Start working')}${marker('submit', submit, 'submitted')}${marker('deadline', deadline, 'deadline')}</div><em>${esc(item.result)}</em></div>`;
  }).join('') || '<p class="muted">No visible backlog yet. Start the match and let MTM status/watch record observations.</p>';
  const rows = report.items.map((item) => `<tr><td>${esc(item.id)}</td><td>${esc(item.type)}</td><td>${min(item.responseMin)}</td><td>${min(item.workMin)} / ${min(item.estimatedMin)}</td><td>${min(item.slackMin)}</td><td>${item.passingEvidence}/${item.evidenceRuns}${item.reviewed ? ' · review' : ''}</td><td>${esc(item.result)}${item.score != null ? ` ${item.score}` : ''}</td></tr>`).join('') || '<tr><td colspan="7">No observations yet</td></tr>';
  const bars = report.timing.map((item) => {
    const cap = Math.max(item.workMin, item.estimatedMin, 1);
    return `<div class="bar-row"><span>${esc(item.id)}</span><div><i style="width:${(item.estimatedMin / cap) * 100}%"></i><b style="width:${(item.workMin / cap) * 100}%"></b></div><em>${min(item.workMin)} actual · ${min(item.estimatedMin)} plan</em></div>`;
  }).join('') || '<p class="muted">Bars appear after the first completed item recorded on the server clock.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MTM coach</title><style>
:root{color-scheme:light dark;--bg:#101827;--panel:#172235;--text:#eef4ff;--muted:#a8b7cd;--line:#314158;--blue:#63b3ff;--green:#55d49a;--amber:#ffcc66;--red:#ff7f92}@media(prefers-color-scheme:light){:root{--bg:#f6f8fc;--panel:#fff;--text:#142238;--muted:#5b6b82;--line:#d8e0ec;--blue:#1268bd;--green:#087c50;--amber:#9b6500;--red:#c22946}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 ui-sans-serif,system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 20px 56px}h1{font-size:28px;margin:0}h2{font-size:16px;margin:0 0 12px}.sub{color:var(--muted);margin:4px 0 26px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:22px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}.metric{font-size:25px;font-weight:700}.muted,small{color:var(--muted)}.status{color:var(--blue)}.ready{color:var(--green)}.again{color:var(--amber)}ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}li{display:grid;grid-template-columns:48px 160px 1fr;gap:8px;align-items:baseline}li b{font-size:12px}.pass b{color:var(--green)}.gap b{color:var(--red)}.timeline{display:grid;gap:9px}.lane{display:grid;grid-template-columns:90px 1fr 125px;gap:10px;align-items:center}.lane>span,.lane em{font-style:normal;font-variant-numeric:tabular-nums}.track{height:16px;position:relative;background:color-mix(in srgb,var(--line) 45%,transparent);border-radius:999px}.work{position:absolute;top:3px;height:10px;background:var(--blue);border-radius:999px}.marker{position:absolute;top:-2px;width:2px;height:20px;background:var(--muted)}.marker.reveal{background:var(--green)}.marker.start{background:var(--blue)}.marker.submit{background:var(--amber)}.marker.deadline{background:var(--red);border-left:1px dashed var(--red);background:transparent}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;background:var(--blue)}.legend .r{background:var(--green)}.legend .s{background:var(--blue)}.legend .u{background:var(--amber)}.legend .d{background:var(--red)}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}.bar-row{display:grid;grid-template-columns:90px 1fr 180px;gap:10px;align-items:center;margin:9px 0}.bar-row>div{height:14px;position:relative;background:color-mix(in srgb,var(--line) 45%,transparent);border-radius:999px}.bar-row i,.bar-row b{height:5px;left:0;position:absolute;border-radius:999px}.bar-row i{top:2px;background:var(--muted)}.bar-row b{bottom:2px;background:var(--blue)}.bar-row em{font-style:normal;color:var(--muted);font-size:13px}@media(max-width:700px){.grid{grid-template-columns:1fr}.lane{grid-template-columns:72px 1fr}.lane em{grid-column:2}.bar-row{grid-template-columns:72px 1fr}.bar-row em{grid-column:2}.card{overflow:auto}li{grid-template-columns:42px 1fr}li small{grid-column:2}}
</style></head><body><main>
<h1>MTM rehearsal coach</h1><p class="sub">Match ${esc(report.matchId || '—')} · ${esc(report.matchStatus)} · generated ${esc(report.generatedAt)}</p>
<section class="grid"><div class="card"><small>Readiness</small><div class="metric ${report.status === 'READY TO COMPETE' ? 'ready' : report.status === 'TRAIN AGAIN' ? 'again' : 'status'}">${esc(report.status)}</div></div><div class="card"><small>Points</small><div class="metric">${report.earnedPoints} / ${report.visiblePoints || '—'}</div><small>${report.scoreRate == null ? 'No scored item yet' : `${(report.scoreRate * 100).toFixed(0)}% of visible points`}</small></div><div class="card"><small>Submission coverage</small><div class="metric">${report.summary.submitted} / ${report.summary.visible}</div><small>${report.summary.failed} failed · ${report.summary.late} late</small></div></section>
<section class="card"><h2>Preflight and quality gates</h2><ul>${gateRows}</ul></section>
<section class="card"><h2>Server-clock timeline</h2><div class="legend"><span><i class="r"></i>reveal</span><span><i class="s"></i>Start working</span><span><i class="u"></i>submit</span><span><i class="d"></i>deadline</span></div><div class="timeline">${lanes}</div></section>
<section class="card"><h2>Work time versus plan</h2><div class="legend"><span><i></i>planned</span><span><i class="s"></i>actual</span></div>${bars}</section>
<section class="card"><h2>Item evidence</h2><table><thead><tr><th>Item</th><th>Type</th><th>Reveal → start</th><th>Work / plan</th><th>Deadline slack</th><th>Checks</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></section>
${report.reasons.length ? `<section class="card"><h2>Coach notes</h2><ul>${report.reasons.map((reason) => `<li class="gap"><b>NOTE</b><span style="grid-column:span 2">${esc(reason)}</span></li>`).join('')}</ul></section>` : ''}
</main></body></html>`;
}
