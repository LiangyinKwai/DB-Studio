import { chooseAppSelect } from './app-select-driver.mjs';
// Opt-in: uses the native Rust adapters against DB 15, keeps its namespaced
// test data, and never reads unrelated values. Build redis_ux_bridge first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';
if (!process.env.DB_STUDIO_REDIS_TEST_HOST) throw new Error('Explicit DB_STUDIO_REDIS_TEST_HOST required');
const prefix = `dbstudio:ux:${Date.now()}:`, dist = resolve('dist'), evidence = resolve('output/playwright/redis-types'); mkdirSync(evidence, { recursive: true });
const bridge = spawn(resolve('src-tauri/target/debug/examples/redis_ux_bridge'), [], { env: { ...process.env, DB_STUDIO_REDIS_TEST_PREFIX: prefix }, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = []; let bridgeError;
bridge.on('exit', code => { bridgeError = new Error(`Redis bridge exited ${code}`); for (const item of pending.splice(0)) item.reject(bridgeError); });
createInterface({ input: bridge.stdout }).on('line', line => { const item = pending.shift(); if (!item) return; const result = JSON.parse(line); result.error ? item.reject(new Error(result.error)) : item.resolve(result.ok); });
const native = (command, args) => new Promise((resolve, reject) => { if (bridgeError) return reject(bridgeError); pending.push({ resolve, reject }); bridge.stdin.write(JSON.stringify({ command, args }) + '\n'); });
const copies = [];
const fixture = createWorkspaceFixture();
const profile = fixture.profiles.find(profile => profile.driver === 'redis'); Object.assign(profile, { name: 'Redis DB 15 验证', database: '15', redisDb: 15 });
const calls = [];
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === 'write_clipboard_text') { copies.push(args.text); return true; }
  if (command === 'list_redis_databases') return [{ index: 15, keyCount: 0 }];
  if (['list_redis_keys', 'get_redis_value', 'create_redis_key', 'operate_redis_key', 'save_redis_cell', 'rename_redis_key', 'copy_redis_key', 'delete_redis_key'].includes(command)) return native(command, args);
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = []; page.on('pageerror', error => errors.push(error.message));
const types = ['string', 'hash', 'list', 'set', 'zset', 'stream'];
const rowFor = type => page.locator(`[data-redis-key="${prefix + type}"]`);
const get = type => native('get_redis_value', { database: 15, key: prefix + type });
const operation = async (type, action, values = {}) => {
  await page.locator(action === 'ttl' ? '#redisTtlAction' : '#redisMemberAction').click();
  const dialog = page.locator('.redis-operation-dialog'); await dialog.waitFor({ state: 'visible' });
  if (await dialog.locator('[name=action]').inputValue() !== action) await chooseAppSelect(dialog.locator('[name=action]'), action);
  if (['remove', 'score'].includes(action) && await dialog.locator('[data-picker]').isVisible()) await chooseAppSelect(dialog.locator('[data-entry-picker]'), '');
  for (const [field, value] of Object.entries(values)) await dialog.locator(`[name=${field}]`).fill(String(value));
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
  const box = await dialog.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= page.viewportSize().height);
  if (action === 'add' || action === 'ttl') await page.screenshot({ path: resolve(evidence, `${type}-${action}-dialog.png`) });
  await dialog.locator('[type=submit]').click(); await dialog.waitFor({ state: 'hidden' });
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id=redis-local]').click();
  const db = page.locator('[data-redis-db="15"] > summary');
  await db.locator('[data-tree-toggle]').click();
  for (const type of types) {
    await db.click({ button: 'right' }); await page.locator('[data-redis-database-context-action=create]').click();
    await page.locator('#redisCreateKey').fill(prefix + type);
    await page.locator('#redisCreateTypeTrigger').click(); await page.locator(`[data-redis-type=${type}]`).click();
    if (['hash', 'stream'].includes(type)) await page.locator('#redisCreateField').fill('name');
    await page.locator('#redisCreateValue').fill(type === 'string' ? '{"name":"初始值","id":9007199254740993}' : '初始值');
    await page.locator('#applyRedisCreate').click(); await page.locator('#redisCreateModal').waitFor({ state: 'hidden' });
    const row = rowFor(type); await row.waitFor(); await row.locator('.object-main').click();
    await page.waitForFunction(type => document.querySelector('#tableToolbarMeta').textContent.toLowerCase().includes(type), type === 'zset' ? 'zset' : type);
    assert.equal((await get(type)).keyType, type);
    assert.equal(await page.locator('#structureTab').isVisible(), false);
    if (type === 'set') assert.deepEqual((await get(type)).columns, ['member']);
    if (type === 'stream') { assert.deepEqual((await get(type)).columns, ['id', 'fields']); assert.equal((await get(type)).rows.length, 1); }
    if (type === 'string' || type === 'hash') {
      const valueCell = page.locator('#resultGrid [data-grid-cell]').last();
      await valueCell.dblclick();
      const input = page.locator('#resultGrid .db-grid-edit-input'); await input.fill(type === 'string' ? '已编辑 🙂 长文本\n第二行' : '已编辑字段'); await input.press('Enter');
      await page.locator('#confirmActionAccept').click(); await page.locator('#confirmActionModal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.querySelector('#resultGrid .db-grid-edit-input'));
      assert.match(JSON.stringify((await get(type)).rows), /已编辑/);
    } else {
      await operation(type, 'add', { ...(type === 'stream' ? { field: 'event' } : {}), value: '新增成员', ...(type === 'zset' ? { score: '12.5' } : {}) });
      assert.equal((await get(type)).rows.length, 2);
    }
    if (type === 'hash') { await operation(type, 'add', { field: 'extra', value: '新增字段' }); assert.equal((await get(type)).rows.length, 2); }
    if (type === 'list') { await operation(type, 'prepend', { value: '头部' }); assert.equal((await get(type)).rows[0][1], '头部'); }
    if (type === 'zset') { await operation(type, 'score', { value: '新增成员', score: '-2.25' }); assert.equal((await get(type)).rows[0][1], '-2.25'); }
    if (type === 'list' || type === 'zset') {
      const cell = page.locator('#resultGrid [data-grid-cell]').nth(1); await cell.dblclick();
      const input = page.locator('#resultGrid .db-grid-edit-input');
      await input.fill(type === 'list' ? '列表直接编辑' : '1.25e3'); await input.press('Enter');
      await page.locator('#confirmActionAccept').click(); await page.locator('#confirmActionModal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.querySelector('#resultGrid .db-grid-edit-input'));
      const entry = await get(type);
      assert.equal(entry.rows[type === 'list' ? 0 : 1][1], type === 'list' ? '列表直接编辑' : '1250');
    }
    await operation(type, 'ttl', { ttl: 600 }); const ttl = (await get(type)).ttl; assert.ok(ttl > 590 && ttl <= 600);
    await operation(type, 'ttl', { ttl: 0 }); assert.equal((await get(type)).ttl, -1);
    if (['hash', 'set', 'zset', 'stream'].includes(type)) {
      const entry = await get(type);
      await operation(type, 'remove', type === 'hash' ? { field: 'extra' } : { value: type === 'stream' ? entry.rows.at(-1)[0] : '新增成员' });
      assert.equal((await get(type)).rows.length, 1);
    }
    await page.screenshot({ path: resolve(evidence, `${type}.png`) });
  }
  const stringRow = rowFor('string'); await stringRow.locator('.object-main').focus(); await page.keyboard.press('F2');
  await page.locator('#redisRenameModal').waitFor({ state: 'visible' }); assert.equal(await page.locator('#redisRenameInput').inputValue(), prefix + 'string');
  await page.screenshot({ path: resolve(evidence, 'rename-dialog.png') }); await page.keyboard.press('Escape');
  await stringRow.click({ button: 'right' }); await page.locator('[data-redis-context-action=copy-value]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制值'); assert.equal(copies.at(-1), (await get('string')).raw);
  await stringRow.locator('.object-main').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制 Redis key'); assert.equal(copies.at(-1), prefix + 'string');
  // Context menus expose direct actions and copy whole values with the native clipboard.
  const streamRow = rowFor('stream'); await streamRow.click({ button: 'right' });
  await page.locator('[data-redis-context-action=ttl]').click();
  await page.locator('.redis-operation-dialog').waitFor({ state: 'visible' });
  await page.locator('[data-ttl-preset="600"]').click();
  assert.equal(await page.locator('.redis-operation-dialog [name=ttl]').inputValue(), '600');
  await page.keyboard.press('Escape');
  await streamRow.click({ button: 'right' }); await page.keyboard.press('End');
  assert.equal(await page.locator('[data-redis-context-action=delete]').evaluate(node => node === document.activeElement), true);
  await page.screenshot({ path: resolve(evidence, 'key-menu.png') }); await page.keyboard.press('Escape');
  for (const type of types) {
    const row = rowFor(type); await row.click({ button: 'right' }); await page.locator('[data-redis-context-action=duplicate]').click();
    if (type === 'string') {
      await page.locator('#redisRenameInput').fill(prefix + 'hash'); await page.locator('#applyRedisRename').click();
      await page.waitForFunction(() => document.querySelector('#redisRenameFeedback').textContent.includes('已存在'));
      assert.ok(await page.locator('#redisRenameModal').isVisible());
    }
    await page.locator('#redisRenameInput').fill(prefix + type + ':copy');
    if (type === 'string') await page.screenshot({ path: resolve(evidence, 'duplicate-dialog.png') });
    await page.locator('#applyRedisRename').click(); await page.locator('#redisRenameModal').waitFor({ state: 'hidden' });
    const copy = await native('get_redis_value', { database: 15, key: prefix + type + ':copy' });
    assert.equal(copy.keyType, type); assert.deepEqual(copy.raw, (await get(type)).raw);
  }
  await rowFor('stream').filter({ has: page.locator('.object-main', { hasText: prefix + 'stream' }) }).first().locator('.object-main').click();
  // Short names should fit the content; search remains inside the compact popup.
  await page.locator('#tableToolbarTitle').click(); const details = page.locator('.redis-key-details');
  await details.waitFor({ state: 'visible' }); assert.ok((await details.boundingBox()).height < 300);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f'); await details.locator('input[name=search]').fill('ux');
  assert.ok(await details.evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: resolve(evidence, 'key-compact.png') });
  await page.keyboard.press('Escape'); assert.ok(await details.isVisible()); await page.mouse.click(5, 5); await details.waitFor({ state: 'hidden' });
  await page.locator('#modeBadge').click(); assert.ok(await page.locator('#redisMemberAction').isDisabled()); assert.ok(await page.locator('#redisTtlAction').isDisabled()); await page.locator('#modeBadge').click();
  await page.locator('#resultGrid [data-grid-cell]').first().click(); await page.locator('#redisMemberAction').click();
  const operationDialog = page.locator('.redis-operation-dialog'); await chooseAppSelect(operationDialog.locator('[name=action]'), 'remove');
  assert.equal(await operationDialog.locator('[name=value]').inputValue(), (await get('stream')).rows[0][0]);
  await page.setViewportSize({ width: 1060, height: 740 });
  assert.ok(await operationDialog.evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: resolve(evidence, 'stream-operation.png') });
  await page.keyboard.press('Escape'); await operationDialog.waitFor({ state: 'hidden' });
  await page.locator('#redisTtlAction').click(); await page.keyboard.press('Escape');
  // Editing retains TTL and detects shifted list values, without overwriting.
  for (const type of ['string', 'hash', 'list', 'zset']) {
    await native('operate_redis_key', { request: { database: 15, key: prefix + type, keyType: type, action: 'ttl', ttl: 600, readOnly: false } });
    const entry = await get(type), row = entry.rows[0];
    const field = type === 'string' ? null : String(row[0]);
    const value = type === 'zset' ? '2.5e3' : '保留 TTL 的编辑';
    await native('save_redis_cell', { request: { database: 15, key: prefix + type, keyType: type, field, expectedValue: String(row.at(-1)), value, readOnly: false } });
    assert.ok((await get(type)).ttl > 590);
    if (type === 'zset') await native('save_redis_cell', { request: { database: 15, key: prefix + type, keyType: type, field, expectedValue: '2.5e3', value: '3.5e3', readOnly: false } });
    if (type === 'list') {
      await native('operate_redis_key', { request: { database: 15, key: prefix + type, keyType: type, action: 'prepend', value: '并发插入', readOnly: false } });
      await assert.rejects(native('save_redis_cell', { request: { database: 15, key: prefix + type, keyType: type, field: '0', expectedValue: value, value: '不应覆盖', readOnly: false } }), /其他操作修改/);
    }
    await native('operate_redis_key', { request: { database: 15, key: prefix + type, keyType: type, action: 'ttl', ttl: 0, readOnly: false } });
  }
  const source = prefix + 'string';
  await native('operate_redis_key', { request: { database: 15, key: source, keyType: 'string', action: 'ttl', ttl: 600, readOnly: false } });
  const copyRequest = { database: 15, key: source, newKey: source + ':expiring-copy', preserveTtl: true, readOnly: false };
  await native('copy_redis_key', { request: copyRequest });
  assert.ok((await native('get_redis_value', { database: 15, key: copyRequest.newKey })).ttl > 590);
  await assert.rejects(native('copy_redis_key', { request: copyRequest }), /已存在/);
  await assert.rejects(native('copy_redis_key', { request: { ...copyRequest, newKey: source + ':readonly-copy', readOnly: true } }), /只读/);
  await native('copy_redis_key', { request: { ...copyRequest, newKey: source + ':permanent-copy', preserveTtl: false } });
  assert.equal((await native('get_redis_value', { database: 15, key: source + ':permanent-copy' })).ttl, -1);
  await native('operate_redis_key', { request: { database: 15, key: source, keyType: 'string', action: 'ttl', ttl: 0, readOnly: false } });
  // Native validation and conflict behavior, never touching unrelated data.
  await assert.rejects(native('operate_redis_key', { request: { database: 15, key: prefix + 'hash', keyType: 'hash', action: 'add', field: 'name', value: '覆盖', readOnly: false } }), /字段已存在/);
  await assert.rejects(native('operate_redis_key', { request: { database: 15, key: prefix + 'hash', keyType: 'set', action: 'add', value: '错误类型', readOnly: false } }), /类型改变/);
  await assert.rejects(native('operate_redis_key', { request: { database: 15, key: prefix + 'set', keyType: 'set', action: 'add', value: '只读' } }), /只读/);
  await assert.rejects(native('save_redis_cell', { request: { database: 15, key: prefix + 'string', keyType: 'string', expectedValue: '旧值', value: '不应覆盖', readOnly: false } }), /其他操作修改/);
  const renameKey = prefix + 'rename-test';
  await native('create_redis_key', { request: { database: 15, key: renameKey, keyType: 'string', value: 'rename', readOnly: false } });
  assert.equal(await native('rename_redis_key', { request: { database: 15, key: renameKey, newKey: prefix + 'renamed', readOnly: false } }), true);
  assert.equal(await native('rename_redis_key', { request: { database: 15, key: prefix + 'renamed', newKey: prefix + 'string', readOnly: false } }), false);
  await native('create_redis_key', { request: { database: 15, key: prefix + 'delete-test', keyType: 'string', value: 'delete only test key', readOnly: false } });
  assert.equal(await native('delete_redis_key', { database: 15, key: prefix + 'delete-test', readOnly: false }), 1);
  assert.equal((await native('get_redis_value', { database: 15, key: prefix + 'delete-test' })).rows.length, 0);
  await page.setViewportSize({ width: 1060, height: 680 });
  for (const theme of ['dark', 'light', 'ocean', 'forest', 'contrast']) {
    await page.locator('#themeButton').click(); await page.locator(`[data-theme-option=${theme}]`).click();
    await page.locator('#redisTtlAction').click(); const ttlDialog = page.locator('.redis-operation-dialog');
    const bounds = await ttlDialog.boundingBox(); assert.ok(bounds.height < 460 && bounds.y >= 0 && bounds.y + bounds.height <= 680);
    assert.ok(await ttlDialog.locator('.redis-action-switch').isHidden());
    await page.screenshot({ path: resolve(evidence, `ttl-${theme}-compact.png`) }); await page.keyboard.press('Escape');
    await rowFor('stream').click({ button: 'right' }); const menu = page.locator('#redisContextMenu');
    const menuBox = await menu.boundingBox(); assert.ok(menuBox.y + menuBox.height <= 680 && menuBox.x + menuBox.width <= 1060);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: six real Redis types created/viewed; string/hash edit; collection add/remove; list prepend; zset score; stream IDs; TTL/persist; compact details/search/backdrop; conflict/readonly/rename/delete. Data retained in DB 15: ${prefix}*`);
} finally { await browser.close(); bridge.stdin.end(); await new Promise(done => server.close(done)); }
