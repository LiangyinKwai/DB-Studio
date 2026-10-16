// Exercise the production planner against a disposable PostgreSQL instance.
import { writeFileSync } from 'node:fs';
import { buildCreateTablePlan, buildStructurePlan, createStructureDraft } from '../src/structure-editor.js';
const details = { schema: 'app', name: 'editor_probe', kind: 'table', columns: [
  { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true },
  { name: 'status', dataType: 'text', nullable: true, defaultValue: "'draft'::text" },
  { name: 'obsolete', dataType: 'text', nullable: true },
  { name: 'computed', dataType: 'integer', nullable: true, generated: true, defaultValue: '1 + 1' },
] };
const rows = createStructureDraft(details);
Object.assign(rows[1], { name: 'state"name', dataType: 'varchar(128)', nullable: false, defaultValue: "'ready'", comment: "状态 'ready' \\ note" });
rows[2].removed = true;
rows.push({ name: 'amount', dataType: 'numeric(12,2)', nullable: false, defaultValue: '0', comment: '金额' });
const create = buildCreateTablePlan({ schema: 'app', name: 'new"table' }, [
  { name: 'id', dataType: 'bigint', primaryKey: true, identity: true, nullable: false, defaultValue: '', comment: '' },
  { name: 'note', dataType: 'text', nullable: false, defaultValue: "'draft'", comment: "创建 '备注'" },
]);
writeFileSync(process.argv[2], `${buildStructurePlan(details, rows).sql}\n${create.sql}`);
