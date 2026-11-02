/** Search words are literal substrings. Escape Redis MATCH metacharacters so
 * server-side SCAN and the visible list use identical, case-sensitive rules. */
export function redisKeySearchPattern(text = '') {
  const value = String(text);
  return value ? `*${value.replace(/[\\*?\[\]]/g, '\\$&')}*` : '';
}
export function redisKeyMatchesSearch(key, text = '') {
  return String(key).includes(String(text));
}

/** Limit parallel DB scans and stop queued work after a search is superseded. */
export async function searchRedisDatabases(databases, visit, current, concurrency = 3) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, databases.length) }, async () => {
    while (current()) {
      const index = next++;
      if (index >= databases.length) return;
      await visit(databases[index]);
    }
  }));
}
