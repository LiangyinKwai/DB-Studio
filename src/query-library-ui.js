import {
  upsertQueryLibraryEntry, renameQueryLibraryEntry, removeQueryLibraryEntry,
  exportQueryLibrary, importQueryLibrary, MAX_QUERY_LIBRARY_IMPORT_BYTES,
} from "./query-library.js";
import { matchesWorkspaceSearch } from "./workspace-ux.js";

/** Query reuse stays local; opening a favorite only creates an editor draft. */
export function createQueryLibrary({ refs, getEntries, getProfiles, getCurrentQuery, onChange, onOpen, onExport, confirm, notify, showPane }) {
  const dialog = document.createElement("dialog");
  dialog.className = "query-library-dialog";
  dialog.setAttribute("aria-labelledby", "query-library-title");
  dialog.innerHTML = `
    <form>
      <div class="dialog-header"><div><span class="eyebrow">QUERY LIBRARY</span><h2 id="query-library-title">收藏查询</h2></div><button type="button" class="icon-btn" data-library-close aria-label="关闭收藏窗口">×</button></div>
      <label class="query-library-name">查询名称<input name="title" maxlength="100" required autocomplete="off" placeholder="例如：今日订单汇总" /></label>
      <p class="query-library-context selectable-text"></p>
      <pre class="query-library-preview"><span class="selectable-text"></span></pre>
      <p class="form-note">保存 SQL 与执行位置；打开收藏后可继续编辑。</p>
      <p class="dialog-feedback" role="status" aria-live="polite"></p>
      <div class="dialog-actions"><span class="toolbar-spacer"></span><button class="secondary-btn" type="button" data-library-close>取消</button><button class="primary-btn" type="submit">保存收藏</button></div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const titleInput = form.elements.namedItem("title");
  const feedback = dialog.querySelector(".dialog-feedback");
  let pending = null;
  let previousFocus = null;
  let focusAfterClose = null;
  let view = "history";
  let busy = false;
  const errorText = error => error?.message || String(error);

  const context = entry => {
    const profile = entry.connectionId && getProfiles().find(item => item.id === entry.connectionId);
    return [profile?.name || profile?.driver || (entry.connectionId ? "原连接不可用" : "未绑定连接"),
      entry.database, entry.schema].filter(Boolean).join(" · ");
  };
  const button = (text, label, action) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "quiet-btn";
    node.textContent = text;
    node.title = label;
    node.setAttribute("aria-label", label);
    node.addEventListener("click", () => {
      try { Promise.resolve(action()).catch(error => notify(errorText(error), "error")); }
      catch (error) { notify(errorText(error), "error"); }
    });
    return node;
  };
  const focusEntry = (id, action = "open") => {
    const target = Array.from(refs.queryLibraryList.querySelectorAll("[data-library-id]"))
      .find(node => node.dataset.libraryId === id && node.dataset.libraryAction === action);
    (target || refs.queryLibrarySearch).focus({ preventScroll: true });
  };
  function render() {
    const focused = refs.queryLibraryList.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.libraryId;
    const focusedAction = focused?.dataset.libraryAction;
    const entries = getEntries();
    const matches = entries.filter(entry => matchesWorkspaceSearch(refs.queryLibrarySearch.value, entry.title, entry.sql, context(entry)));
    refs.queryLibraryCount.textContent = String(entries.length);
    refs.queryLibraryMatchCount.textContent = `${matches.length} / ${entries.length} 项收藏`;
    refs.exportQueryLibrary.disabled = !entries.length || busy;
    refs.importQueryLibrary.disabled = busy;
    refs.queryLibraryList.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "small-empty";
      empty.textContent = entries.length ? "没有匹配的收藏，试试其他关键词。" : "将常用 SQL 收藏到这里，下次直接打开。";
      if (!entries.length) empty.append(button("收藏当前查询", "收藏当前查询", () => saveCurrent()));
      refs.queryLibraryList.append(empty);
      if (focused) refs.queryLibrarySearch.focus({ preventScroll: true });
      return;
    }
    for (const entry of matches) {
      const card = document.createElement("div");
      card.className = "query-library-card";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "query-library-open";
      open.dataset.libraryId = entry.id;
      open.dataset.libraryAction = "open";
      open.title = `${context(entry)}\n${entry.sql}`;
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const meta = document.createElement("small");
      meta.textContent = context(entry);
      const sql = document.createElement("code");
      sql.textContent = entry.sql.replace(/\s+/gu, " ");
      open.append(title, meta, sql);
      open.addEventListener("click", () => {
        try { Promise.resolve(onOpen(entry)).catch(error => notify(errorText(error), "error")); }
        catch (error) { notify(errorText(error), "error"); }
      });
      const actions = document.createElement("div");
      actions.className = "query-library-card-actions";
      const rename = button("重命名", `重命名 ${entry.title}`, () => edit(entry, true));
      const remove = button("删除", `删除收藏 ${entry.title}`, async () => {
          if (!await confirm(`删除收藏「${entry.title}」？已打开的 SQL 草稿会保留。`, { title: "删除收藏", acceptLabel: "删除收藏" })) return;
          try { onChange(removeQueryLibraryEntry(getEntries(), entry.id)); render(); notify("已删除收藏"); }
          catch (error) { notify(errorText(error), "error"); }
        });
      for (const [node, action] of [[rename, "rename"], [remove, "remove"]]) {
        node.dataset.libraryId = entry.id;
        node.dataset.libraryAction = action;
      }
      actions.append(rename, remove);
      card.append(open, actions);
      refs.queryLibraryList.append(card);
    }
    if (focused) focusEntry(focusedId, focusedAction);
  }
  function show(selected = "library", focus = true) {
    view = selected;
    const library = selected === "library";
    refs.showQueryLibrary.setAttribute("aria-pressed", String(library));
    refs.showQueryHistory.setAttribute("aria-pressed", String(!library));
    refs.queryLibraryPanel.hidden = !library;
    refs.recentQueries.hidden = library;
    refs.historySearch.closest("label").hidden = library;
    refs.clearHistory.hidden = library;
    if (library) render();
    if (focus) { showPane(); (library ? refs.queryLibrarySearch : refs.historySearch).focus(); }
  }
  function edit(entry, rename = false) {
    if (dialog.open) { titleInput.focus(); return; }
    pending = { ...entry, rename };
    previousFocus = document.activeElement;
    const previousId = previousFocus?.dataset.libraryId;
    const previousAction = previousFocus?.dataset.libraryAction;
    focusAfterClose = () => {
      if (previousFocus?.isConnected && !previousFocus.closest("[hidden]")) previousFocus.focus({ preventScroll: true });
      else if (view === "library") focusEntry(previousId, previousAction);
      else refs.historySearch.focus({ preventScroll: true });
    };
    dialog.querySelector("h2").textContent = rename ? "重命名收藏" : "收藏查询";
    titleInput.value = entry.title || entry.sql.replace(/\s+/gu, " ").slice(0, 100);
    dialog.querySelector(".query-library-context").textContent = context(entry);
    dialog.querySelector(".query-library-preview span").textContent = entry.sql;
    feedback.textContent = "";
    feedback.classList.remove("error");
    dialog.showModal();
    titleInput.focus();
    titleInput.select();
    dialog.querySelector(".query-library-preview").scrollTop = 0;
  }
  function saveCurrent() {
    const entry = getCurrentQuery();
    if (!entry?.sql?.trim()) { notify("请先在 SQL 编辑器中编写或选中查询", "error"); return; }
    edit(entry);
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!pending || !titleInput.value.trim()) { titleInput.focus(); return; }
    try {
      const next = pending.rename
        ? renameQueryLibraryEntry(getEntries(), pending.id, titleInput.value)
        : upsertQueryLibraryEntry(getEntries(), { ...pending, title: titleInput.value });
      onChange(next);
      show("library", false);
      showPane();
      const savedId = pending.rename ? pending.id : next[0]?.id;
      focusAfterClose = () => focusEntry(savedId);
      dialog.close();
      notify("查询收藏已保存");
    } catch (error) { feedback.textContent = errorText(error); feedback.classList.add("error"); }
  });
  dialog.querySelectorAll("[data-library-close]").forEach(node => node.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    pending = null;
    focusAfterClose?.();
    focusAfterClose = null;
    previousFocus = null;
  });
  refs.showQueryHistory.addEventListener("click", () => show("history", false));
  refs.showQueryLibrary.addEventListener("click", () => show("library", false));
  refs.queryLibrarySearch.addEventListener("input", render);
  refs.saveQueryFavorite.addEventListener("click", saveCurrent);
  refs.importQueryLibrary.addEventListener("click", () => refs.queryLibraryFile.click());
  refs.queryLibraryFile.addEventListener("change", async () => {
    const file = refs.queryLibraryFile.files[0];
    if (!file || busy) return;
    busy = true; render();
    try {
      if (file.size > MAX_QUERY_LIBRARY_IMPORT_BYTES) throw new Error(`查询库文件不能超过 ${MAX_QUERY_LIBRARY_IMPORT_BYTES / 1024 / 1024} MiB`);
      const text = await file.text();
      const imported = importQueryLibrary(getEntries(), text);
      onChange(imported.entries);
      notify(`导入完成 · 新增 ${imported.imported} 项 · 更新 ${imported.updated} 项 · 跳过 ${imported.skipped} 项`);
    } catch (error) { notify(`导入失败：${errorText(error)}`, "error"); }
    finally { busy = false; refs.queryLibraryFile.value = ""; render(); }
  });
  refs.exportQueryLibrary.addEventListener("click", async () => {
    if (busy || !getEntries().length) return;
    busy = true; render();
    try { await onExport(exportQueryLibrary(getEntries())); }
    catch (error) { notify(`导出失败：${errorText(error)}`, "error"); }
    finally { busy = false; render(); }
  });
  show("history", false);
  render();
  return { render, saveCurrent, show: () => show("library"), get view() { return view; } };
}
