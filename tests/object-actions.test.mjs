import test from 'node:test';
import assert from 'node:assert/strict';
import { objectActionPlan } from '../src/object-actions.js';

test('direct database/schema creation quotes the exact name and binds an existing database', () => {
  const target = { connectionId: 'db', database: 'existing', schema: 'public' };
  assert.deepEqual(objectActionPlan(target, 'create-database', ' new"db '), { name: 'new"db', database: 'existing', schema: null, sql: 'CREATE DATABASE "new""db";', label: '创建数据库', success: '数据库 new"db 已创建' });
  assert.equal(objectActionPlan(target, 'create-schema', 'new"schema').sql, 'CREATE SCHEMA "new""schema";');
  assert.equal(objectActionPlan({}, 'create-database', 'new`db', 'mysql').sql, 'CREATE DATABASE `new``db`;');
  assert.throws(() => objectActionPlan(target, 'create-schema', 'new', 'mysql'), /不支持/);
});

test('direct table rename stays in the original database and schema in each dialect', () => {
  const target = { database: 'unrelated', object: { database: 'actual', schema: 'sales', name: 'old', kind: 'table' } };
  const pg = objectActionPlan(target, 'rename-table', 'new"name');
  assert.equal(pg.database, 'actual'); assert.equal(pg.sql, 'ALTER TABLE "sales"."old" RENAME TO "new""name";');
  assert.equal(objectActionPlan(target, 'rename-table', 'new`name', 'mysql').sql, 'RENAME TABLE `sales`.`old` TO `sales`.`new``name`;');
  assert.throws(() => objectActionPlan(target, 'rename-table', 'old'), /不同/);
});

test('direct DDL rejects invalid or truncated names before sending a write', () => {
  for (const name of ['', '  ', 'a\0b', 'a'.repeat(64)]) assert.throws(() => objectActionPlan({}, 'create-database', name));
  for (const name of ['a.b', 'a/b', 'a\\b', 'a'.repeat(65), '🐬']) assert.throws(() => objectActionPlan({}, 'create-database', name, 'mysql'));
  assert.throws(() => objectActionPlan({}, 'create-schema', 'new'), /选择目标数据库/);
  assert.throws(() => objectActionPlan({}, 'create-database', 'new', 'redis'), /驱动/);
});

test('destructive plans quote the exact target and reject mismatches', () => {
  const target = { database: 'prod', object: { database: 'prod', schema: 'sales', name: 'we`ird', kind: 'table' } };
  assert.equal(objectActionPlan(target, 'drop-table', 'we`ird', 'mysql').sql, 'DROP TABLE `sales`.`we``ird`;');
  assert.equal(objectActionPlan({ database: 'a"b' }, 'drop-database', 'a"b').sql, 'DROP DATABASE "a""b";');
  assert.throws(() => objectActionPlan(target, 'drop-table', 'other', 'mysql'), /目标/);
  assert.throws(() => objectActionPlan({ database: 'prod' }, 'drop-database', 'other'), /名称/);
});

test('MySQL database character choices are optional and reject unsafe SQL', () => {
  assert.equal(objectActionPlan({}, 'create-database', 'app', 'mysql', { charset: 'utf8mb4', collation: 'utf8mb4_bin' }).sql, 'CREATE DATABASE `app` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;');
  assert.throws(() => objectActionPlan({}, 'create-database', 'app', 'mysql', { charset: 'utf8mb4', collation: 'latin1_bin' }), /不匹配/);
  assert.throws(() => objectActionPlan({}, 'create-database', 'app', 'mysql', { charset: 'utf8mb4;DROP', collation: '' }), /不匹配/);
});


test('PostgreSQL schema deletion quotes the exact target and refuses cascading', () => {
  const target = { database: 'app', schema: 'sales"2026' };
  assert.equal(objectActionPlan(target, 'drop-schema', 'sales"2026').sql, 'DROP SCHEMA "sales""2026" RESTRICT;');
  assert.throws(() => objectActionPlan(target, 'drop-schema', 'wrong'), /目标/);
  assert.throws(() => objectActionPlan(target, 'drop-schema', 'sales"2026', 'mysql'), /目标/);
});

test('clear table supports safe, quoted SQL with driver-specific behavior', async () => {
  const { clearTablePlan } = await import('../src/object-actions.js');
  const target = { object: { database: 'db', schema: 'a"b', name: 'test"table', kind: 'table' } };
  const pg = clearTablePlan(target, 'truncate');
  assert.equal(pg.sql, 'TRUNCATE TABLE "a""b"."test""table" CONTINUE IDENTITY RESTRICT;');
  assert.match(pg.description, /行级安全/);
  assert.equal(clearTablePlan(target, 'delete').sql, 'DELETE FROM "a""b"."test""table";');
  const mysql = clearTablePlan({ object: { database: 'db', schema: 'db', name: 'a`b', kind: 'table' } }, 'truncate', 'mysql');
  assert.equal(mysql.sql, 'TRUNCATE TABLE `db`.`a``b`;');
  assert.match(mysql.description, /隐式提交/);
  assert.throws(() => clearTablePlan({ object: { ...target.object, kind: 'view' } }, 'delete'), /目标表/);
  assert.throws(() => clearTablePlan(target, 'cascade'), /不支持/);
});
