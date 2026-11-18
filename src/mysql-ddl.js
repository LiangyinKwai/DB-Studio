// Preserve native SHOW CREATE clauses instead of reconstructing a MySQL
// column from PostgreSQL's type/null/default display fields.
function tokens(text, noBackslash = false, columnAttributes = false) {
  const result = []; let depth = 0;
  for (let index = 0; index < text.length;) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] === '#' || (text.slice(index, index + 2) === '--' && /\s/.test(text[index + 2] || ' '))) { index = text.indexOf('\n', index); if (index < 0) break; continue; }
    if (text.slice(index, index + 2) === '/*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) break;
      const visibility = columnAttributes && /^\/\*!\d+\s+(INVISIBLE|VISIBLE)\s*\*\/$/i.exec(text.slice(index, end + 2));
      if (visibility) result.push({ start: index, end: end + 2, raw: visibility[1], depth });
      index = end + 2;
      continue;
    }
    const start = index, ch = text[index];
    if (["'", '"', '`'].includes(ch)) {
      index++;
      while (index < text.length) {
        if (!noBackslash && ch !== '`' && text[index] === '\\') { index += 2; continue; }
        if (text[index] === ch) { if (text[index + 1] === ch) { index += 2; continue; } index++; break; }
        index++;
      }
      result.push({ start, end: index, raw: text.slice(start, index), quoted: ch, depth });
    } else if (/[\p{L}\p{N}_$]/u.test(ch)) {
      while (index < text.length && /[\p{L}\p{N}_$]/u.test(text[index])) index++;
      result.push({ start, end: index, raw: text.slice(start, index), depth });
    } else {
      if (ch === ')') depth--;
      result.push({ start, end: ++index, raw: ch, depth });
      if (ch === '(') depth++;
    }
  }
  return result;
}

export function mysqlDdlTargets(sql, database) {
  const list = tokens(sql), found = [];
  const word = index => list[index] && !list[index].quoted ? list[index].raw.toUpperCase() : '';
  const reference = index => {
    const name = token => token?.quoted === '`' ? token.raw.slice(1, -1).replaceAll('``', '`') : token && !token.quoted && /^[\p{L}\p{N}_$]+$/u.test(token.raw) ? token.raw : null;
    const first = name(list[index]); if (!first) return null;
    if (list[index + 1]?.raw === '.') { const second = name(list[index + 2]); return second ? { database: first, name: second, end: index + 3 } : null; }
    return { database, name: first, end: index + 1 };
  };
  for (let index = 0; index < list.length; index++) {
    if (!['ALTER', 'CREATE', 'DROP', 'RENAME', 'TRUNCATE'].includes(word(index))) continue;
    let cursor = index + 1;
    if (word(cursor) === 'OR' && word(cursor + 1) === 'REPLACE') cursor += 2;
    if (!['TABLE', 'VIEW'].includes(word(cursor))) continue;
    cursor++;
    while (['IF', 'NOT', 'EXISTS'].includes(word(cursor))) cursor++;
    let target = reference(cursor);
    while (target) {
      found.push({ database: target.database, name: target.name }); cursor = target.end;
      if (word(index) === 'RENAME' && word(cursor) === 'TO') { target = reference(cursor + 1); if (target) { found.push({ database: target.database, name: target.name }); cursor = target.end; } }
      if (list[cursor]?.raw !== ',' || !['DROP', 'RENAME'].includes(word(index))) break;
      target = reference(cursor + 1);
    }
  }
  return found;
}

export function mysqlViewDefinition(definition, qualifiedName, sqlMode) {
  if (!definition) throw new Error('当前账号无法读取视图定义');
  const list = tokens(definition, mysqlNoBackslashEscapes(sqlMode));
  const view = list.findIndex(token => !token.quoted && token.raw.toUpperCase() === 'VIEW');
  const name = list[view + 1];
  if (list[0]?.raw.toUpperCase() !== 'CREATE' || view < 1 || !name) {
    throw new Error('无法识别 MySQL 原生视图定义');
  }
  const end = list[view + 2]?.raw === '.' ? list[view + 3]?.end : name.end;
  const as = list.find(token => token.start >= end && !token.depth && !token.quoted && token.raw.toUpperCase() === 'AS');
  if (!as) throw new Error('无法识别 MySQL 原生视图查询');
  const header = `ALTER${definition.slice(list[0].end, name.start)}${qualifiedName}${definition.slice(end, as.end)}`;
  return { header, query: definition.slice(as.end).trim() };
}

function attributeKind(list, index) {
  const current = list[index], previous = list[index - 1];
  if (current.depth || current.quoted) return null;
  const word = current.raw.toUpperCase(), next = list[index + 1]?.raw.toUpperCase();
  if (word === 'NOT' && next === 'NULL') return 'nullable';
  if (word === 'NULL' && !['NOT', 'DEFAULT'].includes(previous?.raw.toUpperCase())) return 'nullable';
  if (word === 'ON' && next === 'UPDATE') return 'onUpdate';
  if (word === 'CHARACTER' && next === 'SET') return 'charset';
  return ({ DEFAULT: 'default', COMMENT: 'comment', AUTO_INCREMENT: 'identity', COLLATE: 'collation', GENERATED: 'generated', INVISIBLE: 'visibility', VISIBLE: 'visibility', COLUMN_FORMAT: 'format', STORAGE: 'storage', SRID: 'srid' })[word] || null;
}

export function mysqlDefaultClause(value, dataType = '') {
  const text = String(value).trim();
  if (!text) return '';
  const literal = /^(?:NULL|TRUE|FALSE|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|'(?:[^']|'')*')$/i.test(text);
  const timestamp = /^(?:CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)(?:\(\d*\))?$/i.test(text);
  const expressionOnlyType = /^(?:tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob|json|geometry)\b/i.test(dataType);
  const expression = text.startsWith('(') && text.endsWith(')') ? text : `(${text})`;
  return ` DEFAULT ${!expressionOnlyType && (literal || timestamp) ? text : expression}`;
}

export function mysqlColumns(details) {
  if (!details.mysql || !details.definition) return null;
  if (typeof details.mysql.sqlMode !== 'string') throw new Error('缺少 MySQL SQL_MODE，无法精确读取原生定义，请刷新表结构后重试');
  const noBackslash = mysqlNoBackslashEscapes(details.mysql.sqlMode);
  const list = tokens(details.definition, noBackslash);
  const open = list.findIndex(token => token.raw === '(' && token.depth === 0);
  if (open < 0) return null;
  const parts = []; let start = list[open].end;
  for (const token of list.slice(open + 1)) {
    if (token.raw === ',' && token.depth === 1) { parts.push(details.definition.slice(start, token.start).trim()); start = token.end; }
    if (token.raw === ')' && token.depth === 0) { parts.push(details.definition.slice(start, token.start).trim()); break; }
  }
  const columns = new Map();
  for (const part of parts) {
    const pieces = tokens(part, noBackslash, true);
    if (pieces[0]?.quoted !== '`') continue;
    const name = pieces[0].raw.slice(1, -1).replaceAll('``', '`');
    const starts = pieces.map((token, index) => ({ token, kind: attributeKind(pieces, index) })).filter(item => item.kind);
    const attrs = starts.map((item, index) => ({ kind: item.kind, raw: part.slice(item.token.start, starts[index + 1]?.token.start ?? part.length).trim() }));
    const type = part.slice(pieces[0].end, starts[0]?.token.start ?? part.length).trim();
    columns.set(name, { definition: part.slice(pieces[0].end).trim(), type, attrs, defaultValue: attrs.find(attr => attr.kind === 'default')?.raw.replace(/^DEFAULT\s+/i, '') || '' });
  }
  return columns;
}

export function mysqlColumnChange(old, row, native, sqlMode, validateType, validateDefault) {
  if (!native) throw new Error(`缺少字段 ${old.name} 的原生定义，请刷新结构后重试`);
  const changed = key => (row[key] ?? '') !== (old[key] ?? '');
  const type = changed('dataType') ? validateType(row.dataType) : native.type;
  if (changed('dataType') && native.attrs.some(attr => ['charset', 'collation'].includes(attr.kind)) && !/^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(type)) throw new Error('跨字符与非字符类型的变更涉及字符集，请使用 SQL 编辑器');
  const attrs = native.attrs.filter(attr => !(changed('nullable') && attr.kind === 'nullable') && !(changed('defaultValue') && attr.kind === 'default') && !(changed('comment') && attr.kind === 'comment'));
  if (changed('nullable')) attrs.push({ kind: 'nullable', raw: row.nullable ? 'NULL' : 'NOT NULL' });
  if (changed('defaultValue') && row.defaultValue.trim()) attrs.push({ kind: 'default', raw: mysqlDefaultClause(validateDefault(row.defaultValue), type).trim() });
  if (changed('comment')) {
    attrs.push({ kind: 'comment', raw: `COMMENT ${mysqlCommentLiteral(row.comment ?? '', sqlMode)}` });
  }
  return `${type} ${attrs.map(attr => attr.raw).join(' ')}`.trim();
}

export function mysqlNoBackslashEscapes(sqlMode) {
  if (typeof sqlMode !== 'string') throw new Error('无法确认 MySQL SQL_MODE，请重新打开建表或结构编辑窗口后重试');
  return sqlMode.split(',').some(mode => mode.trim().toUpperCase() === 'NO_BACKSLASH_ESCAPES');
}

// COMMENT accepts a quoted text token, not a hex literal or CONVERT expression.
// MySQL stores column comments in its system (utf8mb3) character set; it can
// replace supplementary characters or truncate >1024 characters with only a
// warning even when the CREATE otherwise succeeds. Refuse lossy input first.
export function mysqlCommentLiteral(value, sqlMode) {
  let text = String(value);
  if (text.includes('\0')) throw new Error('MySQL 备注不能包含空字符');
  if (/[\uD800-\uDFFF\u{10000}-\u{10FFFF}]/u.test(text)) throw new Error('MySQL 字段备注无法原样保存 emoji 等补充 Unicode 字符或无效字符，请移除后重试');
  // Supplementary/unpaired-surrogate input was rejected above, so UTF-16
  // length now equals the Unicode code-point count without a large allocation.
  if (text.length > 1024) throw new Error('MySQL 字段备注最多 1024 个字符，超出会被服务器截断，请缩短后重试');
  if (text.includes('\\') && !mysqlNoBackslashEscapes(sqlMode)) text = text.replaceAll('\\', '\\\\');
  return `'${text.replaceAll("'", "''")}'`;
}

export function mysqlSqlModeExpectation(sql, sqlMode) {
  return sql.includes('\\') ? { expectedMysqlNoBackslashEscapes: mysqlNoBackslashEscapes(sqlMode) } : {};
}
