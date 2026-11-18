import { setSelectableText } from './selectable-text.js';
import { buildTableDdl } from './table-ddl.js';

let tabGroupId = 0;

function metadataTable(headers, rows, empty) {
  const table = document.createElement('table');
  table.className = 'structure-table';
  const heading = table.createTHead().insertRow();
  for (const label of headers) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    heading.append(th);
  }
  const body = table.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else setSelectableText(cell, value || '—');
    }
  }
  if (!rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = headers.length;
    cell.textContent = empty;
  }
  return table;
}

export function structureMetadataTabs(details, driver, { showTrigger } = {}) {
  const tabs = [];
  const table = ['table', 'partitioned_table', 'foreign_table'].includes(details.kind);
  const indexes = details.indexes || [];
  const constraints = details.constraints || [];
  if (table || indexes.length) tabs.push({
    id: 'indexes', label: '索引',
    content: metadataTable(['名称', '属性', '定义'], indexes.map(index => [
      index.name, index.primary ? '主键' : index.unique ? '唯一' : '普通', index.definition,
    ]), '没有索引'),
  });
  if (table || constraints.length) tabs.push({
    id: 'constraints', label: '约束',
    content: metadataTable(['名称', '类型', '定义'], constraints.map(constraint => [
      constraint.name, constraint.kind, constraint.definition,
    ]), '没有约束'),
  });
  if (table && driver === 'mysql') {
    const headers = showTrigger ? ['名称', '时机', '事件', '定义'] : ['名称', '时机', '事件'];
    const rows = (details.triggers || []).map((trigger, index) => {
      const values = [trigger.name, trigger.timing, trigger.event];
      if (showTrigger) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet-btn';
        button.dataset.triggerDdl = String(index);
        button.textContent = '查看 DDL';
        button.addEventListener('click', () => showTrigger(trigger));
        values.push(button);
      }
      return values;
    });
    tabs.push({ id: 'triggers', label: '触发器', content: metadataTable(headers, rows, '没有可见触发器') });
  }
  let definition = details.definition;
  if (!definition && details.tableDdl) {
    try { definition = buildTableDdl(details, details, driver); }
    catch { /* Some PostgreSQL objects cannot be represented as standalone DDL. */ }
  }
  const ddl = document.createElement(definition ? 'pre' : 'p');
  ddl.className = definition ? 'definition' : 'structure-comment';
  setSelectableText(ddl, definition || details.tableDdl?.unsupportedReason || '没有可显示的定义');
  tabs.push({ id: 'definition', label: '定义', content: ddl });
  return tabs;
}

export function mountStructureTabs(container, tabs, { selected = 'fields', onSelect } = {}) {
  const group = document.createElement('div');
  group.className = 'structure-tabs';
  group.setAttribute('role', 'tablist');
  group.setAttribute('aria-label', '结构类别');
  const prefix = `structure-${++tabGroupId}`;
  const entries = tabs.map(({ id, label, content }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-tab';
    button.id = `${prefix}-${id}-tab`;
    button.textContent = label;
    button.setAttribute('role', 'tab');
    const panel = document.createElement('div');
    panel.id = `${prefix}-${id}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = 0;
    button.setAttribute('aria-controls', panel.id);
    panel.append(content);
    group.append(button);
    return { id, button, panel };
  });
  const select = (id) => {
    for (const entry of entries) {
      const active = entry.id === id;
      entry.button.classList.toggle('active', active);
      entry.button.setAttribute('aria-selected', String(active));
      entry.button.tabIndex = active ? 0 : -1;
      entry.panel.hidden = !active;
    }
    onSelect?.(id);
  };
  entries.forEach(({ id, button }) => button.addEventListener('click', () => select(id)));
  group.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = entries.findIndex(({ button }) => button === event.target);
    if (index < 0) return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (index + step + entries.length) % entries.length;
    event.preventDefault();
    select(entries[next].id);
    entries[next].button.focus();
  });
  container.append(group, ...entries.map(({ panel }) => panel));
  select(entries.some(({ id }) => id === selected) ? selected : entries[0].id);
}
