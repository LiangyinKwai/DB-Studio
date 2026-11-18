import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('  refs.redisCreateForm.addEventListener("submit",');
const end = source.indexOf('  refs.closeRedisConsole?.addEventListener(', start);
assert.ok(start >= 0 && end > start);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const oldTab = { id: 'pg-tab', connectionId: 'pg', mode: 'write', result: { executed: true, rows: [['PG data']] } };
  const pending = { connectionId: 'redis', database: 7 };
  const state = { pendingRedisCreate: pending, tabs: [oldTab], activeTabId: oldTab.id, redisConsole: null,
    activeConnectionId: 'redis', redisActiveDatabase: 7, schemaRequest: 3, redisExpanded: new Set() };
  const calls = [], events = [], messages = [];
  let submit;
  const refs = {
    redisCreateForm: { addEventListener(_name, listener) { submit = listener; } },
    applyRedisCreate: { disabled: false }, redisCreateFeedback: { textContent: '' },
    redisCreateModal: { close() { events.push('close'); } },
    ...Object.fromEntries(Object.entries({ redisCreateKey: 'new:key', redisCreateType: 'string', redisCreateValue: 'new value',
      redisCreateField: '', redisCreateScore: '0', redisCreateTtl: '3600' }).map(([key, value]) => [key, { value }])),
  };
  const runtime = vm.createContext({
    refs, state,
    activeExecutionTab: () => state.redisConsole || state.tabs.find(tab => tab.id === state.activeTabId),
    redisTabDatabase: tab => tab.redisDb,
    call: async (command, args) => { calls.push({ command, args }); events.push('create'); },
    refreshRedisTree: async () => { events.push('refresh'); return true; },
    openRedisValueTab: async (key, database) => { events.push(['open', key, database]); return { result: { executed: true } }; },
    restoreRedisKeyResult: async tab => { events.push('restore'); tab.result = { executed: true, rows: [['new value']] }; },
    emptyResult: () => ({ executed: false, rows: [] }),
    resultGrid: { getCellEditDraft: () => null }, cellWritePending: () => false,
    showToast: (message, type) => messages.push({ message, type }), errorText: error => error.message,
  });
  vm.runInContext(source.slice(start, end), runtime, { filename: 'redis-create-flow.js' });
  return { state, refs, calls, events, messages, runtime, pending, submit: () => submit({ preventDefault() {} }) };
}

test('successful Redis creation refreshes then opens the captured Key even with a PG tab visible', async () => {
  const f = fixture();
  await f.submit();
  assert.deepEqual(f.events, ['create', 'close', 'refresh', ['open', 'new:key', 7]]);
  assert.equal(f.calls[0].args.request.connectionId, 'redis');
  assert.equal(f.calls[0].args.request.database, 7);
  assert.equal(f.state.pendingRedisCreate, null);
  assert.equal(f.state.redisExpanded.has(7), true);
  await f.submit();
  assert.equal(f.calls.length, 1, 'success must not leave an actionable CREATE form');
});

test('creation failures keep the draft and never refresh or open another view', async () => {
  const f = fixture();
  f.runtime.call = async () => { throw new Error('Key already exists'); };
  await f.submit();
  assert.equal(f.state.pendingRedisCreate, f.pending);
  assert.equal(f.refs.redisCreateFeedback.textContent, 'Key already exists');
  assert.equal(f.refs.applyRedisCreate.disabled, false);
  assert.deepEqual(f.events, []);
});

test('post-create refresh and read failures report success separately and never repeat CREATE', async () => {
  for (const failure of ['refresh', 'read', 'read-undefined', 'read-error-tab']) {
    const f = fixture();
    if (failure === 'refresh') f.runtime.refreshRedisTree = async () => { throw new Error('scan denied'); };
    if (failure === 'read') f.runtime.openRedisValueTab = async () => { throw new Error('read denied'); };
    if (failure === 'read-undefined') f.runtime.openRedisValueTab = async () => undefined;
    if (failure === 'read-error-tab') f.runtime.openRedisValueTab = async () => ({ error: true, result: { executed: false } });
    await f.submit();
    assert.equal(f.state.pendingRedisCreate, null);
    assert.equal(f.refs.redisCreateFeedback.textContent, '');
    assert.match(f.messages.at(-1).message, /已创建，但.*失败/);
    await f.submit();
    assert.equal(f.calls.length, 1);
  }
});

test('a tab, console, DB or connection switch during create or refresh cannot steal the new view', async () => {
  for (const phase of ['create', 'refresh']) {
    for (const change of [state => { state.activeTabId = 'other'; }, state => { state.redisConsole = { id: 'console' }; },
      state => { state.redisActiveDatabase = 8; }, state => { state.activeConnectionId = 'other'; }, state => { state.schemaRequest++; }]) {
      const f = fixture(), held = deferred(), entered = deferred();
      if (phase === 'create') f.runtime.call = async (command, args) => { f.calls.push({ command, args }); entered.resolve(); await held.promise; };
      else f.runtime.refreshRedisTree = async () => { entered.resolve(); await held.promise; return true; };
      const running = f.submit();
      await entered.promise;
      change(f.state);
      f.refs.redisCreateKey.value = 'changed-after-submit';
      held.resolve();
      await running;
      assert.equal(f.events.some(event => Array.isArray(event) && event[0] === 'open'), false);
      assert.equal(f.calls[0].args.request.key, 'new:key');
    }
  }
});

test('recreated Keys reload cached tabs while preserving unsaved drafts and pending writes', async () => {
  for (const protection of ['none', 'draft', 'write', 'refreshing']) {
    const f = fixture();
    const oldResult = { executed: true, rows: [['old value']] };
    const old = { id: 'old-key', connectionId: 'redis', redisKey: 'new:key', redisDb: 7, result: oldResult, gridState: { filter: 'old' } };
    f.state.tabs.push(old);
    if (protection === 'draft') f.runtime.resultGrid.getCellEditDraft = () => ({ dirty: true });
    if (protection === 'write') f.runtime.cellWritePending = () => true;
    if (protection === 'refreshing') old.refreshing = true;
    await f.submit();
    if (protection === 'none') {
      assert.notEqual(old.result, oldResult);
      assert.equal(old.result.executed, true);
      assert.deepEqual(old.result.rows, [['new value']]);
      assert.equal(old.gridState, null);
      assert.ok(f.events.indexOf('restore') < f.events.findIndex(event => Array.isArray(event) && event[0] === 'open'));
      assert.ok(f.events.some(event => Array.isArray(event) && event[0] === 'open'));
    } else {
      assert.equal(old.result, oldResult);
      assert.ok(!f.events.some(event => Array.isArray(event) && event[0] === 'open'));
      assert.match(f.messages.at(-1).message, /已创建.*未保存修改或操作/);
    }
  }
});

test('switching views while refreshing a recreated Key keeps its new result in the background', async () => {
  const f = fixture(), held = deferred(), entered = deferred();
  const old = { id: 'old-key', connectionId: 'redis', redisKey: 'new:key', redisDb: 7, result: { executed: true, rows: [['old']] } };
  f.state.tabs.push(old);
  f.runtime.restoreRedisKeyResult = async tab => { entered.resolve(); await held.promise; tab.result = { executed: true, rows: [['new']] }; };
  const saving = f.submit();
  await entered.promise;
  f.state.activeTabId = 'another-tab';
  held.resolve();
  await saving;
  assert.ok(!f.events.some(event => Array.isArray(event) && event[0] === 'open'));
  assert.deepEqual(old.result.rows, [['new']]);
});
