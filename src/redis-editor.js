import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { autocompletion, completionKeymap, acceptCompletion, closeBrackets } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { sqlIme } from "./sql-ime.js";
import { redisCompletionSource } from "./redis-completion.js";

export const redisLanguage = StreamLanguage.define({
  languageData: {
    imeProtectedContext(state, position) {
      const text = state.sliceDoc(0, position);
      let quote = null;
      for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === "\\") { index++; continue; }
        if (quote) { if (character === quote) quote = null; }
        else if (character === '"' || character === "'") quote = character;
      }
      return quote !== null;
    },
  },
  startState: () => ({ quote: null }),
  token(stream, state) {
    if (!state.quote && stream.eatSpace()) return null;
    if (state.quote || stream.peek() === '"' || stream.peek() === "'") {
      if (!state.quote) state.quote = stream.next();
      while (!stream.eol()) {
        const character = stream.next();
        if (character === "\\") stream.next();
        else if (character === state.quote) { state.quote = null; break; }
      }
      return "string";
    }
    if (stream.match(/-?\d+(?:\.\d+)?\b/)) return "number";
    if (stream.match(/[A-Za-z][A-Za-z0-9_.:-]*/)) return stream.start === 0 ? "keyword" : "variableName";
    stream.next(); return null;
  },
});
export const redisEditorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--app-text)", backgroundColor: "var(--input-bg)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.8", overflow: "auto" },
  ".cm-content": { padding: "14px 0", minHeight: "100px", caretColor: "var(--app-text)" },
  ".cm-line": { padding: "0 18px" },
  ".cm-gutters": { backgroundColor: "var(--input-bg)", color: "var(--app-muted)", border: "none", minWidth: "40px" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--selected-bg) 45%, transparent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--app-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selected-bg)" },
  ".cm-placeholder": { color: "var(--app-muted)" },
  ".cm-tooltip": { color: "var(--app-text)", backgroundColor: "var(--app-panel)", border: "1px solid var(--app-border)", borderRadius: "8px", boxShadow: "0 8px 28px #0003", overflow: "hidden" },
  ".cm-tooltip-autocomplete": { overflow: "visible" },
  ".cm-tooltip-autocomplete ul": { fontFamily: "inherit", fontSize: "12px", maxHeight: "250px", minWidth: "280px" },
  ".cm-tooltip-autocomplete ul li": { padding: "7px 10px", display: "flex", alignItems: "center", gap: "12px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { color: "var(--app-text)", backgroundColor: "var(--selected-bg)" },
  ".cm-completionLabel": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: "600" },
  ".cm-completionDetail": { color: "var(--app-muted)", fontStyle: "normal", marginLeft: "auto", fontSize: "11px" },
  ".cm-completionInfo": { padding: "12px 14px", maxWidth: "320px", font: "12px/1.7 -apple-system, sans-serif" },
});
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: tags.number, color: "var(--syntax-number)" },
]));
export function createRedisEditor({ parent, onChange, onHint, onRun, getKeys }) {
  const extensions = [
    EditorView.contentAttributes.of({ id: "redisConsoleInput", "aria-label": "Redis 命令编辑器", spellcheck: "false" }),
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(), closeBrackets(),
    redisLanguage, sqlIme, highlight, redisEditorTheme, placeholder('输入命令，例如 GET "user:1"'),
    autocompletion({ override: [context => redisCompletionSource(context, getKeys())], icons: false, maxRenderedOptions: 20, interactionDelay: 0 }),
    keymap.of([{ key: "Mod-Enter", run: () => { onRun(); return true; } }, ...completionKeymap,
      { key: "Tab", run: acceptCompletion }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) onHint(update.state.doc.lineAt(update.state.selection.main.head).text);
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ extensions }) });
  return {
    view,
    finishComposition: () => view.plugin(sqlIme)?.finish(),
    getValue: () => view.state.doc.toString(),
    currentLine: () => view.state.doc.lineAt(view.state.selection.main.head).text,
    reset: value => view.setState(EditorState.create({ doc: value, extensions })),
    executionText: () => { const { from, to } = view.state.selection.main; return view.state.sliceDoc(from, to) || view.state.doc.toString(); },
    setValue(value) { if (value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); },
    focus: () => view.focus(),
  };
}
