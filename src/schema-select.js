/** Searchable Schema picker. Browsing options never changes the execution target. */
export function createSchemaSelect({ trigger, label, panel, search, list, empty, count, backButton, onChange, onOpen, onClose, manageTrigger = true }) {
  let options = [], value = "", selectedValue = "", contextKey, activeValue;
  let noun = "Schema";
  let refreshing = false;
  let navigate, selectOption, level;
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.setAttribute("aria-atomic", "true");
  const isOpen = () => !panel.hidden;
  const filtered = () => options.filter((option) =>
    `${option.label} ${option.detail || ""}`.toLowerCase().includes(search.value.trim().toLowerCase()));

  function close(restoreFocus = false) {
    const wasOpen = isOpen();
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (restoreFocus && !trigger.disabled && !trigger.hidden) trigger.focus();
    if (wasOpen) onClose?.();
  }
  function position() {
    if (!isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(0, Math.min(316, window.innerWidth - 16));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upward = below < 220 && above > below;
    panel.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
    panel.style.top = upward ? "auto" : `${rect.bottom + 6}px`;
    panel.style.bottom = upward ? `${window.innerHeight - rect.top + 6}px` : "auto";
  }
  function highlight(scroll = true) {
    let active;
    for (const option of list.children) {
      const matches = option.dataset.value === activeValue;
      option.classList.toggle("active", matches);
      if (matches) active = option;
    }
    if (active) {
      search.setAttribute("aria-activedescendant", active.id);
      if (scroll) active.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else search.removeAttribute("aria-activedescendant");
  }
  function render() {
    const visible = filtered();
    if (!visible.some((option) => option.value === activeValue)) activeValue = visible[0]?.value;
    list.replaceChildren(...visible.map((option, index) => {
      const row = document.createElement("div");
      row.id = `${list.id}-${index}`;
      row.className = "schema-select-option";
      row.dataset.value = option.value;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.value === selectedValue));
      row.title = [option.label, option.detail].filter(Boolean).join(" · ");
      const check = document.createElement("span");
      check.className = "schema-select-check";
      check.textContent = option.value === selectedValue ? "✓" : "";
      check.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "schema-select-copy";
      const name = document.createElement("span");
      name.textContent = option.label;
      copy.append(name);
      if (option.detail) {
        const detail = document.createElement("small");
        detail.textContent = option.detail;
        copy.append(detail);
      }
      row.append(check, copy);
      return row;
    }));
    empty.hidden = visible.length > 0;
    const schemaCount = options.filter(option => option.value !== "" || option.countsAsSchema).length;
    count.textContent = refreshing ? "正在检查列表…" : search.value.trim() ? `${visible.length} 个匹配项` : `${schemaCount} 个${noun === "Schema" ? " Schema" : noun}`;
    highlight();
  }
  function open() {
    if (trigger.disabled || trigger.hidden) return;
    search.value = "";
    activeValue = selectedValue;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-expanded", "true");
    position();
    render();
    search.focus();
    onOpen?.();
  }
  function choose(nextValue) {
    if (!options.some((option) => option.value === nextValue)) return;
    if (navigate) {
      navigate(nextValue);
      return;
    }
    const change = selectOption || onChange;
    const changed = nextValue !== value;
    close(true);
    if (changed) change(nextValue);
  }
  if (manageTrigger) trigger.addEventListener("click", () => isOpen() ? close(true) : open());
  if (manageTrigger) trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    }
  });
  search.addEventListener("input", () => { activeValue = undefined; render(); });
  search.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const visible = filtered();
      const index = visible.findIndex((option) => option.value === activeValue);
      activeValue = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.value;
      highlight();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(activeValue);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      if (event.shiftKey && backButton && level) {
        event.preventDefault();
        backButton.focus();
      } else close(true);
    }
  });
  backButton?.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  list.addEventListener("pointermove", (event) => {
    const row = event.target.closest('[role="option"]');
    if (row && row.dataset.value !== activeValue) { activeValue = row.dataset.value; highlight(false); }
  });
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const row = event.target.closest('[role="option"]');
    if (row) choose(row.dataset.value);
  });
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener("focusin", (event) => {
    if (isOpen() && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  // Viewport changes must not leave keyboard focus in the hidden search box.
  // Only restore focus when this picker currently owns it.
  const closeForViewportChange = () => {
    if (isOpen()) close(panel.contains(document.activeElement));
  };
  window.addEventListener("resize", closeForViewportChange);
  document.addEventListener("scroll", (event) => {
    if (isOpen() && !panel.contains(event.target)) closeForViewportChange();
  }, true);
  return {
    open,
    close,
    update(next) {
      if (next.contextKey !== contextKey || next.disabled || next.hidden) close();
      if (level !== next.level) {
        search.value = "";
        activeValue = next.selectedValue ?? next.value;
      }
      level = next.level;
      navigate = next.navigate;
      selectOption = next.selectOption;
      options = next.options;
      noun = next.noun || "Schema";
      refreshing = Boolean(next.refreshing);
      search.placeholder = `搜索${noun === "Schema" ? " " : ""}${noun}…`;
      search.setAttribute("aria-label", search.placeholder.slice(0, -1));
      list.setAttribute("aria-label", `查询 ${noun}`);
      empty.textContent = `没有匹配的${noun === "Schema" ? " " : ""}${noun}`;
      value = next.value;
      selectedValue = next.selectedValue ?? value;
      contextKey = next.contextKey;
      trigger.value = value ?? "";
      trigger.disabled = next.disabled;
      trigger.hidden = next.hidden;
      if (label) {
        label.textContent = next.label;
        trigger.setAttribute("aria-label", next.ariaLabel || `查询 ${noun}：${next.label}`);
      }
      if (isOpen()) { render(); position(); }
    },
  };
}
