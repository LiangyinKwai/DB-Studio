import { chooseAppSelect } from './app-select-driver.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/connection-groups'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
let many = false;
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  const result = await fixture.invoke(command, args);
  return many && command === 'list_connections' ? [...result, ...Array.from({ length: 40 }, (_, index) => ({ ...result[0], id: `extra-${index}`, name: `项目实例 ${index + 1}`, host: `project-${index + 1}.local` }))] : result;
});
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(8000);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-card]').first().waitFor();
  await page.locator('#manageConnectionGroups').click();
  const dialog = page.locator('.connection-groups-dialog');
  const create = dialog.locator('.connection-group-create');
  for (const name of ['生产环境', '测试环境']) { await create.locator('input').fill(name); await create.getByRole('button', { name: '新建分组' }).click(); }
  const settings = dialog.locator('.connection-group-setting');
  const production = await settings.nth(0).getAttribute('data-group-id');
  const testing = await settings.nth(1).getAttribute('data-group-id');
  await chooseAppSelect(dialog.locator('[data-group-connection="conn-dev"]'), production);
  await chooseAppSelect(dialog.locator('[data-group-connection="conn-stage"]'), testing);
  await page.screenshot({ path: resolve(evidence, 'manager.png') });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const group = id => page.locator(`details[data-connection-group="${id}"]`);
  assert.equal(await group(production).locator('[data-connection-card="conn-dev"]').count(), 1);
  await group(production).locator('summary').click();
  assert.equal(await group(production).getAttribute('open'), null);
  await page.reload({ waitUntil: 'networkidle' });
  await group(production).waitFor(); assert.equal(await group(production).getAttribute('open'), null);
  await page.locator('#connectionSearch').fill('生产环境');
  await group(production).locator('[data-connection-id="conn-dev"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-connection-card]').count(), 1);
  await page.locator('#connectionSearch').fill('');
  assert.equal(await group(production).getAttribute('open'), null);
  await group(production).locator('summary').click();
  // Drag across groups moves membership as well as preserving the instance list.
  await group(production).locator('[data-connection-card="conn-dev"]').dragTo(group(testing).locator('[data-connection-card="conn-stage"]'));
  await group(testing).locator('[data-connection-card="conn-dev"]').waitFor();
  assert.equal(await page.locator('[data-connection-card]').count(), 3);
  // Per-connection context menu provides a direct route to assignment.
  await page.locator('[data-connection-id="conn-dev"]').click({ button: 'right' });
  await page.getByText('移动到分组…', { exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('input[type="search"]').inputValue(), '开发库');
  await dialog.locator('input[type="search"]').fill('');
  await settings.nth(1).locator('input').fill('个人项目');
  await settings.nth(1).getByRole('button', { name: '保存名称' }).click();
  assert.equal(await dialog.locator('[data-group-connection="conn-dev"] option:checked').innerText(), '个人项目');
  await dialog.locator(`[data-delete-group="${testing}"]`).click();
  assert.equal(await dialog.locator('[data-group-connection="conn-dev"]').inputValue(), '');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-connection-card]').first().waitFor();
  assert.equal(await group('').locator('[data-connection-card]').count(), 3);
  await page.screenshot({ path: resolve(evidence, 'sidebar.png') });
  // Group operations must not alter database configuration or credentials.
  assert.equal(fixture.calls.filter(call => ['save_connection', 'delete_connection', 'test_connection'].includes(call.command)).length, 0);
  many = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('[data-connection-card]').length === 43);
  await page.locator('#connectionSearch').fill('project-40.local');
  assert.equal(await page.locator('[data-connection-card]').count(), 1);
  await page.locator('#connectionSearch').fill('');
  await page.locator('#manageConnectionGroups').click();
  assert.ok(await dialog.locator('.connection-group-members').evaluate(node => node.scrollHeight > node.clientHeight));
  await dialog.locator('input[type="search"]').fill('project-40.local');
  assert.equal(await dialog.locator('[data-group-connection]').count(), 1);
  await page.evaluate(() => { document.body.dataset.theme = 'light'; });
  await page.screenshot({ path: resolve(evidence, 'manager-light-many.png') });
  assert.deepEqual(errors, []);
  console.log('Connection groups verified: create, assign, collapse persistence, group search, cross-group drag, context menu, rename, delete and reload.');
} finally { await context.close(); await browser.close(); await new Promise(done => server.close(done)); }
