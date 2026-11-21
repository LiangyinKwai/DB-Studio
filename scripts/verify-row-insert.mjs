import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, revealObject } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Real browser controls with a catalog/IPC fixture; this does not claim a
// PostgreSQL runtime test. Inspect both editability and the dispatched SQL.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "row-mysql", name: "MySQL", driver: "mysql", host: "fixture", port: 3306, database: "warehouse", user: "tester" });
const tables = [
  { id: "manual", name: "manual_keys", columns: [
    { name: "tenant", dataType: "text", primaryKey: true, nullable: false },
    { name: "id", dataType: "integer", primaryKey: true, nullable: false },
    { name: "note", dataType: "text", nullable: true },
    { name: "computed", dataType: "integer", generated: true },
  ], row: ["acme", "1", "draft", "2"] },
  { id: "always", name: "always_identity", columns: [
    { name: "id", dataType: "bigint", primaryKey: true, identity: true, identityGeneration: "always" },
    { name: "computed", dataType: "integer", generated: true },
  ], row: ["1", "2"] },
  { id: "optional", name: "optional_identity", columns: [
    { name: "id", dataType: "bigint", primaryKey: true, identity: true, identityGeneration: "byDefault" },
    { name: "note", dataType: "text", defaultValue: "'draft'::text" },
  ], row: ["1", "draft"] },
].map((table) => ({ schema: "public", kind: "table", ...table, qualifiedName: "public." + table.name }));
const shortcuts = {
  id: "shortcuts", name: "row_shortcuts", schema: "public", kind: "table", qualifiedName: "public.row_shortcuts",
  columns: [
    { name: "id", dataType: "bigint", primaryKey: true, identity: true, identityGeneration: "byDefault" },
    { name: "day", dataType: "date", nullable: true },
    { name: "recorded_at", dataType: "timestamp(6) with time zone", nullable: true },
    { name: "active", dataType: "boolean", nullable: true },
    { name: "payload", dataType: "jsonb", nullable: true },
    { name: "token", dataType: "uuid", nullable: true },
    { name: "note", dataType: "text", nullable: true },
    { name: "label", dataType: "text", nullable: true },
  ],
  rows: [["9007199254740992", null, null, true, "{}", null, "first", ""], ["9007199254740993", null, null, false, "[]", null, "second", ""], ["9007199254740994", null, null, true, "{}", null, "third", ""]],
};
const mysqlShortcuts = { ...shortcuts, id: "mysql-shortcuts", schema: "warehouse", qualifiedName: "warehouse.row_shortcuts",
  columns: shortcuts.columns.map(field => ({ ...field, dataType: ({ "recorded_at": "datetime(6)", active: "tinyint(1)", payload: "json", token: "varchar(36)" })[field.name] || field.dataType })) };
tables.push(shortcuts);
const editedCompositeRow = ["renamed-tenant", "43", "draft", "2"];
const compositeKeyUpdate = 'UPDATE "public"."manual_keys"\nSET "tenant" = E\'renamed-tenant\', "id" = E\'43\'\nWHERE "tenant" IS NOT DISTINCT FROM E\'acme\' AND "id" IS NOT DISTINCT FROM E\'1\';';
const mutations = [];
const clipboard = [];
const invoke = async (command, args) => {
  if (command === "write_clipboard_text") { clipboard.push(args.text); return true; }
  if (command === "get_schema_objects" && args.connectionId === "row-mysql") return [mysqlShortcuts];
  if (command === "get_query_context" && args.connectionId === "row-mysql") return { database: "warehouse", defaultSchema: "warehouse", searchPath: ["warehouse"] };
  if (command === "get_schema_objects" && args.schemaName === "public") return tables;
  if (command === "get_object_details") return [...tables, mysqlShortcuts].find((table) => table.id === args.objectId);
  if (command === "execute_query") {
    const table = args.request.connectionId === "row-mysql" ? mysqlShortcuts : tables.find((item) => args.request.sql.includes('"' + item.name + '"'));
    if (table) return { columns: table.columns.map((column) => column.name), rows: table.rows || [table.row], row_count: table.rows?.length || 1 };
  }
  if (command === "execute_mutation") {
    mutations.push(args.request);
    if (args.request.sql === compositeKeyUpdate) tables[0].row = editedCompositeRow;
    return { columns: [], rows: [], row_count: 1 };
  }
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || "/").split("?")[0]).slice(1) || "index.html");
  if (!file.startsWith(dist + "/") || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction("__FIXTURE_INVOKE__", invoke);
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const field = (name) => page.locator('[data-mutation-column="' + name + '"]');
const open = async (table, { insert = true } = {}) => {
  await page.locator("#objectSearch").fill(table.name);
  const object = page.locator('[data-object-id="' + table.id + '"] .object-main');
  await revealObject(object);
  await object.dblclick();
  await page.locator("#newRow").waitFor({ state: "visible" });
  await page.waitForFunction(count => document.querySelector("#resultCount")?.textContent.trim() === String(count), table.rows?.length || 1);
  if (insert) await page.locator("#newRow").click();
};
const submit = async () => {
  const before = mutations.length;
  await page.locator("#mutationModal").getByRole("button", { name: "下一步", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#mutationModal").open);
  assert.equal(mutations.length, before + 1);
  return mutations.at(-1).sql;
};
try {
  await page.goto("http://127.0.0.1:" + server.address().port, { waitUntil: "networkidle" });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-database="app"][data-schema="public"]').waitFor();
  await open(tables[0]);
  assert.ok(await field("tenant").isEditable(), "manual text primary key must be fillable");
  assert.ok(await field("id").isEditable(), "manual composite primary key must be fillable");
  assert.ok(await field("computed").isDisabled(), "generated field must be disabled");
  await field("tenant").fill("new-tenant");
  await field("id").fill("42");
  await field("note").fill("new row");
  // Disabled fields must also be excluded when draft DOM values are stale.
  await field("computed").evaluate((input) => { input.value = "999"; });
  assert.equal(await submit(), 'INSERT INTO "public"."manual_keys" ("tenant", "id", "note")\nVALUES (E\'new-tenant\', E\'42\', E\'new row\');');
  await page.locator('[data-select-row="0"]').check();
  await page.locator("#editRow").click();
  assert.ok(await field("tenant").isEditable(), "manual text key can be edited");
  assert.ok(await field("id").isEditable(), "manual integer key can be edited");
  assert.ok(await field("computed").isDisabled());
  await field("tenant").fill("renamed-tenant");
  await field("id").fill("43");
  await field("computed").evaluate(input => { input.value = "999"; });
  assert.equal(await submit(), compositeKeyUpdate);
  const editedRow = page.locator('#resultGrid .db-grid-row').first();
  await editedRow.getByText(editedCompositeRow[0], { exact: true }).waitFor();
  assert.deepEqual(await editedRow.locator('[data-grid-cell]').allTextContents(), editedCompositeRow);

  await open(tables[1]);
  assert.ok(await field("id").isDisabled(), "ALWAYS identity must be generated by PostgreSQL");
  assert.ok(await field("computed").isDisabled());
  await field("id").evaluate((input) => { input.value = "999"; });
  assert.equal(await submit(), 'INSERT INTO "public"."always_identity" DEFAULT VALUES;');

  await open(tables[2]);
  assert.ok(await field("id").isEditable(), "BY DEFAULT identity permits an explicit id");
  await field("id").fill("9007199254740993");
  assert.equal(await submit(), 'INSERT INTO "public"."optional_identity" ("id")\nVALUES (E\'9007199254740993\');');
  await page.locator("#newRow").click();
  assert.equal(await submit(), 'INSERT INTO "public"."optional_identity" DEFAULT VALUES;');
  const verifyCopy = async (driver, table) => {
    await open(table, { insert: false });
    await page.locator('[data-select-row="0"]').check();
    await page.locator('[data-select-row="1"]').check();
    const before = mutations.length;
    await page.locator('.db-grid-row[data-row-index="1"] .db-grid-row-number').click({ button: "right" });
    await page.locator('[data-row-action="insert"]').click();
    assert.match(clipboard.at(-1), /^INSERT INTO /);
    assert.match(clipboard.at(-1), /\(9007199254740993, NULL, NULL, (?:false|0), '\[\]', NULL, 'second', ''\);$/);
    assert.doesNotMatch(clipboard.at(-1), /9007199254740994/);
    await page.locator('.db-grid-row[data-row-index="1"] [data-column-index="0"]').click({ button: "right" });
    await page.locator('[data-row-action="update"]').click();
    assert.equal(clipboard.at(-1).match(/^UPDATE /gm)?.length, 2);
    assert.match(clipboard.at(-1), driver === "mysql"
      ? /WHERE `id` <=> 9007199254740993;/ : /WHERE "id" IS NOT DISTINCT FROM 9007199254740993;/);
    assert.equal(mutations.length, before, "copying row SQL executed a mutation");
    await page.locator("#newRow").click();
  };
  await verifyCopy("postgres", shortcuts);
  await page.getByText("选择日期时间（UTC）", { exact: true }).click();
  const dateTime = page.locator('input[type="datetime-local"]');
  await dateTime.fill("2026-11-20T10:11:12");
  await dateTime.dispatchEvent("change");
  assert.equal(await field("recorded_at").inputValue(), "2026-11-20 10:11:12+00:00");
  await page.getByRole("button", { name: "day · 今天", exact: true }).click();
  await page.getByRole("button", { name: "active · False", exact: true }).click();
  await page.getByRole("button", { name: "payload · {}", exact: true }).click();
  await page.getByRole("button", { name: "token · 生成 UUID", exact: true }).click();
  const uuid = await field("token").inputValue();
  assert.match(uuid, /^[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "note · 设为 NULL", exact: true }).click();
  await page.getByRole("button", { name: "label · 空字符串", exact: true }).click();
  assert.match(await submit(), new RegExp(`VALUES \\(CURRENT_DATE, E'2026-11-20 10:11:12\\+00:00', false, E'\\{\\}', E'${uuid}', NULL, E''\\);`));

  await page.locator('[data-connection-id="row-mysql"]').click();
  await verifyCopy("mysql", mysqlShortcuts);
  await page.getByText("选择日期时间", { exact: true }).click();
  await dateTime.fill("2026-11-20T14:30");
  await dateTime.dispatchEvent("change");
  assert.equal(await field("recorded_at").inputValue(), "2026-11-20 14:30:00");
  await page.getByRole("button", { name: "active · True", exact: true }).click();
  await page.getByRole("button", { name: "payload · []", exact: true }).click();
  assert.match(await submit(), /VALUES \(CONVERT\(X'323032362d31312d32302031343a33303a3030' USING utf8mb4\), 1, CONVERT\(X'5b5d' USING utf8mb4\)\);/);
  assert.deepEqual(errors, []);
  console.log("PASS: PostgreSQL/MySQL copy only selected rows to INSERT/UPDATE, preserve precise keys, and submit temporal, boolean, JSON, UUID, NULL and empty-string shortcuts.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
