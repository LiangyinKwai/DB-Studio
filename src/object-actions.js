import { mysqlCharacterClause } from './mysql-character-settings.js';
// The form's final submit executes this exact plan; preview is optional.
export function objectActionPlan(target, action, value, driver = 'postgres', options = {}) {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('当前驱动不支持此操作');
  const name = action.startsWith('drop-') ? String(value) : String(value).trim();
  if (!name || /\0/.test(name)) throw new Error('请输入有效名称');
  if (!action.startsWith('drop-') && driver === 'mysql' && ([...name].length > 64 || /[.\/\\\u{10000}-\u{10ffff}]/u.test(name))) throw new Error('MySQL 名称最多 64 个字符，不能包含点、路径符或补充 Unicode 字符');
  if (!action.startsWith('drop-') && driver === 'postgres' && new TextEncoder().encode(name).length > 63) throw new Error('PostgreSQL 名称最多 63 字节');
  const q = identifier => {
    if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) throw new Error('无法确认操作位置');
    const quote = driver === 'mysql' ? '`' : '"'; return quote + identifier.replaceAll(quote, quote + quote) + quote;
  };
  const database = target.object?.database || target.database || null;
  const schema = target.object?.schema || target.schema || null;
  if (action === 'drop-database') {
    if (!target.database || name !== target.database) throw new Error('无法确认数据库名称');
    return { name, database: target.database, schema: null, sql: `DROP DATABASE ${q(name)};`, label: '删除数据库', success: `数据库 ${name} 已删除` };
  }
  if (action === 'drop-schema') {
    if (driver !== 'postgres' || !database || !schema || name !== schema) throw new Error('无法确认目标 schema');
    return { name, database, schema, sql: `DROP SCHEMA ${q(name)} RESTRICT;`, label: '删除 schema', success: `Schema ${name} 已删除` };
  }
  if (action === 'drop-table') {
    if (!database || !schema || !['table', 'partitioned_table'].includes(target.object?.kind) || name !== target.object.name) throw new Error('无法确认目标表');
    return { name, database, schema, sql: `DROP TABLE ${q(schema)}.${q(name)};`, label: '删除表', success: `表 ${schema}.${name} 已删除` };
  }
  if (action === 'create-database') return { name, database, schema: null, sql: `CREATE DATABASE ${q(name)}${driver === 'mysql' ? mysqlCharacterClause(options.charset, options.collation) : ''};`, label: '创建数据库', success: `数据库 ${name} 已创建` };
  if (!database) throw new Error('请先选择目标数据库');
  if (action === 'create-schema' && driver === 'postgres') return { name, database, schema: null, sql: `CREATE SCHEMA ${q(name)};`, label: '创建 Schema', success: `Schema ${name} 已创建` };
  if (action === 'rename-table' && ['table', 'partitioned_table'].includes(target.object?.kind)) {
    if (name === target.object.name) throw new Error('请输入不同于原表名的新名称');
    const table = `${q(schema)}.${q(target.object.name)}`;
    return { name, database, schema, sql: driver === 'mysql' ? `RENAME TABLE ${table} TO ${q(schema)}.${q(name)};` : `ALTER TABLE ${table} RENAME TO ${q(name)};`, label: '重命名表', success: `表已重命名为 ${name}` };
  }
  throw new Error('不支持此对象操作');
}

export function clearTablePlan(target, method, driver = 'postgres') {
  if (!['postgres', 'mysql'].includes(driver) || !['delete', 'truncate'].includes(method)) throw new Error('不支持的清空方式');
  const object = target?.object;
  const database = object?.database || target?.database;
  if (!database || !object?.schema || !object?.name || !['table', 'partitioned_table'].includes(object.kind)) throw new Error('无法确认目标表');
  const quote = driver === 'mysql' ? '`' : '"';
  const q = value => {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('无法确认目标表');
    return quote + value.replaceAll(quote, quote + quote) + quote;
  };
  const table = `${q(object.schema)}.${q(object.name)}`;
  const isDelete = method === 'delete';
  const sql = isDelete ? `DELETE FROM ${table};` : driver === 'postgres' ? `TRUNCATE TABLE ${table} CONTINUE IDENTITY RESTRICT;` : `TRUNCATE TABLE ${table};`;
  const description = isDelete
    ? `执行 DELETE，${driver === 'postgres' ? '不重置序列' : '自增值是否重置取决于存储引擎'}；会触发 DELETE 触发器及外键关联操作，可能影响其他表。权限、行级策略或触发器可能使部分行保留。`
    : driver === 'postgres'
      ? '执行 TRUNCATE，保留序列值，不触发 DELETE 触发器，但会触发 TRUNCATE 触发器；包含子表或分区，不受行级安全策略约束。存在外键引用时拒绝执行，且会取得排他锁。'
      : '执行 TRUNCATE，重置 AUTO_INCREMENT，不触发 DELETE 触发器；存在外键引用时可能被拒绝。该操作会隐式提交，不能回滚。';
  return { database, schema: object.schema, name: object.name, method, sql, description };
}
