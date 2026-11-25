import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { resolveRedisDatabase } from "../src/redis-target.js";

const profile = { id: "redis", driver: "redis", database: "0", redisDb: 0 };
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
function sourceBetween(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing function boundary: ${start}`);
  return mainSource.slice(from, to);
}
function fixture(inherited = null) {
  const state = { tabs: [], profiles: [profile, { id: "pg", driver: "postgres", database: "app" }], activeConnectionId: "redis" };
  const runtime = vm.createContext({
    state, resolveRedisDatabase, MAX_QUERY_TABS: 20,
    refs: { objectTree: { querySelector: () => null } },
    activeExecutionTab: () => inherited,
    activeTab: () => inherited,
    tabDatabase: tab => tab?.database,
    tabSchema: tab => tab?.schema ?? null,
    queryDatabaseOptions: () => null,
    prepareInitialQuerySchema() {},
    showToast() {}, treeTargetFromNode() {},
    objectTabTarget: object => object || null,
    makeId: () => `query-${state.tabs.length + 1}`,
    nextQueryNumber: () => state.tabs.length + 1,
    emptyResult: () => ({}),
    activateTab() {},
  });
  vm.runInContext(sourceBetween("function redisProfileDatabase(profile) {", "function showToast(")
    + sourceBetween("function addTab(", "async function closeTab("), runtime);
  return runtime;
}

test("history and restored Redis tabs honor their saved database without redisDb", () => {
  assert.equal(resolveRedisDatabase({ database: "7" }, profile), 7);
  assert.equal(resolveRedisDatabase({ database: 1 }, profile), 1);
  assert.equal(resolveRedisDatabase({ database: "0" }, { ...profile, redisDb: 4 }), 0);
  assert.equal(resolveRedisDatabase({ redisDb: 3, database: "1" }, profile), 3);
});

test("invalid or absent Redis targets fall back to the saved profile", () => {
  for (const database of [null, undefined, "", " ", "-1", "1.5", "Infinity", true, 2_147_483_648]) {
    assert.equal(resolveRedisDatabase({ database }, { ...profile, redisDb: 5 }), 5);
  }
  assert.equal(resolveRedisDatabase(null, { database: "8" }), 8);
  assert.equal(resolveRedisDatabase(null, null), 0);
});

test("blank consoles always use the profile default even after browsing DB 1", () => {
  for (const source of [{ redisKey: "shared:key" }, { console: true }]) {
    const runtime = fixture({ ...source, connectionId: "redis", redisDb: 1, database: "1" });
    runtime.state.redisActiveDatabase = 1;
    runtime.state.redisConsole = { connectionId: "redis", redisDb: 1 };
    assert.equal(runtime.addTab().redisDb, 0);
    runtime.state.profiles[0] = { ...profile, redisDb: 5 };
    assert.equal(runtime.addTab().redisDb, 5);
    assert.equal(runtime.addTab("", "redis", null, { newQuery: true, database: 0 }).redisDb, 0);
  }
});

test("opening Redis history uses its database even with another active query", () => {
  const runtime = fixture({ connectionId: "redis", redisDb: 2, database: "2" });
  const tab = runtime.addTab("GET shared:key", "redis", null, { database: "1" });
  assert.equal(tab.database, "1");
  assert.equal(tab.redisDb, 1);
  assert.equal(runtime.redisTabDatabase(tab), 1);
});

test("new queries follow the browser when the active tab uses another instance", () => {
  const runtime = fixture({ connectionId: "pg", database: "commerce", schema: "sales" });
  const tab = runtime.addTab();
  assert.equal(tab.connectionId, "redis");
  assert.equal(tab.database, "0");
  assert.equal(tab.schema, null);
});

test("without a browser selection, new PostgreSQL tabs reuse the current connection and resolve their own target", () => {
  const runtime = fixture({ connectionId: "pg", database: "commerce", schema: "sales" });
  runtime.state.activeConnectionId = null;
  const tab = runtime.addTab();
  assert.equal(tab.connectionId, "pg");
  assert.equal(tab.database, null);
  assert.equal(tab.schema, null);
  assert.equal(tab.awaitingDatabase, true);
  assert.equal(tab.redisDb, null);
});
