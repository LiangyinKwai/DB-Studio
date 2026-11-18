import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, revealObject, setTabReadOnly } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const fixture = createWorkspaceFixture();
const mysql = { id: 'mysql-objects', name: 'MySQL', driver: 'mysql', host: 'fixture', port: 3306, user: 'tester', database: 'warehouse' };
fixture.profiles.push(mysql);
const viewQueries = { 'public.orders_view': 'SELECT id FROM public.orders', 'warehouse.orders_view': 'select `id` from `orders` with LOCAL CHECK OPTION' };
const object = (schema, name, kind) => ({ id: `${schema}.${name}`, qualifiedName: `${schema}.${name}`, schema, name, kind });
const sequence = { ...object('public', 'orders_seq', 'sequence'), sequenceOwnedByColumn: true };
const independentSequence = { ...object('public', 'business_number', 'sequence'), sequenceOwnedByColumn: false };
const analyticsSequence = { ...object('analytics', 'events_id_seq', 'sequence'), sequenceOwnedByColumn: true };
const matview = object('public', 'orders_matview', 'materialized_view');
const event = object('warehouse', 'cleanup', 'event');
const mysqlFunction = object('warehouse', 'recount', 'function');
mysqlFunction.id += ':function';
const routine = object('warehouse', 'recount', 'procedure');
const orders = object('warehouse', 'orders', 'table');
const mutations = [];
const transactionScripts = [];
let finishScript;
let failView = true;
let reads = 0;
// 'intact': the CREATE fails before anything changed. 'dropped': the DROP already committed, restore works.
// 'dropped-stuck': the DROP committed and the restore fails as well.
let routineFailure = null;
let routineDropped = false;
let routineDefinitionDrift = false;
// While set, a routine save stays in flight until `releaseRoutineSave()` runs, so the busy dialog can be probed.
let holdRoutineSave = false;
let releaseRoutineSave;
let mysqlProcedureDefinition = 'CREATE PROCEDURE recount(IN value bigint, OUT result int) SET result=1';
let savedPgRoutine = null;
async function invoke(command, args) {
  const isMysql = args?.connectionId === mysql.id;
  if (command === 'execute_mutation' && /^(save|restore)-routine-/.test(args.request.queryId)) {
    mutations.push(args.request);
    if (holdRoutineSave) await new Promise(resolve => { releaseRoutineSave = resolve; });
    if (args.request.queryId.startsWith('restore-routine')) {
      if (routineFailure === 'dropped-stuck') throw new Error('fixture restore failed');
      routineDropped = false;
    } else if (routineFailure) {
      routineDropped = routineFailure !== 'intact';
      throw new Error('fixture create failed');
    } else if (args.request.connectionId === mysql.id) mysqlProcedureDefinition = args.request.sql.split('\n')[2].slice(0, -2);
    else savedPgRoutine = args.request.sql.replace(/;\s*$/, '');
    return { columns: [], rows: [], row_count: 0 };
  }
  if (command === 'get_object_ddl_details' && routineDropped) throw new Error('fixture routine does not exist');
  if (command === 'get_object_ddl_details' && routineDefinitionDrift && args.kind === 'procedure' && isMysql) {
    routineDefinitionDrift = false;
    return { ...routine, definition: 'CREATE PROCEDURE recount() SELECT 99', mysql: { sqlMode: '' } };
  }
  if (isMysql && command === 'list_databases') return [{ name: 'warehouse', current: true }];
  if (isMysql && command === 'get_query_context') return { database: 'warehouse', defaultSchema: 'warehouse', searchPath: ['warehouse'] };
  if (command === 'get_schema_objects') {
    const views = Object.keys(viewQueries).filter(id => id.startsWith(args.schemaName + '.')).map(id => object(args.schemaName, id.split('.')[1], 'view'));
    if (isMysql) return [orders, event, mysqlFunction, routine, ...views];
    const catalog = await fixture.invoke(command, args);
    if (args.schemaName === 'public') return [...catalog.filter(item => item.kind !== 'view'), sequence, independentSequence, matview, ...views];
    if (args.schemaName === 'analytics') return [...catalog, analyticsSequence];
    return catalog;
  }
  if (command === 'get_object_details' || command === 'get_object_ddl_details') {
    if (args.kind === 'view') {
      const [schema, name] = args.objectId.split('.');
      const query = viewQueries[args.objectId];
      const definition = isMysql ? `CREATE ALGORITHM=MERGE DEFINER=\`test\`@\`%\` SQL SECURITY INVOKER VIEW \`${name}\` AS ${query}` : query + ';';
      return { ...object(schema, name, 'view'), definition, ...(isMysql ? { mysql: { sqlMode: '' } } : {
        viewDdl: `CREATE OR REPLACE VIEW "${schema}"."${name}" WITH (security_barrier = 'true') AS\n${query};`,
      }) };
    }
    if (args.kind === 'sequence') return { ...sequence, sequence: { ownedBy: 'public.orders.id', dataType: 'bigint', start: '9007199254740993', increment: '2', cache: '1', lastValue: null }, definition: 'CREATE SEQUENCE "public"."orders_seq" AS bigint START WITH 9007199254740993;' };
    if (args.kind === 'event') return { ...event, event: { status: 'DISABLED', scheduler: 'ON', schedule: 'EVERY 1 DAY', timeZone: 'SYSTEM' }, definition: 'CREATE EVENT cleanup ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1' };
    if (args.kind === 'trigger') return { definition: 'CREATE TRIGGER before_order BEFORE INSERT ON orders FOR EACH ROW SET @seen=1' };
    if (args.kind === 'procedure' && isMysql) return { ...routine, signature: 'recount(IN value bigint, OUT result int)', parameters: [{ name: 'value', dataType: 'bigint', mode: 'IN' }, { name: 'result', dataType: 'int', mode: 'OUT' }], definition: mysqlProcedureDefinition, mysql: { sqlMode: '' } };
    if (args.kind === 'materialized_view') return { ...matview, definition: 'SELECT id FROM public.orders;' };
    if (!isMysql && args.kind === 'procedure') return { ...await fixture.invoke('get_object_details', args), ...(savedPgRoutine ? { definition: savedPgRoutine } : {}) };
    const result = await fixture.invoke('get_object_details', args);
    if (isMysql) return { ...result, ...orders, autoIncrement: '9007199254740993', triggers: [{ id: 'trigger-probe', name: 'before_order', timing: 'BEFORE', event: 'INSERT' }], definition: 'CREATE TABLE `orders` (`id` bigint)', mysql: { sqlMode: '', engine: 'InnoDB' } };
    return { ...result, columns: [{ ...result.columns[0], sequence }] };
  }
  if (command === 'execute_query' && args.request.sql.includes('orders_matview')) {
    return { columns: ['id'], rows: [[++reads]], row_count: 1, elapsed_ms: 1 };
  }
  if (command === 'execute_mutation' && args.request.transactionScript) {
    transactionScripts.push(args.request);
    await new Promise(resolve => { finishScript = resolve; });
    if (args.request.sql.includes('missing_table')) {
      const { sql } = args.request;
      const from = sql.indexOf('SELECT status');
      const rollback = sql.includes('missing_table_unconfirmed') ? 'unconfirmed' : 'succeeded';
      return { scriptError: {
        message: 'fixture missing table',
        rollback,
        rollbackDetail: rollback === 'unconfirmed' ? 'fixture rollback timeout' : null,
        statement: { number: 3, from, to: sql.indexOf(';', from) + 1 },
      } };
    }
    return { columns: ['status'], rows: [['updated']], row_count: 1, statement_count: 2, transaction_script: 'commit' };
  }
  if (command === 'execute_mutation' && args.request.outsideTransaction) {
    const request = args.request;
    assert.equal(request.singleStatement, true);
    mutations.push(request);
    if (request.sql.startsWith('CREATE VIEW') && failView) throw new Error('fixture rejected view');
    if (request.sql.startsWith('CREATE VIEW')) viewQueries[`${request.schema}.new_view`] = 'SELECT 1 AS id';
    return { columns: [], rows: [], row_count: 0 };
  }
  return fixture.invoke(command, args);
}

const server = createServer(async (req, res) => {
  const file = new URL('.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname), new URL('../dist/', import.meta.url));
  try {
    const contents = await readFile(file);
    res.writeHead(200, { 'content-type': file.pathname.endsWith('.html') ? 'text/html' : file.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
    res.end(contents);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: async (...args) => {
    const result = await window.__FIXTURE_INVOKE__(...args);
    if (result?.scriptError) throw result.scriptError;
    return result;
  } } };
  if (!localStorage.getItem('db-studio.query-library.v1')) localStorage.setItem('db-studio.query-library.v1', JSON.stringify([
    { title: 'PG favorite', sql: 'SELECT 17', connectionId: 'conn-dev', database: 'app', schema: 'public' },
    { title: 'MySQL favorite', sql: 'SELECT 84', connectionId: 'mysql-objects', database: 'warehouse', schema: 'warehouse' },
  ]));
});
await context.exposeFunction('__FIXTURE_INVOKE__', invoke);
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const confirm = () => page.locator('#confirmActionAccept').click();
const treeObject = id => page.locator(`[data-object-id="${id}"] .object-main`);
const category = (scope, kind) => page.locator(`${scope} [data-kind="${kind}"].tree-category [data-tree-toggle]`);
const openContext = async (locator, action) => {
  await locator.click({ button: 'right' });
  await page.locator(`#objectContextMenu [data-context-action="${action}"]`).click();
};
const pgDb = '.tree-database[data-database="app"]';
const mysqlDb = '.tree-database[data-database="warehouse"]';
const form = page.locator('.view-editor');
const sqlEditor = page.locator('#sqlEditor .cm-content');
const routineEditor = page.locator('.routine-editor');
const routineText = routineEditor.locator('.cm-content');
const routineSave = routineEditor.locator('[data-routine-save]');
const routineStatus = routineEditor.locator('.routine-editor-status');
const routineAlert = routineEditor.getByRole('alert');
const routineDefinition = page.locator('.routine-definition .cm-content');
const transactionState = text => page.locator('#transactionState').getByText(text, { exact: true }).waitFor();
const executeTransaction = async (sql, action, expectedState, connectionId, database) => {
  const calls = () => fixture.callsFor(`${action}_transaction`);
  const count = calls().length;
  await sqlEditor.fill(sql);
  await page.locator('#runQuery').click();
  await transactionState(expectedState);
  assert.equal(calls().length, count + 1);
  assert.deepEqual(calls().at(-1).args, { connectionId, database });
  assert.ok(await page.locator('#confirmActionModal').isHidden());
};
async function verifyScriptExecution(connectionId, database, fail = false) {
  const table = fail === 'unconfirmed' ? 'missing_table_unconfirmed' : fail ? 'missing_table' : 'orders';
  const sql = `  BEGIN;\nUPDATE orders SET status = 'updated'; -- 🐬\n  SELECT status FROM ${table};\nCOMMIT;`;
  const prefix = fail === 'unconfirmed' ? "SELECT 'outside 🐘';\n" : "";
  const source = prefix + sql;
  const count = transactionScripts.length;
  await sqlEditor.fill(source);
  if (prefix) {
    await page.keyboard.press('Meta+ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Meta+Shift+ArrowDown');
    assert.equal(await page.locator('#runLabel').innerText(), '执行选中');
  }
  await page.locator('#runQuery').click();
  await page.getByRole('dialog', { name: '确认执行事务脚本' }).waitFor();
  assert.equal(await page.locator('#confirmActionModal [data-confirm-detail]').innerText(), sql.trim());
  await page.locator('#confirmActionCancel').click();
  await page.locator('#confirmActionModal').waitFor({ state: 'hidden' });
  assert.equal(transactionScripts.length, count);
  assert.equal(await sqlEditor.innerText(), source);
  await page.locator('#runQuery').click();
  await confirm();
  await transactionState('事务脚本执行中');
  assert.ok(await page.locator('#confirmActionModal').isHidden());
  assert.equal(transactionScripts.length, count + 1);
  assert.equal(transactionScripts.at(-1).connectionId, connectionId);
  assert.equal(transactionScripts.at(-1).database, database);
  assert.equal(transactionScripts.at(-1).sql, sql.trim());
  finishScript();
  await transactionState('自动提交');
  if (fail) {
    const status = fail === 'unconfirmed' ? /回滚结果无法确认/ : /回滚成功/;
    await page.locator('#messagePanel').getByText(status).waitFor();
    assert.ok((await page.locator('#messagePanel').innerText()).includes(`第 3 条 SQL（第 ${prefix ? 4 : 3} 行）失败`));
    if (fail === 'unconfirmed') assert.match(await page.locator('#messagePanel').innerText(), /fixture rollback timeout/);
    const marked = await sqlEditor.locator('.sql-failed-statement').allTextContents();
    assert.equal(marked.join(''), `SELECT status FROM ${table};`);
    assert.equal(await page.locator('#runLabel').innerText(), prefix ? '执行选中' : '执行');
    assert.equal(await sqlEditor.innerText(), source);
  } else {
    await page.locator('#toast').getByText('事务脚本已提交', { exact: true }).waitFor();
    assert.equal(await page.locator('#resultGrid .db-grid-cell').first().innerText(), 'updated');
  }
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator(`${pgDb} > summary [data-tree-toggle]`).click();
  const schema = `${pgDb} .tree-schema[data-schema="public"]`;
  await page.locator(`${schema} > summary [data-tree-toggle]`).click();
  const routines = page.locator(`${schema} .tree-category[data-kind="routine"]`);
  assert.equal(await routines.locator('.count').innerText(), '1');
  await category(schema, 'routine').click();
  assert.match(await routines.locator('.tree-object[data-kind="procedure"] .object-main').getAttribute('title'), /存储过程$/);

  // A routine tab shows its definition directly.
  await treeObject('public.refresh_proc').click();
  await routineDefinition.getByText(/CREATE OR REPLACE PROCEDURE/).waitFor();
  assert.deepEqual(await page.locator('.result-tab:visible').allInnerTexts(), ['定义']);
  assert.equal(await page.locator('#resultFooter').isVisible(), false);
  assert.equal(await page.locator('#refreshTableData').getAttribute('title'), '刷新定义');
  assert.equal(await page.locator('#structurePanel .structure-section').count(), 0);
  // PostgreSQL saves with one CREATE OR REPLACE and says so before it could fork an overload.
  await page.locator('[data-edit-routine]').click();
  await routineEditor.waitFor();
  assert.equal(await routineEditor.locator('h2').innerText(), '编辑存储过程');
  assert.match(await routineEditor.locator('.routine-editor-note').innerText(), /CREATE OR REPLACE/);
  assert.equal(await routineStatus.innerText(), '尚未修改');
  assert.ok(await routineSave.isDisabled());
  const pgRoutine = (await routineText.innerText()).trimEnd();
  assert.match(pgRoutine, /^CREATE OR REPLACE PROCEDURE public\.refresh_orders\(\)/);
  await routineText.fill('SELECT 1');
  await routineEditor.locator('.routine-editor-status.invalid').getByText(/CREATE PROCEDURE/).waitFor();
  assert.ok(await routineSave.isDisabled());
  await routineText.fill(pgRoutine.replace('refresh_orders()', 'refresh_orders(days integer)'));
  await routineEditor.locator('.routine-editor-status.warning').getByText(/参数列表已改变.*重载/).waitFor();
  await routineText.fill(pgRoutine.replace('daily_orders', 'weekly_orders'));
  await routineStatus.getByText('已修改，保存前会再次确认。').waitFor();
  await routineEditor.locator('[data-routine-cancel]').click();
  await page.getByText('放弃尚未保存的存储过程修改？').waitFor();
  await page.locator('#confirmActionCancel').click();
  assert.match(await routineText.innerText(), /weekly_orders/);
  await routineSave.click();
  assert.match(await page.locator('#confirmActionModal [data-confirm-message]').innerText(), /CREATE OR REPLACE.*一个事务内/);
  assert.match(await page.locator('#confirmActionModal [data-confirm-detail]').innerText(), /weekly_orders/);
  await confirm();
  await routineEditor.waitFor({ state: 'hidden' });
  const pgSaved = mutations.at(-1);
  assert.equal(pgSaved.singleStatement, true);
  assert.equal(pgSaved.database, 'app');
  assert.match(pgSaved.sql, /weekly_orders;\nEND;\n\$procedure\$;$/);
  await routineDefinition.getByText(/weekly_orders/).waitFor();
  await page.locator('#toast').getByText('存储过程已保存', { exact: true }).waitFor();
  // The context menu offers the same editor; closing an untouched editor never prompts.
  await openContext(treeObject('public.refresh_proc'), 'edit-routine');
  await routineEditor.waitFor();
  assert.match(await routineText.innerText(), /weekly_orders/);
  await page.keyboard.press('Escape');
  await routineEditor.waitFor({ state: 'hidden' });

  // Clicking the blank area behaves like 取消: silent when untouched, via the discard prompt when edited,
  // and ignored when a press started inside the editor (a text selection dragged out) or while saving.
  const confirmHidden = async () => assert.ok(await page.locator('#confirmActionModal').isHidden());
  const settle = () => page.waitForTimeout(250);
  const openPgRoutine = async () => {
    await openContext(treeObject('public.refresh_proc'), 'edit-routine');
    await routineEditor.waitFor();
  };
  const backdropPoint = async () => {
    const box = await routineEditor.boundingBox();
    return { x: box.x / 2, y: box.y + box.height / 2 };
  };
  const clickBackdrop = async () => {
    const { x, y } = await backdropPoint();
    await page.mouse.click(x, y);
  };
  await openPgRoutine();
  await clickBackdrop();
  await routineEditor.waitFor({ state: 'hidden' });
  await confirmHidden();

  await openPgRoutine();
  await routineEditor.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const compactBox = await routineEditor.boundingBox();
  assert.ok(compactBox.width <= 800, `routine editor stays compact: ${compactBox.width}`);
  const surface = routineEditor.locator('.routine-editor-surface');
  const initialLines = parseInt(await routineEditor.locator('.routine-editor-meta').innerText(), 10);
  assert.equal(await surface.evaluate(element => element.style.getPropertyValue('--routine-lines')), String(initialLines));
  const surfaceHeight = (await surface.boundingBox()).height;
  const compactText = (await routineText.innerText()).trimEnd();
  await routineText.fill(`${compactText}\n${'-- extra line\n'.repeat(60)}`);
  await routineStatus.getByText('已修改，保存前会再次确认。').waitFor();
  const grownBox = await routineEditor.boundingBox();
  assert.deepEqual([grownBox.x, grownBox.y, grownBox.width, grownBox.height], [compactBox.x, compactBox.y, compactBox.width, compactBox.height], 'typing never resizes or moves the dialog');
  assert.equal((await surface.boundingBox()).height, surfaceHeight);
  await clickBackdrop();
  await page.getByText('放弃尚未保存的存储过程修改？').waitFor();
  await page.locator('#confirmActionCancel').click();
  await settle();
  assert.equal(await routineEditor.isVisible(), true);
  assert.match(await routineText.innerText(), /-- extra line/);
  await clickBackdrop();
  await page.getByText('放弃尚未保存的存储过程修改？').waitFor();
  await confirm();
  await routineEditor.waitFor({ state: 'hidden' });

  // A press inside the editor released on the backdrop (dragging a selection out) must not dismiss it.
  await openPgRoutine();
  const textBox = await routineText.boundingBox();
  const outside = await backdropPoint();
  await page.mouse.move(textBox.x + 40, textBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 6 });
  await page.mouse.up();
  await settle();
  assert.equal(await routineEditor.isVisible(), true);
  await confirmHidden();
  // The reverse drag (press on the backdrop, release inside) does not dismiss it either.
  await page.mouse.move(outside.x, outside.y);
  await page.mouse.down();
  await page.mouse.move(textBox.x + 40, textBox.y + 12, { steps: 6 });
  await page.mouse.up();
  await settle();
  assert.equal(await routineEditor.isVisible(), true);
  await confirmHidden();

  // While a save is in flight the backdrop is inert.
  await routineText.fill(compactText.replace('weekly_orders', 'monthly_orders'));
  await routineStatus.getByText('已修改，保存前会再次确认。').waitFor();
  holdRoutineSave = true;
  const savesBefore = mutations.length;
  await routineSave.click();
  await confirm();
  await page.waitForFunction(() => document.querySelector('.routine-editor')?.hasAttribute('aria-busy'));
  while (mutations.length === savesBefore) await page.waitForTimeout(20);
  await clickBackdrop();
  await settle();
  assert.equal(await routineEditor.isVisible(), true);
  assert.equal(await routineEditor.getAttribute('aria-busy'), '');
  await confirmHidden();
  holdRoutineSave = false;
  releaseRoutineSave();
  await routineEditor.waitFor({ state: 'hidden' });
  assert.match(mutations.at(-1).sql, /monthly_orders/);
  await page.locator('.query-tab.active [data-close-tab]').click();
  const sequences = page.locator(`${schema} .tree-category[data-kind="sequence"] > .category-summary`);
  assert.equal(await sequences.getAttribute('aria-expanded'), 'false');
  assert.equal(await sequences.locator('.count').innerText(), '1');
  await category(schema, 'sequence').click();
  await treeObject(independentSequence.id).waitFor();
  assert.equal(await treeObject(sequence.id).count(), 0);
  await page.locator('#objectSearch').fill(sequence.name);
  assert.equal(await page.locator('#objectTree .tree-category[data-kind="sequence"]').count(), 0);
  assert.equal(await page.locator(`${pgDb} > summary`).count(), 0);
  await page.locator('#objectSearch').fill(independentSequence.name);
  await treeObject(independentSequence.id).waitFor();
  await page.locator('#objectSearch').fill('');
  assert.equal(await page.locator(`${pgDb} > .database-children > .tree-category[data-kind="query"]`).count(), 0);
  const pgQueries = page.locator(`${schema} > .tree-category[data-kind="query"]`);
  assert.deepEqual(await page.locator(`${schema} > .tree-category`).evaluateAll(groups => groups.map(group => group.dataset.kind)), ['table', 'view', 'materialized_view', 'routine', 'query', 'sequence']);
  assert.equal(await pgQueries.locator('.count').innerText(), '0');
  await pgQueries.getByRole('button', { name: '展开 查询', exact: true }).click();
  await pgQueries.getByRole('button', { name: '新建查询', exact: true }).click();
  await page.locator('.query-tab.active').getByText('查询 · public', { exact: true }).waitFor();
  assert.equal(await pgQueries.locator('.count').innerText(), '1');
  const pgDraft = pgQueries.getByRole('button', { name: '查询 · public', exact: true });
  const pgDraftId = await pgDraft.getAttribute('data-tree-query-tab');
  assert.match(await page.locator('#editorHint').innerText(), /app \/ public/);
  await transactionState('自动提交');
  await setTabReadOnly(page, true);
  assert.ok(await page.locator('.query-tab.active .tab-readonly').isVisible());
  await sqlEditor.fill('BEGIN');
  const beginCalls = fixture.callsFor('begin_transaction').length;
  await page.locator('#runQuery').click();
  await page.locator('#toast').getByText('请先在标签菜单关闭只读模式', { exact: true }).waitFor();
  assert.equal(fixture.callsFor('begin_transaction').length, beginCalls);
  await setTabReadOnly(page, false);
  await executeTransaction('-- start\nBEGIN;', 'begin', '事务中 · 未提交', 'conn-dev', 'app');
  await page.locator('#addQueryTab').click();
  await transactionState('事务中 · 未提交');
  await executeTransaction('COMMIT;', 'commit', '自动提交', 'conn-dev', 'app');
  await verifyScriptExecution('conn-dev', 'app');
  await page.locator('.query-tab.active .tab-close').click();
  const analytics = `${pgDb} .tree-schema[data-schema="analytics"]`;
  await page.locator(`${analytics} > summary [data-tree-toggle]`).click();
  await category(analytics, 'view').click();
  assert.equal(await page.locator(`${analytics} > .tree-category[data-kind="sequence"]`).count(), 0);
  assert.equal(await page.locator(`${analytics} > .tree-category[data-kind="query"] .count`).innerText(), '0');
  await page.locator(`${analytics} [data-tree-create-view]`).click();
  await form.getByRole('textbox', { name: '视图名称' }).waitFor();
  assert.match(await form.locator('.dialog-header p').innerText(), /analytics$/);
  await form.getByRole('button', { name: '取消' }).click();
  assert.equal(await page.locator(`${pgDb} [data-kind="saved_query"]`).count(), 0);
  await openContext(page.locator(`${schema} > summary`), 'create-view');
  await form.getByRole('textbox', { name: '视图名称' }).fill('new_view');
  const query = form.getByRole('textbox', { name: '查询 SQL' });
  await query.fill('SELECT 1 AS id');
  await form.getByRole('button', { name: '保存视图' }).click();
  await confirm();
  await form.getByRole('alert').filter({ hasText: 'fixture rejected view' }).waitFor();
  assert.equal(await query.inputValue(), 'SELECT 1 AS id');
  failView = false;
  await form.getByRole('button', { name: '保存视图' }).click();
  await confirm();
  await form.waitFor({ state: 'hidden' });
  assert.equal(mutations.at(-1).sql, 'CREATE VIEW "public"."new_view" AS\nSELECT 1 AS id');

  await category(schema, 'view').click();
  await treeObject('public.new_view').waitFor();
  await openContext(treeObject('public.orders_view'), 'edit-view');
  assert.equal(await query.inputValue(), 'SELECT id FROM public.orders');
  await query.fill('SELECT id FROM public.orders WHERE id > 0');
  await form.getByRole('button', { name: '保存视图' }).click();
  await confirm();
  await form.waitFor({ state: 'hidden' });
  assert.match(mutations.at(-1).sql, /security_barrier = 'true'[\s\S]*WHERE id > 0/);

  const pgTables = page.locator(`${schema} > .tree-category[data-kind="table"]`);
  assert.equal(await pgTables.locator('.category-summary').getAttribute('aria-expanded'), 'false');
  await revealObject(treeObject('public.orders'));
  await openContext(treeObject('public.orders'), 'open-structure');
  await page.getByRole('button', { name: '查看 id 的序列' }).click();
  await page.locator('#structurePanel').getByText('9007199254740993', { exact: true }).waitFor();
  await page.locator('#structurePanel').getByText('public.orders.id', { exact: true }).waitFor();
  // Sequences and events have nothing to browse or run either: one "详情" page without data/message tabs.
  assert.deepEqual(await page.locator('.result-tab:visible').allInnerTexts(), ['详情']);
  assert.equal(await page.locator('.query-tab.active .tab-label').innerText(), '详情 · orders_seq');
  assert.equal(await page.locator('#resultFooter').isVisible(), false);
  await category(schema, 'materialized_view').click();
  await treeObject(matview.id).click();
  await page.locator('#resultGrid .db-grid-cell').first().waitFor();
  await openContext(treeObject(matview.id), 'refresh-matview');
  await confirm();
  await page.locator('#resultGrid .db-grid-cell').getByText('2', { exact: true }).waitFor();
  assert.equal(mutations.at(-1).sql, 'REFRESH MATERIALIZED VIEW "public"."orders_matview";');
  await pgDraft.click();
  assert.equal(await page.locator('.query-tab.active').getAttribute('data-tab-id'), pgDraftId);
  await page.locator('.query-tab.active [data-close-tab]').click();
  assert.equal(await pgQueries.locator('.count').innerText(), '0');

  await page.locator('[data-connection-id="mysql-objects"]').click();
  await page.locator(`${mysqlDb} > summary [data-tree-toggle]`).click();
  assert.equal(await page.locator(`${mysqlDb} [data-kind="saved_query"]`).count(), 0);
  await revealObject(treeObject(orders.id));
  await openContext(treeObject(orders.id), 'open-structure');
  await page.locator('#structurePanel').getByRole('tab', { name: '触发器' }).click();
  await page.locator('#structurePanel').getByText('BEFORE', { exact: true }).waitFor();
  await page.locator('[data-trigger-ddl]').click();
  const ddl = page.locator('.ddl-view-dialog');
  await ddl.getByText(/CREATE TRIGGER/).first().waitFor();
  await page.keyboard.press('Escape');
  await category(mysqlDb, 'event').click();
  await treeObject(event.id).click();
  await page.locator('#structurePanel').getByText('EVERY 1 DAY', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.result-tab:visible').allInnerTexts(), ['详情']);
  assert.equal(await page.locator('#refreshTableData').getAttribute('title'), '刷新详情');
  assert.equal(await page.locator('#resultFooter').isVisible(), false);
  await treeObject(event.id).click({ button: 'right' });
  assert.equal(await page.locator('#objectContextMenu [data-context-action="open-structure"] [data-context-label]').innerText(), '查看详情');
  await page.keyboard.press('Escape');
  await page.locator('#objectContextMenu').waitFor({ state: 'hidden' });
  const mysqlRoutines = page.locator(`${mysqlDb} .tree-category[data-kind="routine"]`);
  assert.equal(await mysqlRoutines.locator('.count').innerText(), '2');
  await category(mysqlDb, 'routine').click();
  assert.deepEqual(await mysqlRoutines.locator('.category-items [data-catalog-icon]').evaluateAll(icons => icons.map(icon => icon.dataset.catalogIcon)), ['function', 'procedure']);
  assert.deepEqual(await page.locator(`${mysqlDb} > .mysql-database-objects > .tree-category`).evaluateAll(groups => groups.map(group => group.dataset.kind)), ['table', 'view', 'query', 'routine', 'event']);
  const mysqlQueries = page.locator(`${mysqlDb} .tree-category[data-kind="query"]`);
  assert.equal(await mysqlQueries.locator('.count').innerText(), '0');
  await mysqlQueries.getByRole('button', { name: '展开 查询', exact: true }).click();
  await mysqlQueries.getByRole('button', { name: '新建查询', exact: true }).click();
  await page.locator('.query-tab.active').getByText('查询 · warehouse', { exact: true }).waitFor();
  assert.equal(await mysqlQueries.locator('.count').innerText(), '1');
  await executeTransaction('START TRANSACTION', 'begin', '事务中 · 未提交', mysql.id, 'warehouse');
  await executeTransaction('ROLLBACK;', 'rollback', '自动提交', mysql.id, 'warehouse');
  await verifyScriptExecution(mysql.id, 'warehouse', true);
  await verifyScriptExecution(mysql.id, 'warehouse', 'unconfirmed');
  await treeObject(routine.id).click();
  await page.locator('.routine-definition .cm-content').getByText(/CREATE PROCEDURE/).waitFor();
  assert.equal(await page.locator('.query-tab.active .tab-label').innerText(), routine.name);
  assert.ok(await page.locator('.routine-definition .cm-lineNumbers').isVisible());
  const typeBadge = page.locator('#structurePanel .structure-kind');
  assert.equal(await typeBadge.innerText(), '存储过程');
  assert.equal(await typeBadge.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  assert.equal(await page.locator('#viewTableDdl .tab-glyph').innerText(), 'DDL');
  assert.equal(await page.locator('#openTableSql .tab-glyph').innerText(), 'SQL');
  for (const theme of ['light', 'dark']) {
    await page.locator('#themeButton').click();
    await page.locator(`[data-theme-option="${theme}"]`).click();
    await mysqlRoutines.locator('.category-summary .tree-label').click();
    const procedureIcons = await page.locator('[data-catalog-icon="procedure"]').evaluateAll(nodes =>
      nodes.map(node => ({ color: getComputedStyle(node).color, icon: node.querySelector('svg')?.outerHTML })));
    assert.equal(procedureIcons.length, 3);
    assert.ok(procedureIcons[0].icon);
    assert.deepEqual(procedureIcons, Array(3).fill(procedureIcons[0]));
    const sourceBadges = await page.locator('.object-source-action .tab-glyph').evaluateAll(nodes =>
      nodes.map(node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor, node.clientWidth, node.clientHeight]));
    assert.equal(sourceBadges.length, 2);
    assert.deepEqual(sourceBadges[0], sourceBadges[1]);
    const countContrast = await mysqlRoutines.locator('.category-summary.selected .count').evaluate(node => {
      const style = getComputedStyle(node);
      const luminance = color => color.match(/\d+/g).slice(0, 3)
        .map(Number).map(value => value / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const values = [luminance(style.color), luminance(style.backgroundColor)];
      return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    });
    assert.ok(countContrast >= 4.5, `${theme} selected count contrast: ${countContrast}`);
  }
  await openContext(treeObject(routine.id), 'call-routine');
  await page.locator('#sqlEditor .cm-content').getByText('CALL `warehouse`.`recount`(NULL, @arg_2);', { exact: true }).waitFor();

  // MySQL cannot replace a routine in place: DROP + CREATE in one DELIMITER script, restoring the original on failure.
  const originalProcedure = mysqlProcedureDefinition;
  await treeObject(routine.id).click();
  await routineDefinition.getByText(/SET result=1/).waitFor();
  await page.locator('[data-edit-routine]').click();
  await routineEditor.waitFor();
  assert.match(await routineEditor.locator('.routine-editor-note').innerText(), /先删除原对象再重新创建/);
  assert.equal((await routineText.innerText()).trimEnd(), originalProcedure);
  const editedProcedure = originalProcedure.replace('result=1', 'result=2');
  routineFailure = 'intact';
  await routineText.fill(`${editedProcedure};`);
  await routineSave.click();
  assert.match(await page.locator('#confirmActionModal [data-confirm-message]').innerText(), /先删除再重建.*不能回滚/);
  assert.equal(await page.locator('#confirmActionModal [data-confirm-detail]').innerText(), `DROP PROCEDURE IF EXISTS \`warehouse\`.\`recount\`;\n${editedProcedure};`);
  await confirm();
  await routineAlert.filter({ hasText: '原存储过程未被改动' }).waitFor();
  assert.match(await routineAlert.innerText(), /fixture create failed/);
  assert.match(await routineText.innerText(), /result=2/);
  routineFailure = 'dropped-stuck';
  const restoreAttempts = () => mutations.filter(request => request.queryId.startsWith('restore-routine')).length;
  await routineSave.click();
  await confirm();
  await routineAlert.filter({ hasText: '无法确认原存储过程是否仍然存在' }).waitFor();
  assert.equal(restoreAttempts(), 1);
  await page.locator('.query-tab .tab-label', { hasText: '原定义 · recount' }).waitFor();
  assert.equal(await page.locator('.query-tab', { hasText: '原定义 · recount' }).count(), 1);
  // The previous scenario left the routine missing; assume the user recreated it from the opened tab.
  routineDropped = false;
  routineFailure = 'dropped';
  await routineSave.click();
  await confirm();
  await routineAlert.filter({ hasText: '已自动恢复原存储过程' }).waitFor();
  assert.equal(mutations.at(-1).sql, `DELIMITER $$\n${originalProcedure}$$\nDELIMITER ;`);
  assert.match(mutations.at(-1).queryId, /^restore-routine-/);
  routineFailure = null;
  routineDefinitionDrift = true;
  const mutationsBeforeDrift = mutations.length;
  await routineSave.click();
  await confirm();
  await routineAlert.filter({ hasText: '数据库中的存储过程定义已被修改' }).waitFor();
  assert.equal(mutations.length, mutationsBeforeDrift);
  await routineSave.click();
  await confirm();
  await routineEditor.waitFor({ state: 'hidden' });
  const mysqlSaved = mutations.at(-1);
  assert.equal(mysqlSaved.singleStatement, false);
  assert.equal(mysqlSaved.database, 'warehouse');
  assert.equal(mysqlSaved.sql, `DELIMITER $$\nDROP PROCEDURE IF EXISTS \`warehouse\`.\`recount\`$$\n${editedProcedure}$$\nDELIMITER ;`);
  // The failed-restore scenario left the "原定义" tab active; the definition tab reloads when it is shown again.
  await page.locator('.query-tab', { hasText: '原定义 · recount' }).locator('[data-close-tab]').click();
  await treeObject(routine.id).click();
  await routineDefinition.getByText(/SET result=2/).waitFor();
  await category(mysqlDb, 'view').click();
  await openContext(treeObject('warehouse.orders_view'), 'edit-view');
  assert.match(await query.inputValue(), /LOCAL CHECK OPTION/);
  await form.getByRole('button', { name: '保存视图' }).click();
  await confirm();
  await form.waitFor({ state: 'hidden' });
  assert.match(mutations.at(-1).sql, /ALTER ALGORITHM=MERGE DEFINER=.* SQL SECURITY INVOKER VIEW `warehouse`\.`orders_view` AS/);
  assert.equal(mutations.at(-1).expectedMysqlNoBackslashEscapes, false);
  await openContext(page.locator(`${mysqlDb} > summary`), 'create-view');
  await form.getByRole('textbox', { name: '视图名称' }).fill('new_view');
  await query.fill('SELECT 1 AS id');
  await form.getByRole('button', { name: '保存视图' }).click();
  await confirm();
  await form.waitFor({ state: 'hidden' });
  await treeObject('warehouse.new_view').waitFor();
  assert.equal(mutations.at(-1).sql, 'CREATE VIEW `warehouse`.`new_view` AS\nSELECT 1 AS id');
  assert.deepEqual(errors, []);
  console.log('PASS: both view editors, both routine editors, PG sequence and materialized refresh, MySQL triggers/routines/events.');
} finally {
  await browser.close();
  server.close();
}
