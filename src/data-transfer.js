import { buildPrimaryKeyPredicate, sqlTypedValueLiteral, validateCellDraft } from './cell-edit.js';
import { parse as parseJson, stringify as stringifyJson, isLosslessNumber } from 'lossless-json';

export const TRANSFER_FORMATS = ['sql', 'csv', 'json', 'txt', 'xlsx'];
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10000;
const MAX_COLUMNS = 512;
const scalarText = value => value == null ? '' : value?.$dbStudio === 'mysql-binary' ? `0x${value.hex}` : typeof value === 'object' ? JSON.stringify(value) : String(value);
const quote = (value, driver) => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('表名或字段名无效');
  const mark = driver === 'mysql' ? '`' : '"';
  return mark + value.replaceAll(mark, mark + mark) + mark;
};

export function encodeDelimited({ columns, rows }, delimiter = ',') {
  const cell = (value, header = false) => {
    if (value == null && !header) return '\\N';
    const text = scalarText(value);
    return text === '\\N' || /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.map(value => cell(value, true)).join(delimiter), ...rows.map(row => row.map(value => cell(value)).join(delimiter))].join('\r\n');
}

export function decodeDelimited(source, delimiter = ',') {
  if (![',', '\t', ';'].includes(delimiter)) throw new Error('分隔符无效');
  const text = source.replace(/^\uFEFF/, '');
  const matrix = []; let row = [], value = '', quoted = false, inside = false, closed = false;
  const finishCell = () => { row.push(!quoted && value === '\\N' ? null : value); value = ''; quoted = false; closed = false; };
  const finishRow = () => { finishCell(); matrix.push(row); row = []; if (matrix.length > MAX_IMPORT_ROWS + 1) throw new Error(`最多导入 ${MAX_IMPORT_ROWS} 行，请拆分文件`); };
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (inside) {
      if (ch === '"') { if (text[index + 1] === '"') { value += '"'; index++; } else { inside = false; closed = true; } }
      else value += ch;
    } else if (ch === delimiter) finishCell();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[index + 1] === '\n') index++; finishRow(); }
    else if (ch === '"' && value === '' && !closed) { inside = true; quoted = true; }
    else { if (closed || ch === '"') throw new Error('引号格式无效，请使用双引号转义字段中的引号'); value += ch; }
  }
  if (inside) throw new Error('文件中存在未闭合的双引号');
  if (value || row.length || quoted) finishRow();
  const columns = (matrix.shift() || []).map(scalarText);
  return validateTable({ columns, rows: matrix });
}

const jsonNumber = value => {
  const raw = value.value, number = Number(raw);
  return !Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) || raw.replace(/\D/g, '').length > 15 ? raw : number;
};
export function parseLosslessJson(text) {
  return parseJson(text, (_key, value) => isLosslessNumber(value) ? jsonNumber(value) : value);
}
const jsonCell = value => isLosslessNumber(value) ? jsonNumber(value)
  : value && typeof value === 'object' ? stringifyJson(value) : value;

function validateTable(data) {
  if (!Array.isArray(data.columns) || !data.columns.length || data.columns.length > MAX_COLUMNS || data.columns.some(column => typeof column !== 'string' || !column.trim() || column.includes('\0'))) throw new Error(`首行必须有字段名，最多 ${MAX_COLUMNS} 列`);
  if (!Array.isArray(data.rows) || data.rows.length > MAX_IMPORT_ROWS) throw new Error(`最多导入 ${MAX_IMPORT_ROWS} 行，请拆分文件`);
  data.rows.forEach((row, index) => { if (!Array.isArray(row) || row.length !== data.columns.length) throw new Error(`第 ${index + 2} 行列数与表头不一致`); });
  return data;
}

export function decodeJson(text) {
  const source = parseJson(text.replace(/^\uFEFF/, ''));
  if (source && !Array.isArray(source) && Array.isArray(source.columns) && Array.isArray(source.rows)) return validateTable({ columns: source.columns, rows: source.rows.map(row => Array.isArray(row) ? row.map(jsonCell) : row) });
  if (!Array.isArray(source) || !source.length || source.some(row => !row || typeof row !== 'object' || Array.isArray(row) || isLosslessNumber(row))) throw new Error('JSON 需要为对象数组，或包含 columns、rows 的表格对象');
  const columns = [...new Set(source.flatMap(row => Object.keys(row)))];
  return validateTable({ columns, rows: source.map(row => columns.map(column => Object.hasOwn(row, column) ? jsonCell(row[column]) : undefined)) });
}

async function excel() { const module = await import('exceljs'); return module.default || module; }
function excelValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('XLSX 中有精度不可靠的数字，请将长整数在源文件中存为文本'); return value; }
  if (value instanceof Date) return value.toISOString();
  if (value.richText) return value.richText.map(part => part.text).join('');
  if (value.formula || value.sharedFormula) { if (!Object.hasOwn(value, 'result')) throw new Error('XLSX 公式没有缓存结果，请先在 Excel 中计算并保存'); return excelValue(value.result); }
  if (value.hyperlink) return value.text || value.hyperlink;
  throw new Error('XLSX 包含不支持的单元格或错误值，请先在源文件中处理');
}

export async function readTransferFile(file, { format = file.name.split('.').at(-1).toLowerCase(), sheet = 0, delimiter = format === 'txt' ? '\t' : ',' } = {}) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('文件不能超过 20 MiB，请拆分后导入');
  if (format === 'xlsx') {
    const Excel = await excel(); const workbook = new Excel.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheets = workbook.worksheets.map(sheet => sheet.name), worksheet = workbook.worksheets[sheet];
    if (!worksheet) throw new Error('XLSX 没有可读取的工作表');
    if (!worksheet.rowCount) return { columns: [], rows: [], sheets };
    if (worksheet.rowCount > MAX_IMPORT_ROWS + 1 || worksheet.columnCount > MAX_COLUMNS) return { columns: [], rows: [], sheets, error: '工作表过大，请限制为 10000 行、512 列以内' };
    const matrix = [];
    for (let index = 1; index <= worksheet.rowCount; index++) {
      const row = worksheet.getRow(index);
      matrix.push(Array.from({ length: worksheet.columnCount }, (_, column) => excelValue(row.getCell(column + 1).value)));
    }
    return { ...validateTable({ columns: (matrix.shift() || []).map(scalarText), rows: matrix }), sheets };
  }
  const text = await file.text();
  if (format === 'json') return decodeJson(text);
  if (format === 'csv' || format === 'txt') return decodeDelimited(text, delimiter);
  if (format === 'sql') return { sql: text.replace(/^\uFEFF/, '') };
  throw new Error('支持 SQL、CSV、JSON、TXT、XLSX 文件');
}

const required = field => !field.nullable && !field.identity && !field.generated && field.defaultValue == null;
export function autoMapColumns(source, fields) {
  const used = new Set();
  return source.map(column => {
    const found = fields.find(field => !field.generated && !used.has(field.name) && field.name === column)
      || fields.find(field => !field.generated && !used.has(field.name) && field.name.toLowerCase() === column.toLowerCase());
    if (found) used.add(found.name);
    return found?.name || '';
  });
}

export function buildImportSql(data, mapping, table, driver = 'postgres', valueLiteral = sqlTypedValueLiteral) {
  if (!['postgres', 'mysql'].includes(driver) || !['table', 'partitioned_table'].includes(table.kind)) throw new Error('仅支持导入 PostgreSQL/MySQL 数据表');
  if (!data.rows.length) throw new Error('文件没有可导入的数据行');
  const fields = table.columns || [];
  const selected = mapping.map((name, index) => ({ field: fields.find(field => field.name === name), index, name })).filter(item => item.name);
  if (!selected.length) throw new Error('至少映射一个字段');
  if (new Set(selected.map(item => item.name)).size !== selected.length) throw new Error('多个源列不能映射到同一个目标字段');
  if (selected.some(item => !item.field || item.field.generated)) throw new Error('目标字段无效，生成列不能导入');
  for (const field of fields) if (required(field) && !selected.some(item => item.name === field.name)) throw new Error(`缺少必填字段：${field.name}`);
  const records = data.rows.map((row, index) => '(' + selected.map(({ field, index: column }) => {
    let value = row[column];
    if (value === undefined) { if (required(field)) throw new Error(`第 ${index + 1} 行缺少必填字段 ${field.name}`); return 'DEFAULT'; }
    const original = value;
    if (value !== null) value = scalarText(value);
    try { validateCellDraft(value, { dataType: field.dataType, allowNull: field.nullable === true }); }
    catch (error) { throw new Error(`第 ${index + 1} 行 ${field.name}：${error.message}`); }
    return valueLiteral(typeof original === 'boolean' ? original : value, field.dataType, driver);
  }).join(', ') + ')');
  const override = driver === 'postgres' && selected.some(({ field }) => field.identity && field.identityGeneration !== 'byDefault') ? ' OVERRIDING SYSTEM VALUE' : '';
  const sql = `INSERT INTO ${quote(table.schema, driver)}.${quote(table.name, driver)} (${selected.map(item => quote(item.name, driver)).join(', ')})${override}\nVALUES\n${records.join(',\n')};`;
  if (new TextEncoder().encode(sql).length > 8 * 1024 * 1024) throw new Error('生成的 SQL 超过 8 MiB，请拆分文件后导入');
  return sql;
}

export function buildCopiedRowsSql(data, table, driver, operation) {
  return buildSelectedRowsSql(data, table, driver, operation, (value, dataType, dialect) =>
    sqlTypedValueLiteral(value, dataType, dialect, { readable: true }));
}

function buildSelectedRowsSql(data, table, driver, operation, valueLiteral) {
  if (!['postgres', 'mysql'].includes(driver) || !['table', 'partitioned_table'].includes(table?.kind)) throw new Error('需要能够识别来源的数据表');
  if (!data.rows.length) throw new Error('请选择要复制的数据行');
  const fields = data.columns.map(name => {
    const field = table.columns.find(item => item.name === name);
    if (!field) throw new Error(`缺少字段 ${name} 的元数据，请刷新后重试`);
    return field;
  });
  if (new Set(data.columns).size !== data.columns.length || data.rows.some(row => row.length !== fields.length || fields.some((_, index) => row[index] === undefined))) {
    throw new Error('结果中的字段或行数据不完整');
  }
  if (operation === 'insert') {
    const mapping = fields.map(field => field.generated ? '' : field.name);
    const excerpt = { ...table, columns: table.columns.map(field => ({ ...field, nullable: true })) };
    return buildImportSql(data, mapping, excerpt, driver, valueLiteral);
  }
  if (operation !== 'update') throw new Error('SQL 格式无效');
  const primaryKeys = table.primaryKeys || [];
  const keyTypes = Object.fromEntries(table.columns.map(field => [field.name, field.dataType]));
  const updated = fields.map((field, index) => ({ field, index })).filter(({ field }) =>
    !primaryKeys.includes(field.name) && !field.generated &&
    !(driver === 'postgres' && field.identity && field.identityGeneration !== 'byDefault'));
  if (!updated.length) throw new Error('所选行没有可更新的非主键字段');
  const qualified = `${quote(table.schema, driver)}.${quote(table.name, driver)}`;
  const sql = data.rows.map(row => {
    const where = buildPrimaryKeyPredicate({ primaryKeys, columns: data.columns, row, driver, keyTypes, valueLiteral });
    const set = updated.map(({ field, index }) => `${quote(field.name, driver)} = ${valueLiteral(row[index], field.dataType, driver)}`);
    return `UPDATE ${table.only && driver === 'postgres' ? 'ONLY ' : ''}${qualified}\nSET ${set.join(', ')}\nWHERE ${where};`;
  }).join('\n\n');
  if (new TextEncoder().encode(sql).length > 8 * 1024 * 1024) throw new Error('生成的 SQL 超过 8 MiB，请分批复制');
  return sql;
}

export async function createExport(data, format, { table, driver = 'postgres', title = 'query' } = {}) {
  if (!TRANSFER_FORMATS.includes(format)) throw new Error('导出格式无效');
  const name = `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'query'}.${format}`;
  if (format === 'xlsx') {
    const Excel = await excel(); const workbook = new Excel.Workbook();
    workbook.creator = 'Keybay'; const sheet = workbook.addWorksheet('Data');
    const matrix = [data.columns, ...data.rows].map(row => row.map(value => {
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('数据含不可靠的整数，请重新查询并以文本返回');
      const cell = value == null ? null : typeof value === 'object' ? scalarText(value) : value;
      if (typeof cell === 'string' && cell.length > 32767) throw new Error('单元格超过 XLSX 的 32767 字符限制，请使用 JSON 导出');
      return cell;
    }));
    sheet.addRows(matrix); sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.columns.length } };
    sheet.columns.forEach((column, index) => { column.width = Math.min(48, Math.max(12, data.columns[index].length + 4)); });
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    return { name, bytes: new Uint8Array(await workbook.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  let contents;
  if (format === 'json') contents = JSON.stringify({ format: 'db-studio', version: 1, columns: data.columns, rows: data.rows }, null, 2);
  else if (format === 'sql') {
    if (!table) throw new Error('请从表数据页导出 INSERT SQL');
    // Export may intentionally contain only selected columns. Missing required
    // columns are valid for an excerpt, and are checked when importing it.
    contents = data.rows.length ? '-- Keybay 数据导出；生成列由数据库维护。\n' + buildSelectedRowsSql(data, table, driver, 'insert', sqlTypedValueLiteral) : '-- 没有可导出的数据\n';
  } else contents = '\uFEFF' + encodeDelimited(data, format === 'txt' ? '\t' : ',');
  return { name, contents, mime: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' };
}
