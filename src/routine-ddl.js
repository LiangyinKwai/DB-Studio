// Planning for editing stored procedures and functions. Kept free of DOM and
// CodeMirror so the generated statements can be unit-tested.
//
// PostgreSQL replaces a routine atomically with CREATE OR REPLACE. MySQL has no
// equivalent: changing the body means DROP + CREATE, and that DDL commits
// implicitly. The plan therefore also carries scripts that put the original
// definition back if the CREATE fails after the DROP succeeded.

export const routineKindLabels = { function: '函数', procedure: '存储过程' };

const identifier = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^\\s(.`"]+)';
const qualifiedName = `(${identifier})(?:\\s*\\.\\s*(${identifier}))?`;
const account = '(?:`[^`]*`|\'[^\']*\'|"[^"]*"|[^\\s@]+)';
const definerClause = `DEFINER\\s*=\\s*(?:CURRENT_USER(?:\\s*\\(\\s*\\))?|${account}@${account})\\s+`;
const headerPattern = new RegExp(
  `^CREATE\\s+(OR\\s+REPLACE\\s+)?(?:${definerClause})?(?:AGGREGATE\\s+)?(FUNCTION|PROCEDURE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${qualifiedName}\\s*\\(`,
  'i',
);
const definerPattern = new RegExp(`^(\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?)${definerClause}`, 'i');
const mysqlDelimiters = ['$$', '//', '%%', '@@', '~~', '^^', '!!'];

function stripLeadingComments(sql) {
  let text = String(sql ?? '').trimStart();
  for (;;) {
    const next = text.replace(/^(?:--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/, '').trimStart();
    if (next === text) return text;
    text = next;
  }
}

function unquote(raw) {
  if (!raw) return { text: '', quoted: false };
  const quote = raw[0];
  if (quote === '"' || quote === '`') return { text: raw.slice(1, -1).replaceAll(quote + quote, quote), quoted: true };
  return { text: raw, quoted: false };
}

// Parameter text between the first pair of parentheses, whitespace-insensitive
// so reformatting alone is never reported as a signature change.
function parameterText(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      for (index++; index < text.length; index++) {
        if (text[index] === char) { if (text[index + 1] === char) index++; else break; }
      }
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return text.slice(open + 1, index).replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
  }
  return null;
}

/** Reads `CREATE [OR REPLACE] [DEFINER = …] FUNCTION|PROCEDURE [schema.]name(` — or null. */
export function parseRoutineHeader(sql) {
  const text = stripLeadingComments(sql);
  const match = headerPattern.exec(text);
  if (!match) return null;
  const [whole, orReplace, kind, first, second] = match;
  const params = parameterText(text, whole.length - 1);
  if (params === null) return null;
  const qualifier = second ? unquote(first) : null;
  return { kind: kind.toLowerCase(), orReplace: Boolean(orReplace), qualifier, name: unquote(second || first), params };
}

// `actual` is the catalog's real name. PostgreSQL folds unquoted identifiers to
// lower case, MySQL routine names are case-insensitive.
function sameIdentifier(parsed, actual, driver) {
  if (!parsed) return true;
  if (driver === 'mysql') return parsed.text.toLowerCase() === actual.toLowerCase();
  return (parsed.quoted ? parsed.text : parsed.text.toLowerCase()) === actual;
}

export function chooseMysqlDelimiter(text) {
  return mysqlDelimiters.find(delimiter => !text.includes(delimiter)) ?? null;
}

/** MySQL `SHOW CREATE` keeps the original DEFINER; dropping it recreates the routine as the current user. */
export function stripRoutineDefiner(sql) {
  return String(sql).replace(definerPattern, '$1');
}

const withoutTerminator = sql => String(sql).trim().replace(/[\s;]+$/, '');

function mysqlScript(statements) {
  const delimiter = chooseMysqlDelimiter(statements.join('\n'));
  if (!delimiter) throw new Error('定义中包含了所有可用的分隔符，请改写后再保存');
  return `DELIMITER ${delimiter}\n${statements.map(statement => statement + delimiter).join('\n')}\nDELIMITER ;`;
}

/**
 * @returns {{ driver: string, sql: string, preview: string, singleStatement: boolean,
 *   warnings: string[], restore: string[] }}
 * @throws {Error} with a user-facing message when the text cannot be saved.
 */
export function buildRoutineEdit({ driver, kind, schema, name, original, edited, quoteIdentifier }) {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('当前数据库不支持编辑存储过程或函数');
  const text = String(edited ?? '').trim();
  if (!text) throw new Error('请输入完整的 CREATE 语句');
  if (driver === 'mysql' && /^\s*DELIMITER\b/im.test(text)) throw new Error('无需编写 DELIMITER，保存时会自动处理');
  const header = parseRoutineHeader(text);
  const label = routineKindLabels[kind];
  if (!header) throw new Error(`定义需要以 CREATE ${kind.toUpperCase()} 名称(…) 开头`);
  if (header.kind !== kind) throw new Error(`这是${label}，不能改成${routineKindLabels[header.kind]}`);

  const known = parseRoutineHeader(original);
  const warnings = [];
  const renamed = !sameIdentifier(header.name, name, driver);
  const moved = !sameIdentifier(header.qualifier, schema, driver);

  if (driver === 'postgres') {
    if (renamed || moved) warnings.push(`名称或 schema 已改变：保存后会新建一个${label}，原${label}保持不变。`);
    else if (known && header.params !== known.params) warnings.push(`参数列表已改变：PostgreSQL 会新建一个重载，原${label}保持不变。`);
    else if (!header.orReplace) warnings.push(`缺少 OR REPLACE：${label}已存在，保存会失败。`);
    const sql = /;\s*$/.test(text) ? text : `${text};`;
    return { driver, sql, preview: sql, singleStatement: true, warnings, restore: [] };
  }

  if (renamed) warnings.push(`名称已改变：原${label} ${name} 会被删除，并按新名称创建。`);
  if (moved) warnings.push(`将创建到另一个数据库：${header.qualifier.text}；原${label}会被删除。`);
  const body = withoutTerminator(text);
  const drop = `DROP ${kind.toUpperCase()} IF EXISTS ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const originalBody = original ? withoutTerminator(original) : '';
  const restore = originalBody
    ? [...new Set([originalBody, stripRoutineDefiner(originalBody)])].map(sql => mysqlScript([sql]))
    : [];
  return {
    driver, sql: mysqlScript([drop, body]), preview: `${drop};\n${body};`, singleStatement: false, warnings, restore,
  };
}
