const textType = /^(?:(?:pg_catalog\.)?(?:text|character(?: varying)?|varchar|char|bpchar)|tinytext|mediumtext|longtext)(?:\b|\()/i;

function temporalField(dataType, driver) {
  const type = dataType.replace(/\(\d+\)/g, '').trim().toLowerCase();
  if (type === 'date') return { inputType: 'date', current: 'CURRENT_DATE', label: '选择日期' };
  if (type === 'time' || type === 'time without time zone') return { inputType: 'time', current: driver === 'mysql' ? 'CURRENT_TIME' : 'LOCALTIME', label: '选择时间' };
  if (type === 'timetz' || type === 'time with time zone') {
    return { inputType: 'time', current: 'CURRENT_TIME', label: '选择时间（UTC）', offset: '+00:00' };
  }
  if (type === 'timestamptz' || type === 'timestamp with time zone') {
    return { inputType: 'datetime-local', current: 'CURRENT_TIMESTAMP', label: '选择日期时间（UTC）', offset: '+00:00' };
  }
  if (['datetime', 'timestamp', 'timestamp without time zone'].includes(type)) {
    return { inputType: 'datetime-local', current: driver === 'postgres' ? 'LOCALTIMESTAMP' : 'CURRENT_TIMESTAMP', label: '选择日期时间' };
  }
  return null;
}

function readFieldValue(input) {
  if (input.dataset.mutationValue === 'null') return null;
  if (input.dataset.mutationValue === 'empty') return '';
  return input.value.trim() ? input.value : undefined;
}

export function readRowInput(input, dataType = '', driver) {
  const current = temporalField(dataType, driver)?.current;
  if (input.dataset.mutationValue === 'current' && current === input.value) return { expression: current, value: undefined };
  const value = readFieldValue(input);
  if (typeof value === 'string' && /^(?:bool(?:ean)?|tinyint\(1\))$/i.test(dataType)) {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'false') return { value: normalized === 'true' };
  }
  return { value };
}

export function mountRowInputShortcuts(input, field, driver, { primaryKey = false } = {}) {
  const dataType = field.dataType || '';
  const parent = input.parentElement;
  const tools = document.createElement('div');
  tools.className = 'mutation-field-tools';
  const setValue = (value, mode = '') => {
    input.value = value;
    if (mode) input.dataset.mutationValue = mode;
    else delete input.dataset.mutationValue;
    input.placeholder = mode === 'empty' ? '空字符串' : '';
    reset.hidden = !mode && value === '';
  };
  const button = (label, run) => {
    const control = document.createElement('button');
    control.className = 'quiet-btn';
    control.type = 'button';
    control.textContent = label;
    control.setAttribute('aria-label', `${field.name} · ${label}`);
    control.addEventListener('click', run);
    return control;
  };
  const reset = button('清空输入', () => setValue(''));
  reset.hidden = true;
  const temporal = temporalField(dataType, driver);
  if (temporal) {
    const picker = document.createElement('input');
    picker.type = temporal.inputType;
    if (picker.type !== 'date') picker.step = '1';
    picker.required = false;
    picker.className = 'mutation-temporal-picker';
    picker.setAttribute('aria-label', `${field.name} · ${temporal.label}`);
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      const selected = picker.value.replace('T', ' ');
      const seconds = /^(?:\d+-\d{2}-\d{2} )?\d{2}:\d{2}$/u.test(selected) ? ':00' : '';
      setValue(selected + seconds + (temporal.offset || ''));
    });
    // Only the text field is submitted. Keep the native picker available even
    // on WebKit versions that lack showPicker().
    const details = document.createElement('details');
    details.className = 'mutation-temporal-options';
    const trigger = document.createElement('summary');
    trigger.textContent = temporal.label;
    details.append(trigger, picker);
    tools.append(details, button(temporal.inputType === 'date' ? '今天' : '现在', () => setValue(temporal.current, 'current')));
  } else if (/^(?:bool(?:ean)?|tinyint\(1\))$/i.test(dataType)) {
    tools.append(button('True', () => setValue('true')), button('False', () => setValue('false')));
  } else if (/^jsonb?$/i.test(dataType)) {
    tools.append(button('{}', () => setValue('{}')), button('[]', () => setValue('[]')));
  } else if (dataType.toLowerCase() === 'uuid' && typeof globalThis.crypto?.randomUUID === 'function') {
    tools.append(button('生成 UUID', () => setValue(crypto.randomUUID())));
  }
  if (field.nullable && !primaryKey) tools.append(button('设为 NULL', () => setValue('NULL', 'null')));
  if (textType.test(dataType)) tools.append(button('空字符串', () => setValue('', 'empty')));
  if (!tools.childElementCount) return;
  input.addEventListener('input', () => setValue(input.value));
  tools.append(reset);
  parent.append(tools);
}
