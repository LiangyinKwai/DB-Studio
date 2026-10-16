import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTableDdl } from '../src/table-ddl.js';

const object = { schema: 'app', name: 'orders', kind: 'table' };
function postgresDetails() {
  return {
    ...object,
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false, identity: true, primaryKey: true, comment: '订单 ID' },
      { name: 'status', dataType: 'text', nullable: true, defaultValue: "'draft'::text", comment: "状态 'ready' \\ note" },
      { name: 'computed', dataType: 'integer', nullable: true, generated: true, defaultValue: '(1 + 1)', comment: null },
    ],
    constraints: [
      { name: 'orders_pkey', kind: 'primary_key', definition: 'PRIMARY KEY (id)' },
      { name: 'orders_status_key', kind: 'unique', definition: 'UNIQUE (status) DEFERRABLE INITIALLY DEFERRED' },
      { name: 'orders_check', kind: 'check', definition: 'CHECK ((id > 0)) NOT VALID' },
      { name: 'orders_parent', kind: 'foreign_key', definition: 'FOREIGN KEY (id) REFERENCES app.parents(id) ON DELETE CASCADE' },
    ],
    indexes: [
      { name: 'orders_pkey', primary: true, definition: 'CREATE UNIQUE INDEX orders_pkey ON app.orders USING btree (id)' },
      { name: 'orders_status_key', unique: true, definition: 'CREATE UNIQUE INDEX orders_status_key ON app.orders USING btree (status)' },
      { name: 'orders_partial', definition: 'CREATE INDEX orders_partial ON app.orders USING btree (lower(status)) WHERE (id > 5)' },
    ],
    comment: "订单 'abc' \\ 中文",
    tableDdl: {
      columnDefinitions: [
        '"id" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.orders_id_seq START WITH 10 INCREMENT BY 2 MINVALUE 1 MAXVALUE 999 CACHE 5 NO CYCLE) NOT NULL',
        '"status" text DEFAULT \'draft\'::text',
        '"computed" integer GENERATED ALWAYS AS ((1 + 1)) STORED',
      ],
      beforeStatements: ["SELECT pg_catalog.set_config('search_path', E'public', false);"],
      afterStatements: [], createPrefix: 'CREATE TABLE', createSuffix: '\nUSING "heap"\nWITH ("fillfactor" = E\'80\')',
      constraintIndexes: ['orders_pkey', 'orders_status_key'], unsupportedReason: null,
    },
  };
}

test('PostgreSQL DDL preserves identity/generated/default columns and all named constraints', () => {
  const ddl = buildTableDdl(object, postgresDetails());
  assert.match(ddl, /GENERATED ALWAYS AS IDENTITY \(SEQUENCE NAME app\.orders_id_seq START WITH 10 INCREMENT BY 2/);
  assert.match(ddl, /"status" text DEFAULT 'draft'::text/);
  assert.match(ddl, /"computed" integer GENERATED ALWAYS AS \(\(1 \+ 1\)\) STORED/);
  assert.match(ddl, /ADD CONSTRAINT "orders_status_key" UNIQUE \(status\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddl, /CHECK \(\(id > 0\)\) NOT VALID/);
  assert.match(ddl, /FOREIGN KEY \(id\) REFERENCES app.parents\(id\) ON DELETE CASCADE/);
  assert.match(ddl, /COMMENT ON COLUMN "app"\."orders"\."status" IS E'状态 ''ready'' \\\\ note';/);
  assert.match(ddl, /不含数据、权限\/所有者、触发器、规则和行级安全策略/);
});

test('PostgreSQL DDL emits ordinary indexes once and preserves composite constraint order', () => {
  const details = postgresDetails();
  details.constraints[0].definition = 'PRIMARY KEY (status, id)';
  const ddl = buildTableDdl(object, details);
  assert.match(ddl, /PRIMARY KEY \(status, id\)/);
  assert.equal((ddl.match(/CREATE INDEX orders_partial/g) || []).length, 1);
  assert.doesNotMatch(ddl, /CREATE UNIQUE INDEX orders_(pkey|status_key)/);
  details.constraints.reverse();
  const reversed = buildTableDdl(object, details);
  assert.ok(reversed.indexOf('ADD CONSTRAINT "orders_pkey"') < reversed.indexOf('ADD CONSTRAINT "orders_parent"'));
});

test('PostgreSQL DDL keeps owned sequence prerequisites, partitioning and quoted names', () => {
  const details = postgresDetails();
  details.name = 'ord"ers'; details.kind = 'partitioned_table';
  details.tableDdl.createSuffix = '\nPARTITION BY RANGE (id)';
  details.tableDdl.beforeStatements.push('CREATE SEQUENCE app.serial_seq START WITH 5');
  details.tableDdl.afterStatements.push('ALTER SEQUENCE app.serial_seq OWNED BY app.orders.id');
  const ddl = buildTableDdl({ ...object, name: details.name, kind: details.kind }, details);
  assert.ok(ddl.indexOf('CREATE SEQUENCE') < ddl.indexOf('CREATE TABLE "app"."ord""ers"'));
  assert.match(ddl, /PARTITION BY RANGE \(id\);/);
  assert.match(ddl, /ALTER SEQUENCE app.serial_seq OWNED BY app.orders.id;/);
});

test('PostgreSQL export rejects incomplete metadata instead of silently dropping structure', () => {
  for (const mutate of [
    details => { delete details.tableDdl; },
    details => { delete details.tableDdl.constraintIndexes; },
    details => { details.tableDdl.columnDefinitions.pop(); },
    details => { delete details.constraints; },
    details => { details.constraints[0].definition = ''; },
    details => { details.indexes.at(-1).definition = ''; },
    details => { details.tableDdl.unsupportedReason = '分区子表请使用 pg_dump'; },
    details => { details.name = 'another'; },
  ]) {
    const details = postgresDetails(); mutate(details);
    assert.throws(() => buildTableDdl(object, details));
  }
  assert.throws(() => buildTableDdl({ ...object, kind: 'foreign_table' }, postgresDetails()));
});

test('MySQL uses exact native DDL and qualifies target without rewriting native expressions/options', () => {
  const definition = "CREATE TABLE `orders` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `code` varchar(50) DEFAULT '001',\n  `computed` int GENERATED ALWAYS AS ((`id` + 1)) STORED,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `code_idx` (`code`(10)),\n  CONSTRAINT `positive` CHECK ((`id` > 0))\n) ENGINE=MyISAM AUTO_INCREMENT=123 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单'";
  const ddl = buildTableDdl(object, { ...object, definition }, 'mysql');
  assert.equal(ddl, definition.replace('CREATE TABLE `orders`', 'CREATE TABLE `app`.`orders`') + ';');
  assert.doesNotMatch(ddl, /ENGINE=InnoDB/);
  assert.match(ddl, /DEFAULT '001'/);
});

test('MySQL native target validation handles escaped backticks and refuses incomplete synthetic definitions', () => {
  const escaped = { schema: 'a`b', name: 'ord`ers', kind: 'table' };
  assert.equal(buildTableDdl(escaped, { definition: 'CREATE TABLE `ord``ers` (`id` int)' }, 'mysql'),
    'CREATE TABLE `a``b`.`ord``ers` (`id` int);');
  assert.equal(buildTableDdl(object, { definition: 'CREATE TABLE `app`.`orders` (`id` int);' }, 'mysql'),
    'CREATE TABLE `app`.`orders` (`id` int);');
  assert.throws(() => buildTableDdl(object, { definition: null, columns: [{ name: 'id' }] }, 'mysql'), /原生/);
  assert.throws(() => buildTableDdl(object, { definition: 'CREATE TABLE `wrong` (`id` int)' }, 'mysql'), /不一致/);
  assert.throws(() => buildTableDdl(object, { definition: 'CREATE TABLE `wrong`.`orders` (`id` int)' }, 'mysql'), /不一致/);
});
