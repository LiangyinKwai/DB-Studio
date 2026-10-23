import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

// UI/IPC contract with disposable fixture data; no user database is contacted.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist'), evidence = resolve(root, 'output/playwright/table-save');
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const rows = [['9007199254740993', 'draft', 'note A'], ['2', 'ready', 'note B'], ['3', 'done', null]];
const writes = [];
let failAt = 0, hold = false, release;
const invoke = async (command, args) => {
  if (command === 'get_object_details' && args.objectId === 'public.orders') return {
    kind: 'table', qualifiedName: 'public.orders', definition: 'CREATE TABLE public.orders (id bigint primary key, status text, note text)',
    columns: [{ name: 'id', dataType: 'bigint', primaryKey: true, nullable: false, identity: true, identityGeneration: 'byDefault' }, { name: 'status', dataType: 'text', nullable: true }, { name: 'note', dataType: 'text', nullable: true }], indexes: [], constraints: [],
  };
  if (command === 'execute_query' && args.request.sql.includes('"public"."orders"')) return { columns: ['id', 'status', 'note'], rows: rows.map(row => [...row]), row_count: rows.length };
  if (command === 'execute_mutation' && args.request.sql.startsWith('UPDATE')) {
    writes.push(args.request);
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    if (writes.length === failAt) throw new Error('fixture write conflict');
    if (args.request.sql.includes('"public"."orders"')) {
      const sql = args.request.sql;
      const id = sql.match(/"id" IS NOT DISTINCT FROM E'([^']+)'/)[1];
      const row = rows.find(row => row[0] === id);
      const assignment = sql.match(/SET "(id|status|note)" = (NULL|E'((?:[^']|'')*)')/);
      const value = assignment[2] === 'NULL' ? null : assignment[3].replaceAll("''", "'");
      if (assignment[1] === 'id' && rows.some(other => other !== row && other[0] === value)) throw new Error('fixture duplicate primary key');
      if (!row) return { row_count: 0 };
      row[{ id: 0, status: 1, note: 2 }[assignment[1]]] = value;
    }
    return { row_count: 1 };
  }
  return fixture.invoke(command, args);
};
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
});
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const until = async predicate => { for (let i = 0; i < 160; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('condition timeout'); };
const edit = async (position, column, value) => {
  await page.locator(`#resultGrid [data-position="${position}"][data-column-index="${column}"]`).dblclick();
  await page.locator('.db-grid-edit-input').fill(value);
};
const saved = async count => { await until(() => writes.length === count); await until(() => page.locator('#saveTableChanges').isDisabled()); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  await page.locator('[data-object-id="public.orders"] .object-main').dblclick();
  await page.locator('#resultGrid [data-grid-cell]').first().waitFor();
  const originalTab = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  assert.ok(await page.locator('#saveTableChanges').isDisabled());
  assert.ok(await page.locator('#discardTableChanges').isDisabled());
  await edit(0, 1, 'paid'); await edit(0, 2, 'updated note'); await edit(1, 1, 'processing');
  await page.locator('#resultFilter').fill('draft');
  await page.locator('#saveTableChanges').click();
  await saved(3);
  assert.ok(await page.locator('#confirmActionModal').isHidden());
  assert.deepEqual(rows.slice(0, 2), [['9007199254740993', 'paid', 'updated note'], ['2', 'processing', 'note B']]);
  await page.locator('#resultFilter').fill('');
  await edit(0, 1, 'cancel A'); await edit(1, 2, 'cancel B');
  await page.locator('#discardTableChanges').click();
  assert.ok(await page.locator('#saveTableChanges').isDisabled());
  assert.ok(await page.locator('#discardTableChanges').isDisabled());
  assert.equal(writes.length, 3);
  assert.equal(await page.locator('[data-position="0"][data-column-index="1"]').innerText(), 'paid');
  await edit(0, 1, 'meta shortcut');
  await page.keyboard.press('Meta+s'); await saved(4);
  await edit(1, 1, 'control shortcut');
  await page.keyboard.press('Control+s'); await saved(5);
  await edit(0, 1, 'single only'); await edit(1, 1, 'keep draft');
  await page.locator('.db-grid-edit-input').press('Enter');
  await page.locator('#confirmActionAccept').click();
  await until(() => writes.length === 6);
  assert.ok(await page.locator('#saveTableChanges').isEnabled());
  assert.equal(rows[0][1], 'meta shortcut');
  assert.equal(rows[1][1], 'keep draft');
  await page.locator('#discardTableChanges').click();
  await edit(0, 1, 'partial success'); await edit(0, 2, 'retry note'); await edit(1, 1, 'not executed');
  failAt = writes.length + 2;
  await page.keyboard.press('Meta+s');
  await until(() => page.locator('#toast').innerText().then(text => text.includes('已保存 1 格')));
  assert.equal(writes.length, 8);
  assert.equal(rows[0][1], 'partial success');
  assert.equal(rows[0][2], 'updated note');
  assert.match(await page.locator('.db-grid-footer-status').innerText(), /未保存 2 格/);
  assert.ok(await page.locator('#saveTableChanges').isEnabled());
  failAt = 0;
  await page.locator('#saveTableChanges').click(); await saved(10);
  assert.equal(rows[0][2], 'retry note'); assert.equal(rows[1][1], 'not executed');
  await edit(0, 1, 'held save'); hold = true;
  await page.keyboard.press('Meta+s'); await until(() => Boolean(release));
  assert.ok(await page.locator('#discardTableChanges').isDisabled());
  await page.keyboard.press('Control+s');
  assert.equal(writes.length, 11);
  release(); await saved(11);
  await edit(0, 1, 'keep original table');
  await page.locator('[data-object-id="public.exact_100"] .object-main').dblclick();
  await page.waitForFunction(() => document.querySelector('#tableToolbarTitle').textContent.includes('exact_100'));
  assert.ok(await page.locator('#saveTableChanges').isDisabled());
  await edit(0, 1, 'save other table');
  await page.keyboard.press('Meta+s'); await saved(12);
  assert.ok(writes.at(-1).sql.includes('"public"."exact_100"'));
  assert.equal(rows[0][1], 'held save');
  await page.locator(`.query-tab[data-tab-id="${originalTab}"] .tab-select`).click();
  assert.ok(await page.locator('#saveTableChanges').isEnabled());
  await page.locator('#modeBadge').click();
  assert.ok(await page.locator('#saveTableChanges').isDisabled());
  assert.ok(await page.locator('#discardTableChanges').isEnabled());
  await page.locator('#discardTableChanges').click();
  await page.locator('#modeBadge').click();
  const beforePrimary = writes.length, oldKey = rows[0][0], newKey = '9007199254740997';
  await edit(0, 0, newKey); await edit(0, 2, 'after primary key');
  await page.keyboard.press('Control+s'); await saved(beforePrimary + 2);
  assert.match(writes[beforePrimary].sql, new RegExp(`SET "id" = E'${newKey}'.*WHERE "id" IS NOT DISTINCT FROM E'${oldKey}'`));
  assert.match(writes[beforePrimary + 1].sql, new RegExp(`WHERE "id" IS NOT DISTINCT FROM E'${newKey}'`));
  assert.equal(rows[0][0], newKey); assert.equal(rows[0][2], 'after primary key');
  await edit(0, 1, 'continue after key change'); await page.keyboard.press('Meta+s'); await saved(beforePrimary + 3);
  assert.match(writes.at(-1).sql, new RegExp(`WHERE "id" IS NOT DISTINCT FROM E'${newKey}'`));
  await edit(0, 0, rows[1][0]); await page.keyboard.press('Meta+s');
  await until(() => page.locator('#toast').innerText().then(text => text.includes('duplicate primary key')));
  assert.ok(await page.locator('#saveTableChanges').isEnabled()); assert.equal(rows[0][0], newKey);
  await page.locator('#discardTableChanges').click();
  // The detailed cell editor and row editor expose the key value as well.
  await page.locator('#resultGrid [data-position="0"][data-column-index="0"]').click({ button: 'right' });
  await page.locator('.db-grid-cell-menu').getByRole('menuitem', { name: '查看详情', exact: true }).click();
  assert.ok(await page.locator('#cellValue').isEditable()); assert.ok(await page.locator('#saveCell').isVisible());
  await page.locator('#closeCell').click();
  await page.locator('[data-select-row="0"]').check(); await page.locator('#editRow').click();
  assert.ok(await page.locator('[data-mutation-column="id"]').isEditable());
  await page.locator('#closeMutation').click(); await page.locator('[data-select-row="0"]').uncheck();
  for (const width of [1440, 1060]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 680 });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.ok(await page.locator('.result-heading').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: resolve(evidence, `table-save-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: primary key values editable inline/in details/row form; original-to-new key predicates and sibling draft rebasing, duplicate-key draft retention; save/cancel, hidden drafts, shortcuts, single-cell save, partial failure, duplicate lock, table isolation, readonly and narrow layout.');
} finally {
  await browser.close(); await new Promise(done => server.close(done));
}
