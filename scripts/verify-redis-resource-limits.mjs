import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/redis-resource-limits');
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ ...fixture.profiles.find(profile => profile.id === 'redis-local'), id: 'redis-second', name: '第二个 Redis' });
const keys = ['ttl-positive', 'ttl-permanent', 'ttl-missing', 'ttl-error', 'ttl-slow', 'truncated-key'];
const writes = [], exports = [], commandSessions = [], held = [];
let nextCommandPending = false, resolveCommand, ttlFails = true, holdTtl = false, resolveTtl;
const record = (command, args) => fixture.calls.push({ command, args, at: Date.now() });
const payload = (value, truncated = false) => ({ columns: ['result'], rows: [[value]], raw: value, rowCount: 1, elapsedMs: 0.2, truncated, truncatedReason: truncated ? 'result_size' : null });
const invoke = async (command, args) => {
  if (command === 'write_clipboard_text') { record(command, args); writes.push(args.text); return; }
  if (command === 'save_text_file') { record(command, args); exports.push(args); return true; }
  if (command === 'list_redis_databases') { record(command, args); return [0, 3, 7].map(index => ({ index, keyCount: keys.length, current: index === 0 })); }
  if (command === 'list_redis_keys') { record(command, args); return { cursor: 0, keys, keyTypes: Object.fromEntries(keys.map(key => [key, 'string'])) }; }
  if (command === 'get_redis_value') {
    record(command, args);
    assert.equal(args.key, 'truncated-key', 'TTL-only inspection must never request values');
    return { key: args.key, keyType: 'string', ttl: 42, columns: ['value'], rows: [['PREVIEW ONLY']], raw: 'PREVIEW ONLY', partial: true, truncated: true, truncatedReason: 'result_size' };
  }
  if (command === 'get_redis_ttl') {
    record(command, args);
    if (args.key === 'ttl-slow' && holdTtl) {
      holdTtl = false;
      return new Promise(done => { resolveTtl = done; held.push(() => done(99999)); });
    }
    if (args.key === 'ttl-error' && ttlFails) throw new Error('NOPERM fixture TTL unavailable');
    return args.key === 'ttl-permanent' ? -1 : args.key === 'ttl-missing' ? -2 : args.connectionId === 'redis-second' ? 700 : 120;
  }
  if (command === 'execute_redis_command') {
    record(command, args); commandSessions.push(args.request.consoleId);
    if (nextCommandPending) {
      nextCommandPending = false;
      return new Promise(done => { resolveCommand = done; held.push(() => done(payload('OLD STALE RESULT'))); });
    }
    return payload(args.request.sql === 'TRUNCATED' ? 'SERVER PREVIEW' : args.request.sql.startsWith('BIG ') ? 'X'.repeat(1024 * 1024) : 'PONG', args.request.sql === 'TRUNCATED');
  }
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const until = async (predicate, label) => {
  for (let index = 0; index < 200; index++) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error(`timeout: ${label}`);
};
const calls = command => fixture.callsFor(command);
const released = id => calls('release_redis_console').filter(call => call.args.consoleId === id);
const connect = async id => {
  await page.locator(`[data-connection-id="${id}"]`).click();
  await until(async () => await page.locator(`[data-connection-toggle="${id}"]`).getAttribute('data-status') === 'connected', `connected ${id}`);
};
const expand = async database => {
  const branch = page.locator(`.redis-database[data-redis-db="${database}"]`);
  await branch.waitFor();
  if (await branch.getAttribute('open') === null) await branch.locator(':scope > summary [data-tree-toggle]').click();
  await branch.locator('[data-redis-key]').first().waitFor();
};
const openConsole = async (database = 3) => {
  await page.locator(`.redis-database[data-redis-db="${database}"] > summary`).click({ button: 'right' });
  await page.locator('[data-redis-database-context-action="console"]').click();
  await page.locator('#redisConsolePanel').waitFor();
};
const run = async (sql, pending = false) => {
  const before = calls('execute_redis_command').length;
  await page.locator('#redisCommandEditor .cm-content').fill(sql);
  await page.locator('#redisConsoleRun').click();
  await until(() => calls('execute_redis_command').length === before + 1, `dispatch ${sql}`);
  if (!pending) await page.waitForFunction(() => !document.getElementById('redisConsoleRun').disabled);
  return calls('execute_redis_command').at(-1).args.request.consoleId;
};
const row = (key, database = 3) => page.locator(`.redis-database[data-redis-db="${database}"] [data-redis-key="${key}"]`);
const details = page.locator('.redis-key-details');
const inspect = async (key, database = 3) => {
  await row(key, database).locator('[data-redis-key-info]').click();
  await details.waitFor();
};
const ttlText = () => details.locator('[data-key-ttl]').innerText();
const closeDetails = () => details.getByRole('button', { name: '关闭 Key 详情', exact: true }).click();

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await connect('conn-dev'); await page.locator('#addQueryTab').click();
  const sqlTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await connect('redis-local'); await expand(3); await openConsole();
  await run('TRUNCATED');
  const first = page.locator('.redis-console-entry').first();
  assert.match(await first.innerText(), /完成 · 部分输出/);
  assert.match(await first.locator('.redis-console-notice').innerText(), /仅显示部分输出/);
  await first.getByRole('button', { name: '复制预览', exact: true }).click();
  await until(() => writes.length === 1, 'preview copied');
  assert.match(writes[0], /^\[仅显示部分输出/);
  assert.match(writes[0], /SERVER PREVIEW/);
  checks.push('backend truncation has a visible notice and warning in copied preview');

  for (let index = 0; index < 6; index++) await run(`BIG ${index}`);
  assert.equal(await first.locator('[data-redis-copy]').isDisabled(), true);
  assert.match(await first.locator('.redis-console-notice').innerText(), /旧输出缓存已释放/);
  const outputBytes = await page.locator('.redis-console-result').evaluateAll(nodes => nodes.reduce((size, node) => size + node.textContent.length * 2, 0));
  assert.ok(outputBytes <= 4 * 1024 * 1024, `retained output is ${outputBytes} bytes`);
  checks.push('repeated 1 MiB outputs stay within 4 MiB and disable copy after eviction');

  nextCommandPending = true;
  const closingId = await run('SELECT 7', true);
  assert.equal(await page.locator('#closeRedisConsole').isEnabled(), true);
  await page.locator('#closeRedisConsole').click();
  await until(() => released(closingId).length === 1, 'immediate pending release');
  await openConsole(); const freshId = await run('PING'); assert.notEqual(freshId, closingId);
  resolveCommand(payload('OLD STALE RESULT'));
  await until(() => released(closingId).length >= 2, 'late invoke final release');
  assert.equal(await page.locator('.redis-console-entry').count(), 1);
  assert.doesNotMatch(await page.locator('#redisConsoleOutput').innerText(), /OLD STALE/);
  assert.match(await page.locator('#redisConsoleContext').innerText(), /DB 3/);
  checks.push('pending close releases immediately, finalizes again, and late SELECT cannot alter the new console');

  await openConsole(); await until(() => released(freshId).length === 1, 'replacement release');
  const replacedId = await run('PING');
  await connect('redis-second'); await until(() => released(replacedId).length === 1, 'connection-switch release');
  await openConsole(); const secondId = await run('PING');
  await page.locator(`.tab-select[data-tab-id="${sqlTabId}"]`).click();
  await until(() => released(secondId).length === 1, 'SQL tab release');
  assert.equal(new Set([closingId, freshId, replacedId, secondId]).size, 4);
  checks.push('replacement, connection switch and SQL-tab activation release unique console sessions');

  await connect('redis-local'); await expand(3);
  const valueReads = calls('get_redis_value').length;
  for (const [key, expected] of [['ttl-positive', 'TTL 120 秒（读取时）'], ['ttl-permanent', '无过期时间'], ['ttl-missing', 'Key 已不存在']]) {
    await inspect(key); await until(async () => await ttlText() === expected, `TTL ${key}`);
    assert.deepEqual(calls('get_redis_ttl').at(-1).args, { connectionId: 'redis-local', database: 3, key });
    await closeDetails();
  }
  await inspect('ttl-error'); await until(async () => await ttlText() === 'TTL 读取失败', 'TTL error');
  assert.match(await details.locator('[data-key-ttl]').getAttribute('title'), /NOPERM/);
  ttlFails = false; await details.locator('[data-key-ttl-retry]').click();
  await until(async () => await ttlText() === 'TTL 120 秒（读取时）', 'TTL retry'); await closeDetails();
  holdTtl = true; await inspect('ttl-slow'); await until(() => Boolean(resolveTtl), 'pending TTL');
  await closeDetails(); await inspect('ttl-positive');
  await until(async () => await ttlText() === 'TTL 120 秒（读取时）', 'next key TTL');
  resolveTtl(99999); await page.waitForTimeout(100);
  assert.equal(await ttlText(), 'TTL 120 秒（读取时）');
  await closeDetails();
  resolveTtl = null; holdTtl = true; await inspect('ttl-slow'); await until(() => Boolean(resolveTtl), 'second pending TTL');
  await closeDetails(); resolveTtl(-1); await page.waitForTimeout(100);
  assert.equal(await details.isVisible(), false);
  assert.equal(calls('get_redis_value').length, valueReads, 'TTL inspection must not fetch the value');
  await connect('redis-second'); await expand(7); await inspect('ttl-positive', 7);
  await until(async () => await ttlText() === 'TTL 700 秒（读取时）', 'second connection TTL');
  assert.deepEqual(calls('get_redis_ttl').at(-1).args, { connectionId: 'redis-second', database: 7, key: 'ttl-positive' });
  assert.match(await details.locator('.key-context').innerText(), /第二个 Redis.*DB 7/s);
  await page.screenshot({ path: resolve(evidence, 'ttl-connection-db.png'), fullPage: true });
  await closeDetails();
  checks.push('TTL-only reads cover positive, persistent, missing, error/retry, late results and exact connection/DB binding');

  await connect('redis-local'); await expand(3); await row('truncated-key').locator('.object-main').click();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  assert.match(await page.locator('#resultMeta').innerText(), /当前值已截断/);
  const cell = page.locator('#resultGrid [data-grid-cell]').first();
  await cell.dblclick();
  assert.equal(await page.locator('.db-grid-edit-input').count(), 0);
  if (await page.locator('#cellModal').isVisible()) {
    assert.equal(await page.locator('#saveCell').isVisible(), false);
    assert.match(await page.locator('#cellMeta').innerText(), /截断预览/);
    await page.locator('#closeCell').click();
  }
  const copiesBefore = writes.length;
  await row('truncated-key').click({ button: 'right' });
  await page.locator('[data-redis-context-action="copy-value"]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('仅加载了部分内容'));
  assert.equal(writes.length, copiesBefore, 'full-value copy must not export a partial value');
  await page.locator('#resultMore').click(); await page.locator('[data-export-format="csv"]').click();
  await until(() => exports.length > 0, 'preview export');
  assert.match(exports.at(-1).fileName, /-preview\.csv$/);
  assert.match(exports.at(-1).contents, /PREVIEW ONLY/);
  await page.screenshot({ path: resolve(evidence, 'truncated-key-preview.png'), fullPage: true });
  checks.push('size-truncated key disables editing/full copy and marks exported filenames as previews');
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ passed: true, checks, retainedOutputBytes: outputBytes, screenshots: 2 }, null, 2));
  console.log(`PASS: ${checks.length} Redis resource/lifecycle/TTL browser groups; retained output ${outputBytes} bytes.`);
} finally {
  held.forEach(resolve => resolve());
  await context.close(); await browser.close(); await new Promise(done => server.close(done));
}
