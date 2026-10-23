// The form's final submit executes this exact plan; preview is optional.
export function objectActionPlan(target, action, value, driver = 'postgres') {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('当前驱动不支持此操作');
  const name = String(value).trim();
  if (!name || /\0/.test(name)) throw new Error('请输入有效名称');
  if (driver === 'mysql' && ([...name].length > 64 || /[.\/\\\u{10000}-\u{10ffff}]/u.test(name))) throw new Error('MySQL 名称最多 64 个字符，不能包含点、路径符或补充 Unicode 字符');
  if (driver === 'postgres' && new TextEncoder().encode(name).length > 63) throw new Error('PostgreSQL 名称最多 63 字节');
  const q = identifier => {
    if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) throw new Error('无法确认操作位置');
    const quote = driver === 'mysql' ? '`' : '"'; return quote + identifier.replaceAll(quote, quote + quote) + quote;
  };
  const database = target.object?.database || target.database || null;
  const schema = target.object?.schema || target.schema || null;
  if (action === 'create-database') return { name, database, schema: null, sql: `CREATE DATABASE ${q(name)};`, label: '创建数据库', success: `数据库 ${name} 已创建` };
  if (!database) throw new Error('请先选择目标数据库');
  if (action === 'create-schema' && driver === 'postgres') return { name, database, schema: null, sql: `CREATE SCHEMA ${q(name)};`, label: '创建 Schema', success: `Schema ${name} 已创建` };
  if (action === 'rename-table' && ['table', 'partitioned_table'].includes(target.object?.kind)) {
    if (name === target.object.name) throw new Error('请输入不同于原表名的新名称');
    const table = `${q(schema)}.${q(target.object.name)}`;
    return { name, database, schema, sql: driver === 'mysql' ? `RENAME TABLE ${table} TO ${q(schema)}.${q(name)};` : `ALTER TABLE ${table} RENAME TO ${q(name)};`, label: '重命名表', success: `表已重命名为 ${name}` };
  }
  throw new Error('不支持此对象操作');
}
