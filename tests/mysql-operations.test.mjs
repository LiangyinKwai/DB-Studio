import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlColumns, mysqlDdlTargets, mysqlDefaultClause } from '../src/mysql-ddl.js';
import { buildCreateTablePlan, buildStructurePlan, createStructureDraft, structureFingerprint } from '../src/structure-editor.js';
import { sqlTypedValueLiteral, buildCellUpdateSql, getCellEditCapability } from '../src/cell-edit.js';
import { buildImportSql, createExport, readTransferFile } from '../src/data-transfer.js';

const details = {
  schema: 'app', name: 'items', kind: 'table', mysql: { sqlMode: '', engine: 'InnoDB', serverVersion: '8.4' },
  columns: [
    { name: 'id', dataType: 'tinyint unsigned', nullable: false, identity: true, primaryKey: true },
    { name: 'name', dataType: 'varchar(64)', nullable: false, defaultValue: 'draft', comment: 'keep' },
    { name: 'updated', dataType: 'timestamp(6)', nullable: false, defaultValue: 'CURRENT_TIMESTAMP(6)' },
    { name: 'computed', dataType: 'int', nullable: true, generated: true },
  ],
  definition: "CREATE TABLE `items` (`id` tinyint unsigned NOT NULL AUTO_INCREMENT, `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'draft' COMMENT 'keep', `updated` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), `computed` int GENERATED ALWAYS AS ((`id` % 97)) STORED INVISIBLE, PRIMARY KEY (`id`)) ENGINE=InnoDB AUTO_INCREMENT=2",
};

test('MySQL normalizes literal defaults and leaves unchanged native definitions alone', () => {
  const rows = createStructureDraft(details);
  assert.equal(rows[1].defaultValue, "'draft'");
  assert.equal(buildStructurePlan(details, rows, 'mysql').sql, '');
  assert.equal(structureFingerprint(details), structureFingerprint({ ...details, definition: details.definition.replace('AUTO_INCREMENT=2', 'AUTO_INCREMENT=78') }));
  assert.notEqual(structureFingerprint(details), structureFingerprint({ ...details, definition: details.definition.replace('utf8mb4_bin', 'utf8mb4_general_ci') }));
});

test('MySQL native CHANGE/MODIFY preserves collation, generated, identity, visibility and automatic timestamps', () => {
  const rows = createStructureDraft(details);
  rows[0].name = 'row_id';
  Object.assign(rows[1], { name: 'label', dataType: 'varchar(128)', nullable: true, defaultValue: "'ready'", comment: "新\\路径'" });
  rows[2].comment = 'updated automatically'; rows[3].comment = 'computed';
  const { sql } = buildStructurePlan(details, rows, 'mysql');
  assert.match(sql, /CHANGE COLUMN `id` `row_id` tinyint unsigned NOT NULL AUTO_INCREMENT/);
  assert.match(sql, /CHANGE COLUMN `name` `label` varchar\(128\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT 'ready'/);
  assert.ok(sql.includes("COMMENT '新\\\\路径'''"));
  assert.match(sql, /ON UPDATE CURRENT_TIMESTAMP\(6\)/);
  assert.match(sql, /GENERATED ALWAYS AS \(\(`id` % 97\)\) STORED INVISIBLE/);
  rows[1].dataType = 'int';
  assert.throws(() => buildStructurePlan(details, rows, 'mysql'), /字符集/);
});

test('MySQL NO_BACKSLASH_ESCAPES retains native literals and quotes comments correctly', () => {
  const native = { ...details, mysql: { ...details.mysql, sqlMode: 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES' }, definition: details.definition.replace("'draft'", "'path\\'") };
  assert.equal(mysqlColumns(native).get('name').defaultValue, "'path\\'");
  const rows = createStructureDraft(native); rows[1].comment = "path\\'data";
  assert.ok(buildStructurePlan(native, rows, 'mysql').sql.includes("DEFAULT 'path\\' COMMENT 'path\\''data'"));
});

test('MySQL defaults distinguish scalar and expression-only types and support smaller AUTO_INCREMENT types', () => {
  assert.equal(mysqlDefaultClause("'draft'", 'varchar(64)'), " DEFAULT 'draft'");
  assert.equal(mysqlDefaultClause('CURRENT_TIMESTAMP(6)', 'timestamp(6)'), ' DEFAULT CURRENT_TIMESTAMP(6)');
  assert.equal(mysqlDefaultClause("'text'", 'text'), " DEFAULT ('text')");
  assert.equal(mysqlDefaultClause('JSON_OBJECT()', 'json'), ' DEFAULT (JSON_OBJECT())');
  for (const type of ['tinyint unsigned', 'mediumint', 'smallint']) {
    const plan = buildCreateTablePlan({ schema: 'app', name: '表'.repeat(64) }, [{ name: 'id', dataType: type, identity: true, primaryKey: true, nullable: false, defaultValue: '' }], 'mysql');
    assert.ok(plan.sql.includes(`${type} AUTO_INCREMENT`));
  }
});

test('MySQL DDL invalidation finds qualified/renamed/dropped targets without reading literals or comments', () => {
  assert.deepEqual(mysqlDdlTargets("/* DROP TABLE fake */ ALTER TABLE `a.b`.`te``st` ADD x int; RENAME TABLE old TO new, `other`.`x` TO `other`.`y`; DROP TABLE IF EXISTS x,y; SELECT 'ALTER TABLE nope'", 'app'), [
    { database: 'a.b', name: 'te`st' }, { database: 'app', name: 'old' }, { database: 'app', name: 'new' },
    { database: 'other', name: 'x' }, { database: 'other', name: 'y' }, { database: 'app', name: 'x' }, { database: 'app', name: 'y' },
  ]);
});

test('MySQL typed literals encode BIT/boolean and arbitrary binary exactly', () => {
  assert.equal(sqlTypedValueLiteral(true, 'tinyint(1)', 'mysql'), '1');
  assert.equal(sqlTypedValueLiteral('false', 'tinyint(1)', 'mysql'), '0');
  assert.equal(sqlTypedValueLiteral('255', 'bit(8)', 'mysql'), '255');
  assert.equal(sqlTypedValueLiteral(true, 'bit(1)', 'mysql'), '1');
  assert.throws(() => sqlTypedValueLiteral('256', 'bit(8)', 'mysql'), /范围/);
  assert.equal(sqlTypedValueLiteral({ $dbStudio: 'mysql-binary', hex: '00ff5c' }, 'blob', 'mysql'), "X'00ff5c'");
  assert.equal(sqlTypedValueLiteral('0x', 'varbinary(255)', 'mysql'), "X''");
  assert.throws(() => sqlTypedValueLiteral('0xf', 'blob', 'mysql'), /十六进制/);
  assert.throws(() => sqlTypedValueLiteral('0x0011', 'point', 'mysql'), /ST_GeomFromWKB/);
});

test('MySQL cell editing locates composite BIT and binary primary keys using their real types', () => {
  const raw = { $dbStudio: 'mysql-binary', hex: '00ff' };
  const columns = [{ name: 'mask', dataType: 'bit(8)', primaryKey: true }, { name: 'raw_key', dataType: 'varbinary(8)', primaryKey: true }, { name: 'label', dataType: 'varchar(32)', nullable: true }];
  const tab = { connectionId: 'db', mode: 'write', browse: { schema: 'app', name: 'keys', kind: 'table', primaryKeys: ['mask', 'raw_key'], columns }, result: { executed: true, columns: ['mask', 'raw_key', 'label'], rows: [['255', raw, 'before']] } };
  assert.equal(getCellEditCapability(tab, { rowIndex: 0, columnIndex: 2 }, 'mysql').editable, true);
  const sql = buildCellUpdateSql({ ...tab.browse, driver: 'mysql', columns: tab.result.columns, row: tab.result.rows[0], column: 'label', value: 'after', keyTypes: Object.fromEntries(columns.map(field => [field.name, field.dataType])) });
  assert.match(sql, /WHERE `mask` <=> 255 AND `raw_key` <=> X'00ff';$/);
});

test('MySQL every structured transfer format can reimport binary, bit, bool, uint64 and decimal values', async () => {
  const columns = [
    { name: 'external_id', dataType: 'bigint unsigned', nullable: false }, { name: 'flag', dataType: 'tinyint(1)', nullable: false },
    { name: 'mask', dataType: 'bit(8)', nullable: false }, { name: 'raw', dataType: 'blob', nullable: true },
    { name: 'amount', dataType: 'decimal(30,10)', nullable: true },
  ];
  const table = { schema: 'app', name: 'items', kind: 'table', columns };
  const data = { columns: columns.map(column => column.name), rows: [['18446744073709551615', true, '255', { $dbStudio: 'mysql-binary', hex: '00ff27415c' }, '12345678901234567890.1234567890']] };
  for (const format of ['json', 'csv', 'txt', 'xlsx']) {
    const exported = await createExport(data, format, { table, driver: 'mysql' });
    const file = { name: exported.name, size: exported.bytes?.length || Buffer.byteLength(exported.contents), text: async () => exported.contents, arrayBuffer: async () => exported.bytes };
    const imported = await readTransferFile(file);
    const sql = buildImportSql(imported, data.columns, table, 'mysql');
    assert.match(sql, /, 1, 255, X'00ff27415c',/);
    assert.ok(sql.includes(Buffer.from(data.rows[0][0]).toString('hex')));
    assert.ok(sql.includes(Buffer.from(data.rows[0][4]).toString('hex')));
  }
});
