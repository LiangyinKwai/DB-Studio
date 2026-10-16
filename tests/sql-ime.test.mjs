import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImeCommit } from '../src/sql-ime.js';

test('repairs only segmented Latin from a confirmed IME switch', () => {
  for (const text of ['se l', 'SE L', 'se  le ct', 'se\u00a0l', 'se\u3000l']) {
    assert.equal(normalizeImeCommit({ text, switched: true }), text.replace(/[ \u00a0\u3000]/g, ''));
  }
});

test('requires switch evidence or matching physical keys', () => {
  assert.equal(normalizeImeCommit({ text: 'se l' }), 'se l');
  assert.equal(normalizeImeCommit({ text: 'se l', rawKeys: 'se' }), 'se l');
  assert.equal(normalizeImeCommit({ text: 'se l', rawKeys: 'sel' }), 'sel');
  assert.equal(normalizeImeCommit({ text: 'SE L', rawKeys: 'sel' }), 'SEL');
});

test('keeps deliberate spaces and protected SQL content unchanged', () => {
  for (const protection of [{ typedSpace: true }, { protectedContext: true }]) {
    assert.equal(normalizeImeCommit({ text: 'se l', switched: true, rawKeys: 'sel', ...protection }), 'se l');
  }
});

test('does not rewrite Chinese, punctuation, indentation, cancellation or mixed SQL', () => {
  for (const text of ['', '色了', 'select', "xi'an", 'sel ', ' sel', 'se\tl', 'se\nl', 'SELECT * FROM t', 'a1 b', 'se 色', 'a '.repeat(70) + 'b']) {
    assert.equal(normalizeImeCommit({ text, switched: true }), text);
  }
});
