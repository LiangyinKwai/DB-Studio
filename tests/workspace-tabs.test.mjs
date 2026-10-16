import test from "node:test";
import assert from "node:assert/strict";
import { MAX_QUERY_TABS, restorableWorkspaceTabs } from "../src/workspace-tabs.js";

const target = { id: "public.orders", database: "app", schema: "public", name: "orders", kind: "table" };
const structure = { id: "structure", sql: "", title: "结构 · orders", connectionId: "dev", database: "app",
  schema: "public", openedObject: target, openedObjectView: "structure", tableView: false };

test("startup skips structure inspectors but preserves SQL drafts and table browsers in order", () => {
  const query = { id: "query", sql: "SELECT 1;", title: "查询 1", connectionId: "dev", schema: "public" };
  const table = { id: "table", sql: "SELECT * FROM orders;", browse: target, openedObjectView: "data", tableView: true };
  assert.deepEqual(restorableWorkspaceTabs([structure, query, table]), [query, table]);
  assert.deepEqual(restorableWorkspaceTabs([structure]), []);
  assert.deepEqual(restorableWorkspaceTabs([{ ...structure, title: "Renamed inspector" }]), []);
});

test("startup skips old empty structure tabs even when their object metadata was missing", () => {
  assert.deepEqual(restorableWorkspaceTabs([{ id: "old", title: "结构 · orders", sql: "\n  " }]), []);
  assert.deepEqual(restorableWorkspaceTabs([{ id: "old", title: "other", sql: "", structureOnly: true }]), []);
  const sql = '-- "public"."orders"\n-- 在此编写索引、约束或其他结构变更 SQL。\n';
  assert.deepEqual(restorableWorkspaceTabs([{ ...structure, sql }]), []);
});

test("SQL entered into a broken restored structure tab survives as a generic draft", () => {
  for (const original of [structure, { title: structure.title, id: "legacy", sql: "" }]) {
    const sql = "-- My work\nSELECT 42;";
    const [draft] = restorableWorkspaceTabs([{ ...original, sql }]);
    assert.equal(draft.sql, sql);
    assert.equal(draft.id, original.id);
    assert.equal(draft.connectionId, original.connectionId);
    assert.equal(draft.database, original.database);
    assert.equal(draft.schema, original.schema);
    assert.equal(draft.title, null);
    assert.equal(draft.openedObject, null);
    assert.equal(draft.openedObjectView, null);
    assert.equal(draft.tableView, false);
  }
});

test("legacy placeholder migration keeps real user SQL and leaves unrelated drafts alone", () => {
  const sql = '-- `app`.`orders`\n-- 在此编写索引、约束或其他结构变更 SQL。\n';
  const query = { id: "query", sql, title: "查询 1" };
  assert.equal(restorableWorkspaceTabs([query])[0].sql, "");
  assert.equal(restorableWorkspaceTabs([{ ...structure, sql: sql + "SELECT 1;" }])[0].sql, sql + "SELECT 1;");
  assert.deepEqual(restorableWorkspaceTabs([{ ...query, sql: "-- My notes" }]), [{ ...query, sql: "-- My notes" }]);
  assert.deepEqual(restorableWorkspaceTabs([null, {}, { ...query, console: true }]), []);
  assert.deepEqual(restorableWorkspaceTabs(null), []);
});

test("restores every supported SQL draft beyond the old 24-tab boundary", () => {
  assert.equal(MAX_QUERY_TABS, 100);
  const drafts = Array.from({ length: MAX_QUERY_TABS }, (_, index) => ({
    id: `query-${index + 1}`, title: `查询 ${index + 1}`, sql: `SELECT ${index + 1};`,
    connectionId: "dev", database: "app", schema: "public",
  }));
  assert.deepEqual(restorableWorkspaceTabs(drafts), drafts);
  assert.deepEqual(restorableWorkspaceTabs(restorableWorkspaceTabs(drafts)), drafts);
});

test("applies the supported limit after removing non-restorable inspectors and invalid tabs", () => {
  const drafts = Array.from({ length: MAX_QUERY_TABS + 1 }, (_, index) => ({
    id: `query-${index + 1}`, sql: `SELECT ${index + 1};`,
  }));
  const saved = drafts.flatMap((draft) => [null, structure, { console: true, sql: "PING" }, draft]);
  assert.deepEqual(restorableWorkspaceTabs(saved), drafts.slice(0, MAX_QUERY_TABS));
});
