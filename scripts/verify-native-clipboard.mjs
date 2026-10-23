import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const fixture = createWorkspaceFixture();
const writes = [];
let failClipboard = false;
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
  const value = await fixture.invoke(command, args);
  if (command === 'get_object_details') {
    await new Promise(done => setTimeout(done, 300));
    return { ...value, tableDdl: { columnDefinitions: ['"id" integer NOT NULL', '"status" text'], beforeStatements: [], afterStatements: [], constraintIndexes: [], createPrefix: 'CREATE TABLE', createSuffix: '', unsupportedReason: null } };
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
  await object.click({ button: 'right' });
  await page.locator('[data-context-action="copy-ddl"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制 DDL');
  assert.match(writes[0], /CREATE TABLE "public"\."orders"/);
  assert.equal(await page.evaluate(() => window.__browserClipboardCalls), 0);
  await object.locator('.object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
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
