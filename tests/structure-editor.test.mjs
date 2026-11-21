import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateTablePlan, buildStructurePlan, createStructureDraft, structureFingerprint } from '../src/structure-editor.js';
import { newStructureKey, structureKeyDrafts } from '../src/structure-keys.js';
const details = { id: '1', schema: 'pub"lic', name: 'orders', kind: 'table', columns: [
  { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true },
  { name: 'status', dataType: 'text', nullable: true, defaultValue: "'draft'::text", comment: '状态' },
  { name: 'computed', dataType: 'integer', nullable: true, generated: true, defaultValue: '1 + 1' },
] };
test('unchanged structure emits no SQL and preserves identity/generated expressions', () => {
  assert.equal(buildStructurePlan(details, createStructureDraft(details)).sql, '');
  const rows = createStructureDraft(details);
  rows[0].defaultValue = '4';
  assert.throws(() => buildStructurePlan(details, rows), /自增/);
  rows[0].defaultValue = '';
  rows[2].dataType = 'bigint';
  assert.throws(() => buildStructurePlan(details, rows), /生成/);
});
test('PostgreSQL plan changes properties before rename and quotes comments', () => {
  const rows = createStructureDraft(details);
  Object.assign(rows[1], { name: 'new"name', dataType: 'varchar(128)', nullable: false, defaultValue: "'ready'", comment: "it's \\ done" });
  const { sql } = buildStructurePlan(details, rows);
  assert.match(sql, /ALTER TABLE "pub""lic"\."orders" ALTER COLUMN "status" TYPE varchar\(128\);/);
  assert.ok(sql.indexOf('SET DEFAULT') < sql.indexOf('RENAME COLUMN'));
  assert.match(sql, /RENAME COLUMN "status" TO "new""name";/);
  assert.ok(sql.includes("IS E'it''s \\\\ done';"));
});
test('field addition/drop supports typed defaults and never cascades', () => {
  const rows = createStructureDraft(details);
  rows[1].removed = true;
  rows.push({ name: 'amount', dataType: 'numeric(12,2)', nullable: false, defaultValue: '0', comment: '' });
  const plan = buildStructurePlan(details, rows);
  assert.equal(plan.dropped, 1);
  assert.match(plan.sql, /ADD COLUMN "amount" numeric\(12,2\) NOT NULL DEFAULT \(0\);/);
  assert.ok(!plan.sql.includes('CASCADE'));
});
test('rejects duplicate names, primary key nullability and fragments that append clauses', () => {
  const rows = createStructureDraft(details);
  rows[1].name = 'id';
  assert.throws(() => buildStructurePlan(details, rows), /重复|已存在/);
  rows[1].name = 'status'; rows[0].nullable = true;
  assert.throws(() => buildStructurePlan(details, rows), /主键/);
  rows[0].nullable = false;
  for (const value of ['0; DROP TABLE t', '0, DROP COLUMN id', '0 -- comment', '0 /* comment */', '0)']) {
    rows[1].defaultValue = value;
    assert.throws(() => buildStructurePlan(details, rows));
  }
  rows[1].defaultValue = "'a;b,--c''d'";
  assert.ok(buildStructurePlan(details, rows).sql.includes("'a;b,--c''d'"));
});
test('MySQL emits one ALTER for add/rename/drop and never rewrites existing attributes', () => {
  const mysql = { ...details, schema: 'app', columns: details.columns.map((c) => ({ ...c })) };
  const rows = createStructureDraft(mysql);
  rows[1].name = 'state'; rows[2].removed = true;
  rows.push({ name: 'note', dataType: 'varchar(255)', nullable: true, defaultValue: "'hello'", comment: "a'b" });
  const { sql } = buildStructurePlan(mysql, rows, 'mysql');
  assert.equal((sql.match(/ALTER TABLE/g) || []).length, 1);
  assert.match(sql, /RENAME COLUMN `status` TO `state`,/);
  assert.match(sql, /COMMENT 'a''b'/);
  rows[0].dataType = 'int';
  assert.throws(() => buildStructurePlan(mysql, rows, 'mysql'));
});
test('catalog fingerprint detects external column, identity and constraint changes', () => {
  assert.notEqual(structureFingerprint(details), structureFingerprint({ ...details, columns: details.columns.slice(1) }));
  assert.notEqual(structureFingerprint(details), structureFingerprint({ ...details, constraints: [{ name: 'new' }] }));
});

const newRows = () => [
  { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true, defaultValue: '', comment: '' },
  { name: 'status', dataType: 'varchar(64)', nullable: false, defaultValue: "'draft'", comment: "状态 'draft'" },
];
test('new tables include composite indexes and constraints with dialect-specific DDL', () => {
  for (const driver of ['postgres', 'mysql']) {
    const rows = newRows();
    const indexes = [{ ...newStructureKey('index'), name: 'idx_order', columns: [rows[1], rows[0]], unique: true }];
    const constraints = [
      { ...newStructureKey('check'), name: 'status_check', expression: "status <> 'unavailable'" },
      { ...newStructureKey('foreign_key'), name: 'status_ref', columns: [rows[1]], referenceTable: 'statuses',
        referenceColumns: 'code', onDelete: 'RESTRICT' },
    ];
    const target = { schema: 'app', name: 'orders' };
    const { sql } = buildCreateTablePlan(target, rows, driver, { indexes, constraints });
    if (driver === 'mysql') {
      assert.match(sql, /UNIQUE KEY `idx_order` \(`status`, `id`\)/);
      assert.match(sql, /CONSTRAINT `status_check` CHECK \(status <> 'unavailable'\) ENFORCED/);
      assert.match(sql, /REFERENCES `app`\.`statuses` \(`code`\) ON DELETE RESTRICT/);
      assert.equal(sql.split(';').filter(Boolean).length, 1);
    } else {
      assert.match(sql, /CREATE UNIQUE INDEX "idx_order" ON "app"\."orders" \("status", "id"\);/);
      assert.match(sql, /ALTER TABLE "app"\."orders" ADD CONSTRAINT "status_ref"/);
      assert.ok(sql.indexOf('CREATE UNIQUE INDEX') < sql.indexOf('ADD CONSTRAINT "status_ref"'));
    }
    rows[1].removed = true;
    assert.throws(() => buildCreateTablePlan(target, rows, driver, { indexes, constraints }), /有效的字段/);
    rows[1].removed = false;
    constraints[0].expression = "1); DROP TABLE orders;";
    assert.throws(() => buildCreateTablePlan(target, rows, driver, { indexes, constraints }), /检查表达式/);
  }
});
test('editing simple indexes and check constraints preserves untouched definitions', () => {
  for (const driver of ['postgres', 'mysql']) {
    const mysql = driver === 'mysql';
    const table = { ...details, schema: 'app', indexes: [
      { name: 'orders_pkey', primary: true, definition: 'PRIMARY KEY (id)' },
      { name: 'status_idx', definition: mysql ? 'KEY `status_idx` (`status`)' : 'CREATE INDEX status_idx ON app.orders USING btree (status)' },
      { name: 'special_idx', definition: mysql ? 'KEY `special_idx` (`status`(4))' : 'CREATE INDEX special_idx ON app.orders USING btree (status) WHERE status IS NOT NULL' },
    ], constraints: [
      { name: 'status_check', kind: 'CHECK', definition: mysql ? "CONSTRAINT `status_check` CHECK ((`status` <> ''))" : "CHECK (status <> ''::text)" },
    ] };
    const rows = createStructureDraft(table);
    const keys = structureKeyDrafts(table, rows, driver);
    assert.equal(buildStructurePlan(table, rows, driver, '', keys).sql, '');
    assert.equal(keys.indexes[0].managed, 'primary');
    assert.equal(keys.indexes[2].complex, true);
    keys.indexes[1].columns = [rows[0], rows[1]];
    keys.constraints[0].expression = "status <> 'cancelled'";
    const plan = buildStructurePlan(table, rows, driver, '', keys);
    assert.equal(plan.indexesChanged, 1);
    assert.equal(plan.constraintsChanged, 1);
    assert.doesNotMatch(plan.sql, /special_idx|orders_pkey/);
    if (mysql) {
      assert.match(plan.sql, /DROP INDEX `status_idx`/);
      assert.match(plan.sql, /ADD KEY `status_idx` \(`id`, `status`\)/);
      assert.match(plan.sql, /DROP CHECK `status_check`/);
      assert.equal(plan.sql.split(';').filter(Boolean).length, 1);
    } else {
      assert.match(plan.sql, /DROP INDEX "app"\."status_idx";/);
      assert.match(plan.sql, /CREATE INDEX "status_idx" ON "app"\."orders" \("id", "status"\);/);
      assert.match(plan.sql, /DROP CONSTRAINT "status_check"/);
    }
  }
});
test('creates PostgreSQL tables with the final name, identity, defaults and comments', () => {
  const plan = buildCreateTablePlan({ schema: 'app', name: '  new"table  ' }, newRows());
  assert.equal(plan.name, 'new"table');
  assert.match(plan.sql, /^CREATE TABLE "app"\."new""table"/);
  assert.match(plan.sql, /"id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL/);
  assert.match(plan.sql, /PRIMARY KEY \("id"\)/);
  assert.match(plan.sql, /DEFAULT \('draft'\)/);
  assert.match(plan.sql, /COMMENT ON COLUMN "app"\."new""table"\."status" IS E'状态 ''draft''';/);
});
test('creates MySQL tables with quoted identifiers, auto increment and inline comments', () => {
  const plan = buildCreateTablePlan({ schema: 'ware`house', name: 'items' }, newRows(), 'mysql');
  assert.match(plan.sql, /^CREATE TABLE `ware``house`\.`items`/);
  assert.match(plan.sql, /AUTO_INCREMENT NOT NULL/);
  assert.match(plan.sql, /COMMENT '状态 ''draft'''/);
  assert.match(plan.sql, /ENGINE=InnoDB;$/);
});
test('new tables reject empty names, duplicate columns and unsafe fragments', () => {
  assert.throws(() => buildCreateTablePlan({ schema: 'app', name: ' ' }, newRows()), /表名/);
  assert.throws(() => buildCreateTablePlan({ schema: 'app', name: '表'.repeat(22) }, newRows()), /63 字节/);
  assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'a'.repeat(65) }, newRows(), 'mysql'), /64 个字符/);
  assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'test' }, []), /字段/);
  for (const driver of ['postgres', 'mysql']) {
    const rows = newRows();
    rows[1].name = 'id';
    assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'test' }, rows, driver), /重复/);
    rows[1].name = 'status'; rows[1].dataType = 'text); DROP TABLE t;';
    assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'test' }, rows, driver));
  }
});
test('new table identity and primary key constraints stay consistent', () => {
  const target = { schema: 'app', name: 'test' };
  const rows = newRows();
  rows[0].nullable = true;
  assert.throws(() => buildCreateTablePlan(target, rows), /主键/);
  rows[0].nullable = false; rows[0].defaultValue = '0';
  assert.throws(() => buildCreateTablePlan(target, rows), /默认值/);
  rows[0].defaultValue = ''; rows[0].dataType = 'text';
  assert.throws(() => buildCreateTablePlan(target, rows), /整数/);
  rows[0].dataType = 'bigint'; rows[0].primaryKey = false;
  assert.throws(() => buildCreateTablePlan(target, rows, 'mysql'), /主键/);
  rows[0].identity = false;
  assert.ok(!buildCreateTablePlan(target, rows).sql.includes('PRIMARY KEY'));
});

test('MySQL new tables inherit database defaults or explicitly choose a matching collation', () => {
  const rows = [{ name: 'title', dataType: 'varchar(80)', nullable: true, defaultValue: '', comment: '' }];
  const inherited = buildCreateTablePlan({ schema: 'app', name: 'posts' }, rows, 'mysql').sql;
  assert.match(inherited, /ENGINE=InnoDB;$/);
  const explicit = buildCreateTablePlan({ schema: 'app', name: 'posts', charset: 'utf8mb4', collation: 'utf8mb4_bin' }, rows, 'mysql').sql;
  assert.match(explicit, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;$/);
  assert.throws(() => buildCreateTablePlan({ schema: 'app', name: 'posts', charset: 'latin1', collation: 'utf8mb4_bin' }, rows, 'mysql'), /不匹配/);
});

test('table comments can be set and cleared independently of columns', () => {
  const table = { schema: 'app', name: 'orders', kind: 'table', comment: 'old', columns: [{ name: 'id', dataType: 'int', nullable: true }] };
  const rows = createStructureDraft(table);
  const pg = buildStructurePlan(table, rows, 'postgres', "订单 O'Reilly");
  assert.equal(pg.sql, "COMMENT ON TABLE \"app\".\"orders\" IS E'订单 O''Reilly';");
  assert.equal(pg.tableCommentChanged, true);
  assert.equal(buildStructurePlan(table, rows, 'postgres', '').sql, 'COMMENT ON TABLE "app"."orders" IS NULL;');
  assert.notEqual(structureFingerprint(table), structureFingerprint({ ...table, comment: 'new' }));
  const mysql = { ...table, mysql: { sqlMode: 'NO_BACKSLASH_ESCAPES' } };
  const cleared = buildStructurePlan(mysql, rows, 'mysql', '');
  assert.equal(cleared.sql, "ALTER TABLE `app`.`orders`\n  COMMENT = '';");
  assert.match(buildCreateTablePlan(mysql, rows, 'mysql').sql, /COMMENT='old';$/);
  assert.match(buildCreateTablePlan(table, rows, 'postgres').sql, /COMMENT ON TABLE "app"\."orders" IS E'old';$/);
  assert.throws(() => buildCreateTablePlan({ ...mysql, comment: '字'.repeat(2049) }, rows, 'mysql'), /2048/);
});
