import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: 'mysql-list', name: 'MySQL', driver: 'mysql', database: '', host: 'mysql.local', port: 3306, user: 'tester' });
const postgres = [
  { name: 'app', current: true }, { name: 'app_reporting' }, { name: 'postgres' }, { name: 'blocked', allowConnections: false },
];
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
  assert.deepEqual(errors, []);
  console.log('PASS: the status bar follows the selected host across drivers, and SQL trees retain filters, collapse system databases and load expanded objects lazily.');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
