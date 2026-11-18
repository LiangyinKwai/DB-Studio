import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildCellUpdateSql, cellColumnName, getCellEditCapability, validateCellDraft } from '../src/cell-edit.js';
import { formatCellValue } from '../src/result-grid.js';
import { inspectorSourceValue } from '../src/value-reader.js';
import { estimateResultBytes, MAX_RESULT_BYTES, selectResultsToRelease } from '../src/query-memory.js';

// Execute the production service functions, with only the application boundary
// (dialogs, database IPC and rendered grid) replaced by controlled fixtures.
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production function boundary: ${start}`);
  return mainSource.slice(from, to);
}
const serviceSource = sourceBetween('function cellDestination(tab) {', 'function openCellInspector(');
const dialogSaveSource = sourceBetween('async function saveCellEdit() {', 'function showFeedback(');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const tab = {
    id: 'orders-tab', connectionId: 'pg', mode: 'write', database: 'commerce', schema: 'sales',
    browse: {
      connectionId: 'pg', database: 'commerce', schema: 'sales', name: 'orders', kind: 'table',
      primaryKeys: ['tenant_id', 'id'],
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
        { name: 'tenant_id', dataType: 'text', nullable: false, primaryKey: true },
        { name: 'status', dataType: 'text', nullable: true },
        { name: 'payload', dataType: 'jsonb', nullable: true },
      ],
    },
    result: {
      executed: true, connectionId: 'pg',
      // Result columns intentionally differ from metadata and primary-key order.
      columns: [{ name: 'status' }, 'id', 'payload', 'tenant_id'],
      rows: [
        ['draft', '9007199254740993', '{"n":9007199254740993}', 'acme'],
        ['ready', '9007199254740994', '{"n":2}', 'beta'],
      ],
    },
  };
  const state = {
    tabs: [tab], activeTabId: tab.id, gridResult: tab.result,
    profiles: [{ id: 'pg', driver: 'postgres', host: 'fixture', port: 5432, user: 'test', database: 'commerce' }],
    transactionKeys: new Set(),
  };
  const calls = [];
  const confirmations = [];
  const notifications = [];
  const ui = { refreshes: 0, renders: 0, closes: 0 };
  const refs = {
    saveCell: { disabled: false }, setCellEmpty: { disabled: false }, restoreCellValue: { disabled: false }, cellValue: { value: '', disabled: false },
    cellNull: { checked: false, disabled: false }, cellFeedback: { textContent: '' },
    cellModal: { close() { ui.closes++; } },
  };
  const sandbox = {
    state, refs,
    cellColumnName, getCellEditCapability, validateCellDraft, buildCellUpdateSql,
    inspectorSourceValue,
    cellText: formatCellValue,
    activeTab: () => state.tabs.find(item => item.id === state.activeTabId),
    driverForTab: target => state.profiles.find(profile => profile.id === target?.connectionId)?.driver || 'postgres',
    tabDatabase: target => target?.browse?.database || target?.database || '',
    tabSchema: target => target?.browse?.schema ?? target?.schema ?? null,
    redisTabDatabase: target => target.redisDb ?? 0,
    queryTargetDescription: target => `${target.connectionId}/${target.browse?.database || target.database}/${target.browse?.schema || target.schema}`,
    transactionKey: (connectionId, database) => `${connectionId}\0${database}`,
    resultGrid: { refreshRows() { ui.refreshes++; } },
    renderTabs() { ui.renders++; },
    showToast: message => notifications.push(message),
    errorText: error => error?.message || String(error),
    makeId: prefix => `${prefix}-fixture`,
    confirmAction: async (message, options) => { confirmations.push({ message, options }); return true; },
    call: async (command, args) => { calls.push({ command, args }); return { row_count: 1 }; },
  };
  const runtime = vm.createContext(sandbox);
  vm.runInContext(`${serviceSource}\n${dialogSaveSource}`, runtime, { filename: 'main-cell-save-service.js' });
  const cell = (rowIndex = 0, columnIndex = 0) => ({
    column: cellColumnName(tab.result.columns[columnIndex]), columnIndex, rowIndex, value: tab.result.rows[rowIndex][columnIndex],
  });
  return {
    tab, state, calls, confirmations, notifications, ui, refs, runtime, cell,
    capture: (rowIndex = 0, columnIndex = 0) => runtime.getCellEditState(cell(rowIndex, columnIndex)).context,
  };
}

const batchDraft = (context, newValue, isNull = false) => ({ context, newValue, isNull });
test('saved large values enter the result budget once their tab is no longer protected', async () => {
  const f = fixture();
  f.tab.result.bytes = estimateResultBytes(f.tab.result);
  const other = { id: 'other-tab', result: { executed: true, bytes: MAX_RESULT_BYTES - 4096 } };
  const tabs = [f.tab, other];
  assert.deepEqual(selectResultsToRelease(tabs, { activeTab: other }), []);

  await f.runtime.commitCellValue(f.capture(), 'x'.repeat(4096), false, { confirm: false });
  assert.ok(estimateResultBytes(f.tab.result) > 4096);
  assert.deepEqual(selectResultsToRelease(tabs, { activeTab: f.tab, currentTab: other }), []);
  assert.deepEqual(selectResultsToRelease(tabs, { activeTab: other, isProtected: tab => tab === f.tab }), []);
  assert.deepEqual(selectResultsToRelease(tabs, { activeTab: other }), [f.tab]);

  f.tab.result.cellEditsInTransaction = true;
  assert.deepEqual(selectResultsToRelease(tabs, { activeTab: other }), []);
});

test('failed cell saves preserve the original data and its valid size estimate', async () => {
  const f = fixture();
  const original = f.tab.result.rows[0];
  const originalBytes = f.tab.result.bytes = estimateResultBytes(f.tab.result);
  f.runtime.call = async () => { throw new Error('connection unavailable'); };
  await assert.rejects(f.runtime.commitCellValue(f.capture(), 'x'.repeat(4096), false, { confirm: false }), /connection unavailable/);
  assert.equal(f.tab.result.rows[0], original);
  assert.equal(f.tab.result.bytes, originalBytes);
});

test('saving composite primary key drafts rebases later cells to the new keys in either edit order', async () => {
  for (const keyFirst of [true, false]) {
    const f = fixture();
    const drafts = [batchDraft(f.capture(0, 1), '9007199254740997'), batchDraft(f.capture(0, 3), 'new-tenant'), batchDraft(f.capture(0, 0), 'paid')];
    if (!keyFirst) drafts.unshift(drafts.pop());
    f.runtime.resultGrid.updateCellEditContexts = (_rows, update) => drafts.forEach(draft => update(draft));
    const outcomes = await f.runtime.commitTableCellEdits(drafts);
    assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [true, true, true]);
    assert.deepEqual(Array.from(f.tab.result.rows[0]), ['paid', '9007199254740997', '{"n":9007199254740993}', 'new-tenant']);
    if (keyFirst) {
      assert.match(f.calls[0].args.request.sql, /SET "id" = E'9007199254740997'.*WHERE "tenant_id" IS NOT DISTINCT FROM E'acme' AND "id" IS NOT DISTINCT FROM E'9007199254740993'/);
      assert.match(f.calls[1].args.request.sql, /WHERE "tenant_id" IS NOT DISTINCT FROM E'acme' AND "id" IS NOT DISTINCT FROM E'9007199254740997'/);
      assert.match(f.calls[2].args.request.sql, /WHERE "tenant_id" IS NOT DISTINCT FROM E'new-tenant' AND "id" IS NOT DISTINCT FROM E'9007199254740997'/);
    }
    await f.runtime.commitCellValue(f.capture(0, 0), 'later', false, { confirm: false });
    assert.match(f.calls.at(-1).args.request.sql, /WHERE "tenant_id" IS NOT DISTINCT FROM E'new-tenant' AND "id" IS NOT DISTINCT FROM E'9007199254740997'/);
  }
});

test('failed primary key saves retain the original row and all unsaved drafts for retry', async () => {
  for (const message of ['duplicate key', 'foreign key restriction']) {
    const f = fixture(), original = f.tab.result.rows[0];
    const drafts = [batchDraft(f.capture(0, 1), '9007199254740994'), batchDraft(f.capture(0, 0), 'paid')];
    f.runtime.call = async () => { throw new Error(message); };
    const outcomes = await f.runtime.commitTableCellEdits(drafts);
    assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [false, false]);
    assert.equal(f.tab.result.rows[0], original);
    assert.equal(drafts[1].context.rowRef, original);
    assert.equal(drafts[1].newValue, 'paid');
  }
});

test('MySQL save-all rebases typed BIT and binary primary key values before subsequent updates', async () => {
  const f = fixture(); f.state.profiles[0].driver = 'mysql';
  f.tab.browse.primaryKeys = ['mask', 'raw_key'];
  f.tab.browse.columns = [{ name: 'mask', dataType: 'bit(8)', primaryKey: true }, { name: 'raw_key', dataType: 'varbinary(8)', primaryKey: true }, { name: 'label', dataType: 'text' }];
  f.tab.result.columns = ['mask', 'raw_key', 'label'];
  f.tab.result.rows = [['255', { $dbStudio: 'mysql-binary', hex: '00ff' }, 'before']];
  const drafts = [batchDraft(f.capture(0, 1), '0xaabb'), batchDraft(f.capture(0, 0), '254'), batchDraft(f.capture(0, 2), 'after')];
  f.runtime.resultGrid.updateCellEditContexts = (_rows, update) => drafts.forEach(update);
  const result = await f.runtime.commitTableCellEdits(drafts);
  assert.deepEqual(Array.from(result, outcome => outcome.saved), [true, true, true]);
  assert.match(f.calls[0].args.request.sql, /SET `raw_key` = X'aabb' WHERE `mask` <=> 255 AND `raw_key` <=> X'00ff'/);
  assert.match(f.calls[1].args.request.sql, /SET `mask` = 254 WHERE `mask` <=> 255 AND `raw_key` <=> X'aabb'/);
  assert.match(f.calls[2].args.request.sql, /WHERE `mask` <=> 254 AND `raw_key` <=> X'aabb'/);
});

test('transaction rollback requires backend confirmation for every SQL driver', () => {
  const f = fixture();
  assert.equal(f.runtime.transactionDidRollback(new Error('DDL cannot run inside the active transaction'), 'mysql'), false);
  assert.equal(f.runtime.transactionDidRollback(new Error('[TX_ROLLED_BACK] failed update'), 'mysql'), true);
  assert.equal(f.runtime.transactionDidRollback(new Error('failed update'), 'postgres'), false);
  assert.equal(f.runtime.transactionDidRollback(new Error('[TX_ROLLED_BACK] failed update'), 'postgres'), true);
  assert.equal(f.runtime.transactionDidRollback(new Error('[TX_MISSING] [TX_OUTCOME_UNKNOWN] lost connection'), 'postgres'), false);
});

test('table save writes multiple cells directly without per-cell confirmations and preserves sibling row changes', async () => {
  const f = fixture();
  const status = f.capture(0, 0), json = f.capture(0, 2), other = f.capture(1, 0);
  const drafts = [batchDraft(status, 'paid'), batchDraft(json, '{"n":9007199254740995}'), batchDraft(other, 'done')];
  f.runtime.resultGrid.updateCellEditContexts = (_rows, update) => drafts.forEach(draft => update(draft));
  const result = await f.runtime.commitTableCellEdits(drafts);
  assert.deepEqual(Array.from(result, outcome => outcome.saved), [true, true, true]);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(Array.from(f.tab.result.rows[0]), ['paid', '9007199254740993', '{"n":9007199254740995}', 'acme']);
  assert.equal(f.tab.result.rows[1][0], 'done');
  assert.equal(f.notifications.length, 1);
  assert.equal(f.tab.cellBatchSaving, null);
});

test('table save validates every draft before writing and rejects mixed targets', async () => {
  const f = fixture();
  await assert.rejects(f.runtime.commitTableCellEdits([batchDraft(f.capture(), 'paid'), batchDraft(f.capture(1, 2), '{bad')]), /JSON 格式无效/);
  assert.equal(f.calls.length, 0);
  const context = f.capture(1, 0);
  await assert.rejects(f.runtime.commitTableCellEdits([batchDraft(f.capture(), 'paid'), batchDraft({ ...context, tab: { ...f.tab } }, 'other')]), /当前表/);
  assert.equal(f.calls.length, 0);
});

test('table save stops on failure and reports exactly which cells were saved', async () => {
  const f = fixture();
  let writes = 0;
  f.runtime.call = async () => { if (++writes === 2) throw new Error('connection unavailable'); return { row_count: 1 }; };
  const outcomes = await f.runtime.commitTableCellEdits([batchDraft(f.capture(), 'paid'), batchDraft(f.capture(1, 0), 'ready2'), batchDraft(f.capture(1, 2), '{}')]);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [true, false, false]);
  assert.equal(writes, 2);
  assert.equal(f.tab.result.rows[0][0], 'paid');
  assert.equal(f.tab.result.rows[1][0], 'ready');
  assert.equal(f.tab.cellBatchSaving, null);
  assert.match(f.notifications.at(-1), /已保存 1 格.*2 格修改已保留/);
});

test('a rolled-back transaction cannot mark earlier cells in the same batch as saved', async () => {
  const f = fixture();
  f.state.transactionKeys.add('pg\0commerce');
  let writes = 0;
  f.runtime.call = async () => { if (++writes === 2) throw new Error('[TX_ROLLED_BACK] transaction failed'); return { row_count: 1 }; };
  const outcomes = await f.runtime.commitTableCellEdits([batchDraft(f.capture(), 'paid'), batchDraft(f.capture(1, 0), 'ready2')]);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [false, false]);
  assert.equal(f.tab.result.transactionRolledBack, true);
  assert.equal(f.state.transactionKeys.has('pg\0commerce'), false);
  assert.match(f.notifications.at(-1), /事务已回滚/);
});

test('an unknown PostgreSQL transaction outcome retains the whole batch without claiming rollback', async () => {
  const f = fixture();
  f.state.transactionKeys.add('pg\0commerce');
  let writes = 0;
  f.runtime.call = async () => { if (++writes === 2) throw new Error('[TX_MISSING] [TX_OUTCOME_UNKNOWN] cancellation cleanup unconfirmed'); return { row_count: 1 }; };
  const drafts = [batchDraft(f.capture(), 'paid'), batchDraft(f.capture(1, 0), 'ready2')];
  const outcomes = await f.runtime.commitTableCellEdits(drafts);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [false, false]);
  assert.equal(f.state.transactionKeys.has('pg\0commerce'), false);
  assert.equal(f.tab.result.transactionRolledBack, false);
  assert.equal(f.tab.result.transactionOutcomeUnknown, true);
  assert.match(f.notifications.at(-1), /事务结果未知.*草稿已保留/);
  assert.doesNotMatch(f.notifications.at(-1), /已回滚|已撤销/);
  assert.doesNotMatch(f.tab.message, /已回滚|已撤销/);
  assert.equal(drafts[0].newValue, 'paid');
  assert.equal(drafts[1].newValue, 'ready2');
  await assert.rejects(f.runtime.commitCellValue(drafts[1].context, 'retry', false, { confirm: false }), /事务结果未知/);
  assert.equal(writes, 2, 'stale uncertain values cannot be written again without refresh');
});

test('an uncertain isolated write blocks retry without clearing a transaction started later', async () => {
  const f = fixture();
  let writes = 0;
  f.runtime.call = async () => {
    writes++;
    f.state.transactionKeys.add('pg\0commerce'); // A later independent transaction.
    throw new Error('[PG_OUTCOME_UNKNOWN] write timeout');
  };
  const context = f.capture(), original = f.tab.result.rows[0];
  await assert.rejects(f.runtime.commitCellValue(context, 'paid', false, { confirm: false }), /PG_OUTCOME_UNKNOWN/);
  assert.equal(f.state.transactionKeys.has('pg\0commerce'), true);
  assert.equal(f.tab.result.rows[0], original);
  assert.equal(f.tab.result.transactionRolledBack, false);
  assert.equal(f.tab.result.writeOutcomeUnknown, true);
  assert.match(f.tab.message, /写入结果未知.*草稿已保留/);
  await assert.rejects(f.runtime.commitCellValue(context, 'paid', false, { confirm: false }), /结果未知/);
  assert.equal(writes, 1);
});

test('an uncertain isolated batch preserves known saves and keeps the uncertain draft', async () => {
  const f = fixture();
  let writes = 0;
  f.runtime.call = async () => { if (++writes === 2) throw new Error('[PG_OUTCOME_UNKNOWN] write timeout'); return { row_count: 1 }; };
  const outcomes = await f.runtime.commitTableCellEdits([batchDraft(f.capture(), 'paid'), batchDraft(f.capture(1, 0), 'ready2')]);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [true, false]);
  assert.equal(f.tab.result.writeOutcomeUnknown, true);
  assert.match(f.notifications.at(-1), /已保存 1 格.*1 格修改已保留/);
  assert.doesNotMatch(f.notifications.at(-1), /已回滚/);
});

test('table save locks duplicate and single-cell writes for the full operation', async () => {
  const f = fixture();
  const first = f.capture(), second = f.capture(1, 0);
  const held = deferred();
  let writes = 0;
  f.runtime.call = async () => { writes++; await held.promise; return { row_count: 1 }; };
  const saving = f.runtime.commitTableCellEdits([batchDraft(first, 'paid')]);
  await assert.rejects(f.runtime.commitTableCellEdits([batchDraft(second, 'done')]), /等待/);
  await assert.rejects(f.runtime.commitInlineCell({ context: second, newValue: 'done' }), /等待/);
  assert.equal(writes, 1);
  held.resolve(); await saving;
  assert.equal(f.tab.cellBatchSaving, null);
});

test('Redis hash batch saves retain the captured logical DB and original value checks', async () => {
  const f = fixture();
  f.state.profiles[0].driver = 'redis';
  Object.assign(f.tab, { browse: null, database: '7', redisDb: 7, redisKey: 'shared:key', redisType: 'hash' });
  f.tab.result.columns = ['field', 'value'];
  f.tab.result.rows = [['name', 'Ada'], ['role', 'admin']];
  const outcomes = await f.runtime.commitTableCellEdits([batchDraft(f.capture(0, 1), 'Grace'), batchDraft(f.capture(1, 1), 'editor')]);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.saved), [true, true]);
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.calls.map(call => [call.command, call.args.request.connectionId, call.args.request.database, call.args.request.field, call.args.request.expectedValue]), [
    ['save_redis_cell', 'pg', 7, 'name', 'Ada'], ['save_redis_cell', 'pg', 7, 'role', 'admin'],
  ]);
});

test('cancelling the real save confirmation sends no database write and retains the original row', async () => {
  const f = fixture();
  const original = f.tab.result.rows[0];
  const context = f.capture();
  f.runtime.confirmAction = async () => false;
  assert.equal(await f.runtime.commitInlineCell({ context, newValue: 'paid', isNull: false }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.tab.result.rows[0], original);
  assert.equal(f.tab.cellSaving, false);
});

test('an unchanged cell completes without confirmation or a write', async () => {
  const f = fixture();
  assert.equal(await f.runtime.commitCellValue(f.capture(), 'draft'), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmations.length, 0);
});

const invalidations = [
  ['result replacement', f => { f.tab.result = { ...f.tab.result, rows: f.tab.result.rows.map(row => [...row]) }; }],
  ['row replacement', f => { f.tab.result.rows[0] = [...f.tab.result.rows[0]]; }],
  ['read-only mode', f => { f.tab.mode = 'read'; }],
  ['database change', f => { f.tab.browse.database = 'different_database'; }],
  ['schema change', f => { f.tab.browse.schema = 'different_schema'; }],
  ['connection endpoint change', f => { f.state.profiles[0].host = 'another-host'; }],
  ['result column reordering', f => { f.tab.result.columns = ['tenant_id', 'id', 'payload', 'status']; }],
  ['closed tab', f => { f.state.tabs = []; }],
];

for (const [name, invalidate] of invalidations) {
  test(`a ${name} before save rejects the captured context before confirmation`, async () => {
    const f = fixture();
    const context = f.capture();
    invalidate(f);
    await assert.rejects(f.runtime.commitCellValue(context, 'paid'));
    assert.equal(f.calls.length, 0);
    assert.equal(f.confirmations.length, 0);
  });

  test(`a ${name} while confirming is rechecked before dispatch`, async () => {
    const f = fixture();
    const context = f.capture();
    const decision = deferred();
    f.runtime.confirmAction = () => decision.promise;
    const saving = f.runtime.commitCellValue(context, 'paid');
    assert.equal(f.tab.cellSaving, true);
    invalidate(f);
    decision.resolve(true);
    await assert.rejects(saving);
    assert.equal(f.calls.length, 0);
    assert.equal(f.tab.cellSaving, false);
  });
}

test('the save uses captured reordered columns and all primary keys without numeric precision loss', async () => {
  const f = fixture();
  const rows = f.tab.result.rows;
  const second = rows[1];
  assert.equal(await f.runtime.commitCellValue(f.capture(), "customer's paid"), true);
  assert.equal(f.calls.length, 1);
  const { command, args: { request } } = f.calls[0];
  assert.equal(command, 'execute_mutation');
  assert.equal(request.connectionId, 'pg');
  assert.equal(request.database, 'commerce');
  assert.equal(request.schema, 'sales');
  assert.equal(request.readOnly, false);
  assert.equal(request.sql, 'UPDATE "sales"."orders" SET "status" = E\'customer\'\'s paid\' WHERE "tenant_id" IS NOT DISTINCT FROM E\'acme\' AND "id" IS NOT DISTINCT FROM E\'9007199254740993\';');
  assert.equal(f.confirmations[0].options.detail, request.sql);
  assert.equal(f.tab.result.rows, rows);
  assert.equal(rows[0][0], "customer's paid");
  assert.equal(rows[1], second);
  assert.equal(f.ui.refreshes, 1);
});

test('a database response after switching tabs only updates the captured row and leaves the active grid alone', async () => {
  const f = fixture();
  const response = deferred();
  const dispatched = deferred();
  f.runtime.call = (command, args) => { f.calls.push({ command, args }); dispatched.resolve(); return response.promise; };
  const context = f.capture();
  const saving = f.runtime.commitCellValue(context, 'paid');
  await dispatched.promise;
  const other = { ...f.tab, id: 'other-tab', result: { ...f.tab.result, rows: [['other', '4', '{}', 'beta']] }, cellSaving: false };
  const otherRow = other.result.rows[0];
  f.state.tabs.push(other);
  f.state.activeTabId = other.id;
  f.state.gridResult = other.result;
  response.resolve({ row_count: 1 });
  assert.equal(await saving, true);
  assert.equal(f.tab.result.rows[0][0], 'paid');
  assert.equal(f.tab.result.rows[0][1], '9007199254740993');
  assert.equal(other.result.rows[0], otherRow);
  assert.equal(other.result.rows[0][0], 'other');
  assert.equal(f.ui.refreshes, 0);
  assert.equal(f.tab.cellSaving, false);
});

test('a delayed save never patches a replacement result even after the write succeeds', async () => {
  const f = fixture();
  const response = deferred();
  const dispatched = deferred();
  f.runtime.call = () => { dispatched.resolve(); return response.promise; };
  const saving = f.runtime.commitCellValue(f.capture(), 'paid');
  await dispatched.promise;
  const replacement = { ...f.tab.result, rows: [['replacement', '8', '{}', 'beta']] };
  f.tab.result = replacement;
  response.resolve({ row_count: 1 });
  assert.equal(await saving, true);
  assert.equal(f.tab.result, replacement);
  assert.equal(f.tab.result.rows[0][0], 'replacement');
  assert.equal(f.ui.refreshes, 0);
});

test('backend failures retain the original row, release the save lock and clear a rolled-back transaction', async () => {
  const f = fixture();
  const original = f.tab.result.rows[0];
  f.state.transactionKeys.add('pg\0commerce');
  f.runtime.call = async () => { throw new Error('[TX_ROLLED_BACK] database rejected value'); };
  await assert.rejects(f.runtime.commitCellValue(f.capture(), 'paid'), /database rejected value/);
  assert.equal(f.tab.result.rows[0], original);
  assert.equal(f.tab.cellSaving, false);
  assert.equal(f.state.transactionKeys.has('pg\0commerce'), false);
  assert.equal(f.ui.refreshes, 0);
});

test('a changed transaction during confirmation prevents dispatch', async () => {
  const f = fixture();
  const decision = deferred();
  f.runtime.confirmAction = () => decision.promise;
  const saving = f.runtime.commitCellValue(f.capture(), 'paid');
  f.state.transactionKeys.add('pg\0commerce');
  decision.resolve(true);
  await assert.rejects(saving, /事务状态已改变/);
  assert.equal(f.calls.length, 0);
});

test('zero affected rows never fabricate an updated local row', async () => {
  const f = fixture();
  const original = f.tab.result.rows[0];
  f.runtime.call = async () => ({ row_count: 0 });
  await assert.rejects(f.runtime.commitCellValue(f.capture(), 'paid'), /没有报告行变更/);
  assert.equal(f.tab.result.rows[0], original);
  assert.equal(f.ui.refreshes, 0);
});

test('JSON validation preserves large integer source and rejects malformed JSON before confirmation', async () => {
  const f = fixture();
  const context = f.capture(0, 2);
  await assert.rejects(f.runtime.commitCellValue(context, '{bad json'), /JSON 格式无效/);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.length, 0);
  const source = '{\n  "n": 9007199254740995\n}';
  assert.equal(await f.runtime.commitInlineCell({ context, newValue: source, isNull: false }), true);
  assert.equal(f.tab.result.rows[0][2], source);
  assert.ok(f.calls[0].args.request.sql.includes('9007199254740995'));
});

test('inline SQL saves keep database NULL distinct from an empty string', async () => {
  for (const [newValue, isNull, expectedSql] of [['', true, 'SET "status" = NULL'], ['', false, 'SET "status" = E\'\'']]) {
    const f = fixture();
    assert.equal(await f.runtime.commitInlineCell({ context: f.capture(), newValue, isNull }), true);
    assert.ok(f.calls[0].args.request.sql.includes(expectedSql));
    assert.equal(f.tab.result.rows[0][0], isNull ? null : '');
  }
});

test('the existing dialog save uses the same captured-row service for its edited JSON draft', async () => {
  const f = fixture();
  const source = '{\n  "n": 9007199254740995\n}';
  f.state.cellInspector = { context: f.capture(0, 2), jsonInfo: { raw: source }, jsonEditing: false };
  f.refs.cellValue.value = 'ignored preview text';
  await f.runtime.saveCellEdit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.tab.result.rows[0][2], source);
  assert.equal(f.state.cellInspector, null);
  assert.equal(f.ui.closes, 1);
  assert.equal(f.refs.saveCell.disabled, false);
});

test('a rejected dialog save keeps the draft and reports the error without closing', async () => {
  const f = fixture();
  const context = f.capture();
  const inspector = { context, jsonInfo: null, jsonEditing: false };
  f.state.cellInspector = inspector;
  f.refs.cellValue.value = 'keep my draft';
  f.runtime.call = async () => { throw new Error('connection unavailable'); };
  await f.runtime.saveCellEdit();
  assert.equal(f.state.cellInspector, inspector);
  assert.equal(f.refs.cellValue.value, 'keep my draft');
  assert.equal(f.refs.cellFeedback.textContent, 'connection unavailable');
  assert.equal(f.ui.closes, 0);
  assert.equal(f.tab.result.rows[0], context.rowRef);
  assert.equal(f.refs.saveCell.disabled, false);
});

test('saving one cell preserves and rebases sibling drafts only for the same captured row and target', async () => {
  const f = fixture();
  const status = f.capture(0, 0);
  const json = f.capture(0, 2);
  const unrelated = f.capture(1, 2);
  const wrongTarget = { ...json, destination: 'different-target' };
  const oldRef = json.rowRef;
  f.runtime.resultGrid.updateCellEditContexts = (_rows, update) => {
    [status, json, unrelated, wrongTarget].forEach(context => update({ context }));
  };
  assert.equal(await f.runtime.commitCellValue(status, 'paid'), true);
  assert.equal(json.rowRef, f.tab.result.rows[0]);
  assert.notEqual(json.rowRef, oldRef);
  assert.equal(json.row[0], 'paid');
  assert.equal(wrongTarget.rowRef, oldRef);
  assert.equal(unrelated.rowRef, f.tab.result.rows[1]);
  assert.equal(await f.runtime.commitCellValue(json, '{"n":9007199254740995}'), true);
  assert.equal(f.tab.result.rows[0][0], 'paid');
  assert.equal(f.tab.result.rows[0][2], '{"n":9007199254740995}');
  assert.equal(f.calls.length, 2);
});

test('PostgreSQL boolean cell edits normalize saved local values to canonical booleans without affecting text columns', async () => {
  const f = fixture();
  f.tab.browse.columns.push({ name: 'enabled', dataType: 'boolean', nullable: true });
  f.tab.result.columns.push('enabled');
  f.tab.result.rows[0].push(true);
  f.tab.result.rows[1].push(false);
  assert.equal(await f.runtime.commitCellValue(f.capture(0, 4), 'false', false, { confirm: false }), true);
  assert.equal(f.tab.result.rows[0][4], false);
  assert.equal(await f.runtime.commitCellValue(f.capture(1, 4), 't', false, { confirm: false }), true);
  assert.equal(f.tab.result.rows[1][4], true);
  assert.equal(await f.runtime.commitCellValue(f.capture(0, 0), 't', false, { confirm: false }), true);
  assert.equal(f.tab.result.rows[0][0], 't');
});
