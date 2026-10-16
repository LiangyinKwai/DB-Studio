import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyResultAction, runEmptyResultAction } from '../src/workspace-ux.js';

function dispatch(tab) {
  const calls = [];
  const actions = Object.fromEntries(['stop', 'message', 'connect', 'tableSql', 'refresh', 'editor'].map(action => [action, () => calls.push(action)]));
  runEmptyResultAction(tab, actions);
  return calls;
}
const browse = { connectionId: 'pg', browse: { database: 'shop', schema: 'sales', name: 'orders' }, tableView: true };

test('idle table browser opens a SQL tab instead of focusing its hidden editor', () => {
  assert.equal(emptyResultAction(browse).label, '打开 SQL 编辑器');
  assert.deepEqual(dispatch(browse), ['tableSql']);
  assert.deepEqual(dispatch({ ...browse, tableView: undefined }), ['tableSql']);
  assert.deepEqual(dispatch({ ...browse, tableView: false }), ['editor']);
});

test('Redis value browser reloads the key without assuming its type is a string', () => {
  for (const redisKey of ['hash:profile', 'list:queue', 'stream:events']) {
    const tab = { connectionId: 'redis', redisKey, tableView: true };
    assert.equal(emptyResultAction(tab).label, '加载 Key 数据');
    assert.deepEqual(dispatch(tab), ['refresh']);
  }
});

test('execution, errors and connection selection take priority over object navigation', () => {
  assert.deepEqual(dispatch({ ...browse, running: true }), ['stop']);
  assert.deepEqual(dispatch({ ...browse, error: true }), ['message']);
  assert.deepEqual(dispatch({ ...browse, connectionId: null }), ['connect']);
  assert.deepEqual(dispatch({ connectionId: 'pg' }), ['editor']);
  for (const pending of ['refreshing', 'resolvingTarget', 'confirming', 'opening']) {
    assert.equal(emptyResultAction({ ...browse, [pending]: true }).disabled, true);
    assert.deepEqual(dispatch({ ...browse, [pending]: true }), []);
  }
});
