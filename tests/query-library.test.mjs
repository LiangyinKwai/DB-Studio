import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUERY_LIBRARY_ENTRIES,
  MAX_QUERY_LIBRARY_IMPORT_BYTES,
  MAX_QUERY_SQL_LENGTH,
  MAX_QUERY_TITLE_LENGTH,
  QUERY_LIBRARY_FORMAT,
  QUERY_LIBRARY_VERSION,
  exportQueryLibrary,
  importQueryLibrary,
  normalizeQueryLibrary,
  removeQueryLibraryEntry,
  renameQueryLibraryEntry,
  upsertQueryLibraryEntry,
} from "../src/query-library.js";

function saved(overrides = {}) {
  return {
    id: "saved-query", title: "查询订单", sql: "SELECT * FROM orders",
    connectionId: "connection-dev", database: "app", schema: "public",
    createdAt: 10, updatedAt: 20, ...overrides,
  };
}

function file(entries, overrides = {}) {
  return JSON.stringify({ format: QUERY_LIBRARY_FORMAT, version: QUERY_LIBRARY_VERSION, entries, ...overrides });
}

test("normalizes bad local data, title aliases, missing IDs and timestamps", () => {
  assert.deepEqual(normalizeQueryLibrary({ entries: [] }), []);
  const input = [null, false, [], { sql: "   " }, { sql: 123 },
    { sql: " SELECT 1 ", name: "  示例  ", createdAt: -1 },
    { sql: "SELECT 2", title: "长".repeat(101), connectionId: 42, database: {}, schema: "" },
    saved({ id: "kept", updatedAt: 5 }),
  ];
  const result = normalizeQueryLibrary(input, 100);
  assert.equal(result.length, 3);
  assert.equal(result[0].title, "示例");
  assert.equal(result[0].sql, "SELECT 1");
  assert.equal(result[0].createdAt, 100);
  assert.equal(result[0].updatedAt, 100);
  assert.equal(result[0].connectionId, null);
  assert.equal(result[1].title.length, MAX_QUERY_TITLE_LENGTH);
  assert.equal(result[1].database, null);
  assert.equal(result[1].schema, "");
  assert.equal(result[2].id, "kept");
  assert.equal(result[2].updatedAt, result[2].createdAt);
  assert.equal(result[0].id, normalizeQueryLibrary(input, 200)[0].id);
  assert.deepEqual(normalizeQueryLibrary(result, 200), result);
  assert.equal(input[5].sql, " SELECT 1 ");
});

test("deduplicates only identical SQL with exact connection, database and schema", () => {
  const entries = normalizeQueryLibrary([
    saved(), saved({ id: "duplicate" }), saved({ id: "saved-query", schema: "shop" }),
    saved({ connectionId: "connection-prod" }), saved({ database: "other" }),
    saved({ schema: null }), saved({ schema: "" }),
  ]);
  assert.equal(entries.length, 6);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.equal(entries[0].id, "saved-query");
  assert.deepEqual(normalizeQueryLibrary(entries), entries);
});

test("bounds local entries and ignores oversized SQL", () => {
  const entries = Array.from({ length: MAX_QUERY_LIBRARY_ENTRIES + 1 }, (_, index) => saved({ sql: `SELECT ${index}` }));
  assert.equal(normalizeQueryLibrary(entries).length, MAX_QUERY_LIBRARY_ENTRIES);
  assert.deepEqual(normalizeQueryLibrary([saved({ sql: "x".repeat(MAX_QUERY_SQL_LENGTH + 1) })]), []);
});

test("upsert moves an existing favorite forward while preserving identity and original creation", () => {
  const original = [saved({ sql: "SELECT 2", id: "second" }), saved()];
  const updated = upsertQueryLibraryEntry(original, saved({ id: "different", name: "名称别名", title: undefined, createdAt: 70 }), 100);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].id, "saved-query");
  assert.equal(updated[0].createdAt, 10);
  assert.equal(updated[0].updatedAt, 100);
  assert.equal(updated[0].title, "名称别名");
  assert.equal(original[1].title, "查询订单");
  assert.equal(upsertQueryLibraryEntry(updated, { sql: updated[0].sql, connectionId: "connection-dev", database: "app", schema: "public" }, 101)[0].title, "名称别名");
  assert.equal(upsertQueryLibraryEntry(updated, saved({ schema: "other" }), 101).length, 3);
  assert.throws(() => upsertQueryLibraryEntry(updated, { sql: " " }), /SQL/);
});

test("saving at capacity never silently removes an existing favorite", () => {
  const entries = normalizeQueryLibrary(Array.from({ length: MAX_QUERY_LIBRARY_ENTRIES }, (_, index) => saved({ sql: `SELECT ${index}` })));
  assert.throws(() => upsertQueryLibraryEntry(entries, saved({ sql: "SELECT new" })), /200/);
  assert.equal(upsertQueryLibraryEntry(entries, entries[199]).length, MAX_QUERY_LIBRARY_ENTRIES);
  assert.equal(entries[0].sql, "SELECT 0");
});

test("rename and remove are explicit, target one ID and leave inputs untouched", () => {
  const entries = [saved(), saved({ id: "other", schema: "other" })];
  const renamed = renameQueryLibraryEntry(entries, "saved-query", "  常用订单  ", 100);
  assert.equal(renamed[0].title, "常用订单");
  assert.equal(renamed[0].id, "saved-query");
  assert.equal(renamed[0].updatedAt, 100);
  assert.equal(renamed[1].title, "查询订单");
  assert.equal(entries[0].title, "查询订单");
  assert.throws(() => renameQueryLibraryEntry(entries, "saved-query", " "), /名称/);
  assert.throws(() => renameQueryLibraryEntry(entries, "saved-query", "x".repeat(101)), /100/);
  assert.deepEqual(removeQueryLibraryEntry(renamed, "saved-query"), [renamed[1]]);
  assert.deepEqual(removeQueryLibraryEntry(renamed, "missing"), renamed);
});

test("versioned export round trips all target fields and drops untrusted extras", () => {
  const entries = [saved({ password: "never export", database: " app ", schema: " " })];
  const text = exportQueryLibrary(entries);
  const document = JSON.parse(text);
  assert.equal(document.format, "db-studio-query-library");
  assert.equal(document.version, 1);
  assert.equal(text.includes("never export"), false);
  const result = importQueryLibrary([], text);
  assert.deepEqual(result.entries, normalizeQueryLibrary(entries));
  assert.deepEqual({ ...result, entries: undefined }, { entries: undefined, imported: 1, updated: 0, skipped: 0, total: 1 });
  assert.equal(result.entries[0].connectionId, "connection-dev");
  assert.equal(result.entries[0].database, " app ");
  assert.equal(result.entries[0].schema, " ");
});

test("import validates the complete envelope and every row before merging", () => {
  const local = [saved()];
  const original = structuredClone(local);
  const invalidFiles = [null, "", "{", "[]", "null", file([], { format: "other" }), file([], { version: 2 }),
    file({}, {}), file([saved({ sql: "SELECT new" }), saved({ sql: " " })]),
    file([saved({ id: "" })]), file([saved({ title: "" })]), file([saved({ title: "x".repeat(101) })]),
    file([saved({ sql: "x".repeat(MAX_QUERY_SQL_LENGTH + 1) })]),
    file([saved({ connectionId: { name: "same-named-connection" } })]),
    file([saved({ connectionId: " " })]), file([saved({ database: "" })]),
    file([saved({ schema: undefined })]), file([saved({ updatedAt: 1 })]), file([saved({ createdAt: "10" })]),
    file(Array.from({ length: MAX_QUERY_LIBRARY_ENTRIES + 1 }, () => saved())),
    " ".repeat(MAX_QUERY_LIBRARY_IMPORT_BYTES + 1),
  ];
  for (const text of invalidFiles) assert.throws(() => importQueryLibrary(local, text));
  assert.deepEqual(local, original);
});

test("import accounts for UTF-8 byte size, including multibyte data", () => {
  const text = `"${"汉".repeat(Math.floor(MAX_QUERY_LIBRARY_IMPORT_BYTES / 3) + 1)}"`;
  assert.ok(text.length < MAX_QUERY_LIBRARY_IMPORT_BYTES);
  assert.throws(() => importQueryLibrary([], text), /MB/);
});

test("import merges newer items, preserves local IDs and skips older and duplicate rows", () => {
  const local = [saved()];
  const result = importQueryLibrary(local, file([
    saved({ id: "remote-id", title: "最新名称", createdAt: 12, updatedAt: 40 }),
    saved({ id: "duplicate", title: "不会覆盖", updatedAt: 30 }),
    saved({ id: "saved-query", connectionId: "missing-connection", title: "不同目标" }),
  ]));
  assert.equal(result.imported, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 2);
  assert.equal(result.entries[0].id, "saved-query");
  assert.equal(result.entries[0].createdAt, 10);
  assert.equal(result.entries[0].title, "最新名称");
  assert.equal(result.entries[1].connectionId, "missing-connection");
  assert.notEqual(result.entries[1].id, result.entries[0].id);
  assert.deepEqual(local, [saved()]);
  const repeated = importQueryLibrary(result.entries, exportQueryLibrary(result.entries));
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.updated, 0);
  assert.equal(repeated.skipped, 2);
  assert.equal(importQueryLibrary(result.entries, file([saved({ title: "旧名称" })])).entries[0].title, "最新名称");
});

test("import chooses the newest incoming duplicate before comparing against local data", () => {
  const result = importQueryLibrary([saved()], file([
    saved({ title: "旧名称", updatedAt: 15 }),
    saved({ title: "最新名称", updatedAt: 50 }),
  ]));
  assert.equal(result.entries[0].title, "最新名称");
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
});

test("import keeps every valid local item at capacity and reports skipped incoming items", () => {
  const local = normalizeQueryLibrary(Array.from({ length: MAX_QUERY_LIBRARY_ENTRIES }, (_, index) => saved({ sql: `SELECT ${index}` })));
  const result = importQueryLibrary(local, file([saved({ sql: "SELECT new" })]));
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, MAX_QUERY_LIBRARY_ENTRIES);
  assert.deepEqual(result.entries, local);
});
