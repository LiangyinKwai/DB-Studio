import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, revealObject } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const fixture = createWorkspaceFixture();
const writes = [];
let failClipboard = false, failDetails = false;
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  window.__browserClipboardCalls = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() {
    window.__browserClipboardCalls++;
    return Promise.reject(new Error('WebView clipboard permission unavailable'));
  } } });
  const exec = document.execCommand.bind(document);
  document.execCommand = (command, ...args) => command === 'copy' ? false : exec(command, ...args);
});
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  if (command === 'write_clipboard_text') {
    if (failClipboard) throw new Error('native clipboard busy');
    writes.push(args.text); return;
  }
  const value = await fixture.invoke(command === 'get_object_ddl_details' ? 'get_object_details' : command, args);
  if (command === 'get_object_details' || command === 'get_object_ddl_details') {
    await new Promise(done => setTimeout(done, 300));
    if (failDetails) throw new Error('fixture metadata unavailable');
    return { ...value, tableDdl: { columnDefinitions: ['"id" integer NOT NULL', '"status" text'], beforeStatements: ["SELECT pg_catalog.set_config('search_path', E'pg_catalog', false);"], afterStatements: [], constraintIndexes: [], createPrefix: 'CREATE TABLE', createSuffix: '\nUSING "heap"', unsupportedReason: null } };
  }
  return value;
});
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  const object = page.locator('[data-object-id="public.orders"]');
  await revealObject(object);
  await object.click({ button: 'right' });
  await page.locator('[data-context-action="copy-ddl"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制 DDL');
  assert.match(writes[0], /CREATE TABLE "public"\."orders"/);
  assert.equal(await page.evaluate(() => window.__browserClipboardCalls), 0);
  await object.locator('.object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  const refreshPaths = await page.evaluate(() => ['#refreshSchema', '#refreshQueryTarget', '#refreshTableData', '[data-context-action="refresh-object"]'].map(selector => [...document.querySelectorAll(`${selector} svg path`)].map(path => path.getAttribute('d')).join('')));
  assert.ok(refreshPaths.every(path => path === refreshPaths[0] && path.length > 0), 'refresh icons differ');
  const beforeDdl = fixture.callsFor('execute_query').length;
  assert.equal(await page.locator('#viewTableDdl .tab-glyph').innerText(), 'DDL');
  assert.equal(await page.locator('#openTableSql .tab-glyph').innerText(), 'SQL');
  assert.equal(await page.locator('#openTableSql').getAttribute('aria-label'), '打开 SQL 编辑器');
  assert.equal(await page.locator('#viewTableDdl').getAttribute('aria-label'), '查看当前对象的 DDL');
  const ddlButtonBox = await page.locator('#viewTableDdl').boundingBox();
  const sqlButtonBox = await page.locator('#openTableSql').boundingBox();
  assert.equal(ddlButtonBox.width, sqlButtonBox.width);
  assert.equal(ddlButtonBox.height, sqlButtonBox.height);
  assert.ok(sqlButtonBox.x - (ddlButtonBox.x + ddlButtonBox.width) >= 3 && sqlButtonBox.x - (ddlButtonBox.x + ddlButtonBox.width) <= 6, 'DDL and SQL button spacing');
  await page.locator('#viewTableDdl').click();
  const dialog = page.locator('.ddl-view-dialog');
  assert.equal(await dialog.evaluate(node => node === document.activeElement), true, 'DDL opens without focusing its close button');
  assert.equal(await dialog.locator('.ddl-view-close').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  assert.equal(await dialog.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.locator('.ddl-view-close').evaluate(node => node === document.activeElement), true, 'keyboard can reach DDL close');
  assert.equal(await dialog.locator('.ddl-view-close').evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'keyboard focus must remain visible');
  assert.ok(await dialog.locator('.ddl-view-copy').isDisabled());
  await dialog.locator('.ddl-view-code').filter({ hasText: 'CREATE TABLE "public"."orders"' }).waitFor();
  const ddlDisplay = await dialog.locator('.ddl-view-code').evaluate(node => ({ text: [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'), width: node.getBoundingClientRect().width, parentWidth: node.parentElement.getBoundingClientRect().width }));
  assert.ok(await dialog.locator('.cm-lineWrapping').count());
  assert.ok(await dialog.locator('.cm-line span[class]').count(), 'SQL syntax highlighting missing');
  assert.equal(await dialog.locator('.cm-content').getAttribute('contenteditable'), 'false');
  assert.ok(await dialog.locator('.ddl-view-info').isVisible());
  assert.doesNotMatch(ddlDisplay.text, /-- 建表结构|-- 不含数据/);
  await dialog.locator('.ddl-view-wrap').click();
  assert.equal(await dialog.locator('.cm-lineWrapping').count(), 0);
  await dialog.locator('.ddl-view-wrap').click();
  assert.ok(await dialog.locator('.cm-lineWrapping').count());
  assert.match(ddlDisplay.text, /CREATE TABLE "public"\."orders" \(\n  "id"/);
  assert.ok(ddlDisplay.width > ddlDisplay.parentWidth / 2, 'DDL preview must fill the dialog');
  assert.ok((await dialog.locator('.ddl-view-code').boundingBox()).height <= 200, 'short DDL should not leave an oversized blank editor');
  assert.match(await dialog.locator('.ddl-view-target').textContent(), /app.*public\.orders/);
  mkdirSync(resolve(root, 'output/playwright/ddl-reader'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'output/playwright/ddl-reader/postgres.png') });
  // A drag started in the SQL text must not dismiss the dialog when it ends outside.
  const codeBox = await dialog.locator('.ddl-view-code').boundingBox();
  await page.mouse.move(codeBox.x + 30, codeBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 4 });
  await page.mouse.up();
  assert.ok(await dialog.isVisible());
  assert.equal(await dialog.locator('.ddl-view-simple, .ddl-view-full').count(), 0);
  assert.doesNotMatch(ddlDisplay.text, /set_config|USING "heap"/);
  await dialog.locator('.ddl-view-copy').click();
  assert.match(writes.at(-1), /CREATE TABLE "public"\."orders"/);
  assert.equal(writes.at(-1), writes[0], 'wrapping and highlighting must preserve exact DDL when copying');
  assert.equal(fixture.callsFor('execute_query').length, beforeDdl, 'viewing DDL executed SQL');
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await dialog.isVisible(), false, 'clicking the backdrop should close the DDL dialog');
  const dataTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator('#structureTab').click();
  assert.equal(await page.locator('#viewTableDdl .tab-glyph').innerText(), 'DDL');
  assert.equal(await page.locator('[data-view-ddl]').count(), 0);
  assert.equal(await page.locator('#viewTableDdl').getAttribute('aria-label'), '查看当前对象的 DDL');
  await page.locator('#viewTableDdl').click();
  await dialog.locator('.ddl-view-code').filter({ hasText: 'CREATE TABLE "public"."orders"' }).waitFor();
  await page.keyboard.press('Escape');
  // Closing during a slow read and failed metadata must not copy or execute anything.
  await page.locator('#viewTableDdl').click();
  await page.keyboard.press('Escape');
  failDetails = true;
  await page.locator('#viewTableDdl').click();
  await dialog.locator('.ddl-view-code').filter({ hasText: 'fixture metadata unavailable' }).waitFor();
  assert.ok(await dialog.locator('.ddl-view-copy').isDisabled());
  await dialog.locator('.ddl-view-done').click();
  failDetails = false;
  await page.locator(`[data-tab-id="${dataTabId}"] .tab-select`).click();
  await page.locator('#resultMore').click(); await page.locator('#copyResults').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('已复制 500 行'));
  assert.ok(writes.at(-1).includes('value-1'));
  failClipboard = true;
  await object.click({ button: 'right' }); await page.locator('[data-context-action="copy-ddl"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('native clipboard busy'));
  assert.deepEqual(errors, []);
  console.log('PASS: async right-click DDL and result copies use the native bridge with both browser copy methods denied; native errors remain visible.');
} finally {
  await browser.close(); await new Promise(done => server.close(done));
}
