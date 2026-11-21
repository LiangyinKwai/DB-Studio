import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const fixture = createWorkspaceFixture();
fixture.schemas.push({ name: 'test' });
fixture.profiles.push({ id: 'mysql-list', name: 'MySQL', driver: 'mysql', database: '', host: 'mysql.local', port: 3306, user: 'tester' });
const postgres = [
  { name: 'app', current: true }, { name: 'app_reporting' }, { name: 'postgres' }, { name: 'blocked', allowConnections: false },
];
let postgresSearchPath = ['public'];
const mysql = [
  { name: 'warehouse' }, { name: 'archive' }, { name: 'mysql' }, { name: 'information_schema' },
  { name: 'blocked', allowConnections: false },
];
const server = createServer((request, response) => {
  const file = resolve(dist, decodeURIComponent((request.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
  response.writeHead(200, { 'content-type': type });
  createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  window.__DB_STUDIO_FIXTURE__ = true;
});
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  const value = await fixture.invoke(command, args);
  if (command === 'list_databases') {
    if (args.connectionId === 'conn-dev') return postgres;
    if (args.connectionId === 'mysql-list') return mysql;
  }
  if (command === 'get_query_context' && args.connectionId === 'conn-dev' && value.database === 'app') {
    return { ...value, searchPath: postgresSearchPath };
  }
  return value;
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tree = page.locator('#objectTree');
const search = page.locator('#objectSearch');
const database = name => tree.locator(`.tree-database[data-database="${name}"]`);
const system = tree.locator('.system-databases');
const requests = (connection, ...commands) => commands.flatMap(command =>
  fixture.callsFor(command).filter(call => call.args.connectionId === connection));
const openDatabase = name => database(name).locator(':scope > summary [data-tree-toggle]').click();
const connect = id => page.locator(`[data-connection-id="${id}"]`).click();
const checkConnectedHost = async host => {
  await page.locator('#connectionMode').getByText('已连接', { exact: true }).waitFor();
  assert.equal(await page.locator('#serverInfo').innerText(), host);
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await connect('conn-dev');
  await database('app_reporting').waitFor();
  await checkConnectedHost('fixture.local');
  assert.equal(await database('app').locator('.tree-default-database').innerText(), '默认');
  assert.equal(await database('blocked').count(), 0);
  assert.equal(await system.getAttribute('open'), null);
  assert.equal(await system.locator('.tree-database[data-database="postgres"]').count(), 1);
  assert.ok(await database('postgres').isHidden());
  assert.equal(requests('conn-dev', 'list_schemas', 'get_schema_objects').length, 0);
  await search.fill('app_reporting');
  await database('app_reporting').waitFor();
  assert.equal(await database('app_reporting').getAttribute('open'), null);
  assert.equal(requests('conn-dev', 'list_schemas', 'get_schema_objects').length, 0);
  await search.fill('');
  await system.locator(':scope > summary').press('Enter');
  await database('postgres').waitFor();
  assert.equal(requests('conn-dev', 'list_schemas', 'get_schema_objects').length, 0);
  await system.locator(':scope > summary [data-tree-toggle]').click();
  await openDatabase('app');
  const schema = database('app').locator('.tree-schema[data-schema="public"]');
  await schema.waitFor();
  assert.deepEqual(requests('conn-dev', 'list_schemas').map(call => call.args.database), ['app']);
  assert.equal(requests('conn-dev', 'get_schema_objects').length, 0);
  await schema.locator(':scope > summary [data-tree-toggle]').click();
  await schema.locator('.tree-category[data-kind="table"]').waitFor();
  assert.deepEqual(requests('conn-dev', 'get_schema_objects').map(call => call.args.schemaName), ['public']);

  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseList input[value="app_reporting"]').uncheck();
  await page.locator('#applyDatabasePicker').click();
  assert.equal(await database('app_reporting').count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  await connect('conn-dev');
  await database('app').waitFor();
  assert.equal(await database('app_reporting').count(), 0);
  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseSelectAll').check();
  await page.locator('#applyDatabasePicker').click();
  await database('app_reporting').waitFor();

  await connect('mysql-list');
  await database('archive').waitFor();
  await checkConnectedHost('mysql.local');
  assert.equal(await database('blocked').count(), 0);
  assert.equal(await system.getAttribute('open'), null);
  assert.equal(requests('mysql-list', 'get_schema_objects', 'list_schemas').length, 0);
  await system.locator(':scope > summary [data-tree-toggle]').click();
  await database('information_schema').waitFor();
  assert.equal(requests('mysql-list', 'get_schema_objects', 'list_schemas').length, 0);
  await openDatabase('warehouse');
  await database('warehouse').locator('.tree-category[data-kind="table"]').waitFor();
  await checkConnectedHost('mysql.local');
  assert.deepEqual(requests('mysql-list', 'get_schema_objects').map(call => call.args.database), ['warehouse']);
  assert.equal(requests('mysql-list', 'list_schemas').length, 0);
  await page.locator('#collapseTree').click();
  assert.equal(await system.getAttribute('open'), null);
  assert.equal(await database('warehouse').getAttribute('open'), null);
  const before = requests('mysql-list', 'get_schema_objects').length;
  mysql.push({ name: 'new_project' });
  await page.locator('#refreshSchema').click();
  await database('new_project').waitFor();
  assert.equal(requests('mysql-list', 'get_schema_objects').length, before);
  await connect('redis-local');
  await checkConnectedHost('redis.local');
  await connect('conn-dev');
  await checkConnectedHost('fixture.local');
  if (await database('app').getAttribute('open') === null) await openDatabase('app');
  await database('app').locator('.tree-schema[data-schema="public"]').waitFor();
  await page.locator('#addQueryTab').click();
  const picker = page.locator('#querySchema');
  const options = page.locator('#querySchemaList [role="option"]');
  const chooseDatabase = async name => {
    if (await page.locator('#querySchemaMenu').isHidden()) await picker.click();
    const currentDatabase = page.locator('#querySchemaDatabase');
    if (!await currentDatabase.isVisible() || await currentDatabase.innerText() !== name) {
      await options.getByText(name, { exact: true }).click();
    }
    await page.locator('#querySchemaBack').waitFor();
  };
  await picker.waitFor({ state: 'visible' });
  await chooseDatabase('app');
  await page.locator('#querySchemaList [data-value="analytics"]').click();
  await tree.locator('[data-display-schemas="app"]').click();
  await page.locator('#schemaSelectAll').uncheck();
  await page.locator('#applySchemaPicker').click();
  assert.equal(await page.locator('#schemaModal [role="alert"]').innerText(), '至少选择一个要显示的 Schema');
  await page.locator('#schemaList input[value="public"]').check();
  assert.equal(await page.locator('#schemaModal [role="alert"]').innerText(), '');
  await page.locator('#applySchemaPicker').click();
  assert.equal(await picker.getAttribute('value'), 'analytics');
  assert.match(await page.locator('#editorHint').innerText(), /analytics.*已隐藏 Schema/);
  await picker.click();
  assert.equal(await page.locator('#querySchemaList [data-value="analytics"]').count(), 0);
  await page.locator('#querySchemaList [data-value="public"]').click();
  await picker.click();
  assert.equal(await page.locator('#querySchemaList [data-value="analytics"]').count(), 0);
  assert.equal(await options.count(), 1);
  await page.keyboard.press('Escape');

  await tree.locator('[data-display-schemas="app"]').click();
  await page.locator('#schemaList input[value="analytics"]').check();
  await page.locator('#schemaList input[value="public"]').uncheck();
  await page.locator('#applySchemaPicker').click();
  assert.equal(await picker.getAttribute('value'), 'public');
  const schemaLabel = page.locator('#querySchemaLabel');
  assert.equal(await schemaLabel.innerText(), 'app / 选择 Schema');
  for (const width of [1060, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await schemaLabel.evaluate(label => label.scrollWidth <= label.clientWidth), `Schema label truncated at ${width}px`);
  }
  await picker.click();
  assert.deepEqual(await options.allTextContents(), ['analytics']);
  assert.equal(await page.locator('#querySchemaCount').innerText(), '1 个 Schema');
  await page.keyboard.press('Escape');
  const editor = page.locator('#sqlEditor .cm-content');
  await editor.fill('SELECT 1');
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.schema, 'public');
  const oldQuery = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator('#addQueryTab').click();
  await chooseDatabase('app');
  assert.equal(await picker.getAttribute('value'), 'analytics');
  assert.equal(await schemaLabel.innerText(), 'app / analytics');
  await editor.fill('SELECT 2');
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.schema, 'analytics');
  await page.locator(`.query-tab[data-tab-id="${oldQuery}"] .tab-select`).click();
  assert.equal(await picker.getAttribute('value'), 'public');
  postgresSearchPath = ['public', 'analytics'];
  await picker.click();
  await page.waitForFunction(() => !document.querySelector('#querySchemaCount').textContent.includes('正在检查'));
  assert.deepEqual(await options.evaluateAll(rows => rows.map(row => row.dataset.value)), ['analytics']);
  await page.keyboard.press('Escape');
  postgresSearchPath = ['public'];
  await tree.locator('[data-display-schemas="app"]').click();
  await page.locator('#schemaList input[value="test"]').check();
  await page.locator('#applySchemaPicker').click();
  await page.locator('#addQueryTab').click();
  await chooseDatabase('app');
  await page.keyboard.press('Escape');
  assert.equal(await schemaLabel.innerText(), 'app / 选择 Schema');
  assert.match(await page.locator('#editorHint').innerText(), /app \/ 未选择 Schema/);
  assert.ok(await page.locator('#runQuery').isDisabled());
  const executions = fixture.callsFor('execute_query').length;
  await editor.fill('SELECT 3');
  await editor.press('Meta+Enter');
  await page.locator('#querySchemaMenu').waitFor({ state: 'visible' });
  assert.equal(fixture.callsFor('execute_query').length, executions);
  assert.deepEqual(await options.evaluateAll(rows => rows.map(row => row.dataset.value)), ['analytics', 'test']);
  assert.equal(await page.locator('#querySchemaList [aria-selected="true"]').count(), 0);
  await options.getByText('test', { exact: true }).click();
  assert.match(await page.locator('#editorHint').innerText(), /app \/ test/);
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.schema, 'test');
  await page.locator(`.query-tab[data-tab-id="${oldQuery}"] .tab-select`).click();
  assert.match(await page.locator('#editorHint').innerText(), /public.*已隐藏 Schema/);
  await tree.locator('[data-display-schemas="app"]').click();
  await page.locator('#schemaList input[value="public"]').check();
  await page.locator('#applySchemaPicker').click();
  await picker.click();
  await page.waitForFunction(() => !document.querySelector('#querySchemaCount').textContent.includes('正在检查'));
  assert.equal(await page.locator('#querySchemaList [data-value=""]').count(), 0);
  assert.equal(await page.locator('#querySchemaList [data-value="public"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  postgresSearchPath = [];
  await picker.click();
  await page.waitForFunction(() => !document.querySelector('#querySchemaCount').textContent.includes('正在检查'));
  await page.keyboard.press('Escape');
  await page.locator('#addQueryTab').click();
  await chooseDatabase('app');
  assert.match(await page.locator('#editorHint').innerText(), /app \/ 未选择 Schema/);
  assert.ok(await page.locator('#runQuery').isDisabled());
  assert.deepEqual(await options.evaluateAll(rows => rows.map(row => row.dataset.value)), ['public', 'analytics', 'test']);
  await page.keyboard.press('Escape');

  await page.locator(`.query-tab[data-tab-id="${oldQuery}"] .tab-select`).click();
  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseList input[value="app"]').uncheck();
  await page.locator('#applyDatabasePicker').click();
  assert.match(await page.locator('#editorHint').innerText(), /app（数据库已隐藏）/);
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.database, 'app');

  const contextsBefore = requests('conn-dev', 'get_query_context').length;
  await page.locator('#addQueryTab').click();
  assert.equal(await schemaLabel.innerText(), '选择数据库');
  assert.match(await page.locator('#editorHint').innerText(), /未选择数据库/);
  assert.ok(await page.locator('#runQuery').isDisabled());
  await editor.fill('SELECT 4');
  await editor.press('Meta+Enter');
  await page.locator('#querySchemaMenu').waitFor({ state: 'visible' });
  assert.equal(requests('conn-dev', 'get_query_context').length, contextsBefore);
  assert.deepEqual(await options.evaluateAll(rows => rows.map(row => row.dataset.value)), ['app_reporting', 'postgres']);
  await page.reload({ waitUntil: 'networkidle' });
  await database('app_reporting').waitFor();
  assert.equal(await schemaLabel.innerText(), '选择数据库');
  assert.equal(await editor.innerText(), 'SELECT 4');
  assert.ok(await page.locator('#runQuery').isDisabled());
  await chooseDatabase('app_reporting');
  await page.waitForFunction(() => document.querySelector('#querySchema').value === 'reporting');
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.database, 'app_reporting');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.schema, 'reporting');

  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseList input[value="postgres"]').uncheck();
  await page.locator('#applyDatabasePicker').click();
  await page.locator('#addQueryTab').click();
  assert.equal(await picker.getAttribute('value'), 'reporting');
  assert.match(await page.locator('#editorHint').innerText(), /app_reporting \/ reporting/);

  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseList input[value="app"]').check();
  await page.locator('#applyDatabasePicker').click();
  await picker.click();
  await page.locator('#querySchemaSearch').press('Shift+Tab');
  assert.ok(await page.locator('#querySchemaBack').evaluate(button => document.activeElement === button));
  await page.locator('#querySchemaBack').press('Enter');
  await chooseDatabase('app');
  await options.getByText('test', { exact: true }).waitFor();
  assert.equal(await schemaLabel.innerText(), 'app_reporting / reporting');
  await page.keyboard.press('Escape');
  assert.equal(await picker.getAttribute('value'), 'reporting');
  await picker.click();
  await page.locator('#querySchemaBack').click();
  await chooseDatabase('app');
  await options.getByText('test', { exact: true }).click();
  assert.equal(await schemaLabel.innerText(), 'app / test');
  await editor.fill('SELECT 5');
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => document.querySelector('#runQuery').getAttribute('aria-busy') === 'false');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.database, 'app');
  assert.equal(fixture.callsFor('execute_query').at(-1).args.request.schema, 'test');

  await connect('mysql-list');
  await page.locator('#addQueryTab').click();
  await picker.click();
  await page.locator('#querySchemaList [data-value="archive"]').click();
  await tree.locator('[data-display-databases]').click();
  await page.locator('#databaseSelectAll').uncheck();
  await page.locator('#applyDatabasePicker').click();
  assert.equal(await page.locator('#databaseModal [role="alert"]').innerText(), '至少选择一个要显示的数据库');
  await page.locator('#databaseList input[value="warehouse"]').check();
  assert.equal(await page.locator('#databaseModal [role="alert"]').innerText(), '');
  await page.locator('#applyDatabasePicker').click();
  assert.equal(await picker.getAttribute('value'), 'archive');
  await picker.click();
  assert.match(await page.locator('#querySchemaList [data-value="archive"]').innerText(), /已在对象树中隐藏/);
  await page.locator('#querySchemaList [data-value="warehouse"]').click();
  await picker.click();
  assert.equal(await page.locator('#querySchemaList [data-value="archive"]').count(), 0);
  assert.equal(await options.count(), 1);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS: the status bar follows the selected host across drivers, and SQL trees retain filters, collapse system databases and load expanded objects lazily.');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
