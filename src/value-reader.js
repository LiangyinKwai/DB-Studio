import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { foldGutter, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, closeSearchPanel, searchPanelOpen, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';

export function valueMetrics(value) {
  const text = String(value ?? ''); let characters = 0, lines = 1;
  for (const char of text) { characters++; if (char === '\n') lines++; }
  return { characters, bytes: new TextEncoder().encode(text).length, lines };
}
export function valueMetricsLabel(value) {
  const { characters, bytes, lines } = valueMetrics(value);
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${characters.toLocaleString()} 字符 · ${lines.toLocaleString()} 行 · ${size}`;
}
// Textareas normalize CRLF. Merely entering edit mode must not change source.
export function inspectorSourceValue(inspector, controlValue) {
  if (inspector?.jsonInfo && !inspector.jsonEditing) return inspector.jsonInfo.raw;
  const source = inspector?.jsonInfo?.raw ?? inspector?.sourceText;
  const baseline = inspector?.jsonInfo ? inspector.jsonEditBaseline : inspector?.textBaseline;
  return source !== undefined && controlValue === baseline ? source : controlValue;
}

const colors = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.operator, color: 'var(--syntax-operator)' },
  { tag: tags.comment, color: 'var(--app-muted)', fontStyle: 'italic' },
  { tag: tags.propertyName, color: 'var(--syntax-keyword)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: [tags.bool, tags.null], color: 'var(--syntax-keyword)' },
]);
const sources = new WeakMap();
export const valueReaderSource = view => sources.get(view) ?? view.state.doc.toString();

/** Read-only document rendering: formatting and folding never rewrite saved values. */
export function createValueReader(parent, { label = '内容阅读器', showLineNumbers = true, onSearchChange = () => {} } = {}) {
  const wrapping = new Compartment(); let view = null, wrap = true;
  const theme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--input-bg)', color: 'var(--app-text)', fontSize: '13px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.75' },
    '.cm-content': { padding: '12px 0', minHeight: '100%' },
    '.cm-line': { padding: '0 14px' },
    '.cm-gutters': { backgroundColor: 'var(--app-panel)', color: 'var(--app-muted)', border: 'none' },
    '.cm-foldPlaceholder': { color: 'var(--app-text)', backgroundColor: 'var(--selected-bg)', borderColor: 'var(--app-border)' },
    '.cm-panels': { backgroundColor: 'var(--app-panel)', color: 'var(--app-text)', borderColor: 'var(--app-border)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--editor-selection-bg, var(--selected-bg))' },
    '&.cm-focused': { outline: '2px solid var(--accent-focus)', outlineOffset: '-2px' },
  });
  return {
    show(text, { isJson = false, sqlDriver = null } = {}) {
      const source = String(text);
      const state = EditorState.create({ doc: source, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
        ...(showLineNumbers ? [lineNumbers()] : []), drawSelection(), highlightSpecialChars(), highlightSelectionMatches(),
        search({ top: true }), keymap.of([...searchKeymap, ...defaultKeymap]),
        EditorView.updateListener.of(update => {
          const before = searchPanelOpen(update.startState), after = searchPanelOpen(update.state);
          if (before !== after) onSearchChange(after);
        }),
        Prec.highest(EditorView.domEventHandlers({ keydown(event, editor) {
          if (event.key === 'Escape' && searchPanelOpen(editor.state)) { closeSearchPanel(editor); event.preventDefault(); event.stopPropagation(); return true; }
          return false;
        } })),
        EditorState.phrases.of({ Find: '查找', next: '下一处', previous: '上一处', all: '全选匹配', 'match case': '区分大小写', regexp: '正则', 'by word': '整词', close: '关闭查找' }),
        wrapping.of(wrap ? EditorView.lineWrapping : []), theme,
        ...(isJson ? [json(), foldGutter(), syntaxHighlighting(colors)] : []),
        ...(['postgres', 'mysql'].includes(sqlDriver) ? [sql({ dialect: sqlDriver === 'mysql' ? MySQL : PostgreSQL }), syntaxHighlighting(colors)] : []),
      ] });
      if (view) view.setState(state); else {
        view = new EditorView({ state, parent });
        view.dom.addEventListener('keydown', event => {
          if (event.key === 'Escape' && !event.isComposing && searchPanelOpen(view.state)) {
            event.preventDefault(); event.stopPropagation(); closeSearchPanel(view);
          }
        }, true);
      }
      sources.set(view, source);
      onSearchChange(searchPanelOpen(view.state));
      view.requestMeasure();
    },
    getValue: () => view ? valueReaderSource(view) : '',
    setWrap(value) { wrap = Boolean(value); if (view) view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }); },
    find() { if (view) openSearchPanel(view); },
    toggleFind() { if (view) { if (searchPanelOpen(view.state)) closeSearchPanel(view); else openSearchPanel(view); } },
    closeFind() { if (view && searchPanelOpen(view.state)) closeSearchPanel(view); },
    focus() { view?.contentDOM.focus({ preventScroll: true }); },
    measure() { view?.requestMeasure(); },
    destroy() { if (view) { sources.delete(view); view.destroy(); view = null; onSearchChange(false); } },
    get view() { return view; },
  };
}
