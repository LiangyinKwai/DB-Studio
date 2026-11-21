import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedObjectGroups, setTreeRowExpanded, syncTreeToggle } from '../src/object-tree.js';

test('schema group order is independent of the first alphabetically named object', () => {
  const sequence = { kind: 'sequence', name: 'a_id_seq' };
  const procedure = { kind: 'procedure', name: 'f' };
  const objects = [sequence, procedure, { kind: 'view', name: 'b_view' }, { kind: 'table', name: 'orders' }, { kind: 'table', name: 'users' }, { kind: 'function', name: 'f' }];
  const groups = orderedObjectGroups(objects);
  assert.deepEqual(groups.map(([kind]) => kind), ['table', 'view', 'routine', 'sequence']);
  assert.deepEqual(groups[0][1].map(item => item.name), ['orders', 'users']);
  assert.equal(objects[0], sequence);
  assert.deepEqual(groups[2][1].map(item => item.kind), ['function', 'procedure']);
  assert.deepEqual(orderedObjectGroups([...objects].reverse()).map(([kind]) => kind), groups.map(([kind]) => kind));
});

test('PostgreSQL does not include an empty sequence category', () => {
  const groups = orderedObjectGroups([{ kind: 'table', name: 'orders' }], { driver: 'postgres' });
  assert.deepEqual(groups.map(([kind]) => kind), ['table', 'view', 'materialized_view', 'routine']);
  assert.deepEqual(orderedObjectGroups([], { driver: 'postgres', searching: true }), []);
});

test('disclosure state updates native details and the accessible button without selecting a row', () => {
  const attributes = {};
  const button = { dataset: { treeLabel: 'public' }, setAttribute(name, value) { attributes[name] = value; } };
  const row = { parentElement: { open: false }, matches: value => value === 'summary', querySelector: () => button };
  assert.equal(setTreeRowExpanded(row, true), true);
  assert.equal(row.parentElement.open, true);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(attributes['aria-label'], '收起 public');
  setTreeRowExpanded(row, false);
  assert.equal(attributes['aria-label'], '展开 public');
  syncTreeToggle(row, true);
  assert.equal(attributes['aria-expanded'], 'true');
});

test('double click targets branches but excludes disclosure buttons and action buttons', async () => {
  const { treeBranchForDoubleClick } = await import('../src/object-tree.js');
  const branch = {};
  assert.equal(treeBranchForDoubleClick({ closest: selector => selector === 'summary, .category-summary' ? branch : null }), branch);
  assert.equal(treeBranchForDoubleClick({ closest: selector => selector === 'button, input, a' ? {} : branch }), null);
  assert.equal(treeBranchForDoubleClick({ closest: () => null }), null);
});
