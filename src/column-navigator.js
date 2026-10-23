const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();

/** Search metadata only; the source index is never replaced by a filtered position. */
export function filterColumnNavigationItems(items, query = '') {
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...items];
  return items.filter(item => {
    const text = normalize(`${item.name} ${item.type || ''} ${item.index + 1}`);
    return terms.every(term => text.includes(term));
  });
}

let sequence = 0;
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** A local column chooser; its caller owns the toolbar entry and global shortcut. */
export function createColumnNavigator({ getGrid, getColumnMetadata = () => [], onError = console.error }) {
  const prefix = `column-navigator-${++sequence}`;
  const dialog = node('dialog', 'column-navigator');
  dialog.setAttribute('aria-labelledby', `${prefix}-title`);
  const heading = node('div', 'column-navigator-heading');
  const title = node('h2', '', '定位列');
  title.id = `${prefix}-title`;
  const dismiss = node('button', 'column-navigator-close', 'Esc');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', '关闭列定位');
  heading.append(title, dismiss);
  const search = node('input', 'column-navigator-search');
  search.type = 'text';
  search.placeholder = '搜索列名、类型或列序号…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-label', '搜索列');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-expanded', 'false');
  search.setAttribute('aria-controls', `${prefix}-list`);
  const list = node('div', 'column-navigator-list');
  list.id = `${prefix}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '结果列');
  const empty = node('p', 'column-navigator-empty', '未找到匹配的列');
  empty.hidden = true;
  const footer = node('div', 'column-navigator-footer');
  footer.append(node('span', '', '↑ ↓ 选择 · Enter 定位'));
  const count = node('span', 'column-navigator-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  footer.append(count);
  dialog.append(heading, search, list, empty, footer);
  document.body.append(dialog);
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let grid = null;
  let columns = null;
  let rows = null;
  let items = [];
  let visible = [];
  let selected = -1;
  let previousFocus = null;
  let anchor = null;

  function restoreFocus() {
    search.setAttribute('aria-expanded', 'false');
    const target = previousFocus;
    previousFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function close({ restore = true } = {}) {
    if (!dialog.open) return;
    dialog.close();
    if (restore) restoreFocus();
    else { previousFocus = null; search.setAttribute('aria-expanded', 'false'); }
  }

  function select(index, scroll = true) {
    selected = index;
    list.querySelectorAll('[role="option"]').forEach(option => option.setAttribute('aria-selected', String(Number(option.dataset.optionIndex) === index)));
    const option = list.querySelector(`[data-option-index="${index}"]`);
    if (option) {
      search.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }

  function reveal(index) {
    const item = visible[index];
    if (!item) return;
    if (getGrid() !== grid || grid.columns !== columns || grid.rows !== rows || grid.destroyed) {
      empty.textContent = '结果已变化，请重新打开列定位';
      empty.hidden = false;
      list.hidden = true;
      count.textContent = '结果已变化';
      search.removeAttribute('aria-activedescendant');
      return;
    }
    try {
      close();
      grid.revealColumn(item.index);
    } catch (error) { onError(error); }
  }

  function render() {
    visible = filterColumnNavigationItems(items, search.value);
    list.replaceChildren();
    list.hidden = false;
    for (const [index, item] of visible.entries()) {
      const option = node('button', 'column-navigator-option');
      option.type = 'button';
      option.tabIndex = -1;
      option.id = `${prefix}-option-${item.index}`;
      option.dataset.optionIndex = String(index);
      option.dataset.columnIndex = String(item.index);
      option.setAttribute('role', 'option');
      option.append(node('span', 'column-navigator-number', String(item.index + 1)));
      const copy = node('span', 'column-navigator-copy');
      const name = node('span', 'column-navigator-name', item.name || '（无列名）');
      name.title = item.name;
      copy.append(name);
      if (item.type) copy.append(node('span', 'column-navigator-type', item.type));
      option.append(copy);
      const states = [item.active && '当前列', item.selected && '已选', item.filtered && '已筛选'].filter(Boolean);
      if (states.length) option.append(node('span', 'column-navigator-state', states.join(' · ')));
      list.append(option);
    }
    empty.textContent = '未找到匹配的列';
    empty.hidden = visible.length > 0;
    count.textContent = visible.length === items.length ? `${items.length} 列` : `${visible.length} / ${items.length} 列`;
    const active = search.value ? -1 : visible.findIndex(item => item.active);
    select(visible.length ? Math.max(0, active) : -1, false);
    list.scrollTop = 0;
    if (active >= 0) select(active);
  }

  function position() {
    if (!dialog.open) return;
    const bounds = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const width = dialog.getBoundingClientRect().width;
    const height = dialog.getBoundingClientRect().height;
    const left = bounds ? bounds.right - width : (window.innerWidth - width) / 2;
    const top = bounds ? bounds.bottom + 8 : Math.min(120, window.innerHeight * .15);
    dialog.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, left))}px`;
    dialog.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, top))}px`;
  }

  function open(trigger = null) {
    if (dialog.open) { search.focus(); return true; }
    const candidate = getGrid();
    const next = candidate?.getColumnNavigationItems?.(getColumnMetadata()) || [];
    if (!next.length || candidate.destroyed) return false;
    grid = candidate;
    columns = grid.columns;
    rows = grid.rows;
    items = next;
    anchor = trigger;
    previousFocus = document.activeElement;
    search.value = '';
    render();
    dialog.showModal();
    search.setAttribute('aria-expanded', 'true');
    position();
    search.focus({ preventScroll: true });
    // Scrolling a closed dialog is ignored by some engines.
    if (selected >= 0) select(selected);
    return true;
  }

  search.addEventListener('input', render, options);
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === 'ArrowDown' && visible.length) select((selected + 1) % visible.length);
    if (event.key === 'ArrowUp' && visible.length) select((selected - 1 + visible.length) % visible.length);
    if (event.key === 'Enter') reveal(selected);
    if (event.key === 'Escape') close();
  }, options);
  list.addEventListener('pointerdown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); }, options);
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-option-index]');
    if (option) reveal(Number(option.dataset.optionIndex));
  }, options);
  dismiss.addEventListener('click', () => close(), options);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }, options);
  dialog.addEventListener('close', () => { if (!dialog.open) restoreFocus(); }, options);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }, options);
  window.addEventListener('resize', position, options);
  return {
    open,
    close,
    toggle(trigger) { if (dialog.open) { close(); return false; } return open(trigger); },
    get isOpen() { return dialog.open; },
    destroy() { close({ restore: false }); abort.abort(); dialog.remove(); },
  };
}
