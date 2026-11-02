// Match the detail viewer: typed JSON accepts any valid JSON value, while
// ordinary text is treated as JSON only when it contains an object or array.
export function jsonCellInfo(value, dataType = '') {
  if (value === null || value === undefined) return null;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const parsed = JSON.parse(raw);
    const declared = /(?:^|[^a-z0-9_])jsonb?(?:$|[^a-z0-9_])/i.test(dataType);
    return declared || (parsed !== null && typeof parsed === 'object') ? { raw } : null;
  } catch { return null; }
}
