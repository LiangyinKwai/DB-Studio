const identifier = (value, driver) => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('建表对象名称无效');
  const quote = driver === 'mysql' ? '`' : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
};
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const statement = value => {
  const sql = String(value || '').trim();
  if (!sql) throw new Error('缺少对象定义，不能生成完整建表 SQL');
  return sql.endsWith(';') ? sql : `${sql};`;
};
const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`缺少${label}，请重新加载表结构后再复制`);
  return value;
};

// Copy exact native MySQL DDL, qualifying only the CREATE target. Rebuilding
// from information_schema display fields loses expressions, text defaults,
// engine options, charset, partitioning and constraint/index definitions.
function nativeMysqlTableDdl(object, details) {
  const definition = details.definition?.trim();
  if (!definition) throw new Error('未取得 MySQL 原生 SHOW CREATE TABLE 定义，不能用简化字段信息代替');
  const identifierPattern = '`(?:``|[^`])+`';
  const target = new RegExp(`^(CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(${identifierPattern})(?:\\.(${identifierPattern}))?(\\s*\\()`, 'i');
  const match = definition.match(target);
  if (!match) throw new Error('MySQL 返回的建表定义格式无法确认，请重新加载后再复制');
  const unquote = value => value.slice(1, -1).replaceAll('``', '`');
  if (unquote(match[3] || match[2]) !== object.name || (match[3] && unquote(match[2]) !== object.schema)) {
    throw new Error('MySQL 原生定义与当前表不一致，已停止复制');
  }
  const qualified = `${identifier(object.schema, 'mysql')}.${identifier(object.name, 'mysql')}`;
  return statement(definition.replace(target, (_, prefix, _schema, _name, paren) => `${prefix}${qualified}${paren}`));
}

export function buildTableDdl(object, details, driver = 'postgres') {
  if (!object || !details || !['postgres', 'mysql'].includes(driver)) throw new Error('当前对象无法导出建表 SQL');
  if (!['table', 'partitioned_table'].includes(object.kind)) throw new Error('此对象不是普通表或分区表，不能生成普通建表 SQL');
  if ((details.schema && details.schema !== object.schema) || (details.name && details.name !== object.name) ||
      (details.kind && details.kind !== object.kind)) throw new Error('对象结构与当前表不一致，请刷新后再复制');
  if (driver === 'mysql') return nativeMysqlTableDdl(object, details);

  const metadata = details.tableDdl;
  if (!metadata) throw new Error('缺少精确建表元数据，请更新应用并重新加载表结构；不会复制缺少约束的简化 SQL');
  if (metadata.unsupportedReason) throw new Error(metadata.unsupportedReason);
  const columns = array(details.columns, '字段信息');
  const definitions = array(metadata.columnDefinitions, '精确字段定义');
  const constraints = array(details.constraints, '约束定义');
  const indexes = array(details.indexes, '索引定义');
  const constraintIndexes = new Set(array(metadata.constraintIndexes, '约束索引归属信息'));
  const before = array(metadata.beforeStatements, '前置定义');
  const after = array(metadata.afterStatements, '后置定义');
  if (definitions.length !== columns.length || definitions.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('字段定义不完整，不能生成建表 SQL');
  }
  if (!['CREATE TABLE', 'CREATE UNLOGGED TABLE'].includes(metadata.createPrefix) || typeof metadata.createSuffix !== 'string') {
    throw new Error('表属性不完整，不能生成建表 SQL');
  }
  // Only emit standalone SQL from metadata deparsed on an isolated connection
  // whose lookup path forces PostgreSQL to qualify non-system dependencies.
  if (before[0] !== "SELECT pg_catalog.set_config('search_path', E'pg_catalog', false);") {
    throw new Error('DDL 名称解析环境无法确认，请重新读取表结构');
  }
  const suffix = metadata.createSuffix.replace(/\nUSING "heap"(?=\n|$)/, '');
  const qualified = `${identifier(object.schema, driver)}.${identifier(object.name, driver)}`;
  const primary = constraints.filter(item => item.kind === 'primary_key');
  const entries = [...definitions, ...primary.map(item => `CONSTRAINT ${identifier(item.name, driver)} ${statement(item.definition).replace(/;$/, '')}`)];
  const lines = [
    ...before.slice(1).map(statement),
    `${metadata.createPrefix} ${qualified} (${entries.length ? `\n  ${entries.join(',\n  ')}\n` : ''})${suffix};`,
  ];
  // ALTER ADD preserves NOT VALID/DEFERRABLE and the server's composite-key
  // order. Regenerating a PK from column flags would silently reorder it.
  const constraintPriority = constraint => ['primary_key', 'unique'].includes(constraint.kind) ? 0 : constraint.kind === 'foreign_key' ? 2 : 1;
  for (const constraint of constraints.filter(item => item.kind !== 'primary_key').sort((a, b) => constraintPriority(a) - constraintPriority(b))) {
    const definition = statement(constraint.definition);
    lines.push(`ALTER TABLE ${qualified} ADD CONSTRAINT ${identifier(constraint.name, driver)} ${definition}`);
  }
  for (const index of indexes) {
    if (!constraintIndexes.has(index.name)) lines.push(statement(index.definition));
  }
  lines.push(...after.map(statement));
  if (details.comment !== null && details.comment !== undefined) lines.push(`COMMENT ON TABLE ${qualified} IS ${literal(details.comment)};`);
  for (const column of columns) {
    if (column.comment !== null && column.comment !== undefined) {
      lines.push(`COMMENT ON COLUMN ${qualified}.${identifier(column.name, driver)} IS ${literal(column.comment)};`);
    }
  }
  return lines.join('\n\n');
}
