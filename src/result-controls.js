// Anchored result controls stay outside the grid's scrolling/clipping surface.
export function initResultControls(refs) {
  let opened = null;
  function close(restoreFocus = false) {
    if (!opened) return;
    const { trigger, panel } = opened;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    opened = null;
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function attach(trigger, panel, firstFocus, menu = false) {
    function open() {
      if (trigger.disabled) return;
      close();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      opened = { trigger, panel };
      const anchor = trigger.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${anchor.bottom + panel.offsetHeight + 8 <= window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - panel.offsetHeight - 6)}px`;
      firstFocus()?.focus({ preventScroll: true });
      if (!menu) firstFocus()?.select();
    }
    trigger.addEventListener('click', () => opened?.trigger === trigger ? close(true) : open());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); open();
        if (menu && event.key === 'ArrowUp') [...panel.querySelectorAll('button:not(:disabled)')].at(-1)?.focus();
      }
    });
    panel.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    if (menu) panel.addEventListener('click', event => { if (event.target.closest('button:not(:disabled)')) close(true); });
  }
  attach(refs.resultMore, refs.resultMoreMenu, () => refs.resultMoreMenu.querySelector('button:not(:disabled)'), true);
  attach(refs.dataImportButton, refs.dataImportMenu, () => refs.dataImportMenu.querySelector('button:not(:disabled)'), true);
  attach(refs.pageJumpToggle, refs.pageJumpPanel, () => refs.pageJumpInput);
  document.addEventListener('pointerdown', event => {
    if (opened && !opened.panel.contains(event.target) && !opened.trigger.contains(event.target)) close();
  }, true);
  document.addEventListener('scroll', event => { if (opened && !opened.panel.contains(event.target)) close(); }, true);
  window.addEventListener('resize', () => close());
  return { close };
}
