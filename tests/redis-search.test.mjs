import test from 'node:test';
import assert from 'node:assert/strict';
import { redisKeySearchPattern, redisKeyMatchesSearch } from '../src/redis-search.js';

test('Redis key search treats spaces and MATCH metacharacters as literal names', () => {
  assert.equal(redisKeySearchPattern(''), '');
  assert.equal(redisKeySearchPattern('user:15'), '*user:15*');
  assert.equal(redisKeySearchPattern('A*[x]?\\ '), '*A\\*\\[x\\]\\?\\\\ *');
  assert.equal(redisKeySearchPattern(' 中文 '), '* 中文 *');
});
test('local key filtering matches case-sensitive server substring search', () => {
  assert.equal(redisKeyMatchesSearch('prefix:User:*[1]', 'User:*['), true);
  assert.equal(redisKeyMatchesSearch('prefix:User:*[1]', 'user:'), false);
  assert.equal(redisKeyMatchesSearch('name with spaces ', 'spaces '), true);
  assert.equal(redisKeyMatchesSearch('any-key', ''), true);
});

test('global search bounds concurrency and does not start queued DBs after cancellation', async () => {
  const { searchRedisDatabases } = await import('../src/redis-search.js');
  const started = [], release = []; let valid = true, running = 0, peak = 0;
  const pending = searchRedisDatabases([0, 1, 2, 3, 4, 5], async database => {
    started.push(database); running++; peak = Math.max(peak, running);
    await new Promise(resolve => release.push(resolve)); running--;
  }, () => valid, 3);
  await Promise.resolve(); assert.equal(started.length, 3);
  valid = false; release.forEach(done => done()); await pending;
  assert.equal(peak, 3); assert.deepEqual(started, [0, 1, 2]);
});
