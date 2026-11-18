import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlColumns, mysqlDdlTargets, mysqlDefaultClause, mysqlCommentLiteral } from '../src/mysql-ddl.js';
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

test('MySQL reorders existing columns with their complete native definitions', () => {
  const metadata = { ...details, definition: details.definition.replace('STORED INVISIBLE', 'STORED /*!80023 INVISIBLE */') };
  const [id, name, updated, computed] = createStructureDraft(metadata);
  const { sql, changed, dropped } = buildStructurePlan(metadata, [computed, id, updated, name], 'mysql');
  assert.equal(changed, 2);
  assert.equal(dropped, 0);
  assert.match(sql, /MODIFY COLUMN `computed` int GENERATED ALWAYS AS \(\(`id` % 97\)\) STORED \/\*!80023 INVISIBLE \*\/ FIRST/);
  assert.match(sql, /MODIFY COLUMN `updated` timestamp\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(6\) ON UPDATE CURRENT_TIMESTAMP\(6\) AFTER `id`/);
  assert.equal(buildStructurePlan(metadata, [id, name, updated, computed], 'mysql').sql, '');
});

test('MySQL combines ordering with renamed anchors, added columns and removed columns', () => {
  const [id, name, updated, computed] = createStructureDraft(details);
  name.name = 'label';
  updated.removed = true;
  const added = { name: 'note', dataType: 'text', nullable: true, defaultValue: '', comment: '' };
  const { sql } = buildStructurePlan(details, [name, added, computed, updated, id], 'mysql');
  assert.match(sql, /CHANGE COLUMN `name` `label` [^\n]+ COMMENT 'keep' FIRST/);
  assert.match(sql, /ADD COLUMN `note` text AFTER `label`/);
  assert.match(sql, /MODIFY COLUMN `computed` [^\n]+ AFTER `note`/);
  assert.match(sql, /DROP COLUMN `updated`/);
});

test('MySQL changing a default during a move keeps versioned visibility separate', () => {
  const metadata = { ...details, definition: details.definition.replace("COMMENT 'keep'", '/*!80023 INVISIBLE */') };
  const [id, name, ...rest] = createStructureDraft(metadata);
  assert.equal(name.defaultValue, "'draft'");
  name.defaultValue = "'ready'";
  const { sql } = buildStructurePlan(metadata, [name, id, ...rest], 'mysql');
  assert.match(sql, /COLLATE utf8mb4_bin NOT NULL \/\*!80023 INVISIBLE \*\/ DEFAULT 'ready' FIRST/);
});

test('MySQL comment plans bind their exact backslash mode and keep real line endings', () => {
  const comment = "中文\r\nnext\n  trailing spaces  \\n path\\'";
  for (const mode of ['', 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES']) {
    const noBackslash = mode.includes('NO_BACKSLASH_ESCAPES');
    const rows = [{ name: 'note', dataType: 'text', nullable: true, defaultValue: '', comment }];
    const create = buildCreateTablePlan({ schema: 'app', name: 'notes', mysql: { sqlMode: mode } }, rows, 'mysql');
    assert.equal(create.expectedMysqlNoBackslashEscapes, noBackslash);
    assert.ok(create.sql.includes(`COMMENT ${mysqlCommentLiteral(comment, mode)}`));
    assert.ok(create.sql.includes('中文\r\nnext\n  trailing spaces  '));
    const editDetails = { ...details, mysql: { ...details.mysql, sqlMode: mode } };
    const draft = createStructureDraft(editDetails);
    draft.push({ name: 'new_note', dataType: 'text', nullable: true, defaultValue: '', comment });
    draft[1].comment = comment;
    const alter = buildStructurePlan(editDetails, draft, 'mysql');
    assert.equal(alter.expectedMysqlNoBackslashEscapes, noBackslash);
    assert.equal(alter.sql.split(`COMMENT ${mysqlCommentLiteral(comment, mode)}`).length - 1, 2);
  }
  assert.throws(() => mysqlCommentLiteral('path\\', undefined), /SQL_MODE/);
  assert.equal(mysqlCommentLiteral("it's\r\n原文", undefined), "'it''s\r\n原文'");
  assert.throws(() => mysqlColumns({ ...details, mysql: { engine: 'InnoDB' } }), /SQL_MODE/);
});

test('MySQL comments reject lossy metadata before CREATE, ADD and MODIFY in every SQL mode', () => {
  for (const mode of ['', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES']) {
    assert.equal(mysqlCommentLiteral('界'.repeat(1024), mode), `'${'界'.repeat(1024)}'`);
    assert.equal(mysqlCommentLiteral("'".repeat(1024), mode), `'${"''".repeat(1024)}'`);
    for (const invalid of ['x'.repeat(1025), '界'.repeat(1025), 'x'.repeat(1023) + '\r\n', 'emoji😀', '\ud800', '\0']) {
      assert.throws(() => mysqlCommentLiteral(invalid, mode), /备注/);
      assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'notes', mysql: { sqlMode: mode } }, [{ name: 'note', dataType: 'text', nullable: true, defaultValue: '', comment: invalid }], 'mysql'), /备注/);
      const editDetails = { ...details, mysql: { ...details.mysql, sqlMode: mode } };
      const draft = createStructureDraft(editDetails); draft[1].comment = invalid;
      assert.throws(() => buildStructurePlan(editDetails, draft, 'mysql'), /备注/);
      const added = createStructureDraft(editDetails); added.push({ name: 'new_note', dataType: 'text', nullable: true, defaultValue: '', comment: invalid });
      assert.throws(() => buildStructurePlan(editDetails, added, 'mysql'), /备注/);
    }
  }
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
