import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultGrid } from '../src/result-grid.js';

function editableGrid() {
  const grid = Object.create(ResultGrid.prototype);
  Object.assign(grid, {
    columns: ['id', 'note'], rows: [[3, 'Gamma'], [1, 'Alpha'], [2, null]],
    order: [0, 1, 2], visibleOrder: [0, 1, 2], selected: new Set(), filters: [], textFilter: '',
    editSessions: new WeakMap(), editSession: null, activeCell: null, sort: null,
    viewport: { scrollTop: 0 }, header: { querySelector() { return null; } },
    closeFilter() {}, invalidate() {}, render() {}, focusActiveCell() {},
    mountCellEditor() {}, unmountCellEditor() {}, updateCellEditor() {},
    updateFilterDisplay() {}, notifySelection() {},
    announce(message) { this.announcement = message; },
    getCellEditState(payload) { return { editable: true, allowNull: true, context: { row: this.rows[payload.rowIndex] } }; },
    async onCommitCell() { return true; },
  });
  return grid;
}
const cell = (position, columnIndex = 1) => ({ dataset: { position: String(position), columnIndex: String(columnIndex) } });

test('table save includes hidden drafts, removes only successes and keeps failures for retry', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0)); grid.editSession.draftValue = 'first';
  grid.startCellEdit(cell(1)); grid.editSession.draftValue = 'second';
  grid.visibleOrder = [1];
  let payloads;
  grid.onCommitCells = async drafts => {
    payloads = drafts;
    assert.equal(grid.startCellEdit(cell(0)), false);
    assert.equal(grid.discardCellEdit(), false);
    assert.equal(await grid.commitAllCellEdits(), false);
    return [{ saved: true }, { saved: false, error: 'conflict' }];
  };
  assert.equal(await grid.commitAllCellEdits(), false);
  assert.deepEqual(payloads.map(draft => [draft.rowIndex, draft.newValue]), [[0, 'first'], [1, 'second']]);
  assert.equal(grid.getCellEditDrafts().length, 1);
  assert.equal(grid.cellEditSession(1, 1).error, 'conflict');
  grid.onCommitCells = async () => [{ saved: true }];
  assert.equal(await grid.commitAllCellEdits(), true);
  assert.equal(grid.getCellEditDraft(), null);
});

test('table save completion and cancel only affect their captured result', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0)); grid.editSession.draftValue = 'first';
  grid.startCellEdit(cell(1)); grid.editSession.draftValue = 'second';
  const originalRows = grid.rows;
  let finish;
  grid.onCommitCells = () => new Promise(resolve => { finish = resolve; });
  const saving = grid.commitAllCellEdits();
  grid.suspendCellEdit();
  grid.rows = [[20, 'other table']]; grid.visibleOrder = [0];
  grid.startCellEdit(cell(0)); grid.editSession.draftValue = 'keep other table draft';
  const otherSession = grid.editSession;
  finish([{ saved: true }, { saved: true }]);
  assert.equal(await saving, true);
  assert.equal(grid.getCellEditDraft(originalRows), null);
  assert.equal(grid.editSession, otherSession);
  assert.equal(grid.getCellEditDraft().draftValue, 'keep other table draft');
  assert.equal(grid.discardCellEdit(), true);
  assert.equal(grid.getCellEditDraft(), null);
  assert.deepEqual(grid.rows, [[20, 'other table']]);
});

test('table save skips clean editors and preserves every draft if validation rejects the set', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0)); grid.editSession.draftValue = 'first';
  grid.startCellEdit(cell(1)); // clean current editor, dirty draft elsewhere
  grid.onCommitCells = async drafts => { assert.equal(drafts.length, 1); throw new Error('invalid JSON'); };
  assert.equal(await grid.commitAllCellEdits(), false);
  assert.equal(grid.getCellEditDraft().draftValue, 'first');
  assert.equal(grid.cellEditSession(0, 1).error, 'invalid JSON');
  assert.equal(grid.savingResults.has(grid.rows), false);
});

test('editing captures the original row through a sort and passes its context to commit', async () => {
  const grid = editableGrid();
  grid.visibleOrder = [2, 0, 1];
  grid.startCellEdit(cell(1));
  const row = grid.rows[0];
  grid.editSession.draftValue = 'Changed\nwith a second line';
  grid.sortColumn(0);
  assert.deepEqual(grid.visibleOrder, [1, 2, 0]);
  let saved;
  grid.onCommitCell = async (payload) => { saved = payload; return true; };
  assert.equal(await grid.commitCellEdit(), true);
  assert.equal(saved.rowIndex, 0);
  assert.equal(saved.columnIndex, 1);
  assert.equal(saved.value, 'Gamma');
  assert.equal(saved.newValue, 'Changed\nwith a second line');
  assert.equal(saved.context.row, row);
  assert.equal(grid.editSession, null);
  assert.deepEqual(grid.activeCell, { position: 2, column: 1 });
});

test('editing another cell retains both drafts and restores the original captured context', () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'Unsaved';
  const original = grid.editSession.payload.context;
  grid.startCellEdit(cell(1));
  assert.equal(grid.editSession.payload.rowIndex, 1);
  grid.editSession.draftValue = 'Second draft';
  assert.deepEqual(grid.getCellEditDrafts().map((draft) => draft.draftValue), ['Unsaved', 'Second draft']);
  grid.startCellEdit(cell(0));
  assert.equal(grid.editSession.payload.rowIndex, 0);
  assert.equal(grid.editSession.draftValue, 'Unsaved');
  assert.equal(grid.editSession.payload.context, original);
});

test('refreshing updated rows reapplies the current sort and filter without resetting view or selection', () => {
  const grid = editableGrid();
  grid.sortColumn(1);
  assert.deepEqual(grid.visibleOrder, [1, 0, 2]);
  grid.activeCell = { position: 1, column: 1 };
  grid.selected = new Set([0, 1]);
  grid.selectionAnchor = 0;
  grid.viewport.scrollTop = 12;
  grid.rows[0] = [3, 'Aardvark'];
  grid.refreshRows();
  assert.deepEqual(grid.visibleOrder, [0, 1, 2]);
  assert.deepEqual(grid.sort, { column: 1, direction: 1 });
  assert.deepEqual(grid.activeCell, { position: 0, column: 1 });
  assert.deepEqual([...grid.selected], [0, 1]);
  assert.equal(grid.viewport.scrollTop, 12);
  assert.equal(grid.selectionAnchor, 0);
  grid.filters = [{ column: 1, operator: 'equal', value: 'Alpha' }];
  grid.refreshRows();
  assert.deepEqual(grid.visibleOrder, [1]);
  assert.deepEqual([...grid.selected], [1]);
  assert.equal(grid.activeCell, null);
  assert.equal(grid.selectionAnchor, null);
});

test('read-only cells announce their reason without opening details', () => {
  const grid = editableGrid();
  grid.getCellEditState = () => ({ editable: false, reason: '查询结果只读' });
  let inspected;
  grid.onInspect = (payload) => { inspected = payload; };
  grid.startCellEdit(cell(1));
  assert.equal(grid.editSession, null);
  assert.equal(inspected, undefined);
  assert.equal(grid.announcement, '查询结果只读');
  grid.inspectCell(cell(1));
  assert.equal(inspected.value, 'Alpha');
  assert.equal(inspected.reason, '查询结果只读');
});

test('NULL, empty string and literal NULL remain separate save payloads', async () => {
  const grid = editableGrid();
  const writes = [];
  grid.onCommitCell = async (payload) => { writes.push([payload.newValue, payload.isNull]); return true; };
  grid.startCellEdit(cell(2));
  assert.equal(grid.editSession.draftValue, '');
  assert.equal(grid.editSession.isNull, true);
  await grid.commitCellEdit();
  grid.startCellEdit(cell(2));
  grid.editSession.isNull = false;
  await grid.commitCellEdit();
  grid.startCellEdit(cell(2));
  grid.editSession.isNull = false;
  grid.editSession.draftValue = 'NULL';
  await grid.commitCellEdit();
  assert.deepEqual(writes, [['', true], ['', false], ['NULL', false]]);
});

test('failed writes keep the draft and show an inline error for a safe retry', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'new value';
  grid.onCommitCell = async () => { throw new Error('The row changed elsewhere'); };
  assert.equal(await grid.commitCellEdit(), false);
  assert.equal(grid.editSession.draftValue, 'new value');
  assert.equal(grid.editSession.error, 'The row changed elsewhere');
  assert.equal(grid.editSession.pending, false);
  assert.equal(grid.cellEditSession(0, 1), grid.editSession);
  grid.onCommitCell = async () => false;
  assert.equal(await grid.commitCellEdit(), false);
  assert.equal(grid.editSession.draftValue, 'new value');
});

test('saving cannot submit twice or cancel the pending write', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  let finish;
  let writes = 0;
  grid.onCommitCell = () => { writes++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = grid.commitCellEdit();
  assert.equal(await grid.commitCellEdit(), false);
  grid.cancelCellEdit();
  assert.equal(grid.editSession.pending, true);
  assert.equal(writes, 1);
  finish(true);
  assert.equal(await pending, true);
  assert.equal(grid.editSession, null);
});

test('a pending save after tab switch never closes or mutates the new tab draft', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  const oldRows = grid.rows;
  let finish;
  grid.onCommitCell = () => new Promise((resolve) => { finish = resolve; });
  const pending = grid.commitCellEdit();
  // setResult changes the active session and leaves the old one keyed by its
  // own result. A completion must address the saved session only.
  grid.rows = [[10, 'Other tab']];
  grid.visibleOrder = [0];
  grid.editSession = null;
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'Keep this draft';
  const nextSession = grid.editSession;
  finish(true);
  await pending;
  assert.equal(grid.editSession, nextSession);
  assert.equal(grid.editSession.draftValue, 'Keep this draft');
  assert.equal(grid.editSessions.has(oldRows), false);
  assert.equal(grid.cellEditSession(0, 1), nextSession);
});

test('opening details transfers the complete draft, NULL flag and captured context', () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  const original = grid.editSession.payload.context;
  grid.editSession.draftValue = '{\n  "note": "新内容"\n}';
  let inspected;
  grid.onInspect = (payload) => { inspected = payload; };
  grid.inspectCell(cell(0));
  assert.equal(inspected.draftValue, '{\n  "note": "新内容"\n}');
  assert.equal(inspected.draftIsNull, false);
  assert.equal(inspected.value, 'Gamma');
  assert.equal(inspected.context, original);
  assert.equal(grid.editSession, null);
});

test('replacement guards can inspect and discard drafts from active and inactive tabs', () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'unsaved';
  const oldRows = grid.rows;
  assert.equal(grid.getCellEditDraft(oldRows).draftValue, 'unsaved');
  grid.editSession.pending = true;
  assert.equal(grid.getCellEditDraft().pending, true);
  assert.equal(grid.discardCellEdit(), false);
  grid.editSession.pending = false;
  grid.rows = [[10, 'Other tab']];
  grid.visibleOrder = [0];
  grid.editSession = null;
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'Other draft';
  assert.equal(grid.discardCellEdit(oldRows), true);
  assert.equal(grid.getCellEditDraft(oldRows), null);
  assert.equal(grid.getCellEditDraft().value, 'Other tab');
  assert.equal(grid.discardCellEdit(), true);
  assert.equal(grid.getCellEditDraft(), null);
  assert.equal(grid.editSession, null);
});

test('editor keyboard protects IME, multiline input and global query shortcuts', () => {
  const grid = editableGrid();
  grid.editorInput = {};
  grid.editorControls = { nullInput: {} };
  let saves = 0;
  let cancels = 0;
  grid.commitCellEdit = () => { saves++; };
  grid.cancelCellEdit = () => { cancels++; };
  grid.clearSelection = () => {};
  const key = (key, extra = {}) => {
    const event = { key, target: grid.editorInput, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    grid.handleEditorKeydown(event);
    assert.equal(event.stopped, true);
    return event;
  };
  assert.equal(key('Enter', { isComposing: true }).prevented, undefined);
  assert.equal(key('Enter', { keyCode: 229 }).prevented, undefined);
  assert.equal(key('Enter', { shiftKey: true }).prevented, undefined);
  assert.equal(key('Enter', { metaKey: true }).prevented, true);
  assert.equal(saves, 0);
  assert.equal(key('Enter').prevented, true);
  assert.equal(key('Enter', { target: grid.editorControls.nullInput }).prevented, true);
  assert.equal(saves, 2);
  assert.equal(key('Escape').prevented, true);
  assert.equal(cancels, 1);
});

test('F2 and Enter edit the focused cell without opening details', () => {
  const grid = editableGrid();
  const focused = cell(1);
  focused.closest = (selector) => selector === '[data-grid-cell]' ? focused : null;
  let edits = 0;
  let inspections = 0;
  grid.startCellEdit = (target) => { assert.equal(target, focused); edits++; };
  grid.inspectCell = (target) => { assert.equal(target, focused); inspections++; };
  grid.handleKeydown({ key: 'F2', target: focused, preventDefault() {} });
  grid.handleKeydown({ key: 'Enter', target: focused, preventDefault() {} });
  assert.equal(edits, 2);
  assert.equal(inspections, 0);
});

class GridNode extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force = !this.classes.has(name)) => force ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    this.selectionStart = this.selectionEnd = 0;
    this.selectionDirection = 'none';
    this.value = '';
    this.scrollTop = this.scrollLeft = 0;
    this.clientHeight = 320;
    this.clientWidth = 800;
    this.offsetWidth = 170;
    this.offsetHeight = 145;
  }
  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  get textContent() { return this._text || ''; }
  get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'FRAGMENT') { this.append(...[...child.children]); continue; }
      child.remove();
      this.children.push(child);
      child.parentNode = this;
    }
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    if (document.activeElement === this) document.activeElement = document.body;
    this.parentNode = null;
  }
  contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
  matches(selector) {
    if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => {
      const actual = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : name === 'tabindex' ? String(this.tabIndex) : this.attributes.get(name);
      return actual !== undefined && (value === undefined || actual === value);
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  select() { this.setSelectionRange(0, this.value.length); }
  setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  getBoundingClientRect() { return { left: 250, top: 90, right: 430, bottom: 122 }; }
}

function domGrid(t) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: (tag) => new GridNode(tag), createDocumentFragment: () => new GridNode('fragment'), body: new GridNode('body') };
  document.activeElement = document.body;
  globalThis.window = { innerWidth: 1000, innerHeight: 700 };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  const grid = editableGrid();
  for (const name of ['mountCellEditor', 'unmountCellEditor', 'updateCellEditor', 'render', 'invalidate', 'focusActiveCell']) delete grid[name];
  Object.assign(grid, {
    viewport: new GridNode(), body: new GridNode(), header: new GridNode(),
    widths: [112, 180], offsets: [52, 164], container: new GridNode(),
    renderHeader() {}, headerSignature: '', renderSignature: '',
    scheduleRender() { this.render(); },
  });
  grid.container.append(grid.viewport);
  grid.viewport.append(grid.header, grid.body);
  document.body.append(grid.container);
  grid.render();
  return grid;
}

function emit(node, type, details = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(details)) Object.defineProperty(event, key, { value });
  node.dispatchEvent(event);
  return event;
}

function cellNode(grid, position = 0, columnIndex = 1) {
  return grid.body.querySelector(`[data-position="${position}"][data-column-index="${columnIndex}"]`);
}

test('the editor is the only child inside the actual 32px cell, with no floating controls', async (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  const editedCell = cellNode(grid);
  assert.equal(grid.editorInput.parentNode, editedCell);
  assert.deepEqual(editedCell.children, [grid.editorInput]);
  assert.equal(editedCell.style.width, '180px');
  assert.equal(grid.editorInput.rows, 1);
  assert.equal(grid.editorInput.wrap, 'off');
  assert.equal(document.activeElement, grid.editorInput);
  assert.equal(grid.editorInput.selectionEnd, 'Gamma'.length);
  assert.equal(grid.container.querySelector('.db-grid-inline-editor'), null);
  assert.equal(grid.container.querySelector('.db-grid-cell-inspect'), null);
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/result-grid.css', import.meta.url), 'utf8');
  assert.match(css, /\.db-grid-cell > \.db-grid-edit-input\s*\{[^}]*width: 100%; height: 100%;/);
  assert.match(css, /\.db-grid-cell\s*\{[^}]*height: var\(--db-grid-row-height\)/);
  assert.doesNotMatch(css, /db-grid-inline-editor|db-grid-cell-inspect/);
});

test('virtual replacement preserves the input node, draft, focus and text selection by original row', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  const input = grid.editorInput;
  input.value = 'Keep this draft';
  emit(input, 'input');
  input.setSelectionRange(2, 7, 'backward');
  grid.visibleOrder = [1, 2, 0];
  grid.invalidate();
  grid.render();
  assert.equal(grid.editorInput, input);
  assert.equal(input.parentNode, cellNode(grid, 2));
  assert.equal(input.value, 'Keep this draft');
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, 'backward']);
  grid.visibleOrder = [1, 2];
  grid.invalidate();
  grid.render();
  assert.equal(input.parentNode, null);
  assert.equal(grid.getCellEditDraft().draftValue, 'Keep this draft');
  grid.visibleOrder = [0, 1, 2];
  grid.invalidate();
  grid.render();
  assert.equal(input.parentNode, cellNode(grid));
  assert.equal(document.activeElement, input);
});

test('blur never writes or discards the draft and a redraw never steals external focus', (t) => {
  const grid = domGrid(t);
  let writes = 0;
  grid.onCommitCell = () => { writes++; };
  grid.startCellEdit(cellNode(grid));
  const input = grid.editorInput;
  input.value = 'Unsaved';
  emit(input, 'input');
  document.body.focus();
  emit(input, 'blur');
  grid.invalidate();
  grid.render();
  assert.equal(writes, 0);
  assert.equal(grid.getCellEditDraft().draftValue, 'Unsaved');
  assert.equal(document.activeElement, document.body);
});

test('composition keeps the editor attached until completion and retains the full Chinese draft', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  const input = grid.editorInput;
  const parent = input.parentNode;
  emit(input, 'compositionstart');
  grid.visibleOrder = [1, 2, 0];
  grid.invalidate();
  grid.render();
  assert.equal(input.parentNode, parent);
  assert.equal(document.activeElement, input);
  input.value = '中文输入';
  emit(input, 'input');
  emit(input, 'compositionend');
  assert.equal(input.parentNode, cellNode(grid, 2));
  assert.equal(grid.getCellEditDraft().draftValue, '中文输入');
});

test('typing into a selected cell replaces the value, while IME initiation is not canceled', () => {
  const grid = editableGrid();
  const focused = cell(0);
  focused.closest = (selector) => selector === '[data-grid-cell]' ? focused : null;
  const calls = [];
  grid.startCellEdit = (target, options) => calls.push([target, options]);
  const event = { key: '字', target: focused, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  grid.handleKeydown(event);
  assert.deepEqual(calls[0], [focused, { replaceValue: '字' }]);
  assert.equal(event.prevented, true);
  const ime = { ...event, key: 'Process', keyCode: 229, prevented: false };
  grid.handleKeydown(ime);
  assert.deepEqual(calls[1], [focused, { replaceValue: '' }]);
  assert.equal(ime.prevented, false);
});

test('typing into NULL becomes text and clearing it remains an empty string', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid, 2));
  assert.equal(grid.editorInput.readOnly, false);
  assert.equal(grid.editorInput.placeholder, 'NULL');
  grid.editorInput.value = 'NULL';
  emit(grid.editorInput, 'input');
  assert.equal(grid.editSession.isNull, false);
  assert.equal(grid.editSession.draftValue, 'NULL');
  grid.editorInput.value = '';
  emit(grid.editorInput, 'input');
  assert.equal(grid.editSession.isNull, false);
  assert.equal(grid.editSession.draftValue, '');
});

test('Tab moves only after a successful save, preserving the cell on failure', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  const event = { key: 'Tab', preventDefault() {}, stopPropagation() {} };
  grid.onCommitCell = async () => false;
  grid.handleEditorKeydown(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(grid.activeCell, { position: 0, column: 1 });
  assert.ok(grid.editSession);
  grid.onCommitCell = async () => true;
  grid.handleEditorKeydown(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(grid.activeCell, { position: 1, column: 0 });
  assert.equal(grid.editSession, null);
});

test('the right-click menu transfers current draft and context into details', (t) => {
  const grid = domGrid(t);
  let inspected;
  grid.onInspect = (payload) => { inspected = payload; };
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Draft for details';
  emit(grid.editorInput, 'input');
  const context = grid.editSession.payload.context;
  grid.openCellMenu(cellNode(grid));
  assert.deepEqual(grid.cellMenu.children.map((item) => item.textContent), ['编辑单元格', '查看详情', '复制值', '设为 NULL']);
  emit(grid.cellMenu.querySelector('[data-cell-action="inspect"]'), 'click');
  assert.equal(grid.cellMenu, null);
  assert.equal(inspected.draftValue, 'Draft for details');
  assert.equal(inspected.context, context);
  assert.equal(grid.editSession, null);
});

test('context menu NULL stays a draft until save and read-only actions explain their disabled state', (t) => {
  const grid = domGrid(t);
  let writes = 0;
  grid.onCommitCell = () => { writes++; };
  grid.onInspect = () => {};
  grid.openCellMenu(cellNode(grid));
  emit(grid.cellMenu.querySelector('[data-cell-action="null"]'), 'click');
  assert.equal(grid.editSession.isNull, true);
  assert.equal(grid.editorInput.value, '');
  assert.equal(writes, 0);
  grid.cancelCellEdit();
  grid.getCellEditState = () => ({ editable: false, allowNull: false, reason: '没有唯一键，无法安全编辑' });
  grid.openCellMenu(cellNode(grid));
  assert.equal(grid.cellMenu.querySelector('[data-cell-action="edit"]').disabled, true);
  assert.match(grid.cellMenu.querySelector('[data-cell-action="edit"]').title, /没有唯一键/);
  assert.equal(grid.cellMenu.querySelector('[data-cell-action="null"]').disabled, true);
  assert.equal(grid.cellMenu.querySelector('[data-cell-action="inspect"]').disabled, false);
});

test('Shift F10 and the context-menu key expose the same cell operations', () => {
  const grid = editableGrid();
  const focused = cell(1);
  focused.closest = (selector) => selector === '[data-grid-cell]' ? focused : null;
  const menus = [];
  grid.openCellMenu = (target) => menus.push(target);
  grid.handleKeydown({ key: 'F10', shiftKey: true, target: focused, preventDefault() {}, stopPropagation() {} });
  grid.handleKeydown({ key: 'ContextMenu', target: focused, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(menus, [focused, focused]);
});

test('clicking another cell releases an untouched editor and selects only the new real cell', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  const previousInput = grid.editorInput;
  const target = cellNode(grid, 1);
  grid.handleClick({ target });
  assert.equal(grid.editSession, null);
  assert.equal(previousInput.parentNode, null);
  assert.equal(grid.getCellEditDraft(), null);
  assert.equal(grid.getCellEditDrafts().length, 0);
  assert.deepEqual(grid.activeCell, { position: 1, column: 1 });
  assert.equal(document.activeElement, target);
  assert.equal(cellNode(grid).classList.contains('db-grid-cell-editing'), false);
  assert.equal(cellNode(grid).classList.contains('db-grid-cell-active'), false);
  assert.equal(target.classList.contains('db-grid-cell-active'), true);
  // The first click must not replace the target node, or the browser will not
  // dispatch a double click to the same target.
  assert.equal(cellNode(grid, 1), target);
  assert.equal(grid.startCellEdit(target), true);
  assert.equal(grid.editorInput.parentNode, target);
});

test('clicking freely between dirty cells preserves each draft without writing on blur', (t) => {
  const grid = domGrid(t);
  let writes = 0;
  grid.onCommitCell = async () => { writes++; return true; };
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'First draft';
  emit(grid.editorInput, 'input');
  grid.handleClick({ target: cellNode(grid, 1) });
  assert.equal(grid.editorInput, null);
  assert.equal(cellNode(grid).textContent, 'First draft');
  assert.equal(cellNode(grid).classList.contains('db-grid-cell-draft'), true);
  assert.equal(cellNode(grid).classList.contains('db-grid-cell-editing'), false);
  grid.startCellEdit(cellNode(grid, 1));
  grid.editorInput.value = 'Second draft';
  emit(grid.editorInput, 'input');
  grid.handleClick({ target: cellNode(grid) });
  assert.equal(grid.editorInput.value, 'First draft');
  assert.equal(cellNode(grid, 1).textContent, 'Second draft');
  assert.equal(cellNode(grid, 1).classList.contains('db-grid-cell-draft'), true);
  assert.deepEqual(grid.getCellEditDrafts().map((draft) => draft.draftValue), ['First draft', 'Second draft']);
  assert.equal(writes, 0);
});

test('saving a cell after selecting another preserves the new selection and pending sibling drafts', async (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Save this';
  emit(grid.editorInput, 'input');
  let finish;
  grid.onCommitCell = () => new Promise((resolve) => { finish = resolve; });
  const pending = grid.commitCellEdit();
  grid.handleClick({ target: cellNode(grid, 1) });
  assert.equal(grid.editSession, null);
  assert.deepEqual(grid.activeCell, { position: 1, column: 1 });
  finish(true);
  await pending;
  assert.deepEqual(grid.activeCell, { position: 1, column: 1 });
  assert.equal(document.activeElement, cellNode(grid, 1));
  assert.equal(grid.getCellEditDraft(), null);
});

test('an asynchronous Tab save cannot move focus after the user selects a different cell', async (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  let finish;
  grid.onCommitCell = () => new Promise((resolve) => { finish = resolve; });
  grid.handleEditorKeydown({ key: 'Tab', preventDefault() {}, stopPropagation() {} });
  grid.handleClick({ target: cellNode(grid, 2) });
  finish(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(grid.activeCell, { position: 2, column: 1 });
  assert.equal(document.activeElement, cellNode(grid, 2));
});

test('saving or canceling one cell never deletes another cell draft', async () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'First draft';
  grid.startCellEdit(cell(1));
  grid.editSession.draftValue = 'Second draft';
  await grid.commitCellEdit();
  assert.deepEqual(grid.getCellEditDrafts().map((draft) => draft.draftValue), ['First draft']);
  grid.startCellEdit(cell(2));
  grid.editSession.draftValue = 'Third draft';
  grid.editSession.isNull = false;
  grid.cancelCellEdit();
  assert.deepEqual(grid.getCellEditDrafts().map((draft) => draft.draftValue), ['First draft']);
});

test('replacement guard prioritizes an inactive pending save and discards all drafts atomically', () => {
  const grid = editableGrid();
  grid.startCellEdit(cell(0));
  grid.editSession.draftValue = 'First draft';
  grid.startCellEdit(cell(1));
  grid.editSession.pending = true;
  grid.startCellEdit(cell(2));
  grid.editSession.draftValue = 'Third draft';
  grid.editSession.isNull = false;
  assert.equal(grid.getCellEditDraft().rowIndex, 1);
  assert.equal(grid.getCellEditDraft().pending, true);
  assert.equal(grid.discardCellEdit(), false);
  assert.equal(grid.getCellEditDrafts().length, 3);
  grid.cellEditSession(1, 1).pending = false;
  assert.equal(grid.discardCellEdit(), true);
  assert.equal(grid.getCellEditDrafts().length, 0);
  assert.equal(grid.editSession, null);
});

test('right click operations on a different cell remain available while another has a draft', (t) => {
  const grid = domGrid(t);
  grid.onInspect = () => {};
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Keep this draft';
  emit(grid.editorInput, 'input');
  grid.openCellMenu(cellNode(grid, 1));
  assert.equal(grid.cellMenu.querySelector('[data-cell-action="edit"]').disabled, false);
  assert.equal(grid.cellMenu.querySelector('[data-cell-action="inspect"]').disabled, false);
  emit(grid.cellMenu.querySelector('[data-cell-action="edit"]'), 'click');
  assert.equal(grid.editSession.payload.rowIndex, 1);
  assert.equal(grid.getCellEditDraft().draftValue, 'Keep this draft');
});

test('empty grid space and out-of-bounds coordinates cannot manufacture a selected cell', (t) => {
  const grid = domGrid(t);
  grid.handleClick({ target: grid.viewport });
  grid.handleClick({ target: grid.body });
  assert.equal(grid.activeCell, null);
  for (const target of [cell(-1), cell(3), cell(0, -1), cell(0, 2), cell(0.5), cell(0, 0.5)]) {
    assert.equal(grid.startCellEdit(target), false);
    assert.equal(grid.selectCell(target), false);
  }
  grid.handleClick({ target: cellNode(grid, 1) });
  grid.handleClick({ target: grid.body });
  assert.deepEqual(grid.activeCell, { position: 1, column: 1 });
  assert.equal(grid.body.querySelectorAll('.db-grid-cell-active').length, 1);
});

test('selecting a real cell clears a hidden inspector selection so copying uses the cell value', (t) => {
  const grid = domGrid(t);
  const nativeSelection = { isCollapsed: false, removeAllRanges() { this.isCollapsed = true; } };
  window.getSelection = () => nativeSelection;
  grid.handleClick({ target: grid.body });
  assert.equal(nativeSelection.isCollapsed, false);
  grid.handleClick({ target: cellNode(grid, 1) });
  assert.equal(nativeSelection.isCollapsed, true);
  let copied;
  const event = { target: cellNode(grid, 1), clipboardData: { setData(type, value) { copied = [type, value]; } }, preventDefault() {} };
  grid.handleCopy(event);
  assert.deepEqual(copied, ['text/plain', 'Alpha']);
});

test('reselecting the focused editor preserves its native text selection', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.setSelectionRange(1, 3);
  let clears = 0;
  window.getSelection = () => ({ isCollapsed: false, removeAllRanges() { clears++; } });
  grid.selectCell(cellNode(grid));
  assert.equal(clears, 0);
  assert.deepEqual([grid.editorInput.selectionStart, grid.editorInput.selectionEnd], [1, 3]);
  grid.handleCopy({ target: grid.editorInput, clipboardData: { setData() { assert.fail('Native editor copy must remain untouched'); } } });
});

test('paired sort buttons are independent, expose direction state and leave the column label inert', (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  grid.renderHeader({ start: 0, end: 2 });
  let group = grid.header.querySelector('.db-grid-sort-control');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.children.length, 2);
  const down = group.querySelector('[data-sort-direction="-1"]');
  assert.equal(down.getAttribute('aria-label'), 'id，降序');
  grid.handleClick({ target: down });
  assert.deepEqual(grid.sort, { column: 0, direction: -1 });
  group = grid.header.querySelector('.db-grid-sort-control');
  assert.equal(group.querySelector('[data-sort-direction="-1"]').getAttribute('aria-pressed'), 'true');
  assert.equal(group.querySelector('[data-sort-direction="1"]').getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement, group.querySelector('[data-sort-direction="-1"]'));
  grid.handleClick({ target: grid.header.querySelector('.db-grid-column-name') });
  assert.deepEqual(grid.sort, { column: 0, direction: -1 });
  grid.handleClick({ target: group });
  assert.deepEqual(grid.sort, { column: 0, direction: -1 });
  grid.handleClick({ target: group.querySelector('[data-sort-direction="-1"]') });
  assert.equal(grid.sort, null);
});

test('entering cell editing leaves a visible insertion caret rather than selecting the whole value', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  assert.equal(document.activeElement, grid.editorInput);
  assert.equal(grid.editorInput.selectionStart, 'Gamma'.length);
  assert.equal(grid.editorInput.selectionEnd, 'Gamma'.length);
  assert.equal(grid.editorInput.readOnly, false);
});

test('returning to a changed cell restores its insertion point instead of selecting or jumping', (t) => {
  const grid = domGrid(t);
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Keep this draft';
  emit(grid.editorInput, 'input');
  grid.editorInput.setSelectionRange(4, 4);
  grid.selectCell(cellNode(grid, 1));
  grid.selectCell(cellNode(grid, 0));
  assert.equal(document.activeElement, grid.editorInput);
  assert.equal(grid.editorInput.value, 'Keep this draft');
  assert.deepEqual([grid.editorInput.selectionStart, grid.editorInput.selectionEnd], [4, 4]);
});

test('column labels select columns without sorting, keep edit drafts, and data cell clicks clear column selection', (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  grid.renderHeader({ start: 0, end: 2 });
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Keep this cell draft';
  emit(grid.editorInput, 'input');
  const label = grid.header.querySelector('[data-select-column="1"]');
  grid.handleClick({ target: label });
  assert.equal(grid.sort, null);
  assert.equal(grid.editSession, null);
  assert.equal(grid.getCellEditDraft().draftValue, 'Keep this cell draft');
  assert.equal(label.getAttribute('aria-pressed'), 'true');
  assert.equal(cellNode(grid).classList.contains('db-grid-cell-column-selected'), true);
  grid.handleClick({ target: cellNode(grid, 1) });
  assert.equal(grid.selectedColumns.size, 0);
  assert.deepEqual(grid.activeCell, { position: 1, column: 1 });
});

test('clicking the sole selected column again clears selection and focus like Escape, then allows reselection', (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  delete grid.notifySelection;
  grid.renderHeader({ start: 0, end: 2 });
  let selection;
  grid.onSelectionChange = (value) => { selection = value; };
  grid.startCellEdit(cellNode(grid));
  grid.editorInput.value = 'Keep this draft after deselection';
  emit(grid.editorInput, 'input');
  const label = grid.header.querySelector('[data-select-column="1"]');
  const header = label.closest('[data-column-header]');
  grid.handleClick({ target: label });
  assert.equal(label.getAttribute('aria-pressed'), 'true');
  assert.equal(selection.selectedColumnCount, 1);
  assert.equal(document.activeElement, label);

  grid.handleClick({ target: label });
  assert.equal(grid.selectedColumns.size, 0);
  assert.equal(grid.selected.size, 0);
  assert.equal(grid.activeCell, null);
  assert.equal(grid.columnSelectionAnchor, null);
  assert.equal(grid.selectionAnchor, null);
  assert.equal(header.dataset.columnSelected, 'false');
  assert.equal(header.getAttribute('aria-selected'), 'false');
  assert.equal(label.getAttribute('aria-pressed'), 'false');
  assert.equal(grid.body.querySelectorAll('.db-grid-cell-column-selected').length, 0);
  assert.equal(grid.body.querySelectorAll('.db-grid-cell-active').length, 0);
  assert.deepEqual(selection, { selectedCount: 0, selectedColumnCount: 0, totalCount: 3 });
  assert.equal(document.activeElement, document.body);
  assert.equal(grid.getCellEditDraft().draftValue, 'Keep this draft after deselection');

  grid.handleClick({ target: label });
  assert.deepEqual([...grid.selectedColumns], [1]);
  assert.equal(label.getAttribute('aria-pressed'), 'true');
  assert.equal(selection.selectedColumnCount, 1);
  assert.equal(document.activeElement, label);
});

test('column click cancellation preserves modifier selection, keyboard navigation and explicit menu selection', (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  grid.renderHeader({ start: 0, end: 2 });
  const first = grid.header.querySelector('[data-select-column="0"]');
  const second = grid.header.querySelector('[data-select-column="1"]');
  grid.handleClick({ target: first });
  grid.handleClick({ target: first, shiftKey: true });
  assert.deepEqual([...grid.selectedColumns], [0]);
  grid.handleClick({ target: second, shiftKey: true });
  assert.deepEqual([...grid.selectedColumns], [0, 1]);
  grid.handleClick({ target: second });
  assert.deepEqual([...grid.selectedColumns], [1]);
  grid.handleClick({ target: first, metaKey: true });
  assert.deepEqual([...grid.selectedColumns], [1, 0]);
  grid.handleClick({ target: first, metaKey: true });
  assert.deepEqual([...grid.selectedColumns], [1]);
  grid.handleClick({ target: second, ctrlKey: true });
  assert.equal(grid.selectedColumns.size, 0);
  grid.handleClick({ target: second, ctrlKey: true });
  assert.deepEqual([...grid.selectedColumns], [1]);

  grid.handleKeydown({ key: 'End', target: second, preventDefault() {} });
  assert.deepEqual([...grid.selectedColumns], [1]);
  grid.openColumnMenu(second.closest('[data-column-header]'));
  emit(grid.cellMenu.querySelector('[data-column-action="select"]'), 'click');
  assert.deepEqual([...grid.selectedColumns], [1]);
  assert.equal(second.getAttribute('aria-pressed'), 'true');
});

test('pointer sorting does not reintroduce a focus rectangle while keyboard sorting retains focus', (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  grid.renderHeader({ start: 0, end: 2 });
  const down = grid.header.querySelector('[data-sort-column="0"][data-sort-direction="-1"]');
  down.focus();
  grid.handleClick({ target: down, detail: 1 });
  assert.equal(down.isConnected, false);
  assert.notEqual(document.activeElement, grid.header.querySelector('[data-sort-column="0"][data-sort-direction="-1"]'));
  const up = grid.header.querySelector('[data-sort-column="0"][data-sort-direction="1"]');
  grid.handleClick({ target: up, detail: 0 });
  assert.equal(document.activeElement, grid.header.querySelector('[data-sort-column="0"][data-sort-direction="1"]'));
});

test('Escape clears row, column and cell selections and releases the visible focus ring', (t) => {
  const grid = domGrid(t);
  grid.selected.add(0);
  grid.selectCell(cellNode(grid, 1));
  grid.handleKeydown({ key: 'Escape', target: cellNode(grid, 1), preventDefault() {}, stopPropagation() {} });
  assert.equal(grid.selected.size, 0);
  assert.equal(grid.activeCell, null);
  assert.equal(grid.body.querySelectorAll('.db-grid-cell-active').length, 0);
  assert.equal(document.activeElement, document.body);
});

test('column menu copies the exact column name and only visible column data', async (t) => {
  const grid = domGrid(t);
  delete grid.renderHeader;
  grid.renderHeader({ start: 0, end: 2 });
  grid.visibleOrder = [1, 0];
  const copied = [];
  grid.onCopyCell = async text => copied.push(text);
  const header = grid.header.querySelector('[data-column-header="1"]');
  grid.openColumnMenu(header);
  emit(grid.cellMenu.querySelector('[data-column-action="copy-name"]'), 'click');
  await Promise.resolve();
  assert.equal(copied.at(-1), 'note');
  grid.openColumnMenu(header);
  emit(grid.cellMenu.querySelector('[data-column-action="copy-data"]'), 'click');
  await Promise.resolve();
  assert.equal(copied.at(-1), 'Alpha\nGamma');
  grid.openColumnMenu(header);
  grid.rows = [[999, 'another result']];
  emit(grid.cellMenu.querySelector('[data-column-action="copy-data"]'), 'click');
  assert.equal(copied.length, 2);
});
