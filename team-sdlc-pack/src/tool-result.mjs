export const MAX_RESULT_CHARS = 60000;

/** Limit the serialized result, including JSON escaping, without emitting broken JSON. */
export function serializeToolValue(value) {
  const limit = MAX_RESULT_CHARS;
  const full = JSON.stringify(value);
  if (full.length <= limit) return full;
  const envelope = { truncated: true, originalLength: full.length };
  // Keep short control fields usable even when a large backlog/evidence payload is cut.
  for (const key of ['ok', 'outcome', 'error', 'mustEnd', 'next', 'receipt']) {
    if (value?.[key] !== undefined && JSON.stringify(value[key]).length <= 2000) envelope[key] = value[key];
  }
  let low = 0;
  let high = Math.min(full.length, limit);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify({ ...envelope, preview: full.slice(0, mid) }).length <= limit) low = mid;
    else high = mid - 1;
  }
  return JSON.stringify({ ...envelope, preview: full.slice(0, low) });
}
