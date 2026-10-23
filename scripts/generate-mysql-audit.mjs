import { readFileSync } from 'node:fs';
import { buildCreateTablePlan, buildStructurePlan, createStructureDraft } from '../src/structure-editor.js';
import { createExport, buildImportSql } from '../src/data-transfer.js';
import { buildCellUpdateSql } from '../src/cell-edit.js';

const [mode, schema, name, metadata] = process.argv.slice(2);
if (mode === 'create') {
  const rows = [
    { name: 'id', dataType: 'tinyint unsigned', nullable: false, primaryKey: true, identity: true, defaultValue: '', comment: '自增' },
    { name: 'external_id', dataType: 'bigint unsigned', nullable: false, defaultValue: '0', comment: '' },
    { name: 'name', dataType: 'varchar(64)', nullable: false, defaultValue: "'draft'", comment: '文本默认值' },
    { name: 'payload', dataType: 'json', nullable: true, defaultValue: "JSON_OBJECT('ready', true)", comment: '' },
    { name: 'flag', dataType: 'tinyint(1)', nullable: false, defaultValue: '0', comment: '' },
    { name: 'mask', dataType: 'bit(8)', nullable: false, defaultValue: '0', comment: '' },
    { name: 'raw_data', dataType: 'blob', nullable: true, defaultValue: '', comment: '' },
    { name: 'obsolete', dataType: 'varchar(10)', nullable: true, defaultValue: '', comment: '' },
    { name: 'created_at', dataType: 'timestamp(6)', nullable: false, defaultValue: 'CURRENT_TIMESTAMP(6)', comment: '' },
  ];
  console.log(JSON.stringify(buildCreateTablePlan({ schema, name }, rows, 'mysql')));
} else if (mode === 'alter') {
  const details = JSON.parse(readFileSync(metadata, 'utf8'));
  const rows = createStructureDraft(details);
  Object.assign(rows.find(row => row.name === 'name'), { name: 'label', dataType: 'varchar(128)', nullable: true, defaultValue: "'changed'", comment: "新的\\路径'中文" });
  rows.find(row => row.name === 'id').name = 'row_id';
  rows.find(row => row.name === 'obsolete').removed = true;
  rows.find(row => row.name === 'updated_at').comment = '保留自动更新时间';
  rows.find(row => row.name === 'computed').comment = '保留生成表达式';
  rows.push({ name: 'amount', dataType: 'decimal(12,2)', nullable: false, defaultValue: '1.25', comment: '' });
  console.log(JSON.stringify(buildStructurePlan(details, rows, 'mysql')));
} else if (mode === 'import') {
  const table = JSON.parse(readFileSync(metadata, 'utf8'));
  const data = { columns: ['external_id', 'label', 'payload', 'flag', 'mask', 'raw_data'], rows: [['18446744073709551615', "中文 'quote' \\ path", '{"n":9007199254740993}', true, '255', { $dbStudio: 'mysql-binary', hex: '00ff27415c' }]] };
  console.log(JSON.stringify({ sql: buildImportSql(data, data.columns, table, 'mysql') }));
} else if (mode === 'export') {
  const { table, data } = JSON.parse(readFileSync(metadata, 'utf8'));
  console.log(JSON.stringify(await createExport(data, 'sql', { table, driver: 'mysql', title: name })));
} else if (mode === 'key-update') {
  console.log(JSON.stringify({ sql: buildCellUpdateSql({ schema, name, driver: 'mysql', column: 'label', columns: ['mask', 'raw_key', 'label'], primaryKeys: ['mask', 'raw_key'], keyTypes: { mask: 'bit(8)', raw_key: 'varbinary(8)' }, row: ['255', { $dbStudio: 'mysql-binary', hex: '00ff' }, 'before'], value: 'after' }) }));
} else throw new Error('unknown audit generator mode');
