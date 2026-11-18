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
const mutations = [];
const invoke = async (command, args) => {
  if (command === "get_schema_objects" && args.schemaName === "public") return tables;
  if (command === "get_object_details") return tables.find((table) => table.id === args.objectId);
  if (command === "execute_query") {
    const table = tables.find((item) => args.request.sql.includes('"' + item.name + '"'));
    if (table) return { columns: table.columns.map((column) => column.name), rows: [table.row], row_count: 1 };
  }
  if (command === "execute_mutation" && args.request.sql.startsWith("INSERT")) {
    mutations.push(args.request);
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
const open = async (table) => {
  await page.locator("#objectSearch").fill(table.name);
  const object = page.locator('[data-object-id="' + table.id + '"] .object-main');
  await revealObject(object);
  await object.dblclick();
  await page.locator("#newRow").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#resultCount")?.textContent.trim() === "1");
  await page.locator("#newRow").click();
};
const submit = async () => {
  const before = mutations.length;
  await page.locator("#applyMutation").click();
  await page.locator("#confirmActionAccept").click();
  await page.waitForFunction(() => !document.querySelector("#mutationModal").open);
  assert.equal(mutations.length, before + 1);
  return mutations.at(-1).sql;
};
try {
  await page.goto("http://127.0.0.1:" + server.address().port, { waitUntil: "networkidle" });
  await page.locator('[data-connection-id="conn-dev"]').click();
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
  assert.ok(await field("tenant").isDisabled());
  assert.ok(await field("id").isDisabled());
  assert.ok(await field("computed").isDisabled());
  await page.locator("#cancelMutation").click();

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
  assert.deepEqual(errors, []);
  console.log("PASS: manual/composite primary keys, generated and ALWAYS identity fields, BY DEFAULT explicit/automatic ids, default-only inserts, and primary-key edit protection.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
