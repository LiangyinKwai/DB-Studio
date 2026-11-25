export const MAX_HISTORY_ENTRIES = 10;

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function timestampOrNow(value) {
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

/** Normalize local history data so stale or malformed storage never reaches the UI. */
export function normalizeHistory(value, limit = MAX_HISTORY_ENTRIES) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const sql = textOrNull(entry?.sql);
    const key = JSON.stringify([sql, textOrNull(entry?.connectionId), textOrNull(entry?.database), typeof entry?.schema === "string" ? entry.schema : null]);
    if (!sql || seen.has(key)) continue;
    seen.add(key);
    result.push({
      sql,
      connectionId: textOrNull(entry?.connectionId),
      database: textOrNull(entry?.database),
      schema: typeof entry?.schema === "string" ? entry.schema : null,
      timestamp: timestampOrNow(entry?.timestamp),
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function prependHistoryEntry(history, entry, limit = MAX_HISTORY_ENTRIES) {
  const sql = textOrNull(entry?.sql);
  if (!sql) return normalizeHistory(history, limit);
  return normalizeHistory(
    [
      {
        sql,
        connectionId: entry?.connectionId,
        database: entry?.database,
        schema: entry?.schema,
        timestamp: entry?.timestamp,
      },
      ...(Array.isArray(history) ? history : []),
    ],
    limit,
  );
}

/** Resolve the connection ID used by both current and pre-v2 history entries. */
export function historyConnectionId(entry, profiles = []) {
  if (entry?.connectionId) return entry.connectionId;
  const legacyId = entry?.database;
  return profiles.some((profile) => profile?.id === legacyId) ? legacyId : null;
}

export function historyDatabase(entry, profiles = []) {
  const connectionId = historyConnectionId(entry, profiles);
  const profile = profiles.find((item) => item.id === connectionId);
  // v1 stored the connection ID in `database`; recover the actual saved
  // database when opening those older history entries.
  if (!entry?.connectionId && connectionId && entry?.database === connectionId)
    return profile?.database || null;
  return entry?.database || profile?.database || null;
}

export function historyContext(entry, profiles = []) {
  const connectionId = historyConnectionId(entry, profiles);
  const profile = profiles.find((item) => item.id === connectionId);
  const database = historyDatabase(entry, profiles);
  const parts = [profile?.name || profile?.driver, profile?.driver === "redis" && database != null ? `DB ${database}` : database, entry?.schema];
  return parts.filter((part) => part).join(" · ") || "本地历史";
}
