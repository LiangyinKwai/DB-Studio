import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, revealObject } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// UI fixtures only: no queries are sent to a user's database.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/tree-actions");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "mysql-local", name: "MySQL 开发库", driver: "mysql", database: "warehouse", host: "mysql.fixture", port: 3306, user: "fixture" });
fixture.objectsBySchema.reporting.push({ id: "reporting.items", schema: "reporting", name: "items", kind: "table", qualifiedName: "reporting.items" });
fixture.schemasByDatabase.warehouse = [{ name: "warehouse" }];
fixture.objectsBySchema.warehouse = [{ id: "warehouse.items", schema: "warehouse", name: "items", kind: "table", qualifiedName: "warehouse.items" }];
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//, "") || "index.html");
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
let failCommand = "";
let delayedCatalog = null;
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command === 'get_object_ddl_details' ? 'get_object_details' : command, args);
  if (command === 'get_object_details' || command === 'get_object_ddl_details') return { ...result, tableDdl: { columnDefinitions: ['"id" integer NOT NULL', '"status" text'], beforeStatements: ["SELECT pg_catalog.set_config('search_path', E'pg_catalog', false);"], afterStatements: [], constraintIndexes: [], createPrefix: 'CREATE TABLE', createSuffix: '', unsupportedReason: null } };
  if (command === failCommand) throw new Error("fixture refresh failure");
  if (command === "get_schema_objects" && delayedCatalog) return delayedCatalog;
  return result;
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const expect = (ok, message) => { if (!ok) throw new Error(message); };
const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((done) => setTimeout(done, 50)); } throw new Error("condition timeout"); };
const menu = page.locator("#objectContextMenu");
const action = (name) => menu.locator(`[data-context-action='${name}']`);
const savedTab = () => page.evaluate(() => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find((tab) => tab.id === localStorage.getItem("db-studio.workspace-tabs.v2.active")));
const toast = (text) => page.locator("#toast").getByText(text, { exact: true }).waitFor();
const selected = async (locator) => {
  expect(await locator.getAttribute("aria-current") === "true", "target not selected");
  expect(await page.locator("#objectTree .selected").count() === 1, "multiple tree rows selected");
  expect((await locator.evaluate((node) => getComputedStyle(node).boxShadow)).includes("inset"), "selection has no accent indicator");
};
const openMenu = async (locator) => {
  await locator.click({ button: "right" }); await menu.waitFor(); await selected(locator);
  const buttons = menu.locator('button:visible');
  for (const button of await buttons.all()) {
    expect(await button.locator('svg[aria-hidden="true"]').count() === 1, 'menu action missing its decorative icon');
    expect(await button.locator('[data-context-label]').count() === 1, 'menu action missing its label');
  }
};
async function expand(database, schema) {
  const db = page.locator(`.tree-database[data-database='${database}']`);
  if (!await db.evaluate((node) => node.open)) await db.locator(":scope > summary [data-tree-toggle]").click();
  if (await db.evaluate(node => node.classList.contains('mysql-database'))) { await revealObject(db.locator('.tree-category[data-kind=table] .tree-object').first()); return db.locator('.mysql-database-objects'); }
  const sc = db.locator(`.tree-schema[data-schema='${schema}']`);
  await sc.waitFor();
  if (!await sc.evaluate((node) => node.open)) await sc.locator(":scope > summary [data-tree-toggle]").click();
  await revealObject(sc.locator(".tree-category[data-kind=table] .tree-object").first());
  return sc;
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await selected(page.locator(".tree-root"));
  const sc = await expand("app", "public");
  const table = sc.locator("[data-object-id='public.orders']");
  await openMenu(sc.locator(':scope > summary'));
  const visibleActions = await menu.locator('button:visible').evaluateAll(nodes => nodes.map(node => node.dataset.contextAction));
  expect(visibleActions.at(-1) === 'drop-schema', 'delete schema is not the last menu action');
  expect(await action('drop-schema').evaluate(node => { const probe = document.createElement('span'); probe.style.color = 'var(--error)'; document.body.append(probe); const match = getComputedStyle(node).color === getComputedStyle(probe).color; probe.remove(); return match; }), 'delete schema must use the error color');
  await action('drop-schema').click();
  const confirm = page.locator('#confirmActionModal');
  expect((await confirm.innerText()).includes('仅允许删除空 schema'), 'schema confirmation must explain RESTRICT');
  expect(await page.locator('#confirmActionAccept').isEnabled(), 'confirmation should be directly actionable');
  await page.locator('#confirmActionAccept').click();
  await toast('Schema public 已删除');
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'DROP SCHEMA "public" RESTRICT;', 'schema deletion should be scoped and non-cascading');

  expect(await page.locator(".query-tab").count() === 0, "initial tabs present");
  await openMenu(table);
  await action("open-structure").click();
  await page.locator(".structure-title").waitFor();
  expect(await page.locator("#structurePanel").getByRole("tab", { name: "字段", selected: true }).isVisible(), "fields tab is missing from structure");
  await selected(table);
  expect(fixture.callsFor("get_object_details").at(-1).args.database === "app", "structure tab lost database");

  for (const [locator, refresh, message, command] of [
    [page.locator(".tree-root"), "refresh-databases", "数据库列表已刷新", "list_databases"],
    [page.locator(".tree-database[data-database='app'] > summary"), "refresh-database", "数据库 app 已刷新", "list_schemas"],
    [sc.locator(":scope > summary"), "refresh-schema", "对象列表已刷新", "get_schema_objects"],
    [sc.locator(".tree-category[data-kind='table'] > .category-summary"), "refresh-schema", "对象列表已刷新", "get_schema_objects"],
    [table, "refresh-object", "对象已刷新", "get_schema_objects"],
  ]) {
    const before = fixture.callsFor(command).length;
    await openMenu(locator);
    await action(refresh).click();
    await toast(message);
    await selected(locator);
    expect(fixture.callsFor(command).length > before, `refresh did not call ${command}`);
  }
  await openMenu(table);
  for (const name of ["open-data", "open-structure", "new-query", "create-table", "edit-structure", "rename-table", "copy-ddl", "copy-name", "refresh-object"])
    expect(await action(name).isVisible(), `table action missing: ${name}`);
  expect(await action('clear-table').isVisible(), 'clear table action missing');
  await page.screenshot({ path: resolve(evidence, "table-menu.png") });
  await action("copy-ddl").click();
  await toast("已复制 DDL");
  expect((await page.evaluate(() => navigator.clipboard.readText())).includes("CREATE TABLE"), "copy DDL empty");

  await openMenu(table); await action('clear-table').focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.locator('#clearTableSubmenu').isVisible(), 'keyboard did not open clear submenu');
  expect(await action('clear-table').getAttribute('aria-expanded') === 'true', 'submenu expansion state missing');
  const submenuBounds = await page.locator('#clearTableSubmenu').boundingBox();
  expect(submenuBounds.x >= 0 && submenuBounds.y >= 0 && submenuBounds.x + submenuBounds.width <= 1440 && submenuBounds.y + submenuBounds.height <= 900, 'submenu leaves viewport');
  expect(await page.evaluate(() => document.activeElement?.dataset.clearMethod) === 'delete', 'keyboard focus missing from submenu');
  await page.keyboard.press('Escape');
  expect(await page.locator('#clearTableSubmenu').isHidden(), 'Escape did not close submenu');
  await action('clear-table').hover();
  const beforeClear = fixture.callsFor('execute_mutation').length;
  await page.locator('#clearTableSubmenu [data-clear-method="truncate"]').click();
  expect((await page.locator('#confirmActionModal').innerText()).includes('行级安全'), 'PostgreSQL TRUNCATE warning missing');
  expect((await page.locator('#confirmActionModal').innerText()).includes('CONTINUE IDENTITY RESTRICT'), 'TRUNCATE SQL incorrect');
  await page.locator('#confirmActionCancel').click();
  expect(fixture.callsFor('execute_mutation').length === beforeClear, 'cancelled clear executed');
  await openMenu(table); await action('clear-table').click();
  await page.locator('#clearTableSubmenu [data-clear-method="delete"]').click();
  expect((await page.locator('#confirmActionModal').innerText()).includes('外键关联'), 'DELETE warning missing');
  await page.locator('#confirmActionAccept').click();
  await toast('清空操作已执行，请刷新数据核对');
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'DELETE FROM "public"."orders";', 'wrong clear target');
  await openMenu(table);
  await action("open-data").click();
  await page.locator(".db-grid-cell").first().waitFor();
  const dataTab = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  const icon = table.locator('.object-open');
  expect(await icon.getAttribute('title') === '查看表数据', 'data action must explain its purpose');
  expect(await icon.locator('svg').count() === 1, 'data action must use the data-view icon');
  const readsWithData = fixture.callsFor('execute_query').length;
  await icon.click();
  expect(fixture.callsFor('execute_query').length === readsWithData, 'already-loaded tab should not be re-queried');
  await openMenu(table); await action('clear-table').click();
  await page.locator('#clearTableSubmenu [data-clear-method="delete"]').click();
  await page.locator('#confirmActionAccept').click(); await toast('清空操作已执行，请刷新数据核对');
  await page.locator('#resultEmpty').getByText('尚未加载表数据').waitFor();
  const readsBeforeReopen = fixture.callsFor('execute_query').length;
  await icon.click();
  await wait(() => fixture.callsFor('execute_query').length > readsBeforeReopen);
  await page.locator('.db-grid-cell').first().waitFor();
  expect(await page.locator('.query-tab.active').getAttribute('data-tab-id') === dataTab, 'data action created a duplicate tab');
  expect(fixture.callsFor('execute_query').length === readsBeforeReopen + 1, 'unloaded tab should be queried once');
  const reads = fixture.callsFor("execute_query").length;
  const writes = fixture.callsFor("execute_mutation").length;
  await openMenu(table);
  await action("refresh-object").click();
  await toast("对象已刷新");
  expect(fixture.callsFor("execute_query").length > reads, "active table data not refreshed");
  expect(fixture.callsFor("execute_mutation").length === writes, "refresh performed a mutation");
  failCommand = "get_schema_objects";
  await openMenu(table);
  await action("refresh-object").click();
  await page.locator("#toast[data-type='error']").filter({ hasText: "fixture refresh failure" }).waitFor();
  await selected(table);
  failCommand = "";

  const category = sc.locator(".tree-category[data-kind='table'] > .category-summary");
  await category.locator('[data-tree-toggle]').click();
  await openMenu(category);
  await action("refresh-schema").click();
  await toast("对象列表已刷新");
  expect(await category.getAttribute("aria-expanded") === "false", "refresh lost category collapse state");
  await category.locator('[data-tree-toggle]').click();
  await sc.locator(".tree-category[data-kind='routine'] > .category-summary [data-tree-toggle]").click();
  await openMenu(sc.locator("[data-object-id='public.refresh_proc']"));
  expect(await action("open-data").isHidden() && await action("rename-table").isHidden() && await action("new-query").isHidden(), "procedure exposes invalid table actions");
  await page.keyboard.press("Escape");

  // Explicitly target a non-default database for structure and direct rename.
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  const report = await expand("app_reporting", "reporting");
  const reportTable = report.locator("[data-object-id='reporting.items']");
  await openMenu(reportTable);
  await action("open-structure").click();
  await page.locator(".structure-title").waitFor();
  expect(fixture.callsFor("get_object_details").at(-1).args.database === "app_reporting", "structure opened on default database");
  await openMenu(reportTable);
  const beforeDraft = fixture.callsFor("execute_mutation").length;
  await action("edit-structure").click();
  const structureEditor = page.locator('.structure-editor-dialog');
  await structureEditor.waitFor();
  expect((await structureEditor.locator('.structure-editor-target').innerText()).includes('开发库 / app_reporting / reporting / items'), "structure editor target incorrect");
  expect(fixture.callsFor("get_object_details").at(-1).args.database === "app_reporting", "structure editor tab lost its database");
  expect(fixture.callsFor("execute_mutation").length === beforeDraft, "opening the structure editor executed SQL");
  await structureEditor.getByRole('button', { name: '取消', exact: true }).click();
  await structureEditor.waitFor({ state: 'detached' });

  await openMenu(reportTable);
  await action("rename-table").click();
  expect(await page.locator("#createObjectName").inputValue() === "items", "rename did not prefill old name");
  await page.locator("#createObjectForm button[type='submit']").click();
  expect(await page.locator("#createObjectModal").isVisible(), "rename accepted unchanged name");
  await page.locator("#createObjectName").fill('items"new');
  const tabsBeforeRename = await page.locator('.query-tab').count();
  await page.locator("#createObjectForm button[type='submit']").click();
  await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
  expect(await page.locator('.query-tab').count() === tabsBeforeRename, 'rename opened an SQL tab');
  expect(fixture.callsFor('execute_mutation').length === beforeDraft + 1, 'rename must execute once on final submit');
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'ALTER TABLE "reporting"."items" RENAME TO "items""new";', 'PostgreSQL direct rename quote incorrect');
  expect(fixture.callsFor("execute_mutation").at(-1).args.request.database === "app_reporting", "rename execution routed incorrectly");
  const tabCount = await page.locator(".query-tab").count();
  await openMenu(reportTable);
  await action("rename-table").click();
  await page.locator("#cancelCreateObject").click();
  expect(await page.locator(".query-tab").count() === tabCount, "cancel rename created a tab");

  // A refresh completed after a connection switch must not repaint that connection.
  let release;
  delayedCatalog = new Promise((done) => { release = done; });
  const beforeDelay = fixture.callsFor("get_schema_objects").length;
  await openMenu(reportTable);
  await action("refresh-object").click();
  await wait(() => fixture.callsFor("get_schema_objects").length > beforeDelay);
  await page.locator("[data-connection-id='mysql-local']").click();
  delayedCatalog = null;
  release([{ id: "stale", name: "stale", schema: "reporting", kind: "table" }]);
  const mysql = await expand("warehouse", "warehouse");
  expect(await page.locator("[data-object-id='stale']").count() === 0, "stale catalog polluted another connection");
  const mysqlTable = mysql.locator("[data-object-id='warehouse.items']");
  const mysqlReads = fixture.callsFor('execute_query').length;
  await mysqlTable.locator('.object-open').click();
  await wait(() => fixture.callsFor('execute_query').length > mysqlReads);
  await page.locator('.db-grid-cell').first().waitFor();
  expect(fixture.callsFor('execute_query').at(-1).args.request.database === 'warehouse', 'MySQL data action used the wrong database');
  await openMenu(mysqlTable);
  await action('clear-table').click();
  await page.locator('#clearTableSubmenu [data-clear-method="truncate"]').click();
  expect((await page.locator('#confirmActionModal').innerText()).includes('重置 AUTO_INCREMENT'), 'MySQL reset warning missing');
  expect((await page.locator('#confirmActionModal').innerText()).includes('隐式提交'), 'MySQL implicit commit warning missing');
  expect((await page.locator('#confirmActionModal').innerText()).includes('TRUNCATE TABLE `warehouse`.`items`;'), 'MySQL truncate SQL incorrect');
  await page.locator('#confirmActionCancel').click();
  await openMenu(mysql.locator("[data-object-id='warehouse.items']"));
  await action("rename-table").click();
  await page.locator("#createObjectName").fill("items`new");
  await page.locator("#createObjectForm button[type='submit']").click();
  await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
  const rename = fixture.callsFor('execute_mutation').at(-1).args.request;
  expect(rename.database === 'warehouse' && rename.sql === "RENAME TABLE `warehouse`.`items` TO `warehouse`.`items``new`;", "MySQL direct rename quoting/target incorrect");

  await page.locator("[data-connection-id='redis-local']").click();
  await selected(page.locator(".redis-tree-root"));
  await openMenu(page.locator(".redis-tree-root"));
  await action("refresh-redis").click();
  await toast("Redis 数据库和 key 已刷新");
  const redisDb = page.locator(".redis-database[data-redis-db='0']");
  if (!await redisDb.evaluate((node) => node.open)) await redisDb.locator(":scope > summary [data-tree-toggle]").click();
  const redisKey = redisDb.locator("[data-redis-key='users:1']");
  await redisKey.locator(".object-main").click();
  await page.locator(".db-grid-cell").first().waitFor();
  await redisKey.click({ button: "right" });
  await selected(redisKey);
  await page.locator("[data-redis-context-action='refresh']").click();
  await toast("Redis key 已刷新");
  await selected(redisKey);
  failCommand = "list_redis_keys";
  await redisDb.locator(":scope > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='refresh']").click();
  await page.locator("#toast[data-type='error']").filter({ hasText: "fixture refresh failure" }).waitFor();
  expect(await redisKey.isVisible(), "failed refresh discarded existing keys");
  failCommand = "";
  await redisDb.locator(":scope > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='refresh']").click();
  await toast("Redis DB 0 已刷新");
  await page.locator(".redis-tree-root").click();
  await selected(page.locator(".redis-tree-root"));
  await page.screenshot({ path: resolve(evidence, "instance-selected.png") });
  expect(errors.length === 0, errors.join("\n"));
  console.log("PASS: tree selection, all refresh scopes, active data refresh, failure/stale guards, category persistence, PG/MySQL direct rename without SQL tabs, quoting, cancellation and Redis refresh.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
