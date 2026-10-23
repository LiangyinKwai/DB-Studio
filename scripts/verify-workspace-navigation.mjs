import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/workspace-navigation'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: 'mysql-ux', name: 'MySQL 开发库', driver: 'mysql', database: 'warehouse', host: 'fixture', port: 3306, user: 'test' });
const calls = []; let releaseDisconnect;
const columns = Array.from({ length: 80 }, (_, index) => ({ name: index ? `field_${index}` : 'id', dataType: index === 70 ? 'decimal(20,6)' : 'text', primaryKey: !index, nullable: Boolean(index) }));
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === 'disconnect_connection') { await new Promise(resolve => { releaseDisconnect = resolve; }); return true; }
  if ((args?.connectionId || args?.request?.connectionId) === 'mysql-ux') {
    if (command === 'get_query_context') return { database: 'warehouse', defaultSchema: 'warehouse', searchPath: ['warehouse'] };
    if (command === 'get_schema_objects') return [{ id: 'warehouse.wide_table', schema: 'warehouse', name: 'wide_table', kind: 'table', columns }];
    if (command === 'get_object_details') return { kind: 'table', columns, indexes: [], constraints: [], definition: 'CREATE TABLE wide_table (...)', mysql: { engine: 'InnoDB', sqlMode: '', serverVersion: '8.4' } };
    if (command === 'execute_query') return { columns: columns.map(field => field.name), rows: [columns.map((_, index) => String(index + 1))], row_count: 1 };
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
const count = command => calls.filter(call => call.command === command).length;
const until = async predicate => { for (let index = 0; index < 200; index++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timeout'); };
async function quickOpen(query, structure = false) {
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('combobox', { name: '搜索对象', exact: true }); await search.fill(query);
  await search.press(structure ? 'Shift+Enter' : 'Enter');
  await page.locator('.object-quick-open').waitFor({ state: 'hidden' });
}
async function fit() {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  for (const selector of ['#tableToolbar', '#resultFooter', '.result-heading']) {
    const metrics = await page.locator(selector).evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(metrics.scroll <= metrics.width + 1, `${selector} horizontally overflows: ${JSON.stringify(metrics)}`);
  }
  assert.ok(await page.locator('#resultFooter').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), 'result footer is clipped below the viewport');
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="public.orders"]').waitFor();
  const beforeSearch = calls.length;
  await page.locator('#openObjectQuick').click(); await page.getByRole('combobox', { name: '搜索对象', exact: true }).fill('db:app orders');
  assert.equal(calls.length, beforeSearch, 'searching cache must not run a query/catalog scan');
  const beforeStructure = count('execute_query');
  await page.getByRole('combobox', { name: '搜索对象', exact: true }).press('Shift+Enter');
  await page.locator('#structurePanel .structure-title').waitFor();
  assert.equal(count('execute_query'), beforeStructure, 'Shift+Enter should inspect rather than execute');
  await quickOpen('db:app orders'); await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  const original = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.keyboard.press('Meta+j'); await page.getByRole('combobox', { name: '搜索列', exact: true }).fill('status');
  await page.getByRole('combobox', { name: '搜索列', exact: true }).press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.columnIndex), '1');
  await page.locator('#resultGrid [data-position="0"][data-column-index="1"]').dblclick();
  await page.locator('.db-grid-edit-input').fill('local-draft');
  await until(() => page.locator(`[data-tab-id="${original}"].query-tab`).getAttribute('data-dirty-count').then(value => value === '1'));
  assert.ok(await page.locator('#workspaceAttention').isVisible());
  await quickOpen('exact_100'); await page.waitForFunction(() => document.querySelector('#tableToolbarTitle').textContent.includes('exact_100'));
  assert.equal(await page.locator(`[data-tab-id="${original}"].query-tab .tab-dirty`).innerText(), '1');
  const beforeAttention = count('execute_mutation');
  await page.locator('#workspaceAttention').click();
  const attention = page.locator('dialog.command-palette').filter({ has: page.getByRole('heading', { name: '待处理修改', exact: true }) });
  await attention.getByRole('combobox').press('Enter');
  assert.equal(await page.locator('.query-tab.active').getAttribute('data-tab-id'), original);
  assert.equal(count('execute_mutation'), beforeAttention, 'attention navigation must never save another table');
  await page.locator('#discardTableChanges').click(); await until(() => page.locator('#workspaceAttention').isHidden());
  await page.locator('#beginTransaction').click(); await until(() => page.locator('#commitTransaction').isVisible());
  assert.ok(await page.locator('#transactionState').isVisible());
  // Keep only the structure tab; the transaction still needs a usable entry.
  const dataTabs = await page.locator('.query-tab').evaluateAll(nodes => nodes.filter(node => node.querySelector('.tab-glyph').textContent !== 'DDL').map(node => node.dataset.tabId));
  for (const id of dataTabs) await page.locator(`[data-close-tab="${id}"]`).click();
  await page.locator('#workspaceAttention').click(); await attention.getByRole('combobox').press('Enter');
  await until(() => page.locator('#commitTransaction').isVisible());
  assert.ok(await page.locator('#queryToolbar').isVisible(), 'a structure-only transaction entry must open a usable SQL tab');
  const disconnects = count('disconnect_connection');
  await page.locator('#disconnectConnection').click(); await page.locator('#confirmActionModal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirmActionMessage').innerText(), /回滚.*数据库/s);
  await page.locator('#confirmActionCancel').click(); assert.equal(count('disconnect_connection'), disconnects);
  await page.locator('#disconnectConnection').click(); await page.locator('#confirmActionAccept').click();
  await until(() => Boolean(releaseDisconnect)); assert.ok(await page.locator('#runQuery').isDisabled()); assert.ok(await page.locator('#commitTransaction').isDisabled());
  releaseDisconnect(); await until(() => page.locator('#workspaceAttention').isHidden());
  // A Redis DB 0 key opens with its own connection even after SQL work.
  await page.locator('[data-connection-id="redis-local"]').click(); await page.locator('[data-redis-db="0"] > summary [data-tree-toggle]').click();
  await page.locator('[data-redis-key="cache:home"]').waitFor(); await quickOpen('cache:home');
  await until(() => calls.some(call => call.command === 'get_redis_value' && call.args.key === 'cache:home' && call.args.database === 0 && call.args.connectionId === 'redis-local'));
  assert.ok(await page.locator('#tableTransactionActions').isHidden());
  // Native query columns are strings; use table metadata for type search.
  await page.locator('[data-connection-id="mysql-ux"]').click(); await page.locator('.mysql-database[data-database="warehouse"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="warehouse.wide_table"]').waitFor(); await quickOpen('conn:MySQL wide_table');
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  assert.ok(await page.locator('#beginTransaction').isVisible(), 'MySQL table view must expose transactions');
  await page.keyboard.press('Meta+j'); await page.getByRole('combobox', { name: '搜索列', exact: true }).fill('decimal');
  await page.getByRole('combobox', { name: '搜索列', exact: true }).press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.columnIndex), '70');
  await page.locator('#beginTransaction').click(); await until(() => page.locator('#commitTransaction').isVisible());
  for (const theme of ['dark', 'light', 'ocean', 'forest', 'contrast']) {
    await page.locator('#themeButton').click(); await page.locator(`[data-theme-option="${theme}"]`).click();
    await page.evaluate(() => Promise.all([...document.querySelectorAll('#objectTree .selected')].flatMap(node => node.getAnimations().map(animation => animation.finished.catch(() => {})))));
    for (const width of [1440, 1060]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 680 }); await fit();
      await page.screenshot({ path: resolve(evidence, `${theme}-${width}.png`) });
    }
  }
  await page.locator('#workspaceAttention').click(); await page.screenshot({ path: resolve(evidence, 'pending-transactions.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  const windows = await browser.newContext({ viewport: { width: 1060, height: 680 } });
  await windows.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'Windows' }, configurable: true });
    window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  });
  await windows.exposeFunction('__FIXTURE_INVOKE__', invoke);
  const win = await windows.newPage(); await win.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  assert.equal(await win.locator('#openCommands kbd').innerText(), 'Ctrl P');
  assert.match(await win.locator('#openObjectQuick').getAttribute('title'), /Ctrl K/);
  assert.match(await win.locator('#locateColumn').getAttribute('title'), /Ctrl J/);
  await win.keyboard.press('Control+k'); await win.locator('.object-quick-open[open]').waitFor();
  await win.keyboard.press('Escape'); await win.keyboard.press('Control+p'); await win.locator('.command-palette[open]').waitFor();
  assert.ok((await win.locator('.command-palette[open] .command-palette-shortcut').allTextContents()).every(label => !label.includes('⌘')));
  await windows.close();
  console.log('PASS: cache-only quick open and Shift+Enter structure, Redis DB 0, typed wide-column navigation, dirty tab badges and attention without cross-table save, transaction recovery from structure-only tabs, disconnect rollback confirmation/lock, MySQL transaction UI and five-theme/narrow bounds.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
