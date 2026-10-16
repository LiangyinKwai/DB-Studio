import assert from "node:assert/strict";
import test from "node:test";
import {
  historyConnectionId,
  historyContext,
  historyDatabase,
  normalizeHistory,
  prependHistoryEntry,
} from "../src/query-history.js";

test("normalizes, trims, and deduplicates persisted history", () => {
  const history = normalizeHistory([
    { sql: "  SELECT 1  ", database: "app", timestamp: 12 },
    { sql: "SELECT 1", database: "app", timestamp: 13 },
    { sql: "", database: "ignored" },
    null,
    { sql: "SELECT 2", connectionId: "conn-dev", timestamp: 0 },
  ]);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], {
    sql: "SELECT 1",
    connectionId: null,
    database: "app",
    schema: null,
    timestamp: 12,
  });
  assert.equal(history[1].sql, "SELECT 2");
  assert.ok(history[1].timestamp > 0);
});

test("new history entries move to the front and stay bounded", () => {
  const history = prependHistoryEntry(
    [{ sql: "SELECT old" }, { sql: "SELECT keep" }],
    { sql: " SELECT new ", connectionId: "conn-dev", database: "app" },
    2,
  );
  assert.deepEqual(history.map((entry) => entry.sql), ["SELECT new", "SELECT old"]);
  assert.equal(history[0].connectionId, "conn-dev");
});

test("resolves both v2 connection IDs and legacy database fields", () => {
  const profiles = [{ id: "conn-dev", name: "开发库", driver: "postgres" }];
  assert.equal(historyConnectionId({ connectionId: "conn-dev" }, profiles), "conn-dev");
  assert.equal(historyConnectionId({ database: "conn-dev" }, profiles), "conn-dev");
  assert.equal(historyConnectionId({ database: "app" }, profiles), null);
  assert.equal(historyDatabase({ database: "conn-dev" }, [{ ...profiles[0], database: "app" }]), "app");
  assert.equal(historyContext({ connectionId: "conn-dev", database: "app" }, profiles), "开发库 · app");
});


test("keeps identical SQL bound to different schemas and connections", () => {
  const history = normalizeHistory([
    { sql: "SELECT * FROM orders", connectionId: "dev", database: "app", schema: "shop" },
    { sql: "SELECT * FROM orders", connectionId: "dev", database: "app", schema: "public" },
    { sql: "SELECT * FROM orders", connectionId: "prod", database: "app", schema: "shop" },
  ]);
  assert.equal(history.length, 3);
  assert.equal(history[0].schema, "shop");
  assert.equal(historyContext(history[0], [{ id: "dev", name: "开发库" }]), "开发库 · app · shop");
});
