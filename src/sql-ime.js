import { Transaction } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { ViewPlugin } from '@codemirror/view';

const splitLatin = /^[a-z]+(?:[ \u00a0\u3000]+[a-z]+)+$/i;
const letters = /^[a-z]+$/i;

/** Only an IME's segmented Latin commit may be repaired. Never normalize the
 * document, pasted SQL, string literals, quoted names or intentionally typed spaces. */
export function normalizeImeCommit({ text, switched, typedSpace, protectedContext, rawKeys = '' }) {
  if (protectedContext || typedSpace || !splitLatin.test(text) || text.length > 128) return text;
  const compact = text.replace(/[ \u00a0\u3000]+/g, '');
  // Some input methods consume the switch key before the WebView sees it.
  // A complete physical-key trace is the alternative evidence, not a timeout.
  if (!switched && (!letters.test(rawKeys) || rawKeys.toLowerCase() !== compact.toLowerCase())) return text;
  return compact;
}

function protectedAt(state, position) {
  const guards = state.languageDataAt('imeProtectedContext', position);
  if (guards.length) return guards.some(guard => guard(state, position));
  if (!syntaxTreeAvailable(state, position)) return true;
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent)
    if (/String|Comment|QuotedIdentifier/i.test(node.name)) return true;
  return false;
}

/** macOS Pinyin may commit `se l` when switching to Latin before choosing a
 * candidate. Wait for composition/DOM reconciliation, then repair only that span. */
export const sqlIme = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.session = null;
    this.timer = null;
    this.lastKey = null;
    this.onKey = (event) => {
      const session = this.session;
      const switchKey = ['CapsLock', 'Shift', 'Lang1', 'Lang2', 'Eisu'].includes(event.key) ||
        (event.code === 'Space' && event.ctrlKey);
      if (session) {
        if (switchKey) session.switched = true;
        else if (!session.ended && (event.code === 'Space' || event.key === ' ' || event.key === '\u3000')) session.typedSpace = true;
        else if (!session.ended && letters.test(event.key) && event.key.length === 1 && !event.ctrlKey && !event.metaKey)
          session.rawKeys += event.key;
        else if (!session.ended && !['Process', 'Unidentified'].includes(event.key)) session.rawKeys = '';
      }
      this.lastKey = { key: event.key, at: Date.now(), plain: !event.ctrlKey && !event.metaKey && !event.altKey };
    };
    // CodeMirror deliberately skips its key handlers during composition; capture
    // observes the input-method key without preventing or synthesizing it.
    view.contentDOM.addEventListener('keydown', this.onKey, true);
  }
  start() {
    this.clear();
    const { state } = this.view, { from, to } = state.selection.main;
    if (state.selection.ranges.length !== 1) return;
    const key = this.lastKey;
    this.session = { from, to, protectedContext: protectedAt(state, from), switched: false, typedSpace: false,
      rawKeys: key?.plain && letters.test(key.key) && key.key.length === 1 && Date.now() - key.at < 80 ? key.key : '', ended: false };
  }
  end(event) {
    if (!this.session) return;
    this.session.ended = true;
    this.session.text = event.data || '';
    // Safari can deliver compositionend before its final DOM mutation/key event.
    this.timer = setTimeout(() => this.finish(), 30);
  }
  update(update) {
    if (!this.session || !update.docChanged) return;
    const session = this.session;
    // Before the final DOM change arrives, the right edge still belongs to the
    // composition. Once committed, leave any immediately following typing out.
    const committed = session.ended && update.startState.sliceDoc(session.from, session.to) === session.text;
    session.from = update.changes.mapPos(session.from, -1);
    session.to = update.changes.mapPos(session.to, committed ? -1 : 1);
  }
  finish() {
    const session = this.session;
    if (!session?.ended || this.view.compositionStarted) return;
    this.clear();
    if (!session.text) return;
    const insert = normalizeImeCommit(session);
    if (insert === session.text || this.view.state.sliceDoc(session.from, session.to) !== session.text) return;
    // Position mapping preserves surrounding SQL and a cursor moved after commit.
    this.view.dispatch({ changes: { from: session.from, to: session.to, insert },
      annotations: Transaction.userEvent.of('input.type.compose') });
  }
  clear() { clearTimeout(this.timer); this.timer = null; this.session = null; }
  destroy() { this.clear(); this.view.contentDOM.removeEventListener('keydown', this.onKey, true); }
}, {
  eventHandlers: {
    compositionstart() { this.start(); },
    compositionend(event) { this.end(event); },
  },
});
