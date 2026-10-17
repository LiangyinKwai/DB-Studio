import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Frontend regression coverage with mocked metadata; no real database is used.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist"), evidence = resolve(root, "output/playwright/query-structure");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const file = resolve(dist, (req.url || "/").split("?")[0].slice(1) || "index.html");
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
let holdCatalog = false, releaseCatalog;
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command, args);
  if (command === "list_connections") return [...result, {
    id: "mysql", name: "MySQL", driver: "mysql", host: "fixture.local", port: 3306, database: "app", user: "root",
  }];
  if (command === "get_schema_objects" && holdCatalog) {
    holdCatalog = false;
    await new Promise((done) => { releaseCatalog = done; });
  }
  if (command === "get_schema_objects" && args.connectionId === "mysql") return [
    { id: "app.orders", database: "app", schema: "app", name: "orders", kind: "table", qualifiedName: "app.orders" },
    { id: "other.secret", database: "app", schema: "other", name: "secret", kind: "table", qualifiedName: "other.secret" },
  ];
  if (command === "get_object_details") {
    return { ...result, qualifiedName: args.objectId };
  }
  return result;
});
const page = await context.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const editor = page.locator("#sqlEditor .cm-content");
const menu = page.locator("#queryStructureMenu");
const search = page.locator("#queryStructureSearch");
const entries = page.locator("#queryStructureList [role='option']");
const activeId = () => page.locator(".query-tab.active").getAttribute("data-tab-id");
const activate = (id) => page.locator(`[data-tab-id='${id}'] .tab-select`).click();
const wait = async (fn) => {
  for (let i = 0; i < 180; i++) { if (await fn()) return; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error("condition timed out");
};
const ready = () => wait(() => page.locator("#runQuery").isEnabled());
const savedTab = (id) => page.evaluate((id) => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find((tab) => tab.id === id), id);
const selectSchema = async (value) => {
  await page.locator("#querySchema").click();
  await page.locator(`#querySchemaList [data-value='${value}']`).click();
};
const executions = () => fixture.callsFor("execute_query").length + fixture.callsFor("execute_mutation").length;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#addQueryTab").click();
  await ready();
  const query = await activeId();
  await selectSchema("public");
  assert.equal((await savedTab(query)).sql, "");
  assert.equal(await page.locator(".cm-placeholder").innerText(), "在此编写 SQL…");
  const reads = executions();
  await page.locator("#runQuery").click();
  assert.match(await page.locator("#toast").innerText(), /请先输入 SQL/);
  assert.equal(executions(), reads, "placeholder was executed");
  await page.locator("#saveSql").click();
  await wait(() => fixture.callsFor("save_text_file").length > 0);
  assert.equal(fixture.callsFor("save_text_file").at(-1).args.contents, "", "placeholder was saved as SQL");
  await editor.fill("SELECT * FROM orders");
  assert.equal(await page.locator(".cm-placeholder").count(), 0);
  await page.locator("#structureTab").click();
  await page.locator(".structure-title").waitFor();
  assert.match(await page.locator(".structure-title").innerText(), /public.orders/);
  const ordersStructure = await activeId();
  assert.notEqual(ordersStructure, query);
  const details = fixture.callsFor("get_object_details").at(-1).args;
  assert.deepEqual(details, { connectionId: "conn-dev", objectId: "public.orders", kind: "table", database: "app" });
  assert.equal(executions(), reads, "inspecting structure executed a query");
  const detached = await savedTab(query);
  assert.ok(!detached.browse && !detached.openedObject && detached.tableView === false);

  await page.getByRole("button", { name: "打开 SQL 编辑器", exact: true }).click();
  await ready();
  const blank = await activeId();
  assert.equal((await savedTab(blank)).sql, "", "structure SQL action still writes hint comments");
  assert.equal((await savedTab(blank)).schema, "public");
  assert.ok(await page.locator(".cm-placeholder").isVisible());
  await page.locator("#structureTab").click();
  await menu.waitFor();
  assert.match(await entries.first().innerText(), /public/);
  assert.equal(await entries.count(), 4, "table picker leaked procedures or omitted other schemas");
  await search.fill("events");
  assert.equal(await entries.count(), 1);
  await page.screenshot({ path: resolve(evidence, "blank-query-picker.png") });
  await search.press("Enter");
  await wait(async () => await activeId() !== blank);
  await wait(async () => (await page.locator(".structure-title").innerText()).includes("analytics.events"));
  const eventsStructure = await activeId();
  assert.equal(fixture.callsFor("get_object_details").at(-1).args.objectId, "analytics.events");

  await activate(query);
  await editor.fill("SELECT * FROM public.orders o JOIN analytics.events e ON o.id=e.id");
  await page.locator("#structureTab").click();
  await menu.waitFor();
  assert.match(await entries.nth(0).innerText(), /当前 SQL 引用/);
  assert.match(await entries.nth(1).innerText(), /当前 SQL 引用/);
  const tabsBeforeChoice = await page.locator(".query-tab").count();
  await search.fill("events");
  await search.press("Enter");
  assert.equal(await activeId(), eventsStructure, "existing structure tab was not reused");
  assert.equal(await page.locator(".query-tab").count(), tabsBeforeChoice);

  await activate(blank);
  await selectSchema("analytics");
  await page.locator("#structureTab").click();
  await menu.waitFor();
  assert.match(await entries.first().innerText(), /analytics/);
  await search.press("Escape");
  assert.ok(await menu.isHidden());
  assert.equal(await page.evaluate(() => document.activeElement.id), "structureTab");
  await editor.fill("SELECT * FROM public.orders");
  await page.locator("#structureTab").click();
  await wait(async () => await activeId() === ordersStructure);

  // A delayed metadata read must not open a structure page after switching tabs.
  await activate(blank);
  await page.locator("#refreshQueryTarget").click();
  await ready();
  holdCatalog = true;
  await page.locator("#structureTab").click();
  await wait(() => typeof releaseCatalog === "function");
  await activate(query);
  releaseCatalog();
  await page.waitForTimeout(150);
  assert.equal(await activeId(), query);
  assert.ok(await menu.isHidden());
  assert.ok(await page.locator("#structureTab").isEnabled());

  // Schema changes also invalidate an in-flight choice, even when changed back.
  await page.locator("#refreshQueryTarget").click();
  await ready();
  holdCatalog = true;
  releaseCatalog = null;
  await page.locator("#structureTab").click();
  await wait(() => typeof releaseCatalog === "function");
  await selectSchema("analytics");
  await selectSchema("public");
  releaseCatalog();
  await page.waitForTimeout(150);
  assert.equal(await activeId(), query);
  assert.ok(await menu.isHidden());
  assert.ok(await page.locator("#structureTab").isEnabled());

  // Themes and compact view use the same custom searchable picker styling.
  await editor.fill("");
  assert.ok(await page.locator(".cm-placeholder").isVisible());
  await page.setViewportSize({ width: 1060, height: 680 });
  for (const theme of ["light", "dark", "ocean", "forest", "contrast"]) {
    await page.evaluate((theme) => { document.body.dataset.theme = theme; }, theme);
    await page.locator("#structureTab").click();
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1060 && bounds.y + bounds.height <= 680, theme);
    await page.screenshot({ path: resolve(evidence, `${theme}-picker.png`) });
    await search.press("Escape");
  }

  // MySQL offers current-DB tables only, including for explicitly foreign SQL.
  await page.locator("[data-connection-id='mysql']").click();
  await page.locator(".tree-database[data-database='app'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await ready();
  const mysqlQuery = await activeId();
  await editor.fill("SELECT * FROM other.secret");
  await page.locator("#structureTab").click();
  await menu.waitFor();
  assert.equal(await activeId(), mysqlQuery);
  assert.equal(await entries.count(), 1);
  assert.match(await entries.first().innerText(), /orders/);
  await search.press("Escape");
  await editor.fill("SELECT * FROM `app`.`orders`");
  await page.locator("#structureTab").click();
  await wait(async () => await activeId() !== mysqlQuery);
  assert.equal(fixture.callsFor("get_object_details").at(-1).args.objectId, "app.orders");
  assert.equal(fixture.callsFor("get_object_details").at(-1).args.connectionId, "mysql");
  assert.equal(executions(), reads);

  // Convert only untouched legacy generated comments, preserving actual SQL.
  await page.evaluate(({ blank, query }) => {
    const key = "db-studio.workspace-tabs.v2";
    const tabs = JSON.parse(localStorage.getItem(key));
    const hint = '-- "public"."orders"\n-- 在此编写索引、约束或其他结构变更 SQL。\n';
    tabs.find((tab) => tab.id === blank).sql = hint;
    tabs.find((tab) => tab.id === query).sql = hint + "SELECT 42;";
    localStorage.setItem(key, JSON.stringify(tabs));
    localStorage.setItem(`${key}.active`, blank);
  }, { blank, query });
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  assert.ok(await page.locator(".cm-placeholder").isVisible());
  await activate(query);
  await activate(blank);
  assert.equal((await savedTab(blank)).sql, "");
  assert.ok((await savedTab(query)).sql.endsWith("SELECT 42;"));
  assert.equal(await page.locator(".query-tab .tab-label").filter({ hasText: /^结构 · / }).count(), 0, "startup restored temporary structure tabs");

  // Explicit inspection stays useful within this session, but is never saved
  // as a startup tab and must not open the SQL editor automatically.
  await editor.fill("SELECT * FROM public.orders;");
  await page.locator("#structureTab").click();
  await page.locator(".structure-title").waitFor();
  const temporaryStructure = await activeId();
  assert.ok(await page.locator("#editorPane").isHidden());
  assert.ok(await page.locator("#queryToolbar").isHidden());
  assert.equal(await savedTab(temporaryStructure), undefined, "temporary structure tab was persisted");
  const structureReads = fixture.callsFor("get_object_details").length;
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  assert.equal(await page.locator(`[data-tab-id='${temporaryStructure}']`).count(), 0);
  assert.equal(fixture.callsFor("get_object_details").length, structureReads, "startup loaded a temporary structure");
  assert.equal(executions(), reads, "startup executed SQL for a removed structure tab");
  await activate(blank);
  assert.equal((await savedTab(blank)).sql, "SELECT * FROM public.orders;");

  // Older releases also persisted orphan inspectors without their object
  // target. Discard empty inspectors while preserving any SQL typed into one.
  await page.evaluate(() => {
    const key = "db-studio.workspace-tabs.v2";
    const old = { connectionId: "conn-dev", database: "app", schema: "public", title: "结构 · orders" };
    localStorage.setItem(key, JSON.stringify([
      { ...old, id: "old-empty", sql: "" },
      { ...old, id: "old-work", sql: "-- My work\nSELECT 42;" },
    ]));
    localStorage.setItem(`${key}.active`, "old-empty");
  });
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  assert.equal(await page.locator(".query-tab").count(), 1);
  assert.equal(await activeId(), "old-work");
  assert.match(await page.locator(".query-tab.active .tab-label").innerText(), /^查询 /);
  assert.equal(await editor.innerText(), "-- My work\nSELECT 42;");
  assert.equal((await savedTab("old-work")).openedObject, null);
  assert.equal(executions(), reads);

  // A workspace with only an inspector opens empty on the next launch.
  await editor.fill("SELECT * FROM public.orders;");
  await page.locator("#structureTab").click();
  await page.locator(".structure-title").waitFor();
  await page.locator("[data-tab-id='old-work'] .tab-close").click();
  assert.equal(await page.locator(".query-tab").count(), 1);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#resultEmpty h2").filter({ hasText: "没有打开的查询" }).waitFor();
  assert.equal(await page.locator(".query-tab").count(), 0);
  assert.ok(await page.locator("#editorPane").isHidden(), "empty startup still displayed the SQL editor");
  assert.ok(await page.locator("#queryToolbar").isHidden());
  await page.screenshot({ path: resolve(evidence, "startup-without-structure-tabs.png") });
  assert.equal(executions(), reads);
  assert.deepEqual(errors, []);
  console.log("PASS: real placeholder, empty execution/save, generic query structure, single/multi-table resolution, searchable keyboard picker, schema priority, metadata-only reads, tab reuse, stale response guard, five themes/compact layout, MySQL DB isolation, safe legacy draft migration and startup without temporary structure tabs while retaining SQL drafts.");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
