export function isBrowserDevShortcut(event) {
  const key = String(event.key).toLowerCase();
  return key === 'f12' || Boolean(((event.ctrlKey && event.shiftKey) || (event.metaKey && event.altKey)) && ['i', 'j', 'c'].includes(key));
}

export function captureTextControl(control) {
  return {
    control, value: control.value,
    start: Number.isInteger(control.selectionStart) ? control.selectionStart : 0,
    end: Number.isInteger(control.selectionEnd) ? control.selectionEnd : control.value.length,
    sensitive: control.type === 'password',
    writable: !control.disabled && !control.readOnly,
  };
}

export function replaceTextControlSelection(snapshot, text) {
  const { control, value, start, end } = snapshot;
  if (!control.isConnected || control.disabled || control.readOnly || control.value !== value) throw new Error('输入内容已改变，请重新打开菜单');
  control.focus({ preventScroll: true });
  try { control.setSelectionRange(start, end); } catch {}
  const doc = control.ownerDocument;
  if (!doc.execCommand?.('insertText', false, text)) {
    try { control.setRangeText(text, start, end, 'end'); }
    catch { control.value = value.slice(0, start) + text + value.slice(end); }
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// App-owned menus are used everywhere. Existing grid/tree/tab menus win first.
export function initDesktopMenu({ getItems, copyText, onError, readClipboard = () => navigator.clipboard.readText() }) {
  let menu = null;
  let previousFocus = null;
  const close = (restore = false) => {
    menu?.remove(); menu = null;
    if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };
  const show = (items, event) => {
    close();
    previousFocus = document.activeElement;
    menu = document.createElement('div');
    menu.className = 'context-menu app-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '应用操作');
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.textContent = item.label; button.disabled = Boolean(item.disabled);
      button.addEventListener('click', async () => {
        close(true);
        try { await item.run(); } catch (error) { onError(error); }
      });
      menu.append(button);
    }
    // Append inside a native dialog's top layer when editing one of its fields.
    (event.target.closest('dialog[open]') || document.body).append(menu);
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.addEventListener('keydown', event => {
      event.stopPropagation();
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (['Escape', 'Tab'].includes(event.key)) { event.preventDefault(); close(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const custom = getItems(event.target);
    if (custom?.length) { show(custom, event); return; }
    const control = event.target.closest('input:not([type="checkbox"]):not([type="radio"]), textarea');
    if (control) {
      const snapshot = captureTextControl(control);
      const selected = snapshot.value.slice(snapshot.start, snapshot.end);
      show([
        { label: '剪切', disabled: !snapshot.writable || snapshot.sensitive || !selected, run: async () => { await copyText(selected); replaceTextControlSelection(snapshot, ''); } },
        { label: '复制', disabled: snapshot.sensitive || !selected, run: () => copyText(selected) },
        { label: '粘贴', disabled: !snapshot.writable, run: async () => replaceTextControlSelection(snapshot, await readClipboard()) },
        { label: '全选', disabled: control.disabled || !snapshot.value, run: () => { control.focus(); control.select(); } },
      ], event);
      return;
    }
    const content = event.target.closest('.selectable-text');
    if (content) {
      const selection = window.getSelection();
      const text = selection && content.contains(selection.anchorNode) ? selection.toString() : content.textContent;
      show([{ label: '复制', disabled: !text, run: () => copyText(text) }], event);
    }
  });
  document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) close(); }, true);
  document.addEventListener('scroll', event => {
    // Read-only virtual documents may settle their selection/scroll after a
    // right click. Their copy menu remains valid while the source is unchanged.
    const readerScroll = menu?.closest('dialog') && event.target.closest?.('.value-reader');
    if (menu && !menu.contains(event.target) && !readerScroll) close();
  }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('keydown', event => {
    if (isBrowserDevShortcut(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  return { close };
}
