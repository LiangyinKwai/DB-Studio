export const MAX_RESULT_BYTES = 24 * 1024 * 1024;
export const MAX_CACHED_RESULTS = 6;

/** Approximate retained JSON values without creating a second serialized copy. */
export function estimateResultBytes(result) {
  const pending = [result?.columns, result?.rows];
  const seen = new WeakSet();
  let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number") bytes += 8;
    else if (typeof value === "boolean") bytes += 4;
    else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      // Include container/reference overhead as well as UTF-16 text. This is a
      // cache budget estimate; JavaScript engines may use different layouts.
      bytes += 16;
      if (Array.isArray(value)) {
        bytes += value.length * 8;
        for (const item of value) pending.push(item);
      } else {
        for (const key of Object.keys(value)) {
          bytes += key.length * 2 + 8;
          pending.push(value[key]);
        }
      }
    }
  }
  return bytes;
}

/** Release oldest results until the budget is met, preserving protected work. */
export function selectResultsToRelease(tabs, { activeTab, currentTab, isProtected } = {}) {
  const cached = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab?.result?.executed);
  // Key inspectors are often just a few bytes. The query-count cap must not
  // evict those tiny values; they still share the overall byte budget.
  const countsAsQuery = tab => typeof tab.redisKey !== 'string';
  let count = cached.filter(countsAsQuery).length;
  let bytes = cached.reduce((sum, tab) => sum + resultBytes(tab.result), 0);
  const candidates = cached.filter((tab) => tab !== activeTab && tab !== currentTab &&
    !tab.running && !tab.refreshing && !tab.cellSaving && !tab.cellBatchSaving && !tab.result.cellEditsInTransaction &&
    !isProtected?.(tab));
  candidates.sort((left, right) => finishedAt(left.result) - finishedAt(right.result));
  const release = [];
  for (const tab of candidates) {
    if (count <= MAX_CACHED_RESULTS && bytes <= MAX_RESULT_BYTES) break;
    if (bytes <= MAX_RESULT_BYTES && !countsAsQuery(tab)) continue;
    release.push(tab);
    if (countsAsQuery(tab)) count -= 1;
    bytes -= resultBytes(tab.result);
  }
  return release;
}

function resultBytes(result) {
  return Number.isFinite(result.bytes) && result.bytes >= 0 ? result.bytes : estimateResultBytes(result);
}

function finishedAt(result) {
  return Number.isFinite(result.finishedAt) ? result.finishedAt : 0;
}
