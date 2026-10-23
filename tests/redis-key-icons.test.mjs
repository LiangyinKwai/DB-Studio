import assert from 'node:assert/strict';
import test from 'node:test';
import { redisKeyIcon, redisKeyTypePresentation } from '../src/redis-key-icons.js';

test('each Redis core type has a distinct text badge and a readable type name', () => {
  const types = ['string', 'hash', 'list', 'set', 'zset', 'stream'];
  const shapes = new Set();
  for (const type of types) {
    const presentation = redisKeyTypePresentation(type);
    assert.equal(presentation.type, type);
    assert.match(presentation.label.toLowerCase(), new RegExp(`^${type} · `));
    assert.ok(presentation.description.length > 0);
    assert.match(presentation.icon, /role="img" aria-label="/);
    assert.ok(presentation.icon.includes(`>${type}</span>`));
    assert.equal(redisKeyIcon(type), presentation.icon);
    shapes.add(presentation.icon);
  }
  assert.equal(shapes.size, types.length);
});

test('Redis TYPE normalization preserves safe unknown, missing and module states', () => {
  assert.equal(redisKeyTypePresentation('  HASH ').type, 'hash');
  for (const type of [undefined, null, '', ' ', 0, {}, []]) {
    assert.equal(redisKeyTypePresentation(type).type, 'unknown');
  }
  for (const type of ['none', 'NONE', 'missing']) {
    assert.equal(redisKeyTypePresentation(type).type, 'missing');
  }
  for (const type of ['ReJSON-RL', 'TSDB-TYPE', '__proto__', 'constructor']) {
    assert.equal(redisKeyTypePresentation(type).type, 'module');
  }
});

test('untrusted Redis module names never enter badge markup or accessible attributes', () => {
  const maliciousType = '"><script>alert(1)</script><svg onload="alert(2)';
  const icon = redisKeyIcon(maliciousType);
  assert.equal(icon, redisKeyIcon('module'));
  assert.equal(icon.includes(maliciousType), false);
  assert.doesNotMatch(icon, /script|onload|alert/);
});

test('presentations are immutable and cannot contaminate later rows', () => {
  const presentation = redisKeyTypePresentation('hash');
  assert.ok(Object.isFrozen(presentation));
  assert.throws(() => { presentation.icon = '<script>'; }, TypeError);
  assert.equal(presentation, redisKeyTypePresentation('HASH'));
});
