import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCellUpdateSql, cellColumnName, getCellEditCapability, validateCellDraft } from '../src/cell-edit.js';

function tableTab() {
  return {
    connectionId: 'db-a', mode: 'write',
    browse: {
      connectionId: 'db-a', schema: 'public', name: 'accounts', kind: 'table', primaryKeys: ['id'],
      columns: [{ name: 'id', primaryKey: true, nullable: false, dataType: 'bigint' },
        { name: 'name', nullable: true, dataType: 'text' }],
    },
    result: { connectionId: 'db-a', executed: true, columns: ['name', 'id'], rows: [['Alice', '9007199254740993']] },
  };
}
const nameCell = { column: 'name', columnIndex: 0, rowIndex: 0 };
const update = (overrides = {}) => buildCellUpdateSql({
  schema: 'public', name: 'accounts', column: 'name', primaryKeys: ['id'],
  columns: ['name', 'id'], row: ['Alice', '9007199254740993'], value: 'Bob', ...overrides,
});

test('cell capability uses actual result columns and metadata for editable table cells', () => {
  const tab = tableTab();
  assert.deepEqual(getCellEditCapability(tab, nameCell), { editable: true, reason: '', allowNull: true, allowEmpty: true, dataType: 'text' });
  tab.browse.kind = 'partitioned_table';
  tab.result.columns = [{ name: 'name' }, { name: 'id' }];
  assert.equal(getCellEditCapability(tab, nameCell, 'mysql').editable, true);
  assert.equal(cellColumnName({ name: 'id' }), 'id');
  assert.equal(cellColumnName(undefined), '');
});

test('read-only, unloaded, stale, busy and unsupported results cannot edit', () => {
  const mutations = [
    tab => { tab.connectionId = null; },
    tab => { tab.mode = 'read'; },
    tab => { tab.result.executed = false; },
    tab => { tab.result.connectionId = 'db-b'; },
    tab => { tab.browse.connectionId = 'db-b'; },
    tab => { tab.result.rows = []; },
    tab => { tab.result.rows = [['Alice']]; },
    tab => { tab.result.rows[0][0] = undefined; },
    tab => { tab.result.columns = ['id', 'name']; },
    tab => { tab.browse = null; },
    ...['view', 'materialized_view', 'foreign_table'].map(kind => tab => { tab.browse.kind = kind; }),
    ...['running', 'refreshing', 'changingTransaction', 'confirming', 'resolvingTarget', 'cellSaving']
      .map(flag => tab => { tab[flag] = true; }),
  ];
  for (const mutate of mutations) {
    const tab = tableTab(); mutate(tab);
    const capability = getCellEditCapability(tab, nameCell);
    assert.equal(capability.editable, false, mutate.toString());
    assert.ok(capability.reason);
  }
  assert.equal(getCellEditCapability(tableTab(), nameCell, 'sqlite').editable, false);
  assert.equal(getCellEditCapability(tableTab(), { ...nameCell, rowIndex: -1 }).editable, false);
});

test('primary key values can edit but generated fields and incomplete primary keys cannot', () => {
  assert.equal(getCellEditCapability(tableTab(), { column: 'id', columnIndex: 1, rowIndex: 0 }).editable, true);
  const mutations = [
    tab => { tab.browse.columns[1].identity = true; },
    tab => { tab.browse.columns[1].generated = true; },
    tab => { tab.browse.columns[1].primaryKey = true; },
    tab => { tab.browse.columns = []; },
    tab => { tab.browse.primaryKeys = []; },
    tab => { tab.browse.primaryKeys = ['id', 'id']; },
    tab => { tab.browse.primaryKeys = ['missing']; },
    tab => { tab.result.columns = ['name', 'name']; },
    tab => { tab.result.rows[0][1] = null; },
    tab => { tab.result.rows[0][1] = Number.MAX_SAFE_INTEGER + 1; },
    tab => { tab.result.rows[0][1] = {}; },
  ];
  for (const mutate of mutations) {
    const tab = tableTab(); mutate(tab);
    assert.equal(getCellEditCapability(tab, nameCell).editable, false, mutate.toString());
  }
});

test('Redis permits values with safe type-specific identities and finite scores', () => {
  const tab = {
    connectionId: 'redis-a', mode: 'write', redisKey: '', redisType: 'hash',
    result: { executed: true, columns: ['value', 'field'], rows: [['old', '']] },
  };
  const cell = { column: 'value', columnIndex: 0, rowIndex: 0 };
  assert.deepEqual(getCellEditCapability(tab, cell, 'redis'), { editable: true, reason: '', allowNull: false, allowEmpty: true, dataType: '' });
  assert.equal(getCellEditCapability(tab, { column: 'field', columnIndex: 1, rowIndex: 0 }, 'redis').editable, false);
  tab.result.rows[0][1] = null;
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, false);
  tab.redisType = 'string'; tab.result.columns = ['value']; tab.result.rows = [['']];
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, true);
  tab.redisType = 'list';
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, false);
  tab.result.columns = ['value', 'index']; tab.result.rows = [['value', 0]];
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, true);
  tab.result.rows[0][1] = -1;
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, false);
  tab.redisType = 'zset'; tab.result.columns = ['score', 'member']; tab.result.rows = [['1', 'member']];
  const capability = getCellEditCapability(tab, { ...cell, column: 'score' }, 'redis');
  assert.equal(capability.editable, true);
  assert.equal(validateCellDraft('1.25e3', capability), '1.25e3');
  for (const value of ['', 'NaN', 'Infinity', '1e999']) assert.throws(() => validateCellDraft(value, capability), /有限数值/);
  tab.result.columns = ['value']; tab.result.rows = [['value']];
  tab.redisType = 'string'; tab.result.rows[0][0] = null;
  assert.equal(getCellEditCapability(tab, cell, 'redis').editable, false);
});

test('SQL update locates primary keys using result order and preserves precision', () => {
  assert.equal(update(), 'UPDATE "public"."accounts" SET "name" = E\'Bob\' WHERE "id" IS NOT DISTINCT FROM E\'9007199254740993\';');
  assert.equal(update({ columns: [{ name: 'name' }, { name: 'id' }] }), update());
  assert.equal(update({ primaryKeys: ['tenant', 'id'], columns: ['id', 'name', 'tenant'], row: ['001', 'Alice', 'foo'] }),
    'UPDATE "public"."accounts" SET "name" = E\'Bob\' WHERE "tenant" IS NOT DISTINCT FROM E\'foo\' AND "id" IS NOT DISTINCT FROM E\'001\';');
  assert.match(update({ row: ['Alice', 12] }), /WHERE "id" IS NOT DISTINCT FROM 12;/);
});

test('PostgreSQL SQL quotes names and values without losing whitespace, leading zeros or backslashes', () => {
  assert.equal(update({ schema: 'a"b', name: 't"x', column: 'na"me', columns: ['na"me', 'id'], value: "O'Reilly\\path\n中文" }),
    'UPDATE "a""b"."t""x" SET "na""me" = E\'O\'\'Reilly\\\\path\n中文\' WHERE "id" IS NOT DISTINCT FROM E\'9007199254740993\';');
  for (const text of ['', ' ', '\n', '001', 'true', 'NULL', '🙂']) {
    assert.ok(update({ value: text }).includes(` SET "name" = E'${text}' WHERE `));
  }
  assert.ok(update({ value: null }).includes(' SET "name" = NULL WHERE '));
  assert.throws(() => update({ value: 'x\0y' }), /空字符/);
});

test('MySQL SQL uses UTF-8 hex literals independent of string escape mode', () => {
  const value = "O'Reilly\\path\n001 中文🙂";
  assert.equal(update({ driver: 'mysql', schema: 'a`b', name: 't`x', value }),
    `UPDATE \`a\`\`b\`.\`t\`\`x\` SET \`name\` = CONVERT(X'${Buffer.from(value).toString('hex')}' USING utf8mb4) WHERE \`id\` <=> CONVERT(X'${Buffer.from('9007199254740993').toString('hex')}' USING utf8mb4);`);
  for (const text of ['', ' ', '001', 'true', '\0']) {
    assert.ok(update({ driver: 'mysql', value: text }).includes(`SET \`name\` = CONVERT(X'${Buffer.from(text).toString('hex')}' USING utf8mb4)`));
  }
  assert.ok(update({ driver: 'mysql', value: null }).includes('SET `name` = NULL'));
  assert.throws(() => update({ driver: 'mysql', value: '\ud800' }), /Unicode/);
});

test('SQL update refuses missing, NULL, duplicate, unsafe or ambiguous primary keys and targets', () => {
  for (const invalid of [
    { schema: '' }, { name: 'bad\0name' }, { column: '' }, { column: 'absent' }, { column: 'id', value: null },
    { primaryKeys: [] }, { primaryKeys: ['id', 'id'] }, { primaryKeys: ['missing'] },
    { row: ['Alice', null] }, { row: ['Alice', undefined] }, { row: ['Alice', {}] },
    { row: ['Alice', Number.MAX_SAFE_INTEGER + 1] }, { row: ['Alice', NaN] },
    { columns: ['name', 'id', 'id'], row: ['Alice', '1', '2'] },
    { columns: ['name', 'name', 'id'], row: ['Alice', 'Bob', '1'] },
    { row: ['Alice'] }, { value: undefined }, { value: 3 }, { driver: 'redis' },
  ]) assert.throws(() => update(invalid), JSON.stringify(invalid));
});

test('primary key values use the captured original key for WHERE, including composite keys', () => {
  assert.equal(update({ column: 'id', value: '9007199254740995' }), 'UPDATE "public"."accounts" SET "id" = E\'9007199254740995\' WHERE "id" IS NOT DISTINCT FROM E\'9007199254740993\';');
  assert.equal(update({ driver: 'mysql', column: 'tenant', primaryKeys: ['tenant', 'id'], columns: ['id', 'tenant', 'name'], row: ['001', 'old', 'Alice'], value: 'new' }),
    "UPDATE `public`.`accounts` SET `tenant` = CONVERT(X'6e6577' USING utf8mb4) WHERE `tenant` <=> CONVERT(X'6f6c64' USING utf8mb4) AND `id` <=> CONVERT(X'303031' USING utf8mb4);");
  const tab = tableTab(), cell = { column: 'id', columnIndex: 1, rowIndex: 0 };
  tab.browse.columns[0].identity = true;
  assert.equal(getCellEditCapability(tab, cell, 'mysql').editable, true);
  tab.browse.columns[0].identityGeneration = 'byDefault';
  assert.equal(getCellEditCapability(tab, cell).editable, true);
  tab.browse.columns[0].identityGeneration = 'always';
  assert.equal(getCellEditCapability(tab, cell).editable, false);
  tab.browse.columns[0].identity = false; tab.browse.columns[0].nullable = true;
  assert.equal(getCellEditCapability(tab, cell).allowNull, false);
});

test('draft validation preserves SQL NULL, empty text and raw JSON precision', () => {
  assert.equal(validateCellDraft(null, { allowNull: true }), null);
  assert.throws(() => validateCellDraft(null, { allowNull: false }), /NULL/);
  for (const value of ['', ' ', '001', 'true', 'NULL']) assert.equal(validateCellDraft(value), value);
  const json = ' { "id": 9007199254740993, "decimal": 12345678901234567890.123456789, "keep": "\\u4e2d" } ';
  assert.equal(validateCellDraft(json, { dataType: 'jsonb' }), json);
  assert.equal(validateCellDraft('null', { dataType: 'json', allowNull: false }), 'null');
  for (const dataType of ['json', 'JSONB', 'pg_catalog.jsonb']) {
    for (const value of ['', '{invalid}', '{"x": 1,}']) assert.throws(() => validateCellDraft(value, { dataType }), /JSON/);
  }
  assert.equal(validateCellDraft('{invalid}', { dataType: 'text' }), '{invalid}');
  assert.equal(validateCellDraft('{"x"}', { dataType: 'jsonb[]' }), '{"x"}');
});


test('empty string shortcut only applies to text fields and Redis text values', () => {
  const tab = tableTab();
  for (const [type, allowed] of [['text', true], ['character varying(50)', true], ['varchar(50)', true], ['jsonb', false], ['integer', false], ['timestamp without time zone', false], ['bytea', false]]) {
    tab.browse.columns.find(column => column.name === 'name').dataType = type;
    assert.equal(getCellEditCapability(tab, nameCell).allowEmpty, allowed, type);
  }
});
