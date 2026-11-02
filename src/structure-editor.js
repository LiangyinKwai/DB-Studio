import { mysqlCharacterClause, createMysqlCharacterPicker } from './mysql-character-settings.js';
import { setSelectableText } from './selectable-text.js';
import { mysqlColumns, mysqlColumnChange, mysqlDefaultClause } from './mysql-ddl.js';

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
    if (c === ';' || c === '$' || text.slice(i, i + 2) === '--' || text.slice(i, i + 2) === '/*') throw new Error(`${label}只能填写一个${type ? '类型' : '表达式'}，不能包含语句或注释`);
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) throw new Error(`${label}括号不匹配`);
    if (c === ',' && depth === 0) throw new Error(`${label}不能包含额外字段定义`);
    outer += c;
  }
  if (quote || depth) throw new Error(`${label}引号或括号不匹配`);
  if (type && (!text || !/^[\w\s.()[\],]+$/u.test(outer) || /\b(?:default|null|primary|unique|references|check|constraint|generated|auto_increment|comment|collate|add|drop|rename|alter)\b/i.test(outer)))
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
const literal = (value, mysql) => {
  const text = String(value);
  if (text.includes('\0') || (mysql && text.includes('\\'))) throw new Error('备注包含不支持的字符，请使用 SQL 编辑器');
  return mysql ? `'${text.replaceAll("'", "''")}'` : `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};

export function buildStructurePlan(details, rows, driver = 'postgres') {
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
  let changed = 0;
  let dropped = 0;
  for (const row of rows) {
    const old = row.original;
    if (!changedColumn(row)) continue;
    changed++;
    if (row.removed) {
      if (old) { alter(`DROP COLUMN ${q(old.name)}`); dropped++; }
      continue;
    }
    if (!old) {
      const type = fragment(row.dataType, `${row.name} 的类型`, { type: true, mysql });
      const def = row.defaultValue.trim() ? mysql ? mysqlDefaultClause(fragment(row.defaultValue, `${row.name} 的默认值`, { mysql }), type) : ` DEFAULT (${fragment(row.defaultValue, `${row.name} 的默认值`)})` : '';
      alter(`ADD COLUMN ${q(row.name)} ${type}${row.nullable ? '' : ' NOT NULL'}${def}${mysql && row.comment ? ` COMMENT ${literal(row.comment, true)}` : ''}`);
    } else {
      if (old.primaryKey && row.nullable) throw new Error(`主键 ${old.name} 不能设为可空`);
      if ((old.identity || old.generated) && ['dataType', 'defaultValue'].some((key) => !same(row, old, key))) throw new Error(`自增/生成字段 ${old.name} 的类型和表达式请使用 SQL 编辑器修改`);
      if (mysql && nativeColumns) {
        const definition = mysqlColumnChange(old, row, nativeColumns.get(old.name), details.mysql.sqlMode,
          value => fragment(value, `${row.name} 的类型`, { type: true, mysql: true }),
          value => fragment(value, `${row.name} 的默认值`, { mysql: true }));
        alter(row.name !== old.name ? `CHANGE COLUMN ${q(old.name)} ${q(row.name)} ${definition}` : `MODIFY COLUMN ${q(old.name)} ${definition}`);
        continue;
      }
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
  return { sql: mysql && clauses.length ? `ALTER TABLE ${table}\n  ${clauses.join(',\n  ')};` : statements.join('\n'), changed, dropped };
}

export function buildCreateTablePlan({ schema, name, charset, collation }, rows, driver = 'postgres') {
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
    return `  ${column} ${type}${generated}${row.nullable ? '' : ' NOT NULL'}${def}${mysql && row.comment ? ` COMMENT ${literal(row.comment, true)}` : ''}`;
  });
  if (primary.length) definitions.push(`  PRIMARY KEY (${primary.map(row => q(row.name)).join(', ')})`);
  const statements = [`CREATE TABLE ${table} (\n${definitions.join(',\n')}\n)${mysql ? ` ENGINE=InnoDB${mysqlCharacterClause(charset, collation)}` : ''};`];
  if (!mysql) for (const row of columns) {
    if (row.comment) statements.push(`COMMENT ON COLUMN ${table}.${q(row.name)} IS ${literal(row.comment, false)};`);
  }
  return { sql: statements.join('\n'), name: name.trim(), changed: columns.length, dropped: 0 };
}

// Compare the catalog attributes that can influence an edit before applying it.
export function structureFingerprint(details) {
  return JSON.stringify({ id: details.id, schema: details.schema, name: details.name, kind: details.kind,
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
  const rows = create ? [{ name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true, defaultValue: '', comment: '' }] : createStructureDraft(details);
  const initialRows = JSON.stringify(rows);
  const fields = create ? ['name', 'dataType', 'primaryKey', 'identity', 'nullable', 'defaultValue', 'comment'] : editableKeys;
  const dialog = node('dialog', 'structure-editor-dialog');
  if (create) dialog.classList.add('create-table-dialog');
  dialog.setAttribute('aria-label', create ? '新建表' : `编辑表结构 ${details.qualifiedName}`);
  const form = node('form', 'structure-editor-form');
  const header = node('div', 'dialog-header');
  const title = node('h2', '', create ? '新建表' : `编辑表结构 · ${details.name}`); header.append(title);
  const close = node('button', 'icon-btn', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭结构编辑'); header.append(close);
  const target = node('p', 'structure-editor-target', targetLabel);
  const note = node('p', 'form-note', create ? '先设计字段，保存时再填写表名。默认值使用 SQL 表达式，文本请加单引号。'
    : driver === 'mysql'
    ? details.mysql ? '支持字段新增、改名、类型、可空、默认值和备注修改；保留原生字符集、排序规则及其他字段属性。MySQL DDL 会隐式提交，不能回滚。' : '支持新增字段、删除字段、改名（MySQL 8+）。已有字段的其他属性保留原样，请通过 SQL 编辑器修改。DDL 会直接提交。'
    : '编辑字段后预览并应用。默认值填写 SQL 表达式（文本用单引号）；留空表示无默认值。索引、主键和外键请通过 SQL 编辑器修改。');
  const toolbar = node('div', 'structure-editor-toolbar');
  const add = node('button', 'secondary-btn', '＋ 添加字段'); add.type = 'button';
  const count = node('span', 'form-note'); toolbar.append(add, count);
  const scroller = node('div', 'structure-editor-scroll');
  const table = node('table', 'structure-table structure-editor-table');
  table.innerHTML = `<thead><tr><th>状态</th><th>名称</th><th>类型</th>${create ? '<th>主键</th><th>自增</th>' : ''}<th>可空</th><th>默认值 / 表达式</th><th>备注</th><th>操作</th></tr></thead>`;
  const tbody = node('tbody'); table.append(tbody); scroller.append(table);
  const typePopup = node('div', 'column-type-menu'); typePopup.id = `column-type-menu-${crypto.randomUUID?.() || Date.now()}`;
  typePopup.setAttribute('role', 'listbox'); typePopup.setAttribute('aria-label', '匹配的数据类型'); typePopup.hidden = true;
  const previewBox = node('details', 'structure-sql-preview'); previewBox.open = true;
  const previewTitle = node('summary', '', create ? 'SQL 预览 · 表名将在保存时填写' : 'SQL 预览'); previewBox.append(previewTitle);
  const preview = node('pre'); previewBox.append(preview);
  const feedback = node('p', 'dialog-feedback'); feedback.setAttribute('role', 'status');
  const footer = node('div', 'structure-editor-footer');
  const cancel = node('button', 'secondary-btn', '取消'); cancel.type = 'button';
  const submit = node('button', 'primary-btn', create ? '保存…' : '预览并应用'); submit.type = 'submit';
  const naming = node('div', 'connection-form structure-table-naming'); naming.hidden = true;
  const nameLabel = node('label', '', '表名');
  const nameInput = node('input'); nameInput.type = 'text'; nameInput.autocomplete = 'off'; nameInput.placeholder = '例如：orders'; nameInput.setAttribute('aria-label', '表名');
  nameLabel.append(nameInput);
  const characterPicker = create && driver === 'mysql' && mysqlCharacterSettings ? createMysqlCharacterPicker(mysqlCharacterSettings, '继承数据库默认值') : null;
  if (characterPicker) { naming.append(nameLabel, characterPicker.element); } else naming.append(nameLabel);
  naming.append(node('p', 'form-note', '确认表名和下方 SQL 后创建；返回编辑可继续调整字段。'));
  footer.append(cancel, submit);
  form.append(header, target, note, toolbar, scroller, naming, previewBox, feedback, footer);
  dialog.append(form, typePopup); document.body.append(dialog);
  let busy = false;
  let namingTable = false;
  let plan;
  let activeTypeInput = null;
  let activeTypeOptions = [];
  let activeTypeIndex = -1;
  const closeTypeMenu = () => {
    typePopup.hidden = true;
    activeTypeInput?.setAttribute('aria-expanded', 'false');
    dialog.querySelectorAll('.column-type-trigger').forEach(button => button.setAttribute('aria-expanded', 'false'));
    activeTypeInput = null; activeTypeOptions = []; activeTypeIndex = -1;
  };
  const positionTypeMenu = () => {
    if (typePopup.hidden || !activeTypeInput) return;
    const rect = activeTypeInput.getBoundingClientRect();
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
  const normalizeTypeSearch = value => value.toLocaleLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
  const filterTypes = (input, query = input.value) => {
    activeTypeInput = input; activeTypeOptions = []; activeTypeIndex = -1;
    input.setAttribute('aria-expanded', 'true');
    dialog.querySelectorAll('.column-type-trigger').forEach(button => button.setAttribute('aria-expanded', String(button.previousElementSibling === input)));
    typePopup.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    const needle = normalizeTypeSearch(query);
    const terms = needle.split(/\s+/).filter(Boolean);
    const options = (columnTypes[driver] || []).filter(option => {
      const haystack = normalizeTypeSearch(`${option.group} ${option.value} ${option.label} ${option.keywords}`);
      return !terms.length || terms.every(term => haystack.includes(term));
    });
    if (!options.length) typePopup.append(node('div', 'column-type-empty', `没有匹配项。仍可直接输入数据库自定义类型：${query}`));
    let previousGroup = '';
    for (const option of options.slice(0, 24)) {
      if (option.group !== previousGroup) { typePopup.append(node('div', 'column-type-group', option.group)); previousGroup = option.group; }
      const button = node('button', 'column-type-option'); button.type = 'button'; button.setAttribute('role', 'option'); button.dataset.value = option.value;
      button.id = `${typePopup.id}-option-${activeTypeOptions.length}`;
      const copy = node('span', 'column-type-copy'); copy.append(node('strong', '', option.value), node('small', '', option.label)); button.append(copy);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', event => {
        event.preventDefault(); input.value = option.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        closeTypeMenu(); input.focus();
      });
      typePopup.append(button); activeTypeOptions.push(button);
    }
    typePopup.append(node('div', 'column-type-footnote', '输入可筛选类型、关键字或精度；也可直接填写自定义类型'));
    typePopup.hidden = false; positionTypeMenu(); updateTypeSelection();
  };
  const update = () => {
    try {
      plan = create ? buildCreateTablePlan({ ...details, name: namingTable ? nameInput.value : '<保存时填写表名>', ...(characterPicker?.value() || {}) }, rows, driver) : buildStructurePlan(details, rows, driver);
      setSelectableText(preview, plan.sql || '尚未修改结构');
      count.textContent = `${rows.filter((row) => !row.removed).length} 个字段 · ${plan.changed} 项变更${plan.dropped ? ` · 删除 ${plan.dropped} 列` : ''}`;
      submit.disabled = busy || !plan.sql;
    } catch (error) { plan = null; setSelectableText(preview, error.message); submit.disabled = true; count.textContent = '请完善字段信息'; }
    for (const [index, row] of rows.entries()) {
      const tr = tbody.children[index];
      if (!tr) continue;
      tr.classList.toggle('removed', Boolean(row.removed));
      tr.classList.toggle('changed', changedColumn(row));
      tr.querySelector('[data-column-status]').textContent = row.removed ? '待删除' : !row.original ? '新增' : changedColumn(row) ? '已修改' : row.primaryKey ? 'PK' : row.identity ? '自增' : row.generated ? '生成' : '—';
    }
  };
  const setNaming = (value) => {
    namingTable = value; naming.hidden = !value;
    dialog.classList.toggle('naming-table', value);
    note.hidden = toolbar.hidden = scroller.hidden = value;
    title.textContent = value ? '保存新表' : '新建表';
    previewTitle.textContent = value ? '建表 SQL' : 'SQL 预览 · 表名将在保存时填写';
    cancel.textContent = value ? '返回编辑' : '取消';
    submit.textContent = value ? '创建表' : '保存…';
    feedback.textContent = ''; feedback.classList.remove('error');
    update();
    if (value) { nameInput.focus(); nameInput.select(); }
    else submit.focus();
  };
  characterPicker?.element.addEventListener('change', () => update());
  nameInput.addEventListener('input', () => { feedback.textContent = ''; update(); });
  const renderRows = () => {
    tbody.replaceChildren();
    rows.forEach((row, index) => {
      const tr = node('tr'); const status = node('td'); status.dataset.columnStatus = ''; tr.append(status);
      for (const key of fields) {
        const td = node('td'); const input = node('input'); input.dataset.field = key; input.dataset.fieldRow = String(index);
        input.setAttribute('aria-label', `${row.name || '新字段'} · ${({ name: '名称', dataType: '类型', nullable: '可空', defaultValue: '默认值', comment: '备注', primaryKey: '主键', identity: '自增' })[key]}`);
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
          input.addEventListener('focus', () => filterTypes(input));
          input.addEventListener('keydown', event => {
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
          const picker = node('div', 'column-type-picker'); picker.append(input, typeTrigger); td.append(picker);
        } else td.append(input);
        tr.append(td);
      }
      const td = node('td'); const remove = node('button', 'quiet-btn', row.removed ? '撤销删除' : '删除'); remove.type = 'button';
      remove.addEventListener('click', () => { if (row.original) row.removed = !row.removed; else rows.splice(index, 1); renderRows(); });
      td.append(remove); tr.append(td); tbody.append(tr);
    });
    update();
  };
  add.addEventListener('click', () => {
    rows.push({ name: '', dataType: driver === 'mysql' ? 'varchar(255)' : 'text', nullable: true, defaultValue: '', comment: '' });
    renderRows(); tbody.lastElementChild.querySelector('input').focus();
  });
  const dismiss = async () => {
    if (busy) return;
    if (namingTable) { setNaming(false); return; }
    if ((create ? JSON.stringify(rows) !== initialRows : rows.some(changedColumn)) && !await confirmDiscard()) return;
    dialog.close();
  };
  dialog.addEventListener('pointerdown', event => {
    if (!event.target.closest('.column-type-picker') && !event.target.closest('.column-type-menu')) closeTypeMenu();
  });
  scroller.addEventListener('scroll', positionTypeMenu, { passive: true });
  dialog.addEventListener('scroll', positionTypeMenu, { passive: true });
  window.addEventListener('resize', positionTypeMenu);
  close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('close', () => { closeTypeMenu(); window.removeEventListener('resize', positionTypeMenu); dialog.remove(); onClose(); }, { once: true });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !plan?.sql) return;
    if (create && !namingTable) { setNaming(true); return; }
    busy = true;
    const fields = [...dialog.querySelectorAll('input, select, button')].map((element) => [element, element.disabled]);
    for (const [element] of fields) element.disabled = true;
    feedback.classList.remove('error'); feedback.textContent = '正在准备提交…';
    try {
      if (await onApply(plan)) dialog.close();
      else feedback.textContent = '已取消提交，编辑内容已保留';
    } catch (error) { feedback.textContent = `未能应用：${error.message || error}`; feedback.classList.add('error'); }
    finally { busy = false; for (const [element, disabled] of fields) element.disabled = disabled; update(); }
  });
  renderRows(); dialog.showModal();
}
