// Extract named deliverables from prose/data, never from executable examples or URLs.
const CUE = /\b(?:evidence|artifacts?|baseline|captur\w*|screenshots?|sav\w*|commit\w*|record\w*)\b/i;
const BEFORE = /\bbaseline\b|\bbefore\b[^.!?\n]{0,60}\b(?:fix\w*|chang\w*|edit\w*|implement\w*)\b|\bunfixed\b/i;
const FILE = /(?:[\w-]+\/)*[\w-][\w.-]*\.[a-zA-Z][a-zA-Z0-9]{0,9}\b/g;
// The answer file, organizer templates/schemas and verification specs are named next to
// evidence rules but are never evidence themselves; requiring them would block submission.
const NOT_EVIDENCE = /^(?:submit\.json|.*-submit(?:\.schema)?\.json|.*\.schema\.json|.*minimum-verification-scenarios\.md)$/i;
// Evidence is a captured artifact; `data.steps`-style field references are not files.
const EVIDENCE_EXT = /\.(?:png|jpe?g|gif|webp|svg|pdf|txt|log|md|json|csv|tsv|xml|html?|har|zip|mp4|webm|out)$/i;
const REQUIRED = /\brequired\s+(?:evidence|artifacts?)\b/i;
const baseName = p => String(p).replace(/\\/g, '/').split('/').pop().toLowerCase();

export function extractRequiredEvidence(item = {}, material = {}) {
  const found = new Map();
  const provided = new Set(Object.keys(material.files || {}).map(baseName));
  const scan = (value, context = '') => {
    if (Array.isArray(value)) { value.forEach(v => scan(v, context)); return; }
    if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) scan(v, `${context} ${key}`);
      return;
    }
    if (typeof value !== 'string') return;
    let heading = context;
    let continuation = '';
    const prose = value.replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '')
      .replace(/https?:\/\/[^\s<>"`]+/gi, '').replace(/\[[^\]]*\]\([^)]*\)/g, '');
    for (const line of prose.split(/\r?\n/)) {
      if (/^(?: {4}|\t)(?!\s*[-*]\s|\s*\d+[.)]\s)/.test(line)) continue;
      // Table rows are self-contained: one row's "before" must not leak into the next.
      if (!line.trim() || /^\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s|\|)/.test(line)) continuation = '';
      if (/^\s*#{1,6}\s/.test(line) || /^\s*[\w ]+:\s*$/.test(line)) heading = `${context} ${line}`;
      if (/^\s*(?:\*\*|__)?required\s+(?:evidence|artifacts?)(?:\*\*|__)?\s*:?\s*$/i.test(line) || /^\s*\|\s*required\s+(?:evidence|artifacts?)\s*\|/i.test(line)) heading = `${context} ${line}`;
      // Inline code may name a file; code expressions are not deliverables.
      const clean = line.replace(/`([^`]+)`/g, (_, s) => /^[\w./\\-]+$/.test(s) ? s : '');
      const surrounding = `${heading} ${continuation} ${clean}`;
      for (const match of clean.matchAll(FILE)) {
        // A full answers/<ID>/evidence/<name> path names the same deliverable as evidence/<name>.
        const token = match[0].replace(/^answers\/[\w.-]+\/(?=evidence\/)/, '');
        const prefix = clean.slice(0, match.index);
        if (/[:/\\.\w-]$/.test(prefix) || /\.(?:com|org|net|invalid|example)$/i.test(token)) continue;
        if (!token.startsWith('evidence/') && !EVIDENCE_EXT.test(token)) continue;
        if (!token.startsWith('evidence/') && !CUE.test(surrounding)) continue;
        // Source paths named alongside a capture instruction are inputs, not evidence.
        if (!token.startsWith('evidence/') && (token.includes('/') || /\.(?:[cm]?[jt]sx?|py|sql|toml|ya?ml|prisma|html|css)$/i.test(token))) continue;
        const name = token.replace(/^evidence\//, '');
        if (name.split('/').some(p => !p || p === '.' || p === '..')) continue;
        if (NOT_EVIDENCE.test(baseName(name)) || provided.has(baseName(name))) continue;
        const before = BEFORE.test(surrounding);
        // Only unambiguous names may block submission: an explicit evidence/ path, a "before"
        // artifact, or a screenshot/capture naming an image. Anything else is a reminder.
        const strict = token.startsWith('evidence/') || before || REQUIRED.test(heading) ||
          /\brequired\s+(?:evidence|artifacts?)\s*:/i.test(clean) ||
          (/\.(?:png|jpe?g|gif|webp)$/i.test(name) && /\b(?:screenshots?|captur\w*)\b/i.test(surrounding));
        const prev = found.get(name);
        found.set(name, { name, before: before || prev?.before || false, strict: strict || prev?.strict || false });
      }
      continuation = /[.!?]\s*$/.test(clean) || /^\s*\|/.test(line) ? '' : `${continuation} ${clean}`;
    }
  };
  scan(item.description); scan(item.acceptanceCriteria);
  let template = material.submitTemplate;
  if (typeof template === 'string') { try { template = JSON.parse(template); } catch { /* prose template */ } }
  scan(material.startInstruction); scan(template); scan(material.minimumVerificationScenarios);
  return [...found.values()];
}

export function evidenceArrayRefs(answer) {
  const refs = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidence' && Array.isArray(child)) for (const ref of child) if (typeof ref === 'string') refs.add(ref);
      walk(child);
    }
  };
  walk(answer);
  return refs;
}

export function unscorableAnswer(answer) {
  if (String(answer?.status).trim().toUpperCase() === 'BLOCKED') return 'status is BLOCKED';
  const cases = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:testResults|testCases|cases|tests|scenarios)$/i.test(key) && Array.isArray(child)) cases.push(...child);
      else walk(child);
    }
  };
  walk(answer);
  if (cases.length && cases.every(c => {
    if (!c || typeof c !== 'object') return false;
    const status = String(c.result ?? c.status ?? '').trim().toUpperCase();
    return /^(?:NOT_RUN|FAIL|FAILED)$/.test(status) || ['score', 'points', 'passed'].some(k => c[k] === 0);
  })) return 'every test case is NOT_RUN/FAIL or zero';
  return null;
}
