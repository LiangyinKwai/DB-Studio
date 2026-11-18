import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, revealObject } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/mysql-browser'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: 'mysql-local', name: 'MySQL 开发库', driver: 'mysql', database: '', host: 'mysql.fixture', port: 3306, user: 'root' });
const calls = [];
let failObjects = false, holdObjects = false, releaseObjects, transaction = false, mutationError = '', ordersName = 'orders';
function objects(database) {
  return [
    { id: `${database}.${ordersName}`, name: ordersName, schema: database, qualifiedName: `${database}.${ordersName}`, kind: 'table', columns: [{ name: 'id', dataType: 'bigint' }, { name: 'status', dataType: 'text', comment: '业务状态' }] },
    { id: `${database}.customers`, name: 'customers', schema: database, qualifiedName: `${database}.customers`, kind: 'table', columns: [{ name: 'id', dataType: 'bigint' }] },
    { id: `${database}.orders_view`, name: 'orders_view', schema: database, qualifiedName: `${database}.orders_view`, kind: 'view', columns: [] },
    { id: `mysql:function:["${database}","orders"]`, name: 'orders', schema: database, qualifiedName: `${database}.orders`, kind: 'function', columns: [] },
  ];
}
const invoke = async (command, args) => {
  calls.push({ command, args });
  const id = args?.connectionId || args?.request?.connectionId;
  if (id === 'mysql-local') {
    if (command === 'list_databases') return [{ name: 'warehouse', current: false }, { name: 'archive', current: false }];
    if (command === 'get_query_context') return { database: args.database || 'warehouse', defaultSchema: args.database || 'warehouse', searchPath: [args.database || 'warehouse'] };
    if (command === 'get_schema_objects') {
      assert.equal(args.schemaName, args.database);
      if (holdObjects) { holdObjects = false; await new Promise(resolve => { releaseObjects = resolve; }); return [{ ...objects(args.database)[0], id: `${args.database}.stale`, name: 'stale' }]; }
      if (failObjects) throw new Error('fixture MySQL catalog failed');
      return objects(args.database);
    }
    if (command === 'get_object_details') {
      if (args.kind === 'function') return { kind: 'function', columns: [], indexes: [], constraints: [], definition: 'CREATE FUNCTION `orders`() RETURNS INT DETERMINISTIC RETURN 42', mysql: { sqlMode: '', serverVersion: '8.4' } };
      return { kind: 'table', qualifiedName: `${args.database}.orders`, columns: [{ name: 'id', dataType: 'bigint', primaryKey: true, nullable: false, identity: true }, { name: 'status', dataType: 'varchar(64)', nullable: true, defaultValue: 'draft' }], indexes: [], constraints: [], definition: "CREATE TABLE `orders` (`id` bigint NOT NULL AUTO_INCREMENT, `status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'draft', PRIMARY KEY (`id`)) ENGINE=InnoDB", mysql: { sqlMode: 'STRICT_TRANS_TABLES', serverVersion: '8.4', engine: 'InnoDB' } };
    }
    if (command === 'execute_query') return { columns: ['id', 'status'], rows: [['9007199254740993', 'open']], row_count: 1 };
    if (command === 'begin_transaction') { transaction = true; return true; }
    if (command === 'rollback_transaction' || command === 'commit_transaction') { transaction = false; return true; }
    if (command === 'execute_mutation') {
      if (mutationError) { const error = mutationError; mutationError = ''; transaction = false; throw new Error(error); }
      if (transaction && /ALTER/i.test(args.request.sql)) throw new Error('当前 MySQL 事务保留未提交；DDL 可能隐式提交，请先提交或回滚事务后执行');
      if (args.request.sql === 'RENAME TABLE `warehouse`.`orders` TO `warehouse`.`orders_new`;') ordersName = 'orders_new';
      return { columns: ['result'], rows: [['ok']], row_count: 1 };
    }
  }
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const callsFor = command => calls.filter(call => call.command === command);
const mysqlCalls = command => callsFor(command).filter(call => call.args?.connectionId === 'mysql-local');
const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timeout'); };
const select = async id => { await page.locator(`[data-connection-id="${id}"]`).click(); await page.waitForFunction(id => document.querySelector(`[data-connection-toggle="${id}"]`).dataset.status === 'connected', id); };
const order = () => page.locator('[data-connection-card]').evaluateAll(cards => cards.map(card => card.dataset.connectionCard));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await select('mysql-local');
  assert.equal(mysqlCalls('get_schema_objects').length, 0);
  await page.locator('.mysql-database[data-database="warehouse"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="warehouse.orders"]').waitFor({ state: "attached" });
  assert.equal(await page.locator('.tree-schema').count(), 0);
  assert.equal(await page.locator('[data-display-schemas]').count(), 0);
  const tableGroup = page.locator('.mysql-database[data-database="warehouse"] .tree-category[data-kind="table"]');
  assert.equal(await tableGroup.locator('.tree-object').count(), 2);
  assert.equal(await tableGroup.locator('.category-summary').getAttribute('aria-expanded'), 'false');
  assert.equal(await tableGroup.locator('.tree-object:visible').count(), 0);
  assert.ok(await page.locator('.mysql-database[data-database="warehouse"] .tree-category[data-kind="routine"] > .category-summary').isVisible());
  await page.locator('#objectSearch').fill('customers');
  assert.equal(await tableGroup.locator('.tree-object:visible').count(), 1);
  assert.equal(await page.locator('.mysql-database[data-database="warehouse"] .tree-category[data-kind="event"]').count(), 0);
  await page.locator('#objectSearch').fill('');
  assert.equal(await tableGroup.locator('.tree-object:visible').count(), 0);
  assert.equal(await page.locator('.mysql-database[data-database="warehouse"] .tree-category[data-kind="event"] .count').innerText(), '0');
  assert.equal(await page.locator('.mysql-database[data-database="warehouse"] .tree-category[data-kind="saved_query"]').count(), 0);
  await tableGroup.getByRole('button', { name: '展开 表', exact: true }).click();
  assert.equal(await tableGroup.locator('.tree-object:visible').count(), 2);
  assert.equal(mysqlCalls('list_schemas').length, 0);
  assert.equal(mysqlCalls('get_schema_objects').length, 1);
  await page.locator('[data-object-id="warehouse.orders"] .object-main').click();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  assert.equal(callsFor('execute_query').at(-1).args.request.database, 'warehouse');
  assert.match(callsFor('execute_query').at(-1).args.request.sql, /`warehouse`\.`orders`/);
  const dataTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  // AUTO_INCREMENT keys are editable values. Follow-up cells must use the
  // new key without refreshing the table or losing integer precision.
  await page.locator('#resultGrid [data-position="0"][data-column-index="0"]').dblclick();
  await page.locator('.db-grid-edit-input').fill('9007199254740997'); await page.keyboard.press('Meta+s');
  await until(() => page.locator('#saveTableChanges').isDisabled());
  assert.ok(callsFor('execute_mutation').at(-1).args.request.sql.includes("SET `id` = CONVERT(X'39303037313939323534373430393937'"));
  assert.ok(callsFor('execute_mutation').at(-1).args.request.sql.includes("WHERE `id` <=> CONVERT(X'39303037313939323534373430393933'"));
  await page.locator('#resultGrid [data-position="0"][data-column-index="1"]').dblclick();
  await page.locator('.db-grid-edit-input').fill('key-followup'); await page.keyboard.press('Control+s');
  await until(() => page.locator('#saveTableChanges').isDisabled());
  assert.ok(callsFor('execute_mutation').at(-1).args.request.sql.includes("WHERE `id` <=> CONVERT(X'39303037313939323534373430393937'"));
  // Native metadata enables safe attribute edits rather than a rename-only form.
  await page.locator('#structureTab').click(); await page.locator('[data-edit-structure]').click();
  const editor = page.locator('.structure-editor-dialog'); await editor.waitFor();
  assert.deepEqual(await editor.getByRole('tab').allInnerTexts(), ['字段', '索引', '约束', '触发器', '定义']);
  assert.equal(await page.locator('#resultFooter').isVisible(), false);
  const apply = editor.getByRole('button', { name: '预览并应用' });
  assert.ok(await apply.isDisabled());
  await editor.getByRole('button', { name: 'status · 上移' }).click();
  assert.ok(await apply.isEnabled());
  assert.match(await editor.locator('.structure-sql-preview pre').innerText(), /DEFAULT 'draft' FIRST/);
  await editor.getByRole('button', { name: 'status · 下移' }).click();
  assert.ok(await apply.isDisabled());
  assert.ok(await editor.locator('[data-field-row="1"][data-field="dataType"]').isEnabled());
  assert.equal(await editor.locator('[data-field-row="1"][data-field="defaultValue"]').inputValue(), "'draft'");
  await editor.locator('[data-field-row="1"][data-field="dataType"]').fill('varchar(128)');
  await editor.getByRole('button', { name: 'status · 上移' }).click();
  assert.deepEqual(await editor.locator('[data-field="name"]').evaluateAll(fields => fields.map(field => field.value)), ['status', 'id']);
  assert.match(await editor.locator('.structure-sql-preview pre').innerText(), /MODIFY COLUMN `status` varchar\(128\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'draft' FIRST/);
  await editor.getByRole('tab', { name: '索引' }).click();
  assert.ok(await editor.getByRole('tabpanel').getByText('没有索引').isVisible());
  await editor.getByRole('tab', { name: '字段' }).click();
  assert.equal(await editor.locator('[data-field-row="0"][data-field="name"]').inputValue(), 'status');
  await editor.getByRole('button', { name: '取消', exact: true }).click(); await page.locator('#confirmActionAccept').click(); await editor.waitFor({ state: 'detached' });
  await page.locator(`[data-tab-id="${dataTabId}"] .tab-select`).click();
  const styles = await page.locator('#dataImportButton, #resultMore').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button); return [style.width, style.height, style.padding, style.border, style.backgroundColor, style.gap];
  }));
  assert.deepEqual(styles[0], styles[1]);
  await page.locator('#dataImportButton').click(); assert.equal(await page.locator('#dataImportMenu [role="menuitem"]').count(), 5); await page.keyboard.press('Escape');
  await page.locator('#resultMore').click(); assert.equal(await page.locator('#resultMoreMenu [data-export-format]').count(), 5); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.connection-card[data-connection-card="conn-dev"] .driver-brand-icon').count(), 1);
  assert.equal(await page.locator('.connection-card[data-connection-card="redis-local"] .driver-brand-icon').count(), 1);
  await page.screenshot({ path: resolve(evidence, 'mysql-toolbar-and-icons.png') });
  // A function can have the same name as a table without reusing its data tab.
  await page.locator('.mysql-database [data-kind="routine"] [data-tree-toggle]').click();
  await page.locator('.mysql-database .tree-object[data-kind="function"] .object-main').dblclick();
  await page.locator('#structurePanel .routine-definition .cm-content').waitFor();
  assert.match(await page.locator('#structurePanel').innerText(), /CREATE FUNCTION/);
  assert.equal(await page.locator('.query-tab.active .tab-glyph[data-catalog-icon="function"] svg text').textContent(), 'ƒx');
  assert.equal(await page.locator('.query-tab.active .tab-label').innerText(), 'orders');
  assert.notEqual(await page.locator('.query-tab.active').getAttribute('data-tab-id'), dataTabId);
  await page.locator(`[data-tab-id="${dataTabId}"] .tab-select`).click();
  await page.locator('#openTableSql').click();
  await page.locator('#beginTransaction').click();
  await until(() => page.locator('#rollbackTransaction').isEnabled());
  const sql = page.locator('#sqlEditor .cm-content');
  const run = async text => {
    const before = callsFor('execute_mutation').length;
    await sql.fill(text); await page.locator('#runQuery').click();
    await page.locator('#confirmActionModal').waitFor({ state: 'visible' }); await page.locator('#confirmActionAccept').click();
    await until(() => callsFor('execute_mutation').length > before); await until(() => page.locator('#runQuery').isEnabled());
  };
  await run('ALTER TABLE `warehouse`.`orders` ADD note int;');
  assert.ok(await page.locator('#rollbackTransaction').isEnabled(), 'preflight DDL rejection retains transaction');
  mutationError = '[TX_ROLLED_BACK] MySQL 事务已回滚：fixture conflict';
  await run('UPDATE `warehouse`.`orders` SET status=1;');
  assert.ok(await page.locator('#beginTransaction').isEnabled()); assert.ok(await page.locator('#rollbackTransaction').isDisabled());
  const objectsBeforeDdl = mysqlCalls('get_schema_objects').length;
  await run('ALTER TABLE `warehouse`.`orders` ADD note int;');
  assert.ok(mysqlCalls('get_schema_objects').length > objectsBeforeDdl, 'successful DDL refreshes catalog');
  await page.locator(`[data-tab-id="${dataTabId}"] .tab-select`).click();
  assert.match(await page.locator('#resultMeta').innerText(), /表结构已改变/);
  await page.locator('#refreshTableData').click(); await until(() => page.locator('#resultMeta').innerText().then(text => !text.includes('表结构已改变')));
  await page.locator('#objectSearch').fill('业务状态');
  await page.locator('[data-object-id="warehouse.orders"]').waitFor();
  assert.equal(await page.locator('[data-object-id="warehouse.customers"]').count(), 0);
  await page.locator('#objectSearch').fill('');
  await page.locator('.mysql-database [data-kind="view"] [data-tree-toggle]').click();
  await page.locator('[data-object-id="warehouse.orders_view"]').waitFor();
  const beforeSwitch = mysqlCalls('get_schema_objects').length;
  await select('conn-dev');
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"]').waitFor();
  await select('mysql-local');
  assert.equal(await page.locator('.mysql-database[data-database="warehouse"]').getAttribute('open'), '');
  assert.equal(await page.locator('.mysql-database [data-kind="view"] .category-summary').getAttribute('aria-expanded'), 'true');
  assert.equal(mysqlCalls('get_schema_objects').length, beforeSwitch);
  failObjects = true;
  await page.locator('.mysql-database > summary').click({ button: 'right' });
  await page.locator('[data-context-action="refresh-database"]').click();
  await page.locator('[data-retry-mysql-db="warehouse"]').waitFor();
  assert.ok(await page.locator('[data-object-id="warehouse.orders"]').isVisible());
  failObjects = false; await page.locator('[data-retry-mysql-db="warehouse"]').click();
  await page.locator('[data-retry-mysql-db]').waitFor({ state: 'detached' });
  await page.locator('[data-display-databases]').click();
  await page.locator('#databaseModal input[type="checkbox"][value="archive"]').check();
  await page.locator('#applyDatabasePicker').click();
  await page.locator('.mysql-database[data-database="archive"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="archive.orders"]').waitFor({ state: 'attached' });
  assert.ok(mysqlCalls('get_schema_objects').some(call => call.args.database === 'archive'));
  assert.equal(await page.locator('.tree-schema').count(), 0);
  holdObjects = true;
  await page.locator('.mysql-database[data-database="warehouse"] > summary').click({ button: 'right' });
  await page.locator('[data-context-action="refresh-database"]').click(); await until(() => Boolean(releaseObjects));
  await select('conn-dev'); releaseObjects(); await new Promise(done => setTimeout(done, 100));
  assert.equal(await page.locator('[data-name="stale"]').count(), 0);
  await select('mysql-local');
  const connectionsBeforeDrag = callsFor('connect_connection').length;
  const queriesBeforeDrag = callsFor('execute_query').length;
  const card = id => page.locator(`[data-connection-card="${id}"]`);
  const source = await card('mysql-local').locator('strong').boundingBox();
  const target = await card('conn-dev').boundingBox();
  const beforeDrag = await order();
  const startDrag = async () => {
    await page.mouse.move(source.x + 5, source.y + 5);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + 10, { steps: 8 });
    await card('conn-dev').locator('xpath=self::*[@data-drop-position="before"]').waitFor();
    assert.equal(await card('mysql-local').evaluate(node => getComputedStyle(node).opacity), '1');
  };
  await startDrag();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await order(), beforeDrag);
  assert.equal(await page.locator('[data-drop-position], .connection-dragging').count(), 0);
  await startDrag();
  await page.mouse.up();
  await until(() => order().then(ids => ids[0] === 'mysql-local'));
  assert.equal(callsFor('connect_connection').length, connectionsBeforeDrag);
  assert.equal(callsFor('execute_query').length, queriesBeforeDrag);
  assert.equal(await page.locator('.connection-card.selected').getAttribute('data-connection-card'), 'mysql-local');
  await page.locator('[data-connection-id="mysql-local"]').focus(); await page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual(await order(), ['conn-dev', 'mysql-local', 'conn-stage', 'redis-local']);
  await page.locator('#connectionSearch').fill('开发库');
  await card('mysql-local').dragTo(card('conn-dev'), { sourcePosition: { x: 4, y: 4 }, targetPosition: { x: 4, y: 2 } });
  await until(() => order().then(ids => ids[0] === 'mysql-local'));
  await page.locator('#connectionSearch').fill('');
  assert.deepEqual(await order(), ['mysql-local', 'conn-dev', 'conn-stage', 'redis-local']);
  await page.screenshot({ path: resolve(evidence, 'mysql-light.png') });
  await page.reload({ waitUntil: 'networkidle' });
  await until(() => order().then(ids => ids[0] === 'mysql-local'));
  assert.deepEqual(await order(), ['mysql-local', 'conn-dev', 'conn-stage', 'redis-local']);
  await page.locator('.mysql-database[data-database="warehouse"] > summary [data-tree-toggle]').click();
  await revealObject(page.locator('[data-object-id="warehouse.orders"]'));
  for (const theme of ['light', 'dark']) {
    await page.locator('#themeButton').click(); await page.locator(`[data-theme-option="${theme}"]`).click();
    await page.setViewportSize({ width: 1060, height: 680 });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.screenshot({ path: resolve(evidence, `mysql-${theme}-1060.png`) });
  }
  await page.locator('[data-object-id="warehouse.orders"] .object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  const renameTabsBefore = await page.locator('.query-tab').count();
  await page.locator('[data-object-id="warehouse.orders"]').click({ button: 'right' }); await page.locator('[data-context-action="rename-table"]').click();
  await page.locator('#createObjectName').fill('orders_new');
  await page.screenshot({ path: resolve(evidence, 'direct-rename-dialog.png') });
  await page.locator('#applyCreateObject').click(); await page.locator('#createObjectModal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.query-tab').count(), renameTabsBefore, 'direct rename must reuse data/structure tabs');
  assert.match(await page.locator('.query-tab.active').innerText(), /orders_new/);
  await page.locator('[data-object-id="warehouse.orders_new"][aria-current="true"]').waitFor();
  await page.locator('#refreshTableData').click(); await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  assert.match(callsFor('execute_query').at(-1).args.request.sql, /`warehouse`\.`orders_new`/);
  assert.deepEqual(errors, []);
  console.log('PASS: MySQL native attribute editor, routine/table name isolation, transaction rejection versus rollback, DDL catalog/data invalidation, import/export style and menus, brand icons, collapsible table group, DB scope/search/views/retry, stale-response isolation, PG schema retention and persistent drag/keyboard ordering.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
