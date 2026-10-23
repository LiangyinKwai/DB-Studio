import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/grid-structure'); mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: 'mysql-local', name: 'MySQL 开发库', driver: 'mysql', host: 'mysql.fixture', port: 3306, database: 'app', user: 'fixture' });
let details = { id: 'public.orders', schema: 'public', name: 'orders', kind: 'table', qualifiedName: 'public.orders', columns: [
  { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true },
  { name: 'status', dataType: 'text', nullable: false, defaultValue: "'draft'::text", comment: '状态' },
  { name: 'total', dataType: 'integer', nullable: true, generated: true, defaultValue: '1 + 1' },
], indexes: [{ name: 'orders_pkey', primary: true, definition: 'PRIMARY KEY (id)' }], constraints: [] };
let mutations = [], failMutation = false, staleCatalog = false;
const invoke = async (command, args) => {
  if (command === 'get_object_details') {
    fixture.calls.push({ command, args });
    return staleCatalog ? { ...details, columns: [...details.columns, { name: 'external', dataType: 'text', nullable: true }] } : details;
  }
  if (command === 'execute_query' && args.request.sql.includes('funnel_fixture')) {
    fixture.calls.push({ command, args });
    return { columns: ['id', 'label', 'note'], rows: [['1','Alpha',null], ['2','Beta',''], ['3','Alpha','text'], ['9007199254740993','Alpha','NULL']], elapsed_ms: 1 };
  }
  if (command === 'execute_mutation' && args.request.sql.startsWith('ALTER TABLE')) {
    fixture.calls.push({ command, args }); mutations.push(args.request);
    if (failMutation) throw new Error('fixture: 类型转换失败');
    if (args.request.sql.includes('ADD COLUMN "note"')) details = { ...details, columns: [...details.columns, { name: 'note', dataType: 'text', nullable: true, defaultValue: null, comment: '' }] };
    if (args.request.sql.includes('SET DEFAULT')) details = { ...details, columns: details.columns.map((column) => column.name === 'status' ? { ...column, defaultValue: "'ready'::text" } : column) };
    return { columns: [], rows: [], row_count: 0 };
  }
  return fixture.invoke(command, args);
};
const server = createServer((req, res) => {
  const file = resolve(dist, (req.url || '/').slice(1) || 'index.html');
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => { window.__DB_STUDIO_FIXTURE__ = true; window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } }; });
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage(); page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
const wait = async (predicate) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error('condition timeout'); };
const filter = async (column, operator, value = '') => {
  await page.locator(`[data-filter-column='${column}']`).click();
  const popup = page.locator('.db-grid-filter-panel');
  await popup.getByRole('button', { name: '筛选条件', exact: true }).click();
  await popup.locator(`[role='option'][data-value='${operator}']`).click();
  if (await popup.getByLabel('筛选值', { exact: true }).isVisible()) await popup.getByLabel('筛选值', { exact: true }).fill(value);
  await popup.getByRole('button', { name: '应用筛选', exact: true }).click();
};
const ids = () => page.locator('.db-grid-body [data-column-index="0"]').allTextContents();
const typeSql = async (sql) => { await page.locator('#sqlEditor .cm-content').click(); await page.keyboard.press('Meta+A'); await page.keyboard.insertText(sql); };
const confirm = () => page.locator('#confirmActionAccept').click();
const contrast = async (selectors) => {
  for (const selector of selectors) {
    const ratio = await page.locator(selector).first().evaluate((node) => {
      const rgba = (value) => { const a = value.match(/[\d.]+/g).map(Number); return [a[0], a[1], a[2], a[3] ?? 1]; };
      const blend = (a, b) => [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3]));
      const chain = []; for (let el = node; el; el = el.parentElement) chain.unshift(el);
      let bg = [255,255,255]; for (const el of chain) bg = blend(rgba(getComputedStyle(el).backgroundColor), bg);
      const fg = blend(rgba(getComputedStyle(node).color), bg);
      const lum = (a) => a.map((c) => c/255).map((c) => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i) => sum + c*[.2126,.7152,.0722][i],0);
      const a = lum(fg), b = lum(bg); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    assert.ok(ratio >= 4.5, `${selector} contrast ${ratio}`);
  }
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('#addQueryTab').click();
  const queryId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await typeSql('SELECT * FROM funnel_fixture'); await page.locator('#runQuery').click();
  await wait(async () => (await ids()).length === 4);
  // Browsing conditions must not submit the form or apply a filter. Escape
  // first dismisses the list, and only a second Escape closes the popover.
  await page.locator('[data-filter-column="1"]').click();
  const filterPanel = page.locator('.db-grid-filter-panel');
  const condition = filterPanel.getByRole('button', { name: '筛选条件', exact: true });
  const conditions = filterPanel.getByRole('listbox');
  await condition.focus(); await page.keyboard.press('ArrowDown');
  assert.ok(await conditions.isVisible());
  assert.equal(await conditions.locator('[aria-selected="true"]').innerText(), '✓\n包含');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await condition.innerText(), '不包含');
  assert.ok(await conditions.isHidden());
  assert.deepEqual(await ids(), ['1', '2', '3', '9007199254740993']);
  await condition.click(); await page.keyboard.press('End'); await page.keyboard.press('Escape');
  assert.equal(await condition.innerText(), '不包含');
  assert.ok(await filterPanel.isVisible());
  assert.ok(await condition.evaluate((node) => node === document.activeElement));
  await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await condition.innerText(), '不为空字符串');
  assert.ok(await filterPanel.getByLabel('筛选值', { exact: true }).isHidden());
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  assert.equal(await condition.innerText(), '包含');
  assert.ok(await filterPanel.getByLabel('筛选值', { exact: true }).isVisible());
  await condition.click(); await page.keyboard.press('Tab');
  assert.ok(await conditions.isHidden());
  assert.ok(await filterPanel.getByLabel('筛选值', { exact: true }).evaluate((node) => node === document.activeElement));
  await condition.click(); await page.keyboard.press('Shift+Tab');
  assert.ok(await filterPanel.getByRole('button', { name: '应用筛选', exact: true }).evaluate((node) => node === document.activeElement));
  await condition.click(); await filterPanel.getByLabel('筛选值', { exact: true }).click();
  assert.ok(await conditions.isHidden());
  await page.keyboard.press('Escape');
  assert.equal(await filterPanel.count(), 0);
  await page.locator('[data-select-row="1"]').check();
  await filter(1, 'contains', 'alpha');
  assert.deepEqual(await ids(), ['1', '3', '9007199254740993']);
  assert.equal(await page.locator('#selectionCount').innerText(), '');
  await filter(0, 'gt', '1'); assert.deepEqual(await ids(), ['3', '9007199254740993']);
  await page.locator('[data-sort-column="0"][data-sort-direction="-1"]').click();
  assert.deepEqual(await ids(), ['9007199254740993', '3']);
  await page.locator('#resultFilter').fill('text'); assert.deepEqual(await ids(), ['3']);
  await page.locator('#resultFilter').fill(''); assert.deepEqual(await ids(), ['9007199254740993','3']);
  await page.locator('[data-select-all]').check();
  await page.locator('#resultMore').click();
  await page.locator('#exportResults').click();
  await wait(async () => (await page.locator('#toast').innerText()).includes('取消导出'));
  const csv = fixture.callsFor('save_text_file').at(-1).args.contents;
  assert.ok(csv.includes('9007199254740993')); assert.ok(csv.includes('3,Alpha,text')); assert.ok(!csv.includes('Beta'));
  assert.equal(csv.split('\r\n').length, 3);
  await page.locator('#addQueryTab').click();
  assert.ok(await page.locator('.db-grid-filter-bar').isHidden());
  await page.locator(`[data-tab-id='${queryId}'] .tab-select`).click();
  assert.deepEqual(await ids(), ['9007199254740993','3']);
  assert.match(await page.locator('#selectionCount').innerText(), /2\/2/);
  await page.locator('[data-remove-filter="all"]').click();
  await filter(2, 'isNull'); assert.deepEqual(await ids(), ['1']);
  await filter(2, 'empty'); assert.deepEqual(await ids(), ['2']);
  await filter(2, 'equal', 'NULL'); assert.deepEqual(await ids(), ['9007199254740993']);
  await filter(2, 'contains', 'missing'); assert.deepEqual(await ids(), []);
  assert.ok(await page.locator('.db-grid-empty').isVisible());
  await page.locator('[data-filter-column="2"]').click(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.db-grid-filter-panel').count(), 0);
  assert.equal(await page.locator('[data-filter-column="2"]').evaluate((node) => document.activeElement === node), true);
  for (const theme of ['dark','ocean','forest','contrast','light']) {
    const option = page.locator(`[data-theme-option='${theme}']`); if (!await option.count()) continue;
    await page.locator('#themeButton').click(); await option.click();
    await page.locator('[data-filter-column="2"]').click();
    await contrast(['.db-grid-filter-panel strong', '.db-grid-filter-panel p', '.db-grid-filter-operator', '.db-grid-filter-panel input', '.db-grid-filter-chip']);
    assert.equal(await filterPanel.locator('select').count(), 0);
    const sizes = await filterPanel.evaluate((panel) => ['.db-grid-filter-operator', 'input'].map((selector) => {
      const rect = panel.querySelector(selector).getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    assert.deepEqual(sizes[0], sizes[1], `${theme}: condition/value controls have different sizes`);
    await page.screenshot({ path: resolve(evidence, `funnel-${theme}.png`) });
    await condition.click();
    await contrast(['.db-grid-filter-option[aria-selected="true"]', '.db-grid-filter-option.active', '.db-grid-filter-check']);
    const bounds = await conditions.boundingBox();
    assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= 1432 && bounds.y >= 8 && bounds.y + bounds.height <= 892, `${theme}: options leave viewport`);
    await page.screenshot({ path: resolve(evidence, `funnel-options-${theme}.png`) });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.locator('[data-filter-column="2"]').click(); await condition.click();
  const compactOptions = await conditions.boundingBox();
  assert.ok(compactOptions.x >= 8 && compactOptions.x + compactOptions.width <= 1052 && compactOptions.y >= 8 && compactOptions.y + compactOptions.height <= 672, 'minimum-window condition list leaves viewport');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await condition.innerText(), '不为空字符串');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('PASS funnel: themed condition dropdown, pointer/keyboard/focus/dismissal, compact bounds, multi-column/text/sort, NULL, empty, precision, selection, export and tabs.');
  await page.locator('[data-remove-filter="all"]').click();
  await page.locator('#objectSearch').fill('orders');
  const object = page.locator('[data-object-id="public.orders"]').first(); await object.waitFor();
  await object.locator('.object-main').dblclick();
  await wait(async () => (await page.locator('#resultCount').innerText()).trim() === '500');
  await filter(0, 'equal', '3');
  await page.locator('.db-grid-body [data-column-index="1"]').click({ button: 'right' });
  await page.locator('.db-grid-cell-menu').getByRole('menuitem', { name: '查看详情', exact: true }).click();
  assert.equal(await page.locator('#cellValue').inputValue(), 'value-3');
  await page.locator('#cellValue').fill('AFTER_FILTER');
  await page.locator('#saveCell').click(); await confirm();
  await page.locator('#cellModal').waitFor({ state: 'hidden' });
  const cellWrite = fixture.callsFor('execute_mutation').at(-1).args.request.sql;
  assert.match(cellWrite, /"id" IS NOT DISTINCT FROM (?:E?'3'|3);/);
  const dataTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator('#openTableSql').click();
  const sqlTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator('#beginTransaction').click();
  await page.locator(`.query-tab[data-tab-id='${dataTabId}'] .tab-select`).click();
  await page.locator('#structureTab').click();
  await page.locator('[data-edit-structure]').click();
  assert.equal(await page.locator('.structure-editor-dialog').count(), 0);
  assert.match(await page.locator('#toast').innerText(), /提交或回滚/);
  await page.locator(`.query-tab[data-tab-id='${sqlTabId}'] .tab-select`).click();
  await page.locator('#rollbackTransaction').click();

  await object.click({ button: 'right' }); await page.locator('[data-context-action="edit-structure"]').click();
  const editor = page.locator('.structure-editor-dialog'); await editor.waitFor();
  assert.ok((await editor.locator('.structure-editor-target').innerText()).includes('开发库 / app / public / orders'));
  assert.ok(await editor.locator('[data-field-row="0"][data-field="defaultValue"]').isDisabled());
  assert.ok(await editor.locator('[data-field-row="2"][data-field="dataType"]').isDisabled());
  assert.equal(mutations.length, 0);
  await editor.locator('[data-field-row="1"][data-field="defaultValue"]').fill("'ready'");
  await editor.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
  await editor.locator('[data-field-row="3"][data-field="name"]').fill('note');
  assert.match(await editor.locator('pre').innerText(), /ADD COLUMN "note" text/);
  for (const theme of ['dark','ocean','forest','contrast','light']) {
    await page.evaluate((theme) => { document.body.dataset.theme = theme; }, theme);
    await contrast(['.structure-editor-target', '.structure-editor-dialog .form-note', '.structure-editor-table input[type=text]:not(:disabled)', '.structure-editor-table .changed [data-column-status]', '.structure-sql-preview pre']);
    await page.screenshot({ path: resolve(evidence, `structure-editor-${theme}.png`) });
  }
  await editor.getByRole('button', { name: '预览并应用', exact: true }).click();
  assert.match(await page.locator('#confirmActionModal').innerText(), /开发库 \/ app \/ public \/ orders/);
  await page.locator('#confirmActionModal [value="cancel"]').click();
  assert.equal(mutations.length, 0);
  assert.equal(await editor.locator('[data-field-row="3"][data-field="name"]').inputValue(), 'note');
  failMutation = true;
  await editor.getByRole('button', { name: '预览并应用', exact: true }).click(); await confirm();
  await wait(async () => (await editor.locator('.dialog-feedback').innerText()).includes('类型转换失败'));
  assert.equal(await editor.locator('[data-field-row="3"][data-field="name"]').inputValue(), 'note');
  assert.equal(mutations.length, 1);
  staleCatalog = true; failMutation = false;
  await editor.getByRole('button', { name: '预览并应用', exact: true }).click(); await confirm();
  await wait(async () => (await editor.locator('.dialog-feedback').innerText()).includes('其他操作修改'));
  assert.equal(mutations.length, 1); staleCatalog = false;
  await editor.getByRole('button', { name: '预览并应用', exact: true }).click(); await confirm();
  await editor.waitFor({ state: 'detached' });
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].connectionId, 'conn-dev'); assert.equal(mutations[1].database, 'app'); assert.equal(mutations[1].schema, 'public');
  assert.ok((await page.locator('#structurePanel').innerText()).includes('note'));
  assert.ok(await page.locator('#editorPane').isHidden());
  const browseTab = page.locator('.query-tab').filter({ hasText: /^×SQLorders$/ });
  if (await browseTab.count()) {
    const structureTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
    await browseTab.locator('.tab-select').click();
    await page.locator('#resultTab').click();
    assert.equal(await page.locator('.db-grid-body [data-grid-cell]').count(), 0);
    await page.locator(`[data-tab-id='${structureTabId}'] .tab-select`).click();
  }
  await page.locator('[data-refresh-structure]').click(); await page.locator('[data-edit-structure]').waitFor();
  await page.locator('#modeBadge').click(); await page.locator('[data-edit-structure]').click();
  assert.equal(await editor.count(), 0); assert.match(await page.locator('#toast').innerText(), /只读/);
  await page.locator('#modeBadge').click(); await page.locator('[data-edit-structure]').click(); await editor.waitFor();
  await page.setViewportSize({ width: 720, height: 600 });
  await page.screenshot({ path: resolve(evidence, 'structure-editor-compact.png') });
  assert.ok(await editor.evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth));
  await editor.getByRole('button', { name: '取消', exact: true }).click(); await editor.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-connection-id="mysql-local"]').click();
  await page.locator('#objectSearch').fill('orders');
  await page.locator('[data-object-id="public.orders"]').first().click({ button: 'right' });
  await page.locator('[data-context-action="edit-structure"]').click(); await editor.waitFor();
  assert.ok(await editor.locator('[data-field-row="1"][data-field="dataType"]').isDisabled());
  await editor.locator('[data-field-row="1"][data-field="name"]').fill('state');
  await editor.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
  await editor.locator('[data-field-row="4"][data-field="name"]').fill('remark');
  assert.match(await editor.locator('pre').innerText(), /RENAME COLUMN `status` TO `state`,/);
  assert.match(await editor.locator('pre').innerText(), /ADD COLUMN `remark` varchar\(255\)/);
  await editor.getByRole('button', { name: '预览并应用', exact: true }).click(); await confirm();
  await editor.waitFor({ state: 'detached' });
  assert.equal(mutations.at(-1).connectionId, 'mysql-local');
  assert.deepEqual(errors, []);
  console.log('PASS structure: target, field metadata, add/default SQL, preview, cancel, error draft, stale catalog, success refresh, readonly and compact layout.');
} catch (error) { await page.screenshot({ path: resolve(evidence, 'failure.png') }); throw error; }
finally { await context.close(); await browser.close(); await new Promise((done) => server.close(done)); }
