import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutineEdit, chooseMysqlDelimiter, parseRoutineHeader, stripRoutineDefiner } from '../src/routine-ddl.js';

const quote = { postgres: name => `"${name.replaceAll('"', '""')}"`, mysql: name => `\`${name.replaceAll('`', '``')}\`` };
const pgOriginal = 'CREATE OR REPLACE FUNCTION public.order_total(order_id integer, tax numeric DEFAULT 0.1)\n RETURNS numeric\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RETURN 1;\nEND;\n$function$\n';
const mysqlOriginal = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `recount`(IN value bigint, OUT result int)\nBEGIN\n  SET result = value;\n  SELECT result;\nEND';
const pg = (edited, extra = {}) => buildRoutineEdit({ driver: 'postgres', kind: 'function', schema: 'public', name: 'order_total', original: pgOriginal, edited, quoteIdentifier: quote.postgres, ...extra });
const mysql = (edited, extra = {}) => buildRoutineEdit({ driver: 'mysql', kind: 'procedure', schema: 'warehouse', name: 'recount', original: mysqlOriginal, edited, quoteIdentifier: quote.mysql, ...extra });

test('reads routine headers from PostgreSQL and MySQL definitions', () => {
  const pgHeader = parseRoutineHeader(pgOriginal);
  assert.deepEqual([pgHeader.kind, pgHeader.orReplace, pgHeader.qualifier.text, pgHeader.name.text], ['function', true, 'public', 'order_total']);
  assert.equal(pgHeader.params, 'order_id integer,tax numeric default 0.1');
  const mysqlHeader = parseRoutineHeader(`-- keep\n/* note */\n${mysqlOriginal}`);
  assert.deepEqual([mysqlHeader.kind, mysqlHeader.orReplace, mysqlHeader.qualifier, mysqlHeader.name], ['procedure', false, null, { text: 'recount', quoted: true }]);
  assert.equal(parseRoutineHeader('SELECT 1'), null);
  assert.equal(parseRoutineHeader('CREATE TABLE t (id int)'), null);
  assert.equal(parseRoutineHeader('CREATE FUNCTION f('), null);
});

test('parameter text ignores quoting and formatting, not content', () => {
  const header = sql => parseRoutineHeader(sql).params;
  assert.equal(header('CREATE FUNCTION f( a int ,\n  b text )'), header('CREATE FUNCTION f(a int, b text)'));
  assert.notEqual(header('CREATE FUNCTION f(a int)'), header('CREATE FUNCTION f(a bigint)'));
  assert.equal(header("CREATE FUNCTION f(a text DEFAULT ')')"), "a text default ')'");
});

test('PostgreSQL saves as one CREATE OR REPLACE statement', () => {
  const plan = pg(pgOriginal.replace('RETURN 1', 'RETURN 2'));
  assert.equal(plan.singleStatement, true);
  assert.ok(plan.sql.endsWith('$function$;'));
  assert.match(plan.sql, /RETURN 2/);
  assert.equal(plan.sql, plan.preview);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.restore, []);
});

test('PostgreSQL warns when the edit creates a different object instead of replacing', () => {
  assert.match(pg(pgOriginal.replace('order_id integer', 'order_id bigint')).warnings[0], /参数列表已改变.*重载/);
  assert.match(pg(pgOriginal.replace('order_total', 'order_sum')).warnings[0], /名称或 schema 已改变/);
  assert.match(pg(pgOriginal.replace('public.order_total', 'archive.order_total')).warnings[0], /名称或 schema 已改变/);
  assert.match(pg(pgOriginal.replace('CREATE OR REPLACE', 'CREATE')).warnings[0], /缺少 OR REPLACE/);
  // Reformatting the parameter list or quoting the same name is not a change.
  assert.deepEqual(pg(pgOriginal.replace('(order_id integer, tax numeric DEFAULT 0.1)', '(\n  order_id integer,\n  tax numeric DEFAULT 0.1\n)').replace('public.order_total', 'public."order_total"')).warnings, []);
  assert.match(pg(pgOriginal.replace('public.order_total', '"Order_Total"')).warnings[0], /名称或 schema 已改变/);
});

test('MySQL drops and recreates inside one DELIMITER script', () => {
  const plan = mysql(`${mysqlOriginal.replace('SET result = value', 'SET result = value + 1')};`);
  assert.equal(plan.singleStatement, false);
  assert.equal(plan.sql, `DELIMITER $$\nDROP PROCEDURE IF EXISTS \`warehouse\`.\`recount\`$$\n${mysqlOriginal.replace('SET result = value', 'SET result = value + 1')}$$\nDELIMITER ;`);
  assert.equal(plan.preview.split('\n')[0], 'DROP PROCEDURE IF EXISTS `warehouse`.`recount`;');
  assert.ok(plan.preview.endsWith('END;'));
  assert.deepEqual(plan.warnings, []);
});

test('MySQL picks a delimiter that the body does not contain', () => {
  assert.equal(chooseMysqlDelimiter('SELECT 1'), '$$');
  assert.equal(chooseMysqlDelimiter("SELECT '$$'"), '//');
  assert.equal(chooseMysqlDelimiter('$$ // %% @@ ~~ ^^ !!'), null);
  // A replacer function keeps "$$" literal; a replacement string would collapse it to "$".
  const withBody = text => mysqlOriginal.replace('SELECT result', () => text);
  const plan = mysql(withBody("SELECT '$$'"));
  assert.match(plan.sql, /^DELIMITER \/\/\nDROP PROCEDURE IF EXISTS `warehouse`\.`recount`\/\/\n/);
  assert.ok(plan.sql.endsWith("SELECT '$$';\nEND//\nDELIMITER ;"));
  assert.throws(() => mysql(withBody("SELECT '$$ // %% @@ ~~ ^^ !!'")), /分隔符/);
});

test('MySQL keeps the original definition available to restore after a failed CREATE', () => {
  const plan = mysql(mysqlOriginal);
  assert.equal(plan.restore.length, 2);
  assert.match(plan.restore[0], /^DELIMITER \$\$\nCREATE DEFINER=`root`@`localhost` PROCEDURE `recount`/);
  assert.doesNotMatch(plan.restore[0], /DROP/);
  // The fallback drops DEFINER so a user without SET_USER_ID can still get the routine back.
  assert.match(plan.restore[1], /^DELIMITER \$\$\nCREATE PROCEDURE `recount`/);
  assert.equal(stripRoutineDefiner('CREATE DEFINER = CURRENT_USER() FUNCTION f() RETURNS int RETURN 1'), 'CREATE FUNCTION f() RETURNS int RETURN 1');
  assert.equal(mysql(mysqlOriginal, { original: 'CREATE PROCEDURE `recount`() SELECT 1' }).restore.length, 1);
});

test('MySQL warns about renames and cross-database targets', () => {
  assert.match(mysql(mysqlOriginal.replace('`recount`', '`recount_v2`')).warnings[0], /名称已改变.*recount 会被删除/);
  assert.match(mysql(mysqlOriginal.replace('`recount`', '`other`.`recount`')).warnings[0], /另一个数据库：other/);
  assert.deepEqual(mysql(mysqlOriginal.replace('`recount`', '`WAREHOUSE`.`RECOUNT`')).warnings, []);
});

test('rejects text that cannot be a routine definition', () => {
  assert.throws(() => pg('  '), /CREATE/);
  assert.throws(() => pg('SELECT 1'), /以 CREATE FUNCTION 名称/);
  assert.throws(() => pg('CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$'), /不能改成存储过程/);
  assert.throws(() => mysql('CREATE FUNCTION f() RETURNS int RETURN 1'), /不能改成函数/);
  assert.throws(() => mysql(`DELIMITER $$\n${mysqlOriginal}$$`), /无需编写 DELIMITER/);
  assert.throws(() => buildRoutineEdit({ driver: 'redis', kind: 'function', schema: 's', name: 'n', original: '', edited: 'x', quoteIdentifier: String }), /不支持/);
});
