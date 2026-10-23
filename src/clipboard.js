/** Desktop copies use the native bridge, including after async DDL reads.
 * Browser preview retains Clipboard API and selection-based fallbacks. */
export async function writeClipboardText(text, { invoke = null, clipboard = globalThis.navigator?.clipboard, document: root = globalThis.document } = {}) {
  let nativeError;
  if (invoke) {
    try { await invoke('write_clipboard_text', { text }); return; }
    catch (error) { nativeError = error; }
  }
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return; }
  } catch {}
  const previous = root?.activeElement;
  const selection = root?.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = root?.createElement('textarea');
  if (!textarea) throw nativeError || new Error('系统剪贴板不可用');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  (root.querySelector('dialog[open]') || root.body).append(textarea);
  let copied = false;
  try { textarea.focus({ preventScroll: true }); textarea.select(); copied = Boolean(root.execCommand?.('copy')); }
  catch {}
  finally {
    textarea.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    if (selection && ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
  if (!copied) throw nativeError || new Error('系统剪贴板不可用');
}
