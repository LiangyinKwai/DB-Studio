import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeWorkspaceAttention } from '../src/workspace-attention.js';

const profiles = [{ id: 'pg', name: '开发环境', database: 'app' }, { id: 'mysql', name: '本地', database: 'warehouse' }];
const tab = (id, connectionId, database, extra = {}) => ({ id, title: id, connectionId, database, result: { rows: [] }, ...extra });

test('an empty workspace has no local drafts or database transactions', () => {
  assert.deepEqual(summarizeWorkspaceAttention(), { dirtyCount: 0, transactionCount: 0, draftEntries: [], transactionEntries: [] });
});

test('counts dirty and pending cell drafts across tables without combining their save scope', () => {
  const tabs = [tab('orders', 'pg', 'app'), tab('users', 'pg', 'app'), tab('clean', 'mysql', 'warehouse')];
  const drafts = new Map([
    [tabs[0].result.rows, [{ dirty: true }, { dirty: true, pending: true }, { dirty: false, pending: true }, { dirty: false }]],
    [tabs[1].result.rows, [{ dirty: true }]],
  ]);
  const summary = summarizeWorkspaceAttention({ tabs, profiles, getDrafts: rows => drafts.get(rows) });
  assert.equal(summary.dirtyCount, 4);
  assert.equal(summary.transactionCount, 0);
  assert.deepEqual(summary.draftEntries.map(entry => [entry.tabId, entry.dirtyCount]), [['orders', 3], ['users', 1]]);
  assert.equal(summary.draftEntries[0].connectionId, 'pg');
  assert.equal(summary.draftEntries[0].database, 'app');
});

test('shared row references are counted once, while distinct arrays with equal values remain separate', () => {
  const rows = [[1]], tabs = [tab('first', 'pg', 'app', { result: { rows } }), tab('duplicate', 'pg', 'app', { result: { rows } }), tab('different', 'pg', 'app', { result: { rows: [[1]] } }), { id: 'empty' }];
  let calls = 0;
  const summary = summarizeWorkspaceAttention({ tabs, getDrafts() { calls++; return [{ dirty: true }]; } });
  assert.equal(calls, 2);
  assert.equal(summary.dirtyCount, 2);
  assert.deepEqual(summary.draftEntries.map(entry => entry.tabId), ['first', 'different']);
});

test('local drafts and uncommitted database transactions are independent', () => {
  const tabs = [tab('orders', 'pg', 'app')];
  const transactionKeys = new Set(['pg\u0000app']);
  const summary = summarizeWorkspaceAttention({ tabs, profiles, transactionKeys, getDrafts: () => [{ dirty: true }] });
  assert.equal(summary.dirtyCount, 1);
  assert.equal(summary.transactionCount, 1);
  assert.deepEqual(summary.transactionEntries[0], { key: 'pg\u0000app', connectionId: 'pg', database: 'app', connectionName: '开发环境', tabId: 'orders' });
  const afterLocalSave = summarizeWorkspaceAttention({ tabs, profiles, transactionKeys });
  assert.equal(afterLocalSave.dirtyCount, 0);
  assert.equal(afterLocalSave.transactionCount, 1);
});

test('transaction navigation prefers a data/query tab over a structure-only tab for the same destination', () => {
  const tabs = [tab('ddl', 'pg', 'app', { structureOnly: true }), tab('other-db', 'pg', 'other'), tab('data', 'pg', 'app'), tab('other-connection', 'mysql', 'app')];
  const summary = summarizeWorkspaceAttention({ tabs, profiles, transactionKeys: ['pg\u0000app', 'pg\u0000other', 'mysql\u0000app'] });
  assert.deepEqual(summary.transactionEntries.map(entry => entry.tabId), ['data', 'other-db', 'other-connection']);
  const structureOnly = summarizeWorkspaceAttention({ tabs: tabs.slice(0, 1), profiles, transactionKeys: ['pg\u0000app'] });
  assert.equal(structureOnly.transactionEntries[0].tabId, 'ddl');
});

test('transactions survive closing all tabs and unknown connection profiles remain visible', () => {
  const summary = summarizeWorkspaceAttention({ profiles, transactionKeys: ['deleted\u0000old-db', 'pg\u0000app', 'deleted\u0000old-db'] });
  assert.equal(summary.transactionCount, 2);
  assert.deepEqual(summary.transactionEntries[0], { key: 'deleted\u0000old-db', connectionId: 'deleted', database: 'old-db', connectionName: 'deleted', tabId: null });
  assert.equal(summary.transactionEntries[1].tabId, null);
});

test('database matching follows browse, tab, then profile destination precedence without mutating inputs', () => {
  const tabs = [tab('browse', 'pg', 'wrong', { browse: { database: 'browse-db' } }), tab('profile', 'mysql', null)];
  const before = structuredClone({ tabs, profiles });
  const summary = summarizeWorkspaceAttention({ tabs, profiles, transactionKeys: ['pg\u0000browse-db', 'mysql\u0000warehouse'], getDrafts: () => [{ pending: true }] });
  assert.deepEqual(summary.transactionEntries.map(entry => entry.tabId), ['browse', 'profile']);
  assert.deepEqual(summary.draftEntries.map(entry => entry.database), ['browse-db', 'warehouse']);
  assert.deepEqual({ tabs, profiles }, before);
});
