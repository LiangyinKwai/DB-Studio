import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, revealObject } from "./playwright-import.mjs";
import { chooseAppSelect } from "./app-select-driver.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/database-actions");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "mysql-local", name: "MySQL 开发库", driver: "mysql", host: "mysql.fixture", port: 3306, database: "warehouse", user: "fixture" });
const server = createServer((req, res) => {
  const relative = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//, "") || "index.html";
  const file = resolve(dist, relative);
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
let failRefresh = false;
let createdDatabase = false;
let failTableCreate = false;
let failTableRefresh = false;
let failObjectCreate = false, holdObjectCreate = false, releaseObjectCreate;
const createdTables = [];
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command === 'get_object_ddl_details' ? 'get_object_details' : command, args);
  if (command === 'execute_mutation' && /^CREATE (DATABASE|SCHEMA)/.test(args.request.sql)) {
    if (holdObjectCreate) { holdObjectCreate = false; await new Promise(resolve => { releaseObjectCreate = resolve; }); }
    if (failObjectCreate) throw new Error('fixture: 没有创建权限');
  }
  if (failRefresh && command === "list_schemas" && args.database === "app_reporting") throw new Error("fixture refresh failure");
  if (command === "execute_mutation" && args.request.sql === 'CREATE DATABASE "new_app";') createdDatabase = true;
  if (command === "list_databases" && args.connectionId === "conn-dev" && createdDatabase)
    return [...result, { name: "new_app", current: false, allowConnections: true }];
  if (command === 'execute_mutation' && args.request.sql.startsWith('CREATE TABLE')) {
    if (failTableCreate) throw new Error('fixture: 表名已存在');
    const pg = args.request.sql.match(/^CREATE TABLE "((?:[^"]|"")*)"\."((?:[^"]|"")*)"/);
    const my = args.request.sql.match(/^CREATE TABLE `((?:[^`]|``)*)`\.`((?:[^`]|``)*)`/);
    const match = pg || my;
    const name = match[2].replaceAll(pg ? '""' : '``', pg ? '"' : '`');
    createdTables.push({ connectionId: args.request.connectionId, database: args.request.database, schema: args.request.schema,
      id: `created-${createdTables.length}`, name, qualifiedName: `${args.request.schema}.${name}`, kind: 'table',
      columns: [{ name: 'id', dataType: 'bigint', primaryKey: true, identity: true, nullable: false }, { name: 'note', dataType: 'text', nullable: true }] });
  }
  if (command === 'get_schema_objects') {
    if (failTableRefresh) throw new Error('fixture: catalog refresh failed');
    return [...result, ...createdTables.filter(table => table.connectionId === args.connectionId && table.database === args.database && table.schema === args.schemaName)];
  }
  if (command === 'get_object_details' || command === 'get_object_ddl_details') {
    const table = createdTables.find(item => item.id === args.objectId);
    if (table?.connectionId === 'mysql-local') return { ...table, definition: 'CREATE TABLE `items` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' };
    return table || result;
  }
  return result;
});
const page = await context.newPage();

const expect = (ok, message) => { if (!ok) throw new Error(message); };
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const menu = page.locator("#objectContextMenu");
const action = (name) => menu.locator(`[data-context-action='${name}']`);
async function openMenu(database) {
  await page.locator(`.tree-database[data-database='${database}'] > summary`).click({ button: "right" });
  await menu.waitFor();
}
async function activeSavedTab() {
  return page.evaluate(() => {
    const id = localStorage.getItem("db-studio.workspace-tabs.v2.active");
    return JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find((tab) => tab.id === id);
  });
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  await openMenu("app_reporting");
  const labels = await menu.locator("button:visible").allTextContents();
  for (const label of ["刷新数据库", "新建查询", "新建数据库…", "新建 schema…", "新建表…", "复制 DDL"])
    expect(labels.includes(label), `database menu missing ${label}`);
  expect(!labels.includes("打开表数据"), "object actions leaked into database menu");
  await page.screenshot({ path: resolve(evidence, "database-menu.png") });
  await action("new-database-query").click();
  let tab = await activeSavedTab();
  expect(tab.database === "app_reporting" && tab.connectionId === "conn-dev", "new query lost selected database");
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.fill("SELECT 1");
  await page.locator("#runQuery").click();
  await page.locator(".db-grid-cell").first().waitFor();
  expect(fixture.callsFor("execute_query").at(-1).args.request.database === "app_reporting", "query executed against default database");

  for (const [kind, name, expected] of [
    ["schema", 'report"daily', 'CREATE SCHEMA "report""daily";'],
    ["database", "new_app", 'CREATE DATABASE "new_app";'],
  ]) {
    await openMenu("app_reporting");
    const before = fixture.callsFor("execute_mutation").length;
    const tabsBefore = await page.locator('.query-tab').count();
    await action(`create-${kind}`).click();
    await page.locator("#createObjectModal").waitFor();
    expect((await page.locator("#createObjectContext").innerText()).includes("app_reporting"), "creation dialog lost target");
    await page.locator("#createObjectName").fill("  ");
    await page.locator("#createObjectForm button[type='submit']").click();
    expect(await page.locator("#createObjectModal").isVisible(), "blank name accepted");
    await page.locator("#createObjectName").fill(name);
    await page.locator('#createObjectPreview').evaluate(node => { node.open = true; });
    expect((await page.locator('#createObjectSql').innerText()) === expected, `bad ${kind} preview`);
    await page.locator("#createObjectForm button[type='submit']").click();
    await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
    expect(await page.locator('.query-tab').count() === tabsBefore, 'direct creation opened an SQL tab');
    expect(fixture.callsFor("execute_mutation").length === before + 1, 'final submit must execute once');
    const request = fixture.callsFor('execute_mutation').at(-1).args.request;
    expect(request.database === 'app_reporting' && request.sql === expected, 'direct creation lost database or quoted name');
  }
  // Failed writes retain the form. While the IPC is pending, Enter/Escape and
  // repeated submits cannot duplicate or abandon an in-flight CREATE.
  await openMenu('app_reporting'); await action('create-schema').click();
  const noWrite = fixture.callsFor('execute_mutation').length;
  await page.locator('#createObjectName').fill('retry_schema'); failObjectCreate = true; holdObjectCreate = true;
  await page.locator('#applyCreateObject').click();
  await page.waitForFunction(() => document.querySelector('#applyCreateObject').disabled);
  await page.keyboard.press('Escape');
  expect(await page.locator('#createObjectModal').isVisible(), 'Escape closed an executing CREATE');
  await page.locator('#createObjectForm').evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(fixture.callsFor('execute_mutation').length === noWrite + 1, 'double submit sent a duplicate CREATE');
  for (let i = 0; i < 100 && !releaseObjectCreate; i++) await new Promise(done => setTimeout(done, 25));
  releaseObjectCreate();
  await page.locator('#createObjectFeedback').filter({ hasText: '没有创建权限' }).waitFor();
  expect(await page.locator('#createObjectName').inputValue() === 'retry_schema', 'failed CREATE lost the draft');
  failObjectCreate = false; failRefresh = true;
  await page.locator('#applyCreateObject').click(); await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
  await page.locator('#toast').filter({ hasText: '不要重复执行' }).waitFor(); failRefresh = false;
  expect(fixture.callsFor('execute_mutation').length === noWrite + 2, 'refresh failure retried CREATE');
  await page.locator('#beginTransaction').click(); await page.waitForFunction(() => !document.querySelector('#rollbackTransaction').disabled);
  await openMenu('app_reporting'); await action('create-schema').click(); await page.locator('#createObjectName').fill('blocked_in_transaction');
  const beforeBlocked = fixture.callsFor('execute_mutation').length;
  await page.locator('#applyCreateObject').click(); await page.locator('#createObjectFeedback').filter({ hasText: '先提交或回滚' }).waitFor();
  expect(fixture.callsFor('execute_mutation').length === beforeBlocked, 'direct creation dispatched inside active transaction');
  await page.locator('#cancelCreateObject').click(); await page.locator('#rollbackTransaction').click();
  await page.waitForFunction(() => !document.querySelector('#beginTransaction').disabled);
  const beforeTable = fixture.callsFor('execute_mutation').length;
  await openMenu('app_reporting');
  await action('create-table').click();
  const designer = page.locator('.create-table-dialog');
  await designer.waitFor();
  expect(await page.locator('#createObjectModal').isHidden(), 'table creation asked for a name before editing');
  expect(await designer.getByLabel('表名', { exact: true }).isHidden(), 'table name shown before saving');
  expect((await designer.locator('.structure-editor-target').innerText()).includes('开发库 / app_reporting / reporting'), 'designer lost the default schema of the selected database');
  expect(fixture.callsFor('execute_mutation').length === beforeTable, 'opening the designer executed SQL');
  await designer.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
  const noteField = designer.locator('[data-field-row="1"][data-field="name"]');
  await noteField.fill('id');
  expect(await designer.getByRole('button', { name: '保存…', exact: true }).isDisabled(), 'duplicate columns accepted');
  await noteField.fill('note');
  await chooseAppSelect(designer.locator('[data-default-mode]').nth(1), 'expression');
  await designer.locator('[data-field-row="1"][data-field="defaultValue"]').fill("'draft'");
  await designer.locator('[data-field-row="1"][data-field="comment"]').fill('说明');
  await page.screenshot({ path: resolve(evidence, 'new-table-fields.png') });
  await designer.getByRole('button', { name: '保存…', exact: true }).click();
  const nameField = designer.getByLabel('表名', { exact: true });
  const createButton = designer.getByRole('button', { name: '创建表', exact: true });
  expect(await createButton.isDisabled(), 'empty table name accepted');
  await nameField.fill('  ');
  expect(await createButton.isDisabled(), 'whitespace name accepted');
  await nameField.fill('items"new');
  expect((await designer.locator('pre').innerText()).includes('CREATE TABLE "reporting"."items""new"'), 'final SQL did not quote the table name');
  await page.keyboard.press('Escape');
  expect(await nameField.isHidden() && await noteField.inputValue() === 'note', 'Escape discarded field draft');
  await designer.getByRole('button', { name: '保存…', exact: true }).click();
  expect(await nameField.inputValue() === 'items"new', 'returning to save lost the name');
  expect(fixture.callsFor('execute_mutation').length === beforeTable, 'saving draft executed SQL before final confirmation');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
    await designer.screenshot({ path: resolve(evidence, `save-table-${theme}.png`) });
  }
  failTableCreate = true;
  await createButton.click();
  await designer.locator('.dialog-feedback').filter({ hasText: '表名已存在' }).waitFor();
  expect(await nameField.inputValue() === 'items"new', 'failed creation discarded the name');
  await designer.getByRole('button', { name: '返回编辑', exact: true }).click();
  expect(await noteField.inputValue() === 'note', 'failed creation discarded fields');
  await designer.getByRole('button', { name: '保存…', exact: true }).click();
  failTableCreate = false;
  await createButton.click();
  await designer.waitFor({ state: 'hidden' });
  const createdRequest = fixture.callsFor('execute_mutation').at(-1).args.request;
  expect(createdRequest.database === 'app_reporting' && createdRequest.schema === 'reporting', 'table was created in the wrong database/schema');
  expect(createdRequest.sql.includes('COMMENT ON COLUMN "reporting"."items""new"."note"'), 'field comment missing');
  expect((await page.locator('.query-tab.active').innerText()).includes('items"new'), 'created table structure was not activated');
  expect(fixture.callsFor('get_object_details').at(-1).args.database === 'app_reporting', 'new table structure opened in wrong database');
  expect((await page.locator('#structurePanel').innerText()).includes('items"new'), 'new table structure did not open');
  await openMenu('app_reporting'); await action('create-table').click();
  await designer.waitFor();
  await designer.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
  await designer.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#confirmActionModal').waitFor();
  await page.locator('#confirmActionAccept').click();
  await designer.waitFor({ state: 'hidden' });
  expect(fixture.callsFor('execute_mutation').length === beforeTable + 2, 'discarding draft executed SQL');
  await page.locator(".tree-root").click({ button: "right" });
  await action("refresh-databases").click();
  await page.locator(".tree-database[data-database='new_app']").waitFor();
  const count = await page.locator(".query-tab").count();
  await openMenu("app_reporting");
  await action("create-schema").click();
  await page.locator("#cancelCreateObject").click();
  expect(await page.locator(".query-tab").count() === count, "cancel created a tab");

  const beforeSchemas = fixture.callsFor("list_schemas").length;
  await openMenu("app_reporting");
  await action("refresh-database").click();
  await page.locator("#toast").getByText("数据库 app_reporting 已刷新", { exact: true }).waitFor();
  expect(fixture.callsFor("list_schemas").slice(beforeSchemas).every((call) => call.args.database === "app_reporting"), "refresh touched another database");
  failRefresh = true;
  await openMenu("app_reporting");
  await action("refresh-database").click();
  await page.locator("#toast[data-type='error']").filter({ hasText: "fixture refresh failure" }).waitFor();
  failRefresh = false;

  await page.reload({ waitUntil: "networkidle" });
  expect((await activeSavedTab()).database === "app_reporting", "database binding not persisted");
  await page.locator("[data-connection-id='mysql-local']").click();
  await openMenu("warehouse");
  expect(await action("create-schema").isHidden(), "MySQL exposes redundant PostgreSQL schema action");
  await action('create-database').click(); await page.locator('#createObjectName').fill('my`database');
  await chooseAppSelect(page.locator('#createObjectCharacterSettings select[aria-label="字符集"]'), 'utf8mb4');
  await chooseAppSelect(page.locator('#createObjectCharacterSettings select[aria-label="排序规则"]'), 'utf8mb4_bin');
  const mysqlTabs = await page.locator('.query-tab').count();
  await page.locator('#applyCreateObject').click(); await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
  expect(await page.locator('.query-tab').count() === mysqlTabs, 'MySQL database creation opened an SQL tab');
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'CREATE DATABASE `my``database` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;', 'MySQL database name escaped incorrectly');
  await openMenu('warehouse');
  await action('mysql-characters').click();
  await page.getByRole('dialog').filter({ hasText: '字符集和排序规则' }).getByRole('button', { name: '关闭' }).click();
  await page.locator('[data-display-databases]').click();
  await page.locator("#databaseList input[value='warehouse_reporting']").check();
  await page.locator('#applyDatabasePicker').click();
  await openMenu('warehouse_reporting');
  await action('drop-database').click();
  const confirmDialog = page.locator('#confirmActionModal');
  await confirmDialog.waitFor();
  expect(await page.locator('#confirmActionAccept').isEnabled(), 'confirmation should be directly actionable');
  await page.locator('#confirmActionCancel').click();
  await openMenu('warehouse_reporting'); await action('drop-database').click();
  await page.locator('#confirmActionAccept').click();
  await page.locator('#toast').filter({ hasText: '数据库 warehouse_reporting 已删除' }).waitFor();
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'DROP DATABASE `warehouse_reporting`;', 'wrong database deletion SQL');
  await openMenu('warehouse');
  await action("create-table").click();
  await designer.getByRole('button', { name: '保存…', exact: true }).click();
  await nameField.fill('items');
  await chooseAppSelect(designer.locator('select[aria-label="字符集"]'), 'utf8mb4');
  await chooseAppSelect(designer.locator('select[aria-label="排序规则"]'), 'utf8mb4_bin');
  expect((await designer.locator('pre').innerText()).includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'), 'MySQL table options missing');
  expect((await designer.locator('pre').innerText()).includes('CREATE TABLE `warehouse`.`items`'), 'MySQL table target incorrect');
  expect((await designer.locator('pre').innerText()).includes('AUTO_INCREMENT'), 'MySQL identity missing');
  failTableRefresh = true;
  await createButton.click();
  await designer.waitFor({ state: 'hidden' });
  await page.locator('#toast').filter({ hasText: '已创建，刷新失败' }).waitFor();
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.database === 'warehouse', 'MySQL creation used wrong database');
  failTableRefresh = false;
  const warehouse = page.locator(".tree-database[data-database='warehouse']");
  if (!await warehouse.evaluate(node => node.open)) await warehouse.locator(':scope > summary [data-tree-toggle]').click();
  await openMenu('warehouse'); await action('refresh-database').click();
  const itemRow = warehouse.locator('.tree-object[data-object-id]').filter({ hasText: 'items' }).first();
  await revealObject(itemRow);
  await itemRow.locator('.object-main').dblclick();
  await page.locator('#viewTableDdl').click();
  const ddlDialog = page.locator('.ddl-view-dialog');
  await ddlDialog.locator('.ddl-view-code').filter({ hasText: 'CREATE TABLE `warehouse`.`items`' }).waitFor();
  const mysqlDdl = await ddlDialog.locator('.ddl-view-code .cm-line').allTextContents().then(lines => lines.join('\n'));
  expect(mysqlDdl.includes('COLLATE=utf8mb4_bin'), 'MySQL DDL omitted native collation');
  expect(mysqlDdl.includes('\n  `id` bigint'), 'MySQL DDL line breaks were collapsed');
  expect(await ddlDialog.locator('.cm-lineWrapping').count() === 1, 'MySQL DDL wrapping was not enabled');
  expect(await ddlDialog.locator('.cm-line span[class]').count() > 0, 'MySQL SQL highlighting missing');
  expect(await ddlDialog.locator('.ddl-view-target').textContent() === 'warehouse.items', 'MySQL database name repeated');
  expect(await ddlDialog.locator('.ddl-view-info').isHidden(), 'PostgreSQL scope note leaked into MySQL');
  expect(await ddlDialog.locator('.ddl-view-simple, .ddl-view-full').count() === 0, 'DDL mode switch must not appear');
  await ddlDialog.locator('.ddl-view-done').click();
  await itemRow.click({ button: 'right' }); await action('drop-table').click();
  await page.locator('#confirmActionAccept').click();
  await page.locator('#toast').filter({ hasText: '表 warehouse.items 已删除' }).waitFor();
  expect(fixture.callsFor('execute_mutation').at(-1).args.request.sql === 'DROP TABLE `warehouse`.`items`;', 'wrong table deletion SQL');
  expect(errors.length === 0, errors.join("\n"));
  console.log("PASS: direct database/schema creation without SQL tabs, bound requests and quoted preview, duplicate/pending-dismissal guards, failure draft retention, success-versus-refresh distinction, direct table designer, cancel, persistence and PostgreSQL/MySQL routing.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
