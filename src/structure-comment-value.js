export const commentDisplayValue = value => String(value ?? '').replace(/\r\n?/g, '\n');

// Textarea selection offsets refer to its LF-only view, not the original text.
function sourceOffset(source, offset) {
  let index = 0, visible = 0;
  while (index < source.length && visible < offset) {
    index += source[index] === '\r' && source[index + 1] === '\n' ? 2 : 1;
    visible++;
  }
  return index;
}

/** Keep original line endings and undo as raw text patches. The textarea is
 * only an LF-normalized view; it must never become the stored source. */
export function createCommentValue(value = '') {
  let source = String(value ?? ''), cursor = 0;
  let selection = [0, 0];
  const changes = [];
  const applyPatch = (text, patch, reverse = false) => {
    const removed = reverse ? patch.inserted : patch.removed, inserted = reverse ? patch.removed : patch.inserted;
    return text.slice(0, patch.from) + inserted + text.slice(patch.from + removed.length);
  };
  const restore = direction => {
    if (direction < 0 ? cursor === 0 : cursor === changes.length) return source;
    const change = changes[direction < 0 ? --cursor : cursor++];
    for (const patch of direction < 0 ? [...change.patches].reverse() : change.patches) source = applyPatch(source, patch, direction < 0);
    selection = direction < 0 ? change.before : change.after;
    return source;
  };
  const replace = (start, end, inserted, options, next) => {
    const from = sourceOffset(source, start), to = sourceOffset(source, end);
    const removed = source.slice(from, to);
    if (removed === inserted) return source;
    changes.splice(cursor);
    const patch = { from, removed, inserted };
    const before = [options.selectionStart ?? start, options.selectionEnd ?? end];
    source = applyPatch(source, patch);
    const caret = commentDisplayValue(source.slice(0, from + inserted.length)).length;
    selection = commentDisplayValue(source) === next && Number.isInteger(options.selectionAfterStart)
      ? [options.selectionAfterStart, options.selectionAfterEnd ?? options.selectionAfterStart] : [caret, caret];
    const previous = changes[cursor - 1];
    if (options.group != null && previous?.group === options.group) {
      previous.patches.push(patch); previous.after = selection;
    } else {
      changes.push({ group: options.group, patches: [patch], before, after: selection }); cursor++;
    }
    return source;
  };
  return {
    get value() { return source; },
    get selection() { return selection; },
    undo() { return restore(-1); },
    redo() { return restore(1); },
    finishGroup(group) {
      const change = changes[cursor - 1];
      if (!change || change.group !== group) return;
      let before = source;
      for (const patch of [...change.patches].reverse()) before = applyPatch(before, patch, true);
      if (before === source) { changes.splice(--cursor, 1); }
    },
    apply(value, options = {}) {
      const { inputType = '', selectionStart, selectionEnd, data = null, pasteText = null } = options;
      const next = commentDisplayValue(value), previous = commentDisplayValue(source);
      if (inputType === 'historyUndo') return restore(-1);
      if (inputType === 'historyRedo') return restore(1);
      const selected = Number.isInteger(selectionStart) && Number.isInteger(selectionEnd) && selectionStart >= 0 && selectionEnd >= selectionStart && selectionEnd <= previous.length;
      if (selected) {
        let start = selectionStart, end = selectionEnd;
        let inserted = pasteText;
        if (inserted == null && /^insert/u.test(inputType)) inserted = inputType === 'insertLineBreak' || inputType === 'insertParagraph' ? '\n' : data;
        if (inserted == null && /^delete/u.test(inputType)) {
          inserted = '';
          const deleted = previous.length - next.length;
          if (start === end && deleted > 0) {
            if (/Backward$/u.test(inputType)) start = Math.max(0, start - deleted);
            else if (/Forward$/u.test(inputType)) end = Math.min(previous.length, end + deleted);
          }
        }
        if (typeof inserted === 'string' && previous.slice(0, start) + commentDisplayValue(inserted) + previous.slice(end) === next) return replace(start, end, inserted, options, next);
      }
      if (next === previous) return source;
      // Selection bounds disambiguate edits among repeated identical lines.
      let start = 0, oldEnd = previous.length, newEnd = next.length;
      const prefixLimit = selected ? Math.min(selectionStart, previous.length, next.length) : Math.min(previous.length, next.length);
      while (start < prefixLimit && previous[start] === next[start]) start++;
      const suffixLimit = selected ? Math.max(start, selectionEnd) : start;
      while (oldEnd > suffixLimit && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
      return replace(start, oldEnd, next.slice(start, newEnd), options, next);
    },
  };
}
