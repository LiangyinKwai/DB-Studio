const actions = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'];
const kinds = { unique: '唯一约束', check: '检查约束', foreign_key: '外键', primary_key: '主键', exclusion: '排除约束' };
const normalizeKind = value => String(value || '').toLowerCase().replaceAll(' ', '_');
const quoteFor = (mysql) => mysql ? '`' : '"';
const namePattern = mysql => mysql ? '`(?:[^`]|``)+`|[\\p{L}_][\\p{L}\\p{N}_$]*' : '"(?:[^"]|"")+"|[\\p{L}_][\\p{L}\\p{N}_$]*';
const unwrap = (value, quote) => value.startsWith(quote) ? value.slice(1, -1).replaceAll(quote.repeat(2), quote) : value;

function namesInList(text, mysql) {
  const name = namePattern(mysql);
  if (!new RegExp(`^\\s*(?:${name})(?:\\s*,\\s*(?:${name}))*\\s*$`, 'u').test(text)) return null;
  return [...text.matchAll(new RegExp(name, 'gu'))].map(match => unwrap(match[0], quoteFor(mysql)));
}

function editableDefinition(source, kind, mysql) {
  const name = namePattern(mysql);
  const definition = String(source.definition || '').trim();
  const clause = mysql ? definition.replace(new RegExp(`^CONSTRAINT\\s+(?:${name})\\s+`, 'iu'), '') : definition;
  if (kind === 'check') {
    const match = /^CHECK\s*\(([\s\S]+)\)(?:\s+ENFORCED)?$/i.exec(clause);
    return match ? { expression: match[1] } : null;
  }
  if (kind === 'foreign_key') {
    const match = new RegExp(`^FOREIGN KEY\\s*\\(([\\s\\S]+?)\\)\\s+REFERENCES\\s+(?:(${name})\\s*\\.\\s*)?(${name})\\s*\\(([\\s\\S]+?)\\)((?:\\s+ON (?:DELETE|UPDATE) (?:${actions.join('|')}))*)$`, 'iu').exec(clause);
    if (!match) return null;
    const columns = namesInList(match[1], mysql);
    const referenceColumns = namesInList(match[4], mysql);
    if (!columns || !referenceColumns) return null;
    const quote = quoteFor(mysql);
    return {
      columns,
      referenceSchema: match[2] ? unwrap(match[2], quote) : '',
      referenceTable: unwrap(match[3], quote),
      referenceColumns: match[4],
      onDelete: match[5].match(/ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL)/i)?.[1].toUpperCase() || '',
      onUpdate: match[5].match(/ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL)/i)?.[1].toUpperCase() || '',
    };
  }
  const prefix = kind === 'primary_key' ? '^PRIMARY KEY\\s*' : mysql
    ? `^(?:UNIQUE\\s+)?KEY\\s+(?:${name})\\s*`
    : kind === 'unique' ? '^UNIQUE\\s*' : '^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+.+\\sUSING\\s+btree\\s*';
  const match = new RegExp(prefix + '\\(([\\s\\S]*)\\)$', 'iu').exec(clause);
  const columns = match && namesInList(match[1], mysql);
  return columns ? { columns } : null;
}

export function newStructureKey(kind) {
  return { kind, name: '', unique: false, columns: [], expression: '', referenceSchema: '',
    referenceTable: '', referenceColumns: '', onDelete: '', onUpdate: '' };
}

export function structureKeyDrafts(details, columns, driver) {
  const mysql = driver === 'mysql';
  const ownedIndexes = new Set(details.tableDdl?.constraintIndexes || []);
  for (const constraint of details.constraints || []) {
    if (['unique', 'exclusion'].includes(normalizeKind(constraint.kind))) ownedIndexes.add(constraint.name);
  }
  const draft = (source, kind, managed) => {
    const parsed = managed ? null : editableDefinition(source, kind, mysql);
    const row = { ...newStructureKey(kind), name: source.name, unique: Boolean(source.unique), ...parsed };
    row.columns = row.columns.map(name => columns.find(column => column.original?.name === name) || name);
    return {
      ...row,
      original: row,
      definition: source.definition,
      managed,
      complex: !managed && !parsed,
    };
  };
  return {
    indexes: (details.indexes || []).map(index => draft(index, 'index', index.primary ? 'primary' : ownedIndexes.has(index.name) ? 'constraint' : '')),
    constraints: (details.constraints || []).map(constraint => {
      const kind = normalizeKind(constraint.kind);
      return draft(constraint, kind, !['primary_key', 'unique', 'check', 'foreign_key'].includes(kind) ? 'unsupported' : '');
    }),
  };
}

export function structureKeyChanged(row) {
  const original = row.original;
  return row.removed || !original || Object.keys(newStructureKey(row.kind)).some(key => {
    if (key === 'columns') return row.columns.length !== original.columns.length || row.columns.some((column, index) => column !== original.columns[index]);
    return row[key] !== original[key];
  });
}

export function structureKeyLabel(row) {
  return row.kind === 'index' ? row.managed === 'primary' ? '主键索引' : row.unique ? '唯一索引' : '普通索引' : kinds[row.kind] || row.kind;
}

export const foreignKeyActions = actions;

export function buildKeyChanges(details, columns, keys, { mysql, q, validateExpression }) {
  const result = { dropClauses: [], addClauses: [], foreignKeys: [], dropIndexes: [], createIndexes: [], indexesChanged: 0, constraintsChanged: 0, keysDropped: 0 };
  if (!keys) return result;
  const table = `${q(details.schema)}.${q(details.name)}`;
  const kept = columns.filter(column => !column.removed);
  const columnNames = new Set(kept.map(column => column.name));
  const rows = [...keys.constraints, ...keys.indexes];
  const changes = rows.filter(structureKeyChanged);
  if (keys.constraints.filter(row => row.kind === 'primary_key' && !row.removed).length > 1) {
    throw new Error('每张表只能有一个主键');
  }
  if (mysql && changes.some(row => row.original?.kind === 'foreign_key') &&
      changes.some(row => !row.removed && row.kind === 'foreign_key')) {
    throw new Error('MySQL 请分两次保存外键的移除和添加，避免一次修改只应用一部分');
  }
  const normalizedName = name => mysql ? name.toLowerCase() : name;
  const occupiesIndexName = row => ['index', 'unique', 'primary_key'].includes(row.kind);
  for (const row of changes) {
    if (row.managed || (row.complex && !row.removed)) throw new Error('该定义含有高级选项，请在 SQL 编辑器中修改');
    const original = row.original;
    if (row.kind === 'index') result.indexesChanged++;
    else result.constraintsChanged++;
    if (original) {
      const oldName = q(original.name);
      if (original.kind === 'index' && !mysql) result.dropIndexes.push(`DROP INDEX ${q(details.schema)}.${oldName};`);
      else if (mysql && original.kind === 'primary_key') result.dropClauses.push('DROP PRIMARY KEY');
      else {
        const kind = mysql ? ({ index: 'INDEX', unique: 'INDEX', check: 'CHECK', foreign_key: 'FOREIGN KEY' })[original.kind] : 'CONSTRAINT';
        result.dropClauses.push(`DROP ${kind} ${oldName}`);
      }
      if (row.removed) result.keysDropped++;
    }
    if (row.removed) continue;
    const name = mysql && row.kind === 'primary_key' ? 'PRIMARY' : row.name;
    if (!name.trim()) throw new Error(`请输入${structureKeyLabel(row)}名称`);
    if (!mysql && new TextEncoder().encode(name).length > 63) throw new Error('索引和约束名称不能超过 63 字节');
    const duplicate = rows.some(other => other !== row && !other.removed && normalizedName(other.name) === normalizedName(name) &&
      ((occupiesIndexName(row) && occupiesIndexName(other) && !other.managed) ||
       (row.kind !== 'index' && other.kind !== 'index' && (!mysql || other.kind === row.kind))));
    if (duplicate || (mysql && row.kind !== 'primary_key' && occupiesIndexName(row) && name.toUpperCase() === 'PRIMARY')) throw new Error(`索引或约束名称已存在：${name}`);
    const identifier = q(name);
    const constraint = `CONSTRAINT ${identifier}`;
    if (row.kind === 'check') {
      if (!row.expression.trim()) throw new Error(`请填写 ${name} 的检查表达式`);
      result.addClauses.push(`${constraint} CHECK (${validateExpression(row.expression, name)})${mysql ? ' ENFORCED' : ''}`);
      continue;
    }
    const names = row.columns.map(column => typeof column === 'string' ? column : kept.includes(column) ? column.name : '');
    if (!names.length || names.some(column => !column || !columnNames.has(column)) || new Set(names).size !== names.length) {
      throw new Error(`请为 ${name} 选择有效的字段`);
    }
    const fieldList = names.map(q).join(', ');
    if (row.kind === 'index') {
      const unique = row.unique ? 'UNIQUE ' : '';
      if (mysql) result.addClauses.push(`${unique}KEY ${identifier} (${fieldList})`);
      else result.createIndexes.push(`CREATE ${unique}INDEX ${identifier} ON ${table} (${fieldList});`);
    } else if (row.kind === 'unique') {
      result.addClauses.push(mysql ? `UNIQUE KEY ${identifier} (${fieldList})` : `${constraint} UNIQUE (${fieldList})`);
    } else if (row.kind === 'primary_key') {
      result.addClauses.push(`${mysql ? '' : `${constraint} `}PRIMARY KEY (${fieldList})`);
    } else if (row.kind === 'foreign_key') {
      const referenced = namesInList(row.referenceColumns, mysql);
      if (!row.referenceTable.trim() || !referenced || referenced.length !== names.length) throw new Error(`请填写 ${name} 的引用表及等量的引用字段`);
      const relation = `${q(row.referenceSchema.trim() ? row.referenceSchema : details.schema)}.${q(row.referenceTable)}`;
      const rule = (event, value) => {
        if (!value) return '';
        if (!actions.includes(value)) throw new Error('外键动作无效');
        return ` ON ${event} ${value}`;
      };
      result.foreignKeys.push(`${constraint} FOREIGN KEY (${fieldList}) REFERENCES ${relation} (${referenced.map(q).join(', ')})${rule('DELETE', row.onDelete)}${rule('UPDATE', row.onUpdate)}`);
    }
  }
  return result;
}
