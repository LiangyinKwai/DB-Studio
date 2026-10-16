import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultGrid, formatClipboardRows, selectRowRange } from '../src/result-grid.js';

function gridState() {
  const grid = Object.create(ResultGrid.prototype);
  Object.assign(grid, {
    columns: ['id', 'name'], rows: [[3, 'Gamma'], [1, 'Alpha'], [2, 'Beta'], [null, 'Null']],
    order: [0, 1, 2, 3], visibleOrder: [0, 1, 2, 3], selected: new Set(),
    filters: [], textFilter: '', activeCell: null, sort: null, selectionAnchor: null,
    viewport: { scrollTop: 0, clientHeight: 356, focus() {} },
    header: { querySelector() { return null; } },
    invalidate() {}, render() {}, updateFooter() {}, updateSelectionDisplay() {},
    focusActiveCell() {}, announce(message) { this.announcement = message; },
    columnRange() { return { start: 0 }; },
  });
  return grid;
}

function keyEvent(grid, key, overrides = {}) {
  return {
    key, target: { closest() { return null; }, matches() { return false; } },
    preventDefault() { this.prevented = true; }, ...overrides,
  };
}

test('spreadsheet copying quotes tabs, newlines and quotes without losing values', () => {
  assert.equal(formatClipboardRows([{ name: 'id' }, 'note'], [
    ['9007199254740993', 'first\nsecond'], [null, 'a\tb'], [0, 'say "hello"'],
  ]), 'id\tnote\n9007199254740993\t"first\nsecond"\n\t"a\tb"\n0\t"say ""hello"""');
});

test('range selection follows visible sorted order and supports deselection', () => {
  const order = [4, 1, 8, 2];
  const original = new Set([2]);
  const selected = selectRowRange(order, original, 4, 8, true);
  assert.deepEqual([...selected], [2, 4, 1, 8]);
  assert.deepEqual([...original], [2]);
  assert.deepEqual([...selectRowRange(order, selected, 8, 4, false)], [2]);
  assert.deepEqual([...selectRowRange(order, new Set(), 99, 8, true)], [8]);
});

test('sort cycles through ascending, descending and original server order with NULL last', () => {
  const grid = gridState();
  grid.selected.add(2);
  grid.sortColumn(0);
  assert.deepEqual(grid.visibleOrder, [1, 2, 0, 3]);
  grid.sortColumn(0);
  assert.deepEqual(grid.visibleOrder, [0, 2, 1, 3]);
  grid.sortColumn(0);
  assert.deepEqual(grid.visibleOrder, [0, 1, 2, 3]);
  assert.equal(grid.sort, null);
  assert.deepEqual([...grid.selected], [2]);
});

test('keyboard entry starts at first visible cell instead of skipping a row', () => {
  const grid = gridState();
  grid.viewport.closest = () => null;
  const event = keyEvent(grid, 'ArrowDown', { target: grid.viewport });
  grid.handleKeydown(event);
  assert.deepEqual(grid.activeCell, { position: 0, column: 0 });
  grid.handleKeydown(event);
  assert.deepEqual(grid.activeCell, { position: 1, column: 0 });
  assert.equal(event.prevented, true);
});

test('keyboard selection selects only filtered rows and Escape clears it', () => {
  const grid = gridState();
  grid.visibleOrder = [1, 3];
  grid.viewport.closest = () => null;
  grid.handleKeydown(keyEvent(grid, 'a', { target: grid.viewport, metaKey: true }));
  assert.deepEqual([...grid.selected], [1, 3]);
  grid.handleKeydown(keyEvent(grid, 'Escape', { target: grid.viewport }));
  assert.equal(grid.selected.size, 0);
});

test('space and Shift + space select contiguous visible rows', () => {
  const grid = gridState();
  grid.visibleOrder = [2, 0, 3];
  const cell = { dataset: { position: '0' }, closest() { return null; } };
  cell.closest = (selector) => selector === '[data-grid-cell]' ? cell : null;
  grid.handleKeydown(keyEvent(grid, ' ', { target: cell }));
  cell.dataset.position = '2';
  grid.handleKeydown(keyEvent(grid, ' ', { target: cell, shiftKey: true }));
  assert.deepEqual([...grid.selected], [2, 0, 3]);
});

test('query execution shortcuts do not also start cell editing', () => {
  const grid = gridState();
  const cell = { matches() { return false; } };
  cell.closest = (selector) => selector === '[data-grid-cell]' ? cell : null;
  let editing = false;
  grid.startCellEdit = () => { editing = true; };
  const event = keyEvent(grid, 'Enter', { target: cell, metaKey: true });
  grid.handleKeydown(event);
  assert.equal(editing, false);
  assert.equal(event.prevented, undefined);
  grid.handleKeydown(keyEvent(grid, 'Enter', { target: cell }));
  assert.equal(editing, true);
});

test('clearing all filters synchronizes external search before recomputing results', () => {
  const grid = gridState();
  grid.filters = [{ column: 1, operator: 'contains', value: 'alpha' }];
  grid.textFilter = 'alpha';
  const calls = [];
  grid.onTextFilterChange = (value) => calls.push(['search', value]);
  grid.applyFilters = () => calls.push(['apply', grid.textFilter, grid.filters.length]);
  grid.clearAllFilters();
  assert.deepEqual(calls, [['search', ''], ['apply', '', 0]]);
});

test('clicking a resize handle retains its DOM identity for double-click autofit', () => {
  const grid = gridState();
  grid.widths = [120, 200];
  grid.measureColumns = () => assert.fail('Unchanged widths must not rebuild the header');
  grid.setColumnWidth(0, 120);
  assert.deepEqual(grid.widths, [120, 200]);
});

test('copying prioritizes selected rows and preserves explicit native text selections', () => {
  const previousWindow = globalThis.window;
  try {
    let collapsed = true;
    globalThis.window = { getSelection: () => ({ isCollapsed: collapsed }) };
    const grid = gridState();
    grid.viewport.closest = () => null;
    grid.activeCell = { position: 1, column: 1 };
    const copied = [];
    const event = { target: grid.viewport, clipboardData: { setData: (type, value) => copied.push([type, value]) }, preventDefault() {} };
    grid.handleCopy(event);
    assert.deepEqual(copied.at(-1), ['text/plain', 'Alpha']);
    grid.selected = new Set([2, 0]);
    grid.handleCopy(event);
    assert.deepEqual(copied.at(-1), ['text/plain', 'id\tname\n3\tGamma\n2\tBeta']);
    collapsed = false;
    grid.handleCopy(event);
    assert.equal(copied.length, 2);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

function selectionCell({ row = null, checked = false, disabled = false } = {}) {
  const checkbox = {
    checked, disabled, dataset: row === null ? { selectAll: '' } : { selectRow: String(row) },
    matches(selector) { return selector === (row === null ? '[data-select-all]' : '[data-select-row]'); },
    focus() { this.focused = true; },
    closest(selector) { return selector === '.db-grid-selector' ? cell : null; },
  };
  const cell = {
    querySelector() { return checkbox; },
    closest(selector) { return selector === '.db-grid-selector' ? cell : null; },
  };
  const number = { closest: selector => cell.closest(selector) };
  return { cell, number, checkbox };
}

test('selector cell padding and row number toggle once and focus the checkbox', () => {
  const grid = gridState();
  const { cell, number, checkbox } = selectionCell({ row: 2 });
  let updates = 0;
  grid.updateSelectionDisplay = () => { updates++; };
  grid.handleClick({ target: cell });
  assert.deepEqual([...grid.selected], [2]);
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.focused, true);
  assert.equal(updates, 1);
  grid.handleClick({ target: number });
  assert.equal(grid.selected.size, 0);
  assert.equal(checkbox.checked, false);
  assert.equal(updates, 2);
});

test('native checkbox click and change do not toggle twice, including Shift ranges', () => {
  const grid = gridState();
  grid.visibleOrder = [2, 0, 3];
  grid.selected.add(2);
  grid.selectionAnchor = 2;
  const { checkbox } = selectionCell({ row: 3, checked: true });
  let updates = 0;
  grid.updateSelectionDisplay = () => { updates++; };
  grid.handleClick({ target: checkbox, shiftKey: true });
  assert.equal(checkbox.checked, true);
  assert.equal(updates, 0);
  grid.handleSelection({ target: checkbox });
  assert.deepEqual([...grid.selected], [2, 0, 3]);
  assert.equal(updates, 1);
});

test('Shift clicking row numbers selects and deselects the visible sorted range', () => {
  const grid = gridState();
  grid.visibleOrder = [2, 0, 3];
  const first = selectionCell({ row: 2 });
  const last = selectionCell({ row: 3 });
  grid.handleClick({ target: first.number });
  grid.handleClick({ target: last.cell, shiftKey: true });
  assert.deepEqual([...grid.selected], [2, 0, 3]);
  assert.equal(grid.selectionAnchor, 2);
  grid.handleClick({ target: last.number, shiftKey: true });
  assert.equal(grid.selected.size, 0);
});

test('whole header cell selects filtered rows from mixed state and then clears them', () => {
  const grid = gridState();
  grid.visibleOrder = [1, 3];
  grid.selected.add(1);
  const { cell, number, checkbox } = selectionCell();
  grid.handleClick({ target: number });
  assert.deepEqual([...grid.selected], [1, 3]);
  assert.equal(checkbox.checked, true);
  grid.handleClick({ target: cell });
  assert.equal(grid.selected.size, 0);
  assert.equal(checkbox.checked, false);
  checkbox.disabled = true;
  grid.handleClick({ target: cell });
  assert.equal(grid.selected.size, 0);
  assert.equal(checkbox.checked, false);
});

test('directional sort buttons choose their direction directly and toggle only that direction off', () => {
  const grid = gridState();
  grid.selected.add(2);
  grid.sortColumn(0, -1);
  assert.deepEqual(grid.sort, { column: 0, direction: -1 });
  assert.deepEqual(grid.visibleOrder, [0, 2, 1, 3]);
  grid.sortColumn(0, 1);
  assert.deepEqual(grid.sort, { column: 0, direction: 1 });
  assert.deepEqual(grid.visibleOrder, [1, 2, 0, 3]);
  grid.sortColumn(0, 1);
  assert.equal(grid.sort, null);
  assert.deepEqual(grid.visibleOrder, [0, 1, 2, 3]);
  grid.sortColumn(0, -1);
  grid.sortColumn(0, -1);
  assert.equal(grid.sort, null);
  assert.deepEqual([...grid.selected], [2]);
});

test('column selection copies only chosen columns in visible result order and stays separate from rows', () => {
  const grid = gridState();
  grid.visibleOrder = [2, 1];
  grid.selected.add(2);
  grid.selectColumn(1);
  assert.equal(grid.selected.size, 0);
  assert.deepEqual([...grid.selectedColumns], [1]);
  assert.deepEqual(grid.getSelectedData(), { columns: ['name'], rows: [['Beta'], ['Alpha']] });
  assert.deepEqual(grid.getSelectedRows(), []);
  grid.selectColumn(0, { shiftKey: true });
  assert.deepEqual(grid.getSelectedData(), { columns: ['id', 'name'], rows: [[2, 'Beta'], [1, 'Alpha']] });
  grid.selectColumn(1, { metaKey: true });
  assert.deepEqual([...grid.selectedColumns], [0]);
  grid.sortColumn(0, -1);
  assert.deepEqual([...grid.selectedColumns], [0]);
  grid.clearColumnSelection();
  assert.equal(grid.selectedColumns.size, 0);
});

test('copy from a selected column header exports values without copying other columns', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { getSelection: () => ({ isCollapsed: true }) };
  try {
    const grid = gridState();
    grid.selectColumn(1);
    let copied;
    grid.handleCopy({ target: { closest: selector => selector === '[data-column-header]' ? {} : null }, clipboardData: { setData: (_type, value) => { copied = value; } }, preventDefault() {} });
    assert.equal(copied, 'name\nGamma\nAlpha\nBeta\nNull');
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
