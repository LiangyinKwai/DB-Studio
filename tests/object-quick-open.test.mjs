import assert from "node:assert/strict";
import test from "node:test";
import { collectQuickOpenEntries, parseObjectQuery, searchQuickOpenEntries } from "../src/object-quick-open.js";

const entries = [
  { name: "orders", kind: "table", database: "shop", schema: "public", connectionName: "开发环境", columns: [{ name: "customer_id" }, { name: "shipping_id" }] },
  { name: "order_totals", kind: "view", database: "shop", schema: "analytics", connectionName: "开发环境", columns: [{ name: "amount" }] },
  { name: "customer_orders", kind: "table", database: "shop", schema: "public", connectionName: "生产环境", columns: [{ name: "order_id" }] },
  { name: "users", kind: "table", database: "accounts", schema: "public", connectionName: "开发环境", columns: [{ name: "order_count" }] },
  { name: "session:orders:1", kind: "redis-key", driver: "redis", database: 0, connectionName: "缓存", columns: [] },
];

test("object search ranks names above matching fields and scopes without mutating input", () => {
  const result = searchQuickOpenEntries(entries, "order");
  assert.deepEqual(result.matches.map(({ entry }) => entry.name), ["orders", "order_totals", "customer_orders", "session:orders:1", "users"]);
  assert.deepEqual(result.matches.at(-1).matchedColumns, ["order_count"]);
  assert.equal(entries[0].name, "orders");
  assert.deepEqual(searchQuickOpenEntries(entries, "ＳＨＯＰ order db:shop schema:public conn:开发").matches.map(({ entry }) => entry.name), ["orders"]);
});

test("qualified paths, types, field qualifiers and multiple terms all constrain results", () => {
  assert.equal(searchQuickOpenEntries(entries, "shop.analytics.order type:view").matches[0].entry, entries[1]);
  const fields = searchQuickOpenEntries(entries, "col:id shipping db:shop").matches;
  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0].matchedColumns, ["customer_id", "shipping_id"]);
  assert.equal(searchQuickOpenEntries(entries, "type:视图").matches[0].entry, entries[1]);
  assert.equal(searchQuickOpenEntries(entries, "db:accounts schema:analytics").total, 0);
});

test("Redis DB zero, colon names and quoted scope names remain searchable", () => {
  assert.equal(searchQuickOpenEntries(entries, "db:DB0 session:orders").matches[0].entry, entries[4]);
  assert.deepEqual(parseObjectQuery('db:"Sales Analytics" schema:\'Order Data\' col:id'), [
    { field: "db", value: "sales analytics" }, { field: "schema", value: "order data" }, { field: "col", value: "id" },
  ]);
  assert.deepEqual(parseObjectQuery("session:orders"), [{ field: null, value: "session:orders" }]);
});

test("empty searches preserve loaded order and result rendering has a hard safe cap", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ name: `table_${index}`, columns: [] }));
  const result = searchQuickOpenEntries(many);
  assert.equal(result.total, 200);
  assert.equal(result.matches.length, 80);
  assert.equal(result.truncated, true);
  assert.equal(searchQuickOpenEntries(many, "", { limit: 10000 }).matches.length, 120);
  assert.equal(searchQuickOpenEntries(many, "", { limit: NaN }).matches.length, 80);
  assert.equal(searchQuickOpenEntries(many, "", { limit: 0 }).matches.length, 1);
  assert.deepEqual(searchQuickOpenEntries(entries, " ").matches.map(({ entry }) => entry), entries);
});

test("collects connected caches across drivers and preserves DB scope, overloads and original objects", () => {
  const table = { id: "public.orders", name: "orders", schema: "public", kind: "table", columns: [{ name: "id" }] };
  const overloads = ["(integer)", "(text)"].map((signature, index) => ({ id: `fn${index}`, name: "lookup", signature: `lookup${signature}`, schema: "public", kind: "function" }));
  const options = {
    profiles: [{ id: "mysql", name: "本地", driver: "mysql" }, { id: "pg", name: "开发", driver: "postgres" }, { id: "redis", name: "缓存", driver: "redis" }, { id: "offline", name: "旧连接" }],
    activeConnectionId: "pg", connectionStatuses: { pg: "connected", mysql: "connected", redis: "connected", offline: "disconnected" },
    objectsBySchema: new Map([["app\u0000public", [table, ...overloads]]]),
    treeSessions: new Map([
      ["mysql", { objectsBySchema: new Map([["shop\u0000shop", [{ id: "shop.orders", name: "orders", schema: "shop", kind: "table" }]]]) }],
      ["redis", { redisPages: new Map([[0, { keys: ["session:1"] }], [1, { keys: ["session:1"] }]]) }],
      ["offline", { objectsBySchema: new Map([["old\u0000public", [table]]]) }],
    ]),
    queryTargets: new Map([["pg\u0000app", { objects: [table], context: { database: "app" } }], ["pg\u0000other", { objects: [table], context: { database: "other" } }]]),
  };
  const result = collectQuickOpenEntries(options);
  assert.equal(result.length, 7);
  assert.equal(result[0].object, table);
  assert.equal(result[0].database, "app");
  assert.equal(result.filter(({ kind }) => kind === "function").length, 2);
  assert.equal(result.filter(({ driver }) => driver === "redis").length, 2);
  assert.deepEqual(result.filter(({ driver }) => driver === "redis").map(({ database }) => database), [0, 1]);
  assert.equal(result.some(({ connectionId }) => connectionId === "offline"), false);
});

test("active Redis cache and completion metadata enrich entries without fetching remote data", () => {
  const result = collectQuickOpenEntries({
    profiles: [{ id: "redis", name: "缓存", driver: "redis" }], activeConnectionId: "redis", connectionStatuses: { redis: "connected" },
    redisPages: new Map([[0, { keys: ["", { key: "json:1", type: "string" }], cursor: 28 }]]),
  });
  assert.deepEqual(result.map(({ name }) => name), ["", "json:1"]);
  assert.equal(result[1].type, "string");
  assert.equal(collectQuickOpenEntries().length, 0);
});
test('Redis TYPE metadata is scoped to its cached DB and participates in type filtering', () => {
  const entries = collectQuickOpenEntries({ profiles: [{ id: 'r', driver: 'redis', name: 'Redis' }], activeConnectionId: 'r', connectionStatuses: { r: 'connected' }, redisPages: new Map([[0, { keys: ['same'], keyTypes: new Map([['same', 'string']]) }], [1, { keys: ['same'], keyTypes: new Map([['same', 'hash']]) }]]) });
  assert.deepEqual(searchQuickOpenEntries(entries, 'db:0 type:string').matches.map(item => item.entry.database), [0]);
  assert.deepEqual(searchQuickOpenEntries(entries, 'db:1 type:hash').matches.map(item => item.entry.database), [1]);
  assert.equal(searchQuickOpenEntries(entries, 'db:0 type:hash').total, 0);
});
