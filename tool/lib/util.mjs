import fs from 'node:fs';
import path from 'node:path';

export function getPath(obj, p) {
  if (p == null) return undefined;
  if (p === '' || p === '.') return obj; // empty path = the whole response
  return pathKeys(p).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** "a.b", "checks[0].result" and "checks.0.result" all work; numeric keys create arrays. */
export function pathKeys(p) {
  return String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter((k) => k !== '');
}

export function setPath(obj, p, value) {
  const keys = pathKeys(p);
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys[keys.length - 1]] = value;
}

/** Decodes UTF-8 (with or without BOM) and UTF-16 LE/BE with BOM, which PowerShell 5.1 writes by default. */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

export function readJson(file, fallback) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
  try {
    return JSON.parse(decodeText(buf));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Rewrite it as UTF-8 JSON, or use: mtm fill`);
  }
}

export function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      // Windows: antivirus or an editor can hold the target for a moment.
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 60;
      while (Date.now() < until) { /* short spin, sync on purpose */ }
    }
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameWithRetry(tmp, file);
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Epoch seconds or ms (number or numeric string) or an ISO date string. */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** "90", "90s", "5m", "1.5m" -> seconds. Returns null when the value is not a duration. */
export function parseDuration(v, unit = 's') {
  if (v == null || v === true) return null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || unit).toLowerCase();
  if (u === 'ms') return n / 1000;
  if (u === 'm' || u === 'min') return n * 60;
  return n;
}

export function fmtMin(m) {
  if (m == null) return '-';
  if (m <= 0) return 'over';
  return `${m.toFixed(1)}m`;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

/** Last n lines, each clipped, ANSI codes removed: what the agent reads costs credits. */
export function tailLines(text, n, maxLine = 300) {
  const lines = stripAnsi(text).replace(/\s+$/, '').split(/\r?\n/)
    .map((l) => (l.length > maxLine ? `${l.slice(0, maxLine)} ...[+${l.length - maxLine} chars]` : l));
  if (lines.length <= n) return lines.join('\n');
  return [`... (${lines.length - n} earlier lines omitted)`, ...lines.slice(-n)].join('\n');
}

export function clip(text, max = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const PLACEHOLDER = /^\s*<[^<>]*>\s*$|\{\{[^}]*\}\}|^\s*\.\.\.\s*$|^\s*\[[^\]]*\]\s*$/;

/**
 * Paths of submission fields that are still unfilled: null, empty, an empty array, a bracketed
 * placeholder ("<...>", "{{...}}", "[...]", "..."), or prose copied unchanged from the template
 * (a template hint such as "Describe the root cause"). Short prefilled values (itemId: "BUG-01")
 * may stay as they are. Ordinary words such as TODO or TBD are allowed: they can be domain terms.
 */
export function findPlaceholders(obj, skip = [], template, prefix = '') {
  const out = [];
  const here = prefix || '(root)';
  if (skip.includes(prefix)) return out;
  if (prefix && typeof obj === 'string' && typeof template === 'string' && obj === template && /\s/.test(template.trim())) {
    out.push(here);
    return out;
  }
  if (obj == null) { out.push(here); return out; }
  if (Array.isArray(obj)) {
    if (!obj.length) out.push(here);
    obj.forEach((v, i) => out.push(...findPlaceholders(v, skip, undefined, `${prefix}[${i}]`)));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(...findPlaceholders(v, skip, template && typeof template === 'object' ? template[k] : undefined, p));
    }
  } else if (typeof obj === 'string' && (obj.trim() === '' || PLACEHOLDER.test(obj))) {
    out.push(here);
  }
  return out;
}

/** Small stable hash for change detection (not security). */
export function hashText(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
