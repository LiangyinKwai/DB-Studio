import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/redis-key-icons'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture(), calls = [];
const known = { 'hash:actually_string': 'string', 'users:1001': 'hash', 'queue:emails': 'list', 'tags:popular': 'set', 'leaderboard:daily': 'zset', 'events:orders': 'stream', 'unknown:type': null, 'expired:key': 'none', 'document:1': 'ReJSON-RL', '<img>': 'string', same: 'string' };
let noTypes = false, loadedType = 'string';
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === 'list_redis_keys') {
    if (args.database === 1) return { cursor: 0, keys: ['same'], keyTypes: { same: 'hash' }, keyCount: 1 };
    if (args.cursor) return { cursor: 0, keys: ['same', 'extra'], keyTypes: { same: 'hash', extra: 'list' } };
    return { cursor: 9, keys: Object.keys(known), keyTypes: noTypes ? {} : Object.fromEntries(Object.entries(known).filter(([, value]) => value)), keyCount: Object.keys(known).length + 1 };
  }
  if (command === 'get_redis_value') return { key: args.key, keyType: loadedType, ttl: 120, columns: loadedType === 'hash' ? ['field', 'value'] : ['value'], rows: loadedType === 'hash' ? [['name', 'Ada']] : [['215424']], raw: '215424' };
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const db = index => page.locator(`[data-redis-db="${index}"].redis-database`);
const key = (name, index = 0) => db(index).locator('[data-redis-key]').filter({ has: page.getByRole('button', { name, exact: true }) });
const count = command => calls.filter(call => call.command === command).length;
const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timeout'); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="redis-local"]').click();
  await db(0).locator(':scope > summary [data-tree-toggle]').click(); await key('users:1001').waitFor();
  assert.equal(count('list_redis_keys'), 1); assert.equal(count('get_redis_value'), 0, 'icons must not fetch individual values');
  assert.equal(await db(0).locator(':scope > summary .count').innerText(), String(Object.keys(known).length + 1), 'expand must update stale DB count from server total');
  for (const [name, type] of Object.entries(known)) {
    const safe = !type ? 'unknown' : type === 'none' ? 'missing' : type === 'ReJSON-RL' ? 'module' : type;
    assert.equal(await key(name).getAttribute('data-redis-type'), safe);
    assert.equal(await key(name).locator(`.redis-key-icon--${safe}`).count(), 1);
  }
  assert.equal(await db(0).locator('img').count(), 0);
  await db(0).locator(':scope > summary [data-tree-toggle]').click();
  known['external:new'] = 'list';
  const scansBeforeReopen = count('list_redis_keys');
  await db(0).locator(':scope > summary [data-tree-toggle]').click(); await key('external:new').waitFor();
  assert.equal(count('list_redis_keys'), scansBeforeReopen + 1, 'manual re-expand must refresh cached DB');
  assert.equal(await db(0).locator(':scope > summary .count').innerText(), String(Object.keys(known).length + 1));
  await db(1).locator(':scope > summary [data-tree-toggle]').click(); await key('same', 1).waitFor();
  assert.equal(await key('same', 0).getAttribute('data-redis-type'), 'string'); assert.equal(await key('same', 1).getAttribute('data-redis-type'), 'hash');
  await db(1).locator(':scope > summary [data-tree-toggle]').click();
  // Cache-backed type searching and quick-open icons require no extra SCAN.
  const scans = count('list_redis_keys'); await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', { name: '搜索对象', exact: true }).fill('type:stream');
  assert.equal(await page.locator('.object-quick-open-option').count(), 1);
  assert.equal(await page.locator('.object-quick-open-option .redis-key-icon--stream').count(), 1);
  assert.equal(count('list_redis_keys'), scans); await page.keyboard.press('Escape');
  await key('hash:actually_string').getByRole('button', { name: 'hash:actually_string', exact: true }).dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  assert.equal(await page.locator('.query-tab').count(), 1, 'double-clicking a Redis key must reuse its tab');
  assert.ok(await page.locator('#structureTab').isHidden()); assert.ok(await page.locator('#messageTab').isVisible());
  assert.equal(await page.locator('.query-tab.active .redis-key-icon--string').count(), 1);
  assert.match(await page.locator('#resultMeta').innerText(), /String.*TTL 120 秒/);
  for (const theme of ['dark', 'light', 'ocean', 'forest', 'contrast']) {
    await page.locator('#themeButton').click(); await page.locator(`[data-theme-option="${theme}"]`).click();
    await page.setViewportSize({ width: 1060, height: 900 });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const ratios = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const luminance = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return ['string', 'hash', 'list', 'set', 'zset', 'stream'].map(type => {
        const style = getComputedStyle(document.querySelector(`#objectTree .redis-key-icon--${type}`));
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return { type, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    assert.ok(ratios.every(item => item.ratio >= 4.5), `${theme} type badge contrast: ${JSON.stringify(ratios)}`);
    await page.screenshot({ path: resolve(evidence, `${theme}.png`) });
  }
  // The value read is authoritative if a key changed type after SCAN.
  loadedType = 'hash'; await page.locator('#refreshTableData').click();
  await until(() => key('hash:actually_string').getAttribute('data-redis-type').then(type => type === 'hash'));
  assert.equal(await page.locator('.query-tab.active .redis-key-icon--hash').count(), 1);
  await db(0).locator('[data-load-more-redis-db="0"]').click(); await key('extra').waitFor();
  assert.equal(await key('same', 0).count(), 1); assert.equal(await key('same', 0).getAttribute('data-redis-type'), 'hash');
  // Type permission loss must clear stale type metadata on refresh.
  noTypes = true; await db(0).locator(':scope > summary').click({ button: 'right' });
  await page.locator('[data-redis-database-context-action="refresh"]').click();
  await until(() => key('users:1001').getAttribute('data-redis-type').then(type => type === 'unknown'));
  assert.ok(await key('users:1001').isVisible());
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="public.orders"] .object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor(); assert.ok(await page.locator('#structureTab').isVisible());
  assert.deepEqual(errors, []);
  console.log('PASS: six type icons and unknown/missing/module fallback; authoritative types rather than key prefixes; no value-fetch fanout; DB scoping, quick-open type filter, tab icons, Redis-only structure removal, TTL context, type changes, pagination dedupe, ACL fallback and five themes.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
