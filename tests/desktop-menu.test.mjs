import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTextControl, replaceTextControlSelection, isBrowserDevShortcut } from '../src/desktop-menu.js';

test('developer shortcuts are recognized without blocking normal copy/paste', () => {
  assert.equal(isBrowserDevShortcut({ key: 'F12' }), true);
  assert.equal(isBrowserDevShortcut({ key: 'i', metaKey: true, altKey: true }), true);
  assert.equal(isBrowserDevShortcut({ key: 'j', ctrlKey: true, shiftKey: true }), true);
  assert.equal(isBrowserDevShortcut({ key: 'c', metaKey: true }), false);
  assert.equal(isBrowserDevShortcut({ key: 'v', ctrlKey: true }), false);
});

test('text menu edits the captured selection and emits input, but refuses stale content', () => {
  const events = [];
  const control = { value: 'Alpha Beta', selectionStart: 6, selectionEnd: 10, type: 'text', isConnected: true, ownerDocument: { execCommand: () => false }, focus() {}, setSelectionRange() {}, dispatchEvent: event => events.push(event.type) };
  const snapshot = captureTextControl(control);
  replaceTextControlSelection(snapshot, 'Gamma');
  assert.equal(control.value, 'Alpha Gamma');
  assert.deepEqual(events, ['input']);
  assert.throws(() => replaceTextControlSelection(snapshot, 'stale'), /内容已改变/);
});

test('password controls are sensitive and read-only controls cannot be changed', () => {
  const control = { value: 'secret', selectionStart: 0, selectionEnd: 6, type: 'password', readOnly: true, isConnected: true };
  const snapshot = captureTextControl(control);
  assert.equal(snapshot.sensitive, true);
  assert.equal(snapshot.writable, false);
  assert.throws(() => replaceTextControlSelection(snapshot, 'new'), /内容已改变/);
});
