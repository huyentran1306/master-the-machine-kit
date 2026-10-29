// Extract named deliverables from prose/data, never from executable examples or URLs.
const CUE = /\b(?:evidence|artifacts?|baseline|captur\w*|screenshots?|sav\w*|commit\w*|record\w*)\b/i;
const BEFORE = /\bbaseline\b|\bbefore\b[^.!?\n]{0,60}\b(?:fix\w*|chang\w*|edit\w*|implement\w*)\b|\bunfixed\b/i;
const FILE = /(?:[\w-]+\/)*[\w-][\w.-]*\.[a-zA-Z][a-zA-Z0-9]{0,9}\b/g;

export function extractRequiredEvidence(item = {}, material = {}) {
  const found = new Map();
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
      if (!line.trim() || /^\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s)/.test(line)) continuation = '';
      if (/^\s*#{1,6}\s/.test(line) || /^\s*[\w ]+:\s*$/.test(line)) heading = `${context} ${line}`;
      // Inline code may name a file; code expressions are not deliverables.
      const clean = line.replace(/`([^`]+)`/g, (_, s) => /^[\w./\\-]+$/.test(s) ? s : '');
      const surrounding = `${heading} ${continuation} ${clean}`;
      for (const match of clean.matchAll(FILE)) {
        const token = match[0];
        const prefix = clean.slice(0, match.index);
        if (/[:/\\.\w-]$/.test(prefix) || /\.(?:com|org|net|invalid|example)$/i.test(token)) continue;
        if (!token.startsWith('evidence/') && !CUE.test(surrounding)) continue;
        // Source paths named alongside a capture instruction are inputs, not evidence.
        if (!token.startsWith('evidence/') && (token.includes('/') || /\.(?:[cm]?[jt]sx?|py|sql|toml|ya?ml|prisma|html|css)$/i.test(token))) continue;
        const name = token.replace(/^evidence\//, '');
        if (name.split('/').some(p => !p || p === '.' || p === '..')) continue;
        const before = BEFORE.test(surrounding);
        found.set(name, { name, before: before || found.get(name)?.before || false });
      }
      continuation = /[.!?]\s*$/.test(clean) ? '' : `${continuation} ${clean}`;
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
