import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonCellInfo } from '../src/cell-json.js';

test('JSON detail detection preserves original values and distinguishes SQL NULL', () => {
  assert.equal(jsonCellInfo(null, 'jsonb'), null);
  assert.equal(jsonCellInfo('', 'text'), null);
  assert.equal(jsonCellInfo('null', 'text'), null);
  assert.deepEqual(jsonCellInfo('null', 'jsonb'), { raw: 'null' });
  assert.deepEqual(jsonCellInfo(' [] ', 'text'), { raw: ' [] ' });
  assert.deepEqual(jsonCellInfo('{"id":9007199254740993}', 'text'), { raw: '{"id":9007199254740993}' });
  assert.equal(jsonCellInfo('{invalid', 'json'), null);
});

test('Redis Java long compatibility recognizes only valid object or array values without changing their source', () => {
  const options = { allowJavaLong: true };
  const source = '[{"dictCode":9007199254740993123L,"dictSort":-1L,"text":"6L \\\" 7L","nested":[0L]}]';
  assert.equal(jsonCellInfo(source, 'text'), null);
  assert.deepEqual(jsonCellInfo(source, 'text', options), { raw: source, compatible: true });
  assert.deepEqual(jsonCellInfo('{"text":"6L","id":1}', '', options), { raw: '{"text":"6L","id":1}' });
  for (const invalid of ['{"text":"6L"}', '{"id":01L}', '{"id":1.2L}', '{"id":1e2L}', '{"id":1L,}', '{"id":1L,"x":undefined}', '[1l]', '1L']) {
    const result = jsonCellInfo(invalid, '', options);
    if (invalid === '{"text":"6L"}') assert.deepEqual(result, { raw: invalid });
    else assert.equal(result, null, invalid);
  }
});
