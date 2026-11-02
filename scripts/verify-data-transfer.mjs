import { chooseAppSelect } from './app-select-driver.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { encodeDelimited } from '../src/data-transfer.js';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

// UI/IPC fixture only: no user database is read or modified.
const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/data-transfer'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const saves = [], imports = [];
let failImport = false;
const columns = [{ name: 'id', dataType: 'bigint', primaryKey: true, nullable: false }, { name: 'note', dataType: 'text', nullable: true }, { name: 'payload', dataType: 'jsonb', nullable: true }, { name: 'computed', dataType: 'integer', generated: true }];
const sourceRows = [['9007199254740993', 'alpha', '{"n":9007199254740995}', 2], ['2', 'beta', null, 3]];
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  if (command === 'get_object_details') return { kind: 'table', qualifiedName: 'public.orders', columns, indexes: [], constraints: [], definition: 'CREATE TABLE public.orders (...)' };
  if (command === 'execute_query' && args.request.sql.includes('"public"."orders"')) return { columns: columns.map(column => column.name), rows: sourceRows, row_count: 2 };
  if (command === 'save_text_file' || command === 'save_binary_file') { saves.push({ command, ...args }); return true; }
  if (command === 'execute_mutation' && args.request.sql.startsWith('INSERT')) {
    imports.push(args.request); if (failImport) throw new Error('fixture duplicate key'); return { row_count: 1 };
  }
  return fixture.invoke(command, args);
});
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timeout'); };
async function choose(format, name, contents) {
  await page.locator('#dataImportButton').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator(`[data-import-format="${format}"]`).click();
  await (await chooser).setFiles({ name, mimeType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain', buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents) });
}
const apply = () => page.locator('.data-import-dialog [data-apply]');
async function confirmImport() {
  const before = imports.length;
  await apply().click();
  await until(() => imports.length === before + 1);
  await page.locator('.data-import-dialog').waitFor({ state: 'detached' });
  await until(() => page.locator('#toast').innerText().then(text => text.includes('已导入 1 行')));
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="public.orders"] .object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  await page.locator('#resultFilter').fill('alpha');
  for (const format of ['sql', 'csv', 'json', 'txt', 'xlsx']) {
    await page.locator('#resultMore').click();
    await page.locator(`[data-export-format="${format}"]`).click();
    await until(() => saves.some(save => save.fileName.endsWith('.' + format)));
    const save = saves.at(-1); assert.ok(save.fileName.endsWith('.' + format));
    if (format === 'xlsx') {
      assert.equal(save.command, 'save_binary_file');
      const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(save.contents));
      assert.equal(book.worksheets[0].rowCount, 2);
      assert.equal(book.worksheets[0].getCell('A2').value, '9007199254740993');
    } else {
      assert.ok(save.contents.includes('9007199254740993'));
      assert.ok(!save.contents.includes('beta'));
      if (format === 'sql') assert.ok(!save.contents.includes('"computed"'));
    }
  }
  await page.locator('#resultFilter').fill('');
  const csv = encodeDelimited({ columns: ['external_id', 'label', 'payload'], rows: [['9007199254740997', '中文,"quote"\nline', '{"n":9007199254740999}']] });
  await choose('csv', 'source.csv', csv);
  await until(() => page.locator('.data-import-mapping select').count().then(count => count === 3));
  assert.ok(await apply().isDisabled());
  await chooseAppSelect(page.locator('[data-source-column="0"]'), 'id');
  await chooseAppSelect(page.locator('[data-source-column="1"]'), 'note');
  assert.ok(await apply().isEnabled()); assert.equal(imports.length, 0);
  await page.screenshot({ path: resolve(evidence, 'csv-mapping.png') });
  await page.locator('.data-import-dialog [data-close]').last().click(); assert.equal(imports.length, 0);
  await choose('csv', 'source.csv', csv);
  await until(() => page.locator('.data-import-mapping select').count().then(count => count === 3));
  await chooseAppSelect(page.locator('[data-source-column="0"]'), 'id'); await chooseAppSelect(page.locator('[data-source-column="1"]'), 'note');
  await confirmImport();
  assert.match(imports.at(-1).sql, /9007199254740997/); assert.match(imports.at(-1).sql, /9007199254740999/);
  assert.equal(imports.at(-1).connectionId, 'conn-dev'); assert.equal(imports.at(-1).database, 'app');
  await choose('json', 'source.json', '[{"id":9007199254740997,"note":"json","payload":{"n":9007199254740999}}]');
  await apply().waitFor(); await until(() => apply().isEnabled());
  failImport = true; await apply().click();
  await page.waitForFunction(() => document.querySelector('.data-import-feedback')?.textContent.includes('fixture duplicate key'));
  assert.ok(await page.locator('.data-import-dialog').isVisible());
  assert.match(await page.locator('.data-import-preview').innerText(), /9007199254740997/);
  assert.match(imports.at(-1).sql, /"n":9007199254740999/);
  failImport = false; await confirmImport();
  await choose('txt', 'source.txt', 'id\tnote\tpayload\n0003\t\t\\N');
  await until(() => apply().isEnabled()); await confirmImport();
  assert.match(imports.at(-1).sql, /E'0003', E'', NULL/);
  const book = new ExcelJS.Workbook(); book.addWorksheet('Empty'); const sheet = book.addWorksheet('Data'); sheet.addRow(['id', 'note', 'payload']); sheet.addRow(['0004', 'xlsx', null]);
  await choose('xlsx', 'source.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  await page.locator('[data-sheet-label]').waitFor();
  await chooseAppSelect(page.locator('[data-sheet]'), '1');
  await until(() => apply().isEnabled());
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.screenshot({ path: resolve(evidence, 'xlsx-min-window.png') });
  assert.ok(await page.locator('.data-import-dialog').evaluate(dialog => dialog.getBoundingClientRect().right <= innerWidth));
  await confirmImport();
  await page.locator('#beginTransaction').click();
  await page.locator('#commitTransaction').waitFor();
  await choose('json', 'transaction.json', '[{"id":"0008","note":"pending"}]');
  await until(() => apply().isEnabled()); await confirmImport();
  assert.match(await page.locator('#toast').innerText(), /尚未提交事务/);
  assert.ok(await page.locator('#commitTransaction').isVisible());
  await page.locator('#commitTransaction').click();
  await page.locator('#beginTransaction').waitFor();
  const beforeSql = imports.length;
  await choose('sql', 'source.sql', 'INSERT INTO "public"."orders" ("id") VALUES (5);');
  await page.waitForFunction(() => document.querySelector('#sqlEditor .cm-content')?.textContent.includes('VALUES (5)'));
  assert.equal(imports.length, beforeSql, 'SQL imports must open a draft without executing');
  assert.equal(await page.locator('.query-tab.active .tab-label').innerText(), 'source.sql');
  assert.deepEqual(errors, []);
  console.log('PASS: SQL/CSV/JSON/TXT/XLSX exports respect filters; native XLSX is valid; CSV mapping/cancel, lossless JSON, TXT NULL/empty, XLSX sheet selection, failure retention, target binding and SQL draft-only import.');
} finally {
  await browser.close(); await new Promise(done => server.close(done));
}
