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
