import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultSql, getTypeParameters, isIdentityType, updateTypeParameters } from '../src/create-table-fields.js';
import { buildCreateTablePlan } from '../src/structure-editor.js';

const tableSql = (defaultValue, driver = 'postgres', dataType = 'varchar(255)') => buildCreateTablePlan(
  { schema: 'app', name: 'values' },
  [{ name: 'value', dataType, nullable: true, identity: false, primaryKey: false, defaultValue, comment: '' }], driver,
).sql;

test('type controls expose string parameters and preserve type spelling and suffixes', () => {
  assert.deepEqual(getTypeParameters('VARCHAR(64)'), { kind: 'length', base: 'VARCHAR', length: '64', suffix: '' });
  assert.deepEqual(getTypeParameters('Decimal ( 38 , 18 ) UNSIGNED ZEROFILL'), { kind: 'decimal', base: 'Decimal', precision: '38', scale: '18', suffix: ' UNSIGNED ZEROFILL' });
  assert.deepEqual(getTypeParameters('numeric'), { kind: 'decimal', base: 'numeric', precision: '', scale: '', suffix: '' });
  assert.equal(updateTypeParameters('VARCHAR(64)', { length: '128' }), 'VARCHAR(128)');
  assert.equal(updateTypeParameters('Decimal(38,18) UNSIGNED ZEROFILL', { scale: '0' }), 'Decimal(38,0) UNSIGNED ZEROFILL');
  assert.equal(updateTypeParameters('numeric(12,2)', { precision: '38', scale: '18' }), 'numeric(38,18)');
  assert.equal(updateTypeParameters('numeric(3,2)', { scale: '5' }), 'numeric(3,5)');
  assert.equal(updateTypeParameters('numeric(12,2)', { scale: '' }), 'numeric(12)');
  for (const base of ['char', 'varchar', 'binary', 'varbinary', 'character', 'character varying']) {
    assert.equal(updateTypeParameters(`${base}(16)`, { length: '32' }), `${base}(32)`);
  }
  assert.equal(updateTypeParameters('varchar(64) BINARY', { length: '128' }), 'varchar(128) BINARY');
});

test('type controls never reinterpret custom, array, enum or advanced temporal types', () => {
  for (const type of ['app.numeric(12,2)', '"app"."type"', 'numeric(12,2)[]', 'varchar(64)[]', "enum('a,b','c''d')", "set('read','write')", 'timestamp(6)', 'numeric(12,-2)', 'varchar(12,2)', 'numeric(12) DEFAULT 0']) {
    assert.equal(getTypeParameters(type), null, type);
    assert.equal(updateTypeParameters(type, { length: '7', precision: '7', scale: '3' }), type);
  }
});

test('required parameter edits remain invalid until complete instead of restoring defaults', () => {
  for (const length of ['', ' ', '0', '-1', '1.5', '2); DROP TABLE t', '1e3']) {
    assert.throws(() => updateTypeParameters('varchar(64)', { length }), /长度/);
  }
  for (const precision of ['', '0', '-1', '1.5']) assert.throws(() => updateTypeParameters('decimal(12,2)', { precision }), /精度/);
  for (const scale of ['-1', '1.5', '0); DROP TABLE t']) assert.throws(() => updateTypeParameters('decimal(12,2)', { scale }), /小数位/);
});

test('default controls keep no default, empty text, NULL and text NULL distinct', () => {
  for (const driver of ['postgres', 'mysql']) {
    assert.equal(createDefaultSql('none', 'ignored', driver), '');
    assert.equal(createDefaultSql('text', '', driver), "''");
    assert.equal(createDefaultSql('null', '', driver), 'NULL');
    assert.equal(createDefaultSql('text', 'NULL', driver), "'NULL'");
    assert.equal(createDefaultSql('text', '  value\n ', driver), "'  value\n '");
    const outputs = ['none', 'text', 'null'].map(mode => tableSql(createDefaultSql(mode, '', driver), driver));
    assert.ok(!outputs[0].includes('DEFAULT'));
    assert.match(outputs[1], /DEFAULT \(?''\)?/);
    assert.match(outputs[2], /DEFAULT \(?NULL\)?/);
    assert.match(tableSql(createDefaultSql('text', 'NULL', driver), driver), /DEFAULT \(?'NULL'\)?/);
    assert.equal(new Set(outputs).size, 3);
  }
});

test('expression defaults remain exact SQL strings for zero, false and precise numbers', () => {
  for (const driver of ['postgres', 'mysql']) {
    for (const expression of ['0', 'false', '9007199254740993123456789', '0.12345678901234567890123456789', 'CURRENT_TIMESTAMP', "'{}'", '(1 + 2)']) {
      assert.equal(createDefaultSql('expression', ` ${expression} `, driver), expression);
      assert.ok(tableSql(createDefaultSql('expression', expression, driver), driver).includes(expression));
    }
    assert.equal(createDefaultSql('expression', 0, driver), '0');
    assert.equal(createDefaultSql('expression', false, driver), 'false');
    assert.throws(() => createDefaultSql('expression', ' ', driver), /表达式/);
    assert.throws(() => tableSql(createDefaultSql('expression', '0); DROP TABLE users;', driver), driver), /默认值/);
  }
});

test('text defaults quote SQL-looking contents as one literal in both drivers', () => {
  const text = "  世界😀 O'Reilly'); DROP TABLE users; -- $x  ";
  const literal = `'${text.replaceAll("'", "''")}'`;
  for (const driver of ['postgres', 'mysql']) {
    assert.equal(createDefaultSql('text', text, driver), literal);
    assert.ok(tableSql(literal, driver).includes(literal));
  }
});

test('backslash text uses exact UTF-8 hex expressions accepted by the existing DDL validator', () => {
  const text = "  C:\\数据\\😀\\''); DROP TABLE x; --\n";
  const hex = Buffer.from(text, 'utf8').toString('hex');
  const pg = createDefaultSql('text', text, 'postgres');
  const mysql = createDefaultSql('text', text, 'mysql');
  assert.equal(pg, `convert_from(decode('${hex}', 'hex'), 'UTF8')`);
  assert.equal(mysql, `CONVERT(X'${hex}' USING utf8mb4)`);
  assert.ok(tableSql(pg).includes(`DEFAULT (${pg})`));
  assert.ok(tableSql(mysql, 'mysql').includes(`DEFAULT (${mysql})`));
  assert.equal(Buffer.from(pg.match(/decode\('([^']+)'/)[1], 'hex').toString('utf8'), text);
  assert.equal(Buffer.from(mysql.match(/X'([^']+)'/)[1], 'hex').toString('utf8'), text);
});

test('invalid Unicode and NUL are rejected before UTF-8 encoding or SQL generation', () => {
  for (const value of ['a\0b', '\ud800', '\udfff', 'x\ud800y', '\ud800\ud800', '\udfff\ud800']) {
    for (const driver of ['postgres', 'mysql']) {
      for (const mode of ['text', 'expression']) assert.throws(() => createDefaultSql(mode, value, driver), /空字符|Unicode/);
    }
  }
  assert.equal(createDefaultSql('text', '😀'), "'😀'");
  assert.throws(() => createDefaultSql('unexpected', 'x'), /模式/);
  assert.throws(() => createDefaultSql('text', 'x', 'redis'), /驱动/);
});

test('MySQL expression-only types retain required parentheses', () => {
  for (const type of ['text', 'blob', 'json']) {
    const value = createDefaultSql('text', '{}', 'mysql');
    assert.match(tableSql(value, 'mysql', type), /DEFAULT \('\{\}'\)/);
  }
  assert.match(tableSql(createDefaultSql('expression', 'CURRENT_TIMESTAMP', 'mysql'), 'mysql', 'timestamp'), /DEFAULT CURRENT_TIMESTAMP/);
});

test('identity type controls agree with CREATE TABLE validation for both drivers', () => {
  for (const driver of ['postgres', 'mysql']) {
    for (const type of ['smallint', 'integer', 'int', 'bigint', 'tinyint', 'mediumint', 'int(11)', 'BIGINT UNSIGNED', 'varchar(64)', 'numeric(12,0)', 'int[]', 'app.integer', 'int8', 'bigint zerofill']) {
      const identity = isIdentityType(type, driver);
      const build = () => buildCreateTablePlan({ schema: 'app', name: 'items' }, [{ name: 'id', dataType: type, nullable: false, identity: true, primaryKey: true, defaultValue: '', comment: '' }], driver);
      if (identity) assert.match(build().sql, driver === 'mysql' ? /AUTO_INCREMENT/ : /GENERATED BY DEFAULT AS IDENTITY/);
      else assert.throws(build, /整数/);
    }
  }
  assert.equal(isIdentityType('bigint', 'redis'), false);
});

test('parameter helpers preserve their SQL meaning through CREATE TABLE generation', () => {
  assert.match(tableSql('', 'postgres', updateTypeParameters('numeric(12,2)', { precision: '38', scale: '18' })), /numeric\(38,18\)/);
  assert.match(tableSql('', 'mysql', updateTypeParameters('decimal(12,2) unsigned', { precision: '38', scale: '18' })), /decimal\(38,18\) unsigned/);
  assert.match(tableSql('', 'postgres', updateTypeParameters('varchar(64)', { length: '128' })), /varchar\(128\)/);
});
