import { setSelectableText } from './selectable-text.js';
import { foreignKeyActions, newStructureKey, structureKeyChanged, structureKeyLabel } from './structure-keys.js';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, handler, className = 'quiet-btn') {
  const control = node('button', text, className);
  control.type = 'button';
  control.addEventListener('click', handler);
  return control;
}

function label(text, control) {
  const wrapper = node('label', text);
  wrapper.append(control);
  return wrapper;
}

function options(select, entries) {
  select.replaceChildren(...entries.map(([value, text]) => {
    const option = node('option', text);
    option.value = value;
    return option;
  }));
}

export function createStructureKeyEditor(rows, columns, driver, category, onChange, { create = false } = {}) {
  const index = category === 'indexes';
  const content = node('div', null, 'structure-key-editor');
  const toolbar = node('div', null, 'structure-key-toolbar');
  const list = node('div', null, 'structure-key-list');
  const empty = node('p', index ? '没有索引' : '没有约束', 'form-note');
  const entries = [];
  const add = button(index ? '＋ 添加索引' : '＋ 添加约束', () => {
    const row = newStructureKey(index ? 'index' : 'unique');
    rows.push(row);
    appendRow(row, true);
    entries.at(-1).focus();
    onChange();
  }, 'secondary-btn');
  toolbar.append(add);
  if (!index && create) toolbar.append(node('span', '主键可在字段页设置', 'form-note'));
  content.append(toolbar, empty, list);

  function appendRow(row, open = false) {
    const card = node('details', null, 'structure-key-card');
    card.open = open;
    const summary = node('summary');
    const title = node('span');
    const state = node('span', null, 'structure-key-status');
    summary.append(title, state);
    const body = node('div', null, 'structure-key-body');
    card.append(summary, body);
    list.append(card);
    const original = row.original;
    const existingDefinition = node('pre', null, 'definition');
    if (row.definition) setSelectableText(existingDefinition, row.definition);
    const fields = node('div', null, 'structure-key-form');
    const mysqlForeignKey = driver === 'mysql' && original?.kind === 'foreign_key';
    const writable = !row.managed && !row.complex && !mysqlForeignKey;
    const controls = [];
    let refreshColumns = () => {};

    function textField(key, heading, placeholder, multiline = false) {
      const control = node(multiline ? 'textarea' : 'input');
      if (multiline) control.rows = 2;
      else control.type = 'text';
      control.value = row[key];
      control.placeholder = placeholder || '';
      control.autocomplete = 'off';
      control.addEventListener('input', () => {
        row[key] = control.value;
        onChange();
      });
      const field = label(heading, control);
      fields.append(field);
      controls.push(control);
      return { control, field };
    }

    let nameInput;
    if (writable) {
      const nameField = textField('name', index ? '索引名称' : '约束名称');
      nameInput = nameField.control;
      if (index || !original) {
        const kind = node('select');
        options(kind, index ? [['ordinary', '普通索引'], ['unique', '唯一索引']]
          : [['unique', '唯一约束'], ['check', '检查约束'], ['foreign_key', '外键'], ...(create ? [] : [['primary_key', '主键']])]);
        kind.value = index ? row.unique ? 'unique' : 'ordinary' : row.kind;
        kind.addEventListener('change', () => {
          if (index) row.unique = kind.value === 'unique';
          else row.kind = kind.value;
          onChange();
        });
        fields.append(label('类型', kind));
        controls.push(kind);
      }
      const columnField = node('div', null, 'structure-key-columns');
      const chosen = node('ol', null, 'structure-key-column-list');
      const appendColumn = node('select');
      appendColumn.setAttribute('aria-label', '添加索引或约束字段');
      const columnLabel = label('字段（按添加顺序）', appendColumn);
      columnField.append(columnLabel, chosen);
      fields.append(columnField);
      controls.push(appendColumn);
      const addChoices = () => options(appendColumn, [['', '选择字段…'], ...columns.flatMap((column, i) =>
        !column.removed && column.name && !row.columns.includes(column) ? [[String(i), column.name]] : [])]);
      function changeColumns(next) {
        row.columns = next;
        refreshColumns();
        onChange();
      }
      appendColumn.addEventListener('change', () => {
        if (appendColumn.value !== '') changeColumns([...row.columns, columns[Number(appendColumn.value)]]);
      });
      let lastColumns;
      refreshColumns = () => {
        columnField.hidden = row.kind === 'check';
        const snapshot = JSON.stringify([columns.map(column => [column.name, Boolean(column.removed)]),
          row.columns.map(column => typeof column === 'string' ? column : columns.indexOf(column))]);
        if (snapshot === lastColumns) return;
        lastColumns = snapshot;
        addChoices();
        chosen.replaceChildren(...row.columns.map((column, i) => {
          const name = typeof column === 'string' ? column : column.name || '未命名字段';
          const item = node('li', name);
          const remove = button('×', () => {
            changeColumns(row.columns.filter((_, position) => position !== i));
            const trigger = appendColumn.nextElementSibling;
            (trigger?.classList.contains('app-select-trigger') ? trigger : appendColumn).focus();
          });
          remove.setAttribute('aria-label', `移除字段 ${name}`);
          item.append(remove);
          return item;
        }));
      };
      if (!index) {
        const check = textField('expression', '检查表达式', '例如 amount >= 0', true);
        check.field.classList.add('structure-key-wide');
        const refSchema = textField('referenceSchema', driver === 'mysql' ? '引用数据库' : '引用 Schema', '当前命名空间');
        const refTable = textField('referenceTable', '引用表');
        const refColumns = textField('referenceColumns', '引用字段（逗号分隔）', '例如 id, code');
        const references = [refSchema.field, refTable.field, refColumns.field];
        for (const [property, heading] of [['onDelete', '删除时'], ['onUpdate', '更新时']]) {
          const action = node('select');
          options(action, [['', '数据库默认'], ...foreignKeyActions.map(value => [value, value])]);
          action.value = row[property];
          action.addEventListener('change', () => {
            row[property] = action.value;
            onChange();
          });
          const field = label(heading, action);
          fields.append(field);
          references.push(field);
          controls.push(action);
        }
        const syncColumns = refreshColumns;
        refreshColumns = () => {
          syncColumns();
          nameField.field.hidden = driver === 'mysql' && row.kind === 'primary_key';
          check.field.hidden = row.kind !== 'check';
          for (const field of references) field.hidden = row.kind !== 'foreign_key';
        };
      }
    }
    if (!writable) {
      const reason = row.managed === 'primary' ? '请在约束页修改主键。'
        : row.managed === 'constraint' ? '此索引由约束维护。'
        : mysqlForeignKey ? '替换 MySQL 外键需要分别保存添加和删除。'
        : '此定义包含高级选项，可在 SQL 编辑器中修改。';
      body.append(node('p', reason, 'form-note'));
    } else body.append(fields);
    if (row.definition) {
      if (writable) body.append(node('span', '当前定义', 'form-note'));
      body.append(existingDefinition);
    }
    let remove;
    if (!row.managed) {
      remove = button('删除', () => {
        if (original) row.removed = !row.removed;
        else {
          rows.splice(rows.indexOf(row), 1);
          entries.splice(entries.indexOf(entry), 1);
          card.remove();
          add.focus();
        }
        onChange();
      });
      body.append(remove);
    }
    const entry = {
      focus: () => nameInput?.focus(),
      update() {
        title.textContent = row.name || (driver === 'mysql' && row.kind === 'primary_key' ? 'PRIMARY' : index ? '新索引' : '新约束');
        state.textContent = [structureKeyLabel(row), row.removed ? '待删除' : !original ? '未保存' : structureKeyChanged(row) ? '已修改' : ''].filter(Boolean).join(' · ');
        refreshColumns();
        for (const control of controls) control.disabled = Boolean(row.removed);
        for (const control of chosenControls()) control.disabled = Boolean(row.removed);
        if (remove) remove.textContent = row.removed ? '撤销删除' : '删除';
      },
    };
    function chosenControls() { return fields.querySelectorAll('.structure-key-column-list button'); }
    entries.push(entry);
    entry.update();
  }
  for (const row of rows) appendRow(row);
  return { content, update() {
    empty.hidden = rows.length > 0;
    for (const entry of entries) entry.update();
  } };
}
