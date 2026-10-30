// Match portal adapter: cookie login and reading /match/<matchId>.
// The organizers do not publish the page's internal API ("output is the visible match information
// and authorized backlog, without requiring a specific internal API response"), so the parser is
// layered: structured JSON embedded in the page (Next.js flight data, __NEXT_DATA__, JSON scripts,
// data-* attributes) first, then the visible text. Whatever is parsed, the visible text is kept so
// the agent can read the page itself when the structure is unknown.
import crypto from 'node:crypto';
import { extractJsonObject } from './lifecycle.mjs';
import { request, httpError } from './http.mjs';

const KEY_SRC = '(?:TASK|CR|BUG|PI)-\\d{1,4}';
const KEY_RE = new RegExp(`^${KEY_SRC}$`);
const UUID_SRC = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#34': '"', '#x2F': '/', '#47': '/' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (ENTITIES[e] != null) return ENTITIES[e];
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

export function htmlToText(html) {
  let s = String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|pre|dt|dd|summary|details)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** A React Server Components reference such as "$15", "$L1a" or "$@3": a pointer to another chunk, never text. */
export const isRscRef = (v) => typeof v === 'string' && /^\$[A-Za-z@#]?[0-9a-fA-F]{1,8}$/.test(v.trim());

/** Text chunks of the flight stream: "<hex id>:T<hex byte length>,<text>". The live portal (M02UT89F, 26/10)
 * sends each backlog row with descriptionMd:"$15" and the item text as chunk 15. */
export function rscTextChunks(stream) {
  const chunks = new Map();
  const buf = Buffer.from(stream, 'utf8');
  const head = /(?:^|\n)([0-9a-f]{1,8}):T([0-9a-f]{1,8}),/g;
  let m;
  while ((m = head.exec(stream))) {
    const start = Buffer.byteLength(stream.slice(0, m.index + m[0].length), 'utf8');
    const len = parseInt(m[2], 16);
    if (!Number.isFinite(len) || start + len > buf.length) continue;
    chunks.set(m[1].toLowerCase(), buf.subarray(start, start + len).toString('utf8'));
  }
  return chunks;
}

/** Replace "$<id>" string values that point at a text chunk with that text, so the JSON carries the item text. */
export function resolveRscTextRefs(stream) {
  const chunks = rscTextChunks(stream);
  if (!chunks.size) return stream;
  return stream.replace(/"\$([0-9a-fA-F]{1,8})"/g, (all, id) => (chunks.has(id.toLowerCase()) ? JSON.stringify(chunks.get(id.toLowerCase())) : all));
}

/** A description worth working from: real text, not a reference, not a one-line board row. */
export const usableDescription = (s) => typeof s === 'string' && s.trim().length >= 120 && !isRscRef(s);

/** Segments of the page that may hold JSON: flight data, __NEXT_DATA__, JSON scripts, data-* attributes. */
export function dataSegments(html) {
  const segs = [];
  const flight = [];
  const pushRe = /self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
  let m;
  while ((m = pushRe.exec(html))) {
    try {
      flight.push(JSON.parse(m[1]));
    } catch {
      /* ignore */
    }
  }
  if (flight.length) segs.push(resolveRscTextRefs(flight.join('')));
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    if (!body.trim() || /__next_f\.push/.test(body)) continue;
    if (/type=["']?application\/(ld\+)?json/i.test(attrs) || /id=["']__NEXT_DATA__/i.test(attrs) || /[{[]\s*"/.test(body)) segs.push(body);
  }
  const attrRe = /\sdata-[a-zA-Z0-9_-]+=("([^"]*)"|'([^']*)')/g;
  while ((m = attrRe.exec(html))) {
    const v = decodeEntities(m[2] ?? m[3] ?? '');
    if (/^[{[]/.test(v.trim())) segs.push(v);
  }
  return segs;
}

/** Objects whose own (top-level) values include `needle`, found by trying the nearest "{" before each occurrence. */
function objectsAround(seg, needleRe, maxTries = 10) {
  const found = [];
  const seen = new Set();
  let m;
  needleRe.lastIndex = 0;
  while ((m = needleRe.exec(seg))) {
    const value = m[1];
    let pos = m.index;
    for (let t = 0; t < maxTries; t++) {
      pos = seg.lastIndexOf('{', pos - 1);
      if (pos < 0 || m.index - pos > 200000) break;
      if (seen.has(`${pos}:${value}`)) break;
      const obj = extractJsonObject(seg, pos);
      if (!obj || obj.end < m.index) continue;
      const top = obj.value;
      if (top && typeof top === 'object' && !Array.isArray(top) && Object.values(top).some((v) => v === value)) {
        seen.add(`${pos}:${value}`);
        found.push({ value, obj: top });
        break;
      }
    }
  }
  return found;
}

// The contestant backlog array outranks event headlines and incidental item-id references.
// Scan just its direct objects, including when nested inside a flight initialProjection.
function backlogRows(seg) {
  const rows = [];
  for (const m of seg.matchAll(/"backlog"\s*:\s*\[/g)) {
    let pos = m.index + m[0].length;
    while (pos < seg.length) {
      while (/[\s,]/.test(seg[pos] || '') && pos < seg.length) pos++;
      if (seg[pos] !== '{') break;
      const row = extractJsonObject(seg, pos);
      if (!row) break;
      rows.push(row.value);
      pos = row.end;
    }
  }
  return rows;
}

/**
 * A backlog title the page actually showed, or null.
 *
 * The plain-HTML branch takes whatever text follows the item id on its line, and on a page whose
 * markup it does not fully understand that can be a fragment of JSON or markup - a real match
 * produced the title `"}'` for TASK-01, which told the orchestrator nothing and delayed the item.
 * Better to report no title (the agent then calls get_backlog_item for the real text) than to
 * report noise that reads like a title.
 */
export function usableTitle(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length < 4 || s.length > 200) return null;
  const wordChars = (s.match(/[\p{L}\p{N}]/gu) || []).length;
  if (wordChars < 4) return null;                       // "}' and friends
  if (wordChars / s.length < 0.5) return null;          // mostly punctuation: a fragment, not prose
  if (/^[{}[\]"'`,;:|<>\\/]/.test(s)) return null;      // starts mid-JSON or mid-tag
  if (/(?:https?:\/\/|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/)/i.test(s)) return null;
  if (/^(?:[$>]\s*)?(?:curl|wget|httpie|Invoke-WebRequest|Invoke-RestMethod|fetch|git|npm|npx|pnpm|yarn|node|python|pwsh|powershell|cmd)(?:\s|\()/i.test(s)) return null;
  if (/^(?:API\s+)?(?:endpoint|request URL)\s*:/i.test(s)) return null;
  if (/^(?:\d+\s*(?:pt|pts|points)|open|closed|visible|working|submitted|passed|failed|not started)$/i.test(s)) return null;
  return s;
}

const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return null;
};

/**
 * Assignment values a plain (server-rendered) page shows next to a label: "Team T01", "Team ID: T01",
 * "branch main", "Folder: ABCD1234", "Repository https://host/team/repo.git". Every labelled value is kept
 * (a page may name the team code and the team name); the caller decides what counts as a contradiction.
 */
export function assignmentFromText(pageText) {
  const out = { teamIds: [], branches: [], folders: [], repoUrls: [] };
  const sep = '(?:^|[\\s|·•,;(\\[])';
  const grab = (re, list) => {
    for (const m of String(pageText || '').matchAll(re)) {
      const v = m[1].replace(/[`'".,;)\]]+$/, '');
      if (v && !list.includes(v)) list.push(v);
    }
  };
  grab(new RegExp(`${sep}team(?:\\s*(?:id|code))?\\s*[:#=]?\\s*\`?([A-Za-z0-9][\\w.:-]*)`, 'gim'), out.teamIds);
  grab(new RegExp(`${sep}branch\\s*[:=]?\\s*\`?([A-Za-z0-9][\\w./-]*)`, 'gim'), out.branches);
  grab(new RegExp(`${sep}folder\\s*[:=]?\\s*\`?([A-Za-z0-9][\\w.-]*)`, 'gim'), out.folders);
  grab(new RegExp(`${sep}repo(?:sitory)?(?:\\s*url)?\\s*[:=]?\\s*\`?((?:https?|ssh|git|file):\\/\\/[^\\s\`'"<>·|]+|[\\w.-]+@[\\w.-]+:[^\\s\`'"<>·|]+)`, 'gim'), out.repoUrls);
  return out;
}

/**
 * The match-information part of the page text: the lines before the first line that names a backlog
 * item. Backlog descriptions ("branch dev fails when ...") must never be read as the assignment.
 */
export function matchInfoText(pageText) {
  const lines = String(pageText || '').split('\n');
  const keyLine = new RegExp(`(^|[^A-Za-z0-9])${KEY_SRC}($|[^A-Za-z0-9])`);
  const i = lines.findIndex((l) => keyLine.test(l));
  return (i < 0 ? lines : lines.slice(0, i)).join('\n');
}

/** Team and repository the match object names, when the page carries them as data. */
function assignmentFrom(o) {
  const str = (v) => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null);
  const team = o.team && typeof o.team === 'object' ? o.team : {};
  const repo = [o.repository, o.repo, o.gitRepository].find((r) => r && typeof r === 'object') || {};
  return {
    teamId: str(pick(team, ['teamId', 'teamCode', 'code'])) ?? str(pick(o, ['teamId', 'teamCode'])),
    repository: {
      url: str(pick(repo, ['url', 'cloneUrl', 'gitUrl'])) ?? (typeof o.repository === 'string' ? o.repository : null),
      branch: str(pick(repo, ['branch', 'defaultBranch'])) ?? str(pick(o, ['branch'])),
      folder: str(pick(repo, ['folder', 'path', 'directory'])) ?? str(pick(o, ['folder'])),
    },
  };
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const AVAIL = new Set(['OPEN', 'VISIBLE', 'CLOSED', 'EXPIRED', 'HIDDEN', 'REVEALED', 'CANCELLED', 'REMOVED']);
const TEAM = new Set(['NOT_STARTED', 'WORKING', 'IN_PROGRESS', 'STARTED', 'SUBMITTED', 'GRADING', 'GRADED', 'ACCEPTED', 'PENDING']);
const RESULT = new Set(['PASSED', 'FAILED']);

function classifyStatuses(o, item) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string' || !/status|state|availability|visibility|result|verdict|phase/i.test(k)) continue;
    const s = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (AVAIL.has(s) && !item.availability) item.availability = s === 'REVEALED' ? 'VISIBLE' : s;
    else if (TEAM.has(s) && !item.teamStatus) item.teamStatus = s === 'IN_PROGRESS' || s === 'STARTED' ? 'WORKING' : s;
    else if (RESULT.has(s) && !item.result) item.result = s;
  }
}

function descriptionOf(o) {
  const parts = [];
  // The contestant JSON view carries the full item text in descriptionMd and its verification
  // scenarios (with required evidence names) in minimumVerificationMd.
  const plain = new Set(['description', 'descriptionMd', 'body', 'content']);
  for (const k of ['description', 'descriptionMd', 'descriptionMarkdown', 'markdown', 'body', 'content', 'details', 'detail', 'brief', 'requirements', 'context', 'expectedOutcome', 'acceptanceCriteria', 'instructions', 'minimumVerificationMd']) {
    const v = o[k];
    if (isRscRef(v)) continue; // "$15" is a pointer to a text chunk, not the description
    if (typeof v === 'string' && v.trim().length > 0) parts.push(plain.has(k) ? v : `${k}: ${v}`);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) parts.push(`${k}:\n- ${v.join('\n- ')}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

function itemFromObject(key, o) {
  const it = { id: key, type: key.split('-')[0], title: null, maxPoints: null, availability: null, teamStatus: null, result: null, score: null, deadlineAt: null, revealedAt: null, deadlineMinutes: null, description: null };
  const title = pick(o, ['title', 'backlogTitle', 'name', 'summary', 'headline']);
  if (typeof title === 'string') it.title = usableTitle(title);
  const type = pick(o, ['type', 'backlogType', 'kind', 'itemType']);
  if (typeof type === 'string' && /^(TASK|CR|BUG|PI)$/i.test(type)) it.type = type.toUpperCase();
  const pts = pick(o, ['maxPoints', 'maxPt', 'maxScore', 'points', 'maxPts', 'score_max', 'max']);
  if (pts != null && Number.isFinite(Number(pts))) it.maxPoints = Number(pts);
  const score = pick(o, ['score', 'awardedPoints', 'earnedPoints', 'officialScore']);
  if (score != null && Number.isFinite(Number(score)) && score !== pts) it.score = Number(score);
  it.revealedAt = toMs(pick(o, ['revealedAt', 'visibleAt', 'releasedAt', 'openedAt', 'publishedAt', 'openAt']));
  const dl = pick(o, ['deadlineAt', 'closesAt', 'closeAt', 'dueAt', 'deadline', 'expiresAt', 'closedAt']);
  if (typeof dl === 'number' && dl < 1e6) it.deadlineMinutes = dl;
  else it.deadlineAt = toMs(dl);
  const dm = pick(o, ['deadlineMinutes', 'deadlineMin', 'deadlineInMinutes', 'timeLimitMinutes']);
  if (dm != null && Number.isFinite(Number(dm))) it.deadlineMinutes = Number(dm);
  if (!it.deadlineAt && it.deadlineMinutes != null && it.revealedAt) it.deadlineAt = it.revealedAt + it.deadlineMinutes * 60000;
  classifyStatuses(o, it);
  for (const nested of ['teamStatus', 'team', 'progress', 'submission', 'mine', 'myTeam']) {
    if (o[nested] && typeof o[nested] === 'object' && !Array.isArray(o[nested])) classifyStatuses(o[nested], it);
  }
  it.description = descriptionOf(o);
  return it;
}

function richness(it) {
  return ['title', 'maxPoints', 'availability', 'deadlineAt', 'revealedAt', 'description', 'teamStatus'].filter((k) => it[k] != null).length
    + (it.description ? Math.min(3, it.description.length / 400) : 0);
}

function merge(a, b) {
  const [rich, poor] = richness(a) >= richness(b) ? [a, b] : [b, a];
  const out = { ...rich };
  for (const [k, v] of Object.entries(poor)) if (out[k] == null && v != null) out[k] = v;
  if (poor.description && rich.description && poor.description.length > rich.description.length) out.description = poor.description;
  return out;
}

const TEXT_STATUS = [
  [/\bnot started\b/i, 'teamStatus', 'NOT_STARTED'], [/\bworking\b/i, 'teamStatus', 'WORKING'], [/\bsubmitted\b/i, 'teamStatus', 'SUBMITTED'],
  [/\bgraded\b/i, 'teamStatus', 'GRADED'], [/\bpassed\b/i, 'result', 'PASSED'], [/\bfailed\b/i, 'result', 'FAILED'],
  [/\bclosed\b|\bexpired\b/i, 'availability', 'CLOSED'], [/\bopen\b/i, 'availability', 'OPEN'], [/\bvisible\b/i, 'availability', 'VISIBLE'],
];

/** Items seen only in visible text (fallback). */
function itemsFromText(text) {
  const lines = text.split('\n');
  const byId = new Map();
  const re = new RegExp(`\\b(${KEY_SRC})\\b`);
  lines.forEach((line, idx) => {
    // A title belongs to an item row/heading, never an API example that mentions an id.
    const m = line.match(new RegExp(`^[-*#\\s|]*(${KEY_SRC})\\b`));
    if (!m || byId.get(m[1])?.title) return;
    const id = m[1];
    const it = { id, type: id.split('-')[0], title: null, maxPoints: null, availability: null, teamStatus: null, result: null, score: null, deadlineAt: null, revealedAt: null, description: null };
    const rest = line.slice(line.indexOf(id) + id.length).replace(/^[\s|:·\-—]+/, '');
    const t = rest.split('|').map((x) => x.trim()).filter(Boolean)[0] || '';
    // Only the same row or the next line in this item block may supply a title.
    if (t && !re.test(t)) it.title = usableTitle(t);
    if (!it.title) { const n = lines[idx + 1]; if (n && !re.test(n)) it.title = usableTitle(n); }
    const pts = (line + ' ' + (lines[idx + 1] || '')).match(/\b(?:max\s*)?(\d{2,4})\s*(?:pt|pts|points|điểm)\b/i) || line.match(/\|\s*(\d{2,4})\s*\|/);
    if (pts) it.maxPoints = Number(pts[1]);
    for (const [r, k, v] of TEXT_STATUS) if (!it[k] && r.test(line)) it[k] = v;
    byId.set(id, it);
  });
  return byId;
}

/** Text between an item id and the next item id: used when the page has no structured description. */
export function textBlockFor(text, id, max = 6000) {
  const first = text.indexOf(id);
  if (first < 0) return null;
  // Prefer the occurrence followed by the longest block (detail section rather than table row).
  const re = new RegExp(`\\b${KEY_SRC}\\b`, 'g');
  const positions = [];
  let m;
  while ((m = re.exec(text))) positions.push({ id: m[0], at: m.index });
  let best = null;
  positions.forEach((p, i) => {
    if (p.id !== id) return;
    const next = positions.slice(i + 1).find((q) => q.id !== id);
    const end = next ? next.at : text.length;
    const block = text.slice(p.at, Math.min(end, p.at + max));
    if (!best || block.length > best.length) best = block;
  });
  return best;
}

const MATCH_STATUS_MAP = [
  [/^(IN_PROGRESS|RUNNING|STARTED|ACTIVE|LIVE)$/, 'IN_PROGRESS'], [/^PAUSED$/, 'PAUSED'], [/^(FINISHED|ENDED|COMPLETED|TIME_OVER|CLOSED)$/, 'FINISHED'],
  [/^(PREPARING|PREPARATION|PREPARED|READY|SCHEDULED|NOT_STARTED|WAITING|CREATED|DRAFT)$/, 'NOT_STARTED'],
];
export function normalizeMatchStatus(s) {
  if (!s) return null;
  const v = String(s).trim().toUpperCase().replace(/[\s-]+/g, '_');
  for (const [re, out] of MATCH_STATUS_MAP) if (re.test(v)) return { status: out, raw: v };
  return null;
}

function parseHms(s) {
  const m = String(s).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return m[3] != null ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : (Number(m[1]) * 60 + Number(m[2])) * 1000;
}

/**
 * Parses the match page. Returns
 * { matchUuid, status, statusRaw, endsAt, remainingMs, items: [...], pageText, structured: bool, warnings }
 */
export function parseMatchPage(html, { matchId, serverNow = Date.now() } = {}) {
  const warnings = [];
  const pageText = htmlToText(html);
  const segs = dataSegments(html);
  const corpus = [html, ...segs].join('\n');

  // Match UUID: the Start work / Submit URLs shown under "Digital Cuder APIs".
  const uuidCounts = new Map();
  for (const m of corpus.matchAll(new RegExp(`/api/v1/matches/(${UUID_SRC})/(?:backlogs/start|submissions)`, 'g'))) {
    uuidCounts.set(m[1].toLowerCase(), (uuidCounts.get(m[1].toLowerCase()) || 0) + 1);
  }
  let matchUuid = [...uuidCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (uuidCounts.size > 1) warnings.push(`several match UUIDs in Start/Submit URLs: ${[...uuidCounts.keys()].join(', ')}`);

  // MCP endpoints the page advertises (the organizers' match MCP server with the customer's internal
  // material). Only a URL the page itself shows is ever called; the helper never guesses one.
  const mcpUrls = [...new Set([
    ...[...corpus.matchAll(/https?:\/\/[^\s"'<>()\\]+\/(?:api\/v\d+\/)?mcp(?:\/[A-Za-z0-9._~-]+)*\/?/gi)].map((m) => m[0]),
    ...[...corpus.matchAll(/(?:^|["'\s(])(\/(?:api\/v\d+\/)?mcp(?:\/[A-Za-z0-9._~-]+)*)\/?(?=["'\s)<]|$)/gim)].map((m) => m[1]),
  ])].map((u) => u.replace(/[.,;)]+$/, '')).filter((u) => !/\.(js|css|png|jpg|svg|json)$/i.test(u));

  // Structured items.
  let items = new Map();
  const structuredTitles = new Map();
  const backlogTitles = new Map();
  let matchObj = null;
  for (const seg of segs) {
    for (const row of backlogRows(seg)) {
      const key = [row.key, row.backlogId, row.backlogItemKey, row.id].find(v => typeof v === 'string' && KEY_RE.test(v));
      const title = usableTitle(row.title) || usableTitle(row.backlogTitle);
      if (key && title) backlogTitles.set(key, title);
    }
    for (const { value, obj } of objectsAround(seg, new RegExp(`"(${KEY_SRC})"`, 'g'))) {
      const it = itemFromObject(value, obj);
      // Ignore React props and request/answer examples; only item identity fields bind a title.
      if (['id', 'key', 'backlogId', 'backlogItemKey'].some(k => obj[k] === value)) {
        const title = usableTitle(obj.title) || usableTitle(obj.backlogTitle);
        if (title) structuredTitles.set(value, title);
      }
      items.set(value, items.has(value) ? merge(items.get(value), it) : it);
    }
    if (matchId && !matchObj) {
      const esc = matchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cands = objectsAround(seg, new RegExp(`"(${esc})"`, 'g'));
      matchObj = cands.map((c) => c.obj).find((o) => Object.keys(o).some((k) => /status|state/i.test(k))) || cands[0]?.obj || null;
    }
  }
  const structured = items.size > 0;

  // Text fallback / enrichment.
  const titleText = htmlToText(html
    .replace(/<(pre|code|kbd|samp)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<\/(article|section|tr|li)>/gi, '\n[ITEM BLOCK END]\n'));
  const textItems = itemsFromText(titleText);
  for (const [id, t] of textItems) items.set(id, items.has(id) ? merge(items.get(id), t) : t);
  items = [...items.values()].filter((it) => KEY_RE.test(it.id));
  for (const it of items) {
    it.title = backlogTitles.get(it.id) || structuredTitles.get(it.id) || textItems.get(it.id)?.title || null;
    if (it.title) it.title = String(it.title).replace(/\s+/g, ' ').trim();
    it.specHash = crypto.createHash('sha1').update(`${it.title}|${it.maxPoints}|${it.deadlineAt}|${it.description || ''}`).digest('hex').slice(0, 12);
  }
  items.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  // Match status and clock.
  let status = null;
  let statusRaw = null;
  if (matchObj) {
    for (const [k, v] of Object.entries(matchObj)) {
      if (/status|state|phase/i.test(k) && typeof v === 'string') {
        const n = normalizeMatchStatus(v);
        if (n) {
          ({ status } = n);
          statusRaw = n.raw;
          break;
        }
      }
    }
    if (!matchUuid) {
      const u = Object.values(matchObj).find((v) => typeof v === 'string' && new RegExp(`^${UUID_SRC}$`).test(v));
      if (u) matchUuid = u.toLowerCase();
    }
  }
  if (!status) {
    const m = pageText.match(/Status\s*:?\s*(In Progress|Paused|Finished|Ended|Time Over|Preparing|Prepared|Not Started|Scheduled|Running)/i);
    if (m) {
      const n = normalizeMatchStatus(m[1]);
      status = n?.status || null;
      statusRaw = n?.raw || null;
    }
  }
  let endsAt = matchObj ? toMs(pick(matchObj, ['endsAt', 'endAt', 'endTime', 'finishAt', 'endsAtUtc'])) : null;
  let remainingMs = null;
  if (matchObj) {
    const rs = pick(matchObj, ['remainingSeconds', 'remainingSec']);
    const rm = pick(matchObj, ['remainingMs']);
    if (rm != null) remainingMs = Number(rm);
    else if (rs != null) remainingMs = Number(rs) * 1000;
  }
  if (remainingMs == null) {
    const m = pageText.match(/Remaining\s*:?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i) || pageText.match(/Còn lại\s*:?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
    if (m) remainingMs = parseHms(m[1]);
  }
  if (!endsAt && remainingMs != null) endsAt = serverNow + remainingMs;
  if (endsAt && remainingMs == null) remainingMs = endsAt - serverNow;

  const itemLinks = {};
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]);
    const key = (href.match(new RegExp(`(${KEY_SRC})`)) || [])[1]; // only links that name the item
    if (key && !itemLinks[key] && !/\/api\//.test(href)) itemLinks[key] = href;
  }
  // Is this the page of the assigned match? Visible text first, then the page's own data (quoted value).
  let matchIdShown = null;
  if (matchId) {
    const esc = String(matchId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchIdShown = new RegExp(`(^|[^A-Za-z0-9])${esc}($|[^A-Za-z0-9])`, 'i').test(pageText) || segs.some((seg) => seg.includes(`"${matchId}"`));
  }
  const assignment = matchObj ? assignmentFrom(matchObj) : null;
  if (!matchUuid) warnings.push('match UUID not found on the page (Start/Submit URLs)');
  if (!items.length) warnings.push('no backlog item ids found on the page');
  if (!status) warnings.push('match status not found on the page');
  return { matchUuid, status, statusRaw, endsAt, remainingMs, items, pageText, structured, warnings, itemLinks, matchIdShown, assignment, mcpUrls, textAssignment: assignmentFromText(matchInfoText(pageText)) };
}

/** Read the contestant JSON view when the HTTP page is only a client-rendered shell.
 * Paths come from the adapter, not from probing private endpoints. The public portal client uses
 * /api/v1/match/<publicId>. Authentication and refresh must validate the same view.
 */
export async function loadMatchData(html, { url, matchId, matchUuid, extraJsonPaths = [], call, serverNow = Date.now(), requireUuid = true }) {
  let parsed = parseMatchPage(html, { matchId, serverNow });
  let authenticatedJson = false;
  const readable = () => !!(parsed.matchIdShown && parsed.status && (parsed.matchUuid || (!requireUuid && authenticatedJson)));
  const errors = [];
  // A readable page can still lack the item text (descriptionMd sent as a "$15" reference): then the
  // JSON view the portal itself renders from is read too, for the descriptions only.
  const missingText = () => parsed.items.length > 0 && parsed.items.some((i) => !usableDescription(i.description));
  if (readable() && !missingText()) return { html, parsed, readable: true, authRejected: false, errors };
  const wasReadable = readable();
  for (const template of extraJsonPaths) {
    const target = new URL(template.replace('{matchId}', encodeURIComponent(matchId)).replace('{matchUuid}', matchUuid || ''), url).toString();
    try {
      const res = await call(target, { method: 'GET', headers: { accept: 'application/json', referer: url } });
      if (res.status === 401 || res.status === 403) {
        if (wasReadable) { errors.push(`match data HTTP ${res.status} (descriptions only)`); continue; }
        return { html, parsed, readable: false, authRejected: true, errors: [`match data HTTP ${res.status}`] };
      }
      if (res.status >= 400 || !res.json || typeof res.json !== 'object') {
        errors.push(`match data HTTP ${res.status} without a usable JSON document`);
        continue;
      }
      const code = res.json.match?.publicId || res.json.match?.code;
      if (code && code !== matchId) {
        errors.push('match data belongs to a different match');
        continue;
      }
      html += `\n<script type="application/json">${JSON.stringify(res.json).replace(/</g, '\\u003c')}</script>`;
      parsed = parseMatchPage(html, { matchId, serverNow });
      authenticatedJson = !!(res.json.match && code === matchId);
      if (readable() && !missingText()) return { html, parsed, readable: true, authRejected: false, errors };
    } catch (e) {
      errors.push(e.code || 'MATCH_DATA_REQUEST_FAILED');
    }
  }
  return { html, parsed, readable: readable(), authRejected: false, errors };
}

/** True when the response looks like a login page rather than the match page. */
export function looksLikeLogin(res) {
  if (res.status === 401 || res.status === 403) return true;
  const path = new URL(res.url).pathname;
  if (/(^|\/)(login|signin|sign-in|auth)(\/|$)/i.test(path)) return true;
  return /<input[^>]+type=["']?password/i.test(res.text) && !/\b(?:TASK|CR|BUG|PI)-\d{1,4}\b/.test(res.text);
}

/** Login form discovery: { action, method, enctype, fields: [{name, type, value}] } or null. */
export function findLoginForm(html, baseUrl) {
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRe.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    if (!/type=["']?password/i.test(inner)) continue;
    const attr = (name, src) => {
      const r = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(src);
      return r ? decodeEntities(r[2] ?? r[3] ?? r[4] ?? '') : null;
    };
    const fields = [];
    for (const im of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const name = attr('name', im[1]);
      if (!name) continue;
      fields.push({ name, type: (attr('type', im[1]) || 'text').toLowerCase(), value: attr('value', im[1]) ?? '' });
    }
    const action = attr('action', attrs);
    return {
      action: new URL(action && !/^javascript:/i.test(action) ? action : baseUrl, baseUrl).toString(),
      method: (attr('method', attrs) || 'POST').toUpperCase(),
      enctype: (attr('enctype', attrs) || '').toLowerCase(),
      fields,
    };
  }
  return null;
}

function fillLoginForm(form, username, password) {
  const out = [];
  const userField = form.fields.find((f) => ['email', 'text'].includes(f.type) && /user|email|login|account|name|id/i.test(f.name))
    || form.fields.find((f) => ['email', 'text'].includes(f.type));
  for (const f of form.fields) {
    if (f.type === 'password') out.push([f.name, password]);
    else if (userField && f.name === userField.name) out.push([f.name, username]);
    else if (['hidden'].includes(f.type) || (f.type === 'checkbox' && /remember/i.test(f.name))) out.push([f.name, f.value || (f.type === 'checkbox' ? 'on' : '')]);
  }
  return { pairs: out, userField: userField?.name || null };
}

/**
 * Logs in with the cookie session. ctx: { origin, matchUrl, username, password, jar, allowedOrigins,
 * adapter, preferred, log(phase, req, res|err) }. Returns { strategy, path } or throws.
 */
export async function login(ctx) {
  const { origin, username, password, jar, allowedOrigins, adapter = {}, log = async () => {} } = ctx;
  const cfg = adapter.login || {};
  const order = [ctx.preferred?.strategy, ...(cfg.strategy && cfg.strategy !== 'auto' ? [cfg.strategy] : (cfg.strategies || ['nextauth', 'form', 'json']))].filter(Boolean);
  const tried = [];
  const call = async (op, url, opts) => {
    const reqInfo = { method: opts.method || 'GET', url };
    await log('REQUESTED', reqInfo);
    try {
      // Match the portal's same-origin browser POSTs. The real login endpoint rejects a
      // credentials POST without Origin/Referer; HTTP 403 must not silently fall back to a shell.
      const headers = opts.method === 'POST'
        ? { origin, referer: `${origin}/login`, ...opts.headers }
        : opts.headers;
      const res = await request(url, { jar, allowedOrigins, ...opts, headers });
      await log(res.status < 400 ? 'SUCCEEDED' : 'FAILED', reqInfo, res);
      return res;
    } catch (e) {
      await log('FAILED', reqInfo, null, e);
      throw e;
    }
  };
  const verify = async () => {
    const res = await call('LOGIN', ctx.matchUrl, { method: 'GET' });
    if (looksLikeLogin(res) || res.status >= 400) return false;
    const view = await loadMatchData(res.text, {
      url: ctx.matchUrl, matchId: ctx.matchId || decodeURIComponent(new URL(ctx.matchUrl).pathname.split('/').filter(Boolean).at(-1)),
      extraJsonPaths: adapter.matchView?.extraJsonPaths || ['/api/v1/match/{matchId}'],
      requireUuid: false,
      call: (url, opts) => call('LOGIN', url, opts),
    });
    return view.readable;
  };
  for (const strategy of [...new Set(order)]) {
    try {
      if (strategy === 'nextauth') {
        const base = cfg.nextAuthBasePath || '/api/auth';
        const csrf = await call('LOGIN', `${origin}${base}/csrf`, { method: 'GET', headers: { accept: 'application/json' } });
        const token = csrf.json?.csrfToken;
        if (!token) {
          tried.push(`nextauth: no csrfToken at ${base}/csrf (HTTP ${csrf.status})`);
          continue;
        }
        const providers = cfg.nextAuthProviders || ['credentials'];
        for (const provider of providers) {
          const form = new URLSearchParams({ csrfToken: token, username, email: username, password, callbackUrl: ctx.matchUrl, json: 'true', redirect: 'false' });
          const res = await call('LOGIN', `${origin}${base}/callback/${provider}`, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(),
          });
          if (res.status < 400 && !/error=/i.test(res.json?.url || res.url) && await verify()) return { strategy, path: `${base}/callback/${provider}` };
          tried.push(`nextauth/${provider}: HTTP ${res.status}${res.json?.url ? ` ${res.json.url}` : ''}`);
        }
      } else if (strategy === 'form') {
        for (const p of cfg.loginPaths || ['/login', '/sign-in', '/signin', '/auth/login', '/']) {
          const page = await call('LOGIN', `${origin}${p}`, { method: 'GET' });
          const form = page.status < 400 ? findLoginForm(page.text, page.url) : null;
          if (!form) {
            tried.push(`form: no password form at ${p} (HTTP ${page.status})`);
            continue;
          }
          const { pairs, userField } = fillLoginForm(form, username, password);
          if (!userField) {
            tried.push(`form: no username field at ${p}`);
            continue;
          }
          const multipart = form.enctype.includes('multipart') || pairs.some(([k]) => k.startsWith('$ACTION'));
          let body;
          const headers = { accept: 'text/html,application/json' };
          if (multipart) {
            body = new FormData();
            for (const [k, v] of pairs) body.append(k, v);
          } else {
            body = new URLSearchParams(pairs).toString();
            headers['content-type'] = 'application/x-www-form-urlencoded';
          }
          const res = await call('LOGIN', form.action, { method: form.method === 'GET' ? 'POST' : form.method, headers, body });
          if (res.status < 400 && await verify()) return { strategy, path: new URL(form.action).pathname };
          tried.push(`form: POST ${new URL(form.action).pathname} -> HTTP ${res.status}`);
        }
      } else if (strategy === 'json') {
        for (const p of cfg.jsonLoginPaths || ['/api/auth/login', '/api/login', '/api/v1/auth/login']) {
          for (const body of [{ username, password }, { email: username, password }]) {
            const res = await call('LOGIN', `${origin}${p}`, {
              method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
            });
            if (res.status === 404 || res.status === 405) {
              tried.push(`json: ${p} HTTP ${res.status}`);
              break;
            }
            if (res.status < 400 && await verify()) return { strategy, path: p };
            tried.push(`json: ${p} HTTP ${res.status}`);
          }
        }
      }
    } catch (e) {
      tried.push(`${strategy}: ${e.code || ''} ${e.message}`.trim());
      if (e.code === 'ORIGIN_NOT_ALLOWED' || e.code === 'CROSS_ORIGIN_REDIRECT') continue;
    }
  }
  throw httpError('LOGIN_FAILED', `login failed; tried: ${tried.slice(-8).join(' | ')}`, { tried });
}
