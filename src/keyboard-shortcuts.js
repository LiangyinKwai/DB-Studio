const textInputTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Return whether the document-level shortcut handler may act on an event
 * target. Text editing controls should keep modifier shortcuts for themselves
 * while the SQL editor (CodeMirror) continues to support ⌘/Ctrl+Enter.
 */
export function canHandleGlobalShortcut(target) {
  if (!target) return true;

  if (typeof target.closest === "function" && target.closest(".cm-editor")) {
    return true;
  }

  if (target.isContentEditable) return false;

  const tagName = String(target.tagName || "").toUpperCase();
  return !textInputTags.has(tagName);
}
