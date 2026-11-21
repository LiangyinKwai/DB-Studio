import { mysqlCharacterClause, createMysqlCharacterPicker } from './mysql-character-settings.js';
import { setSelectableText } from './selectable-text.js';
import { mysqlColumns, mysqlColumnChange, mysqlDefaultClause, mysqlCommentLiteral, mysqlSqlModeExpectation } from './mysql-ddl.js';
import { getTypeParameters, updateTypeParameters, createDefaultSql, isIdentityType } from './create-table-fields.js';
import { createStructureCommentEditor } from './structure-comment-editor.js';
import { structureMetadataTabs, mountStructureTabs } from './structure-tabs.js';
import { buildKeyChanges, structureKeyChanged, structureKeyDrafts } from './structure-keys.js';
import { createStructureKeyEditor } from './structure-key-editor.js';

const editableKeys = ['name', 'dataType', 'nullable', 'defaultValue', 'comment'];
const columnTypes = {
  postgres: [
    ['整数', 'smallint', '小整数 2 字节', 'int2 short'], ['整数', 'integer', '整数 4 字节', 'int int4'], ['整数', 'bigint', '大整数 8 字节', 'int8 long'],
    ['精确数值', 'numeric(12,2)', '精确小数，可调整精度和小数位', 'decimal 金额'], ['精确数值', 'numeric', '任意精度数值', 'decimal'],
    ['近似数值', 'real', '单精度浮点数', 'float4'], ['近似数值', 'double precision', '双精度浮点数', 'float8 double'], ['货币', 'money', '货币数值', '金额'],
    ['文本', 'varchar(255)', '变长字符串，可调整长度', 'character varying string'], ['文本', 'character(1)', '定长字符串，可调整长度', 'char character string'], ['文本', 'text', '不限长度的文本', '字符串 string'],
    ['日期时间', 'date', '日期', '日期时间'], ['日期时间', 'time without time zone', '不含时区的时间', 'time 时间'], ['日期时间', 'time with time zone', '含时区的时间', 'timetz 时区'],
    ['日期时间', 'timestamp without time zone', '不含时区的日期时间', 'datetime 时间戳'], ['日期时间', 'timestamp with time zone', '含时区的日期时间', 'timestamptz 时区'], ['日期时间', 'interval', '时间间隔', 'duration 时长'],
    ['布尔值', 'boolean', '真或假', 'bool'], ['JSON', 'jsonb', '二进制优化 JSON，支持索引', 'json'], ['JSON', 'json', 'JSON 文本', 'jsonb'],
    ['标识符', 'uuid', '通用唯一标识', 'guid'], ['二进制', 'bytea', '二进制数据', 'binary blob'],
    ['网络', 'inet', 'IPv4 或 IPv6 地址', 'ip'], ['网络', 'cidr', '网络地址段', 'ip network'], ['网络', 'macaddr', 'MAC 地址', 'mac'],
    ['数组', 'integer[]', '整数数组', 'array int'], ['数组', 'text[]', '文本数组', 'array string'],
  ].map(([group, value, label, keywords]) => ({ group, value, label, keywords })),
  mysql: [
    ['整数', 'tinyint', '极小整数 1 字节', 'int bool boolean'], ['整数', 'smallint', '小整数 2 字节', 'int'], ['整数', 'mediumint', '中整数 3 字节', 'int'],
    ['整数', 'int', '整数 4 字节', 'integer int4'], ['整数', 'bigint', '大整数 8 字节', 'int8'], ['整数', 'int unsigned', '无符号整数', 'integer 正数'], ['整数', 'bigint unsigned', '无符号大整数', '正数'],
    ['精确数值', 'decimal(12,2)', '精确小数，可调整精度和小数位', 'numeric 金额'], ['精确数值', 'decimal', '精确小数', 'numeric'], ['近似数值', 'float', '单精度浮点数', 'real'], ['近似数值', 'double', '双精度浮点数', 'double precision'], ['近似数值', 'bit(1)', '位字段', 'binary'],
    ['文本', 'char(1)', '定长字符串，可调整长度', 'character string'], ['文本', 'varchar(255)', '变长字符串，可调整长度', 'character varying string'], ['文本', 'tinytext', '短文本', 'text'], ['文本', 'text', '文本', 'string'], ['文本', 'mediumtext', '中型文本', 'text'], ['文本', 'longtext', '长文本', 'text'],
    ['枚举', "enum('active','disabled')", '单选枚举值，替换示例选项', '枚举 enum'], ['枚举', "set('read','write')", '多选集合值，替换示例选项', '集合 set'],
    ['日期时间', 'date', '日期', ''], ['日期时间', 'time', '时间', ''], ['日期时间', 'datetime', '日期和时间', 'timestamp'], ['日期时间', 'timestamp', '时间戳', 'datetime'], ['日期时间', 'year', '年份', ''],
    ['布尔值', 'boolean', '布尔值（TINYINT 别名）', 'bool tinyint'], ['JSON', 'json', 'JSON 文档', ''],
    ['二进制', 'binary(16)', '定长二进制，可调整长度', ''], ['二进制', 'varbinary(255)', '变长二进制，可调整长度', ''], ['二进制', 'tinyblob', '短二进制数据', 'blob'], ['二进制', 'blob', '二进制数据', ''], ['二进制', 'mediumblob', '中型二进制数据', 'blob'], ['二进制', 'longblob', '长二进制数据', 'blob'],
    ['空间数据', 'geometry', '几何对象', 'spatial gis'], ['空间数据', 'point', '坐标点', 'gis'], ['空间数据', 'linestring', '线段', 'gis'], ['空间数据', 'polygon', '多边形', 'gis'],
  ].map(([group, value, label, keywords]) => ({ group, value, label, keywords })),
};
const normalizeTypeValue = value => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
const normalizeTypeSearch = value => normalizeTypeValue(value).replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
const typeBase = value => normalizeTypeSearch(value).replace(/^character varying$/, 'varchar').replace(/^character$/, 'char').replace(/^numeric$/, 'decimal');

export function searchColumnTypes(driver, query, { commonFirst = false } = {}) {
  const available = columnTypes[driver] || [];
  const exact = normalizeTypeValue(query), needle = normalizeTypeSearch(query), terms = needle.split(/\s+/).filter(Boolean);
  let options = available.filter(option => {
    const haystack = normalizeTypeSearch(`${option.group} ${option.value} ${option.label} ${option.keywords}`);
    return terms.every(term => haystack.includes(term));
  });
  if (terms.length) {
    // A complete parameterized type is itself the best choice, rather than
    // replacing a user's numeric(18,4) with the menu's numeric(12,2) example.
    const parameters = getTypeParameters(query);
    if (parameters && (parameters.length || parameters.precision)) {
      const template = available.find(option => {
        const candidate = getTypeParameters(option.value);
        return candidate && typeBase(candidate.base) === typeBase(parameters.base);
      });
      if (template) {
        try {
          const value = updateTypeParameters(query, parameters);
          options = [{ ...template, value }, ...options.filter(option => normalizeTypeValue(option.value) !== normalizeTypeValue(value))];
        } catch { /* Keep incomplete/invalid parameter input as an editable draft. */ }
      }
    }
    const rank = option => {
      if (normalizeTypeValue(option.value) === exact) return 0;
      const value = normalizeTypeSearch(option.value), aliases = normalizeTypeSearch(option.keywords);
      if (value.startsWith(needle) || ` ${aliases} `.includes(` ${needle} `)) return 1;
      if (aliases.split(' ').some(alias => alias.startsWith(needle))) return 2;
      return 3;
    };
    // Stable ties preserve the existing order for category/Chinese searches.
    options.sort((left, right) => rank(left) - rank(right));
  } else if (commonFirst) {
    const common = driver === 'mysql' ? ['bigint', 'int', 'varchar(255)', 'decimal(12,2)', 'boolean', 'datetime', 'json', 'text']
      : ['bigint', 'integer', 'text', 'varchar(255)', 'numeric(12,2)', 'boolean', 'jsonb', 'timestamp with time zone'];
    options = [...common.map(value => options.find(option => option.value === value)).filter(Boolean).map(option => ({ ...option, group: '常用' })), ...options.filter(option => !common.includes(option.value))];
  }
  return options;
}
const same = (a, b, key) => key === 'nullable' ? Boolean(a[key]) === Boolean(b[key]) : (a[key] ?? '') === (b[key] ?? '');
export const changedColumn = (row) => !row.original || row.removed || editableKeys.some((key) => !same(row, row.original, key));
export function createStructureDraft(details) {
  const native = mysqlColumns(details);
  return (details.columns || []).map(column => {
    const original = { ...column, defaultValue: native?.get(column.name)?.defaultValue ?? column.defaultValue ?? '' };
    return { ...original, comment: column.comment ?? '', original };
  });
}

// Field types/defaults are SQL fragments, never scripts. Quote-aware checks keep
// a literal containing punctuation usable without allowing extra DDL clauses.
function fragment(value, label, { type = false, mysql = false } = {}) {
  const text = String(value).trim();
  let quote = null;
  let depth = 0;
  let outer = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\0' || c === '\\') throw new Error(`${label}不支持空字符或反斜线，请使用 SQL 编辑器`);
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; outer += 'x'; continue; }
    if (c === ';' || c === '$' || (mysql && c === '#') || text.slice(i, i + 2) === '--' || text.slice(i, i + 2) === '/*') throw new Error(`${label}只能填写一个${type ? '类型' : '表达式'}，不能包含语句或注释`);
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) throw new Error(`${label}括号不匹配`);
    if (c === ',' && depth === 0) throw new Error(`${label}不能包含额外字段定义`);
    outer += c;
  }
  if (quote || depth) throw new Error(`${label}引号或括号不匹配`);
  if (type && (!text || !/^[\w\s.()[\],]+$/u.test(outer) || /\b(?:default|null|primary|unique|references|check|constraint|generated|auto_increment|comment|collate|add|drop|rename|alter)\b/i.test(outer) || (mysql && /\b(?:first|after)\b/i.test(outer))))
    throw new Error(`${label}请只填写类型，例如 ${mysql ? 'varchar(255)' : 'text、numeric(12,2)'}；约束请使用 SQL 编辑器`);
  if (!type && /\b(?:drop|alter|add|rename|constraint|references|primary|check|comment|create|delete|update|insert)\b/i.test(outer))
    throw new Error(`${label}含有不支持的 SQL 关键字，请使用 SQL 编辑器`);
  return text;
}
const identifier = (name, mysql) => {
  if (!name || /\0/.test(name) || (mysql && /\\/.test(name))) throw new Error('字段名不能为空，也不能包含不支持的字符');
  if (mysql && ([...name].length > 64 || /\s$/.test(name) || /[\u{10000}-\u{10ffff}]/u.test(name))) throw new Error('MySQL 标识符不能超过 64 个字符、以空白结尾或使用补充 Unicode 字符');
  const q = mysql ? '`' : '"';
  return q + name.replaceAll(q, q + q) + q;
};
const literal = (value, mysql, sqlMode) => {
  if (mysql) return mysqlCommentLiteral(value, sqlMode);
  const text = String(value);
  if (text.includes('\0')) throw new Error('备注包含不支持的字符，请使用 SQL 编辑器');
  return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};

// Simulate MySQL's left-to-right placement clauses against the surviving columns.
function mysqlColumnPositions(columns, rows, quote) {
  const existing = new Set(rows.flatMap(row => row.original ? [row.original.name] : []));
  const order = columns.map(column => column.name).filter(name => existing.has(name));
  const positions = new Map();
  for (const [index, row] of rows.entries()) {
    const current = row.original ? order.indexOf(row.original.name) : -1;
    if (current === index) {
      order[index] = row.name;
      continue;
    }
    if (current >= 0) order.splice(current, 1);
    if (current >= 0 || index < order.length) {
      positions.set(row, index === 0 ? ' FIRST' : ` AFTER ${quote(rows[index - 1].name)}`);
    }
    order.splice(index, 0, row.name);
  }
  return positions;
}

export function buildStructurePlan(details, rows, driver = 'postgres', tableComment = details.comment ?? '', keys) {
  const mysql = driver === 'mysql';
  if (!['postgres', 'mysql'].includes(driver) || !['table', 'partitioned_table'].includes(details.kind)) throw new Error('此对象暂不支持可视化编辑');
  const q = (name) => identifier(String(name ?? ''), mysql);
  const table = `${q(details.schema)}.${q(details.name)}`;
  const names = new Set();
  const originals = new Set((details.columns || []).map((c) => c.name));
  const kept = rows.filter((row) => !row.removed);
  const nativeColumns = mysql ? mysqlColumns(details) : null;
  if (!kept.length) throw new Error('请至少保留一个字段');
  for (const row of kept) {
    q(row.name);
    const key = mysql ? row.name.toLowerCase() : row.name;
    if (names.has(key)) throw new Error(`字段名重复：${row.name}`);
    names.add(key);
    if (row.name !== row.original?.name && originals.has(row.name)) throw new Error(`字段名 ${row.name} 已存在，请分步改名或删除后再添加`);
  }
  const statements = [];
  const clauses = [];
  const alter = (clause) => mysql ? clauses.push(clause) : statements.push(`ALTER TABLE ${table} ${clause};`);
  const { dropClauses, addClauses, foreignKeys, dropIndexes, createIndexes, indexesChanged, constraintsChanged, keysDropped } =
    buildKeyChanges(details, rows, keys, { mysql, q, validateExpression: (value, name) => fragment(value, `${name} 的检查表达式`, { mysql }) });
  for (const clause of dropClauses) alter(clause);
  statements.push(...dropIndexes);
  const positions = mysql ? mysqlColumnPositions(details.columns || [], kept, q) : new Map();
  let changed = 0;
  let dropped = 0;
  for (const row of rows) {
    const old = row.original;
    const edited = changedColumn(row);
    const position = positions.get(row) || '';
    if (!edited && !position) continue;
    changed++;
    if (row.removed) {
      if (old) { alter(`DROP COLUMN ${q(old.name)}`); dropped++; }
      continue;
    }
    if (!old) {
      const type = fragment(row.dataType, `${row.name} 的类型`, { type: true, mysql });
      const def = row.defaultValue.trim() ? mysql ? mysqlDefaultClause(fragment(row.defaultValue, `${row.name} 的默认值`, { mysql }), type) : ` DEFAULT (${fragment(row.defaultValue, `${row.name} 的默认值`)})` : '';
      alter(`ADD COLUMN ${q(row.name)} ${type}${row.nullable ? '' : ' NOT NULL'}${def}${mysql && row.comment ? ` COMMENT ${literal(row.comment, true, details.mysql?.sqlMode)}` : ''}${position}`);
    } else {
      if (old.primaryKey && row.nullable) throw new Error(`主键 ${old.name} 不能设为可空`);
      if ((old.identity || old.generated) && ['dataType', 'defaultValue'].some((key) => !same(row, old, key))) throw new Error(`自增/生成字段 ${old.name} 的类型和表达式请使用 SQL 编辑器修改`);
      if (mysql && nativeColumns) {
        const native = nativeColumns.get(old.name);
        if (!native) throw new Error(`缺少字段 ${old.name} 的原生定义，请刷新结构后重试`);
        const definition = edited ? mysqlColumnChange(old, row, native, details.mysql.sqlMode,
          value => fragment(value, `${row.name} 的类型`, { type: true, mysql: true }),
          value => fragment(value, `${row.name} 的默认值`, { mysql: true })) : native.definition;
        alter(row.name !== old.name ? `CHANGE COLUMN ${q(old.name)} ${q(row.name)} ${definition}${position}` : `MODIFY COLUMN ${q(old.name)} ${definition}${position}`);
        continue;
      }
      if (position) throw new Error('缺少 MySQL 原生定义，无法调整已有字段顺序，请刷新结构后重试');
      if (mysql && ['dataType', 'nullable', 'defaultValue', 'comment'].some((key) => !same(row, old, key))) throw new Error('MySQL 已有字段当前支持改名、删除；其他属性请使用 SQL 编辑器');
      // Apply property changes before renaming, so all references use the old name.
      const col = q(old.name);
      if (!same(row, old, 'defaultValue') && !row.defaultValue.trim()) alter(`ALTER COLUMN ${col} DROP DEFAULT`);
      if (!same(row, old, 'dataType')) alter(`ALTER COLUMN ${col} TYPE ${fragment(row.dataType, `${row.name} 的类型`, { type: true })}`);
      if (!same(row, old, 'nullable')) alter(`ALTER COLUMN ${col} ${row.nullable ? 'DROP' : 'SET'} NOT NULL`);
      if (!same(row, old, 'defaultValue') && row.defaultValue.trim()) alter(`ALTER COLUMN ${col} SET DEFAULT (${fragment(row.defaultValue, `${row.name} 的默认值`)})`);
      if (!same(row, old, 'name')) alter(`RENAME COLUMN ${col} TO ${q(row.name)}`);
    }
    if (!mysql && (!old || !same(row, old, 'comment')) && (old || row.comment)) statements.push(`COMMENT ON COLUMN ${table}.${q(row.name)} IS ${row.comment ? literal(row.comment, false) : 'NULL'};`);
  }
  const tableCommentChanged = tableComment !== (details.comment ?? '');
  if (tableCommentChanged) {
    if (mysql) alter(`COMMENT = ${mysqlCommentLiteral(tableComment, details.mysql?.sqlMode, { table: true })}`);
    else statements.push(`COMMENT ON TABLE ${table} IS ${tableComment ? literal(tableComment, false) : 'NULL'};`);
  }
  for (const clause of addClauses) alter(`ADD ${clause}`);
  statements.push(...createIndexes);
  for (const clause of foreignKeys) alter(`ADD ${clause}`);
  const sql = mysql && clauses.length ? `ALTER TABLE ${table}\n  ${clauses.join(',\n  ')};` : statements.join('\n');
  return { sql, changed, dropped, tableCommentChanged, indexesChanged, constraintsChanged, keysDropped,
    positionedColumns: new Set(positions.keys()), ...(mysql ? mysqlSqlModeExpectation(sql, details.mysql?.sqlMode) : {}) };
}

export function buildCreateTablePlan({ schema, name, charset, collation, comment, mysql: mysqlMetadata }, rows, driver = 'postgres', keys) {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('此驱动暂不支持可视化建表');
  const mysql = driver === 'mysql';
  if (!name?.trim()) throw new Error('请输入表名');
  if (mysql ? [...name.trim()].length > 64 : new TextEncoder().encode(name.trim()).length > 63)
    throw new Error(mysql ? '表名不能超过 64 个字符' : '表名不能超过 63 字节（中文通常占 3 字节）');
  const q = (value) => identifier(String(value ?? ''), mysql);
  const table = `${q(schema)}.${q(name.trim())}`;
  const columns = rows.filter(row => !row.removed);
  if (!columns.length) throw new Error('请至少添加一个字段');
  const names = new Set();
  const primary = columns.filter(row => row.primaryKey);
  if (primary.length && keys?.constraints.some(row => row.kind === 'primary_key' && !row.removed)) throw new Error('每张表只能有一个主键');
  if (mysql && columns.filter(row => row.identity).length > 1) throw new Error('MySQL 只允许一个自增字段');
  const definitions = columns.map(row => {
    if (!row.name?.trim()) throw new Error('字段名不能为空');
    const key = mysql ? row.name.toLowerCase() : row.name;
    if (names.has(key)) throw new Error(`字段名重复：${row.name}`);
    names.add(key);
    const column = q(row.name);
    const type = fragment(row.dataType, `${row.name} 的类型`, { type: true, mysql });
    if (row.primaryKey && row.nullable) throw new Error(`主键 ${row.name} 不能设为可空`);
    const value = (row.defaultValue || '').trim();
    let generated = '';
    if (row.identity) {
      if (!(mysql ? /^(tinyint|smallint|mediumint|integer|int|bigint)(?:\(\d+\))?(?:\s+unsigned)?$/i : /^(smallint|integer|int|bigint)$/i).test(type)) throw new Error(`自增字段 ${row.name} 请使用整数类型`);
      if (value) throw new Error(`自增字段 ${row.name} 不能同时设置默认值`);
      if (mysql && (!row.primaryKey || primary[0] !== row)) throw new Error(`MySQL 自增字段 ${row.name} 必须是主键的第一列`);
      generated = mysql ? ' AUTO_INCREMENT' : ' GENERATED BY DEFAULT AS IDENTITY';
    }
    const def = value ? mysql ? mysqlDefaultClause(fragment(value, `${row.name} 的默认值`, { mysql }), type) : ` DEFAULT (${fragment(value, `${row.name} 的默认值`)})` : '';
    return `  ${column} ${type}${generated}${row.nullable ? '' : ' NOT NULL'}${def}${mysql && row.comment ? ` COMMENT ${literal(row.comment, true, mysqlMetadata?.sqlMode)}` : ''}`;
  });
  if (primary.length) definitions.push(`  PRIMARY KEY (${primary.map(row => q(row.name)).join(', ')})`);
  const { addClauses, createIndexes, foreignKeys, indexesChanged, constraintsChanged } =
    buildKeyChanges({ schema, name: name.trim() }, rows, keys, { mysql, q, validateExpression: (value, label) => fragment(value, `${label} 的检查表达式`, { mysql }) });
  definitions.push(...[...addClauses, ...(mysql ? foreignKeys : [])].map(clause => `  ${clause}`));
  const tableOptions = mysql ? ` ENGINE=InnoDB${mysqlCharacterClause(charset, collation)}${comment ? ` COMMENT=${mysqlCommentLiteral(comment, mysqlMetadata?.sqlMode, { table: true })}` : ''}` : '';
  const statements = [`CREATE TABLE ${table} (\n${definitions.join(',\n')}\n)${tableOptions};`];
  if (!mysql) statements.push(...createIndexes, ...foreignKeys.map(clause => `ALTER TABLE ${table} ADD ${clause};`));
  if (!mysql && comment) statements.push(`COMMENT ON TABLE ${table} IS ${literal(comment, false)};`);
  if (!mysql) for (const row of columns) {
    if (row.comment) statements.push(`COMMENT ON COLUMN ${table}.${q(row.name)} IS ${literal(row.comment, false)};`);
  }
  const sql = statements.join('\n');
  return { sql, name: name.trim(), changed: columns.length, indexesChanged, constraintsChanged, dropped: 0, ...(mysql ? mysqlSqlModeExpectation(sql, mysqlMetadata?.sqlMode) : {}) };
}

// Compare the catalog attributes that can influence an edit before applying it.
export function structureFingerprint(details) {
  return JSON.stringify({ id: details.id, schema: details.schema, name: details.name, kind: details.kind, comment: details.comment ?? '',
    mysql: details.mysql ? { ...details.mysql, definition: details.definition?.replace(/\sAUTO_INCREMENT=\d+(?=\s|$)/gi, '') } : null,
    columns: (details.columns || []).map((column) => Object.fromEntries([...editableKeys, 'primaryKey', 'identity', 'generated'].map((key) => [key, column[key] ?? null]))),
    indexes: details.indexes || [], constraints: details.constraints || [] });
}

const node = (tag, className = '', text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function openStructureEditor({ details, driver, targetLabel, onApply, onClose, confirmDiscard, create = false, mysqlCharacterSettings = null }) {
  const newCreateRow = values => ({ defaultMode: 'none', defaultInput: '', defaultError: '', typeParameterError: '', typeParameterDraft: null, defaultDraft: null, ...values });
  const rows = create ? [newCreateRow({ name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true, defaultValue: '', comment: '' })] : createStructureDraft(details);
  const keys = structureKeyDrafts(details, rows, driver);
  const initialRows = JSON.stringify(rows);
  const originalTableComment = details.comment ?? '';
  let tableComment = originalTableComment;
  const canReorder = !create && driver === 'mysql' && Boolean(details.mysql && details.definition);
  const fields = create ? ['name', 'dataType', 'primaryKey', 'identity', 'nullable', 'defaultValue', 'comment'] : editableKeys;
  const fieldLabels = { name: '名称', dataType: '类型', nullable: '可空', defaultValue: '默认值', comment: '备注', primaryKey: '主键', identity: '自增' };
  const labelControl = (control, label) => { if (control?.getAttribute('aria-label') !== label) control?.setAttribute('aria-label', label); };
  const dialog = node('dialog', 'structure-editor-dialog');
  if (create) dialog.classList.add('create-table-dialog');
  if (canReorder) dialog.classList.add('reorder-columns');
  dialog.setAttribute('aria-label', create ? '新建表' : `编辑表结构 ${details.qualifiedName}`);
  const form = node('form', 'structure-editor-form');
  const header = node('div', 'dialog-header');
  const title = node('h2', '', create ? '新建表' : `编辑表结构 · ${details.name}`); header.append(title);
  const close = node('button', 'icon-btn', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭结构编辑'); header.append(close);
  const target = node('p', 'structure-editor-target', targetLabel);
  const note = node('p', 'form-note', create ? ''
    : driver === 'mysql'
    ? canReorder ? '用 ↑ 和 ↓ 调整字段顺序。MySQL DDL 会隐式提交。' : '支持新增字段、删除字段、改名（MySQL 8+）。已有字段的其他属性保留原样，请通过 SQL 编辑器修改。DDL 会直接提交。'
    : '默认值填写 SQL 表达式（文本用单引号）。留空表示无默认值。');
  const toolbar = node('div', 'structure-editor-toolbar');
  const add = node('button', 'secondary-btn', '＋ 添加字段'); add.type = 'button';
  const count = node('span', 'form-note'); toolbar.append(add, count);
  const scroller = node('div', 'structure-editor-scroll');
  const table = node('table', 'structure-table structure-editor-table');
  table.innerHTML = `<thead><tr><th>状态</th><th>名称</th><th>类型</th>${create ? '<th>主键</th><th>自增</th>' : ''}<th>可空</th><th>默认值 / 表达式</th><th>备注</th><th>操作</th></tr></thead>`;
  const tbody = node('tbody'); table.append(tbody); scroller.append(table);
  const typePopup = node('div', 'column-type-menu'); typePopup.id = `column-type-menu-${crypto.randomUUID?.() || Date.now()}`;
  typePopup.setAttribute('role', 'listbox'); typePopup.setAttribute('aria-label', '匹配的数据类型'); typePopup.hidden = true;
  const previewBox = node('details', 'structure-sql-preview'); previewBox.open = !create;
  const previewTitle = node('summary', '', 'SQL 预览'); previewBox.append(previewTitle);
  const preview = node('pre'); previewBox.append(preview);
  const validation = node('p', 'structure-validation');
  validation.setAttribute('role', 'status');
  validation.hidden = true;
  const feedback = node('p', 'dialog-feedback'); feedback.setAttribute('role', 'status');
  const footer = node('div', 'structure-editor-footer');
  const cancel = node('button', 'secondary-btn', '取消'); cancel.type = 'button';
  const submit = node('button', 'primary-btn', create ? '创建表' : '保存'); submit.type = 'submit';
  const naming = node('div', 'connection-form structure-table-naming'); naming.hidden = !create;
  const nameLabel = node('label', '', '表名');
  const nameInput = node('input'); nameInput.type = 'text'; nameInput.autocomplete = 'off'; nameInput.placeholder = '例如：orders'; nameInput.setAttribute('aria-label', '表名');
  nameLabel.append(nameInput);
  const tableCommentField = node('label', 'structure-table-comment', '表注释');
  const tableCommentInput = node('textarea');
  tableCommentInput.rows = 2;
  tableCommentInput.placeholder = '说明这张表的用途';
  tableCommentInput.value = tableComment;
  tableCommentField.append(tableCommentInput);
  const characterPicker = create && driver === 'mysql' && mysqlCharacterSettings ? createMysqlCharacterPicker(mysqlCharacterSettings, '继承数据库默认值') : null;
  naming.append(nameLabel, tableCommentField);
  if (characterPicker) {
    const characterOptions = node('details', 'structure-key-wide structure-table-charset');
    characterOptions.append(node('summary', '', '字符集与排序规则'), characterPicker.element);
    naming.append(characterOptions);
  }
  footer.append(cancel, submit);
  form.append(header, target);
  const fieldsPanel = node('div', 'structure-fields-panel');
  if (create) fieldsPanel.append(naming);
  else fieldsPanel.append(tableCommentField, note);
  fieldsPanel.append(toolbar, scroller);
  const keyEditors = ['indexes', 'constraints'].map(id => ({
    id,
    label: id === 'indexes' ? '索引' : '约束',
    editor: createStructureKeyEditor(keys[id], rows, driver, id, () => update(), { create }),
  }));
  mountStructureTabs(form, [
    { id: 'fields', label: '字段', content: fieldsPanel },
    ...keyEditors.map(({ id, label, editor }) => ({ id, label, content: editor.content })),
    ...(create ? [] : structureMetadataTabs(details, driver).filter(({ id }) => !['indexes', 'constraints'].includes(id))),
  ]);
  form.append(previewBox, validation, feedback, footer);
  dialog.append(form, typePopup); document.body.append(dialog);
  const commentEditor = createStructureCommentEditor({ parent: dialog });
  let busy = false;
  let plan;
  let activeTypeInput = null;
  let activeTypeOptions = [];
  let activeTypeIndex = -1;
  const createControls = new Map();
  const commentControls = new Map();
  const syncCommentControls = () => {
    for (const [row, controls] of commentControls) {
      const name = row.name || '新字段', comment = String(row.comment ?? ''), multiline = /[\r\n]/u.test(comment);
      const visible = multiline ? comment.replace(/\r\n?|\n/gu, ' ⏎ ') : comment;
      controls.input.readOnly = multiline;
      if (controls.input.value !== visible) controls.input.value = visible;
      controls.input.title = comment;
      controls.expand.disabled = busy || controls.input.disabled;
      labelControl(controls.input, `${name} · 备注`);
      labelControl(controls.expand, `${name} · 展开备注`);
    }
  };
  const defaultSql = row => {
    try { row.defaultValue = createDefaultSql(row.defaultMode, row.defaultInput, driver); row.defaultError = ''; }
    catch (error) { row.defaultError = error.message; }
  };
  const setIdentity = (row, enabled) => {
    if (enabled === Boolean(row.identity)) return;
    row.identity = enabled;
    if (enabled) {
      row.defaultDraft = { mode: row.defaultMode, text: row.defaultInput };
      row.defaultMode = 'none'; row.defaultInput = ''; row.nullable = false;
      if (driver === 'mysql') row.primaryKey = true;
    } else if (row.defaultDraft) {
      row.defaultMode = row.defaultDraft.mode === 'null' && !row.nullable ? 'none' : row.defaultDraft.mode;
      row.defaultInput = row.defaultDraft.text; row.defaultDraft = null;
    }
    defaultSql(row);
  };
  const syncCreateControls = () => {
    if (!create) return;
    for (const [index, row] of rows.entries()) {
      const controls = createControls.get(row); if (!controls) continue;
      const name = row.name || '新字段';
      for (const [field, control] of Object.entries(controls.inputs)) labelControl(control, `${name} · ${fieldLabels[field]}`);
      for (const field of ['name', 'dataType']) {
        const control = controls.inputs[field];
        if (control.title !== control.value) control.title = control.value;
      }
      labelControl(controls.defaultMode, `${name} · 默认值模式`);
      labelControl(controls.presets, `${name} · 常用默认值`);
      const precedingPrimary = driver === 'mysql' && rows.slice(0, index).some(other => !other.removed && other.primaryKey);
      controls.identity.disabled = busy || (!row.identity && (!isIdentityType(row.dataType, driver) || precedingPrimary));
      controls.identity.title = precedingPrimary ? 'MySQL 自增字段必须是主键的第一列' : !isIdentityType(row.dataType, driver) ? '自增仅支持整数类型' : '';
      controls.identity.checked = Boolean(row.identity);
      controls.primaryKey.checked = Boolean(row.primaryKey);
      controls.nullable.checked = Boolean(row.nullable);
      controls.nullable.disabled = busy || Boolean(row.primaryKey || row.identity);
      controls.defaultMode.disabled = busy || Boolean(row.identity);
      if (controls.defaultMode.value !== row.defaultMode) controls.defaultMode.value = row.defaultMode;
      controls.nullOption.disabled = !row.nullable;
      controls.defaultInput.disabled = busy || row.identity || ['none', 'null'].includes(row.defaultMode);
      controls.defaultValueRow.hidden = ['none', 'null'].includes(row.defaultMode);
      controls.defaultInput.placeholder = row.identity ? '数据库自动生成' : row.defaultMode === 'text' ? '文本值（可留空）' : row.defaultMode === 'expression' ? 'SQL 表达式' : row.defaultMode === 'null' ? 'NULL' : '无默认值';
      const displayedDefault = ['none', 'null'].includes(row.defaultMode) ? '' : row.defaultInput;
      if (controls.defaultInput.value !== displayedDefault) controls.defaultInput.value = displayedDefault;
      if (controls.defaultInput.title !== displayedDefault) controls.defaultInput.title = displayedDefault;
      controls.presets.hidden = row.defaultMode !== 'expression';
      controls.syncParameters();
    }
  };
  const closeTypeMenu = () => {
    typePopup.hidden = true;
    activeTypeInput?.setAttribute('aria-expanded', 'false');
    activeTypeInput?.removeAttribute('aria-activedescendant');
    dialog.querySelectorAll('.column-type-trigger').forEach(button => button.setAttribute('aria-expanded', 'false'));
    activeTypeInput = null; activeTypeOptions = []; activeTypeIndex = -1;
  };
  const positionTypeMenu = () => {
    if (typePopup.hidden || !activeTypeInput) return;
    const rect = activeTypeInput.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    const modal = dialog.getBoundingClientRect();
    const headerBottom = table.tHead?.getBoundingClientRect().bottom || bounds.top;
    const visible = { left: Math.max(0, bounds.left, modal.left), right: Math.min(window.innerWidth, bounds.right, modal.right),
      top: Math.max(0, bounds.top, headerBottom, modal.top), bottom: Math.min(window.innerHeight, bounds.bottom, modal.bottom) };
    if (!activeTypeInput.isConnected || rect.right <= visible.left || rect.left >= visible.right || rect.bottom <= visible.top || rect.top >= visible.bottom) {
      closeTypeMenu(); return;
    }
    const width = Math.min(380, Math.max(230, window.innerWidth - 24));
    const gap = 4;
    const edge = 12;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
    const spaceAbove = Math.max(0, rect.top - gap - edge);
    const openBelow = spaceBelow >= Math.min(280, Math.max(140, spaceAbove));
    const availableHeight = Math.max(120, Math.min(320, openBelow ? spaceBelow : spaceAbove));
    typePopup.style.width = `${width}px`;
    typePopup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    typePopup.style.maxHeight = `${availableHeight}px`;
    typePopup.style.top = `${openBelow ? rect.bottom + gap : Math.max(edge, rect.top - availableHeight - gap)}px`;
  };
  const updateTypeSelection = () => typePopup.querySelectorAll('[role="option"]').forEach((option, index) => {
    option.setAttribute('aria-selected', String(index === activeTypeIndex));
    if (index === activeTypeIndex) activeTypeInput?.setAttribute('aria-activedescendant', option.id);
  });
  const filterTypes = (input, query = input.value) => {
    activeTypeInput = input; activeTypeOptions = []; activeTypeIndex = -1;
    input.setAttribute('aria-expanded', 'true');
    dialog.querySelectorAll('.column-type-trigger').forEach(button => button.setAttribute('aria-expanded', String(button.previousElementSibling === input)));
    typePopup.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    const options = searchColumnTypes(driver, query, { commonFirst: create });
    if (!options.length) typePopup.append(node('div', 'column-type-empty', `没有匹配项。仍可直接输入数据库自定义类型：${query}`));
    let previousGroup = '';
    for (const option of create ? options : options.slice(0, 24)) {
      if (option.group !== previousGroup) { typePopup.append(node('div', 'column-type-group', option.group)); previousGroup = option.group; }
      const button = node('button', 'column-type-option'); button.type = 'button'; button.tabIndex = -1; button.setAttribute('role', 'option'); button.dataset.value = option.value;
      button.id = `${typePopup.id}-option-${activeTypeOptions.length}`;
      const copy = node('span', 'column-type-copy'); copy.append(node('strong', '', option.value), node('small', '', option.label)); button.append(copy);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', event => {
        event.preventDefault(); input.value = option.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (create) input.dispatchEvent(new Event('change', { bubbles: true }));
        closeTypeMenu(); input.focus();
      });
      typePopup.append(button); activeTypeOptions.push(button);
    }
    typePopup.append(node('div', 'column-type-footnote', '输入可筛选类型、关键字或精度；也可直接填写自定义类型'));
    typePopup.hidden = false; positionTypeMenu(); updateTypeSelection();
  };
  const update = () => {
    syncCommentControls();
    syncCreateControls();
    for (const { editor } of keyEditors) editor.update();
    try {
      if (create) {
        const invalid = rows.find(row => row.defaultError || row.typeParameterError);
        if (invalid) throw new Error(`${invalid.name || '新字段'}：${invalid.typeParameterError || invalid.defaultError}`);
      }
      plan = create ? buildCreateTablePlan({ ...details, comment: tableComment, name: nameInput.value || '<表名>', ...(characterPicker?.value() || {}) }, rows, driver, keys) : buildStructurePlan(details, rows, driver, tableComment, keys);
      setSelectableText(preview, plan.sql || '尚未修改结构');
      validation.hidden = true;
      count.textContent = `${rows.filter((row) => !row.removed).length} 个字段${create ? '' : ` · ${plan.changed} 项字段变更`}${plan.dropped ? ` · 删除 ${plan.dropped} 列` : ''}`;
      submit.disabled = busy || !plan.sql || (create && !nameInput.value.trim());
    } catch (error) {
      plan = null;
      setSelectableText(preview, error.message);
      validation.textContent = error.message;
      validation.hidden = false;
      submit.disabled = true;
      count.textContent = '';
    }
    for (const [index, row] of rows.entries()) {
      const tr = tbody.children[index];
      if (!tr) continue;
      const repositioned = plan?.positionedColumns?.has(row);
      tr.classList.toggle('removed', Boolean(row.removed));
      tr.classList.toggle('changed', changedColumn(row) || Boolean(repositioned));
      tr.querySelector('[data-column-status]').textContent = row.removed ? '待删除' : !row.original ? '新增' : changedColumn(row) ? '已修改' : repositioned ? '已调整' : row.primaryKey ? 'PK' : row.identity ? '自增' : row.generated ? '生成' : '—';
      for (const button of tr.querySelectorAll('[data-move-column]')) {
        labelControl(button, `${row.name || '新字段'} · ${button.title}`);
      }
    }
  };
  characterPicker?.element.addEventListener('change', () => update());
  nameInput.addEventListener('input', () => { feedback.textContent = ''; update(); });
  tableCommentInput.addEventListener('input', () => { tableComment = tableCommentInput.value; feedback.textContent = ''; update(); });
  const renderRows = () => {
    closeTypeMenu();
    createControls.clear();
    commentControls.clear();
    tbody.replaceChildren();
    const activeRows = canReorder ? rows.filter(row => !row.removed) : [];
    rows.forEach((row, index) => {
      const tr = node('tr'); const status = node('td'); status.dataset.columnStatus = ''; tr.append(status);
      const controls = { inputs: {} }; if (create) createControls.set(row, controls);
      for (const key of fields) {
        const td = node('td'); const input = node('input'); input.dataset.field = key; input.dataset.fieldRow = String(index);
        input.setAttribute('aria-label', `${row.name || '新字段'} · ${fieldLabels[key]}`);
        if (create) controls.inputs[key] = input;
        const checkbox = ['nullable', 'primaryKey', 'identity'].includes(key);
        input.type = checkbox ? 'checkbox' : 'text';
        if (checkbox) input.checked = Boolean(row[key]); else input.value = row[key] ?? '';
        let typeTrigger = null;
        if (key === 'dataType') {
          input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
          input.setAttribute('aria-haspopup', 'listbox'); input.setAttribute('aria-controls', typePopup.id); input.setAttribute('aria-expanded', 'false');
          input.placeholder = '搜索或输入类型';
          typeTrigger = node('button', 'column-type-trigger', '⌄'); typeTrigger.type = 'button';
          typeTrigger.setAttribute('aria-label', '选择数据类型'); typeTrigger.setAttribute('aria-controls', typePopup.id); typeTrigger.setAttribute('aria-expanded', 'false');
          typeTrigger.disabled = input.disabled;
          typeTrigger.addEventListener('click', () => {
            if (!typePopup.hidden && activeTypeInput === input) closeTypeMenu();
            else { input.focus(); filterTypes(input, ''); }
          });
          input.addEventListener('focus', () => { if (create) input.select(); filterTypes(input, create ? '' : input.value); });
          if (create) input.addEventListener('change', () => {
            if (!isIdentityType(row.dataType, driver)) setIdentity(row, false);
            update();
          });
          input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (typePopup.hidden || activeTypeInput !== input) filterTypes(input);
              else if (activeTypeOptions.length) {
                activeTypeIndex = activeTypeIndex < 0
                  ? (event.key === 'ArrowDown' ? 0 : activeTypeOptions.length - 1)
                  : (activeTypeIndex + (event.key === 'ArrowDown' ? 1 : -1) + activeTypeOptions.length) % activeTypeOptions.length;
                updateTypeSelection(); activeTypeOptions[activeTypeIndex].scrollIntoView({ block: 'nearest' });
              }
            } else if (event.key === 'Enter' && !typePopup.hidden && activeTypeInput === input) {
              event.preventDefault();
              if (activeTypeIndex >= 0) activeTypeOptions[activeTypeIndex].click();
              else closeTypeMenu();
            } else if (event.key === 'Escape' && !typePopup.hidden && activeTypeInput === input) {
              event.preventDefault(); closeTypeMenu();
            }
          });
        }
        if (key === 'defaultValue') input.placeholder = row.identity ? '数据库自动生成' : '无默认值';
        if (!create && (row.identity || row.generated) && ['dataType', 'defaultValue'].includes(key)) input.title = '自增或生成字段：保留数据库定义，可通过 SQL 编辑器修改';
        input.disabled = Boolean(row.removed || (row.original && driver === 'mysql' && !details.mysql && key !== 'name') ||
          (row.primaryKey && key === 'nullable') || (!create && (row.identity || row.generated) && ['dataType', 'defaultValue'].includes(key)));
        if (typeTrigger) typeTrigger.disabled = input.disabled;
        input.addEventListener('input', () => {
          if (create) {
            if (key === 'identity') {
              if (input.checked && driver === 'mysql') for (const other of rows) if (other !== row && other.identity) setIdentity(other, false);
              setIdentity(row, input.checked);
            } else if (key === 'defaultValue') { row.defaultInput = input.value; defaultSql(row); }
            else row[key] = checkbox ? input.checked : input.value;
            if (key === 'primaryKey') {
              if (row.primaryKey) row.nullable = false;
              else if (driver === 'mysql') setIdentity(row, false);
            }
            if (key === 'dataType') {
              row.typeParameterError = ''; row.typeParameterDraft = null;
            }
            if (!row.nullable && row.defaultMode === 'null') { row.defaultMode = 'none'; defaultSql(row); }
            feedback.textContent = '';
            if (key === 'dataType' && !typePopup.hidden && activeTypeInput === input) filterTypes(input);
            update(); return;
          }
          row[key] = checkbox ? input.checked : input.value; feedback.textContent = '';
          if (key === 'primaryKey') {
            if (row.primaryKey) row.nullable = false;
            const nullable = tr.querySelector('[data-field="nullable"]');
            nullable.checked = Boolean(row.nullable); nullable.disabled = Boolean(row.primaryKey);
          }
          if (key === 'dataType' && !typePopup.hidden && activeTypeInput === input) filterTypes(input);
          update();
        });
        if (key === 'dataType') {
          const picker = node('div', 'column-type-picker'); picker.append(input, typeTrigger);
          if (create) {
            const parameters = node('div', 'column-type-parameters');
            const control = node('div', 'column-type-control'); control.append(picker, parameters); td.append(control);
            let parameterKind = null;
            controls.syncParameters = () => {
              const config = getTypeParameters(row.dataType);
              const kind = config?.kind || null;
              if (parameterKind !== kind) {
                parameterKind = kind; parameters.replaceChildren();
                for (const [parameter, label] of kind === 'length' ? [['length', '长度']] : kind === 'decimal' ? [['precision', '精度'], ['scale', '小数位']] : []) {
                  const field = node('label', '', label); const value = node('input'); value.type = 'number'; value.min = parameter === 'scale' ? '0' : '1'; value.step = '1';
                  value.dataset.typeParameter = parameter; value.setAttribute('aria-label', `${row.name || '新字段'} · ${label}`);
                  value.addEventListener('input', () => {
                    const values = Object.fromEntries([...parameters.querySelectorAll('input')].map(control => [control.dataset.typeParameter, control.value]));
                    row.typeParameterDraft = values;
                    try {
                      row.dataType = updateTypeParameters(row.dataType, values); row.typeParameterError = ''; row.typeParameterDraft = null;
                      input.value = row.dataType;
                    } catch (error) { row.typeParameterError = error.message; }
                    feedback.textContent = ''; update();
                  });
                  const stepper = node('span', 'column-parameter-stepper');
                  for (const [direction, glyph, action] of [[-1, '−', '减少'], [1, '+', '增加']]) {
                    const button = node('button', 'column-parameter-step', glyph);
                    button.type = 'button';
                    button.dataset.parameterStep = String(direction);
                    button.setAttribute('aria-label', `${row.name || '新字段'} · ${action}${label}`);
                    button.title = `${action}${label}`;
                    button.addEventListener('pointerdown', event => event.preventDefault());
                    button.addEventListener('click', () => {
                      if (value.disabled) return;
                      const min = BigInt(value.min || '0');
                      const current = /^\d+$/.test(value.value) ? BigInt(value.value) : null;
                      const next = current === null ? min : current + BigInt(direction);
                      value.value = String(next < min ? min : next);
                      value.dispatchEvent(new Event('input', { bubbles: true }));
                    });
                    if (direction < 0) stepper.append(button, value);
                    else stepper.append(button);
                  }
                  field.append(stepper); parameters.append(field);
                }
              }
              parameters.hidden = !kind;
              for (const value of parameters.querySelectorAll('input')) {
                labelControl(value, `${row.name || '新字段'} · ${({ length: '长度', precision: '精度', scale: '小数位' })[value.dataset.typeParameter]}`);
                const current = (row.typeParameterDraft || config)[value.dataset.typeParameter];
                if (document.activeElement !== value && value.value !== current) value.value = current;
                value.disabled = busy;
                const label = ({ length: '长度', precision: '精度', scale: '小数位' })[value.dataset.typeParameter];
                for (const button of value.parentElement.querySelectorAll('[data-parameter-step]')) {
                  const action = button.dataset.parameterStep === '1' ? '增加' : '减少';
                  labelControl(button, `${row.name || '新字段'} · ${action}${label}`);
                  const minimum = BigInt(value.min || '0');
                  const atMinimum = /^\d+$/.test(value.value) && BigInt(value.value) <= minimum;
                  button.disabled = busy || (button.dataset.parameterStep === '-1' && atMinimum);
                }
              }
            };
          } else td.append(picker);
        } else if (create && key === 'defaultValue') {
          const wrapper = node('div', 'column-default-control');
          const mode = node('select'); mode.dataset.defaultMode = ''; mode.setAttribute('aria-label', `${row.name || '新字段'} · 默认值模式`);
          for (const [value, label] of [['none', '无默认值'], ['text', '文本值'], ['null', 'NULL'], ['expression', '表达式']]) {
            const option = node('option', '', label); option.value = value; mode.append(option);
            if (value === 'null') controls.nullOption = option;
          }
          mode.value = row.defaultMode;
          mode.addEventListener('change', () => { row.defaultMode = mode.value; defaultSql(row); feedback.textContent = ''; update(); });
          const valueRow = node('div', 'column-default-value');
          const presets = node('select'); presets.dataset.defaultPreset = ''; presets.setAttribute('aria-label', '选择常用默认值'); presets.title = '选择常用默认值';
          for (const value of ['', '0', '1', 'FALSE', 'TRUE', 'CURRENT_TIMESTAMP']) { const option = node('option', '', value || '常用值'); option.value = value; presets.append(option); }
          presets.addEventListener('change', () => {
            if (!presets.value) return;
            row.defaultInput = presets.value; defaultSql(row); presets.value = ''; update(); input.focus();
          });
          valueRow.append(input, presets); wrapper.append(mode, valueRow); td.append(wrapper);
          controls.defaultMode = mode; controls.defaultInput = input; controls.defaultValueRow = valueRow; controls.presets = presets;
        } else if (key === 'comment') {
          const control = node('div', 'column-comment-control');
          const expand = node('button', 'icon-btn column-comment-expand', '⤢'); expand.type = 'button'; expand.title = '展开备注';
          const openComment = anchor => commentEditor.open({ value: row.comment || '', fieldName: row.name || '新字段', anchor,
            onChange(value) { row.comment = value; feedback.textContent = ''; update(); } });
          expand.addEventListener('click', () => openComment(expand));
          input.addEventListener('click', () => { if (input.readOnly) openComment(input); });
          input.addEventListener('keydown', event => {
            if (!input.readOnly || event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
            event.preventDefault(); event.stopPropagation(); openComment(input);
          });
          input.addEventListener('paste', event => {
            const text = event.clipboardData?.getData('text/plain');
            if (input.readOnly || !/[\r\n]/u.test(text || '')) return;
            event.preventDefault();
            const original = String(row.comment ?? ''), start = input.selectionStart ?? original.length, end = input.selectionEnd ?? start;
            row.comment = original.slice(0, start) + text + original.slice(end);
            feedback.textContent = ''; update(); openComment(input);
          });
          control.append(input, expand); td.append(control);
          commentControls.set(row, { input, expand });
        } else td.append(input);
        if (create && ['primaryKey', 'identity', 'nullable'].includes(key)) controls[key] = input;
        tr.append(td);
      }
      const td = node('td'); const remove = node('button', 'quiet-btn', row.removed ? '撤销删除' : '删除'); remove.type = 'button';
      remove.addEventListener('click', () => { if (row.original) row.removed = !row.removed; else rows.splice(index, 1); renderRows(); });
      if (canReorder && !row.removed) {
        const actions = node('div', 'structure-column-order');
        const activeIndex = activeRows.indexOf(row);
        for (const [step, symbol, label] of [[-1, '↑', '上移'], [1, '↓', '下移']]) {
          const neighbor = activeRows[activeIndex + step];
          const move = node('button', 'icon-btn', symbol);
          move.type = 'button';
          move.title = label;
          move.dataset.moveColumn = String(step);
          move.disabled = !neighbor;
          move.addEventListener('click', () => {
            const targetIndex = rows.indexOf(neighbor);
            [rows[targetIndex], rows[index]] = [rows[index], rows[targetIndex]];
            feedback.textContent = '';
            renderRows();
            const available = [...tbody.children[targetIndex].querySelectorAll('[data-move-column]:enabled')];
            (available.find(button => button.dataset.moveColumn === String(step)) || available[0])?.focus();
          });
          actions.append(move);
        }
        actions.append(remove);
        td.append(actions);
      } else td.append(remove);
      tr.append(td); tbody.append(tr);
    });
    update();
  };
  add.addEventListener('click', () => {
    const row = { name: '', dataType: driver === 'mysql' ? 'varchar(255)' : 'text', nullable: true, defaultValue: '', comment: '' };
    rows.push(create ? newCreateRow(row) : row);
    renderRows(); tbody.lastElementChild.querySelector('input').focus();
  });
  const dismiss = async () => {
    if (busy) return;
    const changed = (create ? nameInput.value.trim() || JSON.stringify(rows) !== initialRows : plan?.sql || rows.some(changedColumn))
      || [...keys.indexes, ...keys.constraints].some(structureKeyChanged);
    if ((changed || tableComment !== originalTableComment) && !await confirmDiscard()) return;
    dialog.close();
  };
  dialog.addEventListener('pointerdown', event => {
    if (!event.target.closest('.column-type-picker') && !event.target.closest('.column-type-menu')) closeTypeMenu();
  });
  dialog.addEventListener('focusout', event => {
    if (typePopup.hidden) return;
    const next = event.relatedTarget;
    if (!next || (!activeTypeInput?.closest('.column-type-picker')?.contains(next) && !typePopup.contains(next))) closeTypeMenu();
  });
  scroller.addEventListener('scroll', positionTypeMenu, { passive: true });
  dialog.addEventListener('scroll', positionTypeMenu, { passive: true });
  window.addEventListener('resize', positionTypeMenu);
  close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('close', () => { closeTypeMenu(); commentEditor?.destroy(); window.removeEventListener('resize', positionTypeMenu); dialog.remove(); onClose(); }, { once: true });
  form.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
    if (event.target.matches('input[type="text"], input[type="number"]')) event.preventDefault();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !plan?.sql) return;
    busy = true;
    const fields = [...dialog.querySelectorAll('input, textarea, select, button')].map((element) => [element, element.disabled]);
    for (const [element] of fields) element.disabled = true;
    feedback.classList.remove('error'); feedback.textContent = '正在准备提交…';
    try {
      if (await onApply(plan)) dialog.close();
      else feedback.textContent = '已取消提交，编辑内容已保留';
    } catch (error) { feedback.textContent = `未能应用：${error.message || error}`; feedback.classList.add('error'); }
    finally { busy = false; for (const [element, disabled] of fields) element.disabled = disabled; update(); }
  });
  renderRows(); dialog.showModal();
  if (create) tbody.querySelector('[data-field="name"]')?.focus({ preventScroll: true });
}
