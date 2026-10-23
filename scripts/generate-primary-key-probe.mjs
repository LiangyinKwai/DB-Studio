import { pathToFileURL } from 'node:url';
import { buildCellUpdateSql, getCellEditCapability } from '../src/cell-edit.js';

export function primaryKeyProbe(driver, schema, name) {
  const fields = [{ name: 'id', dataType: 'bigint', primaryKey: true, identity: true, identityGeneration: driver === 'postgres' ? 'byDefault' : null }, { name: 'tenant', dataType: 'varchar(64)', primaryKey: true }, { name: 'label', dataType: 'varchar(64)', nullable: true }];
  const browse = { schema, name, kind: 'table', columns: fields, primaryKeys: ['id', 'tenant'] };
  const columns = fields.map(field => field.name);
  const first = ['9007199254740993', 'original', 'before'];
  const tab = { connectionId: 'probe', mode: 'write', browse, result: { executed: true, columns, rows: [first] } };
  if (!getCellEditCapability(tab, { columnIndex: 0, rowIndex: 0 }, driver).editable) throw new Error('identity primary key is not editable');
  const update = (row, column, value) => buildCellUpdateSql({ ...browse, driver, columns, row, column, value, keyTypes: Object.fromEntries(fields.map(field => [field.name, field.dataType])) });
  const next = ['9007199254740997', 'changed', 'after'];
  return {
    firstId: update(first, 'id', next[0]),
    secondKey: update([next[0], first[1], first[2]], 'tenant', next[1]),
    followup: update([next[0], next[1], first[2]], 'label', next[2]),
    duplicate: update(next, 'id', '9007199254740995'),
    rollback: update(next, 'id', '9007199254740999'),
    restricted: update(next, 'id', '9007199254741001'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(primaryKeyProbe(...process.argv.slice(2))));
