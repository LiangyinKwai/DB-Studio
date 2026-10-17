const types = [
  { value: "string", label: "String", icon: "Aa", detail: "字符串 · 文本、数字或 JSON" },
  { value: "hash", label: "Hash", icon: "{}", detail: "哈希 · 字段与值" },
  { value: "list", label: "List", icon: "[]", detail: "列表 · 有序元素" },
  { value: "set", label: "Set", icon: "∈", detail: "集合 · 不重复的成员" },
  { value: "zset", label: "Sorted Set", icon: "Z", detail: "有序集合 · 按分数排序" },
];

export function createRedisTypePicker({ input, trigger, menu, label, icon, detail, dialog }) {
  function close(restoreFocus = false) {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function render() {
    const selected = types.find(type => type.value === input.value) || types[0];
    label.textContent = selected.label;
    icon.textContent = selected.icon;
    detail.textContent = selected.detail;
    menu.replaceChildren(...types.map(type => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "driver-option redis-type-option";
      option.dataset.redisType = type.value;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(type.value === selected.value));
      option.tabIndex = -1;
      const badge = document.createElement("span");
      badge.className = "driver-picker-icon"; badge.textContent = type.icon; badge.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span"); copy.className = "redis-type-copy";
      const name = document.createElement("strong"); name.textContent = type.label;
      const description = document.createElement("small"); description.textContent = type.detail;
      copy.append(name, description);
      const check = document.createElement("span");
      check.className = "driver-choice-check"; check.textContent = "✓"; check.setAttribute("aria-hidden", "true");
      option.append(badge, copy, check);
      option.addEventListener("click", () => {
        input.value = type.value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        render(); close(true);
      });
      return option;
    }));
  }
  function open() {
    render();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-selected="true"]')?.focus();
  }
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(); }
  });
  menu.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.children];
    const index = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !trigger.contains(event.target) && !menu.contains(event.target)) close();
  });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("cancel", event => {
    if (!menu.hidden) { event.preventDefault(); close(true); }
  });
  render();
  return { reset: () => { input.value = types[0].value; close(); render(); } };
}
