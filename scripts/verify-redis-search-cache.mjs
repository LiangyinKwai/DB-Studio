import { chooseAppSelect } from './app-select-driver.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const dist = resolve('dist'), evidence = resolve('output/playwright/redis-search-cache'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture(), calls = [];
fixture.profiles.push({ ...fixture.profiles.find(p => p.driver === 'redis'), id: 'redis-second', name: '第二个 Redis' });
const keys = new Map([[0, ['shared:db0', 'only-zero', 'literal:*[1]', 'Case:Upper']], [15, ['shared:db15', 'only-fifteen', 'literal:*[1]', ...Array.from({ length: 8 }, (_, i) => `tiny:${i}`), 'bulk:a', 'bulk:b']]]);
let releaseScan, holdScan = false, globalPagination = false;
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === 'list_redis_databases') return [{ index: 0, keyCount: 4 }, { index: 7, keyCount: 0 }, { index: 15, keyCount: 13 }];
  if (command === 'list_redis_keys') {
    if (args.database === 7) throw new Error('NOPERM DB 7');
    if (globalPagination && args.database === 0 && args.pattern === '*shared*' && !args.cursor) return { cursor: 7, keys: [], keyTypes: {} };
    const text = (args.pattern || '').replace(/^\*|\*$/g, '').replace(/\\(.)/g, '$1');
    if (holdScan && args.database === 15 && text === 'slow') {
      holdScan = false; await new Promise(done => { releaseScan = done; });
      return { cursor: 0, keys: ['stale:slow'], keyTypes: { 'stale:slow': 'string' }, keyCount: 13 };
    }
    const found = (keys.get(args.database) || []).filter(key => key.includes(text));
    return { cursor: 0, keys: found, keyTypes: Object.fromEntries(found.map(key => [key, 'string'])), keyCount: keys.get(args.database)?.length };
  }
  if (command === 'get_redis_value') {
    assert.equal(args.database, 15);
    const value = args.key.startsWith('bulk:') ? args.key + ':' + 'x'.repeat(8 * 1024 * 1024) : `VALUE:${args.key}:DB15`;
    return { key: args.key, keyType: 'string', ttl: -1, columns: ['value'], rows: [[value]], raw: value };
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
const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = []; page.on('pageerror', error => errors.push(error.message));
const listCalls = () => calls.filter(call => call.command === 'list_redis_keys');
const reads = key => calls.filter(call => call.command === 'get_redis_value' && call.args.key === key).length;
const row = (db, key) => page.locator(`[data-redis-db="${db}"][data-redis-key="${key}"] .object-main`);
const search = page.locator('#objectSearch'), scope = page.locator('#redisSearchDatabase');
const until = async predicate => { for (let i = 0; i < 180; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timed out'); };
const choose = async db => { await chooseAppSelect(scope, String(db)); };
const find = async (db, text) => { const before = listCalls().length; await search.fill(text); await until(() => listCalls().length > before); assert.equal(listCalls().at(-1).args.database, db); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id=redis-local]').click();
  await page.locator('[data-redis-db="0"] > summary [data-tree-toggle]').click(); await row(0, 'only-zero').waitFor();
  await page.locator('[data-redis-db="15"] > summary [data-tree-toggle]').click(); await row(15, 'only-fifteen').waitFor();
  assert.equal(await scope.inputValue(), '15');
  const before = listCalls().length; await find(15, 'only-fifteen'); await row(15, 'only-fifteen').waitFor();
  assert.equal(listCalls().length, before + 1); assert.ok(await row(0, 'only-zero').isVisible());
  await choose(0); assert.equal(await search.inputValue(), ''); await find(0, 'only-zero'); await row(0, 'only-zero').waitFor();
  await choose(15); assert.equal(await search.inputValue(), 'only-fifteen'); assert.ok(await row(0, 'only-zero').isVisible());
  const rapid = listCalls().length; await search.fill('s'); await search.fill('sh'); await search.fill('shared');
  await row(15, 'shared:db15').waitFor(); assert.equal(listCalls().length, rapid + 1);
  assert.equal(await scope.inputValue(), '15');
  await page.locator('[data-connection-id=redis-second]').click(); assert.equal(await search.inputValue(), '');
  await page.locator('[data-connection-id=redis-local]').click(); assert.equal(await scope.inputValue(), '15'); assert.equal(await search.inputValue(), 'shared');
  holdScan = true; await search.fill('slow'); await until(() => Boolean(releaseScan));
  await search.fill('shared'); await choose(0); assert.equal(await search.inputValue(), 'only-zero');
  releaseScan(); releaseScan = null; await page.waitForTimeout(80);
  assert.equal(await scope.inputValue(), '0'); assert.equal(await search.inputValue(), 'only-zero'); assert.equal(await page.locator('[data-redis-key="stale:slow"]').count(), 0);
  await row(15, 'shared:db15').waitFor();
  await choose(15); await find(15, '*['); await row(15, 'literal:*[1]').waitFor();
  assert.equal(listCalls().at(-1).args.pattern, '*\\*\\[*'); assert.ok(await row(0, 'only-zero').isVisible());
  await page.screenshot({ path: resolve(evidence, 'db-specific-search.png') });
  globalPagination = true;
  await choose('all');
  await search.fill('shared');
  await row(0, 'shared:db0').waitFor(); await row(15, 'shared:db15').waitFor();
  assert.equal(await scope.inputValue(), 'all');
  assert.ok(listCalls().some(call => call.args.database === 0 && call.args.cursor === 7));
  assert.ok(await page.locator('[data-redis-db="7"]').getByText(/NOPERM DB 7/).isVisible());
  // Selecting a result must not replace the all-DB search scope with its DB.
  await page.locator('[data-redis-db="15"][data-redis-key="shared:db15"]').click();
  assert.equal(await scope.inputValue(), 'all'); assert.equal(await search.inputValue(), 'shared');
  await page.locator('[data-connection-id=redis-second]').click(); assert.equal(await search.inputValue(), '');
  await page.locator('[data-connection-id=redis-local]').click(); assert.equal(await scope.inputValue(), 'all'); assert.equal(await search.inputValue(), 'shared');
  await page.screenshot({ path: resolve(evidence, 'global-search.png') });
  const beforeCollapse = listCalls().length;
  await page.locator('#collapseTree').click();
  assert.equal(await page.locator('.redis-database[open]').count(), 0);
  assert.equal(await scope.inputValue(), 'all'); assert.equal(await search.inputValue(), 'shared');
  assert.equal(listCalls().length, beforeCollapse, 'collapse must not issue scans');
  await page.locator('[data-connection-id=redis-second]').click();
  await page.locator('[data-connection-id=redis-local]').click();
  assert.equal(await page.locator('.redis-database[open]').count(), 0, 'collapsed state should survive switching connections');
  assert.equal(await search.inputValue(), 'shared');

  holdScan = true; await search.fill('slow'); await until(() => Boolean(releaseScan));
  await choose(0); assert.equal(await search.inputValue(), 'only-zero');
  releaseScan(); releaseScan = null;
  await row(0, 'only-zero').waitFor();
  assert.equal(await page.locator('[data-redis-key="stale:slow"]').count(), 0);
  await choose(15); assert.equal(await search.inputValue(), '*[');
  await find(15, ''); await row(15, 'tiny:0').waitFor();
  for (let i = 0; i < 8; i++) { await row(15, `tiny:${i}`).click(); await page.locator('#resultGrid').getByText(`VALUE:tiny:${i}:DB15`, { exact: true }).waitFor(); }
  const smallReads = reads('tiny:0');
  await page.locator('.query-tab').filter({ hasText: 'tiny:0' }).locator('.tab-select').click();
  await page.locator('#resultGrid').getByText('VALUE:tiny:0:DB15', { exact: true }).waitFor(); assert.equal(reads('tiny:0'), smallReads);
  for (const key of ['bulk:a', 'bulk:b']) { await row(15, key).click(); await until(() => reads(key) === 1); await page.waitForFunction(key => document.querySelector('#resultGrid [data-grid-cell]')?.textContent.startsWith(key + ':'), key); }
  await page.locator('.query-tab').filter({ hasText: 'tiny:0' }).locator('.tab-select').click();
  await page.locator('#resultGrid').getByText('VALUE:tiny:0:DB15', { exact: true }).waitFor();
  assert.equal(reads('tiny:0'), smallReads + 1);
  assert.equal(await page.locator('#messageTab').getAttribute('aria-selected'), 'false');
  assert.ok(!await page.locator('#messagePanel').innerText().then(text => text.includes('SQL 已保留')));
  await page.screenshot({ path: resolve(evidence, 'restored-key-preview.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: all-DB search, empty SCAN pagination, per-DB permission isolation, global scope restoration/cancellation, current-DB substring searches, per-DB/per-instance query restoration, literal MATCH escaping, debounce, late scan scope isolation, eight tiny key previews retained, byte-budget eviction and automatic original-DB reload.');
} finally { releaseScan?.(); await browser.close(); await new Promise(done => server.close(done)); }
