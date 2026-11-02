import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionGroupStore, CONNECTION_GROUPS_KEY, normalizeConnectionGroups } from '../src/connection-groups.js';
const memory = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };
test('deleting a group keeps other assignments and restores its connections to ungrouped', () => {
  const storage = memory(), store = createConnectionGroupStore(storage);
  const production = store.add('生产'), personal = store.add('个人');
  store.move('pg', production); store.move('mysql', production); store.move('redis', personal);
  store.collapse(production, true); store.remove(production);
  const restored = createConnectionGroupStore(storage);
  assert.equal(restored.groupFor('pg'), ''); assert.equal(restored.groupFor('mysql'), '');
  assert.equal(restored.groupFor('redis'), personal); assert.deepEqual(restored.snapshot().collapsed, []);
  assert.equal(restored.snapshot().groups.length, 1);
});
test('renaming preserves group identity, assignments and collapsed state across restart', () => {
  const storage = memory(), store = createConnectionGroupStore(storage);
  const id = store.add('测试'); store.move('instance', id); store.collapse(id, true); store.rename(id, '生产');
  const restored = createConnectionGroupStore(storage);
  assert.equal(restored.groupFor('instance'), id); assert.deepEqual(restored.snapshot().groups, [{ id, name: '生产' }]);
  assert.deepEqual(restored.snapshot().collapsed, [id]);
  restored.move('instance', ''); assert.equal(restored.groupFor('instance'), '');
});
test('rejects duplicate names, missing groups and storage failures without changing in-memory state', () => {
  const storage = memory(), store = createConnectionGroupStore(storage);
  const id = store.add('Team'); store.move('instance', id);
  assert.throws(() => store.add(' team '), /同名/); assert.throws(() => store.add('  '));
  assert.throws(() => store.move('instance', 'missing')); assert.equal(store.groupFor('instance'), id);
  const before = store.snapshot(); storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.remove(id), /quota/); assert.deepEqual(store.snapshot(), before);
});
test('malformed stored groups discard dangling assignments without inventing connections', () => {
  assert.deepEqual(normalizeConnectionGroups({ groups: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, null], assignments: { pg: 'a', mysql: 'gone' }, collapsed: ['a', 'gone'] }), { groups: [{ id: 'a', name: 'A' }], assignments: { pg: 'a' }, collapsed: ['a'] });
  const storage = memory(); storage.setItem(CONNECTION_GROUPS_KEY, '{broken');
  assert.deepEqual(createConnectionGroupStore(storage).snapshot(), { groups: [], assignments: {}, collapsed: [] });
});
