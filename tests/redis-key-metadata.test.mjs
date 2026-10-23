import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRedisKeyPage, redisPageKeyType } from '../src/redis-key-metadata.js';

test('Redis scan pages merge names and types without changing indices or duplicating SCAN keys', () => {
  const first = mergeRedisKeyPage({}, { keys: ['same', 'list'], keyTypes: { same: 'string', list: 'list' } }, true);
  const next = mergeRedisKeyPage(first, { keys: ['list', 'same', 'hash'], keyTypes: { list: 'none', same: 'hash', hash: 'hash' } });
  assert.deepEqual(next.keys, ['same', 'list', 'hash']);
  assert.equal(redisPageKeyType(next, 'same'), 'hash'); assert.equal(redisPageKeyType(next, 'list'), 'none');
  assert.equal(redisPageKeyType(first, 'same'), 'string');
});

test('refresh/ACL fallback cannot retain stale known types and old backend names still work', () => {
  const old = { keys: ['old', 'same'], keyTypes: new Map([['old', 'set'], ['same', 'hash']]) };
  const refreshed = mergeRedisKeyPage(old, { keys: ['same'] }, true);
  assert.deepEqual(refreshed.keys, ['same']); assert.equal(redisPageKeyType(refreshed, 'same'), undefined);
  const appended = mergeRedisKeyPage(old, { keys: ['same', 'new'] });
  assert.equal(redisPageKeyType(appended, 'same'), undefined); assert.equal(redisPageKeyType(appended, 'old'), 'set');
});

test('metadata for prototype-like and HTML-looking keys remains plain map data', () => {
  const page = mergeRedisKeyPage({}, JSON.parse('{"keys":["__proto__","<img>","empty"],"keyTypes":{"__proto__":"zset","<img>":"stream","other":"list","empty":null}}'), true);
  assert.equal(redisPageKeyType(page, '__proto__'), 'zset'); assert.equal(redisPageKeyType(page, '<img>'), 'stream');
  assert.equal(page.keyTypes.has('other'), false); assert.equal(redisPageKeyType(page, 'empty'), undefined);
});
