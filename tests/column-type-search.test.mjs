import test from 'node:test';
import assert from 'node:assert/strict';
import { searchColumnTypes } from '../src/structure-editor.js';

test('exact MySQL type names outrank types that merely contain the same word', () => {
  for (const type of ['int', 'text', 'bigint', 'boolean', 'json']) {
    assert.equal(searchColumnTypes('mysql', type)[0].value, type);
    assert.equal(searchColumnTypes('mysql', `  ${type.toUpperCase()}  `)[0].value, type);
  }
  const text = searchColumnTypes('mysql', 'text').map(option => option.value);
  assert.ok(text.indexOf('text') < text.indexOf('tinytext'));
});

test('PostgreSQL exact names and aliases select the intended integer type', () => {
  assert.equal(searchColumnTypes('postgres', 'integer')[0].value, 'integer');
  assert.equal(searchColumnTypes('postgres', 'int')[0].value, 'integer');
  assert.equal(searchColumnTypes('postgres', 'int4')[0].value, 'integer');
  assert.equal(searchColumnTypes('postgres', 'int8')[0].value, 'bigint');
  assert.equal(searchColumnTypes('postgres', 'timestamptz')[0].value, 'timestamp with time zone');
  assert.equal(searchColumnTypes('postgres', '  TIMESTAMP   WITH   TIME ZONE ')[0].value, 'timestamp with time zone');
});

test('completed length and precision input survives selecting the first result', () => {
  assert.equal(searchColumnTypes('postgres', 'numeric(18,4)')[0].value, 'numeric(18,4)');
  assert.equal(searchColumnTypes('postgres', ' numeric ( 38 , 17 ) ')[0].value, 'numeric(38,17)');
  assert.equal(searchColumnTypes('postgres', 'varchar(512)')[0].value, 'varchar(512)');
  assert.equal(searchColumnTypes('mysql', 'DECIMAL(20,6) unsigned')[0].value, 'DECIMAL(20,6) unsigned');
  assert.equal(searchColumnTypes('postgres', 'numeric')[0].value, 'numeric');
});

test('prefix and alias matches precede fuzzy contains while Chinese categories remain stable', () => {
  assert.equal(searchColumnTypes('mysql', 'var')[0].value, 'varchar(255)');
  assert.equal(searchColumnTypes('postgres', 'double')[0].value, 'double precision');
  assert.deepEqual(searchColumnTypes('postgres', '文本').map(option => option.value), ['varchar(255)', 'character(1)', 'text', 'json', 'text[]']);
  assert.equal(searchColumnTypes('postgres', 'private.custom_type').length, 0);
});

test('empty searches retain the explicit common-type order', () => {
  assert.deepEqual(searchColumnTypes('mysql', '', { commonFirst: true }).slice(0, 8).map(option => option.value), ['bigint', 'int', 'varchar(255)', 'decimal(12,2)', 'boolean', 'datetime', 'json', 'text']);
});
