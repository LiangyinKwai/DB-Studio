import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

// Browser fixture timings isolate frontend switching, including a simulated
// 120 ms catalog response. They are not real database latency measurements.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/tree-switching');
mkdirSync(evidence, { recursive: true });
const baseline = process.argv.includes('--baseline');
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const file = resolve(dist, (req.url || '/').split('?')[0].slice(1) || 'index.html');
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  const result = await fixture.invoke(command, args);
  if (command === 'get_object_details') {
    await new Promise((done) => setTimeout(done, 120));
    return { ...result, id: args.objectId, qualifiedName: args.objectId,
      schema: args.objectId.split('.')[0], name: args.objectId.split('.')[1] };
  }
  return result;
});
const page = await context.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const wait = async (predicate) => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error('condition timed out');
};
const object = (name) => page.locator(`[data-object-id='public.${name}'] .object-main`);
const activeId = () => page.locator('.query-tab.active').getAttribute('data-tab-id');
const closeAll = async () => {
  await page.locator('.query-tab.active').click({ button: 'right' });
  await page.locator('[data-tab-context-action="close-all"]').click();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator(".tree-database[data-database='app'] > summary").click();
  await page.locator(".tree-schema[data-schema='public'] > summary").click();
  await object('orders').dblclick();
  await wait(async () => (await page.locator('#resultCount').innerText()).trim() === '500');
  const ordersId = await activeId();
  await object('exact_100').dblclick();
  await wait(async () => (await page.locator('#resultCount').innerText()).trim() === '100');
  const exactId = await activeId();
  const requestsBefore = fixture.calls.length;
  const timings = [];
  for (let i = 0; i < 6; i++) {
    const name = i % 2 === 0 ? 'orders' : 'exact_100';
    const tabId = i % 2 === 0 ? ordersId : exactId;
    const measurement = await page.evaluate(({ name, tabId }) => new Promise((done, reject) => {
      const started = performance.now();
      let immediate;
      const isTarget = () => document.querySelector('.query-tab.active')?.dataset.tabId === tabId &&
        !document.querySelector('#resultGrid').hidden;
      const ready = () => isTarget() || document.querySelector('.structure-title')?.textContent.includes(`public.${name}`);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('table switch timeout')); }, 3000);
      const observer = new MutationObserver(() => {
        if (!ready()) return;
        observer.disconnect(); clearTimeout(timeout);
        requestAnimationFrame(() => done({ name, ms: performance.now() - started, immediate }));
      });
      observer.observe(document.querySelector('.main-pane'), { subtree: true, childList: true, attributes: true });
      document.querySelector(`[data-object-id='public.${name}'] .object-main`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      immediate = isTarget();
    }), { name, tabId });
    timings.push(measurement);
  }
  const report = { fixture: '120 ms catalog response; two already opened tables', timings,
    averageMs: timings.reduce((sum, value) => sum + value.ms, 0) / timings.length,
    extraRequests: fixture.calls.length - requestsBefore };
  writeFileSync(resolve(evidence, baseline ? 'before.json' : 'after.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (baseline) {
    console.log('BASELINE recorded.');
  } else {
    assert.ok(timings.every((value) => value.immediate), 'single click did not activate its existing table synchronously');
    assert.equal(report.extraRequests, 0, 'switching opened tables repeated catalog or data requests');
    assert.equal(await page.locator('.query-tab').count(), 2);
    // Switching must also preserve the table's view, not just its row data.
    await object('orders').click();
    await page.locator('[data-filter-column="0"]').click();
    const panel = page.locator('.db-grid-filter-panel');
    await panel.getByRole('button', { name: '筛选条件', exact: true }).click();
    await panel.locator('[role="option"][data-value="gt"]').click();
    await panel.getByLabel('筛选值', { exact: true }).fill('100');
    await panel.getByRole('button', { name: '应用筛选', exact: true }).click();
    await page.locator('[data-sort-column="0"]').click();
    await page.locator('[data-sort-column="0"]').click();
    await page.locator('[data-select-row="499"]').check();
    const viewport = page.locator('.db-grid-viewport');
    await viewport.evaluate((node) => { node.scrollTop = 320; });
    await page.waitForTimeout(50);
    const view = await page.evaluate(() => ({
      top: document.querySelector('.db-grid-viewport').scrollTop,
      cell: document.querySelector('.db-grid-body [data-column-index="0"]').textContent,
      filter: document.querySelector('.db-grid-filter-chip').textContent,
    }));
    const beforeSwitch = fixture.calls.length;
    await object('exact_100').click();
    assert.equal((await page.locator('#resultCount').innerText()).trim(), '100');
    assert.equal(await page.locator('.db-grid-filter-chip').count(), 0, 'table filter leaked into another table');
    await object('orders').click();
    assert.equal((await page.locator('#resultCount').innerText()).trim(), '400/500');
    assert.equal(await page.locator('.db-grid-filter-chip').innerText(), view.filter);
    assert.equal(await page.locator('.db-grid-viewport').evaluate((node) => node.scrollTop), view.top);
    assert.equal(await page.locator('.db-grid-body [data-column-index="0"]').first().innerText(), view.cell);
    assert.equal(await page.locator('#selectionCount').innerText(), '已选 1/400 行');
    assert.equal(fixture.calls.length, beforeSwitch, 'restoring a table view repeated database requests');
    // A new structure preview responds immediately and is promoted on the
    // second click, so a double-click still opens exactly one data tab.
    await closeAll();
    await object('orders').dblclick({ delay: 180 });
    await wait(async () => (await page.locator('#resultCount').innerText()).trim() === '500');
    assert.equal(await page.locator('.query-tab').count(), 1, 'double click left a redundant structure tab');
    await closeAll();
    await object('orders').click();
    assert.equal(await page.locator('.query-tab').count(), 1, 'single click still waits before opening a structure tab');
    await page.locator('.structure-title').waitFor();
    const structureId = await activeId();
    await object('exact_100').click();
    await page.locator('.structure-title').filter({ hasText: 'public.exact_100' }).waitFor();
    const detailsBefore = fixture.callsFor('get_object_details').length;
    await object('orders').click();
    assert.equal(await activeId(), structureId, 'single click failed to reuse the loaded structure tab');
    assert.equal(fixture.callsFor('get_object_details').length, detailsBefore, 'cached structure was read again');
    // An intentionally opened structure tab remains available when the user
    // later double-clicks the same object to open its separate data view.
    await object('orders').dblclick();
    await wait(async () => (await page.locator('#resultCount').innerText()).trim() === '500');
    assert.equal(await page.locator(`[data-tab-id='${structureId}']`).count(), 2, 'double click replaced an existing structure tab');
    await page.locator(`[data-tab-id='${structureId}'] .tab-select`).click();
    await page.locator('[data-refresh-structure]').click();
    await wait(() => fixture.callsFor('get_object_details').length === detailsBefore + 2);
    await page.locator('.structure-title').waitFor();
    await page.screenshot({ path: resolve(evidence, 'tree-single-click.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: immediate tree selection, loaded data/structure reuse, double-click promotion, explicit refresh and tab deduplication.');
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
