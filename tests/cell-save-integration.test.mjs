import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildCellUpdateSql, cellColumnName, getCellEditCapability, validateCellDraft } from '../src/cell-edit.js';
import { formatCellValue } from '../src/result-grid.js';

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
    saveCell: { disabled: false }, cellValue: { value: '', disabled: false },
    cellNull: { checked: false, disabled: false }, cellFeedback: { textContent: '' },
    cellModal: { close() { ui.closes++; } },
  };
  const sandbox = {
    state, refs,
    cellColumnName, getCellEditCapability, validateCellDraft, buildCellUpdateSql,
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
  f.runtime.call = async () => { throw new Error('database rejected value'); };
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
