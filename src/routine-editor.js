import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { sqlIme } from './sql-ime.js';
import { routineKindLabels } from './routine-ddl.js';

const colors = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--app-muted)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--syntax-operator)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--input-bg)', color: 'var(--app-text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace', fontSize: '12.5px', lineHeight: '1.75' },
  '.cm-content': { padding: '14px 14px 18px 8px', caretColor: 'var(--accent-focus)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--app-text)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--app-panel)', color: 'var(--app-muted)', border: '0', paddingRight: '6px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-line-bg)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--app-text)', fontWeight: '600' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-selection-bg, var(--selected-bg))' },
  '.cm-panels': { backgroundColor: 'var(--app-panel)', color: 'var(--app-text)', borderColor: 'var(--app-border)' },
  '&.cm-focused': { outline: 'none' },
});

const notes = {
  postgres: '保存时执行 CREATE OR REPLACE，在一个事务内完成；失败不会改动原定义。',
  mysql: 'MySQL 不能原地修改：保存时先删除原对象再重新创建，期间对象不可用，且无法回滚；创建失败时会自动尝试恢复原定义。',
};

/**
 * Modal editor for a routine's full CREATE statement.
 * `plan(text)` returns the statements to run (or throws a user-facing message);
 * `onApply(plan)` resolves truthy once saved, and may throw to keep the dialog open.
 */
export function openRoutineEditor({ kind, driver, targetLabel, definition, plan, onApply, confirmDiscard }) {
  const label = routineKindLabels[kind];
  const initial = String(definition ?? '');
  const dialog = document.createElement('dialog');
  dialog.className = 'routine-editor create-object-dialog';
  dialog.setAttribute('aria-labelledby', 'routineEditorTitle');
  dialog.innerHTML = `
    <div class="dialog-header"><div><h2 id="routineEditorTitle"></h2><p class="routine-editor-target"></p></div></div>
    <p class="routine-editor-note"></p>
    <div class="routine-editor-surface"></div>
    <div class="routine-editor-status" role="status" aria-live="polite"></div>
    <p class="dialog-feedback error" role="alert"></p>
    <div class="dialog-actions">
      <span class="routine-editor-meta"></span>
      <button type="button" class="secondary-btn" data-routine-cancel>取消</button>
      <button type="button" class="primary-btn" data-routine-save disabled><span>下一步</span><kbd aria-hidden="true">⌘ S</kbd></button>
    </div>`;
  dialog.querySelector('h2').textContent = `编辑${label}`;
  dialog.querySelector('.routine-editor-target').textContent = targetLabel;
  dialog.querySelector('.routine-editor-note').textContent = notes[driver] || '';
  const status = dialog.querySelector('.routine-editor-status');
  const feedback = dialog.querySelector('.dialog-feedback');
  const meta = dialog.querySelector('.routine-editor-meta');
  const cancel = dialog.querySelector('[data-routine-cancel]');
  const save = dialog.querySelector('[data-routine-save]');

  const lock = new Compartment();
  let view = null;
  let busy = false;
  let current = null;
  const dirty = () => view.state.doc.toString() !== initial;

  const refresh = () => {
    const value = view.state.doc.toString();
    meta.textContent = `${view.state.doc.lines.toLocaleString()} 行`;
    current = null;
    status.replaceChildren();
    status.className = 'routine-editor-status';
    if (value === initial) {
      status.textContent = '尚未修改';
    } else {
      try {
        current = plan(value);
        if (current.warnings.length) {
          status.classList.add('warning');
          for (const warning of current.warnings) status.append(Object.assign(document.createElement('div'), { textContent: warning }));
        } else status.textContent = '已修改，下一步确认保存。';
      } catch (error) {
        status.classList.add('invalid');
        status.textContent = error.message;
      }
    }
    save.disabled = busy || !current;
  };

  const setBusy = value => {
    busy = value;
    cancel.disabled = value;
    view.dispatch({ effects: lock.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
    dialog.toggleAttribute('aria-busy', value);
    save.disabled = value || !current;
  };

  const apply = async () => {
    // Settle any pending IME composition first, then plan from the final text.
    view.plugin(sqlIme)?.finish();
    refresh();
    if (busy || !current) return true;
    feedback.textContent = '';
    setBusy(true);
    try {
      if (await onApply(current)) dialog.close();
    } catch (error) {
      feedback.textContent = error?.message || String(error);
    } finally {
      if (dialog.isConnected) setBusy(false);
    }
    return true;
  };

  const requestClose = async () => {
    if (busy) return;
    if (dirty() && confirmDiscard && !await confirmDiscard()) return;
    dialog.close();
  };

  view = new EditorView({
    parent: dialog.querySelector('.routine-editor-surface'),
    state: EditorState.create({
      doc: initial,
      extensions: [
        EditorView.contentAttributes.of({ 'aria-label': `${label}定义编辑器`, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), sqlIme, drawSelection(),
        bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches({ minSelectionLength: 2, wholeWords: true }),
        search({ top: true }),
        EditorState.phrases.of({ Find: '查找', next: '下一处', previous: '上一处', all: '全选匹配', 'match case': '区分大小写', regexp: '正则', 'by word': '整词', close: '关闭查找', replace: '替换', 'replace all': '全部替换', Replace: '替换' }),
        sql({ dialect: driver === 'mysql' ? MySQL : PostgreSQL }), syntaxHighlighting(colors), theme,
        lock.of([]),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void apply(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of(update => { if (update.docChanged) refresh(); }),
      ],
    }),
  });

  // The editor is sized once from the opening definition so the centred dialog never jitters while typing.
  dialog.querySelector('.routine-editor-surface').style.setProperty('--routine-lines', String(view.state.doc.lines));

  cancel.addEventListener('click', () => void requestClose());
  save.addEventListener('click', () => void apply());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void requestClose();
  });
  dialog.addEventListener('close', () => { view.destroy(); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  refresh();
  view.focus();
  return dialog;
}
