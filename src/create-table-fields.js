// Keep convenience controls separate from the SQL draft. Unrecognized types
// remain editable SQL, including enums, arrays and schema-qualified types.
export function getTypeParameters(dataType) {
  const match = String(dataType ?? '').trim().match(/^(character\s+varying|character|varchar|char|varbinary|binary|decimal|numeric)(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?((?:\s+(?:unsigned|zerofill|binary))*)$/i);
  if (!match) return null;
  const [, base, first = '', second = '', suffix = ''] = match;
  if (/^(decimal|numeric)$/i.test(base)) return { kind: 'decimal', base, precision: first, scale: second, suffix };
  if (second) return null;
  return { kind: 'length', base, length: first, suffix };
}

function parameter(value, label, { optional = false, zero = false } = {}) {
  const text = String(value ?? '').trim();
  if (optional && !text) return '';
  if (!/^\d+$/.test(text) || (!zero && !/[1-9]/.test(text))) throw new Error(`${label}必须为${zero ? '非负' : '正'}整数`);
  return text;
}

export function updateTypeParameters(dataType, values = {}) {
  const current = getTypeParameters(dataType);
  if (!current) return String(dataType ?? '');
  if (current.kind === 'length') {
    const length = parameter(Object.hasOwn(values, 'length') ? values.length : current.length, '长度');
    return `${current.base}(${length})${current.suffix}`;
  }
  const precision = parameter(Object.hasOwn(values, 'precision') ? values.precision : current.precision, '精度');
  const scale = parameter(Object.hasOwn(values, 'scale') ? values.scale : current.scale, '小数位', { optional: true, zero: true });
  // Scale/precision limits vary by server. In particular PostgreSQL permits
  // scale greater than precision; do not narrow valid SQL without a driver.
  return `${current.base}(${precision}${scale ? `,${scale}` : ''})${current.suffix}`;
}

function validText(value) {
  const text = String(value ?? '');
  if (text.includes('\0')) throw new Error('默认值不支持空字符');
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('默认值包含无效的 Unicode 字符');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('默认值包含无效的 Unicode 字符');
  }
  return text;
}

export function createDefaultSql(mode, value = '', driver = 'postgres') {
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('此驱动暂不支持可视化建表');
  if (mode === 'none') return '';
  if (mode === 'null') return 'NULL';
  if (!['text', 'expression'].includes(mode)) throw new Error('默认值模式无效');
  const text = validText(value);
  if (mode === 'expression') {
    if (!text.trim()) throw new Error('请输入默认值表达式');
    return text.trim();
  }
  if (text.includes('\\')) {
    const hex = Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('');
    return driver === 'mysql' ? `CONVERT(X'${hex}' USING utf8mb4)` : `convert_from(decode('${hex}', 'hex'), 'UTF8')`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

export function isIdentityType(dataType, driver = 'postgres') {
  const type = String(dataType ?? '').trim();
  if (driver === 'mysql') return /^(tinyint|smallint|mediumint|integer|int|bigint)(?:\(\d+\))?(?:\s+unsigned)?$/i.test(type);
  if (driver === 'postgres') return /^(smallint|integer|int|bigint)$/i.test(type);
  return false;
}
