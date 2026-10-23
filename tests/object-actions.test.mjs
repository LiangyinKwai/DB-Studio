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
