import { commentDisplayValue, createCommentValue } from './structure-comment-value.js';

let sequence = 0;

/** Expand a comment draft; closing only collapses the editor. Callbacks update
 * the parent draft synchronously and must not execute database operations. */
export function createStructureCommentEditor({ parent, onCommit } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'structure-comment-dialog';
  const titleId = `structure-comment-title-${++sequence}`;
  dialog.setAttribute('aria-labelledby', titleId);
  // Do not nest a form: Enter and the close controls must never submit the
  // surrounding CREATE/ALTER form.
  dialog.innerHTML = `<div class="dialog-header"><h2 id="${titleId}"></h2><button type="button" class="icon-btn structure-comment-close" aria-label="收起备注编辑">×</button></div>
    <textarea class="structure-comment-input" rows="10" wrap="soft" spellcheck="false"></textarea>
    <p class="structure-comment-feedback" role="alert" hidden></p>
    <div class="structure-comment-footer"><button type="button" class="primary-btn structure-comment-done">完成</button></div>`;
  (parent || document.body).append(dialog);
  const title = dialog.querySelector('h2');
  const textarea = dialog.querySelector('textarea');
  const feedback = dialog.querySelector('.structure-comment-feedback');
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let context = null, lastPublished = '', composing = false, pendingClose = false;
  let ignoreCancel = false, cancelTimer = 0, destroyed = false;
  let model = createCommentValue(), beforeEdit = null, paste = null, pasteTimer = 0;
  let groupSequence = 0, compositionGroup = null, typing = null;

  const renderValue = (restoreSelection = false) => {
    const visible = commentDisplayValue(model.value);
    if (textarea.value !== visible || restoreSelection) {
      textarea.value = visible;
      const [start, end] = model.selection;
      textarea.setSelectionRange(Math.min(start, visible.length), Math.min(end, visible.length));
    }
  };
  const readInput = event => {
    const previous = commentDisplayValue(model.value);
    const captured = beforeEdit?.visible === previous ? beforeEdit : null;
    const clipboard = paste?.visible === previous ? paste : null;
    const inputType = event?.inputType || captured?.inputType || '';
    const selectionStart = clipboard?.start ?? captured?.start, selectionEnd = clipboard?.end ?? captured?.end;
    let group = compositionGroup;
    if (group == null) {
      const typeable = !clipboard && selectionStart === selectionEnd && ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(inputType);
      const now = Date.now();
      if (typeable && typing?.inputType === inputType && typing.position === selectionStart && now - typing.at < 750) group = typing.group;
      else group = ++groupSequence;
      typing = typeable ? { group, inputType, position: textarea.selectionStart, at: now } : null;
    }
    model.apply(textarea.value, { inputType, selectionStart, selectionEnd, data: event?.data ?? captured?.data,
      pasteText: clipboard?.text ?? null, group, selectionAfterStart: textarea.selectionStart, selectionAfterEnd: textarea.selectionEnd });
    beforeEdit = paste = null; clearTimeout(pasteTimer);
    // Deleting text between an original CR and LF can join them into CRLF.
    // Re-render that source faithfully instead of leaving an offset mismatch.
    renderValue();
  };

  const publish = () => {
    if (!context || composing) return true;
    if (textarea.value !== commentDisplayValue(model.value)) readInput();
    if (model.value === lastPublished) return true;
    try {
      (context.onChange || onCommit)?.(model.value);
      lastPublished = model.value;
      feedback.textContent = ''; feedback.hidden = true;
      return true;
    } catch (error) {
      feedback.textContent = error?.message || String(error); feedback.hidden = false;
      return false;
    }
  };
  const history = redo => {
    if (composing || !context) return;
    typing = beforeEdit = paste = null; clearTimeout(pasteTimer);
    if (redo) model.redo(); else model.undo();
    renderValue(true); publish();
  };
  const restoreFocus = () => {
    const anchor = context?.anchor;
    context = null;
    if (!destroyed && anchor?.isConnected && !anchor.disabled) anchor.focus({ preventScroll: true });
  };
  const close = () => {
    if (!dialog.open) return true;
    if (composing) { pendingClose = true; return false; }
    if (!publish()) return false;
    pendingClose = false;
    dialog.close();
    restoreFocus();
    return true;
  };
  textarea.addEventListener('beforeinput', event => {
    if (!composing && ['historyUndo', 'historyRedo'].includes(event.inputType) && event.cancelable) {
      event.preventDefault(); history(event.inputType === 'historyRedo'); return;
    }
    beforeEdit = { visible: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd, inputType: event.inputType, data: event.data };
  }, options);
  textarea.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string') return;
    paste = { text, visible: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
    clearTimeout(pasteTimer); pasteTimer = setTimeout(() => { paste = null; }, 0);
  }, options);
  textarea.addEventListener('input', event => { readInput(event); publish(); }, options);
  textarea.addEventListener('pointerdown', () => { typing = null; }, options);
  textarea.addEventListener('compositionstart', () => { composing = true; compositionGroup = ++groupSequence; typing = null; }, options);
  textarea.addEventListener('compositionend', () => {
    composing = false;
    if (textarea.value !== commentDisplayValue(model.value)) readInput();
    model.finishGroup(compositionGroup); compositionGroup = null;
    publish();
    if (pendingClose) close();
  }, options);
  for (const button of dialog.querySelectorAll('button')) button.addEventListener('click', close, options);
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (composing || event.isComposing || event.keyCode === 229) {
      if (event.key === 'Escape') {
        // A native cancel can follow the IME key's default action after
        // compositionend. Keep that same key from closing this dialog.
        ignoreCancel = true;
        clearTimeout(cancelTimer);
        cancelTimer = setTimeout(() => { ignoreCancel = false; }, 0);
      }
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || (event.ctrlKey && key === 'y'))) {
      event.preventDefault(); history(event.shiftKey || key === 'y'); return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) typing = null;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); close(); }
  }, options);
  dialog.addEventListener('cancel', event => {
    event.preventDefault(); event.stopPropagation();
    if (event.detail === "backdrop" || (!composing && !ignoreCancel)) close();
  }, options);
  dialog.addEventListener('close', () => {
    if (dialog.open || destroyed) return;
    publish(); restoreFocus();
  }, options);

  return {
    open({ value = '', fieldName = '', anchor = null, onChange } = {}) {
      if (destroyed || (dialog.open && !close())) return false;
      context = { anchor, onChange };
      title.textContent = `${fieldName || '新字段'} · 备注`;
      textarea.setAttribute('aria-label', `${fieldName || '新字段'} · 备注`);
      model = createCommentValue(value);
      textarea.value = commentDisplayValue(model.value);
      lastPublished = model.value;
      beforeEdit = paste = typing = null; compositionGroup = null; clearTimeout(pasteTimer);
      composing = pendingClose = ignoreCancel = false;
      clearTimeout(cancelTimer);
      feedback.textContent = ''; feedback.hidden = true;
      dialog.showModal();
      textarea.focus({ preventScroll: true });
      return true;
    },
    close,
    destroy() {
      if (destroyed) return;
      destroyed = true; context = null; pendingClose = false;
      clearTimeout(cancelTimer); clearTimeout(pasteTimer); abort.abort();
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
