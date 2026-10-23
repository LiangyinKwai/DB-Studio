import assert from 'node:assert/strict';
import test from 'node:test';
import { formatShortcut } from '../src/shortcut-labels.js';

test('Mac shortcut labels retain command symbols', () => {
  for (const platform of ['MacIntel', 'macOS', 'MacPPC', 'iPad']) {
    assert.equal(formatShortcut('⌘ K · ⌘ ⇧ P', platform), '⌘ K · ⌘ ⇧ P');
  }
});

test('Windows and Linux shortcut labels replace every command symbol', () => {
  for (const platform of ['Win32', 'Windows', 'Linux x86_64', 'Linux', '']) {
    assert.equal(formatShortcut('⌘ K · ⌘ ⇧ P', platform), 'Ctrl K · Ctrl ⇧ P');
  }
});

test('formatting has no implicit navigator dependency and preserves non-command shortcut text', () => {
  assert.equal(formatShortcut('Enter / F2 / Alt+↑', 'Windows'), 'Enter / F2 / Alt+↑');
  assert.equal(formatShortcut('⌘ S'), 'Ctrl S');
  assert.equal(formatShortcut(null, 'MacIntel'), '');
});
