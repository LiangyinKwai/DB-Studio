// Shared, DOM-free rules for inline and dialog editing. Values and primary keys
// must come from the captured result, never the currently visible grid.
export function cellColumnName(column) {
  return typeof column === 'string' ? column : typeof column?.name === 'string' ? column.name : '';
}

const busyFlags = ['running', 'refreshing', 'changingTransaction', 'confirming', 'resolvingTarget', 'cellSaving'];
const jsonType = (dataType) => /^(?:pg_catalog\.)?jsonb?$/i.test(String(dataType || '').trim());
const safeKeyValue = (value) => typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const validIdentifier = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const uniqueIndex = (columns, name) => {
  const index = columns.indexOf(name);
  return index >= 0 && columns.lastIndexOf(name) === index ? index : -1;
};

export function getCellEditCapability(tab, { column, columnIndex, rowIndex } = {}, driver = 'postgres') {
  const deny = (reason) => ({ editable: false, reason, allowNull: false, dataType: '' });
  if (!tab || !validIdentifier(tab.connectionId)) return deny('请先选择数据库连接');
  if (tab.mode !== 'write') return deny('当前查询已锁定为只读');
  if (busyFlags.some((flag) => tab[flag])) return deny('请等待当前操作完成后再编辑');
  const result = tab.result;
  if (result?.transactionRolledBack) return deny('事务已回滚，请刷新结果后再编辑');
  if (!result?.executed) return deny('请先加载数据后再编辑');
  if (result.connectionId && result.connectionId !== tab.connectionId) return deny('结果所属连接已改变，请重新加载数据');
  if (!Array.isArray(result.columns) || !Array.isArray(result.rows) ||
      !Number.isInteger(columnIndex) || !Number.isInteger(rowIndex) || columnIndex < 0 || rowIndex < 0 ||
      columnIndex >= result.columns.length || rowIndex >= result.rows.length) return deny('当前单元格已失效，请重新加载数据');
  const columns = result.columns.map(cellColumnName);
  const name = columns[columnIndex];
  const row = result.rows[rowIndex];
  if (!validIdentifier(name) || (column !== undefined && column !== name) || uniqueIndex(columns, name) < 0 ||
      !Array.isArray(row) || row.length !== columns.length || row[columnIndex] === undefined) return deny('无法确定此单元格对应的字段');

  if (driver === 'redis') {
    if (typeof tab.redisKey !== 'string' || name !== 'value' || !['string', 'hash'].includes(tab.redisType)) {
      return deny('仅支持 Redis string 值和 hash 字段值编辑');
    }
    if (row[columnIndex] === null) return deny('当前 Redis 值已失效，请重新加载数据');
    if (tab.redisType === 'hash') {
      const fieldIndex = uniqueIndex(columns, 'field');
      if (fieldIndex < 0 || typeof row[fieldIndex] !== 'string') return deny('无法确定要编辑的 Redis 字段');
    }
    return { editable: true, reason: '', allowNull: false, dataType: '' };
  }

  if (!['postgres', 'mysql'].includes(driver)) return deny('此数据库暂不支持单元格编辑');
  const browse = tab.browse;
  if (!browse || !['table', 'partitioned_table'].includes(browse.kind)) return deny('仅支持普通表和分区表的单元格编辑');
  if (!validIdentifier(browse.schema) || !validIdentifier(browse.name) ||
      (browse.connectionId && browse.connectionId !== tab.connectionId)) return deny('无法确认当前表的执行位置');
  const metadata = Array.isArray(browse.columns) ? browse.columns.filter((item) => item.name === name) : [];
  if (metadata.length !== 1) return deny('请先加载完整表结构后再编辑');
  const field = metadata[0];
  const primaryKeys = browse.primaryKeys;
  if (!Array.isArray(primaryKeys) || !primaryKeys.length) return deny('当前表没有主键，无法安全定位要更新的行');
  if (field.primaryKey || primaryKeys.includes(name)) return deny('主键用于定位行，不可修改');
  if (field.identity || field.generated) return deny('自增或生成字段由数据库维护，不可修改');
  if (new Set(primaryKeys).size !== primaryKeys.length || primaryKeys.some((key) => !validIdentifier(key)) ||
      browse.columns.some((item) => item.primaryKey && !primaryKeys.includes(item.name))) {
    return deny('主键信息不完整，请重新加载表结构');
  }
  for (const key of primaryKeys) {
    const index = uniqueIndex(columns, key);
    if (index < 0 || !safeKeyValue(row[index])) return deny('结果缺少有效主键，无法安全定位要更新的行');
  }
  return { editable: true, reason: '', allowNull: field.nullable === true, dataType: field.dataType || '' };
}

export function validateCellDraft(value, { dataType = '', allowNull = false } = {}) {
  if (value === null) {
    if (!allowNull) throw new Error('此字段不允许设为 NULL');
    return null;
  }
  if (typeof value !== 'string') throw new Error('单元格内容必须为文本或 NULL');
  if (jsonType(dataType)) {
    try { JSON.parse(value); }
    catch { throw new Error('JSON 格式无效，请修正后再保存'); }
  }
  // Parsing is validation only: serializing would round large JSON integers,
  // rewrite whitespace and erase the distinction between text and SQL NULL.
  return value;
}

function quoteIdentifier(value, driver) {
  if (!validIdentifier(value)) throw new Error('表名、字段名和主键名不能为空或包含空字符');
  const quote = driver === 'mysql' ? '`' : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

export function sqlValueLiteral(value, driver = 'postgres') {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('此数据库暂不支持数据写入');
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (!safeKeyValue(value)) throw new Error('主键值无法安全表示，请重新加载数据');
    return String(value);
  }
  if (value && typeof value === 'object') {
    try { value = JSON.stringify(value); }
    catch { throw new Error('JSON 数据无法序列化'); }
  }
  if (typeof value !== 'string') throw new Error('写入内容必须为文本、数值、布尔值、JSON 或 NULL');
  if (driver === 'mysql') {
    // Hex-encoded UTF-8 is independent of NO_BACKSLASH_ESCAPES and preserves
    // empty strings, leading zeroes, quotes, backslashes and Unicode exactly.
    const bytes = new TextEncoder().encode(value);
    if (new TextDecoder().decode(bytes) !== value) throw new Error('单元格包含无效 Unicode 字符');
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  if (value.includes('\0')) throw new Error('PostgreSQL 文本不能包含空字符');
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

export function buildCellUpdateSql({ schema, name, column, primaryKeys, columns, row, value, driver = 'postgres' } = {}) {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('此数据库暂不支持单元格编辑');
  if (value !== null && typeof value !== 'string') throw new Error('单元格内容必须为文本或 NULL');
  const q = (identifier) => quoteIdentifier(identifier, driver);
  const table = `${q(schema)}.${q(name)}`;
  q(column);
  if (!Array.isArray(columns) || !Array.isArray(row) || columns.length !== row.length) throw new Error('结果字段和行数据不完整');
  const names = columns.map(cellColumnName);
  if (uniqueIndex(names, column) < 0) throw new Error('结果中缺少唯一对应的待编辑字段');
  if (!Array.isArray(primaryKeys) || !primaryKeys.length || new Set(primaryKeys).size !== primaryKeys.length) {
    throw new Error('缺少完整主键，无法安全定位要更新的行');
  }
  if (primaryKeys.includes(column)) throw new Error('主键用于定位行，不可修改');
  const predicates = primaryKeys.map((key) => {
    q(key);
    const index = uniqueIndex(names, key);
    if (index < 0 || !safeKeyValue(row[index])) throw new Error('结果缺少有效主键，无法安全定位要更新的行');
    return `${q(key)} ${driver === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM'} ${sqlValueLiteral(row[index], driver)}`;
  });
  return `UPDATE ${table} SET ${q(column)} = ${sqlValueLiteral(value, driver)} WHERE ${predicates.join(' AND ')};`;
}
