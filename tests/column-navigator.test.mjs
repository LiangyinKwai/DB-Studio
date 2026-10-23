import assert from 'node:assert/strict';
import test from 'node:test';
import { filterColumnNavigationItems } from '../src/column-navigator.js';
import { ResultGrid } from '../src/result-grid.js';

test('column search retains original indices, duplicate names and source order', () => {
  const items = [
    { index: 0, name: 'id', type: 'bigint' },
    { index: 1, name: 'display_name', type: 'varchar(255)' },
    { index: 79, name: 'id', type: 'text' },
  ];
  assert.deepEqual(filterColumnNavigationItems(items, 'id').map(item => item.index), [0, 79]);
  assert.deepEqual(filterColumnNavigationItems(items, 'ID TEXT').map(item => item.index), [79]);
  assert.deepEqual(filterColumnNavigationItems(items, '８０').map(item => item.index), [79]);
  assert.deepEqual(filterColumnNavigationItems(items, 'display varchar').map(item => item.index), [1]);
  assert.deepEqual(filterColumnNavigationItems(items, 'absent'), []);
  assert.notEqual(filterColumnNavigationItems(items), items);
});

function gridState() {
  const grid = Object.create(ResultGrid.prototype);
  Object.assign(grid, {
    columns: [{ name: 'id', dataType: 'bigint' }, 'status', { name: 'id', data_type: 'text' }],
    rows: [[1, 'first', 'a'], [2, 'second', 'b']],
    order: [1, 0], visibleOrder: [1, 0],
    selected: new Set([1]), selectedColumns: new Set([0, 2]),
    filters: [{ column: 1, operator: 'contains', value: 'second' }],
    activeCell: { position: 1, column: 0 },
    offsets: [52, 252, 452], widths: [200, 200, 200],
    viewport: { scrollLeft: 0, scrollTop: 0, clientWidth: 360 },
    header: { querySelector() { return null; } },
    closeFilter() {}, closeCellMenu() {}, suspendCellEdit() { this.suspended = true; },
    invalidate() {}, render() {}, focusActiveCell(scroll) { this.focusedWithScroll = scroll; },
    announce(message) { this.announcement = message; }, updateFooter() {},
  });
  return grid;
}

test('column list exposes active, selection and filter metadata without changing source columns', () => {
  const grid = gridState();
  assert.deepEqual(grid.getColumnNavigationItems(), [
    { index: 0, name: 'id', type: 'bigint', active: true, selected: true, filtered: false },
    { index: 1, name: 'status', type: '', active: false, selected: false, filtered: true },
    { index: 2, name: 'id', type: 'text', active: false, selected: true, filtered: false },
  ]);
});

test('string result columns can use unique table metadata for type searches', () => {
  const grid = gridState();
  grid.columns = ['id', 'payload', 'status'];
  const items = grid.getColumnNavigationItems([
    { name: 'status', dataType: 'varchar(255)' },
    { name: 'id', dataType: 'bigint' },
    { name: 'payload', dataType: 'json' },
  ]);
  assert.deepEqual(items.map(item => item.type), ['bigint', 'json', 'varchar(255)']);
  assert.deepEqual(filterColumnNavigationItems(items, 'json').map(item => item.index), [1]);
});

test('duplicate result or metadata names never infer an ambiguous column type', () => {
  const grid = gridState();
  grid.columns = ['id', 'id', 'payload', { name: 'id', dataType: 'uuid' }];
  assert.deepEqual(grid.getColumnNavigationItems([
    { name: 'id', dataType: 'bigint' },
    { name: 'payload', dataType: 'json' },
    { name: 'payload', dataType: 'text' },
  ]).map(item => item.type), ['', '', '', 'uuid']);
  assert.deepEqual(grid.getColumnNavigationItems(null).map(item => item.type), ['', '', '', 'uuid']);
});

test('reveal scrolls virtual columns while preserving original row, filters and export selection', () => {
  const grid = gridState();
  const before = grid.getSelectedData();
  const filters = grid.filters;
  const order = grid.visibleOrder;
  assert.equal(grid.revealColumn(2), true);
  assert.equal(grid.viewport.scrollLeft, 292);
  assert.deepEqual(grid.activeCell, { position: 1, column: 2 });
  assert.equal(grid.suspended, true);
  assert.equal(grid.focusedWithScroll, true);
  assert.deepEqual(grid.getSelectedData(), before);
  assert.equal(grid.filters, filters);
  assert.equal(grid.visibleOrder, order);
  assert.match(grid.announcement, /第 3 列/);
  grid.revealColumn(0);
  assert.equal(grid.viewport.scrollLeft, 0);
});

test('reveal defaults to the visible row instead of scrolling a long result to its beginning', () => {
  const grid = gridState();
  grid.visibleOrder = Array.from({ length: 1000 }, (_, index) => index);
  grid.activeCell = null;
  grid.viewport.scrollTop = 3200;
  grid.revealColumn(1, { focus: false });
  assert.deepEqual(grid.activeCell, { position: 100, column: 1 });
  assert.equal(grid.viewport.scrollTop, 3200);
  assert.equal(grid.focusedWithScroll, undefined);
});

test('oversized columns align to their leading edge so their names remain visible', () => {
  const grid = gridState();
  grid.widths[2] = 800;
  grid.revealColumn(2, { focus: false });
  assert.equal(grid.viewport.scrollLeft, 400);
});

test('an active cell left outside the viewport does not pull column navigation back to an old row', () => {
  const grid = gridState();
  grid.visibleOrder = Array.from({ length: 1000 }, (_, index) => index);
  grid.activeCell = { position: 1, column: 0 };
  grid.viewport.scrollTop = 3200;
  grid.revealColumn(2, { focus: false });
  assert.deepEqual(grid.activeCell, { position: 100, column: 2 });
  assert.equal(grid.viewport.scrollTop, 3200);
});

test('empty filtered results can still reveal a column and focus its header', () => {
  const grid = gridState();
  grid.visibleOrder = [];
  let focused = false;
  grid.header.querySelector = selector => selector === '[data-select-column="2"]' ? { focus() { focused = true; } } : null;
  grid.revealColumn(2);
  assert.equal(grid.activeCell, null);
  assert.equal(focused, true);
});

test('invalid indices, destroyed grids and IME composition cannot move the grid', () => {
  const grid = gridState();
  for (const value of [-1, 3, 0.5, NaN, '1']) assert.equal(grid.revealColumn(value), false);
  grid.editorComposing = true;
  assert.equal(grid.revealColumn(1), false);
  grid.editorComposing = false;
  grid.destroyed = true;
  assert.equal(grid.revealColumn(1), false);
  assert.equal(grid.suspended, undefined);
  assert.equal(grid.viewport.scrollLeft, 0);
});
