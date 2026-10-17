import test from 'node:test';
import assert from 'node:assert/strict';
import { redisCommandCandidates, redisCommandHint, redisCompletionSource, quoteRedisArgument } from '../src/redis-completion.js';

test('Redis commands match case-insensitive prefixes without completing key arguments', () => {
  assert.ok(redisCommandCandidates('  hg').some(item => item.label === 'HGET'));
  assert.deepEqual(redisCommandCandidates('GET user'), []);
  assert.deepEqual(redisCommandCandidates('SET "a b" '), []);
  assert.ok(redisCommandCandidates('PING\nza').some(item => item.label === 'ZADD'));
  assert.ok(redisCommandCandidates('GET ignored', 2).some(item => item.label === 'GET'));
});
test('Redis command help shows signatures for command arguments', () => {
  assert.match(redisCommandHint('hset users:1 '), /HSET key field value/);
  assert.match(redisCommandHint('SET '), /NX\|XX/);
  assert.equal(redisCommandHint('UNKNOWN x'), '');
});

const context = text => ({ pos: text.length, explicit: false, state: { doc: { lineAt: () => ({ from: 0 }) }, sliceDoc: (from, to) => text.slice(from, to) } });
test('Redis editor completes keys in key position and avoids hash field/value positions', () => {
  const result = redisCompletionSource(context('GET user'), ['user:1', 'user:1', 'user 2']);
  assert.deepEqual(result.options.map(item => item.label), ['user:1', 'user 2']);
  assert.equal(result.options[1].apply, '"user 2"');
  assert.equal(redisCompletionSource(context('HSET user:1 field'), ['field']), null);
  assert.equal(redisCompletionSource(context('SCAN 0'), ['0']), null);
  assert.equal(redisCompletionSource(context(''), []), null);
});
test('Redis key quoting preserves control characters rather than converting them to literal escapes', () => {
  assert.equal(quoteRedisArgument('key\nnext'), '"key\nnext"');
  assert.equal(quoteRedisArgument('simple:key'), 'simple:key');
  assert.equal(quoteRedisArgument('a"b'), '"a\\"b"');
});
