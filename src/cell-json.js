// Match the detail viewer: typed JSON accepts any valid JSON value, while
// ordinary text is treated as JSON only when it contains an object or array.
function withoutJavaLongSuffixes(raw) {
  const number = /-?(?:0|[1-9]\d*)L(?=\s*[,}\]])/y;
  let normalized = '', inString = false, escaped = false, changed = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      normalized += char;
    } else if ((char === '-' || /[0-9]/.test(char)) && (i === 0 || /[\s\[{: ,]/.test(raw[i - 1]))) {
      number.lastIndex = i;
      const match = number.exec(raw);
      if (match) {
        normalized += match[0].slice(0, -1);
        i += match[0].length - 1;
        changed = true;
      } else normalized += char;
    } else normalized += char;
  }
  return changed ? normalized : null;
}

export function jsonCellInfo(value, dataType = '', { allowJavaLong = false } = {}) {
  if (value === null || value === undefined) return null;
  let raw;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
    const parsed = JSON.parse(raw);
    const declared = /(?:^|[^a-z0-9_])jsonb?(?:$|[^a-z0-9_])/i.test(dataType);
    return declared || (parsed !== null && typeof parsed === 'object') ? { raw } : null;
  } catch {
    if (!allowJavaLong || typeof raw !== 'string') return null;
    const normalized = withoutJavaLongSuffixes(raw);
    if (normalized === null) return null;
    try {
      const parsed = JSON.parse(normalized);
      return parsed !== null && typeof parsed === 'object' ? { raw, compatible: true } : null;
    } catch { return null; }
  }
}
