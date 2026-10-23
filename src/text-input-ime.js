import { normalizeImeCommit } from './ime-commit.js';

const letters = /^[a-z]$/i;
const supportedTypes = new Set(['text', 'search', 'url', 'tel']);
function isTextControl(control) {
  return control && !control.disabled && !control.readOnly && !control.closest?.('.cm-editor, .password-control') &&
    !/password/i.test(control.autocomplete || '') &&
    (control.tagName === 'TEXTAREA' || (control.tagName === 'INPUT' && supportedTypes.has(control.type))) &&
    Number.isInteger(control.selectionStart) && Number.isInteger(control.selectionEnd);
}

/** Delegation also covers filter popovers, inline cells and dialogs created
 * after startup. Only the tracked composition span can be changed. */
export function initTextInputIme(root = document) {
  let session = null;
  let timer = null;
  const keys = new WeakMap();
  const handlers = [];
  function listen(type, handler) {
    root.addEventListener(type, handler, true);
    handlers.push([type, handler]);
  }
  function clear() { clearTimeout(timer); timer = null; session = null; }
  function finish() {
    const current = session;
    if (!current?.ended) return;
    clear();
    const { control, from, prefix, suffix, text } = current;
    if (!control.isConnected || !isTextControl(control) || !text) return;
    const insert = normalizeImeCommit(current);
    const to = from + text.length;
    if (insert === text || !control.value.startsWith(prefix) || !control.value.endsWith(suffix) || control.value.slice(from, to) !== text) return;
    const start = control.selectionStart, end = control.selectionEnd, direction = control.selectionDirection;
    const map = position => position <= from ? position : position >= to ? position + insert.length - text.length : from + insert.length;
    // Use the native editing command when focused so the repair participates in
    // undo. Blur reconciliation must not steal focus from the clicked control.
    let edited = false;
    if (root.activeElement === control && root.execCommand) {
      control.setSelectionRange(from, to);
      edited = root.execCommand('insertText', false, insert);
    }
    if (!edited) {
      control.setRangeText(insert, from, to, 'preserve');
      control.dispatchEvent(new Event('input', { bubbles: true }));
    }
    control.setSelectionRange(map(start), map(end), direction);
  }
  listen('keydown', event => {
    const control = event.target;
    if (!isTextControl(control)) return;
    const switched = ['CapsLock', 'Shift', 'Lang1', 'Lang2', 'Eisu'].includes(event.key) || (event.code === 'Space' && event.ctrlKey);
    if (session?.control === control) {
      if (switched) session.switched = true;
      else if (!session.ended && (event.code === 'Space' || event.key === ' ' || event.key === '\u3000')) session.typedSpace = true;
      else if (!session.ended && letters.test(event.key) && !event.ctrlKey && !event.metaKey) session.rawKeys += event.key;
      else if (!session.ended && !['Process', 'Unidentified'].includes(event.key)) session.rawKeys = '';
      if (session.ended && event.key === 'Enter' && !event.isComposing) finish();
    }
    keys.set(control, { key: event.key, at: Date.now(), plain: !event.ctrlKey && !event.metaKey && !event.altKey });
  });
  listen('compositionstart', event => {
    finish(); clear();
    const control = event.target;
    if (!isTextControl(control)) return;
    const from = control.selectionStart, to = control.selectionEnd, key = keys.get(control);
    session = { control, from, prefix: control.value.slice(0, from), suffix: control.value.slice(to),
      switched: false, typedSpace: false, ended: false,
      rawKeys: key?.plain && letters.test(key.key) && Date.now() - key.at < 80 ? key.key : '' };
  });
  listen('compositionend', event => {
    if (session?.control !== event.target) return;
    session.ended = true;
    session.text = event.data || '';
    // Match the SQL editor's reconciliation window for WebKit's event order.
    clearTimeout(timer); timer = setTimeout(finish, 30);
  });
  listen('beforeinput', event => {
    if (session?.control !== event.target) return;
    if (/insertFromPaste|insertFromDrop|historyUndo|historyRedo/.test(event.inputType)) { clear(); return; }
    if (session.ended && !event.isComposing && !/Composition/.test(event.inputType) &&
      session.control.value.slice(session.from, session.from + session.text.length) === session.text) finish();
  });
  listen('pointerdown', event => { if (session?.ended && event.target !== session.control) finish(); });
  listen('focusout', event => { if (session?.control === event.target) finish(); });
  listen('submit', finish);
  return { finish, destroy() { clear(); for (const [type, handler] of handlers) root.removeEventListener(type, handler, true); } };
}
