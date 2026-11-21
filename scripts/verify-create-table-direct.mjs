import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { chooseAppSelect } from './app-select-driver.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/create-table-controls'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: 'mysql-local', name: 'MySQL 开发库', driver: 'mysql', host: 'mysql.fixture', port: 3306, database: 'warehouse', user: 'fixture' });
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  const value = await fixture.invoke(command, args);
  if (command !== 'get_object_details' || args.objectId !== 'public.orders') return value;
  return { ...value, indexes: [
    { name: 'orders_pkey', primary: true, unique: true, definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)' },
    { name: 'orders_status_idx', definition: 'CREATE INDEX orders_status_idx ON public.orders USING btree (status)' },
  ], constraints: [
    { name: 'orders_pkey', kind: 'primary_key', definition: 'PRIMARY KEY (id)' },
    { name: 'orders_status_check', kind: 'check', definition: "CHECK (status <> ''::text)" },
  ] };
});
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
const designer = page.locator('.create-table-dialog');
const row = index => designer.locator('tbody > tr').nth(index);
const field = (index, name) => row(index).locator(`[data-field="${name}"]`);
const parameter = (index, name) => row(index).locator(`[data-type-parameter="${name}"]`);
const mode = index => row(index).locator('[data-default-mode]');
const preview = () => designer.locator('.structure-sql-preview pre').innerText();
const save = () => designer.getByRole('button', { name: '下一步', exact: true });
const add = async (name, type) => {
  await designer.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
  const index = await designer.locator('tbody > tr').count() - 1;
  await field(index, 'name').fill(name);
  if (type) await field(index, 'dataType').fill(type);
  return index;
};
const open = async (connection, database) => {
  await page.locator(`[data-connection-id="${connection}"]`).click();
  await page.locator(`.tree-database[data-database="${database}"] > summary`).click({ button: 'right' });
  await page.locator('[data-context-action="create-table"]').click(); await designer.waitFor();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await open('conn-dev', 'app');
  const tableName = designer.getByLabel('表名', { exact: true });
  assert.equal(await tableName.isVisible(), true);
  assert.equal(await designer.locator('.structure-sql-preview').getAttribute('open'), null);
  await tableName.fill('direct_create_test');
  await field(0, 'name').fill('id');
  await add('amount', 'integer');
  await designer.getByRole('tab', { name: '索引' }).click();
  await designer.getByRole('button', { name: '＋ 添加索引' }).click();
  await designer.getByLabel('索引名称').fill('amount_idx');
  await chooseAppSelect(designer.locator('[role="tabpanel"]:visible select[aria-label="添加索引或约束字段"]'), '1');
  await designer.locator('.structure-sql-preview summary').click();
  assert.match(await preview(), /CREATE INDEX "amount_idx".*\("amount"\)/);
  await designer.screenshot({ path: resolve(evidence, 'create-index.png'), animations: 'disabled' });
  await designer.getByRole('tab', { name: '约束' }).click();
  await designer.getByRole('button', { name: '＋ 添加约束' }).click();
  await chooseAppSelect(designer.locator('[role="tabpanel"]:visible .structure-key-form select').first(), 'check');
  await designer.getByLabel('约束名称').fill('amount_nonnegative');
  await designer.getByLabel('检查表达式').fill('amount >= 0');
  const sql = await preview();
  assert.match(sql, /direct_create_test/);
  assert.match(sql, /CONSTRAINT "amount_nonnegative" CHECK \(amount >= 0\)/);
  await designer.getByRole('tab', { name: '字段' }).click();
  await field(1, 'name').fill('total');
  assert.match(await preview(), /CREATE INDEX "amount_idx".*\("total"\)/);
  await field(1, 'name').fill('amount');
  const count = fixture.callsFor('execute_mutation').length;
  await designer.getByRole('button', { name: '创建表', exact: true }).click();
  await designer.waitFor({ state: 'hidden' });
  assert.equal(fixture.callsFor('execute_mutation').length, count + 1);
  assert.equal(fixture.callsFor('execute_mutation').at(-1).args.request.sql, sql);
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  const publicSchema = page.locator('.tree-schema[data-schema="public"]');
  if (await publicSchema.getAttribute('open') === null) await publicSchema.locator(':scope > summary [data-tree-toggle]').click();
  const tableGroup = publicSchema.locator('.tree-category[data-kind="table"]');
  if (await tableGroup.locator('.category-summary').getAttribute('aria-expanded') === 'false') await tableGroup.locator('.category-summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="public.orders"] .object-main').click({ button: 'right' });
  await page.locator('[data-context-action="edit-structure"]').click();
  const edit = page.locator('.structure-editor-dialog');
  await edit.waitFor();
  await edit.getByRole('tab', { name: '索引' }).click();
  const index = edit.locator('.structure-key-card').filter({ hasText: 'orders_status_idx' });
  await index.locator('summary').click();
  await index.getByLabel('索引名称').fill('orders_status_updated');
  assert.match(await edit.locator('.structure-sql-preview pre').innerText(), /DROP INDEX "public"\."orders_status_idx"/);
  await edit.getByRole('tab', { name: '约束' }).click();
  const constraint = edit.locator('.structure-key-card').filter({ hasText: 'orders_status_check' });
  await constraint.locator('summary').click();
  await constraint.getByLabel('检查表达式').fill("status <> 'cancelled'");
  const primary = edit.locator('[role="tabpanel"]:visible .structure-key-card').filter({ hasText: 'orders_pkey' });
  await primary.locator('summary').click();
  assert.equal(await primary.getByLabel('约束名称').inputValue(), 'orders_pkey');
  await edit.getByRole('tab', { name: '定义' }).click();
  const editSql = await edit.locator('.structure-sql-preview pre').innerText();
  assert.match(editSql, /ADD CONSTRAINT "orders_status_check" CHECK \(status <> 'cancelled'\)/);
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('#confirmActionAccept').click();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(fixture.callsFor('execute_mutation').at(-1).args.request.sql, editSql);
  await page.setViewportSize({ width: 1060, height: 680 });
  await open('mysql-local', 'warehouse');
  await tableName.fill('mysql_create_test');
  await add('parent_id', 'bigint');
  await designer.getByRole('tab', { name: '约束' }).click();
  await designer.getByRole('button', { name: '＋ 添加约束' }).click();
  await chooseAppSelect(designer.locator('[role="tabpanel"]:visible .structure-key-form select').first(), 'foreign_key');
  await designer.getByLabel('约束名称').fill('parent_ref');
  await chooseAppSelect(designer.locator('[role="tabpanel"]:visible select[aria-label="添加索引或约束字段"]'), '1');
  await designer.getByLabel('引用表').fill('parents');
  await designer.getByLabel('引用字段（逗号分隔）').fill('id');
  await designer.locator('.structure-sql-preview summary').click();
  const mysqlSql = await preview();
  assert.match(mysqlSql, /CONSTRAINT `parent_ref` FOREIGN KEY \(`parent_id`\) REFERENCES `warehouse`\.`parents` \(`id`\)/);
  await designer.screenshot({ path: resolve(evidence, 'create-foreign-key.png'), animations: 'disabled' });
  await designer.getByRole('button', { name: '创建表', exact: true }).click();
  await designer.waitFor({ state: 'hidden' });
  assert.equal(fixture.callsFor('execute_mutation').at(-1).args.request.sql, mysqlSql);
  assert.deepEqual(errors, []);
  console.log('PASS: create and edit indexes and constraints, keep field bindings, and preview SQL from every tab');
} finally {
  await context.close(); await browser.close(); await new Promise(done => server.close(done));
}
