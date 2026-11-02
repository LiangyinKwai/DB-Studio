import assert from 'node:assert/strict';
import test from 'node:test';
import { redisValueForCopy, redisTtlSummary, redisLocation } from '../src/redis-ui.js';

test('copy Redis values preserves exact string content and refuses partial or missing data', () => {
  for (const raw of ['', '  中文\r\n🙂 ', '{"id":9007199254740993}']) assert.equal(redisValueForCopy({ keyType: 'string', raw }), raw);
  assert.equal(redisValueForCopy({ keyType: 'hash', raw: ['field', 'value'] }), '[\n  "field",\n  "value"\n]');
  assert.throws(() => redisValueForCopy({ keyType: 'list', partial: true, raw: ['subset'] }), /部分内容/);
  assert.throws(() => redisValueForCopy({ keyType: 'none', raw: null }), /过期/);
});
test('Redis dialog target and TTL distinguish permanent, expired and unread metadata', () => {
  assert.equal(redisLocation({ connectionName: '开发', database: 15 }), '开发 · DB 15');
  assert.equal(redisTtlSummary(-1), '永久保留');
  assert.equal(redisTtlSummary(-2), 'Key 已不存在');
  assert.match(redisTtlSummary(600), /600 秒/);
  assert.match(redisTtlSummary(undefined), /尚未读取/);
});
