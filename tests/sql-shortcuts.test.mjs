import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, EditorSelection } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { keymap, runScopeHandlers } from '@codemirror/view';
import { createSqlExecutionKeymap } from '../src/sql-shortcuts.js';

const mac = /Mac/.test(globalThis.navigator?.platform ?? '');
const modEnter = () => ({
  key: 'Enter', code: 'Enter', keyCode: 13,
  metaKey: mac, ctrlKey: !mac, altKey: false, shiftKey: false,
  stopPropagation() { this.propagationStopped = true; },
});

function editorStateWith(bindings) {
  const sql = 'SELECT * FROM customers;\nDELETE FROM customers;';
  return EditorState.create({
    doc: sql,
    selection: EditorSelection.single(0, sql.indexOf('\n')),
    extensions: [keymap.of(bindings)],
  });
}

function simulatedView(state) {
  const view = { state };
  view.dispatch = (transaction) => { view.state = transaction.state; };
  return view;
}

test('execution binding preserves selected SQL ahead of default Mod-Enter behavior', () => {
  let calls = 0;
  let submitted;
  const view = simulatedView(editorStateWith([
    ...createSqlExecutionKeymap(() => {
      calls++;
      submitted = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    }),
    ...defaultKeymap,
  ]));
  const before = view.state;
  const event = modEnter();
  assert.equal(runScopeHandlers(view, event, 'editor'), true);
  assert.equal(calls, 1);
  assert.equal(submitted, 'SELECT * FROM customers;');
  assert.equal(view.state, before);
  assert.equal(event.propagationStopped, true);
});

test('default Mod-Enter mutates the SQL selection without the application override', () => {
  const view = simulatedView(editorStateWith(defaultKeymap));
  const before = view.state;
  assert.equal(runScopeHandlers(view, modEnter(), 'editor'), true);
  assert.notEqual(view.state.doc.toString(), before.doc.toString());
  assert.equal(view.state.selection.main.empty, true);
});

test('async submission is consumed immediately and cannot fall through to another handler', async () => {
  let resolveQuery;
  let calls = 0;
  let fallbackCalls = 0;
  const pending = new Promise(resolve => { resolveQuery = resolve; });
  const bindings = createSqlExecutionKeymap(() => { calls++; return pending; });
  const view = simulatedView(editorStateWith([
    ...bindings,
    { key: 'Mod-Enter', run: () => { fallbackCalls++; return true; } },
    ...defaultKeymap,
  ]));
  const event = modEnter();
  assert.equal(runScopeHandlers(view, event, 'editor'), true);
  assert.equal(calls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(event.propagationStopped, true);
  assert.equal(bindings[0].preventDefault, true);
  resolveQuery();
  await pending;
  assert.equal(calls, 1);
});

test('execution override leaves ordinary Enter to the editor', () => {
  let calls = 0;
  const view = simulatedView(editorStateWith(createSqlExecutionKeymap(() => { calls++; })));
  const event = { ...modEnter(), ctrlKey: false, metaKey: false };
  assert.equal(runScopeHandlers(view, event, 'editor'), false);
  assert.equal(calls, 0);
  assert.equal(event.propagationStopped, undefined);
});
