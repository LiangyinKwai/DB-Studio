import { redisKeyTypePresentation } from './redis-key-icons.js';
import { redisPageKeyType } from './redis-key-metadata.js';

const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
const kindLabels = { table: "表", partitioned_table: "分区表", foreign_table: "外部表", view: "视图", materialized_view: "物化视图", sequence: "序列", function: "函数", procedure: "存储过程", "redis-key": "Redis key" };
const dataKinds = new Set(["table", "partitioned_table", "foreign_table", "view", "materialized_view", "redis-key"]);

/** Snapshot only existing caches. This function never loads a catalog or scans Redis. */
export function collectQuickOpenEntries({ profiles = [], activeConnectionId, connectionStatuses = {}, treeSessions = new Map(), objectsBySchema = new Map(), redisPages = new Map(), queryTargets = new Map() } = {}) {
  const entries = new Map();
  const addObject = (profile, object, database, schema) => {
    if (!object?.name) return;
    const entry = { connectionId: profile.id, connectionName: profile.name, driver: profile.driver || "postgres", database: object.database ?? database ?? profile.database ?? "", schema: object.schema ?? schema ?? "", name: object.name, kind: object.kind || "table", columns: object.columns || [], object };
    const id = JSON.stringify([entry.connectionId, entry.database, entry.schema, entry.kind, object.id ?? object.signature ?? entry.name]);
    // The active tree is visited first; a cached completion catalog can still add columns.
    if (!entries.has(id) || (!entries.get(id).columns.length && entry.columns.length)) entries.set(id, entry);
  };
  for (const profile of profiles.slice().sort((a, b) => Number(b.id === activeConnectionId) - Number(a.id === activeConnectionId))) {
    if (connectionStatuses[profile.id] !== "connected") continue;
    const cache = profile.id === activeConnectionId ? { objectsBySchema, redisPages } : treeSessions.get(profile.id);
    for (const [key, objects] of cache?.objectsBySchema || []) {
      const [database, schema] = key.split("\u0000");
      for (const object of objects) addObject(profile, object, database, schema);
    }
    for (const [database, page] of cache?.redisPages || []) {
      for (const key of page.keys || []) {
        const name = typeof key === "string" ? key : key.name ?? key.key;
        if (typeof name !== "string") continue;
        const entry = { connectionId: profile.id, connectionName: profile.name, driver: "redis", database, schema: "", name, key: name, kind: "redis-key", columns: [], type: redisPageKeyType(page, name) ?? (typeof key === 'object' ? key.type : null) };
        entries.set(JSON.stringify([profile.id, database, "redis-key", name]), entry);
      }
    }
    for (const [key, data] of queryTargets) {
      const [connectionId, database] = key.split("\u0000");
      if (connectionId !== profile.id) continue;
      for (const object of data.objects || []) addObject(profile, object, data.context?.database || database);
    }
  }
  return [...entries.values()];
}

/** Supports whitespace terms, db:/schema:/conn:/type:/col: qualifiers and quoted values. */
export function parseObjectQuery(query = "") {
  return [...normalize(query).matchAll(/(?:([^\s:"']+):)?(?:"([^"]*)"|'([^']*)'|([^\s]+))/gu)].map((match) => {
    const field = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    return ["db", "schema", "conn", "type", "col"].includes(field) ? { field, value } : { field: null, value: field ? `${field}:${value}` : value };
  }).filter(({ value }) => value.length);
}

/** Search is local and results are capped even when the caller requests an unsafe limit. */
export function searchQuickOpenEntries(entries, query = "", { limit = 80 } = {}) {
  const terms = parseObjectQuery(query);
  const matches = [];
  for (const [index, entry] of entries.entries()) {
    const columns = (entry.columns || []).map((column) => typeof column === "string" ? column : column.name).filter(Boolean);
    const name = normalize(entry.name);
    const fields = { db: normalize(entry.database), schema: normalize(entry.schema), conn: normalize(entry.connectionName), type: normalize(`${entry.kind} ${kindLabels[entry.kind] || ""} ${entry.type || ""}`), col: normalize(columns.join("\n")) };
    const path = normalize([entry.database, entry.schema !== entry.database ? entry.schema : "", entry.name].filter((value) => value !== "" && value != null).join("."));
    let score = 0;
    let matched = true;
    const matchedColumns = new Set();
    for (const { field, value } of terms) {
      const columnMatches = columns.filter((column) => normalize(column).includes(value));
      if (field) {
        const haystack = field === "db" && entry.driver === "redis" ? `${fields.db} db${fields.db}` : fields[field];
        if (!haystack.includes(value)) { matched = false; break; }
        score += 10;
        if (field === "col") columnMatches.forEach((column) => matchedColumns.add(column));
      } else if (name === value) score += 100;
      else if (name.startsWith(value)) score += 80;
      else if (name.includes(value)) score += 60;
      else if (path.includes(value)) score += 40;
      else if (columnMatches.length) { score += 25; columnMatches.forEach((column) => matchedColumns.add(column)); }
      else if ([fields.conn, fields.type, fields.db, fields.schema].some((text) => text.includes(value))) score += 10;
      else { matched = false; break; }
    }
    if (matched) matches.push({ entry, matchedColumns: [...matchedColumns], score, index });
  }
  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(120, Math.floor(limit))) : 80;
  return { matches: matches.slice(0, safeLimit), total: matches.length, truncated: matches.length > safeLimit };
}

let sequence = 0;

/** getEntries is synchronous and cache-only; onOpen(entry, {structure}) owns actual navigation. */
export function createObjectQuickOpen({ getEntries, onOpen, onError = console.error }) {
  const prefix = `object-quick-open-${++sequence}`;
  const dialog = document.createElement("dialog");
  dialog.className = "object-quick-open";
  dialog.setAttribute("aria-labelledby", `${prefix}-title`);
  dialog.innerHTML = `<div class="object-quick-open-heading"><h2 id="${prefix}-title">快速打开对象</h2><span>搜索已加载的表、字段和 Redis key</span></div>
    <div class="object-quick-open-search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="text" role="combobox" aria-label="搜索对象" aria-autocomplete="list" aria-controls="${prefix}-list" aria-expanded="false" placeholder="对象名、字段名，或 db:库名 schema:名称…" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="object-quick-open-close" title="关闭（Esc）" aria-label="关闭对象搜索"><kbd>Esc</kbd></button></div>
    <div class="object-quick-open-scope">仅搜索已加载目录；展开左侧数据库可加载更多对象。</div>
    <div class="object-quick-open-results" id="${prefix}-list" role="listbox" aria-label="匹配对象"></div>
    <div class="object-quick-open-empty" hidden><strong>没有匹配的对象</strong><span>试试更短的关键词，或先在左侧展开数据库。</span></div>
    <div class="object-quick-open-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>Shift ↵</kbd> 结构</span><span class="object-quick-open-count" role="status" aria-live="polite" aria-atomic="true"></span></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector("input");
  const results = dialog.querySelector(".object-quick-open-results");
  const empty = dialog.querySelector(".object-quick-open-empty");
  const count = dialog.querySelector(".object-quick-open-count");
  let entries = [], visible = [], selected = -1, previousFocus = null, composing = false;
  const restoreFocus = () => {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
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
    selected = index;
    results.querySelectorAll("[role='option']").forEach((option) => option.setAttribute("aria-selected", String(Number(option.dataset.index) === index)));
    const option = results.querySelector(`[data-index="${index}"]`);
    if (option) { input.setAttribute("aria-activedescendant", option.id); if (scroll) option.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const run = (index, structure = false) => {
    const entry = visible[index]?.entry;
    if (!entry) return;
    close();
    try { Promise.resolve(onOpen(entry, { structure: entry.driver === "redis" ? false : structure || !dataKinds.has(entry.kind) })).catch(onError); }
    catch (error) { onError(error); }
  };
  const render = () => {
    const search = searchQuickOpenEntries(entries, input.value);
    visible = search.matches;
    results.replaceChildren();
    for (const [index, { entry, matchedColumns }] of visible.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "object-quick-open-option";
      option.id = `${prefix}-option-${index}`;
      option.dataset.index = String(index);
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      const kind = document.createElement("span");
      kind.className = "object-quick-open-kind";
      if (entry.kind === 'redis-key') {
        const type = redisKeyTypePresentation(entry.type);
        kind.innerHTML = type.icon; kind.title = type.label;
      } else kind.textContent = kindLabels[entry.kind] || entry.kind;
      const copy = document.createElement("span");
      copy.className = "object-quick-open-copy";
      const title = document.createElement("strong");
      title.textContent = entry.object?.signature || entry.name;
      title.title = title.textContent;
      const path = document.createElement("span");
      path.className = "object-quick-open-path";
      path.textContent = [entry.connectionName, entry.driver === "redis" ? `DB ${entry.database}` : entry.database, entry.driver !== "redis" && entry.schema !== entry.database ? entry.schema : ""].filter((value) => value !== "" && value != null).join(" / ");
      path.title = path.textContent;
      copy.append(title, path);
      if (matchedColumns.length) {
        const columns = document.createElement("span");
        columns.className = "object-quick-open-columns";
        columns.textContent = `匹配字段：${matchedColumns.slice(0, 4).join("、")}${matchedColumns.length > 4 ? ` 等 ${matchedColumns.length} 项` : ""}`;
        copy.append(columns);
      }
      option.append(kind, copy);
      option.addEventListener("pointermove", () => { if (selected !== index) select(index, false); });
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", (event) => run(index, event.shiftKey));
      results.append(option);
    }
    empty.hidden = visible.length > 0;
    results.hidden = visible.length === 0;
    count.textContent = search.truncated ? `显示 ${visible.length} / ${search.total} 项，请缩小范围` : `${search.total} 个对象`;
    select(visible.length ? 0 : -1, false);
    results.scrollTop = 0;
  };
  const open = (initialQuery = "") => {
    try {
      entries = getEntries();
      if (!dialog.open) previousFocus = document.activeElement;
      input.value = String(initialQuery ?? "");
      render();
      if (!dialog.open) dialog.showModal();
      input.setAttribute("aria-expanded", "true");
      input.focus({ preventScroll: true });
    } catch (error) { onError(error); }
  };
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; render(); });
  input.addEventListener("input", () => { if (!composing) render(); });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) { if (event.key === "Escape") event.preventDefault(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); run(selected, event.shiftKey); return; }
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (visible.length) select((selected + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
  });
  dialog.querySelector(".object-quick-open-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!composing) close(); });
  dialog.addEventListener("close", () => { if (!dialog.open) restoreFocus(); });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  return { open, close, toggle: () => dialog.open ? close() : open(), isOpen: () => dialog.open, destroy: () => { close(); dialog.remove(); } };
}
