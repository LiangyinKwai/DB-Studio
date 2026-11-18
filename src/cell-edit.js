// Shared, DOM-free rules for inline and dialog editing. Values and primary keys
// must come from the captured result, never the currently visible grid.
export function cellColumnName(column) {
  return typeof column === 'string' ? column : typeof column?.name === 'string' ? column.name : '';
}

const busyFlags = ['running', 'refreshing', 'paging', 'changingTransaction', 'confirming', 'resolvingTarget', 'cellSaving', 'cellBatchSaving'];
const emptyTextType = dataType => /^(?:(?:pg_catalog\.)?(?:text|character(?: varying)?|varchar|char|bpchar)|(?:tinytext|mediumtext|longtext))(?:\b|\()/i.test(String(dataType || '').trim());
const jsonType = (dataType) => /^(?:pg_catalog\.)?jsonb?$/i.test(String(dataType || '').trim());
const safeKeyValue = (value) => typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const safeTypedKey = (value, dataType, driver) => {
  if (safeKeyValue(value)) return true;
  if (driver !== 'mysql' || value?.$dbStudio !== 'mysql-binary' || !/^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i.test(dataType || '')) return false;
  try { sqlTypedValueLiteral(value, dataType, driver); return true; } catch { return false; }
};
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
  if (result?.schemaChanged) return deny('表结构已改变，请刷新数据后再编辑');
  if (result?.transactionOutcomeUnknown) return deny(`${result.writeOutcomeUnknown ? '写入' : '事务'}结果未知，请刷新并核对数据库后再编辑`);
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
    if (result.redisValueTruncated) return deny('当前值仅为截断预览，不能编辑；请分段读取完整数据');
    const editableColumn = tab.redisType === 'zset' ? 'score' : 'value';
    if (typeof tab.redisKey !== 'string' || name !== editableColumn || !['string', 'hash', 'list', 'zset'].includes(tab.redisType)) {
      return deny(tab.redisType === 'stream' ? '消息内容不可修改，可通过消息操作追加或删除' : tab.redisType === 'set' ? '集合成员可通过成员操作添加或移除' : '可编辑字符串、哈希值、列表值和有序集合分数；标识列不可修改');
    }
    if (row[columnIndex] === null) return deny('当前 Redis 值已失效，请重新加载数据');
    if (tab.redisType === 'hash') {
      const fieldIndex = uniqueIndex(columns, 'field');
      if (fieldIndex < 0 || typeof row[fieldIndex] !== 'string') return deny('无法确定要编辑的 Redis 字段');
    }
    if (tab.redisType === 'list') {
      const index = uniqueIndex(columns, 'index');
      if (index < 0 || !Number.isSafeInteger(row[index]) || row[index] < 0) return deny('列表下标无效，请刷新数据');
    }
    if (tab.redisType === 'zset') {
      const index = uniqueIndex(columns, 'member');
      if (index < 0 || typeof row[index] !== 'string') return deny('无法确定有序集合成员');
      return { editable: true, reason: '', allowNull: false, allowEmpty: false, dataType: 'redis-score' };
    }
    return { editable: true, reason: '', allowNull: false, allowEmpty: true, dataType: '' };
  }

  if (!['postgres', 'mysql'].includes(driver)) return deny('此数据库暂不支持单元格编辑');
  const browse = tab.browse;
  if (!browse || !['table', 'partitioned_table'].includes(browse.kind)) return deny('仅支持普通表和分区表的单元格编辑');
  if (!validIdentifier(browse.schema) || !validIdentifier(browse.name) ||
      (browse.connectionId && browse.connectionId !== tab.connectionId)) return deny('无法确认当前表的执行位置');
  const metadata = Array.isArray(browse.columns) ? browse.columns.filter((item) => item.name === name) : [];
  if (metadata.length !== 1) return deny('请先加载完整表结构后再编辑');
  const field = metadata[0];
  if (driver === 'mysql' && /^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i.test(field.dataType || '')) return deny('空间字段请使用 ST_GeomFromText 等 MySQL SQL 函数修改');
  const primaryKeys = browse.primaryKeys;
  if (!Array.isArray(primaryKeys) || !primaryKeys.length) return deny('当前表没有主键，无法安全定位要更新的行');
  if (field.generated) return deny('生成字段由数据库维护，不可修改');
  if (field.identity && driver === 'postgres' && field.identityGeneration !== 'byDefault') return deny('此 PostgreSQL 字段为 GENERATED ALWAYS identity，数据库仅允许写入 DEFAULT');
  if (new Set(primaryKeys).size !== primaryKeys.length || primaryKeys.some((key) => !validIdentifier(key)) ||
      browse.columns.some((item) => item.primaryKey && !primaryKeys.includes(item.name))) {
    return deny('主键信息不完整，请重新加载表结构');
  }
  for (const key of primaryKeys) {
    const index = uniqueIndex(columns, key);
    if (index < 0 || !safeTypedKey(row[index], browse.columns.find(field => field.name === key)?.dataType, driver)) return deny('结果缺少有效主键，无法安全定位要更新的行');
  }
  return { editable: true, reason: '', allowNull: !primaryKeys.includes(name) && !field.primaryKey && field.nullable === true, allowEmpty: emptyTextType(field.dataType), dataType: field.dataType || '' };
}

export function validateCellDraft(value, { dataType = '', allowNull = false } = {}) {
  if (value === null) {
    if (!allowNull) throw new Error('此字段不允许设为 NULL');
    return null;
  }
  if (typeof value !== 'string') throw new Error('单元格内容必须为文本或 NULL');
  if (dataType === 'redis-score' && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error('分数必须为有限数值');
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

export function sqlTypedValueLiteral(value, dataType = '', driver = 'postgres') {
  if (driver !== 'mysql' || value === null) return sqlValueLiteral(value, driver);
  if (typeof value === 'boolean' && !dataType) return sqlValueLiteral(value, driver);
  if (typeof value === 'boolean') {
    if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bool|boolean|bit)\b/i.test(dataType)) return value ? '1' : '0';
    value = String(value);
  }
  if (/^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i.test(dataType)) throw new Error('空间数据请使用 MySQL 原生 SQL 和 ST_GeomFromWKB 导入，不能直接写入内部字节');
  if (/^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i.test(dataType)) {
    let hex;
    if (value && typeof value === 'object' && value.$dbStudio === 'mysql-binary') hex = value.hex;
    else if (typeof value === 'string') {
      if (/^0x/i.test(value)) hex = value.slice(2);
      else { try { const encoded = JSON.parse(value); if (encoded.$dbStudio === 'mysql-binary') hex = encoded.hex; } catch {} }
    }
    if (typeof hex !== 'string' || !/^(?:[a-f\d]{2})*$/i.test(hex)) throw new Error('二进制字段需要 0x 开头的偶数位十六进制文本');
    return `X'${hex}'`;
  }
  const bit = String(dataType).match(/^bit(?:\((\d+)\))?$/i);
  if (bit) {
    const text = typeof value === 'boolean' ? value ? '1' : '0' : String(value);
    if (!/^\d+$/.test(text) || BigInt(text) >= 1n << BigInt(bit[1] || 1)) throw new Error(`BIT 字段超出 ${bit[1] || 1} 位范围`);
    return text;
  }
  if (/^(?:bool(?:ean)?\b|tinyint\(1\)(?=\s|$))/i.test(dataType) && (typeof value === 'boolean' || /^(?:true|false)$/i.test(String(value)))) return String(value).toLowerCase() === 'true' ? '1' : '0';
  return sqlValueLiteral(value, driver);
}

export function buildCellUpdateSql({ schema, name, column, primaryKeys, columns, row, value, driver = 'postgres', dataType, capability, keyTypes = {} } = {}) {
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
  if (primaryKeys.includes(column) && value === null) throw new Error('主键不能设为 NULL');
  const predicates = primaryKeys.map((key) => {
    q(key);
    const index = uniqueIndex(names, key);
    if (index < 0 || !safeTypedKey(row[index], keyTypes[key], driver)) throw new Error('结果缺少有效主键，无法安全定位要更新的行');
    return `${q(key)} ${driver === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM'} ${sqlTypedValueLiteral(row[index], keyTypes[key], driver)}`;
  });
  return `UPDATE ${table} SET ${q(column)} = ${sqlTypedValueLiteral(value, dataType || capability?.dataType, driver)} WHERE ${predicates.join(' AND ')};`;
}
