const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 36;
const SELECTOR_WIDTH = 52;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 800;
const ROW_OVERSCAN = 6;
const COLUMN_OVERSCAN = 2;
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function columnName(column) {
  return typeof column === 'string' ? column : String(column?.name ?? column ?? '');
}

// Wide CJK glyphs occupy approximately two monospace cells.
function displayCells(text, limit) {
  let cells = 0;
  for (const char of text) {
    cells += char.codePointAt(0) > 255 ? 2 : 1;
    if (cells >= limit) return limit;
  }
  return cells;
}

function columnDataType(column) {
  return typeof column === 'object' ? column?.dataType ?? column?.data_type ?? column?.type : undefined;
}

export function formatCellValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value && typeof value === 'object' && value.$dbStudio === 'mysql-binary' && typeof value.hex === 'string') return `0x${value.hex}`;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// Quote separators so a multi-line value remains one spreadsheet cell.
export function formatClipboardRows(columns, rows, { includeHeaders = true } = {}) {
  const quote = (value) => {
    const text = value === null || value === undefined ? '' : formatCellValue(value);
    return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return (includeHeaders ? [columns.map(columnName), ...rows] : rows).map((row) => row.map(quote).join('\t')).join('\n');
}

// PostgreSQL bigint/numeric values arrive as strings. Their sort order must not
// pass through JavaScript's floating point representation.
function numericKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const match = String(value).trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  let digits = ((match[2] ?? '') + fraction).replace(/^0+/, '');
  if (!digits) return { sign: 0, digits: '', scale: 0n };
  // Canonicalize trailing zeroes so 1.20 and 1.2 compare equal. `scale` is
  // the power of ten occupied by the final mantissa digit.
  let scale = BigInt(match[5] || 0) - BigInt(fraction.length);
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale += 1n; }
  return {
    sign: match[1] === '-' ? -1 : 1,
    digits,
    scale,
  };
}

function sortKey(value) {
  if (value === null || value === undefined) return { nil: true };
  return { numeric: numericKey(value), text: formatCellValue(value) };
}

function compareKeys(left, right) {
  if (left.nil || right.nil) return left.nil === right.nil ? 0 : left.nil ? 1 : -1;
  if (left.numeric && right.numeric) {
    const a = left.numeric;
    const b = right.numeric;
    if (a.sign !== b.sign) return a.sign - b.sign;
    if (a.sign === 0) return 0;
    const aTop = a.scale + BigInt(a.digits.length);
    const bTop = b.scale + BigInt(b.digits.length);
    if (aTop !== bTop) return (aTop < bTop ? -1 : 1) * a.sign;
    for (let i = 0, length = Math.max(a.digits.length, b.digits.length); i < length; i++) {
      const difference = (a.digits.charCodeAt(i) || 48) - (b.digits.charCodeAt(i) || 48);
      if (difference) return Math.sign(difference) * a.sign;
    }
    return 0;
  }
  return collator.compare(left.text, right.text);
}

export function compareCellValues(left, right) {
  return compareKeys(sortKey(left), sortKey(right));
}

export function visibleRowRange(scrollTop, viewportHeight, rowCount) {
  const first = Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT);
  return {
    start: Math.max(0, Math.min(rowCount, first - ROW_OVERSCAN)),
    end: Math.min(rowCount, Math.ceil((Math.max(0, scrollTop) + Math.max(ROW_HEIGHT, viewportHeight - HEADER_HEIGHT)) / ROW_HEIGHT) + ROW_OVERSCAN),
  };
}

export const FILTER_OPERATORS = [
  ['contains', '包含'], ['notContains', '不包含'], ['equal', '等于'], ['notEqual', '不等于'],
  ['gt', '大于'], ['gte', '大于或等于'], ['lt', '小于'], ['lte', '小于或等于'],
  ['isNull', '为 NULL'], ['notNull', '不为 NULL'], ['empty', '为空字符串'], ['notEmpty', '不为空字符串'],
];
const unaryFilter = (operator) => ['isNull', 'notNull', 'empty', 'notEmpty'].includes(operator);

export function matchesColumnFilter(value, { operator, value: term = '' }) {
  const nil = value === null || value === undefined;
  if (operator === 'isNull') return nil;
  if (operator === 'notNull') return !nil;
  if (nil) return false;
  const text = formatCellValue(value).toLocaleLowerCase();
  const needle = String(term).toLocaleLowerCase();
  if (operator === 'empty') return text === '';
  if (operator === 'notEmpty') return text !== '';
  if (operator === 'contains') return text.includes(needle);
  if (operator === 'notContains') return !text.includes(needle);
  const comparison = compareCellValues(value, term);
  return { equal: comparison === 0, notEqual: comparison !== 0, gt: comparison > 0,
    gte: comparison >= 0, lt: comparison < 0, lte: comparison <= 0 }[operator] ?? true;
}

export function normalizeColumnFilters(filters, columnCount) {
  const byColumn = new Map();
  for (const filter of Array.isArray(filters) ? filters : []) {
    if (Number.isInteger(filter?.column) && filter.column >= 0 && filter.column < columnCount &&
        FILTER_OPERATORS.some(([operator]) => operator === filter.operator))
      byColumn.set(filter.column, { column: filter.column, operator: filter.operator, value: String(filter.value ?? '') });
  }
  return [...byColumn.values()];
}

export function filterRowOrder(rows, order, filters = [], text = '') {
  const needle = text.trim().toLocaleLowerCase();
  return order.filter((index) => (!needle || rows[index].some((value) => formatCellValue(value).toLocaleLowerCase().includes(needle))) &&
    filters.every((filter) => matchesColumnFilter(rows[index][filter.column], filter)));
}

export function selectRowRange(order, selected, anchor, target, checked) {
  const next = new Set(selected);
  const anchorPosition = order.indexOf(anchor);
  const targetPosition = order.indexOf(target);
  if (targetPosition < 0) return next;
  const start = anchorPosition < 0 ? targetPosition : Math.min(anchorPosition, targetPosition);
  const end = anchorPosition < 0 ? targetPosition : Math.max(anchorPosition, targetPosition);
  for (let position = start; position <= end; position++) {
    if (checked) next.add(order[position]);
    else next.delete(order[position]);
  }
  return next;
}

function validPermutation(value, length) {
  if (!Array.isArray(value) || value.length !== length) return null;
  const seen = new Set();
  for (const index of value) {
    if (!Number.isInteger(index) || index < 0 || index >= length || seen.has(index)) return null;
    seen.add(index);
  }
  return [...value];
}

/** Validate persisted view state before it can affect a result grid. */
export function normalizeGridViewState(value, rowCount, columnCount) {
  if (!value || typeof value !== 'object') return null;
  const rows = Math.max(0, Number.isInteger(rowCount) ? rowCount : 0);
  const columns = Math.max(0, Number.isInteger(columnCount) ? columnCount : 0);
  const order = validPermutation(value.order, rows);
  const selected = Array.isArray(value.selected)
    ? [...new Set(value.selected.filter((index) => Number.isInteger(index) && index >= 0 && index < rows))]
    : [];
  const sort = Number.isInteger(value.sort?.column) && value.sort.column >= 0 && value.sort.column < columns && (value.sort.direction === 1 || value.sort.direction === -1)
    ? { column: value.sort.column, direction: value.sort.direction }
    : null;
  const activeCell = Number.isInteger(value.activeCell?.position) && value.activeCell.position >= 0 && value.activeCell.position < rows && Number.isInteger(value.activeCell.column) && value.activeCell.column >= 0 && value.activeCell.column < columns
    ? { position: value.activeCell.position, column: value.activeCell.column }
    : null;
  const widths = Array.isArray(value.widths) && value.widths.length === columns && value.widths.every((width) => Number.isFinite(width) && width > 0)
    ? value.widths.map((width) => Math.round(width))
    : null;
  return {
    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0,
    scrollLeft: Number.isFinite(value.scrollLeft) ? Math.max(0, value.scrollLeft) : 0,
    order,
    filters: normalizeColumnFilters(value.filters, columns),
    selected,
    selectedColumns: Array.isArray(value.selectedColumns) ? [...new Set(value.selectedColumns.filter(index => Number.isInteger(index) && index >= 0 && index < columns))] : [],
    sort,
    activeCell,
    widths,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A dependency-free, two-axis virtual result grid. It retains original row
 * references; only the visible cells and a small overscan exist in the DOM. */
export class ResultGrid {
  constructor(container, { onInspect, shouldInspectCell, onSelectionChange, onTextFilterChange, onDraftChange, getCellEditState, onCommitCell, onCommitCells, onCopyCell, getRowActions, editActions } = {}) {
    this.container = container;
    this.onInspect = onInspect;
    this.shouldInspectCell = shouldInspectCell;
    this.onSelectionChange = onSelectionChange;
    this.onTextFilterChange = onTextFilterChange;
    this.onDraftChange = onDraftChange;
    this.getCellEditState = getCellEditState;
    this.onCommitCell = onCommitCell;
    this.onCommitCells = onCommitCells;
    this.onCopyCell = onCopyCell;
    this.getRowActions = getRowActions;
    // Result arrays belong to their tabs. Keep drafts with that exact result,
    // never with a visible position that sorting or a new query can change.
    this.editSessions = new WeakMap();
    this.editSession = null;
    this.columns = [];
    this.rows = [];
    this.order = [];
    this.visibleOrder = [];
    this.filters = [];
    this.textFilter = '';
    this.widths = [];
    this.offsets = [];
    this.selected = new Set();
    this.selectedColumns = new Set();
    this.columnSelectionAnchor = null;
    this.sort = null;
    this.activeCell = null;
    this.selectionAnchor = null;
    this.frame = 0;
    this.destroyed = false;
    this.renderSignature = '';
    this.headerSignature = '';
    this.abort = new AbortController();
    const options = { signal: this.abort.signal };

    this.viewport = element('div', 'db-grid-viewport');
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'grid');
    this.viewport.setAttribute('aria-label', '查询结果。方向键浏览，输入文字直接编辑，双击、F2 或 Enter 编辑，右键查看详情，空格选择行，Control 或 Command 加 C 复制。表头可排序和筛选。');
    this.viewport.setAttribute('aria-multiselectable', 'true');
    this.viewport.setAttribute('aria-readonly', String(!onCommitCell));
    this.canvas = element('div', 'db-grid-canvas');
    this.header = element('div', 'db-grid-header');
    this.header.setAttribute('role', 'row');
    this.header.setAttribute('aria-rowindex', '1');
    this.body = element('div', 'db-grid-body');
    this.body.setAttribute('role', 'rowgroup');
    this.empty = element('div', 'db-grid-empty');
    this.empty.setAttribute('role', 'status');
    const emptyIcon = element('div', 'db-grid-empty-icon');
    emptyIcon.setAttribute('aria-hidden', 'true');
    emptyIcon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11M14 14h3"/></svg>';
    this.emptyTitle = element('strong', 'db-grid-empty-title');
    this.emptyDescription = element('p', 'db-grid-empty-description');
    this.emptyClear = element('button', 'db-grid-empty-clear', '清除全部筛选');
    this.emptyClear.type = 'button';
    this.emptyClear.addEventListener('click', () => this.clearAllFilters(), options);
    this.empty.append(emptyIcon, this.emptyTitle, this.emptyDescription, this.emptyClear);
    this.canvas.append(this.header, this.body);
    this.viewport.append(this.canvas, this.empty);
    this.filterBar = element('div', 'db-grid-filter-bar');
    this.filterBar.hidden = true;
    this.footer = element('div', 'db-grid-footer');
    this.footerHint = element('span', 'db-grid-footer-hint', '输入文字直接编辑 · 双击 / Enter 编辑 · 右键详情');
    this.footerHint.title = '空格选择当前行 · Shift + 点击连续选择 · ⌘/Ctrl A 全选 · Esc 清除选择 · 双击列边缘自动调整列宽';
    this.footerStatus = element('span', 'db-grid-footer-status');
    this.footerStatus.setAttribute('role', 'status');
    this.footerStatus.setAttribute('aria-live', 'polite');
    this.footerStatus.setAttribute('aria-atomic', 'true');
    this.footerActions = element('div', 'db-grid-footer-actions');
    this.footerActions.hidden = true;
    this.externalEditActions = Boolean(editActions);
    this.editCancel = editActions?.cancel || element('button', 'db-grid-edit-cancel', '取消修改');
    this.editCancel.type = 'button';
    this.editCancel.title = '取消当前表的全部未保存修改';
    this.editCancel.addEventListener('click', () => this.discardCellEdit(), options);
    this.editSave = editActions?.save || element('button', 'db-grid-edit-save', '保存');
    this.editSave.type = 'button';
    this.editSave.title = '保存当前表的修改 · ⌘/Ctrl+S';
    this.editSave.addEventListener('click', () => this.commitAllCellEdits(), options);
    if (!editActions) this.footerActions.append(this.editCancel, this.editSave);
    this.footer.append(this.footerHint, this.footerStatus, this.footerActions);
    this.container.append(this.filterBar, this.viewport, this.footer);
    this.container.classList.add('db-grid-host');

    this.viewport.addEventListener('scroll', () => { this.closeFilter(false); this.closeCellMenu(false); this.scheduleRender(); }, { ...options, passive: true });
    this.viewport.addEventListener('change', (event) => this.handleSelection(event), options);
    this.viewport.addEventListener('click', (event) => this.handleClick(event), options);
    this.viewport.addEventListener('dblclick', (event) => {
      const resize = event.target.closest('[data-resize-column]');
      if (resize) this.fitColumn(Number(resize.dataset.resizeColumn));
      else if (event.target !== this.editorInput) this.handleCellDoubleClick(event.target.closest('[data-grid-cell]'));
    }, options);
    this.viewport.addEventListener('contextmenu', (event) => {
      const header = event.target.closest('[data-column-header]');
      if (header) { event.preventDefault(); event.stopPropagation(); this.openColumnMenu(header, event); return; }
      const cell = event.target.closest('[data-grid-cell]');
      if (cell) { event.preventDefault(); event.stopPropagation(); this.openCellMenu(cell, event); return; }
      const selector = event.target.closest('.db-grid-selector');
      if (selector) this.openSelectedRowMenu(selector, event);
    }, options);
    this.viewport.addEventListener('compositionstart', (event) => {
      const cell = event.target.closest('[data-grid-cell]');
      if (cell && event.target !== this.editorInput) this.startCellEdit(cell, { replaceValue: '' });
    }, options);
    this.viewport.addEventListener('copy', (event) => this.handleCopy(event), options);
    this.viewport.addEventListener('keydown', (event) => this.handleKeydown(event), options);
    this.viewport.addEventListener('pointerdown', (event) => this.startResize(event), options);
    document.addEventListener('pointerdown', (event) => {
      if (event.target !== this.editorInput && this.editSession) this.editSession.restoreFocus = false;
      if (this.cellMenu && !this.cellMenu.contains(event.target)) this.closeCellMenu(false);
      if (this.filterPanel && !this.filterPanel.contains(event.target) && !event.target.closest('[data-filter-column]')) this.closeFilter(false);
    }, options);
    document.addEventListener('keydown', (event) => { if (this.filterPanel && event.key === 'Escape') { event.preventDefault(); this.closeFilter(true); } }, options);
    document.addEventListener('focusin', (event) => {
      if (event.target !== this.editorInput && this.editSession) this.editSession.restoreFocus = false;
    }, options);
    window.addEventListener('resize', () => { this.closeFilter(false); this.closeCellMenu(false); }, options);
    this.filterBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-filter]');
      if (!button) return;
      if (button.dataset.removeFilter === 'all') this.clearAllFilters();
      else {
        if (button.dataset.removeFilter === 'text') {
          this.textFilter = '';
          this.onTextFilterChange?.('');
        } else this.filters = this.filters.filter((item) => item.column !== Number(button.dataset.removeFilter));
        this.applyFilters();
      }
      this.viewport.focus();
    }, options);
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.container);
    this.setResult({ columns: [], rows: [] });
  }

  setResult({ columns = [], rows = [] } = {}) {
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.closeCellMenu(false);
    const previousSession = this.editSession;
    this.suspendCellEdit();
    const sameColumns = this.columns.length === columns.length && this.columns.every((column, i) => columnName(column) === columnName(columns[i]));
    this.closeFilter(false);
    clearTimeout(this.statusTimer);
    this.statusTimer = 0;
    this.filters = [];
    this.textFilter = '';
    this.columns = columns;
    this.rows = rows;
    this.order = Array.from({ length: rows.length }, (_, index) => index);
    this.visibleOrder = [...this.order];
    this.filterBar.hidden = true;
    this.selected.clear();
    this.selectedColumns = new Set();
    this.columnSelectionAnchor = null;
    this.sort = null;
    this.activeCell = null;
    this.selectionAnchor = null;
    if (!sameColumns) this.widths = columns.map((column, index) => {
      let length = displayCells(columnName(column), 36) + 3;
      // Sampling bounds startup work independently of the returned row count.
      for (let row = 0; row < Math.min(rows.length, 20); row++) {
        const value = rows[row]?.[index];
        const displayLength = typeof value === 'object' && value !== null ? 28 : displayCells(String(value ?? 'NULL'), 36);
        length = Math.max(length, displayLength);
      }
      return Math.max(112, Math.min(300, length * 7 + 28));
    });
    this.measureColumns();
    this.viewport.scrollTop = 0;
    this.viewport.scrollLeft = 0;
    this.viewport.setAttribute('aria-rowcount', String(rows.length + 1));
    this.viewport.setAttribute('aria-colcount', String(columns.length + 1));
    this.body.style.height = `${rows.length * ROW_HEIGHT}px`;
    this.updateEmptyState();
    this.updateFooter();
    this.canvas.hidden = columns.length === 0;
    this.invalidate();
    this.render();
    if (previousSession && this.isCellEditDirty(previousSession)) this.announce('结果已切换，原单元格草稿已保留；切回同一结果可继续');
    this.notifySelection();
  }

  clear() { this.setResult({ columns: [], rows: [] }); }

  getViewState() {
    return {
      scrollTop: this.viewport.scrollTop,
      scrollLeft: this.viewport.scrollLeft,
      order: [...this.order],
      filters: this.filters.map((filter) => ({ ...filter })),
      selected: [...this.selected],
      selectedColumns: [...(this.selectedColumns || [])],
      sort: this.sort ? { ...this.sort } : null,
      activeCell: this.activeCell ? { ...this.activeCell } : null,
      widths: [...this.widths],
    };
  }

  restoreViewState(value) {
    const state = normalizeGridViewState(value, this.rows.length, this.columns.length);
    if (!state) return;
    if (state.order) this.order = state.order;
    this.filters = state.filters;
    this.visibleOrder = filterRowOrder(this.rows, this.order, this.filters, this.textFilter);
    const visible = new Set(this.visibleOrder);
    this.selected = new Set(state.selected.filter((index) => visible.has(index)));
    this.selectedColumns = new Set(state.selectedColumns);
    if (this.selectedColumns.size) this.selected.clear();
    this.sort = state.sort;
    this.activeCell = state.activeCell?.position < this.visibleOrder.length ? state.activeCell : null;
    this.updateFilterDisplay();
    if (state.widths) this.widths = state.widths.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
    this.measureColumns();
    this.invalidate();
    this.viewport.scrollTop = state.scrollTop;
    this.viewport.scrollLeft = state.scrollLeft;
    this.render();
    this.updateFooter();
  }

  getSelectedData() {
    const order = this.selected.size ? this.visibleOrder.filter((index) => this.selected.has(index)) : this.visibleOrder;
    const selectedColumns = [...(this.selectedColumns || [])].sort((a, b) => a - b);
    return selectedColumns.length
      ? { columns: selectedColumns.map(index => this.columns[index]), rows: order.map(index => selectedColumns.map(column => this.rows[index][column])) }
      : { columns: this.columns, rows: order.map((index) => this.rows[index]) };
  }

  getSelectedRows() {
    return this.visibleOrder
      .filter((index) => this.selected.has(index))
      .map((index) => this.rows[index]);
  }

  getRow(index) {
    return this.rows[index];
  }

  /** Original column indices remain stable across scrolling, sorting and filtering. */
  getColumnNavigationItems(metadata = []) {
    const counts = new Map();
    const metadataByName = new Map();
    for (const column of this.columns) counts.set(columnName(column), (counts.get(columnName(column)) || 0) + 1);
    for (const column of Array.isArray(metadata) ? metadata : []) {
      const name = columnName(column);
      // Duplicate source/result names cannot be mapped unambiguously by name.
      metadataByName.set(name, metadataByName.has(name) ? null : column);
    }
    return this.columns.map((column, index) => ({
      index,
      name: columnName(column),
      type: String(columnDataType(column) ?? (counts.get(columnName(column)) === 1 ? columnDataType(metadataByName.get(columnName(column))) : undefined) ?? ''),
      active: this.activeCell?.column === index,
      selected: Boolean(this.selectedColumns?.has(index)),
      filtered: this.filters.some(filter => filter.column === index),
    }));
  }

  /** Reveal a column without changing the data/column selection used by copy and export. */
  revealColumn(index, { focus = true } = {}) {
    if (this.destroyed || !Number.isInteger(index) || index < 0 || index >= this.columns.length || this.editorComposing) return false;
    this.closeFilter(false);
    this.closeCellMenu(false);
    this.suspendCellEdit();
    const left = this.offsets[index];
    const right = left + this.widths[index];
    const width = this.viewport.clientWidth || 800;
    if (left < this.viewport.scrollLeft + SELECTOR_WIDTH || this.widths[index] > width - SELECTOR_WIDTH)
      this.viewport.scrollLeft = Math.max(0, left - SELECTOR_WIDTH);
    else if (right > this.viewport.scrollLeft + width)
      this.viewport.scrollLeft = Math.max(0, right - width);
    if (this.visibleOrder.length) {
      // A cell left above/below the viewport should not pull a scrolled result back.
      const first = Math.floor(this.viewport.scrollTop / ROW_HEIGHT);
      const last = Math.ceil((this.viewport.scrollTop + Math.max(ROW_HEIGHT, (this.viewport.clientHeight || 320) - HEADER_HEIGHT)) / ROW_HEIGHT) - 1;
      const current = this.activeCell?.position;
      const position = current >= first && current <= last ? current : first;
      this.activeCell = { position: Math.max(0, Math.min(this.visibleOrder.length - 1, position)), column: index };
    } else this.activeCell = null;
    this.invalidate();
    this.render();
    if (focus) {
      if (this.activeCell) this.focusActiveCell(true);
      else this.header.querySelector(`[data-select-column="${index}"]`)?.focus({ preventScroll: true });
    }
    const header = this.header.querySelector(`[data-column-header="${index}"]`);
    header?.classList.remove('db-grid-column-located');
    if (header) { void header.offsetWidth; header.classList.add('db-grid-column-located'); }
    this.announce(`已定位 ${columnName(this.columns[index])} · 第 ${index + 1} 列`);
    this.updateFooter();
    return true;
  }

  destroy() {
    this.closeCellMenu(false);
    this.unmountCellEditor();
    this.editSession = null;
    this.editSessions = new WeakMap();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.abort.abort();
    this.resizeAbort?.abort();
    this.closeFilter(false);
    clearTimeout(this.statusTimer);
    this.filterBar.remove();
    this.viewport.remove();
    this.footer.remove();
    this.container.classList.remove('db-grid-host');
    this.rows = [];
    this.order = [];
    this.selected.clear();
  }

  invalidate() { this.renderSignature = ''; this.headerSignature = ''; }

  measureColumns() {
    let offset = SELECTOR_WIDTH;
    this.offsets = this.widths.map((width) => { const current = offset; offset += width; return current; });
    this.totalWidth = offset;
    this.canvas.style.width = `${offset}px`;
    this.viewport.style.setProperty('--db-grid-row-height', `${ROW_HEIGHT}px`);
    this.viewport.style.setProperty('--db-grid-header-height', `${HEADER_HEIGHT}px`);
    this.viewport.style.setProperty('--db-grid-selector-width', `${SELECTOR_WIDTH}px`);
  }

  scheduleRender() {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  columnRange() {
    const left = this.viewport.scrollLeft + SELECTOR_WIDTH;
    const right = this.viewport.scrollLeft + (this.viewport.clientWidth || 800);
    let start = 0;
    while (start < this.columns.length && this.offsets[start] + this.widths[start] < left) start++;
    let end = start;
    while (end < this.columns.length && this.offsets[end] < right) end++;
    return { start: Math.max(0, start - COLUMN_OVERSCAN), end: Math.min(this.columns.length, end + COLUMN_OVERSCAN) };
  }

  render() {
    if (this.destroyed) return;
    const columns = this.columnRange();
    const columnSignature = `${columns.start}:${columns.end}:${this.widths.join(',')}`;
    if (this.headerSignature !== columnSignature) {
      this.renderHeader(columns);
      this.headerSignature = columnSignature;
    }
    const rows = visibleRowRange(this.viewport.scrollTop, this.viewport.clientHeight || 320, this.visibleOrder.length);
    const signature = `${rows.start}:${rows.end}:${columnSignature}`;
    if (signature === this.renderSignature) return;
    // Reparenting even the same textarea cancels an active IME candidate.
    // Defer virtual row replacement until composition has finished.
    if (this.editorComposing) return;
    this.closeCellMenu(false);
    this.unmountCellEditor({ preserve: true });
    const restoreCellFocus = Boolean(this.viewport.contains(document.activeElement) && document.activeElement?.matches('[data-grid-cell]'));
    const fragment = document.createDocumentFragment();
    for (let position = rows.start; position < rows.end; position++) {
      const originalIndex = this.visibleOrder[position];
      const row = element('div', `db-grid-row${position % 2 ? ' db-grid-row-alternate' : ''}`);
      row.setAttribute('role', 'row');
      row.setAttribute('aria-rowindex', String(position + 2));
      row.setAttribute('aria-selected', String(this.selected.has(originalIndex)));
      row.dataset.rowIndex = String(originalIndex);
      row.style.top = `${position * ROW_HEIGHT}px`;
      const selector = element('div', 'db-grid-selector');
      selector.setAttribute('role', 'gridcell');
      selector.setAttribute('aria-colindex', '1');
      selector.title = `点击选择第 ${position + 1} 行 · Shift + 点击连续选择`;
      const checkbox = element('input', 'db-grid-checkbox');
      checkbox.type = 'checkbox';
      checkbox.tabIndex = -1;
      checkbox.checked = this.selected.has(originalIndex);
      checkbox.dataset.selectRow = String(originalIndex);
      checkbox.setAttribute('aria-label', `选择第 ${position + 1} 行`);
      selector.append(checkbox, element('span', 'db-grid-row-number', String(position + 1)));
      row.append(selector);
      for (let column = columns.start; column < columns.end; column++) {
        const draft = this.cellEditSession(originalIndex, column);
        const value = draft ? draft.isNull ? null : draft.draftValue : this.rows[originalIndex]?.[column];
        const cell = element('div', 'db-grid-cell');
        cell.dataset.gridCell = '';
        cell.dataset.position = String(position);
        cell.dataset.columnIndex = String(column);
        cell.classList.toggle('db-grid-cell-editing', this.editSession?.payload.rowIndex === originalIndex && this.editSession?.payload.columnIndex === column);
        cell.classList.toggle('db-grid-cell-active', this.activeCell?.position === position && this.activeCell?.column === column);
        cell.classList.toggle('db-grid-cell-draft', Boolean(draft && (draft.pending || this.isCellEditDirty(draft))));
        cell.setAttribute('aria-selected', String(this.activeCell?.position === position && this.activeCell?.column === column));
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colindex', String(column + 2));
        cell.classList.toggle('db-grid-cell-column-selected', Boolean(this.selectedColumns?.has(column)));
        cell.tabIndex = this.activeCell?.position === position && this.activeCell?.column === column ? 0 : -1;
        cell.style.left = `${this.offsets[column]}px`;
        cell.style.width = `${this.widths[column]}px`;
        cell.classList.toggle('db-grid-null', value === null || value === undefined);
        cell.classList.toggle('db-grid-number', typeof value === 'number' || typeof value === 'bigint');
        cell.classList.toggle('db-grid-empty-value', value === '');
        cell.classList.toggle('db-grid-boolean', typeof value === 'boolean');
        cell.classList.toggle('db-grid-boolean-true', value === true);
        cell.classList.toggle('db-grid-boolean-false', value === false);
        const text = formatCellValue(value);
        cell.textContent = value === '' ? '空字符串' : text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
        // Keep large text/JSON out of native tooltip buffers. The inspector
        // receives the original value without truncation.
        cell.title = `${value === '' ? '空字符串（长度为 0）' : text.length > 400 ? `${text.slice(0, 400)}…` : text}\n${draft ? draft.pending ? '保存中 · ' : '未保存草稿 · ' : ''}输入文字直接编辑 · 双击查看 JSON 或编辑 · Enter 编辑 · 右键查看详情`;
        row.append(cell);
      }
      fragment.append(row);
    }
    this.body.replaceChildren(fragment);
    this.renderSignature = signature;
    this.mountCellEditor();
    if (restoreCellFocus && !this.editorInput?.contains(document.activeElement)) this.focusActiveCell(false);
  }

  renderHeader(columns) {
    const corner = element('div', 'db-grid-selector db-grid-corner');
    corner.setAttribute('role', 'columnheader');
    corner.setAttribute('aria-colindex', '1');
    corner.title = '点击全选或取消选择当前筛选结果';
    const checkbox = element('input', 'db-grid-checkbox');
    checkbox.type = 'checkbox';
    checkbox.dataset.selectAll = '';
    checkbox.checked = this.visibleOrder.length > 0 && this.selected.size === this.visibleOrder.length;
    checkbox.indeterminate = this.selected.size > 0 && this.selected.size < this.visibleOrder.length;
    checkbox.disabled = !this.visibleOrder.length;
    checkbox.setAttribute('aria-label', '选择全部筛选结果');
    corner.append(checkbox, element('span', 'db-grid-row-number', '#'));
    const fragment = document.createDocumentFragment();
    fragment.append(corner);
    for (let index = columns.start; index < columns.end; index++) {
      const name = columnName(this.columns[index]);
      const cell = element('div', 'db-grid-column');
      cell.setAttribute('role', 'columnheader');
      cell.setAttribute('aria-colindex', String(index + 2));
      cell.dataset.columnHeader = String(index);
      cell.dataset.columnSelected = String(Boolean(this.selectedColumns?.has(index)));
      cell.setAttribute('aria-selected', String(Boolean(this.selectedColumns?.has(index))));
      cell.setAttribute('aria-sort', this.sort?.column === index ? this.sort.direction === 1 ? 'ascending' : 'descending' : 'none');
      cell.style.left = `${this.offsets[index]}px`;
      cell.style.width = `${this.widths[index]}px`;
      const label = element('button', 'db-grid-column-name', name);
      label.type = 'button';
      label.dataset.selectColumn = String(index);
      label.setAttribute('aria-label', `选择 ${name} 列`);
      label.setAttribute('aria-pressed', String(Boolean(this.selectedColumns?.has(index))));
      label.title = `${name} · 点击选择整列，再次点击取消，Shift 连选，⌘/Ctrl 多选`;
      const sortControl = element('div', 'db-grid-sort-control');
      sortControl.setAttribute('role', 'group');
      sortControl.setAttribute('aria-label', `${name} 排序`);
      for (const direction of [1, -1]) {
        const selected = this.sort?.column === index && this.sort.direction === direction;
        const directionLabel = direction === 1 ? '升序' : '降序';
        const button = element('button', 'db-grid-sort');
        button.type = 'button';
        button.dataset.sortColumn = String(index);
        button.dataset.sortDirection = String(direction);
        button.setAttribute('aria-label', `${name}，${directionLabel}`);
        button.setAttribute('aria-pressed', String(selected));
        button.title = `${name} · ${selected ? '恢复原始顺序' : `${directionLabel}排列`}（已加载结果）`;
        button.innerHTML = `<svg viewBox="0 0 16 10" aria-hidden="true"><path d="${direction === 1 ? 'm4 7 4-4 4 4' : 'm4 3 4 4 4-4'}"/></svg>`;
        sortControl.append(button);
      }
      const resize = element('span', 'db-grid-resize');
      resize.dataset.resizeColumn = String(index);
      resize.tabIndex = 0;
      resize.setAttribute('role', 'separator');
      resize.setAttribute('aria-orientation', 'vertical');
      resize.setAttribute('aria-label', `调整 ${name} 列宽`);
      resize.setAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH));
      resize.setAttribute('aria-valuemax', String(MAX_COLUMN_WIDTH));
      resize.setAttribute('aria-valuenow', String(this.widths[index]));
      resize.title = '拖动调整列宽 · 双击自动适应 · 方向键调整 16px';
      const funnel = element('button', 'db-grid-filter');
      funnel.type = 'button';
      funnel.dataset.filterColumn = String(index);
      const active = this.filters.some((filter) => filter.column === index);
      funnel.classList.toggle('active', active);
      funnel.setAttribute('aria-label', `${name}，${active ? '已筛选，编辑条件' : '筛选此列'}`);
      funnel.setAttribute('aria-haspopup', 'dialog');
      funnel.setAttribute('aria-expanded', 'false');
      funnel.title = `${name} · ${active ? '已启用筛选' : '筛选已加载结果'}`;
      funnel.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 7v6l-4 2v-8Z"/></svg>';
      cell.append(label, funnel, sortControl, resize);
      fragment.append(cell);
    }
    this.header.replaceChildren(fragment);
  }

  handleSelection(event) {
    const target = event.target;
    if (target.matches('[data-select-row], [data-select-all]')) this.clearColumnSelection();
    if (target.matches('[data-select-all]')) {
      this.selected = target.checked ? new Set(this.visibleOrder) : new Set();
      this.selectionAnchor = null;
    } else if (target.matches('[data-select-row]')) {
      const index = Number(target.dataset.selectRow);
      target.checked ? this.selected.add(index) : this.selected.delete(index);
    } else return;
    this.updateSelectionDisplay();
  }

  updateSelectionDisplay() {
    // Mutate only the visible checkboxes to preserve keyboard focus.
    const all = this.header.querySelector('[data-select-all]');
    if (all) {
      all.checked = this.visibleOrder.length > 0 && this.selected.size === this.visibleOrder.length;
      all.indeterminate = this.selected.size > 0 && this.selected.size < this.visibleOrder.length;
    }
    for (const checkbox of this.body.querySelectorAll('[data-select-row]')) {
      const selected = this.selected.has(Number(checkbox.dataset.selectRow));
      checkbox.checked = selected;
      checkbox.closest('.db-grid-row').setAttribute('aria-selected', String(selected));
    }
    this.notifySelection();
  }

  notifySelection() {
    this.updateFooter();
    this.onSelectionChange?.({ selectedCount: this.selected.size, selectedColumnCount: this.selectedColumns?.size || 0, totalCount: this.visibleOrder.length });
  }

  handleClick(event) {
    const selectionCell = event.target.closest('.db-grid-selector');
    if (selectionCell) {
      const checkbox = selectionCell.querySelector('[data-select-row], [data-select-all]');
      if (!checkbox || checkbox.disabled) return;
      // Native checkbox clicks are already toggled before click dispatch and
      // emit change afterwards. The rest of the cell follows the same path
      // explicitly, preserving Shift without dispatching a second click.
      const direct = event.target === checkbox;
      if (!direct) checkbox.checked = !checkbox.checked;
      if (checkbox.matches('[data-select-row]')) {
        const index = Number(checkbox.dataset.selectRow);
        if (event.shiftKey) this.selected = selectRowRange(this.visibleOrder, this.selected, this.selectionAnchor, index, checkbox.checked);
        else this.selectionAnchor = index;
      }
      if (!direct) {
        checkbox.focus({ preventScroll: true });
        this.handleSelection({ target: checkbox });
      }
      return;
    }
    const filter = event.target.closest('[data-filter-column]');
    if (filter) { this.openFilter(Number(filter.dataset.filterColumn), filter); return; }
    const sort = event.target.closest('[data-sort-column]');
    if (sort) { this.sortColumn(Number(sort.dataset.sortColumn), Number(sort.dataset.sortDirection), event.detail === undefined || event.detail === 0); return; }
    const column = event.target.closest('[data-select-column]');
    if (column) {
      const index = Number(column.dataset.selectColumn);
      const plainClick = !event.shiftKey && !event.ctrlKey && !event.metaKey;
      if (plainClick && this.selectedColumns?.size === 1 && this.selectedColumns.has(index)) this.clearSelection();
      else this.selectColumn(index, event);
      return;
    }
    const cell = event.target.closest('[data-grid-cell]');
    if (this.cellPayload(cell)) {
      this.selectCell(cell);
      this.updateFooter();
    } else if (event.target === this.viewport || event.target === this.canvas ||
               event.target === this.body || event.target === this.header ||
               event.target.matches('.db-grid-row')) {
      this.clearSelection();
    }
  }

  clearSelection() {
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    const previousCell = this.editorInput?.closest?.('[data-grid-cell]');
    this.suspendCellEdit();
    if (previousCell) this.refreshCellValue(previousCell);
    this.selected.clear();
    this.clearColumnSelection();
    this.activeCell = null;
    this.selectionAnchor = null;
    this.updateActiveCellDisplay();
    if (typeof document !== 'undefined' && this.viewport.contains?.(document.activeElement)) document.activeElement?.blur?.();
    this.updateSelectionDisplay();
  }

  clearColumnSelection() {
    if (!this.selectedColumns?.size) return;
    this.selectedColumns.clear();
    this.columnSelectionAnchor = null;
    this.updateColumnSelectionDisplay();
  }

  updateColumnSelectionDisplay() {
    for (const header of this.header?.querySelectorAll?.('[data-column-header]') || []) {
      const selected = Boolean(this.selectedColumns?.has(Number(header.dataset.columnHeader)));
      header.dataset.columnSelected = String(selected);
      header.setAttribute('aria-selected', String(selected));
      header.querySelector('[data-select-column]')?.setAttribute('aria-pressed', String(selected));
    }
    for (const cell of this.body?.querySelectorAll?.('[data-grid-cell]') || []) {
      cell.classList.toggle('db-grid-cell-column-selected', Boolean(this.selectedColumns?.has(Number(cell.dataset.columnIndex))));
    }
  }

  selectColumn(column, { shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
    if (!Number.isInteger(column) || column < 0 || column >= this.columns.length) return;
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    const oldCell = this.editorInput?.closest?.('[data-grid-cell]');
    this.suspendCellEdit();
    if (oldCell) this.refreshCellValue(oldCell);
    this.activeCell = null;
    this.selected.clear();
    this.selectionAnchor = null;
    this.selectedColumns ||= new Set();
    const additive = ctrlKey || metaKey;
    if (shiftKey && Number.isInteger(this.columnSelectionAnchor)) {
      if (!additive) this.selectedColumns.clear();
      for (let index = Math.min(this.columnSelectionAnchor, column); index <= Math.max(this.columnSelectionAnchor, column); index++) this.selectedColumns.add(index);
    } else {
      if (!additive) this.selectedColumns.clear();
      if (additive && this.selectedColumns.has(column)) this.selectedColumns.delete(column);
      else this.selectedColumns.add(column);
      this.columnSelectionAnchor = column;
    }
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed) selection.removeAllRanges?.();
    this.updateActiveCellDisplay();
    this.updateColumnSelectionDisplay();
    this.updateSelectionDisplay();
    this.header.querySelector(`[data-select-column="${column}"]`)?.focus({ preventScroll: true });
  }

  sortColumn(column, requestedDirection, restoreFocus = true) {
    if (!Number.isInteger(column) || column < 0 || column >= this.columns.length) return;
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.closeCellMenu(false);
    const explicit = requestedDirection === 1 || requestedDirection === -1;
    const direction = explicit
      ? this.sort?.column === column && this.sort.direction === requestedDirection ? 0 : requestedDirection
      : this.sort?.column === column ? this.sort.direction === 1 ? -1 : 0 : 1;
    this.sort = direction ? { column, direction } : null;
    this.sortRowOrder();
    this.visibleOrder = filterRowOrder(this.rows, this.order, this.filters, this.textFilter);
    this.viewport.scrollTop = 0;
    this.activeCell = null;
    this.selectionAnchor = null;
    this.invalidate();
    this.render();
    const focusDirection = explicit ? requestedDirection : direction || 1;
    if (restoreFocus) this.header.querySelector(`[data-sort-column="${column}"][data-sort-direction="${focusDirection}"]`)?.focus({ preventScroll: true });
    this.announce(`${columnName(this.columns[column])} · ${direction === 1 ? '升序' : direction === -1 ? '降序' : '已恢复原始顺序'}`);
  }

  sortRowOrder() {
    if (!this.sort) this.order = Array.from({ length: this.rows.length }, (_, index) => index);
    else {
      const { column, direction } = this.sort;
      const keys = this.rows.map((row) => sortKey(row?.[column]));
      this.order.sort((left, right) => {
        // NULL remains last in both directions. Ties retain original row order.
        if (keys[left].nil || keys[right].nil) return compareKeys(keys[left], keys[right]) || left - right;
        return compareKeys(keys[left], keys[right]) * direction || left - right;
      });
    }
  }

  refreshRows() {
    const activeRow = this.activeCell ? this.visibleOrder[this.activeCell.position] : null;
    const activeColumn = this.activeCell?.column;
    this.sortRowOrder();
    this.visibleOrder = filterRowOrder(this.rows, this.order, this.filters, this.textFilter);
    const visible = new Set(this.visibleOrder);
    this.selected = new Set([...this.selected].filter((index) => visible.has(index)));
    const position = this.visibleOrder.indexOf(activeRow);
    this.activeCell = position < 0 ? null : { position, column: activeColumn };
    if (!visible.has(this.selectionAnchor)) this.selectionAnchor = null;
    this.updateFilterDisplay();
    this.invalidate();
    this.render();
    this.notifySelection();
  }

  handleCellDoubleClick(cell) {
    const payload = this.cellPayload(cell);
    if (!payload) return;
    if (this.onInspect && this.shouldInspectCell?.(payload)) this.inspectCell(cell);
    else this.startCellEdit(cell);
  }

  inspectCell(cell) {
    const payload = this.cellPayload(cell);
    if (!payload) return;
    const session = this.cellEditSession(payload.rowIndex, payload.columnIndex);
    if (session) {
      this.inspectEditSession(session);
      return;
    }
    this.onInspect?.({ ...payload, ...this.getCellEditState?.(payload) });
  }

  cellPayload(cell) {
    if (!cell) return null;
    const position = Number(cell.dataset.position);
    if (!Number.isInteger(position) || position < 0 || position >= this.visibleOrder.length) return null;
    const rowIndex = this.visibleOrder[position];
    const columnIndex = Number(cell.dataset.columnIndex);
    if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex) || !this.rows[rowIndex] || columnIndex < 0 || columnIndex >= this.columns.length) return null;
    return { column: columnName(this.columns[columnIndex]), value: this.rows[rowIndex][columnIndex], rowIndex, columnIndex };
  }

  cellEditSession(rowIndex, columnIndex, rows = this.rows) {
    return this.editSessions?.get(rows)?.get(`${rowIndex}:${columnIndex}`) || null;
  }

  isCellEditDirty(session) {
    if (!session) return false;
    const originalNull = session.payload.value == null;
    return session.isNull !== originalNull || (!session.isNull && session.draftValue !== formatCellValue(session.payload.value));
  }

  removeCellEditSession(session) {
    const sessions = this.editSessions?.get(session.rows);
    if (!sessions) return;
    sessions.delete(`${session.payload.rowIndex}:${session.payload.columnIndex}`);
    if (!sessions.size) this.editSessions.delete(session.rows);
  }

  suspendCellEdit() {
    const session = this.editSession;
    if (!session) return;
    this.unmountCellEditor();
    session.restoreFocus = false;
    this.editSession = null;
    if (!session.pending && !this.isCellEditDirty(session)) this.removeCellEditSession(session);
  }

  selectCell(cell, { focus = true } = {}) {
    const payload = this.cellPayload(cell);
    if (!payload) return false;
    const hadColumns = Boolean(this.selectedColumns?.size);
    this.clearColumnSelection();
    if (hadColumns) this.notifySelection();
    // A selection in an inspector can survive while its pane is hidden.
    // Selecting a real grid cell takes ownership of copy again. Native input
    // events do not enter this path; preserve textarea selections if invoked
    // programmatically for the editor that already owns focus.
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    const editorOwnsSelection = this.editorInput && typeof document !== 'undefined' && document.activeElement === this.editorInput &&
      this.editorInput.closest?.('[data-grid-cell]') === cell;
    if (!editorOwnsSelection && selection && !selection.isCollapsed) selection.removeAllRanges?.();
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    const same = this.editSession?.rows === this.rows && this.editSession.payload.rowIndex === payload.rowIndex && this.editSession.payload.columnIndex === payload.columnIndex;
    if (!same) {
      const previousCell = this.editorInput?.closest?.('[data-grid-cell]');
      this.suspendCellEdit();
      this.editSession = this.cellEditSession(payload.rowIndex, payload.columnIndex);
      if (previousCell) this.refreshCellValue(previousCell);
    }
    this.activeCell = { position: Number(cell.dataset.position), column: payload.columnIndex };
    this.updateActiveCellDisplay();
    if (this.editSession) this.mountCellEditor(focus && !editorOwnsSelection);
    if (focus && !this.editSession) this.focusActiveCell(false);
    return true;
  }

  refreshCellValue(cell) {
    const payload = this.cellPayload(cell);
    if (!payload) return;
    const draft = this.cellEditSession(payload.rowIndex, payload.columnIndex);
    const value = draft ? draft.isNull ? null : draft.draftValue : payload.value;
    const text = formatCellValue(value);
    cell.textContent = value === '' ? '空字符串' : text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
    cell.classList.remove('db-grid-cell-editing');
    cell.classList.toggle('db-grid-cell-draft', Boolean(draft && (draft.pending || this.isCellEditDirty(draft))));
    cell.classList.toggle('db-grid-null', value == null);
    cell.classList.toggle('db-grid-number', typeof value === 'number' || typeof value === 'bigint');
    cell.classList.toggle('db-grid-empty-value', value === '');
    cell.classList.toggle('db-grid-boolean', typeof value === 'boolean');
    cell.classList.toggle('db-grid-boolean-true', value === true);
    cell.classList.toggle('db-grid-boolean-false', value === false);
    cell.title = `${value === '' ? '空字符串（长度为 0）' : text.length > 400 ? `${text.slice(0, 400)}…` : text}\n${draft ? draft.pending ? '保存中 · ' : '未保存草稿 · ' : ''}输入文字直接编辑 · 双击查看 JSON 或编辑 · Enter 编辑 · 右键查看详情`;
  }

  updateActiveCellDisplay() {
    for (const cell of this.body?.querySelectorAll('[data-grid-cell]') || []) {
      const active = Number(cell.dataset.position) === this.activeCell?.position && Number(cell.dataset.columnIndex) === this.activeCell?.column;
      cell.tabIndex = active ? 0 : -1;
      cell.classList.toggle('db-grid-cell-active', active);
      cell.setAttribute('aria-selected', String(active));
    }
  }

  startCellEdit(cell, { replaceValue, isNull } = {}) {
    if (this.savingResults?.has(this.rows)) return false;
    const payload = this.cellPayload(cell);
    if (!payload) return false;
    const existing = this.cellEditSession(payload.rowIndex, payload.columnIndex);
    if (existing) {
      this.selectCell(cell);
      if (!existing.pending && (replaceValue !== undefined || isNull !== undefined)) {
        if (replaceValue !== undefined) existing.draftValue = replaceValue;
        existing.isNull = isNull ?? false;
        existing.error = '';
        if (this.editorInput) this.editorInput.value = existing.isNull ? '' : existing.draftValue;
        this.updateCellEditor();
      }
      return true;
    }
    const editState = this.getCellEditState?.(payload) || { editable: false };
    if (!editState.editable || !this.onCommitCell) {
      this.announce(editState.reason || '此单元格只读，可右键查看详情');
      return false;
    }
    this.closeFilter(false);
    this.closeCellMenu(false);
    this.selectCell(cell, { focus: false });
    this.editSession = {
      rows: this.rows, payload: { ...payload, ...editState },
      draftValue: replaceValue !== undefined ? replaceValue : payload.value == null ? '' : formatCellValue(payload.value),
      isNull: isNull ?? (replaceValue !== undefined ? false : payload.value == null),
      pending: false, error: '', restoreFocus: false,
    };
    if (!this.editSessions.has(this.rows)) this.editSessions.set(this.rows, new Map());
    this.editSessions.get(this.rows).set(`${payload.rowIndex}:${payload.columnIndex}`, this.editSession);
    this.mountCellEditor(true);
    return true;
  }

  unmountCellEditor({ preserve = false } = {}) {
    const input = this.editorInput;
    if (input) {
      const session = this.editSession;
      if (session) {
        session.selection = [input.selectionStart, input.selectionEnd, input.selectionDirection];
        if (typeof document !== 'undefined' && document.activeElement === input) session.restoreFocus = preserve;
      }
      input.remove();
    }
    if (!preserve) {
      this.editorInput = null;
      this.editorComposing = false;
    }
  }

  mountCellEditor(focus = false) {
    const session = this.editSession;
    if (!session || this.destroyed) return;
    const position = this.visibleOrder.indexOf(session.payload.rowIndex);
    const cell = position < 0 ? null : this.body.querySelector(`[data-position="${position}"][data-column-index="${session.payload.columnIndex}"]`);
    if (!cell) { this.updateFooter(); return; }
    let input = this.editorInput;
    if (!input) {
      input = element('textarea', 'db-grid-edit-input');
      input.value = session.isNull ? '' : session.draftValue;
      input.rows = 1;
      input.wrap = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', `${session.payload.column} 的新值`);
      input.setAttribute('aria-description', 'Enter 保存，Shift Enter 换行，Escape 取消，Tab 保存并移到下一格。右键查看详情或设为 NULL。');
      // Text editing and native clipboard operations belong to the textarea,
      // never to the result grid or the global SQL keyboard shortcuts.
      for (const type of ['pointerdown', 'click', 'dblclick', 'input', 'change', 'copy', 'cut', 'paste', 'keyup']) input.addEventListener(type, (event) => {
        if (type === 'pointerdown') this.closeCellMenu(false);
        event.stopPropagation();
      });
      input.addEventListener('keydown', (event) => this.handleEditorKeydown(event));
      input.addEventListener('input', () => {
        session.draftValue = input.value;
        session.isNull = false;
        session.error = '';
        this.updateCellEditor();
      });
      input.addEventListener('compositionstart', (event) => { event.stopPropagation(); this.editorComposing = true; });
      input.addEventListener('compositionend', (event) => {
        event.stopPropagation();
        this.editorComposing = false;
        session.draftValue = input.value;
        session.isNull = false;
        this.scheduleRender();
      });
      input.addEventListener('blur', () => {
        // Leaving the cell is deliberately not a database write. The footer
        // remains available even if the edited row is outside the viewport.
        this.updateFooter();
      });
      this.editorInput = input;
    }
    if (input.parentNode !== cell) cell.replaceChildren(input);
    cell.classList.add('db-grid-cell-editing');
    this.updateCellEditor();
    if (focus || session.restoreFocus) {
      input.focus({ preventScroll: true });
      // Enter editing with an insertion caret, not a full-value selection.
      // A restored draft keeps its exact caret/selection instead of jumping.
      if (session.selection) input.setSelectionRange(...session.selection);
      else {
        input.setSelectionRange(input.value.length, input.value.length);
        // Reveal the insertion point for values wider/taller than one cell.
        input.scrollLeft = input.scrollWidth;
        input.scrollTop = input.scrollHeight;
      }
      session.restoreFocus = false;
    }
  }

  updateCellEditor() {
    const session = this.editSession;
    if (!session) { this.updateFooter(); return; }
    if (this.editorInput) {
      // readOnly retains focus and the selection while a write is pending.
      this.editorInput.readOnly = session.pending || Boolean(this.savingResults?.has(session.rows));
      this.editorInput.placeholder = session.isNull ? 'NULL' : '空字符串';
      this.editorInput.classList.toggle('db-grid-edit-null', session.isNull);
      this.editorInput.setAttribute('aria-busy', String(session.pending));
      this.editorInput.setAttribute('aria-invalid', String(Boolean(session.error)));
      this.editorInput.title = session.error || 'Enter 保存 · Shift Enter 换行 · Esc 取消 · 右键详情';
    }
    this.updateFooter();
  }

  handleEditorKeydown(event) {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229 || this.editorComposing) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      this.openCellMenu(this.editorInput?.closest('[data-grid-cell]'));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.editSession?.pending) { this.cancelCellEdit({ focus: false }); this.clearSelection(); }
    }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.preventDefault();
    else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.commitCellEdit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const session = this.editSession;
      const direction = event.shiftKey ? -1 : 1;
      const selectionVersion = this.selectionVersion;
      this.commitCellEdit().then((saved) => {
        if (!saved || this.rows !== session?.rows || this.editSession || this.selectionVersion !== selectionVersion) return;
        const position = this.visibleOrder.indexOf(session.payload.rowIndex);
        if (position < 0) return;
        const next = Math.max(0, Math.min(this.visibleOrder.length * this.columns.length - 1, position * this.columns.length + session.payload.columnIndex + direction));
        this.activeCell = { position: Math.floor(next / this.columns.length), column: next % this.columns.length };
        this.focusActiveCell(true);
        this.updateFooter();
      });
    }
  }

  closeCellMenu(focus = false) {
    if (!this.cellMenu) return;
    this.cellMenu.remove();
    this.cellMenu = null;
    const columnTrigger = this.columnMenuTrigger;
    this.columnMenuTrigger = null;
    if (focus) {
      if (columnTrigger?.isConnected) columnTrigger.focus({ preventScroll: true });
      else if (this.editorInput?.isConnected) this.editorInput.focus({ preventScroll: true });
      else this.focusActiveCell(false);
    }
  }

  openColumnMenu(header, event) {
    const column = Number(header.dataset.columnHeader);
    if (!Number.isInteger(column) || column < 0 || column >= this.columns.length) return;
    this.closeCellMenu(false);
    this.closeFilter(false);
    const columns = this.columns;
    const rows = this.rows;
    const name = columnName(columns[column]);
    const rect = header.getBoundingClientRect();
    const menu = element('div', 'db-grid-cell-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${name} 列操作`);
    const copy = async (text, message) => {
      try {
        if (this.onCopyCell) await this.onCopyCell(text);
        else await navigator.clipboard.writeText(text);
        this.announce(message);
      } catch (error) { this.announce(`复制失败：${error.message || error}`); }
    };
    const items = [
      ['select', '选中整列', () => this.selectColumn(column)],
      ['copy-name', '复制列名', () => copy(name, `已复制列名 ${name}`)],
      ['copy-data', '复制列数据', () => copy(formatClipboardRows([name], this.visibleOrder.map(index => [rows[index][column]]), { includeHeaders: false }), `已复制 ${name} · ${this.visibleOrder.length} 行`)],
      ['ascending', '升序排列', () => this.sortColumn(column, 1)],
      ['descending', '降序排列', () => this.sortColumn(column, -1)],
      ['filter', '筛选此列', () => this.openFilter(column, this.header.querySelector(`[data-filter-column="${column}"]`))],
    ];
    for (const [action, label, run] of items) {
      const button = element('button', 'db-grid-cell-menu-item', label);
      button.type = 'button'; button.dataset.columnAction = action; button.setAttribute('role', 'menuitem');
      button.addEventListener('click', () => {
        this.closeCellMenu(false);
        if (this.rows === rows && this.columns === columns) run();
      });
      menu.append(button);
    }
    menu.addEventListener('keydown', key => {
      key.stopPropagation();
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement);
      if (key.key === 'Escape' || key.key === 'Tab') { key.preventDefault(); this.closeCellMenu(true); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key.key)) {
        key.preventDefault();
        const next = key.key === 'Home' ? 0 : key.key === 'End' ? buttons.length - 1 : (current + (key.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    document.body.append(menu);
    this.cellMenu = menu;
    this.columnMenuTrigger = header.querySelector('[data-select-column]');
    menu.style.left = `${Math.max(8, Math.min(event?.clientX ?? rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event?.clientY ?? rect.bottom, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  openCellMenu(cell, event) {
    const payload = this.cellPayload(cell);
    if (!payload) return;
    this.closeCellMenu(false);
    this.closeFilter(false);
    const rows = this.rows;
    const state = this.getCellEditState?.(payload) || { editable: false };
    const session = this.cellEditSession(payload.rowIndex, payload.columnIndex);
    const busy = Boolean(session?.pending);
    const reason = busy ? '正在保存，请稍候' : state.reason || '此单元格只读';
    const editable = Boolean(state.editable && this.onCommitCell && !busy);
    this.selectCell(cell, { focus: false });
    const menu = element('div', 'db-grid-cell-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${payload.column} 单元格操作`);
    // Resolve the source row by identity on action, never by a stale visible
    // position after sorting/filtering or switching tabs.
    const sourceCell = () => rows === this.rows ? { dataset: { position: String(this.visibleOrder.indexOf(payload.rowIndex)), columnIndex: String(payload.columnIndex) } } : null;
    const item = (action, label, enabled, callback, disabledReason = reason) => {
      const button = element('button', 'db-grid-cell-menu-item', label);
      button.type = 'button';
      button.dataset.cellAction = action;
      button.setAttribute('role', 'menuitem');
      button.disabled = !enabled;
      button.title = enabled ? label : disabledReason;
      if (!enabled) button.setAttribute('aria-description', disabledReason);
      button.addEventListener('click', () => {
        const source = sourceCell();
        this.closeCellMenu(false);
        if (source && Number(source.dataset.position) >= 0) callback(source);
      });
      menu.append(button);
    };
    item('inspect', '查看详情', Boolean(this.onInspect && !busy), (source) => this.inspectCell(source));
    item('copy', '复制值', true, async () => {
      const value = session ? session.isNull ? null : session.draftValue : payload.value;
      try {
        const text = formatCellValue(value);
        if (this.onCopyCell) await this.onCopyCell(text);
        else await navigator.clipboard.writeText(text);
        this.announce(`已复制 ${payload.column} 的值`);
      } catch (error) { this.announce(`复制失败：${error instanceof Error ? error.message : String(error)}`); }
    });
    item('edit', '编辑单元格', editable, (source) => this.startCellEdit(source));
    item('empty', '设为空字符串', editable && state.allowEmpty === true, (source) => {
      this.startCellEdit(source, { replaceValue: '', isNull: false });
    }, state.editable && !state.allowEmpty ? '该字段类型不支持空字符串' : reason);
    item('null', '设为 NULL', editable && state.allowNull !== false, (source) => {
      if (!this.startCellEdit(source, { isNull: true })) return;
      this.editSession.isNull = true;
      this.editSession.error = '';
      if (this.editorInput) this.editorInput.value = '';
      this.updateCellEditor();
    }, state.allowNull === false ? '此列不允许 NULL' : reason);
    const rowActions = this.selectedRowActions(payload.rowIndex);
    if (rowActions.length) {
      const divider = element('div', 'db-grid-menu-divider');
      divider.setAttribute('role', 'separator');
      menu.append(divider);
      this.appendRowActions(menu, rowActions);
    }
    this.showCellMenu(menu, cell, event);
    this.updateFooter();
  }

  selectedRowActions(rowIndex) {
    if (!this.getRowActions || !this.selected.has(rowIndex)) return [];
    return this.getRowActions({ columns: this.columns, rows: this.getSelectedRows() });
  }

  appendRowActions(menu, actions) {
    const rows = this.rows;
    const columns = this.columns;
    for (const { id, label, disabledReason, run } of actions) {
      const button = element('button', 'db-grid-cell-menu-item', label);
      button.type = 'button';
      button.dataset.rowAction = id;
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(disabledReason);
      if (disabledReason) {
        button.title = disabledReason;
        button.setAttribute('aria-description', disabledReason);
      }
      button.addEventListener('click', () => {
        this.closeCellMenu(true);
        if (rows === this.rows && columns === this.columns) void run();
      });
      menu.append(button);
    }
  }

  openSelectedRowMenu(selector, event) {
    const row = selector.closest('[data-row-index]');
    if (!row) return;
    const actions = this.selectedRowActions(Number(row.dataset.rowIndex));
    if (!actions.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeCellMenu(false);
    this.closeFilter(false);
    const menu = element('div', 'db-grid-cell-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `所选 ${this.selected.size} 行的操作`);
    this.appendRowActions(menu, actions);
    this.columnMenuTrigger = selector.querySelector('[data-select-row]');
    this.showCellMenu(menu, selector, event.type === 'contextmenu' ? event : null);
  }

  showCellMenu(menu, anchor, event) {
    const rect = anchor.getBoundingClientRect();
    menu.addEventListener('keydown', (key) => {
      key.stopPropagation();
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement);
      if (key.key === 'Escape' || key.key === 'Tab') { key.preventDefault(); this.closeCellMenu(true); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key.key)) {
        key.preventDefault();
        const next = key.key === 'Home' ? 0 : key.key === 'End' ? items.length - 1 : (current + (key.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    document.body.append(menu);
    this.cellMenu = menu;
    menu.style.left = `${Math.max(8, Math.min(event?.clientX ?? rect.left + 8, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event?.clientY ?? rect.bottom, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  async commitCellEdit() {
    const session = this.editSession;
    if (!session || session.pending || !this.onCommitCell) return false;
    session.pending = true;
    session.error = '';
    this.updateCellEditor();
    try {
      const saved = await this.onCommitCell({ ...session.payload, newValue: session.draftValue, isNull: session.isNull });
      if (!saved) { session.error = '未能保存，请检查后重试'; return false; }
      this.removeCellEditSession(session);
      if (this.editSession === session) {
        const restoreFocus = typeof document === 'undefined' || document.activeElement === this.editorInput || this.footerActions?.contains(document.activeElement);
        this.unmountCellEditor();
        this.editSession = null;
        const position = this.visibleOrder.indexOf(session.payload.rowIndex);
        this.activeCell = position < 0 ? null : { position, column: session.payload.columnIndex };
        this.invalidate();
        this.render();
        if (restoreFocus) {
          if (this.activeCell) this.focusActiveCell(false);
          else this.viewport.focus?.({ preventScroll: true });
        }
        this.updateFooter();
        this.announce(`${session.payload.column} 已保存`);
      }
      return true;
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      session.pending = false;
      if (this.editSession === session) this.updateCellEditor();
      else if (this.rows === session.rows) {
        this.invalidate();
        this.render();
        this.updateFooter();
      }
    }
  }

  async commitAllCellEdits() {
    if (this.editorComposing || this.savingResults?.has(this.rows)) return false;
    const rows = this.rows;
    const sessions = [...(this.editSessions?.get(rows)?.values() || [])];
    if (sessions.some(session => session.pending)) return false;
    const dirty = sessions.filter(session => this.isCellEditDirty(session));
    if (!dirty.length || (!this.onCommitCells && !this.onCommitCell)) return false;
    const payloads = dirty.map(session => ({ ...session.payload, newValue: session.draftValue, isNull: session.isNull }));
    this.savingResults ||= new WeakSet();
    this.savingResults.add(rows);
    for (const session of dirty) { session.pending = true; session.error = ''; }
    this.updateCellEditor();
    let outcomes;
    try {
      outcomes = this.onCommitCells ? await this.onCommitCells(payloads) : await this.commitCellEditsSequentially(payloads);
    } catch (error) {
      outcomes = dirty.map(() => ({ saved: false, error: error instanceof Error ? error.message : String(error) }));
    }
    this.savingResults.delete(rows);
    for (const [index, session] of dirty.entries()) {
      session.pending = false;
      if (outcomes?.[index]?.saved) {
        this.removeCellEditSession(session);
        if (this.editSession === session) { this.unmountCellEditor(); this.editSession = null; }
      } else session.error = outcomes?.[index]?.error || '未能保存，修改已保留';
    }
    if (this.rows === rows) {
      this.invalidate(); this.render();
    }
    this.updateCellEditor(); this.updateFooter();
    return outcomes?.length === dirty.length && outcomes.every(outcome => outcome.saved);
  }

  async commitCellEditsSequentially(payloads) {
    const outcomes = [];
    for (const payload of payloads) {
      try {
        if (!await this.onCommitCell(payload)) throw new Error('未能保存，修改已保留');
        outcomes.push({ saved: true });
      } catch (error) {
        while (outcomes.length < payloads.length) outcomes.push({ saved: false, error: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    return outcomes;
  }

  cancelCellEdit({ focus = true } = {}) {
    if (!this.editSession || this.editSession.pending || this.savingResults?.has(this.editSession.rows)) return;
    this.removeCellEditSession(this.editSession);
    this.unmountCellEditor();
    this.editSession = null;
    this.invalidate();
    this.render();
    if (focus) this.focusActiveCell(false);
    this.updateFooter();
  }

  getCellEditDraft(rows = this.rows) {
    const drafts = this.getCellEditDrafts(rows);
    return drafts.find((draft) => draft.pending) || drafts.find((draft) => draft.dirty) || null;
  }

  getCellEditDrafts(rows = this.rows) {
    return [...(this.editSessions?.get(rows)?.values() || [])].map((session) => ({
      ...session.payload, draftValue: session.draftValue,
      draftIsNull: session.isNull, pending: session.pending, dirty: this.isCellEditDirty(session),
    }));
  }

  updateCellEditContexts(rows, update) {
    for (const draft of this.getCellEditDrafts(rows)) update(draft);
  }

  discardCellEdit(rows = this.rows) {
    if (this.savingResults?.has(rows)) return false;
    const sessions = this.editSessions?.get(rows);
    if (!sessions) return true;
    if ([...sessions.values()].some((session) => session.pending)) return false;
    if (this.editSession?.rows === rows) {
      this.unmountCellEditor();
      this.editSession = null;
    }
    this.editSessions.delete(rows);
    if (rows === this.rows) {
      this.invalidate();
      this.render();
      this.updateFooter();
    }
    return true;
  }

  inspectEditSession(session = this.editSession) {
    if (!session || session.pending || !this.onInspect) return;
    const payload = { ...session.payload, draftValue: session.draftValue, draftIsNull: session.isNull };
    if (this.editSession === session) this.cancelCellEdit({ focus: false });
    else this.removeCellEditSession(session);
    this.onInspect(payload);
  }

  handleKeydown(event) {
    if (event.target === this.editorInput) return;
    const composingCell = event.target.closest('[data-grid-cell]');
    if (composingCell && (event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Dead')) {
      // Focus the native editor before the IME performs its default input.
      // Do not cancel the initiating event or insert the candidate ourselves.
      event.stopPropagation?.();
      this.startCellEdit(composingCell, { replaceValue: '' });
      return;
    }
    if (event.isComposing) return;
    const columnLabel = event.target.closest('[data-select-column]');
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation?.(); this.clearSelection(); return;
    }
    if (columnLabel) {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault(); event.stopPropagation?.(); this.openColumnMenu(columnLabel.closest('[data-column-header]')); return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const column = Number(columnLabel.dataset.selectColumn);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.columns.length - 1 : Math.max(0, Math.min(this.columns.length - 1, column + (event.key === 'ArrowRight' ? 1 : -1)));
        this.selectColumn(next, event);
      }
      return;
    }
    const resize = event.target.closest('[data-resize-column]');
    if (resize && event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.fitColumn(Number(resize.dataset.resizeColumn));
      return;
    }
    if (resize && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index = Number(resize.dataset.resizeColumn);
      this.setColumnWidth(index, this.widths[index] + (event.key === 'ArrowRight' ? 16 : -16));
      this.header.querySelector(`[data-resize-column="${index}"]`)?.focus({ preventScroll: true });
      return;
    }
    const cell = event.target.closest('[data-grid-cell]');
    if (cell && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) { event.preventDefault(); event.stopPropagation?.(); this.openCellMenu(cell); return; }
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && event.target.matches('[data-select-row]')) {
      this.openSelectedRowMenu(event.target.closest('.db-grid-selector'), event);
      return;
    }
    if (cell && (event.key === 'F2' || event.key === 'Enter') && !event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopPropagation?.(); this.startCellEdit(cell); return; }
    if (cell && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation?.();
      this.startCellEdit(cell, { replaceValue: event.key });
      return;
    }
    if (!cell && event.target !== this.viewport && !event.target.matches('[data-select-row], [data-select-all]')) return;
    if (!this.visibleOrder.length || !this.columns.length) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.clearColumnSelection();
      this.selected = new Set(this.visibleOrder);
      this.updateSelectionDisplay();
      return;
    }
    if (cell && event.key === ' ') {
      event.preventDefault();
      this.clearColumnSelection();
      const index = this.visibleOrder[Number(cell.dataset.position)];
      const checked = !this.selected.has(index);
      this.selected = selectRowRange(this.visibleOrder, this.selected, event.shiftKey ? this.selectionAnchor : index, index, checked);
      if (!event.shiftKey) this.selectionAnchor = index;
      this.updateSelectionDisplay();
      return;
    }
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const entering = !this.activeCell;
    const position = this.activeCell ? { ...this.activeCell } : { position: Math.floor(this.viewport.scrollTop / ROW_HEIGHT), column: this.columnRange().start };
    const page = Math.max(1, Math.floor((this.viewport.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT));
    if (!entering && event.key === 'ArrowUp') position.position--;
    if (!entering && event.key === 'ArrowDown') position.position++;
    if (!entering && event.key === 'ArrowLeft') position.column--;
    if (!entering && event.key === 'ArrowRight') position.column++;
    if (event.key === 'PageUp') position.position -= page;
    if (event.key === 'PageDown') position.position += page;
    if (event.key === 'Home') { position.column = 0; if (event.ctrlKey || event.metaKey) position.position = 0; }
    if (event.key === 'End') { position.column = this.columns.length - 1; if (event.ctrlKey || event.metaKey) position.position = this.visibleOrder.length - 1; }
    position.position = Math.max(0, Math.min(this.visibleOrder.length - 1, position.position));
    position.column = Math.max(0, Math.min(this.columns.length - 1, position.column));
    this.selectCell({ dataset: { position: String(position.position), columnIndex: String(position.column) } }, { focus: false });
    this.focusActiveCell(true);
    this.updateFooter();
  }

  handleCopy(event) {
    // Preserve native copying when the user explicitly selected some text.
    if (event.target === this.editorInput || !event.clipboardData || !window.getSelection()?.isCollapsed) return;
    const cell = event.target.closest('[data-grid-cell]');
    if (!cell && event.target !== this.viewport && !event.target.closest('[data-column-header]') && !event.target.matches('[data-select-row], [data-select-all]')) return;
    let text;
    let label;
    if (this.selectedColumns?.size) {
      const data = this.getSelectedData();
      text = formatClipboardRows(data.columns, data.rows);
      label = `已复制 ${this.selectedColumns.size} 列 · ${data.rows.length} 行（含列名）`;
    } else if (this.selected.size) {
      text = formatClipboardRows(this.columns, this.getSelectedRows());
      label = `已复制 ${this.selected.size.toLocaleString()} 行（含列名）`;
    } else if (this.activeCell) {
      const { position, column } = this.activeCell;
      const draft = this.cellEditSession(this.visibleOrder[position], column);
      text = formatCellValue(draft ? draft.isNull ? null : draft.draftValue : this.rows[this.visibleOrder[position]]?.[column]);
      label = `已复制 ${columnName(this.columns[column])} 的值`;
    } else return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    this.announce(label);
  }

  updateFooter() {
    if (!this.footer) return;
    this.footer.hidden = this.columns.length === 0;
    const session = this.editSession;
    const drafts = this.getCellEditDrafts().filter((draft) => draft.pending || draft.dirty);
    this.onDraftChange?.({ rows: this.rows, dirtyCount: drafts.filter(draft => draft.dirty).length, pending: drafts.some(draft => draft.pending) });
    const unsaved = drafts.length ? `未保存 ${drafts.length} 格` : '';
    this.footerHint.textContent = session ? 'Enter 保存当前格 · Esc 取消当前格 · ⌘/Ctrl S 保存修改' : '点击列名选列 · 输入文字编辑 · 右键详情';
    this.footerActions.hidden = Boolean(this.externalEditActions);
    const dirty = drafts.filter(draft => draft.dirty);
    const pending = drafts.some(draft => draft.pending);
    this.editCancel.disabled = !dirty.length || pending;
    this.editSave.disabled = !dirty.length || pending || !this.getCellEditState?.(dirty[0])?.editable;
    this.editSave.title = `保存当前表的修改${dirty.length ? `（${dirty.length} 格）` : ''} · ⌘/Ctrl+S`;
    this.footerStatus.classList.toggle('db-grid-footer-error', Boolean(session?.error));
    if (session) {
      const position = this.visibleOrder.indexOf(session.payload.rowIndex);
      const location = position < 0 ? '已被筛选隐藏' : `第 ${position + 1} 行`;
      this.footerStatus.textContent = [unsaved, session.error || `${session.payload.column} · ${location} · ${session.pending ? '保存中…' : this.isCellEditDirty(session) ? session.isNull ? 'NULL 待保存' : '待保存' : '编辑中'}`].filter(Boolean).join(' · ');
    } else {
      if (this.statusTimer) return;
      const location = this.selectedColumns?.size
        ? `已选 ${this.selectedColumns.size} 列 · ${this.visibleOrder.length} 行 · Esc 清除`
        : this.selected.size
        ? `已选 ${this.selected.size.toLocaleString()} 行 · Esc 清除`
        : this.activeCell
          ? `第 ${(this.activeCell.position + 1).toLocaleString()} 行 · ${columnName(this.columns[this.activeCell.column])}`
          : `${this.visibleOrder.length.toLocaleString()} 行 · ${this.columns.length} 列`;
      this.footerStatus.textContent = [unsaved, location].filter(Boolean).join(' · ');
    }
    this.footerStatus.title = this.footerStatus.textContent;
  }

  announce(message) {
    clearTimeout(this.statusTimer);
    this.footerStatus.textContent = message;
    this.footerStatus.title = message;
    this.statusTimer = setTimeout(() => { this.statusTimer = 0; this.updateFooter(); }, 2600);
  }

  focusActiveCell(scroll) {
    if (!this.activeCell) return;
    const { position, column } = this.activeCell;
    if (!this.cellPayload({ dataset: { position: String(position), columnIndex: String(column) } })) {
      this.activeCell = null;
      return;
    }
    if (scroll) {
      const top = position * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      const height = this.viewport.clientHeight - HEADER_HEIGHT;
      if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
      else if (bottom > this.viewport.scrollTop + height) this.viewport.scrollTop = bottom - height;
      const left = this.offsets[column];
      const right = left + this.widths[column];
      if (left < this.viewport.scrollLeft + SELECTOR_WIDTH) this.viewport.scrollLeft = left - SELECTOR_WIDTH;
      else if (right > this.viewport.scrollLeft + this.viewport.clientWidth) this.viewport.scrollLeft = right - this.viewport.clientWidth;
      this.render();
    }
    const cell = this.body.querySelector(`[data-position="${position}"][data-column-index="${column}"]`);
    if (cell) {
      this.updateActiveCellDisplay();
      cell.focus({ preventScroll: true });
    }
  }

  setTextFilter(value) {
    this.textFilter = value;
    this.applyFilters();
  }

  clearAllFilters() {
    this.filters = [];
    this.textFilter = '';
    this.onTextFilterChange?.('');
    this.applyFilters();
    this.viewport.focus({ preventScroll: true });
  }

  applyFilters() {
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.closeCellMenu(false);
    this.closeFilter(false);
    this.visibleOrder = filterRowOrder(this.rows, this.order, this.filters, this.textFilter);
    const visible = new Set(this.visibleOrder);
    this.selected = new Set([...this.selected].filter((index) => visible.has(index)));
    this.activeCell = null;
    this.selectionAnchor = null;
    this.viewport.scrollTop = 0;
    this.updateFilterDisplay();
    this.invalidate();
    this.render();
    this.notifySelection();
  }

  updateFilterDisplay() {
    this.viewport.setAttribute('aria-rowcount', String(this.visibleOrder.length + 1));
    this.body.style.height = `${this.visibleOrder.length * ROW_HEIGHT}px`;
    this.updateEmptyState();
    this.filterBar.hidden = !this.filters.length && !this.textFilter.trim();
    this.filterBar.replaceChildren(element('span', 'db-grid-filter-scope', `已加载数据 · ${this.visibleOrder.length}/${this.rows.length} 行`));
    if (this.textFilter.trim()) {
      const chip = element('button', 'db-grid-filter-chip', `搜索：${this.textFilter} ×`);
      chip.type = 'button';
      chip.dataset.removeFilter = 'text';
      chip.title = `清除搜索：${this.textFilter}`;
      chip.setAttribute('aria-label', chip.title);
      this.filterBar.append(chip);
    }
    for (const filter of this.filters) {
      const label = `${columnName(this.columns[filter.column])} ${FILTER_OPERATORS.find(([op]) => op === filter.operator)[1]}${unaryFilter(filter.operator) ? '' : ` ${filter.value}`}`;
      const chip = element('button', 'db-grid-filter-chip', `${label} ×`);
      chip.type = 'button';
      chip.dataset.removeFilter = String(filter.column);
      chip.title = `清除筛选：${label}`;
      chip.setAttribute('aria-label', chip.title);
      this.filterBar.append(chip);
    }
    const clear = element('button', 'quiet-btn', '清除全部');
    clear.type = 'button';
    clear.dataset.removeFilter = 'all';
    this.filterBar.append(clear);
  }

  updateEmptyState() {
    this.empty.hidden = this.visibleOrder.length > 0;
    const filtered = this.filters.length > 0 || Boolean(this.textFilter.trim());
    this.emptyTitle.textContent = filtered ? '没有符合条件的记录' : this.columns.length ? '查询完成，暂无记录' : '结果会显示在这里';
    this.emptyDescription.textContent = filtered
      ? `当前在 ${this.rows.length.toLocaleString()} 行已加载数据中筛选。试试其他关键词，或清除筛选重新查看。`
      : this.columns.length ? '数据库返回了列信息，但没有返回数据。可以调整查询条件后重试。' : '执行 SQL 查询，或在对象列表中打开一张表。';
    this.emptyClear.hidden = !filtered;
  }

  closeFilter(focus = false) {
    if (!this.filterPanel) return;
    const column = this.filterPanel.dataset.column;
    this.filterPanel.remove();
    this.filterPanel = null;
    const trigger = this.header.querySelector(`[data-filter-column="${column}"]`);
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus) trigger?.focus({ preventScroll: true });
  }

  openFilter(column, trigger) {
    this.closeCellMenu(false);
    const toggle = this.filterPanel?.dataset.column === String(column);
    this.closeFilter(false);
    if (toggle) return;
    const panel = element('form', 'db-grid-filter-panel');
    panel.dataset.column = String(column);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `筛选 ${columnName(this.columns[column])}`);
    const heading = element('strong', '', `筛选 · ${columnName(this.columns[column])}`);
    const note = element('p', '', '仅筛选当前已加载数据，多列条件同时满足。');
    const operatorField = element('div', 'db-grid-filter-field');
    const operatorPicker = element('div', 'db-grid-filter-select');
    const operator = element('button', 'db-grid-filter-operator');
    operator.type = 'button';
    operator.setAttribute('aria-label', '筛选条件');
    operator.setAttribute('aria-haspopup', 'listbox');
    operator.setAttribute('aria-expanded', 'false');
    const operatorText = element('span', '');
    const chevron = element('span', 'theme-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    operator.append(operatorText, chevron);
    const menu = element('div', 'db-grid-filter-operators');
    menu.id = `${this.container.id || 'result-grid'}-filter-${column}-operators`;
    menu.tabIndex = -1;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '筛选条件选项');
    menu.hidden = true;
    operator.setAttribute('aria-controls', menu.id);
    const previous = this.filters.find((filter) => filter.column === column);
    operator.value = previous?.operator || 'contains';
    operatorText.textContent = FILTER_OPERATORS.find(([value]) => value === operator.value)[1];
    operatorPicker.append(operator, menu);
    operatorField.append(element('span', '', '条件'), operatorPicker);
    const valueLabel = element('label', '', '值');
    const input = element('input', '');
    input.setAttribute('aria-label', '筛选值');
    input.value = previous?.value || '';
    input.placeholder = '输入值（文字不区分大小写）';
    valueLabel.append(input);
    const positionPanel = () => {
      if (!panel.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - panel.offsetHeight - 8))}px`;
    };
    let activeOperator = operator.value;
    const highlightOperator = () => {
      for (const row of menu.children) row.classList.toggle('active', row.dataset.value === activeOperator);
      const row = [...menu.children].find((item) => item.dataset.value === activeOperator);
      if (row) {
        menu.setAttribute('aria-activedescendant', row.id);
        row.scrollIntoView({ block: 'nearest' });
      }
    };
    const closeOperators = (focus = false) => {
      menu.hidden = true;
      menu.removeAttribute('aria-activedescendant');
      operator.setAttribute('aria-expanded', 'false');
      if (focus) operator.focus({ preventScroll: true });
    };
    const openOperators = () => {
      activeOperator = operator.value;
      menu.replaceChildren(...FILTER_OPERATORS.map(([value, label], index) => {
        const row = element('div', 'db-grid-filter-option');
        row.id = `${menu.id}-${index}`;
        row.dataset.value = value;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(value === operator.value));
        const check = element('span', 'db-grid-filter-check', value === operator.value ? '✓' : '');
        check.setAttribute('aria-hidden', 'true');
        row.append(check, element('span', '', label));
        return row;
      }));
      const rect = operator.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const right = panelRect.right + gap;
      const left = panelRect.left - gap - rect.width;
      const beside = right + rect.width <= window.innerWidth - margin ? right : left >= margin ? left : null;
      const availableHeight = beside === null ? rect.top - gap - margin : window.innerHeight - 2 * margin;
      menu.style.width = `${rect.width}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(260, availableHeight))}px`;
      menu.hidden = false;
      // Keep the value and action controls clickable while the list is open.
      const top = beside === null ? rect.top - gap - menu.offsetHeight
        : Math.max(margin, Math.min(rect.top, window.innerHeight - margin - menu.offsetHeight));
      menu.style.left = `${(beside ?? rect.left) - rect.left}px`;
      menu.style.top = `${top - rect.top}px`;
      operator.setAttribute('aria-expanded', 'true');
      menu.focus({ preventScroll: true });
      highlightOperator();
    };
    const chooseOperator = (value) => {
      operator.value = value;
      operatorText.textContent = FILTER_OPERATORS.find(([id]) => id === value)[1];
      valueLabel.hidden = unaryFilter(value);
      closeOperators(true);
      positionPanel();
    };
    operator.addEventListener('click', () => menu.hidden ? openOperators() : closeOperators(true));
    operator.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openOperators();
      }
    });
    menu.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'];
      if (keys.includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const index = FILTER_OPERATORS.findIndex(([value]) => value === activeOperator);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? FILTER_OPERATORS.length - 1
          : Math.max(0, Math.min(FILTER_OPERATORS.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        activeOperator = FILTER_OPERATORS[next][0];
        highlightOperator();
      } else if (event.key === 'Enter' || event.key === ' ') chooseOperator(activeOperator);
      else if (event.key === 'Escape' || event.key === 'Tab') closeOperators(true);
    });
    menu.addEventListener('pointermove', (event) => {
      const row = event.target.closest('[role="option"]');
      if (row && row.dataset.value !== activeOperator) {
        activeOperator = row.dataset.value;
        highlightOperator();
      }
    });
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
      const row = event.target.closest('[role="option"]');
      if (row) chooseOperator(row.dataset.value);
    });
    panel.addEventListener('pointerdown', (event) => {
      if (!operatorPicker.contains(event.target)) closeOperators();
    });
    panel.addEventListener('focusin', (event) => {
      if (!operatorPicker.contains(event.target)) closeOperators();
    });
    valueLabel.hidden = unaryFilter(operator.value);
    const actions = element('div', 'db-grid-filter-actions');
    const clear = element('button', 'quiet-btn', '清除此列');
    clear.type = 'button';
    const cancel = element('button', 'quiet-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.closeFilter(true));
    const apply = element('button', 'primary-btn', '应用筛选');
    apply.type = 'submit';
    const commit = (filter) => {
      this.filters = this.filters.filter((item) => item.column !== column);
      if (filter) this.filters.push(filter);
      this.applyFilters();
      this.header.querySelector(`[data-filter-column="${column}"]`)?.focus({ preventScroll: true });
    };
    clear.addEventListener('click', () => commit(null));
    panel.addEventListener('submit', (event) => { event.preventDefault(); commit({ column, operator: operator.value, value: input.value }); });
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const nodes = [...panel.querySelectorAll('input, select, button')].filter((node) => node.getClientRects().length);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    });
    actions.append(clear, cancel, apply);
    panel.append(heading, note, operatorField, valueLabel, actions);
    document.body.append(panel);
    this.filterPanel = panel;
    trigger.setAttribute('aria-expanded', 'true');
    positionPanel();
    (valueLabel.hidden ? operator : input).focus();
  }

  setColumnWidth(index, width) {
    this.closeCellMenu(false);
    const nextWidth = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
    // Keep the original handle alive after a click so a second click can
    // produce dblclick, and avoid rebuilding the grid at a resize boundary.
    if (this.widths[index] === nextWidth) return;
    this.widths[index] = nextWidth;
    this.measureColumns();
    this.invalidate();
    this.render();
  }

  fitColumn(index) {
    let length = columnName(this.columns[index]).length + 5;
    for (const rowIndex of this.visibleOrder.slice(0, 200)) {
      length = Math.max(length, displayCells(formatCellValue(this.rows[rowIndex]?.[index]), 110));
    }
    this.setColumnWidth(index, length * 7 + 28);
    this.header.querySelector(`[data-resize-column="${index}"]`)?.focus({ preventScroll: true });
    this.announce(`已自动调整 ${columnName(this.columns[index])} 列宽`);
  }

  startResize(event) {
    const handle = event.target.closest('[data-resize-column]');
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    const index = Number(handle.dataset.resizeColumn);
    const startX = event.clientX;
    const startWidth = this.widths[index];
    this.resizeAbort?.abort();
    this.resizeAbort = new AbortController();
    const options = { signal: this.resizeAbort.signal };
    this.viewport.classList.add('db-grid-is-resizing');
    let latestX = startX;
    let frame = 0;
    const apply = () => { frame = 0; this.setColumnWidth(index, startWidth + latestX - startX); };
    window.addEventListener('pointermove', (move) => {
      latestX = move.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    }, options);
    const end = () => {
      cancelAnimationFrame(frame);
      apply();
      this.viewport.classList.remove('db-grid-is-resizing');
      this.resizeAbort.abort();
    };
    window.addEventListener('pointerup', end, { ...options, once: true });
    window.addEventListener('pointercancel', end, { ...options, once: true });
    window.addEventListener('blur', end, { ...options, once: true });
  }
}
