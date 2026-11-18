import test from 'node:test';
import assert from 'node:assert/strict';
import { commentDisplayValue, createCommentValue } from '../src/structure-comment-value.js';

test('opening and editing preserve unchanged CRLF, CR and LF independently', () => {
  const raw = 'first\r\nsecond\rthird\nfourth';
  const model = createCommentValue(raw);
  assert.equal(model.apply(commentDisplayValue(raw)), raw);
  assert.equal(model.apply('first\nsecond!\nthird\nfourth', { selectionStart: 12, selectionEnd: 12, inputType: 'insertText', data: '!' }), 'first\r\nsecond!\rthird\nfourth');
  assert.equal(model.apply('first\nsecond!\nthird\nFOURTH', { selectionStart: 20, selectionEnd: 26, inputType: 'insertText', data: 'FOURTH' }), 'first\r\nsecond!\rthird\nFOURTH');
});

test('paste replaces the exact selection with original clipboard line endings', () => {
  const model = createCommentValue('a\r\nb\rc\n');
  assert.equal(model.apply('a\nx\ny\nz\n\nc\n', { selectionStart: 2, selectionEnd: 3, pasteText: 'x\r\ny\rz\n', inputType: 'insertFromPaste' }), 'a\r\nx\r\ny\rz\n\rc\n');
});

test('identical displayed paste still replaces its source line endings', () => {
  const model = createCommentValue('a\nb');
  assert.equal(model.apply('a\nb', { selectionStart: 0, selectionEnd: 3, pasteText: 'a\r\nb', inputType: 'insertFromPaste' }), 'a\r\nb');
  assert.equal(model.apply('a\nb', { inputType: 'historyUndo' }), 'a\nb');
  assert.equal(model.apply('a\nb', { inputType: 'historyRedo' }), 'a\r\nb');
});

test('grouped undo/redo restores original removed newline sequences', () => {
  const model = createCommentValue('a\r\nb\rc\n');
  model.apply('Xc\n', { selectionStart: 0, selectionEnd: 4, data: 'X', inputType: 'insertText', group: 1 });
  model.apply('XYc\n', { selectionStart: 1, selectionEnd: 1, data: 'Y', inputType: 'insertText', group: 1 });
  assert.equal(model.apply('a\nb\nc\n', { inputType: 'historyUndo' }), 'a\r\nb\rc\n');
  assert.equal(model.apply('XYc\n', { inputType: 'historyRedo' }), 'XYc\n');
  model.apply('a\nb\nc\n', { inputType: 'historyUndo' });
  assert.equal(model.apply('a!\nb\nc\n', { selectionStart: 1, selectionEnd: 1, data: '!', inputType: 'insertText' }), 'a!\r\nb\rc\n');
});

test('CR/LF seams preserve raw bytes and undo their visual normalization exactly', () => {
  const model = createCommentValue('x\rZ\ny');
  assert.equal(model.apply('x\n\ny', { selectionStart: 2, selectionEnd: 3, inputType: 'deleteContentBackward' }), 'x\r\ny');
  assert.equal(model.undo(), 'x\rZ\ny');
  assert.equal(model.redo(), 'x\r\ny');
});

test('deletion in repeated mixed newline text uses the exact selected source', () => {
  const first = createCommentValue('\r\n\n'), second = createCommentValue('\r\n\n');
  assert.equal(first.apply('\n', { selectionStart: 0, selectionEnd: 1, inputType: 'deleteContentBackward' }), '\n');
  assert.equal(second.apply('\n', { selectionStart: 1, selectionEnd: 2, inputType: 'deleteContentBackward' }), '\r\n');
  assert.equal(first.undo(), '\r\n\n'); assert.equal(second.undo(), '\r\n\n');
});

test('repeated newline insertion and backward deletion preserve the other original separators', () => {
  const model = createCommentValue('\r\n\r\n\r');
  assert.equal(model.apply('\n\n\n\n', { selectionStart: 0, selectionEnd: 0, inputType: 'insertLineBreak' }), '\n\r\n\r\n\r');
  assert.equal(model.apply('\n\n\n', { selectionStart: 1, selectionEnd: 1, inputType: 'deleteContentBackward' }), '\r\n\r\n\r');
});
