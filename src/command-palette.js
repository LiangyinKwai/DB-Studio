const normalizeSearch = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase().trim();

/** Match every search term and prefer titles over supplementary search metadata. */
export function filterCommands(commands, query = "") {
  const search = normalizeSearch(query);
  const terms = search.split(/\s+/u).filter(Boolean);
  return commands
    .map((command, index) => {
      const title = normalizeSearch(command.title);
      const keywords = normalizeSearch(Array.isArray(command.keywords) ? command.keywords.join(" ") : command.keywords);
      const description = normalizeSearch(command.description);
      const group = normalizeSearch(command.group);
      let score = 0;
      for (const term of terms) {
        if (title === term) score += 120;
        else if (title.startsWith(term)) score += 100;
        else if (title.includes(term)) score += 80;
        else if (keywords.includes(term)) score += 50;
        else if (description.includes(term)) score += 25;
        else if (group.includes(term)) score += 10;
        else return null;
      }
      if (search && title === search) score += 100;
      return { command, index, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ command }) => command);
}

let paletteSequence = 0;

/** Creates a local dialog. The caller owns global shortcuts and available actions. */
export function createCommandPalette({ getCommands, onError = console.error }) {
  const prefix = `command-palette-${++paletteSequence}`;
  const dialog = document.createElement("dialog");
  dialog.className = "command-palette";
  dialog.setAttribute("aria-labelledby", `${prefix}-title`);
  dialog.innerHTML = `
    <div class="command-palette-heading">
      <h2 id="${prefix}-title">快速操作</h2>
      <span>搜索命令、连接与查询</span>
    </div>
    <div class="command-palette-search">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
      <input type="text" role="combobox" aria-label="搜索快速操作" aria-autocomplete="list" aria-controls="${prefix}-list" aria-expanded="false" placeholder="输入命令或名称…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button type="button" class="command-palette-close" aria-label="关闭快速操作" title="关闭（Esc）"><kbd>Esc</kbd></button>
    </div>
    <div class="command-palette-results" id="${prefix}-list" role="listbox" aria-label="可用操作"></div>
    <div class="command-palette-empty" hidden>
      <strong>未找到匹配的操作</strong>
      <span>试试更短的关键词，或搜索连接和查询名称。</span>
    </div>
    <div class="command-palette-footer">
      <span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>↵</kbd> 执行</span>
      <span class="command-palette-count" role="status" aria-live="polite" aria-atomic="true"></span>
    </div>`;
  document.body.append(dialog);

  const input = dialog.querySelector("input");
  const results = dialog.querySelector(".command-palette-results");
  const empty = dialog.querySelector(".command-palette-empty");
  const count = dialog.querySelector(".command-palette-count");
  let commands = [];
  let visible = [];
  let selectedIndex = -1;
  let previousFocus = null;

  const restoreFocus = () => {
    input.setAttribute("aria-expanded", "false");
    const target = previousFocus;
    previousFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  const close = () => {
    if (!dialog.open) return;
    dialog.close();
    restoreFocus();
  };

  const select = (index, scroll = true) => {
    selectedIndex = index;
    results.querySelectorAll("[role='option']").forEach((option) => {
      option.setAttribute("aria-selected", String(Number(option.dataset.index) === index));
    });
    const option = index < 0 ? null : results.querySelector(`[data-index="${index}"]`);
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const run = (index) => {
    const command = visible[index];
    if (!command || command.disabled || typeof command.run !== "function") return;
    close();
    try {
      Promise.resolve(command.run()).catch(onError);
    } catch (error) {
      onError(error);
    }
  };

  const render = () => {
    const matches = filterCommands(commands, input.value);
    const groups = new Map();
    for (const command of matches) {
      const group = command.group || "操作";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(command);
    }
    // Keep keyboard movement in the same order as the grouped visual results.
    visible = [...groups.values()].flat();
    results.replaceChildren();
    let index = 0;
    for (const [name, members] of groups) {
      const group = document.createElement("div");
      group.className = "command-palette-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", name);
      const heading = document.createElement("div");
      heading.className = "command-palette-group-title";
      heading.textContent = name;
      heading.setAttribute("aria-hidden", "true");
      group.append(heading);
      for (const command of members) {
        const optionIndex = index++;
        const option = document.createElement("button");
        option.type = "button";
        option.className = "command-palette-option";
        option.id = `${prefix}-option-${optionIndex}`;
        option.dataset.index = String(optionIndex);
        option.tabIndex = -1;
        option.setAttribute("role", "option");
        option.setAttribute("aria-disabled", String(Boolean(command.disabled)));
        option.disabled = Boolean(command.disabled);
        const copy = document.createElement("span");
        copy.className = "command-palette-copy";
        const title = document.createElement("span");
        title.className = "command-palette-option-title";
        title.textContent = command.title;
        copy.append(title);
        if (command.description) {
          const description = document.createElement("span");
          description.className = "command-palette-description";
          description.textContent = command.description;
          copy.append(description);
        }
        option.append(copy);
        if (command.shortcut) {
          const shortcut = document.createElement("kbd");
          shortcut.className = "command-palette-shortcut";
          shortcut.textContent = command.shortcut;
          option.append(shortcut);
        }
        if (command.disabled) {
          const disabledLabel = document.createElement("span");
          disabledLabel.className = "command-palette-unavailable";
          disabledLabel.textContent = "暂不可用";
          option.append(disabledLabel);
        }
        option.addEventListener("pointermove", () => {
          if (!command.disabled && selectedIndex !== optionIndex) select(optionIndex, false);
        });
        // Keep input focus so typing can continue immediately after pointer navigation.
        option.addEventListener("pointerdown", (event) => event.preventDefault());
        option.addEventListener("click", () => run(optionIndex));
        group.append(option);
      }
      results.append(group);
    }
    empty.hidden = visible.length > 0;
    results.hidden = visible.length === 0;
    count.textContent = `${visible.length} 项操作`;
    select(visible.findIndex((command) => !command.disabled), false);
    results.scrollTop = 0;
  };

  const open = (initialQuery = "") => {
    try {
      commands = getCommands();
      if (!dialog.open) previousFocus = document.activeElement;
      input.value = String(initialQuery ?? "");
      render();
      if (!dialog.open) dialog.showModal();
      input.setAttribute("aria-expanded", "true");
      input.focus({ preventScroll: true });
    } catch (error) {
      onError(error);
    }
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      run(selectedIndex);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const enabled = visible.map((command, index) => command.disabled ? -1 : index).filter((index) => index !== -1);
    if (!enabled.length) return;
    const current = enabled.indexOf(selectedIndex);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? enabled.length - 1
      : event.key === "ArrowDown" ? (current + 1) % enabled.length
      : (current - 1 + enabled.length) % enabled.length;
    select(enabled[next]);
  });
  dialog.querySelector(".command-palette-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) restoreFocus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });

  return { open, close, toggle: () => dialog.open ? close() : open() };
}
