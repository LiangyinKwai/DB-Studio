import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTION_ORDER_KEY, moveConnection, orderConnections, readConnectionOrder, saveConnectionOrder } from '../src/connection-order.js';

const profiles = ['pg', 'mysql', 'redis', 'staging'].map(id => ({ id, name: id }));
test('stored instance order ignores deleted/duplicate ids and appends new instances stably', () => {
  const sorted = orderConnections(profiles, ['redis', 'deleted', 'mysql', 'redis']);
  assert.deepEqual(sorted.map(profile => profile.id), ['redis', 'mysql', 'pg', 'staging']);
  assert.equal(sorted[0], profiles[2]);
  assert.deepEqual(profiles.map(profile => profile.id), ['pg', 'mysql', 'redis', 'staging']);
  assert.deepEqual(orderConnections(profiles, null), profiles);
});
test('moving instances keeps every hidden profile and never changes profile or connection identities', () => {
  assert.deepEqual(moveConnection(profiles, 'staging', 'mysql', 'before').map(profile => profile.id), ['pg', 'staging', 'mysql', 'redis']);
  assert.deepEqual(moveConnection(profiles, 'pg', 'redis', 'after').map(profile => profile.id), ['mysql', 'redis', 'pg', 'staging']);
  assert.deepEqual(moveConnection(profiles, 'missing', 'mysql'), profiles);
  assert.deepEqual(moveConnection(profiles, 'mysql', 'mysql'), profiles);
});
test('order preferences persist ids only and survive malformed/unavailable storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(saveConnectionOrder(profiles, storage), true);
  assert.equal(values.get(CONNECTION_ORDER_KEY), '["pg","mysql","redis","staging"]');
  assert.deepEqual(readConnectionOrder(storage), profiles.map(profile => profile.id));
  values.set(CONNECTION_ORDER_KEY, '{bad'); assert.deepEqual(readConnectionOrder(storage), []);
  values.set(CONNECTION_ORDER_KEY, '{}'); assert.deepEqual(readConnectionOrder(storage), []);
  assert.equal(saveConnectionOrder(profiles, { setItem() { throw new Error('quota'); } }), false);
});
