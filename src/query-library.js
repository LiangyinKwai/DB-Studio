export const QUERY_LIBRARY_FORMAT = "db-studio-query-library";
export const QUERY_LIBRARY_VERSION = 1;
export const MAX_QUERY_LIBRARY_ENTRIES = 200;
export const MAX_QUERY_TITLE_LENGTH = 100;
export const MAX_QUERY_SQL_LENGTH = 100_000;
export const MAX_QUERY_LIBRARY_IMPORT_BYTES = 16 * 1024 * 1024;

const MAX_ID_LENGTH = 128;
const MAX_TARGET_LENGTH = 512;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function currentTimestamp(value) {
  return validTimestamp(value) ? value : Date.now();
}

function queryText(value) {
  if (typeof value !== "string") return null;
  const sql = value.trim();
  return sql && sql.length <= MAX_QUERY_SQL_LENGTH ? sql : null;
}

function targetText(value, preserveEmpty = false) {
  if (typeof value !== "string" || value.length > MAX_TARGET_LENGTH) return null;
  return preserveEmpty || value.trim() ? value : null;
}

function entryTitle(entry, sql) {
  const title = [entry.title, entry.name].find((value) => typeof value === "string" && value.trim());
  return (title?.trim() || sql.split(/\r?\n/, 1)[0]).slice(0, MAX_QUERY_TITLE_LENGTH);
}

function entryKey(entry) {
  return JSON.stringify([entry.sql, entry.connectionId, entry.database, entry.schema]);
}

function validId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

// A persisted legacy item without an ID keeps its identity between reads.
function generatedId(key) {
  let hash = 2166136261;
  let second = 5381;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    hash = Math.imul(hash ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `query-${(hash >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

function availableId(preferred, key, usedIds) {
  const base = validId(preferred) && !usedIds.has(preferred) ? preferred : generatedId(key);
  let id = base;
  for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** Recover valid local entries without trusting the shape of persisted storage. */
export function normalizeQueryLibrary(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const timestamp = currentTimestamp(now);
  const seenKeys = new Set();
  const usedIds = new Set();
  const entries = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sql = queryText(item.sql);
    if (!sql) continue;
    const createdAt = validTimestamp(item.createdAt) ? item.createdAt : timestamp;
    const entry = {
      title: entryTitle(item, sql),
      sql,
      connectionId: targetText(item.connectionId),
      database: targetText(item.database),
      schema: targetText(item.schema, true),
      createdAt,
      updatedAt: Math.max(createdAt, validTimestamp(item.updatedAt) ? item.updatedAt : createdAt),
    };
    const key = entryKey(entry);
    if (seenKeys.has(key)) continue;
    const id = availableId(item.id, key, usedIds);
    entries.push({ id, ...entry });
    seenKeys.add(key);
    usedIds.add(id);
    if (entries.length >= MAX_QUERY_LIBRARY_ENTRIES) break;
  }
  return entries;
}

/** Save one query. Matching SQL and exact target updates the existing favorite. */
export function upsertQueryLibraryEntry(value, item, now = Date.now()) {
  if (!isRecord(item) || !queryText(item.sql)) {
    throw new Error(`查询 SQL 不能为空，且不能超过 ${MAX_QUERY_SQL_LENGTH} 个字符。`);
  }
  const timestamp = currentTimestamp(now);
  const entries = normalizeQueryLibrary(value, timestamp);
  const [candidate] = normalizeQueryLibrary([item], timestamp);
  const key = entryKey(candidate);
  const existing = entries.find((entry) => entryKey(entry) === key);
  if (!existing && entries.length >= MAX_QUERY_LIBRARY_ENTRIES) {
    throw new Error(`查询收藏已达到 ${MAX_QUERY_LIBRARY_ENTRIES} 条上限，请先删除不再需要的收藏。`);
  }
  const entry = {
    ...candidate,
    id: existing?.id || availableId(candidate.id, key, new Set(entries.map((saved) => saved.id))),
    title: existing && ![item.title, item.name].some((title) => typeof title === "string" && title.trim())
      ? existing.title : candidate.title,
    createdAt: existing?.createdAt || candidate.createdAt,
    updatedAt: Math.max(timestamp, candidate.updatedAt, existing?.updatedAt || 0),
  };
  return [entry, ...entries.filter((saved) => entryKey(saved) !== key)];
}

export function renameQueryLibraryEntry(value, id, title, now = Date.now()) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > MAX_QUERY_TITLE_LENGTH) {
    throw new Error(`收藏名称不能为空，且不能超过 ${MAX_QUERY_TITLE_LENGTH} 个字符。`);
  }
  const timestamp = currentTimestamp(now);
  return normalizeQueryLibrary(value, timestamp).map((entry) => entry.id === id
    ? { ...entry, title: title.trim(), updatedAt: Math.max(timestamp, entry.updatedAt) }
    : entry);
}

export function removeQueryLibraryEntry(value, id) {
  return normalizeQueryLibrary(value).filter((entry) => entry.id !== id);
}

function assertTextSize(text) {
  // Check UTF-16 length first to avoid allocating a large encoded copy for bad input.
  if (text.length > MAX_QUERY_LIBRARY_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_QUERY_LIBRARY_IMPORT_BYTES) {
    throw new Error(`查询库文件不能超过 ${MAX_QUERY_LIBRARY_IMPORT_BYTES / 1024 / 1024} MB。`);
  }
}

export function exportQueryLibrary(value) {
  const text = JSON.stringify({
    format: QUERY_LIBRARY_FORMAT,
    version: QUERY_LIBRARY_VERSION,
    entries: normalizeQueryLibrary(value),
  }, null, 2);
  assertTextSize(text);
  return text;
}

function validateImportEntry(entry, index) {
  const location = `第 ${index + 1} 条收藏`;
  if (!isRecord(entry) || !validId(entry.id) || typeof entry.title !== "string"
    || !entry.title.trim() || entry.title.length > MAX_QUERY_TITLE_LENGTH
    || !queryText(entry.sql) || entry.sql.length > MAX_QUERY_SQL_LENGTH
    || !validTimestamp(entry.createdAt) || !validTimestamp(entry.updatedAt)
    || entry.updatedAt < entry.createdAt) {
    throw new Error(`${location}格式无效，请使用 DB Studio 导出的查询库文件。`);
  }
  for (const field of ["connectionId", "database", "schema"]) {
    if (entry[field] !== null && (typeof entry[field] !== "string" || entry[field].length > MAX_TARGET_LENGTH
      || (field !== "schema" && !entry[field].trim()))) {
      throw new Error(`${location}的目标信息无效。`);
    }
  }
}

/**
 * Validate the entire file before merging. IDs never resolve against connection names.
 * Local items win timestamp ties; items over capacity and duplicate imports are skipped.
 * Counts describe unique new/updated entries and all skipped incoming rows.
 */
export function importQueryLibrary(value, text) {
  if (typeof text !== "string") throw new Error("请选择有效的 JSON 查询库文件。");
  assertTextSize(text);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("查询库文件不是有效的 JSON。");
  }
  if (!isRecord(document) || document.format !== QUERY_LIBRARY_FORMAT
    || document.version !== QUERY_LIBRARY_VERSION || !Array.isArray(document.entries)) {
    throw new Error("不支持此查询库格式或版本，请使用 DB Studio 导出的版本 1 文件。");
  }
  if (document.entries.length > MAX_QUERY_LIBRARY_ENTRIES) {
    throw new Error(`查询库文件最多可包含 ${MAX_QUERY_LIBRARY_ENTRIES} 条收藏。`);
  }
  document.entries.forEach(validateImportEntry);

  const entries = normalizeQueryLibrary(value);
  const positions = new Map(entries.map((entry, index) => [entryKey(entry), index]));
  const usedIds = new Set(entries.map((entry) => entry.id));
  const incomingEntries = new Map();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of document.entries) {
    const [incoming] = normalizeQueryLibrary([raw]);
    const key = entryKey(incoming);
    const duplicate = incomingEntries.get(key);
    if (duplicate) {
      skipped += 1;
      if (incoming.updatedAt > duplicate.updatedAt) incomingEntries.set(key, incoming);
    } else {
      incomingEntries.set(key, incoming);
    }
  }
  for (const [key, incoming] of incomingEntries) {
    const position = positions.get(key);
    if (position !== undefined) {
      const existing = entries[position];
      if (incoming.updatedAt <= existing.updatedAt) {
        skipped += 1;
        continue;
      }
      entries[position] = { ...incoming, id: existing.id, createdAt: existing.createdAt };
      updated += 1;
    } else if (entries.length < MAX_QUERY_LIBRARY_ENTRIES) {
      const id = availableId(incoming.id, key, usedIds);
      positions.set(key, entries.length);
      entries.push({ ...incoming, id });
      usedIds.add(id);
      imported += 1;
    } else {
      skipped += 1;
    }
  }
  return { entries, imported, updated, skipped, total: entries.length };
}
