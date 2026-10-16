import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCellValues, formatCellValue, normalizeGridViewState, visibleRowRange } from '../src/result-grid.js';

test('PostgreSQL bigint and numeric sort without precision loss', () => {
  const values = ['9007199254740993', '9007199254740992', '9007199254740994'];
  assert.deepEqual(values.sort(compareCellValues), ['9007199254740992', '9007199254740993', '9007199254740994']);
  assert.ok(compareCellValues('9999999999999999999999999.9999999999999999999991', '9999999999999999999999999.9999999999999999999992') < 0);
  assert.ok(compareCellValues('-100000000000000000000000001', '-100000000000000000000000000') < 0);
  assert.equal(compareCellValues('1.0', '1'), 0);
  assert.equal(compareCellValues('-0.000', '0'), 0);
  assert.equal(compareCellValues('.0012', '1.20e-3'), 0);
  assert.ok(compareCellValues('1e100000000000000000', '1e99999999999999999') > 0);
  assert.ok(compareCellValues('0.0000000000000000000000001', '0.0000000000000000000000002') < 0);
});

test('NULL and empty strings retain distinct display and ordering', () => {
  assert.equal(formatCellValue(null), 'NULL');
  assert.equal(formatCellValue(''), '');
  assert.equal(formatCellValue(false), 'false');
  assert.equal(formatCellValue({ name: '<unsafe>' }), '{"name":"<unsafe>"}');
  assert.ok(compareCellValues(null, '') > 0);
  assert.equal(compareCellValues(null, undefined), 0);
});

test('virtual window stays bounded and covers first, middle and last rows', () => {
  const totalRows = 100000;
  for (const scroll of [0, 32 * 1000 + 11, 32 * totalRows - 640]) {
    const range = visibleRowRange(scroll, 640, totalRows);
    assert.ok(range.start >= 0);
    assert.ok(range.end <= totalRows);
    assert.ok(range.end - range.start <= 33);
    assert.ok(range.start <= Math.floor(scroll / 32));
    assert.ok(range.end > Math.floor(scroll / 32));
  }
  assert.deepEqual(visibleRowRange(0, 640, 0), { start: 0, end: 0 });
});

test('result grid view state keeps valid sort, selection, and scroll data', () => {
  const state = normalizeGridViewState({
    scrollTop: 640,
    scrollLeft: 120,
    order: [2, 0, 1],
    selected: [2, 2, 9, -1, 0],
    sort: { column: 1, direction: -1 },
    activeCell: { position: 2, column: 1 },
    widths: [120, 240],
  }, 3, 2);
  assert.deepEqual(state.order, [2, 0, 1]);
  assert.deepEqual(state.selected, [2, 0]);
  assert.deepEqual(state.sort, { column: 1, direction: -1 });
  assert.deepEqual(state.activeCell, { position: 2, column: 1 });
  assert.deepEqual(state.widths, [120, 240]);
  assert.equal(state.scrollTop, 640);
});

test('invalid persisted grid order is ignored instead of corrupting rows', () => {
  const state = normalizeGridViewState({ order: [0, 0, 4], selected: [1], sort: { column: 8, direction: 1 } }, 3, 2);
  assert.equal(state.order, null);
  assert.deepEqual(state.selected, [1]);
  assert.equal(state.sort, null);
});

test('large result view state keeps scroll and selection within loaded bounds', () => {
  const rowCount = 100000;
  const state = normalizeGridViewState({
    scrollTop: 32 * (rowCount - 1),
    scrollLeft: 640,
    selected: [0, rowCount - 1, rowCount, -1],
    activeCell: { position: rowCount - 1, column: 3 },
    widths: [120, 160, 200, 240],
  }, rowCount, 4);
  assert.equal(state.scrollTop, 32 * (rowCount - 1));
  assert.equal(state.scrollLeft, 640);
  assert.deepEqual(state.selected, [0, rowCount - 1]);
  assert.deepEqual(state.activeCell, { position: rowCount - 1, column: 3 });
  assert.deepEqual(state.widths, [120, 160, 200, 240]);
});

test('column filters distinguish NULL, empty strings and literal NULL', async () => {
  const { matchesColumnFilter: matches } = await import('../src/result-grid.js');
  assert.equal(matches(null, { operator: 'isNull' }), true);
  assert.equal(matches('NULL', { operator: 'isNull' }), false);
  assert.equal(matches('', { operator: 'empty' }), true);
  assert.equal(matches(null, { operator: 'empty' }), false);
  assert.equal(matches(null, { operator: 'notContains', value: 'x' }), false);
  assert.equal(matches('AbC', { operator: 'contains', value: 'bc' }), true);
  assert.equal(matches('9007199254740993', { operator: 'gt', value: '9007199254740992' }), true);
});

test('multiple column filters combine with text search and preserve row identity and sort order', async () => {
  const { filterRowOrder, normalizeColumnFilters } = await import('../src/result-grid.js');
  const rows = [['1','Alpha'],['2','Beta'],['3','Alpha'],['4',null]];
  const filters = [{ column: 0, operator: 'gt', value: '1' }, { column: 1, operator: 'contains', value: 'alpha' }];
  assert.deepEqual(filterRowOrder(rows, [3,2,1,0], filters), [2]);
  assert.deepEqual(filterRowOrder(rows, [3,2,1,0], filters, 'Beta'), []);
  assert.deepEqual(filterRowOrder(rows, [3,2,1,0], [], 'Alpha'), [2,0]);
  assert.deepEqual(normalizeColumnFilters([...filters, { column: 10, operator: 'contains' }, { column: 0, operator: 'invalid' }], 2), filters);
});

test('persisted column selections keep valid unique columns only', () => {
  const state = normalizeGridViewState({ selectedColumns: [1, 1, -1, 0, 3, 0.5, '2'] }, 10, 3);
  assert.deepEqual(state.selectedColumns, [1, 0]);
  assert.deepEqual(normalizeGridViewState({}, 0, 0).selectedColumns, []);
});
