import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { autoMapColumns, buildImportSql, createExport, decodeDelimited, decodeJson, encodeDelimited, parseLosslessJson, readTransferFile } from '../src/data-transfer.js';

const data = { columns: ['id', 'note', 'value'], rows: [['9007199254740993', 'a,"b"\n中文', null], ['0002', '', '\\N'], ['3', '=SUM(A1:A2)', true]] };
const table = { schema: 'sales', name: 'items', kind: 'table', columns: [{ name: 'id', dataType: 'bigint', nullable: false, primaryKey: true }, { name: 'note', dataType: 'text', nullable: true }, { name: 'value', dataType: 'text', nullable: true }] };
const file = (name, text) => ({ name, size: new TextEncoder().encode(text).length, text: async () => text });

test('CSV and TXT retain null, empty text, literal null marker, quoted multiline values and ids', () => {
  for (const delimiter of [',', '\t', ';']) {
    const parsed = decodeDelimited(encodeDelimited(data, delimiter), delimiter);
    assert.deepEqual(parsed.columns, data.columns);
    assert.deepEqual(parsed.rows[0], data.rows[0]);
    assert.deepEqual(parsed.rows[1], data.rows[1]);
    assert.equal(parsed.rows[2][2], 'true');
  }
  assert.throws(() => decodeDelimited('a,b\n1'), /列数/);
  assert.throws(() => decodeDelimited('a\n"unclosed'), /未闭合/);
  assert.throws(() => decodeDelimited('a\n"value"extra'), /引号/);
});

test('lossless JSON retains unsafe numeric tokens and does not rewrite strings or prototype keys', () => {
  const parsed = parseLosslessJson('[{"id":9007199254740993,"decimal":1.234567890123456789,"name":"a12345678901234567","__proto__":"text"}]');
  assert.equal(parsed[0].id, '9007199254740993');
  assert.equal(parsed[0].decimal, '1.234567890123456789');
  assert.equal(parsed[0].name, 'a12345678901234567');
  const tabular = decodeJson('[{"id":9007199254740993,"note":null},{"id":"0001"}]');
  assert.deepEqual(tabular.rows, [['9007199254740993', null], ['0001', undefined]]);
  const nested = decodeJson('[{"id":9007199254740993,"payload":{"n":9007199254740995,"decimal":1.234567890123456789}}]');
  assert.equal(nested.rows[0][1], '{"n":9007199254740995,"decimal":1.234567890123456789}');
});

test('all five export formats are produced and non-XLSX formats round trip', async () => {
  for (const format of ['csv', 'txt', 'json', 'sql', 'xlsx']) {
    const output = await createExport(data, format, { table, title: 'items', driver: 'postgres' });
    assert.equal(output.name, `items.${format}`);
    if (format === 'sql') {
      assert.match(output.contents, /INSERT INTO "sales"\."items"/);
      assert.match(output.contents, /9007199254740993/);
      assert.match(output.contents, /E'a,"b"\n中文'/);
    } else if (format !== 'xlsx') {
      const parsed = await readTransferFile(file(output.name, output.contents));
      assert.deepEqual(parsed.rows[0], data.rows[0]);
    } else assert.deepEqual([...output.bytes.slice(0, 2)], [80, 75]);
  }
  await assert.rejects(createExport({ columns: ['unknown'], rows: [['value']] }, 'sql', { table }), /元数据/);
});

test('XLSX round trip preserves long text ids, null, empty strings, booleans and formula-looking strings', async () => {
  const output = await createExport(data, 'xlsx');
  const parsed = await readTransferFile({ name: 'data.xlsx', size: output.bytes.length, arrayBuffer: async () => output.bytes });
  assert.deepEqual(parsed.columns, data.columns);
  assert.deepEqual(parsed.rows, data.rows);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(output.bytes);
  assert.equal(workbook.worksheets[0].getCell('B4').type, ExcelJS.ValueType.String);
});

test('XLSX supports sheet selection and cached formula results without executing formulas', async () => {
  const book = new ExcelJS.Workbook(); book.addWorksheet('Empty');
  const sheet = book.addWorksheet('Data'); sheet.addRow(['id', 'calculated']); sheet.addRow(['0001', { formula: '1+1', result: 2 }]);
  const bytes = await book.xlsx.writeBuffer(), input = { name: 'source.xlsx', size: bytes.length, arrayBuffer: async () => bytes };
  const empty = await readTransferFile(input); assert.deepEqual(empty.sheets, ['Empty', 'Data']);
  const parsed = await readTransferFile(input, { sheet: 1 }); assert.deepEqual(parsed.rows, [['0001', 2]]);
  sheet.getCell('B2').value = { formula: '1+1' };
  const missing = await book.xlsx.writeBuffer();
  await assert.rejects(readTransferFile({ ...input, arrayBuffer: async () => missing }, { sheet: 1 }), /缓存结果/);
});

test('field mapping validates duplicates, missing required fields, JSON and nullability before writes', () => {
  assert.deepEqual(autoMapColumns(['ID', 'note', 'unknown'], table.columns), ['id', 'note', '']);
  assert.throws(() => buildImportSql(data, ['', 'note', 'value'], table), /必填字段.*id/);
  assert.throws(() => buildImportSql(data, ['id', 'id', ''], table), /同一个目标/);
  assert.throws(() => buildImportSql({ columns: ['id'], rows: [[null]] }, ['id'], table), /不允许.*NULL/);
  const jsonTable = { ...table, columns: [...table.columns, { name: 'payload', dataType: 'jsonb', nullable: true }] };
  assert.throws(() => buildImportSql({ columns: ['id', 'payload'], rows: [['1', '{bad']] }, ['id', 'payload'], jsonTable), /JSON 格式/);
});

test('INSERT handles both dialects, generated fields, ALWAYS identity and missing default values', () => {
  const metadata = { ...table, columns: [{ ...table.columns[0], identity: true, identityGeneration: 'always' }, { ...table.columns[1], defaultValue: "'draft'" }, { name: 'computed', generated: true }] };
  const source = { columns: ['id', 'note'], rows: [['9007199254740993', undefined], ['0002', "a'b\\c"]] };
  const pg = buildImportSql(source, ['id', 'note'], metadata);
  assert.match(pg, /OVERRIDING SYSTEM VALUE/); assert.match(pg, /DEFAULT/); assert.match(pg, /E'a''b\\\\c'/);
  const mysql = buildImportSql(source, ['id', 'note'], metadata, 'mysql');
  assert.match(mysql, /INSERT INTO `sales`\.`items`/); assert.match(mysql, /CONVERT\(X'/);
  assert.throws(() => buildImportSql(source, ['id', 'computed'], metadata), /生成列/);
});

test('malformed and oversized files are rejected rather than truncated', async () => {
  await assert.rejects(readTransferFile({ ...file('big.csv', 'id\n1'), size: 21 * 1024 * 1024 }), /20 MiB/);
  assert.throws(() => decodeJson('[1,2]'), /对象数组/);
  assert.throws(() => decodeJson('{"columns":["id"],"rows":[[1,2]]}'), /列数/);
  await assert.rejects(createExport({ columns: ['value'], rows: [['a'.repeat(32768)]] }, 'xlsx'), /32767/);
});
