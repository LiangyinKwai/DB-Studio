import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('async function showTableData()'), source.indexOf('async function runRedisCommand('));

function fixture(kind = 'table') {
  const object = { id: 'orders', name: 'orders', schema: 'sales', database: 'shop', kind };
  const tab = { id: 'preview', connectionId: 'original', structureOnly: true,
    inspectedObject: object, openedObject: { ...object, connectionId: 'original' },
    openedObjectView: 'structure', outputTab: 'structure', structure: { columns: [] } };
  const queries = [];
  let release;
  const metadata = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    state: { activeConnectionId: 'other', tabs: [tab], structureRequest: 0, editor: { setState() {} } },
    activeTab: () => tab,
    objectTabTarget: (value, connectionId) => ({ ...value, connectionId }),
    findObjectTab: () => null,
    matchesObjectTab: (value, target) => value.openedObject.connectionId === target.connectionId,
    browseSql: browse => `SELECT * FROM "${browse.schema}"."${browse.name}" LIMIT ${browse.pageSize + 1} OFFSET ${browse.page * browse.pageSize};`,
    addTab: () => { throw new Error('Expected existing structure tab to be reused'); },
    makeEditorState: () => ({}), renderTabs() {}, renderOutput() {}, updateCursor() {}, persistTabs() {},
    loadBrowseDetails: async (value, prefetched) => { assert.equal(value, tab); assert.equal(prefetched, tab.structure); await metadata; },
    runQuery: async () => { queries.push({ connectionId: tab.browse.connectionId, sql: tab.sql }); },
  });
  vm.runInContext(navigation, context);
  return { tab, queries, release, show: () => context.showTableData() };
}

test('structure to data loads the first page once using the original connection', async () => {
  for (const kind of ['table', 'partitioned_table', 'view', 'materialized_view', 'foreign_table']) {
    const { tab, queries, release, show } = fixture(kind);
    const pending = show();
    assert.equal(tab.structureOnly, false);
    assert.equal(tab.outputTab, 'result');
    assert.equal(tab.browse.page, 0);
    assert.equal(tab.browse.pageSize, 500);
    await show(); // A second click during metadata loading must not dispatch twice.
    assert.equal(queries.length, 0);
    release();
    await pending;
    assert.deepEqual(queries, [{ connectionId: 'original', sql: 'SELECT * FROM "sales"."orders" LIMIT 501 OFFSET 0;' }]);
    tab.outputTab = 'structure';
    await show();
    assert.equal(tab.outputTab, 'result');
    assert.equal(queries.length, 1);
  }
});

test('non-queryable objects do not execute a default query', async () => {
  const { queries, show } = fixture('sequence');
  await show();
  assert.equal(queries.length, 0);
});

function pagingFixture({ confirm = async () => true, query } = {}) {
  const result = { executed: true, columns: ['id'], rows: [[1]] };
  const tab = { id: 'orders', sql: 'OFFSET 0', browse: { page: 0, pageSize: 500 }, result };
  let active = tab;
  const calls = [], messages = [];
  const context = vm.createContext({
    activeTab: () => active, cellWritePending: () => false,
    confirmDiscardCellEdits: confirm, state: { editor: { setState() {} } },
    resultGrid: { getViewState: () => ({ widths: [180], scrollLeft: 240, scrollTop: 900 }) },
    browseSql: browse => `OFFSET ${browse.page * browse.pageSize}`,
    setEditorValue: sql => { tab.sql = sql; }, renderOutput() {}, persistTabs() {},
    makeEditorState: value => ({ sql: value.sql }), showToast: text => messages.push(text),
    runQuery: async options => {
      calls.push(options);
      assert.equal(options.preserveResult, true);
      assert.equal(options.pagingRequest, tab.paging);
      if (query) return query(tab);
      tab.result = { ...result, rows: [[2]] };
      return true;
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function jumpBrowsePage('), source.indexOf('async function runQuery(')), context);
  return { tab, result, context, calls, messages, switchAway: () => { active = null; } };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('paging keeps data, column geometry and current page until the replacement arrives', async () => {
  const pending = deferred(), started = deferred();
  const { tab, result, context, calls } = pagingFixture({ query: async value => {
    started.resolve();
    await pending.promise;
    value.result = { ...result, rows: [[2]] };
    return true;
  } });
  const navigation = context.moveBrowsePage(1);
  await started.promise;
  assert.equal(tab.sql, 'OFFSET 500');
  assert.equal(tab.result, result);
  assert.equal(tab.browse.page, 0);
  assert.deepEqual([...tab.paging.view.widths], [180]);
  assert.equal(tab.paging.view.scrollLeft, 240);
  assert.equal(tab.paging.view.scrollTop, 0);
  await context.moveBrowsePage(1);
  assert.equal(calls.length, 1);
  pending.resolve();
  await navigation;
  assert.equal(tab.browse.page, 1);
  assert.equal(tab.paging, null);
  assert.deepEqual(tab.result.rows, [[2]]);
});

test('jump uses one-based page numbers and rejects invalid or overflowing offsets', async () => {
  const { tab, context, calls, messages } = pagingFixture();
  for (const input of ['', '0', '-1', '1.5', '1e3', 'abc', '9007199254740993', '999999999999999']) await context.jumpBrowsePage(input);
  assert.equal(calls.length, 0);
  assert.equal(messages.length, 8);
  await context.jumpBrowsePage(' 12 ');
  assert.equal(tab.sql, 'OFFSET 5500');
  assert.equal(tab.browse.page, 11);
  await context.jumpBrowsePage('12');
  assert.equal(calls.length, 1);
});

test('cancelled or failed page loads keep the original page and SQL', async () => {
  for (const query of [async () => false, async () => undefined, async () => { throw new Error('offline'); }]) {
    const { tab, result, context } = pagingFixture({ query });
    await context.jumpBrowsePage('5').catch(error => assert.equal(error.message, 'offline'));
    assert.equal(tab.result, result);
    assert.equal(tab.browse.page, 0);
    assert.equal(tab.sql, 'OFFSET 0');
    assert.equal(tab.paging, null);
  }
});

test('pending discard confirmation blocks duplicate navigation and declining preserves data', async () => {
  const pending = deferred();
  const { tab, context, calls } = pagingFixture({ confirm: () => pending.promise });
  const navigation = context.jumpBrowsePage('2');
  await context.jumpBrowsePage('3');
  assert.equal(tab.paging.page, 1);
  pending.resolve(false);
  await navigation;
  assert.equal(calls.length, 0);
  assert.equal(tab.browse.page, 0);
  assert.equal(tab.paging, null);
});

test('background completion commits to the originating tab and empty pages explain navigation', async () => {
  const pending = deferred(), started = deferred();
  const f = pagingFixture({ query: async tab => {
    started.resolve();
    await pending.promise;
    tab.result = { executed: true, columns: ['id'], rows: [] };
    return true;
  } });
  const navigation = f.context.jumpBrowsePage('8');
  await started.promise;
  f.switchAway();
  pending.resolve();
  await navigation;
  assert.equal(f.tab.browse.page, 7);
  assert.equal(f.tab.paging, null);
  assert.equal(f.messages.length, 0);
  const empty = pagingFixture({ query: async tab => { tab.result = { ...tab.result, rows: [] }; return true; } });
  await empty.context.jumpBrowsePage('8');
  assert.match(empty.messages[0], /第 8 页没有数据/);
});
