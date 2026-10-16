import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { PostgreSQL, MySQL, sql } from "@codemirror/lang-sql";
import { buildCompletionSchema, catalogCompletionSource, objectMatchesSearch, matchingColumns, queryStructureObjects } from "../src/sql-catalog.js";

const objects = [
  { database: "app", schema: "public", name: "orders", kind: "table", columns: [{ name: "id", dataType: "bigint" }, { name: "status", dataType: "text", comment: "订单状态" }] },
  { database: "other", schema: "public", name: "orders", kind: "table", columns: [{ name: "private_column" }] },
];

const structureCatalog = [...objects,
  { ...objects[0], schema: "analytics" },
  { ...objects[0], schema: "analytics", name: "events" },
  { ...objects[0], name: "exact_100" },
  { ...objects[0], schema: 'app.data', name: 'Order."Items' },
];
const structureNames = (text, options = {}) => queryStructureObjects(text, structureCatalog,
  { database: "app", schema: "public", ...options }).referenced.map((object) => `${object.schema}.${object.name}`);

test("structure inspection resolves SQL relations, schemas, aliases and nested queries", () => {
  assert.deepEqual(structureNames("SELECT * FROM orders"), ["public.orders"]);
  assert.deepEqual(structureNames("SELECT * FROM orders", { schema: "analytics" }), ["analytics.orders"]);
  assert.deepEqual(structureNames("SELECT * FROM orders", { schema: null, searchPath: ["missing", "analytics", "public"] }), ["analytics.orders"]);
  assert.deepEqual(structureNames('SELECT * FROM public.orders o JOIN "analytics"."events" e ON o.id=e.id'), ["public.orders", "analytics.events"]);
  assert.deepEqual(structureNames("SELECT * FROM (SELECT * FROM analytics.events) e, public.orders o"), ["analytics.events", "public.orders"]);
  assert.deepEqual(structureNames('SELECT * FROM "app.data"."Order.""Items"'), ['app.data.Order."Items']);
  assert.deepEqual(structureNames("SELECT * FROM orders a JOIN orders b ON a.id=b.id"), ["public.orders"]);
  assert.deepEqual(structureNames("SELECT * FROM orders AS o, exact_100 AS x"), ["public.orders", "public.exact_100"]);
  assert.deepEqual(queryStructureObjects("SELECT * FROM orders JOIN missing_table ON true", structureCatalog,
    { database: "app", schema: "public" }).unresolved, ["missing_table"]);
});

test("structure inspection ignores comments, literals, CTE aliases and unrelated schemas", () => {
  for (const text of ["-- SELECT * FROM orders", "SELECT 'FROM orders'", "SELECT $$FROM orders$$", "SELECT 1 /* FROM orders */", "SELECT * FROM other.public.orders", "SELECT * FROM orders(1,2)"])
    assert.deepEqual(structureNames(text), [], text);
  assert.deepEqual(structureNames("SELECT * FROM events"), []);
  assert.deepEqual(structureNames("WITH orders AS (SELECT * FROM exact_100) SELECT * FROM orders"), ["public.exact_100"]);
  assert.deepEqual(structureNames("WITH x AS (SELECT * FROM orders) SELECT * FROM x JOIN analytics.events e ON true"), ["public.orders", "analytics.events"]);
});

test("structure inspection supports mutation and common structure SQL without running it", () => {
  for (const text of ["UPDATE ONLY public.orders SET status=1", "INSERT INTO orders (id) VALUES (1)", "DELETE FROM orders", "ALTER TABLE IF EXISTS orders ADD COLUMN x int", "CREATE INDEX idx ON orders(id)", "COMMENT ON TABLE orders IS 'hello'", "TRUNCATE orders"])
    assert.deepEqual(structureNames(text), ["public.orders"], text);
});

test("MySQL structure inspection stays inside the current database", () => {
  const catalog = [{ ...objects[0], schema: "app" }, { ...objects[0], schema: "other" }, objects[1]];
  for (const text of ["SELECT * FROM orders", "SELECT * FROM `app`.`orders`"])
    assert.deepEqual(queryStructureObjects(text, catalog, { database: "app", driver: "mysql" }).referenced.map((object) => object.schema), ["app"]);
  const result = queryStructureObjects("SELECT * FROM other.orders", catalog, { database: "app", driver: "mysql" });
  assert.deepEqual(result.referenced, []);
  assert.deepEqual(result.objects.map((object) => object.schema), ["app"]);
});

test("completion catalog isolates databases with equal schema and table names", () => {
  const schema = buildCompletionSchema(objects, "app");
  assert.deepEqual(schema.public.children.orders.children.map((column) => column.label), ["id", "status"]);
  assert.equal(schema.public.children.orders.children[1].detail, "text · public.orders");
  assert.equal(schema.public.children.orders.children[1].info, "订单状态");
});

test("object search finds fields and field comments case insensitively", () => {
  assert.equal(objectMatchesSearch(objects[0], "STATUS"), true);
  assert.equal(objectMatchesSearch(objects[0], "状态"), true);
  assert.equal(objectMatchesSearch(objects[0], "private_column"), false);
  assert.deepEqual(matchingColumns(objects[0], "状态").map((column) => column.name), ["status"]);
});

test("CodeMirror completes table fields, aliases and quoted identifiers", () => {
  for (const dialect of [PostgreSQL, MySQL]) {
    const config = { dialect, schema: buildCompletionSchema(objects, "app"), defaultSchema: "public" };
    for (const doc of ["SELECT * FROM orders WHERE st", "SELECT st FROM public.orders", "SELECT * FROM orders JOIN public.orders p ON st", "SELECT * FROM public.orders o WHERE o.st", 'SELECT * FROM "public"."orders" o WHERE o.st']) {
      if (dialect === MySQL && doc.includes('"')) continue;
      const state = EditorState.create({ doc, extensions: [sql(config)] });
      const pos = doc.startsWith("SELECT st ") ? "SELECT st".length : doc.length;
      const result = catalogCompletionSource(config)(new CompletionContext(state, pos, true));
      assert.ok(result?.options.some((option) => option.label === "status"), doc);
      assert.ok(!result?.options.some((option) => option.label === "private_column"), doc);
    }
  }
});

test("field completion skips SQL comments and strings", () => {
  const config = { dialect: PostgreSQL, schema: buildCompletionSchema(objects, "app"), defaultSchema: "public" };
  for (const doc of ["SELECT * FROM orders -- st", "SELECT * FROM orders WHERE status = 'st'"]) {
    const state = EditorState.create({ doc, extensions: [sql(config)] });
    const pos = doc.endsWith("'") ? doc.length - 1 : doc.length;
    assert.equal(catalogCompletionSource(config)(new CompletionContext(state, pos, true)), null);
  }
});

test("fields that require quoting insert valid identifiers for both drivers", () => {
  const catalog = [{ ...objects[0], columns: [{ name: "Order Status" }, { name: 'a"b' }] }];
  assert.equal(buildCompletionSchema(catalog, "app").public.children.orders.children[0].apply, '"Order Status"');
  assert.equal(buildCompletionSchema(catalog, "app").public.children.orders.children[1].apply, '"a""b"');
  const mysqlCatalog = catalog.map((object) => ({ ...object, schema: "app" }));
  assert.equal(buildCompletionSchema(mysqlCatalog, "app", "mysql").app.children.orders.children[0].apply, "`Order Status`");
});

test("relation suggestions carry metadata and never suggest browse fields after FROM", () => {
  const catalog = [...objects, { ...objects[0], name: "orders_view", kind: "view", comment: "订单视图" }];
  const config = { dialect: PostgreSQL, schema: buildCompletionSchema(catalog, "app"), defaultSchema: "public", defaultTable: "orders" };
  const doc = "SELECT * FROM or";
  const state = EditorState.create({ doc, extensions: [sql(config)] });
  const result = catalogCompletionSource(config)(new CompletionContext(state, doc.length, true));
  const table = result.options.find((item) => item.label === "orders");
  const view = result.options.find((item) => item.label === "orders_view");
  assert.equal(table.kindLabel, "表");
  assert.equal(table.detail, "public");
  assert.equal(view.kindLabel, "视图");
  assert.equal(view.info, "订单视图");
  assert.ok(!result.options.some((item) => item.type === "property"));
});

test("catalog metadata preserves quoted names with literal dots", () => {
  const catalog = [{ ...objects[0], schema: "app.data", name: "Order.Items" }];
  const config = { dialect: PostgreSQL, schema: buildCompletionSchema(catalog, "app"), defaultSchema: "app.data" };
  const doc = 'SELECT * FROM "app.data"."Order.Items" o WHERE o.st';
  const state = EditorState.create({ doc, extensions: [sql(config)] });
  const result = catalogCompletionSource(config)(new CompletionContext(state, doc.length, true));
  assert.equal(result.options.find((item) => item.label === "status").detail, "text · app.data.Order.Items");
});

function complete(config, doc, pos = doc.length) {
  const state = EditorState.create({ doc, extensions: [sql(config)] });
  return catalogCompletionSource(config)(new CompletionContext(state, pos, true));
}

test("PostgreSQL prefers current-schema tables and qualifies same-database alternatives", () => {
  const catalog = [...objects, { ...objects[0], schema: "analytics" },
    { ...objects[0], schema: "analytics", name: "events" }];
  const schema = buildCompletionSchema(catalog, "app");
  for (const current of ["public", "analytics"]) {
    const other = current === "public" ? "analytics" : "public";
    const result = complete({ dialect: PostgreSQL, schema, defaultSchema: current }, "SELECT * FROM or");
    const preferred = result.options.find((option) => option.label === "orders");
    const secondary = result.options.find((option) => option.label === `${other}.orders`);
    assert.equal(preferred.detail, current);
    assert.equal(preferred.apply, "orders");
    assert.equal(secondary.apply, `${other}.orders`);
    assert.ok(preferred.boost > secondary.boost);
    assert.ok(!result.options.some((option) => option.detail === "other"));
  }
  const qualified = complete({ dialect: PostgreSQL, schema, defaultSchema: "public" }, "SELECT * FROM analytics.or");
  assert.deepEqual(qualified.options.map((option) => option.label).sort(), ["events", "orders"]);
});

test("cross-schema completion preserves quoting and never inserts an unqualified shadowed name", () => {
  const schema = buildCompletionSchema([{ ...objects[0], schema: 'team."data', name: "Order.Items" }], "app");
  const config = { dialect: PostgreSQL, schema, defaultSchema: "public" };
  for (const doc of ["SELECT * FROM Ord", 'SELECT * FROM "Ord"']) {
    const pos = doc.endsWith('"') ? doc.length - 1 : doc.length;
    const result = complete(config, doc, pos);
    const option = result.options.find((option) => option.type === "class");
    const applied = doc.slice(0, result.from) + option.apply + doc.slice(result.to ?? pos);
    assert.equal(applied, 'SELECT * FROM "team.""data"."Order.Items"');
  }
});

test("query fields follow SQL relations and aliases rather than a table used to open the editor", () => {
  const schema = buildCompletionSchema([...objects, { ...objects[0], name: "events", columns: [{ name: "event_name" }] }], "app");
  const config = { dialect: PostgreSQL, schema, defaultSchema: "public", defaultTable: "orders" };
  const blank = complete(config, "SELECT st");
  assert.ok(!blank.options.some((option) => option.type === "property"));
  for (const doc of ["SELECT ev FROM events", "SELECT * FROM events WHERE ev", "SELECT * FROM events e WHERE e.ev"]) {
    const pos = doc.startsWith("SELECT ev ") ? "SELECT ev".length : doc.length;
    const result = complete(config, doc, pos);
    assert.ok(result.options.some((option) => option.label === "event_name"), doc);
    assert.ok(!result.options.some((option) => option.label === "status"), doc);
  }
});

test("MySQL only completes the current database, including fields and qualified table names", () => {
  const catalog = [
    { ...objects[0], schema: "app" },
    { ...objects[0], database: "other", schema: "other", name: "private_table" },
    { ...objects[0], schema: "other", name: "leaked_table" },
  ];
  const schema = buildCompletionSchema(catalog, "app", "mysql");
  assert.deepEqual(Object.keys(schema), ["app"]);
  const config = { dialect: MySQL, driver: "mysql", schema, defaultSchema: "app" };
  for (const doc of ["SELECT * FROM or", "SELECT * FROM app.or", "SELECT * FROM `app`.`or`", "SELECT * FROM orders o WHERE o.st"]) {
    const result = complete(config, doc, doc.endsWith("`") ? doc.length - 1 : doc.length);
    assert.ok(result.options.some((option) => option.label.replace(/`/g, "") === (doc.includes("WHERE") ? "status" : "orders")), doc);
    assert.ok(!result.options.some((option) => /other|private|leaked/.test(option.label)), doc);
  }
  assert.equal(complete(config, "SELECT * FROM other.pr"), null);
});
