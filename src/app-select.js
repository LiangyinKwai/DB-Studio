/** Theme-aware, searchable single selects. The original select remains the data
 * source so dynamically generated forms keep their change/validation behavior. */
export function initAppSelects(root = document.body) {
  const controls = new WeakMap();
  let active = null, sequence = 0;
  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'app-select-trigger';
    trigger.dataset.selectId = select.id || `app-select-${++sequence}`;
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'app-select-value'; trigger.append(label);
    const chevron = document.createElement('span'); chevron.className = 'app-select-chevron'; chevron.setAttribute('aria-hidden', 'true'); trigger.append(chevron);
    select.after(trigger); select.classList.add('app-select-source'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    let panel, search, list, highlighted = -1, shown = [];
    function sync() {
      trigger.hidden = select.hidden;
      trigger.disabled = select.disabled;
      label.textContent = select.selectedOptions[0]?.label || '请选择';
      let accessible = select.getAttribute('aria-label');
      if (!accessible && select.labels?.length) {
        const copy = select.labels[0].cloneNode(true); copy.querySelectorAll('select,button').forEach(node => node.remove());
        accessible = copy.textContent.trim();
      }
      trigger.setAttribute('aria-label', `${accessible || '选择选项'}：${label.textContent}`);
      trigger.title = select.title || label.textContent;
      if (panel && (select.hidden || select.disabled || !select.isConnected || !trigger.getClientRects().length)) close();
      if (panel) render();
    }
    const options = () => [...select.options].map((option, index) => ({ index, label: option.label, disabled: option.disabled || option.parentElement?.disabled, hidden: option.hidden, group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '' }));
    function position() {
      const rect = trigger.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 216), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      panel.style.width = `${width}px`; panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      const upward = below < 240 && above > below;
      panel.style.maxHeight = `${Math.max(80, Math.min(360, upward ? above : below))}px`;
      panel.style.top = upward ? 'auto' : `${rect.bottom + 6}px`;
      panel.style.bottom = upward ? `${window.innerHeight - rect.top + 6}px` : 'auto';
    }
    function highlight() {
      list.querySelectorAll('[role="option"]').forEach(row => row.classList.toggle('active', Number(row.dataset.index) === highlighted));
      const current = [...list.children].find(row => Number(row.dataset.index) === highlighted);
      if (current) { search.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
      else search.removeAttribute('aria-activedescendant');
    }
    function render() {
      const query = search.value.trim().toLowerCase();
      shown = options().filter(option => !option.hidden && `${option.label} ${option.group}`.toLowerCase().includes(query));
      if (!shown.some(option => option.index === highlighted && !option.disabled)) highlighted = shown.find(option => !option.disabled)?.index ?? -1;
      list.replaceChildren();
      let group;
      for (const option of shown) {
        if (option.group && option.group !== group) { const heading = document.createElement('div'); heading.className = 'app-select-group'; heading.textContent = option.group; list.append(heading); }
        group = option.group;
        const row = document.createElement('div'); row.className = 'app-select-option'; row.id = `${list.id}-${option.index}`; row.dataset.index = option.index;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.index === select.selectedIndex));
        row.setAttribute('aria-disabled', String(Boolean(option.disabled)));
        const check = document.createElement('span'); check.className = 'app-select-check'; check.textContent = option.index === select.selectedIndex ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.textContent = option.label; row.append(check, text); row.title = option.label;
        row.addEventListener('pointermove', () => { if (!option.disabled) { highlighted = option.index; highlight(); } });
        row.addEventListener('click', event => { event.preventDefault(); choose(option.index); }); list.append(row);
      }
      if (!shown.length) { const empty = document.createElement('div'); empty.className = 'app-select-empty'; empty.textContent = '没有匹配的选项'; list.append(empty); }
      highlight();
    }
    function close(focus = false) {
      if (!panel) return;
      panel.remove(); panel = null; trigger.setAttribute('aria-expanded', 'false');
      if (active?.trigger === trigger) active = null;
      if (focus && trigger.isConnected && !trigger.disabled) trigger.focus();
    }
    function choose(index) {
      const option = options().find(item => item.index === index);
      if (!option || option.disabled) return;
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index; sync(); close(true);
      if (changed) { select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    function open() {
      sync(); if (trigger.disabled || trigger.hidden) return;
      active?.close();
      panel = document.createElement('div'); panel.className = 'app-select-panel'; panel.setAttribute('popover', 'manual');
      search = document.createElement('input'); search.type = 'search'; search.className = 'app-select-search'; search.placeholder = '搜索选项…'; search.autocomplete = 'off';
      search.setAttribute('aria-label', '搜索下拉选项'); search.setAttribute('role', 'combobox'); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-autocomplete', 'list');
      list = document.createElement('div'); list.className = 'app-select-options'; list.id = `${trigger.dataset.selectId}-options`; list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', trigger.getAttribute('aria-label')); search.setAttribute('aria-controls', list.id); trigger.setAttribute('aria-controls', list.id);
      panel.append(search, list); (select.closest('dialog') || root).append(panel);
      panel.showPopover?.(); trigger.setAttribute('aria-expanded', 'true');
      active = { trigger, close, sync, panel }; highlighted = select.selectedIndex;
      position(); render(); search.focus();
      search.addEventListener('input', render);
      panel.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') { close(true); }
        else if (event.key === 'Enter') { event.preventDefault(); if (highlighted >= 0) choose(highlighted); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const enabled = shown.filter(option => !option.disabled), at = enabled.findIndex(option => option.index === highlighted);
          highlighted = enabled[event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.index ?? -1;
          highlight();
        }
      });
    }
    trigger.addEventListener('click', event => { event.preventDefault(); if (panel) close(true); else open(); });
    trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
    select.addEventListener('change', sync);
    // JS assignments to value/selectedIndex do not generate DOM mutations.
    for (const key of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
      Object.defineProperty(select, key, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(); } });
    }
    controls.set(select, { sync }); sync();
  }
  root.querySelectorAll('select').forEach(enhance);
  const observer = new MutationObserver(records => {
    const changed = new Set();
    for (const record of records) {
      const select = record.target.closest?.('select'); if (select) changed.add(select);
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('select')) enhance(node);
        node.querySelectorAll('select').forEach(enhance);
      }
    }
    changed.forEach(select => controls.get(select)?.sync());
    if (active && (!active.trigger.isConnected || !active.trigger.getClientRects().length)) active.close();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'selected', 'label', 'value', 'aria-label', 'title'] });
  document.addEventListener('pointerdown', event => { if (active && !active.panel.contains(event.target) && !active.trigger.contains(event.target)) active.close(); }, true);
  document.addEventListener('close', () => active?.close(), true);
  root.addEventListener('reset', event => queueMicrotask(() => event.target.querySelectorAll('select').forEach(select => controls.get(select)?.sync())));
  window.addEventListener('resize', () => active?.close());
  document.addEventListener('scroll', event => { if (active && !active.panel.contains(event.target)) active.close(); }, true);
}
