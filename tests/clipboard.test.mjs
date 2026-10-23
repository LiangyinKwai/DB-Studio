import assert from 'node:assert/strict';
import test from 'node:test';
import { writeClipboardText } from '../src/clipboard.js';

test('async desktop DDL copies use the native bridge without browser permissions', async () => {
  const text = 'CREATE TABLE "中文表" ("note" text DEFAULT E\'line\\nvalue\');\n';
  const calls = [];
  await Promise.resolve(); // metadata read completed after the menu click
  await writeClipboardText(text, {
    invoke: async (command, args) => { calls.push({ command, args }); },
    clipboard: { writeText() { throw new Error('WebView clipboard permission expired'); } }, document: null,
  });
  assert.deepEqual(calls, [{ command: 'write_clipboard_text', args: { text } }]);
});

test('browser preview and native errors can still use the browser clipboard', async () => {
  const copied = [];
  for (const invoke of [null, async () => { throw new Error('native bridge unavailable'); }]) {
    await writeClipboardText('  text\n中文  ', { invoke, clipboard: { writeText: async text => copied.push(text) }, document: null });
  }
  assert.deepEqual(copied, ['  text\n中文  ', '  text\n中文  ']);
});

function fallbackDocument(copied = true) {
  let removed = false, restored = false;
  const parent = { append(control) { this.control = control; } };
  const previous = { isConnected: true, focus() { restored = true; } };
  const control = { style: {}, setAttribute() {}, focus() {}, select() {}, remove() { removed = true; } };
  const root = { activeElement: previous, querySelector: () => parent, body: {}, createElement: () => control, execCommand: () => copied };
  return { root, parent, get removed() { return removed; }, get restored() { return restored; } };
}

test('selection fallback stays in the open dialog and restores focus', async () => {
  const fixture = fallbackDocument();
  await writeClipboardText('DDL', { clipboard: null, document: fixture.root });
  assert.equal(fixture.parent.control.value, 'DDL');
  assert.equal(fixture.removed, true);
  assert.equal(fixture.restored, true);
});

test('a failed copy cleans up the fallback and reports the native error', async () => {
  const fixture = fallbackDocument(false);
  await assert.rejects(writeClipboardText('DDL', { invoke: async () => { throw new Error('native clipboard busy'); }, clipboard: null, document: fixture.root }), /native clipboard busy/);
  assert.equal(fixture.removed, true);
  assert.equal(fixture.restored, true);
});
