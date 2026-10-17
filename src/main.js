import { acceptCompletion, autocompletion, closeBrackets, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  HighlightStyle,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { format as formatSqlText } from "sql-formatter";
import { ResultGrid, formatCellValue, formatClipboardRows } from "./result-grid.js";
import {
  historyConnectionId,
  historyContext,
  historyDatabase,
  MAX_HISTORY_ENTRIES,
  normalizeHistory,
  prependHistoryEntry,
} from "./query-history.js";
import { resolveSaveOutcome } from "./save-outcome.js";
import { isQueryCancellation } from "./query-status.js";
import { canHandleGlobalShortcut } from "./keyboard-shortcuts.js";
import { isCurrentConnectionRequest } from "./request-state.js";
import { initWorkspaceLayout } from "./workspace-layout.js";
import { buildCompletionSchema, catalogCompletionSource, matchingColumns, objectMatchesSearch, queryStructureObjects } from "./sql-catalog.js";
import { createConfirmationDialog } from "./confirmation-dialog.js";
import { sqlExecutionInfo } from "./sql-execution.js";
import { createSchemaSelect } from "./schema-select.js";
import { sqlIme } from "./sql-ime.js";
import { initPasswordFields } from "./password-fields.js";
import { openStructureEditor, structureFingerprint } from "./structure-editor.js";
import { MAX_QUERY_TABS, restorableWorkspaceTabs } from "./workspace-tabs.js";
import { normalizeQueryLibrary } from "./query-library.js";
import { createQueryLibrary } from "./query-library-ui.js";
import { estimateResultBytes, selectResultsToRelease } from "./query-memory.js";
import { createCommandPalette } from "./command-palette.js";
import { matchesWorkspaceSearch, historyTimeLabel, emptyResultAction, runEmptyResultAction } from "./workspace-ux.js";
import { createSqlExecutionKeymap } from "./sql-shortcuts.js";
import { getCellEditCapability, buildCellUpdateSql, validateCellDraft, cellColumnName, sqlValueLiteral } from "./cell-edit.js";
import { buildTableDdl } from "./table-ddl.js";
import { setSelectableText } from "./selectable-text.js";
import { initDesktopMenu } from "./desktop-menu.js";
import { redisCompletionSource, redisCommandHint } from "./redis-completion.js";
import { createRedisTypePicker } from "./redis-type-picker.js";
import { createRedisEditor, redisLanguage } from "./redis-editor.js";
import { resolveRedisDatabase } from "./redis-target.js";
import { orderedObjectGroups, syncTreeToggle, setTreeRowExpanded, treeBranchForDoubleClick } from "./object-tree.js";

const invoke = window.__TAURI__?.core?.invoke;
const refs = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((node) => [node.id, node]),
);
const confirmAction = createConfirmationDialog(refs.confirmActionModal);
const passwordFields = initPasswordFields();
const querySchemaSelect = createSchemaSelect({
  trigger: refs.querySchema, label: refs.querySchemaLabel, panel: refs.querySchemaMenu,
  search: refs.querySchemaSearch, list: refs.querySchemaList, empty: refs.querySchemaEmpty,
  count: refs.querySchemaCount, onChange: changeQuerySchema,
});
let queryStructureChoice = null;
const queryStructureSelect = createSchemaSelect({
  trigger: refs.structureTab, panel: refs.queryStructureMenu,
  search: refs.queryStructureSearch, list: refs.queryStructureList, empty: refs.queryStructureEmpty,
  count: refs.queryStructureCount, noun: "表与视图", manageTrigger: false,
  onChange(value) {
    const choice = queryStructureChoice;
    const object = choice?.objects[Number(value)];
    if (object && choice.current()) void openObjectStructureTab(object, choice.connectionId);
  },
});
// A newly opened workspace should be empty.  A query is created when the user
// explicitly asks for one (⌘T) or opens an object from the tree; showing a
// pre-filled diagnostic query on first launch makes the app look as if it has
// already started working against an unknown database.
const defaultSql = "";
const tabsKey = "db-studio.workspace-tabs.v2";
const historyKey = "db-studio.query-history.v2";
const queryLibraryKey = "db-studio.query-library.v1";
const themeKey = "db-studio.theme.v1";
const emptyResult = () => ({
  columns: [],
  rows: [],
  rowCount: null,
  elapsedMs: null,
  truncated: false,
  truncatedReason: null,
  executed: false,
});
const kindLabels = {
  table: "表",
  partitioned_table: "分区表",
  view: "视图",
  materialized_view: "物化视图",
  foreign_table: "外部表",
  sequence: "序列",
  function: "函数",
  procedure: "过程",
};
const svgIcon = (body) =>
  `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
// One disclosure glyph for databases, schemas, object groups and Redis DBs.
const treeDisclosureIcon = '<svg class="tree-disclosure" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 3.5 4.5 4.5-4.5 4.5"/></svg>';
function treeToggle(label, expanded) {
  return `<button class="tree-toggle" type="button" data-tree-toggle data-tree-label="${escapeHtml(label)}" aria-label="${expanded ? "收起" : "展开"} ${escapeHtml(label)}" aria-expanded="${Boolean(expanded)}">${treeDisclosureIcon}</button>`;
}
const databaseIcon = svgIcon(
  '<ellipse cx="12" cy="5" rx="7" ry="3.2"/><path d="M5 5v6c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2V5"/><path d="M5 11v6c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-6"/>',
);
const schemaIcon = svgIcon(
  '<path d="M12 3 19 7v10l-7 4-7-4V7l7-4Z"/><path d="m5 7 7 4 7-4M12 11v10"/>',
);
const instanceIcon = svgIcon(
  '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 8h8M8 12h5M8 16h8"/><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none"/>',
);
const postgresIcon = svgIcon(
  '<path d="M7 18.5c-2.4-.8-3-3-3-6V8.7C4 5.6 6.8 3 12 3s8 2.6 8 5.7v3.8c0 2.3-.9 4.1-2.7 5.3"/><path d="M8 9c.7-1.1 1.7-1.6 4-1.6s3.3.5 4 1.6M9 17.5c0 1.9 1.1 3.5 3 3.5s3-1.6 3-3.5v-6.4c0-.9-.8-1.6-3-1.6s-3 .7-3 1.6v6.4Z"/><path d="M9 14.2c-1.4.1-2.3-.3-2.8-1.2M15 14.2c1.4.1 2.3-.3 2.8-1.2"/>',
);
const redisIcon = svgIcon(
  '<path d="m12 3 9 4.2-9 4.2-9-4.2L12 3Z"/><path d="m3 11 9 4.2 9-4.2M3 15 12 19l9-4"/><path d="m3 7.2 9 4.2 9-4.2"/><circle cx="12" cy="7.2" r=".8" fill="currentColor" stroke="none"/>',
);
const mysqlIcon = svgIcon(
  '<path d="M3 8.5c2.5-4 5.2-4 7.7 0s5.2 4 7.7 0"/><path d="M3 8.5v5c2.5 4 5.2 4 7.7 0 2.5 4 5.2 4 7.7 0v-5"/><path d="M3 13.5c2.5 4 5.2 4 7.7 0 2.5 4 5.2 4 7.7 0"/><path d="M17 8.5h4v10h-4"/>',
);
const driverIcon = (driver) => driver === "redis" ? redisIcon : driver === "mysql" ? mysqlIcon : postgresIcon;
// The gap between the database and the plug is the connection state. Keep the
// short cable in both variants so the symbol reads as a connection, not power.
const connectionDatabaseGlyph = '<ellipse cx="8.5" cy="6" rx="6.2" ry="2.6"/><path d="M2.3 6v14c0 1.5 2.8 2.6 6.2 2.6s6.2-1.1 6.2-2.6V6M2.3 13c0 1.5 2.8 2.6 6.2 2.6s6.2-1.1 6.2-2.6"/>';
const connectionStateIcon = (plug) =>
  `<svg class="ui-icon connection-state-icon" viewBox="0 0 44 28" aria-hidden="true">${connectionDatabaseGlyph}${plug}</svg>`;
const connectIcon = connectionStateIcon(
  '<path d="M20 11h5M20 17h5M25 8.5h4a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4h-4zM33 14h1.5c2.5 0 2 6 5 6h2"/>',
);
const disconnectIcon = connectionStateIcon(
  '<path d="M12.5 11h4M12.5 17h4M16.5 8.5h4a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4h-4zM24.5 14h2.5c2.5 0 2 6 5 6h5"/>',
);
const kindIcons = {
  table: svgIcon('<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 10h16M10 10v9M15 10v9"/>'),
  partitioned_table: svgIcon('<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 10h16M10 10v9M15 10v9M8 3h8"/>'),
  view: svgIcon('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/>'),
  materialized_view: svgIcon('<path d="M4 6h16v12H4z"/><path d="m7 14 3-3 2 2 3-4 2 3"/>'),
  foreign_table: svgIcon('<path d="M7 7h10M7 17h10M5 12h14M8 4l-3 3 3 3M16 14l3 3-3 3"/>'),
  sequence: svgIcon('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>'),
  function: svgIcon('<path d="M7 4c4 0 2 5 6 5s2 5 6 5M7 20c4 0 2-5 6-5s2-5 6-5"/>'),
  procedure: svgIcon('<circle cx="12" cy="12" r="7"/><path d="m9 12 2 2 4-4"/>'),
};
const frequentSqlKeywords = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "ON", "AS", "AND", "OR", "NOT", "NULL", "ORDER", "BY", "GROUP",
  "HAVING", "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE",
  "SET", "DELETE", "RETURNING", "CREATE", "ALTER", "DROP", "WITH",
]);
function sqlKeywordCompletion(label, type) {
  return { label, type, boost: frequentSqlKeywords.has(label.toUpperCase()) ? 10 : -10 };
}

function objectTabTarget(object, connectionId) {
  if (!object?.name || !object?.schema) return null;
  return {
    id: object.id || null,
    connectionId: connectionId || null,
    database: object.database ?? null,
    schema: object.schema,
    name: object.name,
    kind: object.kind || null,
  };
}
function matchesObjectTab(tab, target, view) {
  if (!target) return false;
  if (view === "data" && (!tab.browse || tab.tableView === false)) return false;
  const opened = tab.openedObject || tab.browse;
  const openedView = tab.openedObjectView || (tab.browse ? "data" : null);
  return openedView === view && opened?.connectionId === target.connectionId &&
    (opened?.database ?? null) === target.database && opened?.schema === target.schema && opened?.name === target.name;
}
function findObjectTab(target, view) {
  return state.tabs.find((tab) => tab.id === state.activeTabId && matchesObjectTab(tab, target, view)) ||
    state.tabs.find((tab) => matchesObjectTab(tab, target, view));
}

function completionKind(completion) {
  const badge = document.createElement("span");
  badge.className = "cm-completionKind";
  badge.textContent = completion.kindLabel || ({ property: "字段", class: "表", namespace: "Schema",
    keyword: "关键字", function: "函数", type: "类型", constant: "别名" })[completion.type] || "SQL";
  return badge;
}

function readTabs() {
  try {
    const value = JSON.parse(
      localStorage.getItem(tabsKey) ||
        localStorage.getItem("db-studio.query-tabs.v1") ||
        "null",
    );
    return restorableWorkspaceTabs(value)
      .map((tab, index) => {
        // SQL text never determines a table binding; only a saved data browser does.
        const browse = tab.tableView === false ? null : tab.browse;
        const normalizedBrowse = browse
          ? { ...browse, connectionId: browse.connectionId || tab.connectionId || null }
          : null;
        const savedObject = normalizedBrowse || (tab.openedObjectView === "structure" ? tab.openedObject : null);
        const detachedQuery = !savedObject && !tab.redisKey && (tab.browse || tab.openedObject);
        return {
        id: tab.id || `query-${index + 1}`,
        title: detachedQuery ? `查询 ${index + 1}` : tab.title || `查询 ${index + 1}`,
        sql: tab.sql,
        connectionId: tab.connectionId || null,
        database: tab.database || tab.browse?.database || tab.openedObject?.database || null,
        schema: Object.hasOwn(tab, "schema") ? tab.schema : tab.browse?.schema ?? tab.openedObject?.schema ?? null,
        mode: tab.readOnly === true || tab.mode === "read" ? "read" : "write",
        browse: normalizedBrowse,
        openedObject: savedObject ? objectTabTarget(savedObject, savedObject.connectionId || tab.connectionId) : null,
        openedObjectView: savedObject ? tab.openedObjectView || "data" : null,
        result: emptyResult(),
        message: "",
        outputTab: "result",
        filter: "",
        redisKey: typeof tab.redisKey === "string" ? tab.redisKey : null,
        redisDb: Number.isInteger(tab.redisDb) && tab.redisDb >= 0 ? tab.redisDb : null,
        console: tab.console === true,
        consoleHistory: Array.isArray(tab.consoleHistory) ? tab.consoleHistory.slice(-100) : [],
        tableView: Boolean(normalizedBrowse || (tab.redisKey && tab.tableView !== false)),
        };
      });
  } catch {
    return [];
  }
}
function readHistory() {
  try {
    return normalizeHistory(JSON.parse(localStorage.getItem(historyKey) || "[]"));
  } catch {
    return [];
  }
}
function readQueryLibrary() {
  try { return normalizeQueryLibrary(JSON.parse(localStorage.getItem(queryLibraryKey) || "[]")); }
  catch { return []; }
}
function saveQueryLibrary(entries) {
  // Persist before changing the visible state so a full disk never looks saved.
  try { localStorage.setItem(queryLibraryKey, JSON.stringify(entries)); }
  catch { throw new Error("收藏保存失败，本地存储空间不足或不可用。请导出备份后重试。"); }
  state.queryLibrary = entries;
}
function persistTabs() {
  try {
    const tabs = restorableWorkspaceTabs(
        state.tabs.map(({ id, title, sql, connectionId, database, schema, mode, browse, openedObject, openedObjectView, redisKey, redisDb, console, consoleHistory, tableView }) => ({
          id,
          title,
          sql,
          connectionId,
          database,
          schema,
          readOnly: mode === "read",
          redisKey: redisKey || null,
          redisDb: Number.isInteger(redisDb) ? redisDb : null,
          console: console === true,
          consoleHistory: console === true ? (consoleHistory || []).slice(-100) : [],
          tableView: tableView !== false,
          openedObject: openedObject ? { ...openedObject } : null,
          openedObjectView: openedObjectView || null,
          browse: browse
            ? {
                id: browse.id,
                connectionId: browse.connectionId || connectionId || null,
                database: browse.database,
                schema: browse.schema,
                name: browse.name,
                kind: browse.kind,
                page: browse.page || 0,
                pageSize: browse.pageSize || 500,
                columns: browse.columns || null,
                primaryKeys: browse.primaryKeys || null,
                tableView: browse.tableView !== false,
              }
            : null,
        })),
    );
    localStorage.setItem(tabsKey, JSON.stringify(tabs));
    const active = tabs.find((tab) => tab.id === state.activeTabId) || tabs.at(-1);
    localStorage.setItem(`${tabsKey}.active`, active?.id || "");
  } catch {}
}
function persistHistory() {
  try {
    localStorage.setItem(
      historyKey,
      JSON.stringify(state.history.slice(0, MAX_HISTORY_ENTRIES)),
    );
  } catch {}
}
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function errorText(error) {
  return error?.message ? error.message : String(error || "未知错误");
}
const themeNames = new Set(["dark", "light", "ocean", "forest", "contrast"]);
function readTheme() {
  try {
    const value = localStorage.getItem(themeKey);
    return themeNames.has(value) ? value : "dark";
  } catch {
    return "dark";
  }
}
function applyTheme(theme) {
  const selected = themeNames.has(theme) ? theme : "dark";
  document.body.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected === "light" ? "light" : "dark";
  const labels = { dark: "暗黑", light: "白天", ocean: "海蓝", forest: "森林", contrast: "高对比" };
  if (refs.themeButtonLabel) refs.themeButtonLabel.textContent = labels[selected];
  if (refs.themeButtonSwatch) refs.themeButtonSwatch.className = `theme-swatch theme-${selected}`;
  refs.themeMenu?.querySelectorAll("[data-theme-option]").forEach((option) => {
    option.setAttribute("aria-checked", String(option.dataset.themeOption === selected));
  });
  try {
    localStorage.setItem(themeKey, selected);
  } catch {}
}
function toggleMode() {
  const tab = activeTab();
  if (!tab || cellWritePending(tab)) return;
  tab.mode = tab.mode === "read" ? "write" : "read";
  persistTabs();
  renderTabs();
  if (state.editor) renderOutput();
}
function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
function activeTab() {
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0]
  );
}
// The temporary Redis console covers the tab workspace. Its input, controls
// and execution must all refer to this same surface, not the tab underneath.
function activeExecutionTab() {
  return state.redisConsole || activeTab();
}
function closeRedisConsole() {
  if (!state.redisConsole) return;
  state.redisConsole = null;
  renderTabs();
  renderOutput();
}
function tabDatabase(tab = activeTab()) {
  return tab?.browse?.database || tab?.database || state.profiles.find((p) => p.id === tab?.connectionId)?.database || "";
}
function tabSchema(tab = activeTab()) {
  return tab?.browse?.schema ?? tab?.schema ?? null;
}
function queryTargetKey(tab) {
  return transactionKey(tab?.connectionId, tabDatabase(tab));
}
function queryTargetData(tab = activeTab()) {
  return state.queryTargets.get(queryTargetKey(tab));
}
function queryTargetLocked(tab = activeTab()) {
  return !tab || Boolean(tab.structureOnly || (tab.browse && tab.tableView !== false) || tab.redisKey || tab.console || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction ||
    state.transactionKeys.has(queryTargetKey(tab)));
}
function queryTargetDescription(tab = activeTab()) {
  const profile = state.profiles.find((item) => item.id === tab?.connectionId);
  const data = queryTargetData(tab);
  const database = tabDatabase(tab) || data?.context?.database || "未选择数据库";
  const schema = tabSchema(tab) || (data?.context?.searchPath || []).join(" → ") || "无默认 schema";
  return `${profile?.name || (tab?.connectionId ? "原连接不可用" : "未选择连接")} / ${database}${profile?.driver === "postgres" || !profile?.driver ? ` / ${schema}${tabSchema(tab) ? "" : "（默认搜索路径）"}` : ""}`;
}
async function loadQueryTarget(tab = activeTab(), force = false) {
  if (!tab?.connectionId || driverForTab(tab) === "redis") return null;
  const key = queryTargetKey(tab);
  const cached = state.queryTargets.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && !force) return cached;
  const entry = { loading: true, error: null, context: null, schemas: [] };
  state.queryTargets.set(key, entry);
  const args = { connectionId: tab.connectionId, database: tabDatabase(tab) || null };
  entry.pending = (async () => {
    const results = await Promise.allSettled([
      call("get_query_context", args),
      driverForTab(tab) === "mysql" ? Promise.resolve([]) : call("list_schemas", args),
    ]);
    if (state.queryTargets.get(key) !== entry) return entry;
    const [context, schemas] = results;
    if (context.status === "fulfilled") entry.context = context.value;
    else entry.error = errorText(context.reason);
    if (schemas.status === "fulfilled") entry.schemas = schemas.value;
    entry.catalogError = results.slice(1).filter((item) => item.status === "rejected").map((item) => errorText(item.reason)).join("；");
    entry.loading = false;
    entry.pending = null;
    renderTabs();
    return entry;
  })();
  return entry.pending;
}
function renderQueryTarget(tab = activeExecutionTab()) {
  refs.queryTargetBar.hidden = !tab || Boolean(tab.console);
  refs.queryTargetDetail.hidden = true;
  if (!tab) {
    querySchemaSelect.update({ contextKey: null, hidden: true, disabled: true, options: [], value: "", label: "Schema" });
    return;
  }
  const profile = state.profiles.find((item) => item.id === tab.connectionId);
  const isRedis = profile?.driver === "redis";
  const isPostgres = Boolean(profile && !["redis", "mysql"].includes(profile.driver));
  let data = queryTargetData(tab);
  if (profile && !isRedis && !data) {
    void loadQueryTarget(tab);
    data = queryTargetData(tab);
  }
  const database = isRedis ? `DB ${redisTabDatabase(tab)}` : tabDatabase(tab) || data?.context?.database || "未选择数据库";
  const defaultPath = (data?.context?.searchPath || []).join(" → ") || "无可用 schema";
  const schema = tabSchema(tab);
  const schemas = [...new Set([...(schema ? [schema] : []), ...(data?.schemas || []).map((item) => item.name)])];
  const defaultLabel = data?.context ? `默认（${defaultPath}）` : data?.error ? "读取失败" : "读取中…";
  querySchemaSelect.update({
    contextKey: `${tab.id}:${queryTargetKey(tab)}`, hidden: !isPostgres,
    disabled: queryTargetLocked(tab) || !profile || Boolean(data?.loading),
    value: schema || "", label: schema || defaultLabel,
    options: [{ value: "", label: defaultPath, detail: "使用连接的默认搜索路径" }, ...schemas.map((name) => ({ value: name, label: name }))],
  });
  const source = profile ? `${profile.name} / ${database}` : "请先从左侧选择连接";
  const endpoint = profile ? `${profile.host}:${profile.port}${profile.user ? ` · ${profile.user}` : ""}` : "";
  const detail = `${source}\n${endpoint}${isPostgres ? `\nSchema：${schema || `默认（${defaultPath}）`}\n未限定表名使用当前 Schema，SQL 中显式指定的 Schema 优先。` : ""}`;
  refs.querySchema.title = detail;
  refs.queryTargetContext.hidden = isPostgres;
  refs.queryTargetContext.textContent = profile ? database : "未绑定连接";
  refs.queryTargetContext.title = detail;
  refs.queryTargetBar.title = detail;
  refs.refreshQueryTarget.hidden = !profile || isRedis;
  refs.refreshQueryTarget.disabled = Boolean(data?.loading || tab.running || tab.confirming || tab.resolvingTarget);
  refs.queryTargetDetail.textContent = !profile ? tab.connectionId ? "原连接已不可用。SQL 草稿已保留，可复制到新建查询中继续。" : "从左侧选择连接，或在 Schema 上右键新建查询。"
    : data?.error ? `无法确认执行位置：${data.error} · 点击${tab.browse && tab.tableView !== false ? "刷新" : " ↻ "}重试`
    : data?.catalogError ? `Schema 列表读取失败：${data.catalogError} · 点击 ↻ 重试` : "";
  refs.queryTargetDetail.hidden = !refs.queryTargetDetail.textContent || Boolean(tab.console);
  refs.queryTargetDetail.dataset.error = String(Boolean(data?.error || data?.catalogError));
  refs.tableToolbarTitle.title = detail;
  refs.editorHint.title = detail;
}
function changeQuerySchema(value) {
  const tab = activeTab();
  if (queryTargetLocked(tab) || driverForTab(tab) !== "postgres") return renderQueryTarget(tab);
  queryStructureSelect.close();
  tab.structureChoiceRequest = null;
  tab.structureChoosing = false;
  tab.schema = value || null;
  tab.browse = null;
  tab.openedObject = null;
  tab.openedObjectView = null;
  tab.tableView = false;
  // Previous results belong to their old destination and must not be edited
  // or mistaken for results from the newly selected database.
  tab.result = emptyResult();
  tab.structure = null;
  tab.message = "执行位置已切换，请重新执行查询。";
  tab.gridState = null;
  tab.outputTab = "result";
  updateEditorSchema();
  persistTabs();
  renderTabs();
  renderOutput();
}
function redisProfileDatabase(profile) {
  return resolveRedisDatabase(null, profile);
}
function redisTabDatabase(tab = activeTab()) {
  const profile = state.profiles.find((item) => item.id === tab?.connectionId);
  return resolveRedisDatabase(tab, profile);
}
function showToast(message, type = "info") {
  refs.toast.textContent = message;
  refs.toast.dataset.type = type;
  refs.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(
    () => refs.toast.classList.remove("visible"),
    type === "error" ? 7000 : 4000,
  );
}
async function copyText(text, { allowEmpty = false } = {}) {
  const value = String(text ?? "");
  if (!value && !allowEmpty) throw new Error("复制内容为空");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("系统剪贴板不可用");
}
function cellText(value) {
  return formatCellValue(value);
}
function quoteIdent(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}
function quoteIdentForDriver(identifier, driver = "postgres") {
  if (driver === "mysql") return `\`${String(identifier).replaceAll("`", "``")}\``;
  return quoteIdent(identifier);
}
function driverForConnection(connectionId) {
  return state.profiles.find((profile) => profile.id === connectionId)?.driver || "postgres";
}
function driverForTab(tab = activeTab()) {
  return driverForConnection(tab?.connectionId || state.activeConnectionId);
}
function driverForBrowse(browse) {
  return driverForConnection(browse?.connectionId || state.activeConnectionId);
}
function sqlEquality(left, right, driver) {
  return driver === "mysql" ? `${left} <=> ${right}` : `${left} IS NOT DISTINCT FROM ${right}`;
}
function schemaKey(database, schema) {
  return `${database}\u0000${schema}`;
}
function transactionKey(connectionId, database) {
  return `${connectionId}\u0000${database || ""}`;
}
function clearTransactionKeys(connectionId) {
  for (const key of state.transactionKeys) {
    if (key.startsWith(`${connectionId}\u0000`)) state.transactionKeys.delete(key);
  }
}
function visibleDatabaseStorageKey(connectionId) {
  return `db-studio.visible-databases.v1.${connectionId}`;
}
function visibleSchemaStorageKey(connectionId, database) {
  return `db-studio.visible-schemas.v1.${connectionId}.${encodeURIComponent(database)}`;
}
function readVisibleDatabases(connectionId) {
  try {
    const value = JSON.parse(
      localStorage.getItem(visibleDatabaseStorageKey(connectionId)) || "null",
    );
    return Array.isArray(value) ? new Set(value.filter(Boolean)) : null;
  } catch {
    return null;
  }
}
function readVisibleSchemas(connectionId, database) {
  try {
    const value = JSON.parse(
      localStorage.getItem(visibleSchemaStorageKey(connectionId, database)) || "null",
    );
    return Array.isArray(value) ? new Set(value.filter(Boolean)) : null;
  } catch {
    return null;
  }
}
function persistVisibleDatabases(connectionId) {
  try {
    localStorage.setItem(
      visibleDatabaseStorageKey(connectionId),
      JSON.stringify([...state.visibleDatabases]),
    );
  } catch {}
}
function persistVisibleSchemas(connectionId, database, schemas) {
  try {
    localStorage.setItem(
      visibleSchemaStorageKey(connectionId, database),
      JSON.stringify([...schemas]),
    );
  } catch {}
}
function qualifiedObjectName(object) {
  return `${quoteIdentForDriver(object.schema, object.driver)}.${quoteIdentForDriver(object.name, object.driver)}`;
}
async function call(command, args) {
  if (!invoke) throw new Error("请使用 Tauri 启动 DB Studio");
  return invoke(command, args);
}

function readActiveTabId() {
  try {
    return localStorage.getItem(`${tabsKey}.active`) || "query-1";
  } catch {
    return "query-1";
  }
}
const savedTabs = readTabs();
const state = {
  tabs: savedTabs,
  activeTabId: readActiveTabId(),
  history: readHistory(),
  queryLibrary: readQueryLibrary(),
  profiles: [],
  activeConnectionId: null,
  connectionStatuses: {},
  connectionErrors: {},
  treeSessions: new Map(),
  transactionKeys: new Set(),
  queryTargets: new Map(),
  redisDatabases: [],
  redisDatabaseError: null,
  redisExpanded: new Set(),
  redisActiveDatabase: 0,
  redisPages: new Map(),
  redisScanGenerations: new Map(),
  redisPattern: "",
  redisSearchTimer: null,
  redisRequest: 0,
  databases: [],
  visibleDatabases: new Set(),
  databasePickerDraft: null,
  visibleSchemasByDatabase: new Map(),
  expandedDatabases: new Set(),
  schemaPickerDatabase: null,
  schemaPickerDraft: null,
  schemasByDatabase: new Map(),
  objectsBySchema: new Map(),
  expandedSchemas: new Set(),
  schemaRequest: 0,
  databaseRequest: 0,
  objectRequests: new Map(),
  structureRequest: 0,
  collapsedCategories: new Set(),
  expandedCategories: new Set(),
  schemaErrors: new Map(),
  schemaLoading: new Set(),
  gridResult: null,
  gridFilter: null,
  structureRendered: null,
  modalBusy: false,
  selectedObject: null,
  selectedTreeKey: null,
  editor: null,
  persistTimer: null,
  applyingBrowse: false,
  mutation: null,
  cellInspector: null,
  contextObject: null,
  contextTreeTarget: null,
  pendingObjectCreate: null,
  contextRedisKey: null,
  contextRedisDb: null,
  contextRedisConnectionId: null,
  pendingRedisRename: null,
  contextTabId: null,
  redisConsole: null,
  objectClickPreviewId: null,
};
if (!state.tabs.some((tab) => tab.id === state.activeTabId))
  state.activeTabId = state.tabs[0]?.id || null;

function nextQueryNumber() {
  const used = new Set(
    state.tabs
      .map((tab) => Number(tab.title?.match(/^查询 (\d+)$/)?.[1]) || 0)
      .filter((number) => number > 0),
  );
  for (let number = 1; number <= MAX_QUERY_TABS; number += 1)
    if (!used.has(number)) return number;
  return state.tabs.length + 1;
}
const schemaCompartment = new Compartment();
function completionConfig(tab = activeTab()) {
  const profile = state.profiles.find((item) => item.id === tab?.connectionId);
  const target = queryTargetData(tab);
  const database = tabDatabase(tab) || target?.context?.database;
  const catalog = target?.objects || (tab?.connectionId === state.activeConnectionId ? [...state.objectsBySchema.values()].flat() : []);
  const schema = buildCompletionSchema(catalog, database, profile?.driver);
  return { schema,
    defaultSchema: profile?.driver === "mysql" ? database : tabSchema(tab) || target?.context?.defaultSchema,
    driver: profile?.driver,
    dialect: profile?.driver === "mysql" ? MySQL : PostgreSQL };
}

async function loadQueryCatalog(tab) {
  const data = await loadQueryTarget(tab);
  if (!data?.context) return data;
  if (!data.objects) {
    data.objectRequest ||= (async () => {
      const database = tabDatabase(tab) || data.context.database;
      const schemas = driverForTab(tab) === "mysql" ? [{ name: database }] : data.schemas;
      const results = await Promise.allSettled(schemas.map(({ name }) =>
        call("get_schema_objects", { connectionId: tab.connectionId, schemaName: name, database })));
      data.objects = results.filter((result) => result.status === "fulfilled")
        .flatMap((result) => result.value.map((object) => ({ ...object, database })));
      data.objectError = [data.catalogError, ...results.filter((result) => result.status === "rejected")
        .map((result) => errorText(result.reason))].filter(Boolean).join("；");
      data.objectRequest = null;
    })();
    await data.objectRequest;
  }
  return data;
}
async function completeCatalog(context) {
  if (/Comment|String/.test(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  const tab = activeTab();
  if (!tab?.connectionId || driverForTab(tab) === "redis") return null;
  const key = queryTargetKey(tab);
  const schema = tabSchema(tab);
  const data = await loadQueryCatalog(tab);
  const current = () => !context.aborted && activeTab() === tab && queryTargetKey(tab) === key &&
    tabSchema(tab) === schema && queryTargetData(tab) === data;
  if (!data?.context) return null;
  return current() ? catalogCompletionSource(completionConfig(tab))(context) : null;
}
function makeEditorState(tab) {
  return EditorState.create({
    doc: tab.sql,
    extensions: [
      EditorView.contentAttributes.of({ "aria-label": "SQL 查询编辑器" }),
      placeholder("在此编写 SQL…"),
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: tags.keyword, color: "var(--syntax-keyword)" },
          { tag: tags.string, color: "var(--syntax-string)" },
          { tag: tags.number, color: "var(--syntax-number)" },
          { tag: tags.comment, color: "var(--app-muted)", fontStyle: "italic" },
          { tag: tags.operator, color: "var(--syntax-operator)" },
        ]),
      ),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      sqlIme,
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      highlightActiveLine(),
      highlightSelectionMatches({ minSelectionLength: 2, wholeWords: true }),
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 30, icons: false,
        addToOptions: [{ position: 20, render: completionKind }] }),
      keymap.of([
        ...createSqlExecutionKeymap(runQuery),
        ...completionKeymap,
        { key: "Tab", run: acceptCompletion },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      schemaCompartment.of(
        editorLanguageExtension(tab),
      ),
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "var(--input-bg)", color: "var(--app-text)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--app-text)", borderLeftWidth: "2px" },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
          fontSize: "12px",
          lineHeight: "1.75",
        },
        ".cm-content": {
          padding: "18px 18px 26px 12px",
          caretColor: "var(--accent-focus)",
        },
        ".cm-gutters": {
          backgroundColor: "var(--app-panel)",
          color: "var(--app-muted)",
          border: "0",
          paddingRight: "8px",
        },
        ".cm-activeLine": { backgroundColor: "var(--editor-line-bg)" },
        ".cm-placeholder": { color: "var(--app-muted)", fontStyle: "normal" },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: "var(--app-text)",
          fontWeight: "600",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--app-surface)",
          border: "1px solid var(--app-border)",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected=true]": {
          backgroundColor: "var(--selected-bg)",
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const currentTab = activeTab();
          if (!currentTab) return;
          currentTab.sql = update.state.doc.toString();
          currentTab.editorState = update.state;
          if (refs.saveQueryFavorite) refs.saveQueryFavorite.disabled = !currentTab.sql.trim() || Boolean(currentTab.console || currentTab.structureOnly || driverForTab(currentTab) === "redis");
          if (!state.applyingBrowse) {
            currentTab.browse = null;
            updatePageControls();
          }
          schedulePersistTabs();
        }
        if (update.selectionSet || update.docChanged)
          updateCursor(update.state);
      }),
    ],
  });
}
function createEditor() {
  const tab = activeTab() || { sql: "", mode: "write" };
  tab.editorState = makeEditorState(tab);
  state.editor = new EditorView({
    state: tab.editorState,
    parent: refs.sqlEditor,
  });
}
function updateEditorSchema() {
  if (state.editor)
    state.editor.dispatch({
      effects: schemaCompartment.reconfigure(
        editorLanguageExtension(activeTab()),
      ),
    });
}
let redisTypePicker;
let redisEditor;
let redisEditorSessionId;
function cachedRedisKeys(tab = activeExecutionTab()) {
  return tab?.connectionId === state.activeConnectionId ? state.redisPages.get(redisTabDatabase(tab))?.keys || [] : [];
}
function completeRedis(context) { return redisCompletionSource(context, cachedRedisKeys(activeTab())); }
function editorLanguageExtension(tab = activeTab()) {
  const profile = state.profiles.find((item) => item.id === tab?.connectionId);
  if (profile?.driver === "redis") return [redisLanguage, EditorState.languageData.of(() => [{ autocomplete: completeRedis }])];
  const dialect = profile?.driver === "mysql" ? MySQL : PostgreSQL;
  return [sql({ dialect, upperCaseKeywords: true, keywordCompletion: sqlKeywordCompletion }),
    dialect.language.data.of({ autocomplete: completeCatalog })];
}
function updateCursor(editorState = state.editor?.state) {
  if (!editorState) return;
  const { head, from, to } = editorState.selection.main;
  const line = editorState.doc.lineAt(head);
  const selection = editorState.sliceDoc(from, to);
  const lineCount = editorState.doc.lineAt(Math.max(from, to - 1)).number - editorState.doc.lineAt(from).number + 1;
  refs.cursorPosition.textContent = `Ln ${line.number}, Col ${head - line.from + 1}` +
    (selection ? ` · 已选 ${selection.length} 字符${lineCount > 1 ? ` / ${lineCount} 行` : ""}` : "");
  refs.runLabel.textContent = selection.trim() ? "执行选中" : "执行";
  refs.runQuery.title = selection.trim() ? "仅执行选中的 SQL（⌘ Enter）" : "执行编辑器中的全部 SQL（⌘ Enter）";
}
function schedulePersistTabs() {
  clearTimeout(state.persistTimer);
  state.persistTimer = setTimeout(persistTabs, 350);
}
function setEditorValue(sqlText) {
  state.editor?.dispatch({
    changes: { from: 0, to: state.editor.state.doc.length, insert: sqlText },
  });
}

function renderConnections() {
  const query = refs.connectionSearch.value;
  const profiles = state.profiles.filter(profile => matchesWorkspaceSearch(query, profile.name, profile.driver, profile.host, profile.database, profile.port));
  refs.connectionCount.textContent = query.trim() ? `${profiles.length}/${state.profiles.length}` : String(state.profiles.length);
  refs.connectionSearch.disabled = !state.profiles.length;
  refs.connectionList.innerHTML = !state.profiles.length
    ? '<div class="small-empty">将数据库连接到你的工作区<br/><button class="secondary-btn" id="emptyNewConnection">＋ 新建连接</button></div>'
    : !profiles.length
      ? '<div class="small-empty">没有找到匹配的连接<br/><button data-clear-connection-search>清除搜索</button></div>'
      : profiles.map((profile) => {
        const status = state.connectionStatuses[profile.id] || "idle";
        const driver = profile.driver === "redis" ? "Redis" : profile.driver === "mysql" ? "MySQL" : "PostgreSQL";
        const statusLabel = { connected: "已连接", connecting: "连接中", error: "连接失败", idle: "未连接" }[status];
        const toggleLabel = status === "connected" ? "断开连接" : status === "connecting" ? "连接中" : "连接";
        const toggleIcon = status === "connecting" ? '<span class="spinner"></span>' : svgIcon('<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/>');
        const description = `${driver} · ${profile.host}:${profile.port}${profile.database ? ` / ${profile.database}` : ""}`;
        return `<div class="connection-card ${profile.id === state.activeConnectionId ? "selected" : ""}" data-driver="${escapeHtml(profile.driver || "postgres")}"><button class="connection-select" data-connection-id="${escapeHtml(profile.id)}" title="${escapeHtml(description)}" aria-label="${escapeHtml(profile.name)}，${driver}，${statusLabel}" ${profile.id === state.activeConnectionId ? 'aria-current="true"' : ''}><span class="connection-icon connection-driver-icon">${driverIcon(profile.driver)}</span><span class="connection-copy"><strong>${escapeHtml(profile.name)}</strong><small><span class="connection-state-label" data-status="${status}">${statusLabel}</span> · ${driver}</small></span></button><button class="icon-btn connection-toggle" data-connection-toggle="${escapeHtml(profile.id)}" data-status="${status}" title="${toggleLabel}" aria-label="${toggleLabel}：${escapeHtml(profile.name)}" aria-pressed="${status === "connected"}" ${status === "connecting" ? "disabled" : ""}>${toggleIcon}</button><button class="icon-btn connection-edit" data-edit-id="${escapeHtml(profile.id)}" title="编辑连接" aria-label="编辑连接：${escapeHtml(profile.name)}">•••</button></div>`;
      }).join("");
  refs.connectionMode.textContent = state.activeConnectionId
    ? {
        connected: "已连接",
        connecting: "连接中…",
        error: "连接失败",
        idle: "未连接",
      }[state.connectionStatuses[state.activeConnectionId]] || "未连接"
    : "未连接";
  refs.statusDot.className = `status-dot ${state.connectionStatuses[state.activeConnectionId] || ""}`;
  const active = state.profiles.find((p) => p.id === state.activeConnectionId);
  const activeDriverLabel = active?.driver === "redis" ? "Redis" : active?.driver === "mysql" ? "MySQL" : "PostgreSQL";
  refs.headerContext.textContent = active
    ? `浏览：${active.name}  /  ${active.database || (active.driver === "redis" ? `DB ${redisProfileDatabase(active)}` : activeDriverLabel)}`
    : "数据库工作区";
  refs.headerContext.title = refs.headerContext.textContent;
  refs.serverInfo.textContent = active?.database
    ? `${active.database} · ${active.host}`
    : "";
  refs.disconnectConnection.disabled =
    state.connectionStatuses[state.activeConnectionId] !== "connected";
  if (refs.workspaceStats) refs.workspaceStats.textContent = active ? activeDriverLabel : "本地工作区";
  if (refs.editorHint && !activeTab()) refs.editorHint.textContent = active?.driver === "redis"
    ? "Redis 命令 · 只读锁定后仅允许安全读取命令"
    : active?.driver === "mysql"
      ? "MySQL · 选中 SQL 可单独执行"
      : "PostgreSQL · 选中 SQL 可单独执行";
  if (refs.collapseTree) refs.collapseTree.hidden = active?.driver === "redis";
  if (refs.refreshSchema) refs.refreshSchema.title = active?.driver === "redis" ? "刷新 Redis key" : "刷新数据库对象";
  if (refs.objectSearch) refs.objectSearch.placeholder = active?.driver === "redis" ? "搜索 Redis key…" : "搜索表、字段或 schema…";
  refs.refreshSchema.disabled = state.connectionStatuses[state.activeConnectionId] !== "connected";
  if (!activeTab()) renderOutput();
}
async function loadConnections({ restore = true } = {}) {
  if (!invoke) {
    refs.previewLabel.hidden = false;
    refs.previewLabel.title = "此窗口用于预览界面。连接数据库请运行桌面应用。";
    renderConnections();
    return;
  }
  try {
    state.profiles = await call("list_connections");
    // Missing profiles must never delete restored SQL drafts. Their original
    // binding stays visible and runQuery refuses to execute until it exists.
    renderConnections();
    renderTabs();
    renderHistory();
    queryLibraryUI.render();
    persistTabs();
    if (!state.profiles.length || !restore) return;
    const restoredConnection = activeTab()?.connectionId;
    if (restoredConnection && state.profiles.some((profile) => profile.id === restoredConnection)) {
      const tab = activeTab();
      tab.connectionId = restoredConnection;
      const connected = await selectConnection(restoredConnection);
      if (connected && tab.redisKey && !tab.result?.executed) {
        const value = await call("get_redis_value", { connectionId: restoredConnection, key: tab.redisKey, database: redisTabDatabase(tab) });
        applyRedisValueResult(tab, value, restoredConnection, redisTabDatabase(tab));
        renderTabs();
        renderOutput();
      }
      if (connected && tab.browse && !tab.result?.executed) {
        try {
          await loadBrowseDetails(tab);
        } catch (error) {
          tab.browse.detailsError = errorText(error);
          showToast(`读取表结构失败：${errorText(error)}`, "error");
        }
        if (activeTab() === tab) {
          renderOutput();
          await runQuery();
        }
      }
    }
  } catch (error) {
    renderConnections();
    showToast(`读取连接失败：${errorText(error)}`, "error");
  }
}
const treeSessionFields = [
  "databases", "visibleDatabases", "visibleSchemasByDatabase", "expandedDatabases",
  "schemasByDatabase", "objectsBySchema", "expandedSchemas", "schemaErrors",
  "collapsedCategories", "expandedCategories", "selectedObject", "selectedTreeKey",
  "redisDatabases", "redisDatabaseError", "redisExpanded", "redisActiveDatabase", "redisPattern",
];
function rememberTreeSession() {
  const id = state.activeConnectionId;
  if (!id || state.connectionStatuses[id] !== "connected") return;
  const session = Object.fromEntries(treeSessionFields.map((key) => {
    const value = state[key];
    return [key, value instanceof Set ? new Set(value) : value instanceof Map ? new Map(value) : value];
  }));
  session.redisPages = new Map([...state.redisPages].map(([database, page]) => [database, { ...page }]));
  session.search = refs.objectSearch.value;
  session.selectionLabel = refs.objectSelection.textContent;
  session.scrollTop = refs.objectTree.scrollTop;
  state.treeSessions.set(id, session);
}
async function restoreTreeSession(session, profile, request, redisRequest) {
  for (const key of treeSessionFields) state[key] = session[key];
  state.redisPages = session.redisPages;
  refs.objectSearch.value = session.search;
  refs.objectSelection.textContent = session.selectionLabel;
  const current = () => request === state.schemaRequest && state.activeConnectionId === profile.id;
  // Requests abandoned when switching instances must not leave loading rows
  // stuck, or write their late responses into another instance's tree.
  const pendingRedis = [...state.redisPages].filter(([, page]) => page.loading).map(([database]) => database);
  for (const page of state.redisPages.values()) page.loading = false;
  renderConnections();
  renderTree();
  refs.objectTree.scrollTop = session.scrollTop;
  if (profile.driver === "redis") {
    await Promise.all([...state.redisExpanded].filter((database) => pendingRedis.includes(database) || !state.redisPages.get(database)?.loaded)
      .map((database) => loadRedisKeys(database, 0, state.redisPattern, profile.id, redisRequest)));
  } else {
    await Promise.all([...state.expandedDatabases].filter((database) => !state.schemasByDatabase.has(database))
      .map((database) => loadSchemas(database, profile.id, request)));
    if (!current()) return false;
    await Promise.all([...state.expandedSchemas].filter((key) => !state.objectsBySchema.has(key))
      .map((key) => loadSchemaObjects(...key.split("\u0000"))));
  }
  if (current()) refs.objectTree.scrollTop = session.scrollTop;
  return current();
}
async function selectConnection(id) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return false;
  closeRedisConsole();
  const connected = state.connectionStatuses[id] === "connected";
  rememberTreeSession();
  const session = connected ? state.treeSessions.get(id) : null;
  if (!connected) state.treeSessions.delete(id);
  const request = ++state.schemaRequest;
  const redisRequest = ++state.redisRequest;
  state.selectedObject = null;
  state.selectedTreeKey = null;
  state.objectRequests.clear();
  state.activeConnectionId = id;
  state.schemaLoading.clear();
  state.redisScanGenerations.clear();
  state.schemaPickerDatabase = null;
  state.schemaPickerDraft = null;
  if (session && (profile.driver === "redis" ? session.redisDatabases.length : session.databases.length))
    return restoreTreeSession(session, profile, request, redisRequest);
  state.selectedTreeKey = treeTargetKey({ type: "root", connectionId: id });
  state.collapsedCategories.clear();
  state.expandedCategories.clear();
  state.connectionStatuses[id] = connected ? "connected" : "connecting";
  state.databases = [];
  state.redisDatabases = [];
  state.redisDatabaseError = null;
  state.redisExpanded = new Set();
  state.redisActiveDatabase = redisProfileDatabase(profile);
  state.redisPages.clear();
  state.redisScanGenerations.clear();
  state.redisPattern = "";
  refs.objectSearch.value = "";
  refs.objectSelection.textContent = "展开数据库和 schema，浏览对象";
  state.visibleDatabases.clear();
  state.visibleSchemasByDatabase.clear();
  state.expandedDatabases.clear();
  state.expandedSchemas.clear();
  state.schemaPickerDatabase = null;
  state.schemaPickerDraft = null;
  state.schemasByDatabase.clear();
  state.objectsBySchema.clear();
  state.schemaErrors.clear();
  state.schemaLoading.clear();
  renderConnections();
  renderTree();
  try {
    if (!connected) await call("connect_connection", { connectionId: id });
    if (request !== state.schemaRequest || state.activeConnectionId !== id)
      return false;
    state.connectionStatuses[id] = "connected";
    delete state.connectionErrors[id];
    renderConnections();
    if (profile.driver === "redis") {
      state.databases = [];
      state.schemasByDatabase.clear();
      state.objectsBySchema.clear();
      try {
        const redisDatabases = await call("list_redis_databases", { connectionId: id });
        if (
          request !== state.schemaRequest ||
          !isCurrentConnectionRequest(redisRequest, state.redisRequest, id, state.activeConnectionId)
        )
          return false;
        state.redisDatabases = redisDatabases
          .map((database) => ({
            index: Number(database.index),
            keyCount: Number.isFinite(Number(database.keyCount)) ? Number(database.keyCount) : null,
            current: Boolean(database.current),
          }))
          .filter((database) => Number.isInteger(database.index) && database.index >= 0);
      } catch (error) {
        if (
          request !== state.schemaRequest ||
          !isCurrentConnectionRequest(redisRequest, state.redisRequest, id, state.activeConnectionId)
        )
          return false;
        // Keep older fixtures/servers usable while they upgrade. The selected
        // profile database remains a valid single logical database.
        state.redisDatabaseError = errorText(error);
        state.redisDatabases = [];
      }
      if (!state.redisDatabases.length)
        state.redisDatabases = [{ index: redisProfileDatabase(profile), keyCount: null, current: true }];
      // A connection starts with every DB collapsed. Only the user's explicit
      // expansion scans keys; old persisted expansion preferences are ignored.
      renderRedisTree();
      return (
        request === state.schemaRequest &&
        isCurrentConnectionRequest(redisRequest, state.redisRequest, id, state.activeConnectionId)
      );
    }
    const databases = await call("list_databases", { connectionId: id });
    if (request !== state.schemaRequest || state.activeConnectionId !== id)
      return false;
    state.databases = databases;
    const saved = readVisibleDatabases(id);
    state.visibleDatabases = new Set(
      (saved?.size ? [...saved] : [profile.database]).filter((name) =>
        state.databases.some((database) => database.name === name),
      ),
    );
    if (!state.visibleDatabases.size && state.databases.length)
      state.visibleDatabases.add(
        state.databases.some((database) => database.name === profile.database)
          ? profile.database
          : state.databases[0].name,
      );
    renderTree();
    await loadVisibleSchemas(false);
    return request === state.schemaRequest && state.activeConnectionId === id;
  } catch (error) {
    if (request !== state.schemaRequest || state.activeConnectionId !== id)
      return false;
    state.connectionStatuses[id] = "error";
    state.connectionErrors[id] = errorText(error);
    renderConnections();
    refs.objectTree.innerHTML = `<div class="tree-status">连接失败：${escapeHtml(errorText(error))}<br/><button data-retry-connection="${escapeHtml(id)}">重试连接</button></div>`;
    showToast(`连接失败：${errorText(error)}`, "error");
    return false;
  }
}

function renderDatabasePicker() {
  const query = (refs.databaseSearch?.value || "").trim().toLowerCase();
  const visible = state.databasePickerDraft || state.visibleDatabases;
  const filtered = state.databases.filter(
    (database) => !query || database.name.toLowerCase().includes(query),
  );
  if (refs.databaseList)
    refs.databaseList.innerHTML = filtered.length
      ? filtered
          .map(
            (database) =>
              `<label class="database-option"><input type="checkbox" value="${escapeHtml(database.name)}" ${visible.has(database.name) ? "checked" : ""}/><span class="database-option-icon">${databaseIcon}</span><span>${escapeHtml(database.name)}</span>${database.current ? '<small>当前</small>' : ""}</label>`,
          )
          .join("")
      : '<div class="tree-status">没有匹配的数据库</div>';
  const selectedCount = filtered.filter((database) => visible.has(database.name)).length;
  if (refs.databaseSelectAll) {
    refs.databaseSelectAll.checked = filtered.length > 0 && selectedCount === filtered.length;
    refs.databaseSelectAll.indeterminate = selectedCount > 0 && selectedCount < filtered.length;
  }
  if (refs.databaseSelectionCount)
    refs.databaseSelectionCount.textContent = `${visible.size} 个已显示`;
}
function openDatabasePicker() {
  if (!state.databases.length) return;
  state.databasePickerDraft = new Set(state.visibleDatabases);
  renderDatabasePicker();
  refs.databaseModal?.showModal();
}
async function applyDatabasePicker() {
  const draft = state.databasePickerDraft || state.visibleDatabases;
  const selected = new Set(
    [...draft].filter((name) => state.databases.some((database) => database.name === name)),
  );
  if (!selected.size) {
    showToast("至少选择一个要显示的数据库", "error");
    return;
  }
  state.visibleDatabases = selected;
  state.databasePickerDraft = null;
  persistVisibleDatabases(state.activeConnectionId);
  refs.databaseModal.close();
  await loadVisibleSchemas();
}
function renderSchemaPicker() {
  const database = state.schemaPickerDatabase;
  const schemas = state.schemasByDatabase.get(database) || [];
  const query = (refs.schemaSearch?.value || "").trim().toLowerCase();
  const visible =
    state.schemaPickerDraft || state.visibleSchemasByDatabase.get(database) || new Set();
  const filtered = schemas.filter(
    (schema) => !query || schema.name.toLowerCase().includes(query),
  );
  if (refs.schemaPickerDatabaseName)
    refs.schemaPickerDatabaseName.textContent = database || "";
  if (refs.schemaList)
    refs.schemaList.innerHTML = filtered.length
      ? filtered
          .map(
            (schema) =>
              `<label class="schema-option database-option"><input type="checkbox" value="${escapeHtml(schema.name)}" ${visible.has(schema.name) ? "checked" : ""}/><span class="database-option-icon schema-option-icon">${schemaIcon}</span><span>${escapeHtml(schema.name)}</span>${schema.owner ? `<small>${escapeHtml(schema.owner)}</small>` : ""}</label>`,
          )
          .join("")
      : '<div class="tree-status">没有匹配的 schema</div>';
  const selectedCount = filtered.filter((schema) => visible.has(schema.name)).length;
  if (refs.schemaSelectAll) {
    refs.schemaSelectAll.checked = filtered.length > 0 && selectedCount === filtered.length;
    refs.schemaSelectAll.indeterminate = selectedCount > 0 && selectedCount < filtered.length;
  }
  if (refs.schemaSelectionCount)
    refs.schemaSelectionCount.textContent = `${visible.size} 个已显示`;
}
function openSchemaPicker(database) {
  const schemas = state.schemasByDatabase.get(database) || [];
  if (!schemas.length) return;
  state.schemaPickerDatabase = database;
  state.schemaPickerDraft = new Set(
    state.visibleSchemasByDatabase.get(database) || schemas.map((schema) => schema.name),
  );
  if (refs.schemaSearch) refs.schemaSearch.value = "";
  renderSchemaPicker();
  refs.schemaModal?.showModal();
}
async function applySchemaPicker() {
  const database = state.schemaPickerDatabase;
  const schemas = state.schemasByDatabase.get(database) || [];
  const draft = state.schemaPickerDraft || state.visibleSchemasByDatabase.get(database) || new Set();
  const selected = new Set(
    [...draft].filter((name) => schemas.some((schema) => schema.name === name)),
  );
  if (!selected.size) {
    showToast("至少选择一个要显示的 schema", "error");
    return;
  }
  state.visibleSchemasByDatabase.set(database, selected);
  persistVisibleSchemas(state.activeConnectionId, database, selected);
  state.schemaPickerDraft = null;
  state.schemaPickerDatabase = null;
  refs.schemaModal?.close();
  for (const key of [...state.objectsBySchema.keys()]) {
    if (key.startsWith(`${database}\u0000`) && !selected.has(key.slice(database.length + 1)))
      state.objectsBySchema.delete(key);
  }
  for (const key of [...state.expandedSchemas]) {
    if (key.startsWith(`${database}\u0000`) && !selected.has(key.slice(database.length + 1)))
      state.expandedSchemas.delete(key);
  }
  if (
    state.selectedObject?.database === database &&
    !selected.has(state.selectedObject.schema)
  ) {
    state.selectedObject = null;
    state.selectedTreeKey = null;
    refs.objectSelection.textContent = "展开数据库和 schema，浏览对象";
  }
  updateEditorSchema();
  renderTree();
}
async function disconnectConnection(connectionId = state.activeConnectionId) {
  if (!connectionId) return;
  if (anyQueryRunning()) {
    showToast("有查询正在执行，请先停止后再断开连接", "error");
    return;
  }
  const id = connectionId;
  const isActive = state.activeConnectionId === id;
  const profile = state.profiles.find((item) => item.id === id);
  if (isActive) {
    ++state.schemaRequest;
    ++state.redisRequest;
    state.objectRequests.clear();
  }
  try {
    await call("disconnect_connection", { connectionId: id });
    state.connectionStatuses[id] = "idle";
    state.treeSessions.delete(id);
    clearTransactionKeys(id);
    if (state.redisConsole?.connectionId === id) closeRedisConsole();
    if (state.activeConnectionId !== id) {
      renderConnections();
      showToast(`已断开${profile ? `「${profile.name}」` : "连接"}`);
      return;
    }
    state.databases = [];
    state.redisDatabases = [];
    state.redisDatabaseError = null;
    state.redisExpanded.clear();
    state.redisPages.clear();
    state.redisScanGenerations.clear();
    state.redisPattern = "";
    state.visibleDatabases.clear();
    state.visibleSchemasByDatabase.clear();
    state.expandedDatabases.clear();
    state.expandedSchemas.clear();
    state.selectedObject = null;
    state.selectedTreeKey = null;
    refs.objectSelection.textContent = "展开数据库和 schema，浏览对象";
    state.schemaPickerDatabase = null;
    state.schemaPickerDraft = null;
    state.schemasByDatabase.clear();
    state.objectsBySchema.clear();
    state.schemaErrors.clear();
    state.schemaLoading.clear();
    renderConnections();
    renderTree();
    showToast(`已断开${profile ? `「${profile.name}」` : "连接"}`);
  } catch (error) {
    showToast(`断开失败：${errorText(error)}`, "error");
  }
}

function renderTree() {
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeConnectionId);
  if (activeProfile?.driver === "redis") {
    renderRedisTree();
    return;
  }
  refs.objectTree.dataset.driver = activeProfile?.driver || "";
  const query = refs.objectSearch.value.trim().toLowerCase();
  if (!activeProfile) {
    refs.objectTree.innerHTML = `<div class="tree-welcome"><span class="database-icon">${databaseIcon}</span><strong>数据库对象</strong><p>选择左侧连接后，<br/>在这里浏览数据库、表和视图。</p><button class="quiet-btn" data-tree-connect>选择连接</button></div>`;
    return;
  }
  const driverLabel = activeProfile?.driver === "mysql" ? "MySQL" : "PostgreSQL";
  const chunks = [
    `<div class="tree-root" tabindex="0" aria-label="数据库实例"><span class="database-icon driver-tree-icon">${driverIcon(activeProfile?.driver)}</span><span class="tree-label">${driverLabel} 数据库</span><small>${state.visibleDatabases.size || "—"}</small><button class="icon-btn tree-root-action" data-display-databases title="选择显示的数据库">•••</button></div>`,
  ];
  if (!state.activeConnectionId || state.connectionStatuses[state.activeConnectionId] !== "connected") {
    chunks.push(`<div class="tree-status">连接后加载 ${driverLabel} 数据库</div>`);
    refs.objectTree.innerHTML = chunks.join("");
    applyTreeSelection();
    return;
  }
  if (!state.databases.length) {
    chunks.push('<div class="tree-status">正在读取数据库列表…</div>');
    refs.objectTree.innerHTML = chunks.join("");
    applyTreeSelection();
    return;
  }
  for (const database of state.databases) {
    if (!state.visibleDatabases.has(database.name)) continue;
    const schemas = state.schemasByDatabase.get(database.name) || [];
    const schemaLoading = state.schemaLoading.has(database.name);
    const schemaError = state.schemaErrors.get(database.name);
    const visibleSchemas = state.visibleSchemasByDatabase.get(database.name);
    const databaseMatches =
      !query ||
      database.name.toLowerCase().includes(query) ||
      schemas.some(
        (schema) =>
          (!visibleSchemas || visibleSchemas.has(schema.name)) &&
          (schema.name.toLowerCase().includes(query) ||
            (state.objectsBySchema.get(schemaKey(database.name, schema.name)) || []).some((object) => objectMatchesSearch(object, query))),
      );
    if (!databaseMatches) continue;
    chunks.push(
      `<details class="tree-database" data-database="${escapeHtml(database.name)}"${query || state.expandedDatabases.has(database.name) ? " open" : ""}><summary>${treeToggle(database.name, query || state.expandedDatabases.has(database.name))}<span class="database-icon">${databaseIcon}</span><span class="tree-label">${escapeHtml(database.name)}</span><span class="count">${(state.visibleSchemasByDatabase.get(database.name)?.size ?? schemas.length) || "…"}</span><button type="button" class="icon-btn tree-database-action" data-display-schemas="${escapeHtml(database.name)}" title="选择显示的 schema" aria-label="选择显示的 schema">•••</button></summary><div class="database-children">`,
    );
    if (!state.schemasByDatabase.has(database.name)) {
      chunks.push(schemaError
        ? `<div class="tree-status">读取 schema 失败：${escapeHtml(schemaError)}<br/><button data-retry-schema="${escapeHtml(state.activeConnectionId)}">重试</button></div>`
        : '<div class="tree-status">读取 schema…</div>');
    } else {
      if (schemaLoading) chunks.push('<div class="tree-status">刷新 schema…</div>');
      if (schemaError) chunks.push(`<div class="tree-status">刷新 schema 失败：${escapeHtml(schemaError)}<br/><button data-retry-schema="${escapeHtml(state.activeConnectionId)}">重试</button></div>`);
      for (const schema of schemas) {
        const visibleSchemas = state.visibleSchemasByDatabase.get(database.name);
        if (visibleSchemas && !visibleSchemas.has(schema.name)) continue;
        const key = schemaKey(database.name, schema.name);
        const objects = state.objectsBySchema.get(key) || [];
        const matchesSchema =
          !query ||
          schema.name.toLowerCase().includes(query) ||
          objects.some((o) =>
            objectMatchesSearch(o, query),
          );
        if (!matchesSchema) continue;
        const open = query || state.expandedSchemas.has(key) ? " open" : "";
        chunks.push(
          `<details class="tree-schema" data-database="${escapeHtml(database.name)}" data-schema="${escapeHtml(schema.name)}"${open}><summary>${treeToggle(schema.name, Boolean(open))}<span class="schema-icon">${schemaIcon}</span><span class="tree-label">${escapeHtml(schema.name)}</span><span class="count">${objects.length || "…"}</span></summary>`,
        );
        const objectLoading = state.objectRequests.has(key);
        if (!state.objectsBySchema.has(key)) {
          chunks.push(`<div class="tree-status">${objectLoading ? "读取对象…" : "展开以读取对象…"}</div>`);
        } else {
          if (objectLoading) chunks.push('<div class="tree-status">刷新对象…</div>');
          if (!objects.length) chunks.push('<div class="tree-status">没有可见对象</div>');
          else {
          const groups = orderedObjectGroups(objects.filter(object => objectMatchesSearch(object, query)));
          for (const [kind, items] of groups) {
            const categoryKey = JSON.stringify([database.name, schema.name, kind]);
            const expandedByDefault = Boolean(query) || (state.collapsedCategories.has(categoryKey) ? false : state.expandedCategories.has(categoryKey) || kind === "table" || kind === "partitioned_table");
            chunks.push(
              `<div class="tree-category${expandedByDefault ? "" : " collapsed"}" data-kind="${escapeHtml(kind)}"><div class="category-summary" tabindex="0" aria-expanded="${expandedByDefault}">${treeToggle(kindLabels[kind] || kind, expandedByDefault)}<span class="category-kind-icon">${kindIcons[kind] || "•"}</span><span class="tree-label">${kindLabels[kind] || kind}</span><span class="count">${items.length}</span></div><div class="category-items">`,
            );
            for (const object of items) {
              const fields = matchingColumns(object, query).map((column) => column.name);
              const label = (object.signature || object.name) + (fields.length ? ` · ${fields.join(", ")}` : "");
              chunks.push(
                `<div class="tree-object" data-object-id="${escapeHtml(object.id)}" data-database="${escapeHtml(database.name)}" data-schema="${escapeHtml(object.schema)}" data-name="${escapeHtml(object.name)}" data-kind="${escapeHtml(object.kind)}"><span class="object-kind-icon">${kindIcons[kind] || "•"}</span><button class="object-main" title="${escapeHtml(object.qualifiedName)}">${escapeHtml(label)}</button><button class="object-open" title="打开数据">↗</button></div>`,
              );
            }
            chunks.push("</div></div>");
          }
          }
        }
        chunks.push("</details>");
      }
    }
    chunks.push("</div></details>");
  }
  if (query && chunks.length === 1) chunks.push('<div class="tree-status">没有匹配的对象。<br/>试试表名、字段或备注，或<button data-clear-object-search>清除搜索</button>。</div>');
  refs.objectTree.innerHTML = chunks.join("");
  applyTreeSelection();
  const connectionId = state.activeConnectionId;
  const requestId = state.schemaRequest;
  refs.objectTree
    .querySelectorAll("details.tree-database[data-database]")
    .forEach((node) => {
      node.addEventListener("toggle", () => {
        syncTreeToggle(node.querySelector('summary'), node.open);
        if (!node.isConnected || requestId !== state.schemaRequest || connectionId !== state.activeConnectionId) return;
        const database = node.dataset.database;
        if (!database || query) return;
        if (node.open) {
          state.expandedDatabases.add(database);
          if (!state.schemasByDatabase.has(database) && !state.schemaLoading.has(database)) void loadSchemas(database);
        } else {
          state.expandedDatabases.delete(database);
        }
      });
    });
  refs.objectTree
    .querySelectorAll("details.tree-schema[data-schema][data-database]")
    .forEach((node) => {
      node.addEventListener("toggle", () => {
        syncTreeToggle(node.querySelector('summary'), node.open);
        if (!node.isConnected || requestId !== state.schemaRequest || connectionId !== state.activeConnectionId) return;
        if (query) return;
        const name = node.dataset.schema;
        const database = node.dataset.database;
        const key = schemaKey(database, name);
        const wasOpen = state.expandedSchemas.has(key);
        if (node.open && !wasOpen) {
          state.expandedSchemas.add(key);
          loadSchemaObjects(database, name);
        } else if (!node.open && wasOpen) state.expandedSchemas.delete(key);
      });
    });
}
// Selection belongs to the browser, independently of the object inspected in a tab.
function treeTargetFromNode(node) {
  const scope = { connectionId: state.activeConnectionId, driver: driverForConnection(state.activeConnectionId) };
  const row = node.closest(".tree-object, .category-summary, summary, .tree-root");
  if (!row) return null;
  if (row.matches(".tree-root")) return { ...scope, type: "root" };
  if (row.matches("[data-redis-key]")) return { ...scope, type: "redis-key", database: Number(row.dataset.redisDb), key: row.dataset.redisKey };
  if (row.matches("[data-object-id]")) {
    const object = objectFromTreeRow(row);
    return object ? { ...scope, type: "object", object } : null;
  }
  const redis = row.closest(".redis-database");
  if (redis) return { ...scope, type: "redis-database", database: Number(redis.dataset.redisDb) };
  const schema = row.closest(".tree-schema");
  if (schema) return { ...scope, type: row.matches(".category-summary") ? "category" : "schema", database: schema.dataset.database, schema: schema.dataset.schema, kind: row.closest(".tree-category")?.dataset.kind };
  const database = row.closest(".tree-database");
  return database ? { ...scope, type: "database", database: database.dataset.database } : null;
}
function treeTargetKey(target) {
  if (!target) return null;
  return JSON.stringify([target.connectionId, target.type, target.object?.database ?? target.database, target.object?.schema ?? target.schema, target.object?.id ?? target.key ?? target.kind]);
}
function applyTreeSelection() {
  for (const node of refs.objectTree.querySelectorAll(".tree-root, summary, .category-summary, .tree-object")) {
    const selected = Boolean(state.selectedTreeKey && treeTargetKey(treeTargetFromNode(node)) === state.selectedTreeKey);
    node.classList.toggle("selected", selected);
    if (selected) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
}
function toggleTreeRow(row, expanded) {
  const isCategory = row.matches('.category-summary');
  const current = isCategory ? row.getAttribute('aria-expanded') === 'true' : row.parentElement.open;
  const next = expanded ?? !current;
  if (!setTreeRowExpanded(row, next)) return;
  if (isCategory) {
    const target = treeTargetFromNode(row);
    const key = JSON.stringify([target.database, target.schema, target.kind]);
    if (next) { state.expandedCategories.add(key); state.collapsedCategories.delete(key); }
    else { state.expandedCategories.delete(key); state.collapsedCategories.add(key); }
  }
}
function clearTreeSelection() {
  state.selectedTreeKey = null;
  state.selectedObject = null;
  refs.objectSelection.textContent = "展开数据库和 schema，浏览对象";
  applyTreeSelection();
  if (refs.objectTree.contains(document.activeElement)) document.activeElement?.blur();
}
function selectTreeTarget(target) {
  if (!target) return;
  state.selectedTreeKey = treeTargetKey(target);
  refs.objectSelection.textContent = contextTargetLabel(target);
  applyTreeSelection();
}
function redisPage(database, pattern = state.redisPattern) {
  const existing = state.redisPages.get(database);
  if (!existing || existing.pattern !== pattern) {
    const page = { keys: [], cursor: 0, pattern, loading: false, loaded: false, error: null };
    state.redisPages.set(database, page);
    return page;
  }
  return existing;
}
function renderRedisTree() {
  refs.objectTree.dataset.driver = "redis";
  const query = refs.objectSearch.value.trim().toLowerCase();
  const expanded = state.redisExpanded;
  const total = state.redisDatabases.length;
  const loadedCount = [...expanded].reduce((sum, database) => sum + (redisPage(database).keys.length || 0), 0);
  const chunks = [`<div class="tree-root redis-tree-root" tabindex="0" aria-label="Redis 实例"><span class="database-icon driver-tree-icon">${redisIcon}</span><span class="tree-label">Redis 数据库</span><small>${expanded.size}/${total || "—"}</small><button class="icon-btn tree-root-action" data-refresh-redis title="刷新 Redis key">↻</button></div>`];
  if (!state.activeConnectionId || state.connectionStatuses[state.activeConnectionId] !== "connected") {
    chunks.push('<div class="tree-status">连接后加载 Redis DB</div>');
  } else if (!state.redisDatabases.length) {
    chunks.push(`<div class="tree-status">${state.redisDatabaseError ? `读取 Redis DB 失败：${escapeHtml(state.redisDatabaseError)}` : "正在读取 Redis DB…"}</div>`);
  } else {
    for (const database of state.redisDatabases) {
      const index = database.index;
      const page = redisPage(index);
      const keys = page.keys.filter((key) => !query || key.toLowerCase().includes(query));
      const open = expanded.has(index) ? " open" : "";
      const count = database.keyCount ?? (page.keys.length ? `${page.keys.length}${page.cursor ? "+" : ""}` : "—");
      chunks.push(`<details class="tree-database redis-database" data-redis-db="${index}"${open}><summary>${treeToggle(`DB ${index}`, Boolean(open))}<span class="database-icon redis-db-icon">${databaseIcon}</span><span class="tree-label">DB ${index}</span><span class="count">${escapeHtml(count)}</span></summary><div class="database-children redis-database-children">`);
      if (page.loading && !page.keys.length) chunks.push('<div class="tree-status">读取 key…</div>');
      else {
        if (page.loading) chunks.push('<div class="tree-status">正在刷新 key…</div>');
        if (page.error) chunks.push(`<div class="tree-status">刷新 key 失败，保留已加载结果：${escapeHtml(page.error)}</div>`);
        if (!keys.length && !page.error) chunks.push(`<div class="tree-status">${query ? "没有匹配的 Redis key" : "没有 Redis key"}</div>`);
        if (keys.length) {
        chunks.push('<div class="redis-key-list">');
        for (const key of keys) {
          chunks.push(`<div class="tree-object redis-key-object" data-redis-key="${escapeHtml(key)}" data-redis-db="${index}"><span class="object-kind-icon redis-key-icon">◇</span><button class="object-main" title="${escapeHtml(key)}">${escapeHtml(key)}</button></div>`);
        }
        chunks.push('</div>');
        }
      }
      if (page.cursor) chunks.push(`<button class="quiet-btn redis-load-more" data-load-more-redis-db="${index}" type="button">加载更多 key</button>`);
      chunks.push('</div></details>');
    }
    if (!loadedCount && !expanded.size) chunks.push('<div class="tree-status">选择要展开的 Redis DB</div>');
  }
  refs.objectTree.innerHTML = chunks.join("");
  applyTreeSelection();
  const connectionId = state.activeConnectionId;
  const requestId = state.redisRequest;
  refs.objectTree.querySelectorAll("details.redis-database[data-redis-db]").forEach((node) => {
    node.addEventListener("toggle", () => {
      syncTreeToggle(node.querySelector('summary'), node.open);
      if (!node.isConnected || !isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId)) return;
      const database = Number(node.dataset.redisDb);
      if (!Number.isInteger(database)) return;
      if (node.open === state.redisExpanded.has(database)) return;
      if (node.open) {
        state.redisExpanded.add(database);
        const page = redisPage(database);
        if (!page.keys.length && !page.loading) void loadRedisKeys(database, 0, state.redisPattern);
      } else {
        state.redisExpanded.delete(database);
      }
      const count = refs.objectTree.querySelector(".redis-tree-root small");
      if (count) count.textContent = `${state.redisExpanded.size}/${state.redisDatabases.length || "—"}`;
    });
  });
}
async function refreshRedisTree() {
  const connectionId = state.activeConnectionId;
  if (!connectionId) return false;
  // A refresh supersedes any earlier Redis tree request, including another
  // refresh started by a rapid double click.
  const requestId = ++state.redisRequest;
  const expanded = new Set(state.redisExpanded);
  const databases = await call("list_redis_databases", { connectionId });
  if (!isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId)) return false;
  state.redisDatabases = databases
    .map((database) => ({
      index: Number(database.index),
      keyCount: Number.isFinite(Number(database.keyCount)) ? Number(database.keyCount) : null,
      current: Boolean(database.current),
    }))
    .filter((database) => Number.isInteger(database.index) && database.index >= 0);
  const available = new Set(state.redisDatabases.map((database) => database.index));
  state.redisExpanded = new Set([...expanded].filter((database) => available.has(database)));
  for (const database of state.redisPages.keys()) {
    if (!available.has(database)) state.redisPages.delete(database);
  }
  renderRedisTree();
  state.redisDatabaseError = null;
  const results = await Promise.all([...state.redisExpanded].map((database) => loadRedisKeys(database, 0, state.redisPattern, connectionId, requestId)));
  return results.every(Boolean) && isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId);
}
async function loadRedisKeys(database = state.redisActiveDatabase, cursor = 0, pattern = state.redisPattern, connectionId = state.activeConnectionId, requestId = state.redisRequest) {
  if (!connectionId || !Number.isInteger(Number(database))) return;
  database = Number(database);
  const pageState = redisPage(database, pattern);
  const generation = (state.redisScanGenerations.get(database) || 0) + 1;
  state.redisScanGenerations.set(database, generation);
  pageState.loading = true;
  pageState.error = null;
  renderRedisTree();
  try {
    const page = await call("list_redis_keys", {
      connectionId,
      database,
      cursor,
      pattern,
      count: 200,
    });
    if (!isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId) || generation !== state.redisScanGenerations.get(database)) return;
    if (cursor === 0) pageState.keys = [];
    pageState.keys.push(...(page.keys || []));
    pageState.cursor = Number(page.cursor || 0);
    pageState.pattern = pattern;
    pageState.loading = false;
    pageState.loaded = true;
    state.redisPattern = pattern;
    state.redisActiveDatabase = database;
    renderRedisTree();
    return true;
  } catch (error) {
    if (!isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId) || generation !== state.redisScanGenerations.get(database)) return;
    pageState.loading = false;
    pageState.error = errorText(error);
    renderRedisTree();
    return false;
  }
}
async function openRedisValueTab(key, database = state.redisActiveDatabase) {
  const connectionId = state.activeConnectionId;
  const requestId = state.redisRequest;
  const redisDb = Number(database);
  const tab = addTab("", connectionId);
  if (!tab) return;
  tab.title = key;
  tab.redisKey = key;
  tab.redisDb = Number.isInteger(redisDb) && redisDb >= 0 ? redisDb : redisProfileDatabase(state.profiles.find((profile) => profile.id === connectionId));
  tab.database = String(tab.redisDb);
  tab.tableView = true;
  tab.mode = "write";
  persistTabs();
  renderTabs();
  try {
    const value = await call("get_redis_value", { connectionId, key, database: tab.redisDb });
    if (requestId !== state.redisRequest || state.activeConnectionId !== connectionId) return;
    applyRedisValueResult(tab, value, connectionId, tab.redisDb);
    tab.outputTab = "result";
    renderTabs();
    renderOutput();
  } catch (error) {
    if (requestId !== state.redisRequest || state.activeConnectionId !== connectionId) return;
    tab.error = true;
    tab.message = `读取 Redis key 失败：${errorText(error)}`;
    tab.outputTab = "message";
    renderOutput();
  }
}
function applyRedisValueResult(tab, value, connectionId, database = redisTabDatabase(tab)) {
  tab.result = {
    columns: value.columns || [],
    rows: value.rows || [],
    rowCount: (value.rows || []).length,
    elapsedMs: 0,
    truncated: false,
    truncatedReason: null,
    executed: true,
    connectionId,
  };
  tab.result.finishedAt = Date.now();
  tab.result.bytes = estimateResultBytes(tab.result);
  trimResultMemory(tab);
  tab.redisDb = Number(database);
  tab.database = String(database);
  tab.redisType = value.keyType;
  tab.redisTtl = value.ttl;
  tab.message = `Redis ${value.keyType} · TTL ${value.ttl}`;
  tab.outputTab = "result";
}
async function loadSchemas(database, connectionId = state.activeConnectionId, request = state.schemaRequest) {
  if (request !== state.schemaRequest || state.activeConnectionId !== connectionId) return false;
  state.schemaLoading.add(database);
  state.schemaErrors.delete(database);
  renderTree();
  try {
    const schemas = await call("list_schemas", { connectionId, database });
    if (
      request !== state.schemaRequest ||
      state.activeConnectionId !== connectionId
    )
      return;
    state.schemaLoading.delete(database);
    state.schemasByDatabase.set(database, schemas);
    // A successful schema refresh invalidates the catalog objects for this
    // database. Keep them only while the schema request is in flight so a
    // failed refresh can still show the previous tree.
    for (const key of [...state.objectsBySchema.keys()]) {
      if (key.startsWith(`${database}\u0000`)) state.objectsBySchema.delete(key);
    }
    for (const key of [...state.objectRequests.keys()]) {
      if (key.startsWith(`${database}\u0000`)) state.objectRequests.delete(key);
    }
    const available = new Set(schemas.map((schema) => schema.name));
    for (const key of [...state.expandedSchemas]) {
      if (key.startsWith(`${database}\u0000`) && !available.has(key.split("\u0000")[1]))
        state.expandedSchemas.delete(key);
    }
    const saved = readVisibleSchemas(connectionId, database);
    const selected = new Set(
      [...(saved || available)].filter((name) => available.has(name)),
    );
    if (!selected.size && available.size) selected.add(schemas[0].name);
    state.visibleSchemasByDatabase.set(database, selected);
    renderTree();
    const results = await Promise.all(
      [...state.expandedSchemas]
        .filter((key) => key.startsWith(`${database}\u0000`) && available.has(key.split("\u0000")[1]))
        .map((key) => loadSchemaObjects(database, key.split("\u0000")[1])),
    );
    return results.every(Boolean);
  } catch (error) {
    if (
      request === state.schemaRequest &&
      state.activeConnectionId === connectionId
    ) {
      state.schemaLoading.delete(database);
      state.schemaErrors.set(database, errorText(error));
      renderTree();
    }
    return false;
  }
}
async function loadVisibleSchemas(force = true) {
  if (!force) return;
  const request = ++state.schemaRequest;
  for (const database of state.visibleDatabases) {
    state.schemaLoading.add(database);
    state.schemaErrors.delete(database);
  }
  renderTree();
  const results = await Promise.all(
    [...state.visibleDatabases].map((database) =>
      loadSchemas(database, state.activeConnectionId, request),
    ),
  );
  return results.every(Boolean);
}
async function loadSchemaObjects(database, schemaName, { force = false } = {}) {
  const connectionId = state.activeConnectionId;
  const requestId = state.schemaRequest;
  const key = schemaKey(database, schemaName);
  if (!force && state.objectRequests.has(key)) return state.objectRequests.get(key);
  if (!force && state.objectsBySchema.has(key)) return true;
  const isCurrent = () => requestId === state.schemaRequest &&
    state.activeConnectionId === connectionId && state.objectRequests.get(key) === request;
  // Store the whole operation so concurrent readers also receive handled failures.
  const request = Promise.resolve().then(async () => {
    try {
      const objects = await call("get_schema_objects", { connectionId, schemaName, database });
      if (!isCurrent()) return false;
      state.objectsBySchema.set(key, objects.map((object) => ({ ...object, database })));
      return true;
    } catch (error) {
      if (isCurrent()) showToast(`读取 ${database}.${schemaName} 失败：${errorText(error)}`, "error");
      return false;
    } finally {
      if (state.objectRequests.get(key) === request) {
        state.objectRequests.delete(key);
        if (requestId === state.schemaRequest && state.activeConnectionId === connectionId) renderTree();
      }
    }
  });
  state.objectRequests.set(key, request);
  renderTree();
  return request;
}

function renderHistory() {
  const query = refs.historySearch.value;
  const entries = state.history.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    matchesWorkspaceSearch(query, entry.sql, historyContext(entry, state.profiles)));
  refs.clearHistory.disabled = !state.history.length;
  refs.historySearch.disabled = !state.history.length;
  refs.historyCount.textContent = query.trim() ? `${entries.length}/${state.history.length}` : String(state.history.length);
  refs.recentQueries.innerHTML = entries.length
    ? entries.map(({ entry, index }) => {
        const context = historyContext(entry, state.profiles);
        const time = historyTimeLabel(entry.timestamp);
        return `<button class="recent-query" data-history-index="${index}" title="${escapeHtml(`${context}\n${entry.sql}`)}"><span>${svgIcon('<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>')}</span><span class="recent-copy"><strong>${escapeHtml(entry.sql.replace(/\s+/g, " ").trim())}</strong><small>${escapeHtml(context)}${time ? ` · ${time}` : ""}</small></span></button>`;
      }).join("")
    : `<div class="small-empty">${state.history.length ? '没有找到匹配的查询<br/><button data-clear-history-search>清除搜索</button>' : '最近执行的查询会保留在这里<br/>随时找回 SQL，继续工作'}</div>`;
}
function recordHistory(sql, tab = activeTab()) {
  const normalized = sql.trim();
  if (!normalized) return;
  state.history = prependHistoryEntry(state.history, {
    sql: normalized,
    connectionId: tab?.connectionId || state.activeConnectionId,
    database: tabDatabase(tab),
    schema: tabSchema(tab),
    timestamp: Date.now(),
  });
  persistHistory();
  renderHistory();
}

function loadHistoryEntry(index) {
  const entry = state.history[index];
  if (!entry) return;
  openSavedQuery({ ...entry, connectionId: historyConnectionId(entry, state.profiles), database: historyDatabase(entry, state.profiles) });
}
function openSavedQuery(entry) {
  closeRedisConsole();
  const connectionId = entry.connectionId || null;
  const tab = addTab(entry.sql, connectionId, null, {
    title: entry.title, database: entry.database, schema: entry.schema,
  });
  if (!tab) return;
  persistTabs();
  state.editor?.focus();
  const missing = connectionId && !state.profiles.some(profile => profile.id === connectionId);
  showToast(missing ? "SQL 已打开，原连接不可用；可复制 SQL 到新建查询中继续。" : "已在新标签打开查询");
}
function renderTabs() {
  if (refs.saveQueryFavorite) {
    const tab = activeExecutionTab();
    refs.saveQueryFavorite.disabled = !tab || !tab.sql?.trim() || Boolean(tab.console || tab.structureOnly || driverForTab(tab) === "redis");
  }
  const focusedTab = refs.queryTabs.contains(document.activeElement) ? document.activeElement : null;
  const focusedTabId = focusedTab?.dataset.tabId;
  const focusedCloseId = focusedTab?.dataset.closeTab;
  refs.queryTabs.innerHTML = state.tabs
    .map(
      (tab) =>
        `<div class="query-tab ${!state.redisConsole && tab.id === state.activeTabId ? "active" : ""} ${tab.running ? "running" : ""}" data-tab-id="${escapeHtml(tab.id)}" role="presentation"><button class="tab-select" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${!state.redisConsole && tab.id === state.activeTabId}" tabindex="${tab.id === state.activeTabId ? 0 : -1}" title="${escapeHtml(`${tab.title} · ${queryTargetDescription(tab)}`)}"><span class="tab-glyph">${tab.console ? "CLI" : tab.redisKey ? "KV" : tab.structureOnly ? "DDL" : tab.browse ? "表" : "SQL"}</span><span class="tab-label">${escapeHtml(tab.title)}</span></button><button class="tab-close" data-close-tab="${escapeHtml(tab.id)}" title="关闭标签" aria-label="关闭 ${escapeHtml(tab.title)}">×</button></div>`,
    )
    .join("");
  if (focusedTabId) refs.queryTabs.querySelector(`.tab-select[data-tab-id="${CSS.escape(focusedTabId)}"]`)?.focus({ preventScroll: true });
  if (focusedCloseId) {
    const target = refs.queryTabs.querySelector(`[data-close-tab="${CSS.escape(focusedCloseId)}"]`) || refs.queryTabs.querySelector('[aria-selected="true"]') || refs.addQueryTab;
    target.focus({ preventScroll: true });
  }
  const tab = activeExecutionTab();
  renderQueryTarget(tab);
  const activeDriver = state.profiles.find((profile) => profile.id === tab?.connectionId)?.driver;
  if (tab && activeDriver !== "redis") {
    refs.editorHint.textContent = `${activeDriver === "mysql" ? "MySQL" : "PostgreSQL"} · ${queryTargetDescription(tab)} · 选中 SQL 可单独执行`;
  }
  const isRedis = activeDriver === "redis";
  if (isRedis) refs.editorHint.textContent = "Redis 命令 · 只读锁定后仅允许安全读取命令";
  const isConsole = tab?.console === true;
  if (refs.beginTransaction) refs.beginTransaction.hidden = isRedis;
  if (refs.commitTransaction) refs.commitTransaction.hidden = isRedis;
  if (refs.rollbackTransaction) refs.rollbackTransaction.hidden = isRedis;
  if (refs.formatQuery) refs.formatQuery.hidden = isConsole;
  if (refs.importSql) refs.importSql.hidden = isConsole;
  if (refs.saveSql) refs.saveSql.hidden = isConsole;
  if (refs.modeBadge) refs.modeBadge.hidden = isConsole;
  if (!tab) {
    queryStructureSelect.close();
    renderWorkspaceMode(undefined);
    if (refs.formatQuery) refs.formatQuery.disabled = true;
    if (refs.modeBadge) refs.modeBadge.disabled = true;
    if (refs.beginTransaction) refs.beginTransaction.disabled = true;
    if (refs.commitTransaction) refs.commitTransaction.disabled = true;
    if (refs.rollbackTransaction) refs.rollbackTransaction.disabled = true;
    refs.runQuery.disabled = true;
    refs.stopQuery.disabled = true;
    refs.resultTab.disabled = refs.structureTab.disabled = refs.messageTab.disabled = true;
    return;
  }
  refs.resultTab.disabled = refs.messageTab.disabled = false;
  if (refs.modeBadge) refs.modeBadge.disabled = false;
  const queryStructure = !tab?.browse && !tab?.structure && !tab?.structureOnly;
  refs.structureTab.disabled = activeDriver === "redis" || !tab?.connectionId || Boolean(tab.structureChoosing);
  refs.structureTab.setAttribute("aria-busy", String(Boolean(tab.structureChoosing)));
  refs.structureTab.title = activeDriver === "redis" ? "Redis 没有表结构" : queryStructure ? "查看 SQL 引用的表结构，或选择表" : "查看表结构";
  if (queryStructure && activeDriver !== "redis" && tab?.connectionId) {
    refs.structureTab.setAttribute("aria-haspopup", "listbox");
    refs.structureTab.setAttribute("aria-controls", "queryStructureList");
  } else {
    queryStructureSelect.close();
    refs.structureTab.removeAttribute("aria-haspopup");
    refs.structureTab.removeAttribute("aria-controls");
  }
  if (refs.formatQuery) {
    refs.formatQuery.disabled = activeDriver === "redis";
    refs.formatQuery.title = activeDriver === "redis" ? "Redis 命令不使用 SQL 格式化" : "格式化 SQL";
  }
  renderWorkspaceMode(tab);
  const mode = tab?.mode === "write" ? "write" : "read";
  const txOpen = Boolean(
    tab?.connectionId && state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab))),
  );
  refs.beginTransaction.hidden = isRedis || (mode === "read" && !txOpen);
  refs.commitTransaction.hidden = isRedis || !txOpen;
  refs.rollbackTransaction.hidden = isRedis || !txOpen;
  if (refs.modeBadge) {
    refs.modeBadge.textContent = mode === "read" ? "🔒 只读" : "🔓 可写";
    refs.modeBadge.setAttribute("aria-pressed", String(mode === "read"));
    refs.modeBadge.title = mode === "read" ? "已锁定为只读，点击解锁" : "当前可执行写入，点击锁定为只读";
  }
  const busy = Boolean(tab?.running || tab?.confirming || tab?.resolvingTarget || tab?.changingTransaction || cellWritePending(tab));
  if (refs.modeBadge) refs.modeBadge.disabled = cellWritePending(tab);
  if (refs.beginTransaction) refs.beginTransaction.disabled = !tab?.connectionId || txOpen || mode === "read" || busy || Boolean(queryTargetData(tab)?.loading || queryTargetData(tab)?.error);
  if (refs.commitTransaction) refs.commitTransaction.disabled = !txOpen || busy;
  if (refs.rollbackTransaction) refs.rollbackTransaction.disabled = !txOpen || busy;
  const target = queryTargetData(tab);
  refs.runQuery.disabled = Boolean(busy || (!isRedis && (target?.loading || target?.error || !tab?.connectionId)));
  refs.stopQuery.disabled = !tab?.running;
}
function renderWorkspaceMode(tab = activeExecutionTab()) {
  document.body.classList.toggle("empty-workspace-mode", !tab);
  document.body.classList.toggle("structure-only-mode", Boolean(tab?.structureOnly));
  const tableView = Boolean((tab?.browse || tab?.redisKey) && tab.tableView !== false);
  document.body.classList.toggle("table-browse-mode", tableView);
  if (refs.queryToolbar) refs.queryToolbar.hidden = !tab || tableView || Boolean(tab?.console);
  if (refs.tableToolbar) refs.tableToolbar.hidden = !tableView;
  if (tableView) {
    const browse = tab.browse;
    refs.tableToolbarTitle.textContent = tab.redisKey || `${browse.schema}.${browse.name}`;
    refs.tableToolbarMeta.textContent = tab.redisKey ? "Redis" : `${browse.pageSize} 行/页`;
    if (refs.openTableDdl) refs.openTableDdl.hidden = Boolean(tab.redisKey);
    if (refs.openTableSql) refs.openTableSql.hidden = Boolean(tab.redisKey);
    if (refs.newRow) refs.newRow.hidden = Boolean(tab.redisKey);
    if (refs.editRow) refs.editRow.hidden = Boolean(tab.redisKey);
    if (refs.deleteRows) refs.deleteRows.hidden = Boolean(tab.redisKey);
    if (refs.refreshTableData) refs.refreshTableData.disabled = Boolean(tab.running || tab.refreshing || cellWritePending(tab));
  } else {
    if (refs.openTableDdl) refs.openTableDdl.hidden = false;
    if (refs.openTableSql) refs.openTableSql.hidden = false;
    if (refs.refreshTableData) refs.refreshTableData.disabled = false;
  }
}
function anyQueryRunning() {
  return Boolean(state.redisConsole?.running) || state.tabs.some((tab) => tab.running);
}
function rememberActiveView() {
  // addTab pushes its new tab before activation. With no previous active tab,
  // activeTab's fallback would overwrite that tab with the empty editor.
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (!tab || !state.editor) return;
  state.editor.plugin(sqlIme)?.finish();
  tab.editorState = state.editor.state;
  tab.sql = tab.console && redisEditor
    ? redisEditor.getValue()
    : state.editor.state.doc.toString();
  tab.editorScroll = {
    top: state.editor.scrollDOM.scrollTop,
    left: state.editor.scrollDOM.scrollLeft,
  };
  if (
    state.gridResult === tab.result &&
    typeof resultGrid.getViewState === "function"
  )
    tab.gridState = { ...resultGrid.getViewState(), filter: state.gridFilter };
}
function activateTab(id, focus = true) {
  if (id === state.activeTabId && !state.redisConsole) return;
  const next = state.tabs.find((tab) => tab.id === id);
  if (!next) return;
  queryStructureSelect.close();
  const previous = activeTab();
  if (previous) {
    previous.structureChoiceRequest = null;
    previous.structureChoosing = false;
  }
  rememberActiveView();
  state.redisConsole = null;
  state.activeTabId = id;
  state.editor.setState(
    next.editorState || (next.editorState = makeEditorState(next)),
  );
  updateEditorSchema();
  state.editor.scrollDOM.scrollTop = next.editorScroll?.top || 0;
  state.editor.scrollDOM.scrollLeft = next.editorScroll?.left || 0;
  refs.resultFilter.value = next.filter || "";
  renderTabs();
  renderOutput();
  updateCursor();
  persistTabs();
  if (focus) {
    if (next.console) redisEditor?.focus();
    else state.editor.focus();
  }
  refs.queryTabs
    .querySelector(`[data-tab-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function addTab(
  sql = "",
  connectionId = activeExecutionTab()?.connectionId || state.activeConnectionId,
  browse = null,
  options = {},
) {
  if (state.tabs.length >= MAX_QUERY_TABS) {
    showToast(`最多打开 ${MAX_QUERY_TABS} 个查询，请先关闭不需要的标签`);
    return null;
  }
  const selected = !activeExecutionTab() && refs.objectTree.querySelector('[aria-current="true"]');
  const target = selected ? treeTargetFromNode(selected) : null;
  const inherited = arguments.length < 2 ? activeExecutionTab() || (target && {
    connectionId: target.connectionId,
    database: target.object?.database ?? target.database,
    schema: target.object?.schema ?? target.schema,
  }) : null;
  const profile = state.profiles.find((item) => item.id === connectionId);
  const tabBrowse = browse
    ? { ...browse, connectionId: browse.connectionId || connectionId }
    : null;
  const openedObject = objectTabTarget(options.openedObject || tabBrowse, connectionId);
  const structureOnly = Boolean(openedObject && options.openedObjectView === "structure" && !tabBrowse);
  const database = options.database ?? browse?.database ?? (inherited
    ? profile?.driver === "redis" ? String(redisTabDatabase(inherited)) : tabDatabase(inherited)
    : profile?.database) ?? null;
  const redisDb = profile?.driver === "redis" ? resolveRedisDatabase({ database }, profile) : null;
  const tab = {
    id: makeId("query"),
    title: options.title || browse?.name || `查询 ${nextQueryNumber()}`,
    sql,
    connectionId,
    database: redisDb === null ? database : String(redisDb),
    redisDb,
    schema: options.schema ?? browse?.schema ?? (inherited ? tabSchema(inherited) : null),
    mode: "write",
    browse: tabBrowse,
    tableView: Boolean(tabBrowse),
    openedObject,
    openedObjectView: options.openedObjectView || (tabBrowse ? "data" : null),
    structureOnly,
    inspectedObject: structureOnly ? openedObject : null,
    result: emptyResult(),
    message: "",
    outputTab: structureOnly ? "structure" : "result",
    filter: "",
    console: false,
    consoleHistory: [],
  };
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}
async function closeTab(id) {
  const target = state.tabs.find((tab) => tab.id === id);
  if (!target) return;
  if (target.running || target.opening || target.confirming || target.resolvingTarget || target.cellSaving) {
    showToast("请先停止此查询，再关闭标签");
    return;
  }
  if (!await confirmDiscardCellEdits([target])) return;
  if (state.tabs.length === 1) {
    closeTabsByIds([id]);
    return;
  }
  const index = state.tabs.indexOf(target);
  if (id === state.activeTabId)
    activateTab(state.tabs[index === 0 ? 1 : index - 1].id);
  state.tabs = state.tabs.filter((tab) => tab.id !== id);
  renderTabs();
  persistTabs();
}
function updatePageControls() {
  const tab = activeTab();
  const browse = tab?.browse;
  refs.pageControls.hidden =
    !browse || (tab.outputTab || "result") !== "result";
  if (!browse) return;
  refs.pageLabel.textContent = `第 ${browse.page + 1} 页 · ${browse.pageSize} 行/页`;
  refs.previousPage.disabled = browse.page === 0 || Boolean(tab.running);
  refs.nextPage.disabled = !browse.hasNext || Boolean(tab.running);
}
function trimResultMemory(current) {
  const tabs = selectResultsToRelease(state.tabs, {
    currentTab: current, activeTab: activeTab(),
    isProtected: tab => Boolean(resultGrid.getCellEditDraft(tab.result.rows)),
  });
  for (const oldest of tabs) {
    oldest.result = emptyResult();
    oldest.gridState = null;
    oldest.message = "已释放此查询的结果内存，SQL 已保留。重新执行可加载结果。";
    oldest.outputTab = "message";
  }
}

function renderOutput() {
  const tab = activeTab();
  resultGrid.closeFilter(false);
  if (state.redisConsole) {
    renderWorkspaceMode(state.redisConsole);
    refs.editorResult.hidden = true;
    refs.redisConsolePanel.hidden = false;
    renderRedisConsole(state.redisConsole);
    return;
  }
  if (!tab) {
    renderWorkspaceMode(undefined);
    refs.queryToolbar.hidden = true;
    refs.editorResult.hidden = false;
    refs.redisConsolePanel.hidden = true;
    refs.resultEmpty.hidden = false;
    refs.resultEmpty.querySelector("h2").textContent = state.profiles.length ? "准备好，继续探索数据" : "让数据工作，更专注";
    refs.resultEmpty.querySelector("p").textContent = state.profiles.length
      ? "打开一个查询，或从左侧选择数据库中的表。你的 SQL 草稿会自动保存。"
      : "连接你的数据库，浏览数据、编写查询，在一个工作区完成。";
    refs.emptyActions.hidden = false;
    refs.welcomeFeatures.hidden = false;
    refs.emptyNextAction.hidden = true;
    refs.welcomeConnect.textContent = state.profiles.length ? "＋ 新建连接" : "＋ 连接数据库";
    refs.resultEmpty.dataset.state = "welcome";
    refs.resultGrid.hidden = true;
    refs.structurePanel.hidden = true;
    refs.messagePanel.hidden = true;
    refs.resultFilter.hidden = true;
    refs.resultCount.textContent = "—";
    refs.resultMeta.textContent = "尚未打开查询";
    refs.resultMeta.classList.remove("error");
    refs.copyResults.disabled = refs.exportResults.disabled = true;
    if (state.gridResult) resultGrid.clear();
    state.gridResult = null;
    state.gridFilter = null;
    updatePageControls();
    return;
  }
  if (tab.console) {
    refs.editorResult.hidden = true;
    refs.redisConsolePanel.hidden = false;
    renderRedisConsole(tab);
    updatePageControls();
    return;
  }
  refs.editorResult.hidden = false;
  refs.redisConsolePanel.hidden = true;
  const result = tab.result;
  resultGrid.viewport.setAttribute("aria-readonly", String(tab.mode !== "write" || (!tab.browse && !tab.redisKey)));
  const mode = tab.outputTab || "result";
  renderWorkspaceMode(tab);
  const filter = (tab.filter || "").trim().toLowerCase();
  refs.resultFilter.value = tab.filter || "";
  for (const [key, name] of [
    ["resultTab", "result"],
    ["structureTab", "structure"],
    ["messageTab", "message"],
  ]) {
    refs[key].classList.toggle("active", mode === name);
    refs[key].setAttribute("aria-selected", String(mode === name));
    refs[key].tabIndex = mode === name ? 0 : -1;
  }
  refs.emptyActions.hidden = true;
  refs.welcomeFeatures.hidden = true;
  refs.resultEmpty.dataset.state = tab.running ? "running" : tab.error ? "error" : "idle";
  refs.emptyNextAction.hidden = result.columns.length > 0 || (result.executed && !tab.error);
  const emptyAction = emptyResultAction(tab);
  refs.emptyNextAction.textContent = emptyAction.label;
  refs.emptyNextAction.disabled = Boolean(emptyAction.disabled);
  refs.resultEmpty.hidden = mode !== "result" || result.columns.length > 0;
  refs.resultEmpty.querySelector("h2").textContent = tab.running
    ? "查询执行中…"
    : tab.cancelled
      ? "查询已取消"
    : tab.error
      ? "查询未完成"
      : result.executed
        ? "语句执行成功"
        : tab.browse && tab.tableView !== false ? "尚未加载表数据"
          : tab.redisKey && tab.tableView !== false ? "尚未加载 Key 数据"
            : "从一个查询开始";
  refs.resultEmpty.querySelector("p").textContent = tab.running
    ? "可以在其他标签继续工作。"
    : tab.cancelled
      ? "可以修改 SQL 后重新执行。"
    : tab.error
      ? "在消息页查看错误详情。"
      : result.executed
        ? "这条语句没有返回结果集。"
        : tab.redisKey
          ? "点击加载数据，查看这个 Key 的内容。"
          : tab.browse && tab.tableView !== false
            ? "点击上方「刷新」加载表数据，或打开 SQL 编辑器调整查询。"
            : tab.connectionId ? "编写 SQL 后按 ⌘ Enter 执行，也可以选中部分语句单独执行。" : "先选择一个数据库连接，再开始查询。";
  refs.resultGrid.hidden = mode !== "result" || !result.columns.length;
  refs.structurePanel.hidden = mode !== "structure";
  refs.messagePanel.hidden = mode !== "message";
  refs.resultFilter.hidden = mode !== "result" || !result.columns.length;
  if (state.gridResult !== result) {
    state.gridResult = null;
    resultGrid.setResult({ columns: result.columns, rows: result.rows });
    // Filtering retains original row indices so inspection/editing/export agree.
    resultGrid.textFilter = filter;
    if (tab.gridState) resultGrid.restoreViewState(tab.gridState);
    else resultGrid.applyFilters();
    state.gridResult = result;
    state.gridFilter = filter;
  } else if (state.gridFilter !== filter) {
    state.gridFilter = filter;
    resultGrid.setTextFilter(filter);
  }
  const count = resultGrid.visibleOrder.length;
  refs.selectionCount.textContent = resultGrid.selectedColumns?.size ? `已选 ${resultGrid.selectedColumns.size} 列` : resultGrid.selected.size ? `已选 ${resultGrid.selected.size}/${count} 行` : "";
  const filtered = Boolean(filter || resultGrid.filters.length);
  refs.resultCount.textContent = result.executed
    ? filtered ? `${count}/${result.rowCount}` : String(result.rowCount)
    : "—";
  const source =
    result.connectionLabel ||
    state.profiles.find((p) => p.id === tab.connectionId)?.name ||
    "未选择连接";
  refs.resultMeta.textContent = result.transactionRolledBack
    ? "事务已回滚 · 当前结果已失效，请刷新数据"
    : tab.running
    ? `${source} · 执行中…`
    : tab.refreshing
      ? `${source} · 刷新中…`
    : tab.cancelled
      ? `${source} · 查询已取消`
    : tab.error
      ? `${source} · 查询失败，查看消息`
      : !result.executed
        ? "尚未执行查询"
        : `${source} · ${Number(result.elapsedMs || 0).toFixed(1)} ms · ${result.rowCount} 行${filtered ? ` · 已过滤为 ${count} 行（已加载数据）` : ""}${result.truncated ? ` · 已达${result.truncatedReason === "result_size" ? " 8 MiB" : " 1000 行"}上限` : ""}${tab.browse?.orderNotice ? ` · ${tab.browse.orderNotice}` : ""}`;
  refs.resultMeta.title = refs.resultMeta.textContent;
  refs.resultMeta.classList.toggle("error", Boolean(tab.error || result.transactionRolledBack));
  setSelectableText(refs.messagePanel, tab.message || "执行查询后显示数据库消息");
  refs.copyResults.disabled = refs.exportResults.disabled =
    mode !== "result" || !result.columns.length;
  const editableTable = Boolean(
    tab.mode === "write" && tab.browse && ["table", "partitioned_table"].includes(tab.browse.kind),
  );
  const selectedRows = typeof resultGrid.getSelectedRows === "function"
    ? resultGrid.getSelectedRows()
    : [];
  const hasPrimaryKey = Boolean(tab.browse?.primaryKeys?.length);
  if (refs.newRow) refs.newRow.hidden = !editableTable || mode !== "result";
  if (refs.editRow) {
    refs.editRow.hidden = !editableTable || !hasPrimaryKey || mode !== "result";
    refs.editRow.disabled = selectedRows.length !== 1;
  }
  if (refs.deleteRows) {
    refs.deleteRows.hidden = !editableTable || !hasPrimaryKey || mode !== "result";
    refs.deleteRows.disabled = selectedRows.length === 0;
  }
  if (mode === "structure") {
    if (tab.structure && state.structureRendered !== tab.structure) {
      renderStructure(tab.structure);
      state.structureRendered = tab.structure;
    } else if (!tab.structure) {
      renderStructureLoading(
        tab.structureError ||
          structurePlaceholder(tab),
      );
      state.structureRendered = null;
    }
  }
  updatePageControls();
}

function renderStructureLoading(title = "选择一个对象查看结构") {
  refs.structurePanel.innerHTML = `<div class="empty-state"><div class="empty-symbol">◇</div><h2>${escapeHtml(title)}</h2><p>列、索引、约束与定义会按需读取。</p></div>`;
  const tab = activeTab();
  const object = tab?.inspectedObject || tab?.browse;
  if (object && !tab.structurePending) {
    const refresh = document.createElement("button");
    refresh.className = "secondary-btn";
    refresh.textContent = "刷新结构";
    refresh.addEventListener("click", () => inspectObject(object, { tab, connectionId: object.connectionId || tab.connectionId }));
    refs.structurePanel.querySelector(".empty-state").append(refresh);
  }
}

async function showQueryStructure() {
  const tab = activeTab();
  if (!tab?.connectionId || driverForTab(tab) === "redis") return;
  if (tab.browse || tab.structure || tab.structureOnly) {
    tab.outputTab = "structure";
    renderOutput();
    return;
  }
  if (!refs.queryStructureMenu.hidden) return queryStructureSelect.close(true);
  const request = {};
  const key = queryTargetKey(tab), schema = tabSchema(tab), text = tab.sql;
  let catalogData;
  tab.structureChoiceRequest = request;
  tab.structureChoosing = true;
  renderTabs();
  const current = () => activeTab() === tab && state.tabs.includes(tab) &&
    tab.structureChoiceRequest === request && queryTargetKey(tab) === key && tabSchema(tab) === schema && tab.sql === text &&
    (!catalogData || queryTargetData(tab) === catalogData);
  try {
    const data = await loadQueryCatalog(tab);
    catalogData = data;
    if (!current()) return;
    if (!data?.context) throw new Error(data?.error || "无法读取当前查询的执行位置");
    const catalog = queryStructureObjects(text, data.objects || [], {
      database: tabDatabase(tab) || data.context.database, schema,
      searchPath: data.context.searchPath || [data.context.defaultSchema].filter(Boolean), driver: driverForTab(tab),
    });
    if (catalog.referenced.length === 1 && !catalog.unresolved.length && !data.objectError)
      return void openObjectStructureTab(catalog.referenced[0], tab.connectionId);
    const referenced = new Set(catalog.referenced);
    const preferred = schema || data.context.defaultSchema;
    const objects = catalog.objects.slice().sort((a, b) =>
      Number(referenced.has(b)) - Number(referenced.has(a)) ||
      Number(b.schema === preferred) - Number(a.schema === preferred) ||
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
    queryStructureChoice = { objects, current, connectionId: tab.connectionId };
    queryStructureSelect.update({
      contextKey: request, hidden: false, disabled: false, value: "",
      options: objects.map((object, index) => ({ value: String(index), label: object.name,
        detail: [object.schema, kindLabels[object.kind] || object.kind, referenced.has(object) ? "当前 SQL 引用" : ""].filter(Boolean).join(" · ") })),
    });
    if (data.objectError) showToast(`部分表列表读取失败：${data.objectError}；可点击 Schema 旁的刷新重试`, "error");
    refs.queryStructureEmpty.textContent = objects.length ? "没有匹配的表或视图" : "当前数据库没有可查看的表或视图";
    queryStructureSelect.open();
  } catch (error) {
    if (current()) showToast(`无法查看结构：${errorText(error)}`, "error");
  } finally {
    if (tab.structureChoiceRequest === request) tab.structureChoosing = false;
    renderTabs();
  }
}
function redisConsoleOutput(payload) {
  if (payload?.raw !== undefined && payload.raw !== null) {
    return typeof payload.raw === "string" ? payload.raw : JSON.stringify(payload.raw, null, 2);
  }
  const columns = payload?.columns || [];
  const rows = payload?.rows || [];
  if (!columns.length && !rows.length) return "OK";
  const lines = [];
  if (columns.length) {
    lines.push(columns.join(" | "));
    lines.push(columns.map(() => "---").join(" | "));
  }
  for (const row of rows) lines.push(row.map((value) => cellText(value)).join(" | "));
  return lines.join("\n");
}
function renderRedisConsole(tab) {
  const database = Number.isInteger(tab?.redisDb) ? tab.redisDb : redisTabDatabase(tab);
  const profile = state.profiles.find((item) => item.id === tab.connectionId);
  refs.redisConsoleContext.textContent = `${profile?.name || "Redis"} · DB ${database}`;
  refs.redisConsoleRun.disabled = Boolean(tab.running);
  refs.closeRedisConsole.disabled = Boolean(tab.running);
  if (redisEditorSessionId !== tab.id) { redisEditor?.reset(tab.sql || ""); redisEditorSessionId = tab.id; }
  else redisEditor?.setValue(tab.sql || "");
  refs.redisConsoleHint.textContent = redisCommandHint(redisEditor?.currentLine() || "") || "输入命令查看参数说明";
  const history = tab.consoleHistory || [];
  refs.redisOutputCount.textContent = history.length;
  refs.redisClearOutput.disabled = !history.length || Boolean(tab.running);
  refs.redisClearEditor.disabled = Boolean(tab.running);
  refs.redisConsoleOutput.innerHTML = history.length
    ? history.map((entry, index) => {
      const entryDatabase = entry.database ?? database;
      return `<article class="redis-console-entry${entry.error ? " has-error" : ""}"><div class="redis-entry-header"><span class="redis-entry-status ${entry.pending ? "pending" : entry.error ? "error" : "success"}">${entry.pending ? "执行中" : entry.error ? "失败" : "完成"}</span><span class="redis-entry-database">DB ${entryDatabase}</span><span class="redis-entry-meta">${entry.elapsedMs != null ? `${Number(entry.elapsedMs).toFixed(1)} ms` : ""}</span><span class="toolbar-spacer"></span><button type="button" class="quiet-btn" data-redis-reuse="${index}" title="将命令放回编辑器">复用</button><button type="button" class="quiet-btn" data-redis-copy="${index}"${entry.pending ? " disabled" : ""}>复制结果</button></div><pre class="redis-console-command selectable-text">${escapeHtml(entry.command || "")}</pre>${entry.output ? `<pre class="redis-console-result${entry.error ? " error" : ""} selectable-text">${escapeHtml(entry.output)}</pre>` : ""}</article>`;
    }).join("")
    : `<div class="redis-console-empty"><div class="redis-empty-symbol" aria-hidden="true">›_</div><h3>从一条命令开始</h3><p>命令、参数说明和 Key 补全，随输入出现。</p><div class="redis-command-examples"><button type="button" data-redis-example="PING"><code>PING</code><span>检查连接</span></button><button type="button" data-redis-example="INFO server"><code>INFO server</code><span>实例信息</span></button><button type="button" data-redis-example="SCAN 0 MATCH * COUNT 100"><code>SCAN 0</code><span>浏览 Key</span></button></div></div>`;
  refs.redisConsoleOutput.scrollTop = refs.redisConsoleOutput.scrollHeight;
}
function structurePlaceholder(tab) {
  if (tab?.structurePending) return `正在读取 ${tab.inspectedObject?.name || tab.browse?.name || tab.title || "对象"} 结构…`;
  if (tab?.structureOnly) return `正在准备 ${tab.inspectedObject?.name || "对象"} 的结构`;
  if (tab?.redisKey) return "Redis key 没有表结构";
  if (tab?.browse) return "正在准备对象结构";
  return "当前查询未绑定对象";
}
function renderStructure(details) {
  const columns = details.columns || [];
  const indexes = details.indexes || [];
  const constraints = details.constraints || [];
  const text = value => `<span class="selectable-text">${escapeHtml(value)}</span>`;
  const code = value => `<code class="selectable-text">${escapeHtml(value)}</code>`;
  refs.structurePanel.innerHTML = `
    <h2 class="structure-title"><span class="schema-icon">${kindIcons[details.kind] || "◇"}</span>${text(details.qualifiedName)} <span class="object-kind-icon">${escapeHtml(kindLabels[details.kind] || details.kind)}</span></h2>
    ${details.signature ? `<div class="structure-comment">${text(details.signature)}</div>` : ""}
    ${details.comment ? `<p class="structure-comment">${text(details.comment)}</p>` : ""}
    <div class="structure-section">列 · ${columns.length}</div>
    <table class="structure-table"><thead><tr><th>名称</th><th>类型</th><th>可为空</th><th>默认值</th><th>备注</th></tr></thead><tbody>
      ${columns.map(c => `<tr><td>${code(c.name)}${c.primaryKey ? '<span class="pk-badge">PK</span>' : ""}</td><td>${text(c.dataType)}</td><td>${text(c.nullable ? "是" : "否")}</td><td>${code(c.defaultValue ?? "—")}</td><td>${text(c.comment || "—")}</td></tr>`).join("") || '<tr><td colspan="5">此对象没有列信息</td></tr>'}
    </tbody></table>
    ${indexes.length ? `<div class="structure-section">索引 · ${indexes.length}</div><table class="structure-table"><thead><tr><th>名称</th><th>属性</th><th>定义</th></tr></thead><tbody>${indexes.map(i => `<tr><td>${code(i.name)}</td><td>${text(i.primary ? "主键" : i.unique ? "唯一" : "普通")}</td><td>${code(i.definition)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${constraints.length ? `<div class="structure-section">约束 · ${constraints.length}</div><table class="structure-table"><thead><tr><th>名称</th><th>类型</th><th>定义</th></tr></thead><tbody>${constraints.map(c => `<tr><td>${code(c.name)}</td><td>${text(c.kind)}</td><td>${code(c.definition)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${details.definition ? `<div class="structure-section">定义</div><pre class="definition">${text(details.definition)}</pre>` : ""}`;
  const toolbar = document.createElement("div");
  toolbar.className = "structure-actions";
  const object = activeTab()?.inspectedObject || activeTab()?.browse;
  if (object) {
    if (["table", "partitioned_table"].includes(details.kind)) {
      const edit = document.createElement("button");
      edit.className = "primary-btn";
      edit.textContent = "编辑表结构";
      edit.dataset.editStructure = "";
      edit.addEventListener("click", () => editTableStructure(activeTab()));
      toolbar.append(edit);
    }
    const refresh = document.createElement("button");
    refresh.className = "secondary-btn";
    refresh.textContent = "刷新";
    refresh.dataset.refreshStructure = "";
    refresh.addEventListener("click", () => {
      const tab = activeTab();
      if (tab && !tab.running && !tab.confirming) void inspectObject(object, { connectionId: object.connectionId || tab.connectionId, tab });
    });
    toolbar.append(refresh);
    const sql = document.createElement("button");
    sql.className = "quiet-btn";
    sql.textContent = "打开 SQL 编辑器";
    sql.addEventListener("click", () => {
      const tab = activeTab();
      addTab("", tab.connectionId, null, {
        database: object.database || tabDatabase(tab), schema: object.schema,
      });
    });
    toolbar.append(sql);
  }
  refs.structurePanel.prepend(toolbar);

}
async function inspectObject(object, { connectionId = state.activeConnectionId, tab = activeTab() } = {}) {
  if (!tab) return openObjectStructureTab(object, connectionId);
  const request = ++state.structureRequest;
  tab.structureRequest = request;
  tab.inspectedObject = { ...object, connectionId };
  state.selectedObject = object;
  refs.objectSelection.textContent = `${object.schema}.${object.name}`;
  tab.outputTab = "structure";
  tab.structurePending = true;
  tab.structure = null;
  tab.structureError = null;
  renderOutput();
  renderStructureLoading(
    `正在读取 ${object.signature || object.qualifiedName}`,
  );
  let pending;
  try {
    pending = call("get_object_details", {
      connectionId,
      objectId: object.id,
      kind: object.kind,
      database: object.database,
    });
    tab.structureLoad = pending;
    const details = await pending;
    if (tab.structureRequest === request) {
      tab.structure = details;
      tab.structurePending = false;
      if (activeTab() === tab) {
        renderTabs();
        renderOutput();
      }
      return true;
    }
  } catch (error) {
    if (tab.structureRequest !== request) return false;
    tab.structurePending = false;
    tab.structureError = errorText(error);
    if (activeTab() === tab) renderOutput();
  } finally {
    if (tab.structureLoad === pending) tab.structureLoad = null;
  }
  return false;
}
function browseSql(browse) {
  const driver = driverForBrowse(browse);
  return `SELECT *\nFROM ${quoteIdentForDriver(browse.schema, driver)}.${quoteIdentForDriver(browse.name, driver)}\nLIMIT ${browse.pageSize + 1} OFFSET ${browse.page * browse.pageSize};`;
}
function objectFromTreeRow(row) {
  if (!row) return null;
  return state.objectsBySchema
    .get(schemaKey(row.dataset.database, row.dataset.schema))
    ?.find((object) => object.id === row.dataset.objectId);
}
function openObjectStructureTab(object, connectionId = state.activeConnectionId, { fromTreeClick = false } = {}) {
  if (!object) return;
  const target = objectTabTarget(object, connectionId);
  const existing = findObjectTab(target, "structure");
  if (existing) {
    activateTab(existing.id);
    return existing;
  }
  const tab = addTab("", connectionId, null, {
    database: object.database,
    schema: object.schema,
    title: `结构 · ${object.name}`,
    openedObject: target,
    openedObjectView: "structure",
  });
  if (!tab) return;
  if (fromTreeClick) state.objectClickPreviewId = tab.id;
  tab.outputTab = "structure";
  tab.structureOnly = true;
  renderTabs();
  return inspectObject(object, { connectionId, tab });
}
function showContextMenu(menu, x, y) {
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
}

function contextDriver(target = state.contextTreeTarget) {
  return driverForConnection(target?.connectionId || state.activeConnectionId);
}

function contextIdentifier(value, driver) {
  return quoteIdentForDriver(value, driver);
}

function contextTargetLabel(target) {
  if (!target) return "对象";
  if (target.type === "root") return state.profiles.find((profile) => profile.id === target.connectionId)?.name || "数据库实例";
  if (target.type === "database") return `数据库 ${target.database}`;
  if (target.type === "schema") return `schema ${target.schema}`;
  if (target.type === "category") return `${target.schema} · ${kindLabels[target.kind] || target.kind}`;
  if (target.type === "redis-database") return `Redis DB ${target.database}`;
  if (target.type === "redis-key") return `DB ${target.database} · ${target.key}`;
  if (target.type === "object") return target.object?.qualifiedName || target.object?.name || "对象";
  return "对象";
}

function contextMenuActionButtons() {
  return [...(refs.objectContextMenu?.querySelectorAll("[data-context-action]") || [])];
}

function prepareObjectContextMenu(target) {
  const driver = target?.driver || contextDriver(target);
  const actions = new Set();
  const isTable = ["table", "partitioned_table"].includes(target?.object?.kind);
  if (target?.type === "root" && driver === "redis") {
    actions.add("refresh-redis");
  } else if (target?.type === "root" && ["postgres", "mysql"].includes(driver)) {
    actions.add("refresh-databases");
    actions.add("create-database");
  } else if (target?.type === "database" && ["postgres", "mysql"].includes(driver)) {
    actions.add("refresh-database");
    actions.add("new-database-query");
    actions.add("create-database");
    if (driver === "postgres") actions.add("create-schema");
    actions.add("copy-ddl");
    actions.add("create-table");
  } else if (target?.type === "schema" && ["postgres", "mysql"].includes(driver)) {
    actions.add("refresh-schema");
    actions.add("new-database-query");
    actions.add("copy-ddl");
    actions.add("create-table");
  } else if (target?.type === "category") {
    actions.add("refresh-schema");
    actions.add("new-database-query");
    if (["table", "partitioned_table"].includes(target.kind)) actions.add("create-table");
  } else if (target?.type === "object") {
    if (["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(target.object.kind)) {
      actions.add("open-data");
      actions.add("new-query");
    }
    actions.add("open-structure");
    actions.add("copy-name");
    actions.add("copy-ddl");
    actions.add("refresh-object");
    if (isTable) {
      actions.add("create-table");
      actions.add("edit-structure");
      actions.add("rename-table");
    }
  }
  for (const button of contextMenuActionButtons()) {
    button.setAttribute("role", "menuitem");
    button.hidden = !actions.has(button.dataset.contextAction);
  }
  refs.objectContextTitle.textContent = contextTargetLabel(target);
  refs.objectContextMenu.querySelector('[data-context-action="open-data"]').textContent = isTable ? "打开表数据" : "打开数据";
  refs.objectContextMenu.querySelector('[data-context-action="open-structure"]').textContent = isTable ? "查看表结构" : "查看结构 / 定义";
  refs.objectContextMenu.querySelector('[data-context-action="copy-ddl"]').textContent = isTable ? "复制建表 SQL" : "复制 DDL";
  const hasDivider = refs.objectContextMenu?.querySelector("[data-context-divider]");
  if (hasDivider) hasDivider.hidden = !actions.has("copy-ddl");
}

function contextTableDdl(object, details, driver) {
  return buildTableDdl(object, details, driver);
}

function contextObjectDdl(object, details, driver) {
  if (["table", "partitioned_table", "foreign_table"].includes(object.kind)) return contextTableDdl(object, details, driver);
  const quote = (name) => contextIdentifier(name, driver);
  const qualified = `${quote(object.schema)}.${quote(object.name)}`;
  const definition = details?.definition?.trim();
  if (definition) {
    if (["view", "materialized_view"].includes(object.kind)) {
      if (driver === "mysql" && /^CREATE\s/i.test(definition)) return definition.endsWith(";") ? definition : `${definition};`;
      if (object.kind === "materialized_view" && driver === "postgres") {
        return `CREATE MATERIALIZED VIEW ${qualified} AS\n${definition.replace(/;\s*$/, "")};`;
      }
      return `CREATE OR REPLACE VIEW ${qualified} AS\n${definition.replace(/;\s*$/, "")};`;
    }
    return definition.endsWith(";") ? definition : `${definition};`;
  }
  if (["table", "partitioned_table", "foreign_table"].includes(object.kind)) {
    return contextTableDdl(object, details, driver);
  }
  if (object.kind === "sequence" && driver === "postgres") return `CREATE SEQUENCE ${qualified};`;
  return `-- DDL for ${object.qualifiedName || `${object.schema}.${object.name}`} is not available from this driver.`;
}

function contextDatabaseDdl(target, driver) {
  const name = target.database || target.schema;
  if (!name) return "";
  return `CREATE DATABASE ${contextIdentifier(name, driver)};`;
}

function contextSchemaDdl(target, driver) {
  const name = target.schema || target.database;
  if (!name) return "";
  return driver === "mysql"
    ? `CREATE DATABASE ${contextIdentifier(name, driver)};`
    : `CREATE SCHEMA ${contextIdentifier(name, driver)};`;
}

function openContextDdlQuery(sql, title, target) {
  if (!sql) return;
  const tab = addTab(sql, target.connectionId, null, {
    title,
    database: target.object?.database || target.database,
    schema: target.object?.schema || target.schema || null,
  });
  if (!tab) return;
  showToast("已创建 DDL 查询，请确认后执行");
}

async function copyContextDdl(target) {
  const driver = target?.driver || contextDriver(target);
  let ddl = "";
  try {
    if (target?.type === "object") {
      const object = target.object;
      const details = await call("get_object_details", {
        connectionId: target.connectionId || state.activeConnectionId,
        objectId: object.id,
        kind: object.kind,
        database: object.database,
      });
      ddl = contextObjectDdl(object, details, driver);
    } else if (target?.type === "database") ddl = contextDatabaseDdl(target, driver);
    else if (target?.type === "schema") ddl = contextSchemaDdl(target, driver);
    if (!ddl) throw new Error("当前对象没有可复制的 DDL");
    await copyText(ddl);
    showToast("已复制 DDL");
  } catch (error) {
    showToast(`复制 DDL 失败：${errorText(error)}`, "error");
  }
}

function openContextCreateQuery(target, action) {
  if (action === "create-table") return openCreateTableEditor(target);
  state.pendingObjectCreate = { target, action };
  const rename = action === "rename-table";
  const kind = action.replace("create-", "");
  const labels = { database: "数据库", schema: "schema", table: "表" };
  refs.createObjectTitle.textContent = rename ? "重命名表" : `新建${labels[kind]}`;
  refs.createObjectNameLabel.textContent = rename ? "新表名" : `${labels[kind]}名称`;
  const profile = state.profiles.find((item) => item.id === target.connectionId);
  refs.createObjectContext.textContent = `${profile?.name || ""} / ${target.object?.database || target.database || profile?.database || "服务器"}${rename ? ` / ${target.object.schema}.${target.object.name}` : ""}`;
  refs.createObjectHint.textContent = `填写名称后打开 SQL 编辑器，检查语句并点击「执行」完成${rename ? "重命名" : "创建"}。`;
  refs.createObjectName.value = rename ? target.object.name : "";
  refs.createObjectName.placeholder = rename ? "new_table_name" : `new_${kind}`;
  refs.createObjectName.setCustomValidity("");
  refs.createObjectModal.showModal();
  refs.createObjectName.focus();
  if (rename) refs.createObjectName.select();
}

function submitContextCreateQuery(target, action, name) {
  const driver = target?.driver || contextDriver(target);
  const scope = target?.type === "object"
    ? { ...target, schema: target.object?.schema, database: target.object?.database }
    : target;
  if (action === "create-database") {
    openContextDdlQuery(`CREATE DATABASE ${contextIdentifier(name, driver)};`, `新建数据库 · ${name}`, scope);
  } else if (action === "create-schema") {
    openContextDdlQuery(`CREATE SCHEMA ${contextIdentifier(name, driver)};`, `新建 schema · ${name}`, scope);
  } else if (action === "rename-table") {
    const quote = (value) => contextIdentifier(value, driver);
    const qualified = `${quote(target.object.schema)}.${quote(target.object.name)}`;
    const sql = driver === "mysql"
      ? `RENAME TABLE ${qualified} TO ${quote(target.object.schema)}.${quote(name)};`
      : `ALTER TABLE ${qualified} RENAME TO ${quote(name)};`;
    openContextDdlQuery(sql, `重命名 · ${target.object.name}`, scope);
  }
}

async function openCreateTableEditor(context) {
  if (document.querySelector('.create-table-dialog')) return;
  const target = { connectionId: context.connectionId, database: context.object?.database || context.database,
    schema: context.object?.schema || context.schema || null };
  const driver = context.driver || contextDriver(context);
  try {
    const data = await loadQueryTarget(target);
    if (!data?.context || data.error) throw new Error(`无法确认建表位置：${data?.error || '请刷新数据库后重试'}`);
    target.database ||= data.context.database;
    target.schema ||= driver === 'mysql' ? target.database : data.context.defaultSchema;
    if (!target.schema) throw new Error('当前数据库没有默认 schema，请在目标 schema 上右键新建表');
    const key = transactionKey(target.connectionId, target.database);
    const guard = () => {
      if (state.connectionStatuses[target.connectionId] !== 'connected') throw new Error('连接已断开，请重新连接后保存');
      if (state.transactionKeys.has(key)) throw new Error('请先提交或回滚当前数据库的事务，再创建表');
      if (state.tabs.some(item => item.connectionId === target.connectionId && tabDatabase(item) === target.database && (item.running || item.changingTransaction)))
        throw new Error('当前数据库有操作正在执行，请完成后再创建表');
    };
    guard();
    if (document.querySelector('.create-table-dialog')) return;
    openStructureEditor({
      create: true, details: { schema: target.schema }, driver, targetLabel: queryTargetDescription(target),
      confirmDiscard: () => confirmAction('放弃尚未保存的新表字段？', { title: '放弃新建表', acceptLabel: '放弃草稿' }),
      onClose: () => {},
      onApply: async plan => {
        guard();
        await call('execute_mutation', { request: { ...target, sql: plan.sql, queryId: makeId('create-table'), readOnly: false } });
        // Creation is complete. A catalog refresh failure must never invite a
        // retry of the CREATE statement (or lose the successful outcome).
        try {
          recordHistory(plan.sql, target);
          state.queryTargets.delete(key);
          state.treeSessions.get(target.connectionId)?.objectsBySchema.delete(schemaKey(target.database, target.schema));
          if (state.activeConnectionId === target.connectionId) {
            state.objectsBySchema.delete(schemaKey(target.database, target.schema));
            if (!await loadSchemaObjects(target.database, target.schema, { force: true })) throw new Error('对象目录读取失败');
            const object = (state.objectsBySchema.get(schemaKey(target.database, target.schema)) || []).find(item => item.name === plan.name && item.kind === 'table');
            if (object && !await openObjectStructureTab({ ...object, database: target.database }, target.connectionId)) throw new Error('表结构读取失败');
          }
          updateEditorSchema();
          showToast(`表 ${plan.name} 已创建`);
        } catch (error) { showToast(`表 ${plan.name} 已创建，刷新失败：${errorText(error)}，请手动刷新`, 'error'); }
        return true;
      },
    });
  } catch (error) { showToast(errorText(error), 'error'); }
}

async function openTableStructureEditor(target) {
  const tab = addTab("", target.connectionId, null, {
    database: target.object.database, schema: target.object.schema, title: `结构 · ${target.object.name}`,
    openedObject: target.object, openedObjectView: "structure",
  });
  if (!tab) return;
  tab.structureOnly = true;
  if (await inspectObject(target.object, { connectionId: target.connectionId, tab })) await editTableStructure(tab);
}

async function editTableStructure(tab) {
  const object = tab?.inspectedObject || tab?.browse;
  if (!object || !tab.structure || tab.running || tab.confirming || tab.editingStructure) return;
  const connectionId = object.connectionId || tab.connectionId;
  const database = object.database || tabDatabase(tab);
  const schema = object.schema;
  const target = { connectionId, database, schema };
  const key = transactionKey(connectionId, database);
  const guard = () => {
    if (tab.mode !== "write") throw new Error("当前窗口为只读，请先点击顶部锁切换为可写");
    if (state.transactionKeys.has(key)) throw new Error("请先提交或回滚当前数据库的事务，再编辑表结构");
    if (state.tabs.some((item) => item.connectionId === connectionId && tabDatabase(item) === database && (item.running || item.changingTransaction)))
      throw new Error("当前数据库有操作正在执行，请完成后再编辑结构");
  };
  try { guard(); } catch (error) { showToast(error.message, "error"); return; }
  const details = { ...tab.structure, id: object.id, schema, name: object.name, kind: object.kind };
  const normalize = (fresh) => ({ ...fresh, id: fresh.id ?? object.id, schema: fresh.schema ?? schema, name: fresh.name ?? object.name, kind: fresh.kind ?? object.kind });
  const fetchDetails = () => call("get_object_details", { connectionId, database, objectId: object.id, kind: object.kind });
  const fingerprint = structureFingerprint(details);
  tab.editingStructure = true;
  openStructureEditor({
    details, driver: driverForConnection(connectionId),
    targetLabel: `${queryTargetDescription(target)} / ${object.name}`,
    confirmDiscard: () => confirmAction("放弃尚未应用的表结构修改？", { title: "放弃结构修改", acceptLabel: "放弃修改" }),
    onClose: () => { tab.editingStructure = false; renderTabs(); },
    onApply: async (plan) => {
      guard();
      tab.confirming = true;
      renderTabs();
      try {
        if (!await confirmAction(`执行位置：${queryTargetDescription(target)} / ${object.name}\n\n共 ${plan.changed} 项字段变更。${plan.dropped ? `将删除 ${plan.dropped} 列及其数据。` : ""}${driverForConnection(connectionId) === "mysql" ? "MySQL DDL 会直接提交。" : "PostgreSQL 将在一个事务中应用，失败会回滚。"}`, {
          title: "确认修改表结构", detail: plan.sql, acceptLabel: "应用结构修改",
        })) return false;
        guard();
        const fresh = normalize(await fetchDetails());
        if (structureFingerprint(fresh) !== fingerprint) throw new Error("表结构已被其他操作修改。草稿已保留，请复制 SQL 预览后取消并刷新结构，核对后重新编辑");
        tab.running = true;
        renderTabs();
        await call("execute_mutation", { request: { ...target, sql: plan.sql, queryId: makeId("structure"), readOnly: false } });
        recordHistory(plan.sql, target);
        // A completed DDL must not leave stale row editors or completions usable.
        state.queryTargets.delete(key);
        state.treeSessions.get(connectionId)?.objectsBySchema.delete(schemaKey(database, schema));
        const related = state.tabs.filter((item) => item === tab || (item.connectionId === connectionId && tabDatabase(item) === database &&
          (item.inspectedObject?.id === object.id || item.browse?.id === object.id)));
        for (const item of related) {
          item.structure = null;
          item.structureRequest = ++state.structureRequest;
          item.structureError = "结构已修改，请刷新读取最新结构";
          if (item.browse) {
            item.browse.detailsLoaded = false;
            item.browse.columns = [];
            item.browse.primaryKeys = [];
            item.result = emptyResult();
            item.gridState = null;
            item.filter = "";
            item.message = "表结构已修改，刷新后查看最新数据";
          }
        }
        tab.message = "表结构修改成功";
        let refreshError = "";
        try {
          const updated = await fetchDetails();
          for (const item of related) {
            item.structure = updated;
            item.structureError = null;
            if (item.browse) {
              item.browse.columns = updated.columns || [];
              item.browse.primaryKeys = item.browse.columns.filter((column) => column.primaryKey).map((column) => column.name);
              item.browse.detailsLoaded = true;
            }
          }
        } catch (error) { refreshError = errorText(error); }
        if (state.activeConnectionId === connectionId) {
          state.objectsBySchema.delete(schemaKey(database, schema));
          if (!await loadSchemaObjects(database, schema, { force: true })) refreshError ||= "对象目录读取失败";
        }
        state.structureRendered = null;
        updateEditorSchema();
        showToast(refreshError ? `修改已提交，刷新失败：${refreshError}，请手动刷新` : "表结构已更新", refreshError ? "error" : undefined);
        return true;
      } finally {
        tab.confirming = false;
        tab.running = false;
        renderTabs();
        renderOutput();
      }
    },
  });
}

function openDatabaseContextQuery(target) {
  if (!target?.database || !target.connectionId) return;
  addTab("", target.connectionId, null, { database: target.database, schema: target.schema || null, title: `查询 · ${target.schema || target.database}` });
}

async function refreshDatabaseContext(target) {
  if (!target?.database || !target.connectionId) return;
  if (target.connectionId !== state.activeConnectionId) return;
  const request = state.schemaRequest;
  const refreshed = await loadSchemas(target.database, target.connectionId, request);
  if (request !== state.schemaRequest || target.connectionId !== state.activeConnectionId) return;
  if (refreshed) showToast(`数据库 ${target.database} 已刷新`);
  else showToast(`刷新失败：${state.schemaErrors.get(target.database) || "部分对象未能读取，请重试"}`, "error");
}

async function refreshTreeObject(target) {
  if (target.connectionId !== state.activeConnectionId) return;
  const database = target.object?.database || target.database;
  const schema = target.object?.schema || target.schema;
  const generation = state.schemaRequest;
  const tab = activeTab();
  const current = () => generation === state.schemaRequest && target.connectionId === state.activeConnectionId;
  if (!await loadSchemaObjects(database, schema, { force: true }) || !current()) return;
  if (target.object && tab && activeTab() === tab && tab.connectionId === target.connectionId) {
    const object = target.object;
    try {
      if (tab.outputTab === "structure" && tab.inspectedObject?.id === object.id && tab.inspectedObject.database === database) {
        if (!await inspectObject(object, { connectionId: target.connectionId, tab })) {
          if (current()) showToast("对象目录已刷新，结构读取失败", "error");
          return;
        }
      } else if (tab.browse?.id === object.id && tab.browse.database === database && tab.tableView !== false && !tab.running && !tab.refreshing) {
        await loadBrowseDetails(tab);
        if (!current() || activeTab() !== tab) return;
        state.applyingBrowse = true;
        setEditorValue(browseSql(tab.browse));
        state.applyingBrowse = false;
        await runQuery({ preserveResult: true });
        if (tab.error || tab.cancelled) return;
      }
    } catch (error) {
      if (current()) showToast(`刷新对象失败：${errorText(error)}`, "error");
      return;
    }
  }
  if (current()) showToast(target.object ? "对象已刷新" : "对象列表已刷新");
}

async function refreshRedisContext(database = null) {
  const connectionId = state.activeConnectionId;
  const generation = state.redisRequest;
  try {
    const refreshed = database === null
      ? await refreshRedisTree()
      : await loadRedisKeys(database, 0, state.redisPattern, connectionId, generation);
    if (connectionId !== state.activeConnectionId || (database !== null && generation !== state.redisRequest)) return;
    if (refreshed) showToast(database === null ? "Redis 数据库和 key 已刷新" : `Redis DB ${database} 已刷新`);
    else {
      const error = database === null
        ? [...state.redisPages.values()].find((page) => page.error)?.error
        : state.redisPages.get(database)?.error;
      if (error) showToast(`刷新 Redis 失败：${error}`, "error");
    }
  } catch (error) {
    if (connectionId === state.activeConnectionId) showToast(`刷新 Redis 失败：${errorText(error)}`, "error");
  }
}

async function refreshDatabaseList(target, { notify = true } = {}) {
  const connectionId = target?.connectionId;
  if (!connectionId || connectionId !== state.activeConnectionId) return;
  const request = ++state.databaseRequest;
  const generation = state.schemaRequest;
  const isCurrent = () => request === state.databaseRequest && generation === state.schemaRequest && connectionId === state.activeConnectionId;
  try {
    const databases = await call("list_databases", { connectionId });
    if (!isCurrent()) return;
    const previous = new Set(state.databases.map((database) => database.name));
    const available = new Set(databases.map((database) => database.name));
    state.databases = databases;
    state.visibleDatabases = new Set([...available].filter((name) => state.visibleDatabases.has(name) || !previous.has(name)));
    for (const name of previous) {
      if (available.has(name)) continue;
      state.schemasByDatabase.delete(name);
      state.visibleSchemasByDatabase.delete(name);
      state.expandedDatabases.delete(name);
      state.schemaErrors.delete(name);
      state.schemaLoading.delete(name);
      for (const key of [...state.objectsBySchema.keys()])
        if (key.startsWith(`${name}\u0000`)) state.objectsBySchema.delete(key);
      for (const key of [...state.objectRequests.keys()])
        if (key.startsWith(`${name}\u0000`)) state.objectRequests.delete(key);
      for (const key of [...state.expandedSchemas])
        if (key.startsWith(`${name}\u0000`)) state.expandedSchemas.delete(key);
    }
    persistVisibleDatabases(connectionId);
    renderTree();
    if (notify) showToast("数据库列表已刷新");
    return true;
  } catch (error) {
    if (isCurrent()) showToast(`刷新数据库列表失败：${errorText(error)}`, "error");
    return false;
  }
}

function hideContextMenus() {
  refs.objectContextMenu?.setAttribute("hidden", "");
  refs.redisContextMenu?.setAttribute("hidden", "");
  refs.redisDatabaseContextMenu?.setAttribute("hidden", "");
  refs.tabContextMenu?.setAttribute("hidden", "");
  state.contextObject = null;
  state.contextTreeTarget = null;
  state.contextRedisKey = null;
  state.contextRedisDb = null;
  state.contextRedisConnectionId = null;
  state.contextTabId = null;
}
async function closeTabsByIds(ids) {
  const idSet = new Set(ids);
  const blocked = state.tabs.filter((tab) => idSet.has(tab.id) && (tab.running || tab.opening || tab.confirming || tab.resolvingTarget || tab.changingTransaction || tab.cellSaving));
  if (blocked.length) {
    showToast("有查询正在执行，请先停止后再关闭标签", "error");
    return;
  }
  if (!await confirmDiscardCellEdits(state.tabs.filter(tab => idSet.has(tab.id)))) return;
  if (idSet.size === state.tabs.length) {
    state.tabs = [];
    state.activeTabId = null;
    state.editor.setState(makeEditorState({ sql: "", mode: "write" }));
    renderTabs();
    renderOutput();
    updateCursor();
    persistTabs();
    return;
  }
  const activeRemoved = idSet.has(state.activeTabId);
  state.tabs = state.tabs.filter((tab) => !idSet.has(tab.id));
  if (!state.tabs.length) {
    state.activeTabId = null;
    addTab("");
  } else if (activeRemoved) {
    state.activeTabId = state.tabs[0].id;
    const tab = activeTab();
    state.editor.setState(tab.editorState || (tab.editorState = makeEditorState(tab)));
    renderTabs();
    renderOutput();
    updateCursor();
  } else {
    renderTabs();
    renderOutput();
  }
  persistTabs();
}
function applyTabContextAction(action) {
  const id = state.contextTabId;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return hideContextMenus();
  if (action === "close") closeTabsByIds([id]);
  if (action === "close-others") closeTabsByIds(state.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  if (action === "close-right") closeTabsByIds(state.tabs.slice(index + 1).map((tab) => tab.id));
  if (action === "close-all") closeTabsByIds(state.tabs.map((tab) => tab.id));
  hideContextMenus();
}
async function confirmWrite(sql, tab = activeTab()) {
  const info = sqlExecutionInfo(sql, driverForTab(tab));
  if (info.singleRead) return true;
  const dangerous = info.keywords.some((keyword) => /^(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|DELETE)$/i.test(keyword));
  const scope = dangerous ? "这可能改变数据库结构、权限或删除数据。" : "这会修改数据库中的数据。";
  const profile = state.profiles.find((profile) => profile.id === (tab?.connectionId || state.activeConnectionId));
  return confirmAction(`执行位置：${queryTargetDescription(tab)}\n${profile?.host || ""}:${profile?.port || ""}${profile?.user ? ` · ${profile.user}` : ""}\n\n即将执行 ${info.count || 1} 条 SQL。${scope}`, { title: "确认执行 SQL", detail: sql });
}
function firstRedisCommand(sql) {
  return sql.trim().match(/^[^\s]+/)?.[0]?.toUpperCase() || "";
}
function isRedisReadCommand(sql) {
  const parts = sql.trim().split(/\s+/);
  const command = parts[0]?.toUpperCase();
  const subcommand = parts[1]?.toUpperCase();
  if (command === "OBJECT") return new Set(["ENCODING", "FREQ", "HELP", "IDLETIME", "REFCOUNT"]).has(subcommand);
  if (command === "MEMORY") return new Set(["DOCTOR", "HELP", "MALLOC-STATS", "STATS", "USAGE"]).has(subcommand);
  return new Set([
    "GET", "MGET", "TYPE", "TTL", "PTTL", "EXISTS", "SCAN", "HSCAN", "HGET",
    "HGETALL", "HKEYS", "HEXISTS", "HLEN", "LRANGE", "LLEN", "SMEMBERS", "SSCAN", "SCARD", "SISMEMBER",
    "ZRANGE", "ZSCAN", "ZCARD", "ZSCORE", "XRANGE", "XLEN", "STRLEN", "GETRANGE",
    "INFO", "PING", "DBSIZE",
  ]).has(command);
}
function confirmRedisCommand(sql) {
  if (isRedisReadCommand(sql)) return true;
  const command = firstRedisCommand(sql);
  const dangerous = new Set([
    "FLUSHALL", "FLUSHDB", "CONFIG", "DEBUG", "MODULE", "SHUTDOWN",
    "REPLICAOF", "SLAVEOF", "ACL", "EVAL", "EVALSHA",
  ]).has(command);
  const scope = dangerous
    ? "这可能清空数据、改变 Redis 服务配置或执行高风险脚本。"
    : "这会修改 Redis 中的数据或状态。";
  return confirmAction(`即将执行 Redis 命令（${command || "未知"}）。\n\n${scope}`, { detail: sql });
}
async function loadBrowseDetails(tab, prefetched = null) {
  const browse = tab?.browse;
  const connectionId = tab?.connectionId || state.activeConnectionId;
  if (!browse || !connectionId || !["table", "partitioned_table"].includes(browse.kind)) return null;
  const details = await (prefetched || call("get_object_details", {
    connectionId,
    objectId: browse.id,
    kind: browse.kind,
    database: browse.database,
  }));
  browse.columns = details.columns || [];
  browse.primaryKeys = browse.columns.filter((column) => column.primaryKey).map((column) => column.name);
  browse.detailsLoaded = true;
  tab.structure = details;
  tab.structurePending = false;
  tab.structureError = null;
  return details;
}

async function openObjectQuery(object, { previewTab = null } = {}) {
  if (
    ![
      "table",
      "partitioned_table",
      "view",
      "materialized_view",
      "foreign_table",
    ].includes(object.kind)
  ) {
    openObjectStructureTab(object);
    return;
  }
  const connectionId = state.activeConnectionId;
  const target = objectTabTarget(object, connectionId);
  const existing = findObjectTab(target, "data");
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const browse = {
    id: object.id,
    connectionId,
    database: object.database,
    schema: object.schema,
    name: object.name,
    kind: object.kind,
    page: 0,
    pageSize: 500,
    columns: object.columns || null,
    primaryKeys: null,
    tableView: true,
  };
  const promote = previewTab?.structureOnly && state.tabs.includes(previewTab) && matchesObjectTab(previewTab, target, "structure");
  const prefetched = promote ? previewTab.structure || previewTab.structureLoad : null;
  const tab = promote ? previewTab : addTab(browseSql(browse), connectionId, browse, { openedObject: target, openedObjectView: "data" });
  if (!tab) return;
  if (promote) {
    // The first click already opened this preview. Promote it on double-click
    // instead of delaying all single clicks or leaving an extra structure tab.
    tab.structureRequest = ++state.structureRequest;
    Object.assign(tab, { title: object.name, sql: browseSql(browse), browse,
      tableView: true, structureOnly: false, structurePending: false,
      openedObject: target, openedObjectView: "data", outputTab: "result" });
    tab.editorState = makeEditorState(tab);
    if (activeTab() === tab) state.editor.setState(tab.editorState);
    else activateTab(tab.id);
    renderTabs();
    renderOutput();
    updateCursor();
    persistTabs();
  }
  try {
    await loadBrowseDetails(tab, prefetched);
    if (activeTab() === tab) renderOutput();
  } catch (error) {
    showToast(`读取表结构失败：${errorText(error)}`, "error");
  }
  if (activeTab() === tab) await runQuery();
}
async function runRedisCommand(tab, sqlText, connectionId) {
  const writeMode = tab.mode === "write";
  const database = redisTabDatabase(tab);
  if (!tab.console && !await confirmRedisCommand(sqlText)) return;
  if (state.connectionStatuses[connectionId] !== "connected") {
    const ok = await selectConnection(connectionId);
    if (!ok) return;
  }
  tab.running = true;
  tab.queryId = makeId("redis-run");
  tab.error = false;
  tab.cancelled = false;
  tab.gridState = null;
  tab.message = "正在执行 Redis 命令…";
  tab.result = emptyResult();
  tab.consoleHistory = tab.consoleHistory || [];
  const consoleEntry = tab.console ? { command: sqlText, database, output: "", pending: true, error: false } : null;
  if (consoleEntry) {
    tab.consoleHistory.push(consoleEntry);
    tab.consoleHistory = tab.consoleHistory.slice(-100);
  }
  renderTabs();
  renderOutput();
  const isActive = () => activeExecutionTab() === tab;
  try {
    const payload = await call("execute_redis_command", {
      request: {
        connectionId,
        database,
        sql: sqlText,
        queryId: tab.queryId,
        readOnly: tab.console ? false : !writeMode,
        console: Boolean(tab.console),
        consoleId: tab.console ? tab.id : null,
      },
    });
    const rows = payload.rows || [];
    tab.result = {
      columns: payload.columns || ["result"],
      rows,
      rowCount: payload.rowCount ?? rows.length,
      elapsedMs: payload.elapsedMs ?? payload.elapsed_ms ?? 0,
      truncated: false,
      truncatedReason: null,
      executed: true,
      connectionId,
    };
    tab.result.finishedAt = Date.now();
    tab.result.bytes = estimateResultBytes(tab.result);
    trimResultMemory(tab);
    tab.message = `Redis 命令成功 · ${tab.result.rowCount} 行 · ${Number(tab.result.elapsedMs).toFixed(1)} ms`;
    const selectMatch = tab.console && /^\s*SELECT\s+(\d+)\s*$/i.exec(sqlText);
    if (selectMatch) {
      tab.redisDb = Number(selectMatch[1]);
      tab.database = selectMatch[1];
    }
    if (consoleEntry) {
      consoleEntry.output = redisConsoleOutput(payload);
      consoleEntry.elapsedMs = tab.result.elapsedMs;
      consoleEntry.pending = false;
      persistTabs();
    }
    recordHistory(sqlText, tab);
    tab.outputTab = "result";
    if (isActive()) {
      renderOutput();
      showToast("Redis 命令完成");
    }
  } catch (error) {
    const cancelled = tab.cancelRequested || isQueryCancellation(error);
    tab.result = emptyResult();
    tab.error = !cancelled;
    tab.cancelled = cancelled;
    tab.message = cancelled
      ? `Redis 命令已取消\n\n${sqlText}`
      : `Redis 命令失败：${errorText(error)}\n\n${sqlText}`;
    if (consoleEntry) {
      consoleEntry.output = cancelled ? "Redis 命令已取消" : errorText(error);
      consoleEntry.pending = false;
      consoleEntry.error = !cancelled;
      persistTabs();
    }
    tab.outputTab = "message";
    if (isActive()) {
      renderOutput();
      showToast(cancelled ? "Redis 命令已取消" : `Redis 命令失败：${errorText(error)}`, cancelled ? "info" : "error");
    }
  } finally {
    tab.running = false;
    tab.queryId = null;
    tab.cancelRequested = false;
    renderTabs();
    if (isActive()) renderOutput();
  }
}
async function moveBrowsePage(delta) {
  const tab = activeTab();
  if (!tab?.browse || tab.running || cellWritePending(tab)) return;
  if (!await confirmDiscardCellEdits([tab]) || activeTab() !== tab) return;
  const page = Math.max(0, tab.browse.page + delta);
  if (page === tab.browse.page) return;
  tab.browse.page = page;
  state.applyingBrowse = true;
  setEditorValue(browseSql(tab.browse));
  state.applyingBrowse = false;
  renderOutput();
  await runQuery();
}

async function runQuery({ preserveResult = false } = {}) {
  const tab = activeExecutionTab();
  if (!tab || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction || cellWritePending(tab)) return;
  if (!await confirmDiscardCellEdits([tab]) || activeExecutionTab() !== tab) return;
  if (tab.console) redisEditor?.finishComposition();
  else state.editor.plugin(sqlIme)?.finish();
  const previousResult = preserveResult ? tab.result : null;
  const previousGridState = preserveResult ? tab.gridState : null;
  const selected = tab.console
    ? ""
    : state.editor.state
        .sliceDoc(
          state.editor.state.selection.main.from,
          state.editor.state.selection.main.to,
        )
        .trim();
  const sqlText = tab.console
    ? (redisEditor?.executionText() || tab.sql || "").trim()
    : selected || tab.sql.trim();
  if (!sqlText) {
    showToast("请先输入 SQL", "error");
    return;
  }
  const connectionId = tab.connectionId || state.activeConnectionId;
  if (!connectionId) {
    showToast("请先选择数据库连接", "error");
    refs.connectionModal.showModal();
    return;
  }
  const profile = state.profiles.find((item) => item.id === connectionId);
  if (!profile || !tab.connectionId) {
    showToast(tab.connectionId ? "原连接已不可用，请复制 SQL 到新建查询并选择连接" : "请先从左侧选择此查询使用的连接", "error");
    return;
  }
  if (profile?.driver === "redis") {
    await runRedisCommand(tab, sqlText, connectionId);
    return;
  }
  tab.resolvingTarget = true;
  renderTabs();
  const target = await loadQueryTarget(tab, Boolean(preserveResult && queryTargetData(tab)?.error));
  tab.resolvingTarget = false;
  if (!target?.context || target.error) {
    renderTabs();
    showToast(`无法确认执行位置：${target?.error || "请刷新执行位置"}`, "error");
    return;
  }
  // Capture the destination before confirmation/connection awaits; never read
  // the active browser or another tab when dispatching or recording history.
  const executionTarget = { connectionId, database: tabDatabase(tab) || target.context.database || null, schema: tabSchema(tab) };
  const targetDescription = queryTargetDescription(tab);
  const writeMode = tab.mode === "write";
  tab.confirming = true;
  renderTabs();
  try {
    if (writeMode && !await confirmWrite(sqlText, tab)) {
      showToast("已取消执行");
      return;
    }
    if (state.connectionStatuses[connectionId] !== "connected") {
      if (!await selectConnection(connectionId)) return;
    }
    tab.running = true;
  } finally {
    tab.confirming = false;
    renderTabs();
  }
  const readStatement = sqlExecutionInfo(sqlText, profile?.driver).singleRead;
  const txOpen = state.transactionKeys.has(transactionKey(connectionId, executionTarget.database));
  tab.queryId = makeId("query-run");
  tab.error = false;
  tab.cancelled = false;
  tab.gridState = null;
  tab.refreshing = preserveResult;
  tab.message = `正在执行 ${selected ? "选中的 SQL" : "查询"}…`;
  if (!preserveResult) tab.result = emptyResult();
  renderTabs();
  renderOutput();
  const isActive = () => activeTab() === tab;
  try {
    const payload = await call(writeMode && (!readStatement || txOpen) ? "execute_mutation" : "execute_query", {
      request: {
        ...executionTarget,
        sql: sqlText,
        queryId: tab.queryId,
        readOnly: !writeMode,
      },
    });
    const truncatedReason =
      payload.truncatedReason || payload.truncated_reason || null;
    const returnedRows = payload.rows || [];
    const browseHasNext = Boolean(
      tab.browse && returnedRows.length > tab.browse.pageSize,
    );
    const rows = tab.browse
      ? returnedRows.slice(0, tab.browse.pageSize)
      : returnedRows;
    if (tab.browse) tab.browse.hasNext = browseHasNext;
    tab.result = {
      columns: payload.columns || [],
      rows,
      rowCount: (payload.columns || []).length ? rows.length : (payload.row_count ?? rows.length),
      elapsedMs: payload.elapsed_ms ?? 0,
      truncated: Boolean(payload.truncated),
      truncatedReason,
      executed: true,
      ...executionTarget,
    };
    tab.result.finishedAt = Date.now();
    tab.result.bytes = estimateResultBytes(tab.result);
    trimResultMemory(tab);
    tab.refreshing = false;
    tab.gridState = null;
    const statementCount = payload.statement_count || 1;
    tab.message = `执行成功${statementCount > 1 ? ` · ${statementCount} 条语句 · 显示最后一条语句的结果` : ""} · ${tab.result.rowCount} 行 · ${Number(tab.result.elapsedMs).toFixed(1)} ms${tab.result.truncated ? `\n结果已限制（${truncatedReason === "result_size" ? "8 MiB" : "1000 行"}）。` : ""}`;
    tab.message += `\n执行位置：${targetDescription}`;
    recordHistory(sqlText, executionTarget);
    tab.outputTab = "result";
    if (isActive()) {
      renderOutput();
      showToast("查询完成");
    }
  } catch (error) {
    const cancelled = tab.cancelRequested || isQueryCancellation(error);
    tab.refreshing = false;
    if (preserveResult && previousResult?.executed) {
      tab.result = previousResult;
      tab.gridState = previousGridState;
    } else {
      tab.result = emptyResult();
    }
    tab.error = !cancelled;
    tab.cancelled = cancelled;
    tab.message = cancelled
      ? `查询已取消\n\n${sqlText}`
      : `查询失败：${errorText(error)}\n执行位置：${targetDescription}\n\n${sqlText}`;
    tab.outputTab = "message";
    if (isActive()) {
      renderOutput();
      showToast(cancelled ? "查询已取消" : `查询失败：${errorText(error)}`, cancelled ? "info" : "error");
    }
  } finally {
    tab.refreshing = false;
    tab.running = false;
    tab.queryId = null;
    tab.cancelRequested = false;
    renderTabs();
    if (isActive()) renderOutput();
  }
}

async function changeTransaction(action) {
  const tab = activeTab();
  if (!tab || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction || cellWritePending(tab)) return;
  const connectionId = tab?.connectionId || state.activeConnectionId;
  const database = tabDatabase(tab);
  if (!connectionId || !database) {
    showToast("请先选择数据库连接", "error");
    return;
  }
  if (action === "rollback" && !await confirmDiscardCellEdits(state.tabs.filter(item => item.connectionId === connectionId && tabDatabase(item) === database))) return;
  if (action === "begin" && tab?.mode === "read") {
    showToast("当前已锁定为只读，请先点击锁解锁", "error");
    return;
  }
  tab.changingTransaction = true;
  renderTabs();
  try {
    if (state.connectionStatuses[connectionId] !== "connected") {
      const ok = await selectConnection(connectionId);
      if (!ok) return;
    }
    await call(`${action}_transaction`, { connectionId, database });
    const key = transactionKey(connectionId, database);
    if (action === "begin") state.transactionKeys.add(key);
    else state.transactionKeys.delete(key);
    if (action === "rollback") {
      for (const item of state.tabs) {
        if (item.connectionId === connectionId && tabDatabase(item) === database && item.result?.cellEditsInTransaction) {
          item.result = emptyResult();
          item.gridState = null;
          item.message = "事务已回滚，未提交的单元格修改已撤销。请刷新数据。";
        }
      }
      renderOutput();
    } else if (action === "commit") {
      for (const item of state.tabs) {
        if (item.connectionId === connectionId && tabDatabase(item) === database && item.result) delete item.result.cellEditsInTransaction;
      }
    }
    renderTabs();
    showToast(action === "begin" ? "事务已开始" : action === "commit" ? "事务已提交" : "事务已回滚");
  } catch (error) {
    showToast(`${action === "begin" ? "开始事务" : action === "commit" ? "提交事务" : "回滚事务"}失败：${errorText(error)}`, "error");
  } finally {
    tab.changingTransaction = false;
    renderTabs();
  }
}

function sqlLiteral(value, driver = driverForTab()) {
  return sqlValueLiteral(value, driver);
}

function mutationInputValue(value, original) {
  if (typeof original === "boolean" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value;
}

function mutationColumns(tab) {
  return tab?.result?.columns?.length
    ? tab.result.columns.map(cellColumnName)
    : tab?.browse?.columns?.map((column) => column.name) || [];
}

function mutationFieldState(tab, column, type) {
  const field = tab.browse?.columns?.find((item) => item.name === column) || {};
  const isKey = tab.browse?.primaryKeys?.includes(column);
  if (field.generated) return { disabled: true, hint: "生成字段由数据库维护" };
  if (type === "edit" && isKey) return { disabled: true, hint: "主键用于定位行，不会被修改" };
  if (field.identity) {
    if (type === "edit" || (driverForTab(tab) === "postgres" && field.identityGeneration !== "byDefault")) {
      return { disabled: true, hint: "自增字段由数据库自动生成" };
    }
    return { disabled: false, hint: "留空由数据库自动生成，也可手动指定" };
  }
  return { disabled: false, hint: type === "insert" && field.defaultValue ? "留空使用数据库默认值" : "" };
}

function openMutation(type) {
  const tab = activeTab();
  if (tab?.mode !== "write") {
    showToast("当前已锁定为只读，请先点击锁解锁", "error");
    return;
  }
  const browse = tab?.browse;
  if (!browse || !["table", "partitioned_table"].includes(browse.kind)) return;
  const columns = mutationColumns(tab);
  const primaryKeys = browse.primaryKeys || [];
  const selectedRows = resultGrid.getSelectedRows?.() || [];
  if ((type === "edit" || type === "delete") && (!primaryKeys.length || selectedRows.length === 0)) {
    showToast("请先选择带主键的表数据行", "error");
    return;
  }
  if (type === "edit" && selectedRows.length !== 1) {
    showToast("编辑时只能选择一行", "error");
    return;
  }
  state.mutation = { type, tab, columns, primaryKeys, selectedRows };
  const labels = { insert: "新增行", edit: "编辑行", delete: "删除行" };
  refs.mutationTitle.textContent = labels[type];
  refs.mutationHint.textContent = `${browse.schema}.${browse.name}${type === "delete" ? ` · 将删除 ${selectedRows.length} 行` : " · 空白字段不写入，编辑时仅保存有改动的字段"}`;
  refs.mutationFeedback.textContent = "";
  refs.mutationFeedback.classList.remove("error");
  refs.applyMutation.textContent = type === "delete" ? "确认删除" : "执行";
  const source = selectedRows[0] || [];
  refs.mutationFields.innerHTML = type === "delete"
    ? '<div class="form-note">删除操作会按主键匹配选中行，执行前仍会再次确认。</div>'
    : columns
        .map((column, index) => {
          const isKey = primaryKeys.includes(column);
          const field = mutationFieldState(tab, column, type);
          const value = type === "edit" && source[index] != null ? cellText(source[index]) : "";
          return `<div class="mutation-field"><label for="mutation-${index}">${escapeHtml(column)}${isKey ? " · 主键" : ""}</label><input id="mutation-${index}" data-mutation-column="${escapeHtml(column)}" value="${escapeHtml(value ?? "")}"${field.disabled ? " disabled" : ""}/>${field.hint ? `<small>${escapeHtml(field.hint)}</small>` : ""}</div>`;
        })
        .join("");
  refs.mutationModal.showModal();
}

async function applyMutation(event) {
  event?.preventDefault();
  const mutation = state.mutation;
  if (!mutation || cellWritePending(mutation.tab)) return;
  const { type, tab, columns, primaryKeys, selectedRows } = mutation;
  const browse = tab.browse;
  const driver = driverForTab(tab);
  const quote = (identifier) => quoteIdentForDriver(identifier, driver);
  const table = `${quote(browse.schema)}.${quote(browse.name)}`;
  let sql;
  try {
    if (type === "delete") {
      const keyIndexes = primaryKeys.map((key) => columns.indexOf(key));
      const predicates = selectedRows.map((row) =>
        `(${primaryKeys.map((key, index) => sqlEquality(quote(key), sqlLiteral(row[keyIndexes[index]], driver), driver)).join(" AND ")})`,
      );
      sql = `DELETE FROM ${table}\nWHERE ${predicates.join(" OR ")};`;
    } else {
      const values = Object.fromEntries(
        [...refs.mutationFields.querySelectorAll("[data-mutation-column]")].map((input) => [input.dataset.mutationColumn, input.value]),
      );
      const source = selectedRows[0] || [];
      const changed = columns.filter((column, index) => !mutationFieldState(tab, column, type).disabled && typeof values[column] === "string" && values[column].trim() !== "" &&
        values[column] !== (source[index] == null ? "" : cellText(source[index])));
      if (type === "insert") {
        const included = columns.filter((column) => !mutationFieldState(tab, column, type).disabled && typeof values[column] === "string" && values[column].trim() !== "");
        sql = included.length
          ? `INSERT INTO ${table} (${included.map(quote).join(", ")})\nVALUES (${included.map((column) => sqlLiteral(values[column], driver)).join(", ")});`
          : driver === "mysql" ? `INSERT INTO ${table} () VALUES ();` : `INSERT INTO ${table} DEFAULT VALUES;`;
      } else {
        if (!changed.length) {
          refs.mutationFeedback.textContent = "尚未修改任何字段";
          refs.mutationFeedback.classList.add("error");
          return;
        }
        const keyPredicates = primaryKeys.map((key) => {
          const index = columns.indexOf(key);
          return sqlEquality(quote(key), sqlLiteral(source[index], driver), driver);
        });
        sql = `UPDATE ${table}\nSET ${changed.map((column) => `${quote(column)} = ${sqlLiteral(mutationInputValue(values[column], source[columns.indexOf(column)]), driver)}`).join(", ")}\nWHERE ${keyPredicates.join(" AND ")};`;
      }
    }
  } catch (error) {
    refs.mutationFeedback.textContent = `无法生成写入语句：${errorText(error)}`;
    refs.mutationFeedback.classList.add("error");
    return;
  }
  if (!await confirmWrite(sql, tab)) return;
  refs.applyMutation.disabled = true;
  try {
    const payload = await call("execute_mutation", {
      request: {
        connectionId: tab.connectionId || state.activeConnectionId,
        database: tabDatabase(tab),
        schema: tabSchema(tab),
        sql,
        queryId: makeId("mutation"),
        readOnly: false,
      },
    });
    refs.mutationModal.close();
    state.mutation = null;
    tab.message = `写入成功 · ${payload.row_count ?? 0} 行受影响`;
    tab.outputTab = "message";
    showToast(`写入成功 · ${payload.row_count ?? 0} 行受影响`);
    const txOpen = state.transactionKeys.has(transactionKey(tab.connectionId || state.activeConnectionId, tabDatabase(tab)));
    if (!txOpen) {
      const originalMode = tab.mode;
      tab.mode = "read";
      state.applyingBrowse = true;
      setEditorValue(browseSql(browse));
      state.applyingBrowse = false;
      await runQuery();
      tab.mode = originalMode;
    }
  } catch (error) {
    refs.mutationFeedback.textContent = `执行失败：${errorText(error)}`;
    refs.mutationFeedback.classList.add("error");
  } finally {
    refs.applyMutation.disabled = false;
    renderTabs();
    renderOutput();
  }
}

function resultData() {
  return resultGrid.getSelectedData();
}
async function copyResults() {
  const data = resultData();
  if (!data?.columns.length) return;
  const text = formatClipboardRows(data.columns, data.rows);
  try {
    await copyText(text);
    showToast(`已复制 ${data.rows.length} 行`);
  } catch {
    showToast("复制失败，请检查剪贴板权限", "error");
  }
}
async function exportResults() {
  const data = resultData();
  if (!data?.columns.length) return;
  const csvEscape = (value) => {
    const text = value === null ? "" : cellText(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [data.columns, ...data.rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
  const name = `${activeTab()?.title || "query"}.csv`;
  try {
    const nativeResult = invoke
      ? await call("save_text_file", {
          fileName: name,
          contents: `\ufeff${csv}`,
        })
      : null;
    const outcome = resolveSaveOutcome(Boolean(invoke), nativeResult);
    if (outcome === "saved") {
      showToast(`已导出 ${data.rows.length} 行`);
      return;
    }
    if (outcome === "cancelled") {
      showToast("已取消导出");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }),
    );
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`已导出 ${data.rows.length} 行`);
  } catch (error) {
    showToast(`导出失败：${errorText(error)}`, "error");
  }
}

async function confirmDiscardCellEdits(tabs) {
  const drafts = tabs.map(tab => ({ tab, rows: tab.result?.rows, draft: Array.isArray(tab.result?.rows) ? resultGrid.getCellEditDraft(tab.result.rows) : null })).filter(item => item.draft);
  if (!drafts.length) return true;
  if (drafts.some(item => item.draft.pending)) { showToast("请等待单元格保存完成"); return false; }
  if (!await confirmAction("当前有尚未保存的单元格修改。继续操作会放弃这些修改。", { title: "放弃单元格修改？", acceptLabel: "放弃并继续" })) return false;
  return drafts.every(item => resultGrid.discardCellEdit(item.rows));
}

function cellDestination(tab) {
  const profile = state.profiles.find(item => item.id === tab.connectionId);
  return JSON.stringify({
    connection: tab.connectionId, driver: driverForTab(tab), database: tabDatabase(tab), schema: tabSchema(tab),
    endpoint: profile && [profile.host, profile.port, profile.user, profile.driver, profile.database],
    table: tab.browse && [tab.browse.schema, tab.browse.name, tab.browse.kind, tab.browse.primaryKeys],
    key: tab.redisKey, keyType: tab.redisType, redisDb: tab.redisKey != null ? redisTabDatabase(tab) : null,
  });
}
function cellWritePending(tab) {
  return Boolean(tab && state.tabs.some(item => item.cellSaving && item.connectionId === tab.connectionId && tabDatabase(item) === tabDatabase(tab)));
}
function captureCellEdit(tab, cell, capability) {
  const result = tab.result;
  return {
    tab, result, ...cell, capability, rowRef: result.rows[cell.rowIndex], row: [...result.rows[cell.rowIndex]],
    columns: result.columns.map(cellColumnName), destination: cellDestination(tab),
    connectionId: tab.connectionId, database: tabDatabase(tab), schema: tabSchema(tab), driver: driverForTab(tab),
    browse: tab.browse ? { ...tab.browse, primaryKeys: [...(tab.browse.primaryKeys || [])] } : null,
    key: tab.redisKey, keyType: tab.redisType, redisDb: tab.redisKey != null ? redisTabDatabase(tab) : null,
    location: queryTargetDescription(tab),
  };
}
function getCellEditState(cell) {
  const tab = activeTab();
  const capability = getCellEditCapability(tab, cell, driverForTab(tab));
  if (capability.editable && cellWritePending(tab)) return { ...capability, editable: false, reason: "请等待当前单元格保存完成" };
  return { ...capability, context: capability.editable ? captureCellEdit(tab, cell, capability) : null };
}
function assertCellEditCurrent(context, ownSave = false) {
  const tab = context?.tab;
  if (!tab || !state.tabs.includes(tab) || tab.result !== context.result ||
      tab.result.rows[context.rowIndex] !== context.rowRef || cellDestination(tab) !== context.destination ||
      tab.result.columns.map(cellColumnName).join('\0') !== context.columns.join('\0')) {
    throw new Error("原始结果或执行位置已改变，请重新打开单元格后编辑");
  }
  if (tab.result.transactionRolledBack) throw new Error("当前事务已回滚，结果需要刷新；请先复制需要保留的修改后刷新数据");
  const capability = getCellEditCapability(ownSave ? { ...tab, cellSaving: false } : tab, context, context.driver);
  if (!capability.editable) throw new Error(capability.reason);
  return capability;
}
async function commitCellValue(context, newValue, isNull = false) {
  const capability = assertCellEditCurrent(context);
  if (cellWritePending(context.tab)) throw new Error("请等待当前单元格保存完成");
  const value = validateCellDraft(isNull ? null : newValue, capability);
  if ((value === null && context.value === null) || (value !== null && context.value !== null && value === cellText(context.value))) return true;
  const tab = context.tab;
  const txKey = transactionKey(context.connectionId, context.database);
  const txOpen = state.transactionKeys.has(txKey);
  const isRedis = context.driver === "redis";
  const sql = isRedis ? null : buildCellUpdateSql({ ...context.browse, ...context, value });
  const field = isRedis && context.keyType === "hash" ? context.row[context.columns.indexOf("field")] : null;
  tab.cellSaving = true;
  renderTabs();
  try {
    const accepted = await confirmAction(
      isRedis
        ? `执行位置：${context.location}\nKey：${context.key}${field !== null ? `\n字段：${field}` : ""}\n\n保存会校验原值，防止覆盖其他操作的修改。`
        : `执行位置：${context.location}\n字段：${context.column}${txOpen ? "\n写入当前事务，提交后才会生效。" : ""}`,
      { title: "确认保存单元格", detail: isRedis ? value : sql, acceptLabel: "保存修改" },
    );
    if (!accepted) return false;
    assertCellEditCurrent(context, true);
    if (state.transactionKeys.has(txKey) !== txOpen) throw new Error("事务状态已改变，请重新确认后保存");
    let changedRows = 1;
    try {
      if (isRedis) {
        await call("save_redis_cell", { request: {
          connectionId: context.connectionId, database: context.redisDb, key: context.key, keyType: context.keyType,
          field, expectedValue: cellText(context.value), value, readOnly: false,
        } });
      } else {
        const payload = await call("execute_mutation", { request: {
          connectionId: context.connectionId, database: context.database, schema: context.schema,
          sql, queryId: makeId("cell-mutation"), readOnly: false,
        } });
        changedRows = payload.row_count ?? 0;
      }
    } catch (error) {
      // The SQL backend rolls back and removes a failed transaction.
      if (!isRedis && txOpen) {
        state.transactionKeys.delete(txKey);
        for (const item of state.tabs) {
          if (item.connectionId === context.connectionId && tabDatabase(item) === context.database && item.result?.cellEditsInTransaction) {
            item.message = "保存失败，当前事务已回滚。之前未提交的单元格修改已撤销，请刷新核对。";
            item.result.transactionRolledBack = true;
          }
        }
      }
      throw error;
    }
    if (!changedRows) throw new Error("数据库没有报告行变更，请刷新核对记录后再编辑");
    if (tab.result === context.result && tab.result.rows[context.rowIndex] === context.rowRef) {
      const row = [...context.row];
      row[context.columnIndex] = value;
      tab.result.rows[context.rowIndex] = row;
      resultGrid.updateCellEditContexts?.(context.result.rows, draft => {
        const sibling = draft.context;
        if (!sibling || sibling === context || sibling.tab !== tab || sibling.result !== context.result ||
            sibling.destination !== context.destination || sibling.rowIndex !== context.rowIndex ||
            sibling.rowRef !== context.rowRef || sibling.columnIndex === context.columnIndex ||
            sibling.value !== row[sibling.columnIndex]) return;
        sibling.rowRef = row;
        sibling.row = [...row];
      });
      if (txOpen) tab.result.cellEditsInTransaction = true;
      tab.gridState = null;
      if (activeTab() === tab && state.gridResult === tab.result) {
        resultGrid.refreshRows();
      }
    }
    tab.message = `${isRedis ? "Redis 单元格" : "单元格"}已保存${txOpen ? "，已写入当前事务，尚未提交" : ""}\n执行位置：${context.location}\n字段：${context.column}\n可刷新数据核对数据库返回值。`;
    showToast(txOpen ? "单元格已写入当前事务，尚未提交" : "单元格已保存");
    return true;
  } finally {
    tab.cellSaving = false;
    renderTabs();
  }
}
async function commitInlineCell({ context, newValue, isNull }) {
  if (!context) throw new Error("当前单元格不可编辑，请重新加载数据");
  return commitCellValue(context, newValue, isNull);
}

function openCellInspector({ column, columnIndex, value, rowIndex, context = null, draftValue, draftIsNull }) {
  const tab = context?.tab || activeTab();
  const capability = getCellEditCapability(tab, { column, columnIndex, rowIndex }, driverForTab(tab));
  if (!context && capability.editable) context = captureCellEdit(tab, { column, columnIndex, value, rowIndex }, capability);
  const hasDraft = typeof draftValue === "string";
  const displayedValue = hasDraft ? draftValue : value;
  const columnMetadata = tab?.browse?.columns?.find((item) => item.name === column);
  const dataType = columnMetadata?.dataType || "";
  const declaredJson = /(?:^|[^a-z0-9_])jsonb?(?:$|[^a-z0-9_])/i.test(dataType);
  let jsonInfo = null;
  if (displayedValue !== null && displayedValue !== undefined) {
    try {
      const raw = typeof displayedValue === "string" ? displayedValue : JSON.stringify(displayedValue);
      const parsed = JSON.parse(raw);
      if (declaredJson || (parsed !== null && typeof parsed === "object")) jsonInfo = { raw };
    } catch {
      // Only actual JSON values get the JSON preview controls; ordinary text
      // cells keep the existing plain-text inspector.
    }
  }
  state.cellInspector = { tab, column, columnIndex, value, rowIndex, context, capability, jsonInfo, jsonMode: "pretty", jsonEditing: false };
  refs.cellTitle.textContent = column;
  refs.cellMeta.textContent = `第 ${rowIndex + 1} 行 · ${value === null ? "NULL" : typeof value}`;
  refs.cellValue.value = hasDraft ? draftValue : jsonInfo?.raw ?? (value === null ? "" : cellText(value));
  refs.cellNull.checked = hasDraft ? Boolean(draftIsNull) : value === null;
  refs.cellFeedback.textContent = "";
  const canEdit = capability.editable;
  refs.cellNullControl.hidden = !canEdit || !capability.allowNull;
  refs.cellValue.readOnly = !canEdit;
  refs.cellValue.disabled = canEdit && refs.cellNull.checked;
  refs.saveCell.disabled = false;
  refs.saveCell.hidden = !canEdit;
  refs.cellMeta.textContent += ` · ${canEdit ? "可编辑，保存前会二次确认" : capability.reason || "只读详情"}`;
  refs.cellJsonTools.hidden = !jsonInfo;
  refs.cellJsonCaption.textContent = "JSON 预览";
  refs.cellJsonFormatControls.hidden = false;
  refs.editCellJson.hidden = !canEdit || !jsonInfo;
  refs.editCellJson.textContent = "编辑 JSON";
  refs.cellJsonPreview.hidden = !jsonInfo;
  refs.cellValue.hidden = Boolean(jsonInfo);
  refs.saveCell.hidden = !canEdit || Boolean(jsonInfo);
  refs.cellValue.readOnly = !canEdit || Boolean(jsonInfo);
  if (jsonInfo) renderCellJsonPreview();
  else refs.cellValue.readOnly = !canEdit;
  if (hasDraft && jsonInfo && canEdit) toggleCellJsonEditing();
  refs.cellModal.showModal();
  requestAnimationFrame(() => {
    if (jsonInfo && !state.cellInspector?.jsonEditing) refs.cellJsonPretty.focus({ preventScroll: true });
    else {
      refs.cellValue.focus({ preventScroll: true });
      refs.cellValue.select();
    }
  });
}
function renderCellJsonPreview() {
  const inspector = state.cellInspector;
  if (!inspector?.jsonInfo) return;
  const pretty = inspector.jsonMode === "pretty";
  setSelectableText(refs.cellJsonPreview, formatJsonSource(inspector.jsonInfo.raw, pretty));
  refs.cellJsonPretty.setAttribute("aria-pressed", String(pretty));
  refs.cellJsonCompact.setAttribute("aria-pressed", String(!pretty));
  refs.cellJsonPretty.classList.toggle("active", pretty);
  refs.cellJsonCompact.classList.toggle("active", !pretty);
}
function formatJsonSource(source, pretty) {
  const text = String(source);
  if (!pretty) {
    let compact = "";
    let inString = false;
    let escaped = false;
    for (const character of text) {
      if (inString) {
        compact += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') {
        inString = true;
        compact += character;
      } else if (!/\s/.test(character)) compact += character;
    }
    return compact;
  }
  let formatted = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const indent = () => "  ".repeat(depth);
  const nextToken = (from) => {
    let index = from;
    while (index < text.length && /\s/.test(text[index])) index++;
    return text[index];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      formatted += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (/\s/.test(character)) continue;
    if (character === '"') {
      inString = true;
      formatted += character;
    } else if (character === "{" || character === "[") {
      formatted += character;
      depth++;
      if (nextToken(index + 1) !== (character === "{" ? "}" : "]")) formatted += `\n${indent()}`;
    } else if (character === "}" || character === "]") {
      depth--;
      if (formatted.at(-1) !== (character === "}" ? "{" : "[")) formatted += `\n${indent()}`;
      formatted += character;
    } else if (character === ",") formatted += `,\n${indent()}`;
    else if (character === ":") formatted += ": ";
    else formatted += character;
  }
  return formatted;
}
function toggleCellJsonEditing() {
  const inspector = state.cellInspector;
  if (!inspector?.jsonInfo) return;
  if (!inspector.jsonEditing) {
    inspector.jsonEditing = true;
    refs.cellValue.value = inspector.jsonInfo.raw;
    refs.cellValue.readOnly = false;
    refs.cellValue.hidden = false;
    refs.cellJsonPreview.hidden = true;
    refs.cellJsonFormatControls.hidden = true;
    refs.cellJsonCaption.textContent = "JSON 编辑";
    refs.editCellJson.textContent = "返回预览";
    refs.saveCell.hidden = false;
    refs.cellValue.focus({ preventScroll: true });
    refs.cellValue.select();
    return;
  }
  try { JSON.parse(refs.cellValue.value); }
  catch {
    showToast("JSON 格式无效，请修正后再返回预览", "error");
    refs.cellValue.focus();
    return;
  }
  inspector.jsonInfo = { raw: refs.cellValue.value };
  inspector.jsonEditing = false;
  refs.cellValue.readOnly = true;
  refs.cellValue.hidden = true;
  refs.cellJsonPreview.hidden = false;
  refs.cellJsonFormatControls.hidden = false;
  refs.cellJsonCaption.textContent = "JSON 预览";
  refs.editCellJson.textContent = "编辑 JSON";
  refs.saveCell.hidden = false;
  renderCellJsonPreview();
}
async function saveCellEdit() {
  const edit = state.cellInspector;
  if (!edit?.context || refs.saveCell.disabled) return;
  const newValue = edit.jsonInfo && !edit.jsonEditing ? edit.jsonInfo.raw : refs.cellValue.value;
  refs.saveCell.disabled = true;
  refs.cellValue.disabled = true;
  refs.cellNull.disabled = true;
  refs.cellFeedback.textContent = "";
  try {
    if (await commitCellValue(edit.context, newValue, refs.cellNull.checked)) {
      refs.cellModal.close();
      state.cellInspector = null;
    }
  } catch (error) {
    refs.cellFeedback.textContent = errorText(error);
  } finally {
    refs.saveCell.disabled = false;
    refs.cellNull.disabled = false;
    refs.cellValue.disabled = refs.cellNull.checked;
  }
}
function showFeedback(message, error = false) {
  refs.connectionFeedback.textContent = message;
  refs.connectionFeedback.classList.toggle("error", error);
}
const dismissibleDialogIds = [
  "connectionModal",
  "databaseModal",
  "schemaModal",
  "cellModal",
  "redisRenameModal",
  "redisCreateModal",
  "mutationModal",
  "createObjectModal",
  "shortcutsModal",
];
function clearDialogDraft(dialog) {
  if (dialog === refs.createObjectModal) state.pendingObjectCreate = null;
  if (dialog === refs.databaseModal) state.databasePickerDraft = null;
  if (dialog === refs.schemaModal) {
    state.schemaPickerDraft = null;
    state.schemaPickerDatabase = null;
  }
  if (dialog === refs.cellModal) state.cellInspector = null;
  if (dialog === refs.redisRenameModal) state.pendingRedisRename = null;
  if (dialog === refs.redisCreateModal) state.pendingRedisCreate = null;
  if (dialog === refs.mutationModal) state.mutation = null;
}
function dismissDialog(dialog) {
  if (!dialog?.open || dialogIsBusy(dialog)) return;
  clearDialogDraft(dialog);
  dialog.close();
}
function dialogIsBusy(dialog) {
  return (dialog === refs.connectionModal && (refs.saveConnection.disabled || refs.testConnection.disabled)) ||
    (dialog === refs.cellModal && refs.saveCell.disabled) ||
    (dialog === refs.redisCreateModal && refs.applyRedisCreate.disabled) ||
    (dialog === refs.mutationModal && refs.applyMutation.disabled);
}
function isBackdropClick(dialog, event) {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
}
function selectedConnectionDriver() {
  return refs.connectionDriver?.value || "postgres";
}
function defaultConnectionDatabase(driver) {
  return driver === "redis" ? "0" : driver === "mysql" ? "" : "postgres";
}
function ensureMySqlDriverOption() {
  if (!refs.connectionDriverMenu || refs.connectionDriverMenu.querySelector('[data-driver="mysql"]')) return;
  // Keep older cached Tauri HTML compatible with the driver list. The menu is
  // also declared in index.html, but adding the option here makes upgrades
  // deterministic when WebKit has retained a previous embedded document.
  refs.connectionDriverMenu.insertAdjacentHTML(
    "beforeend",
    '<button class="driver-option" type="button" role="option" data-driver="mysql" aria-selected="false"><span class="driver-picker-icon" aria-hidden="true">M</span><span><strong>MySQL</strong><small>关系型数据库</small></span><span class="driver-choice-check" aria-hidden="true">✓</span></button>',
  );
}
function renderConnectionDriver() {
  ensureMySqlDriverOption();
  const value = selectedConnectionDriver();
  const option = refs.connectionDriverMenu?.querySelector(`[data-driver="${CSS.escape(value)}"]`);
  const label = option?.querySelector("strong")?.textContent || (value === "redis" ? "Redis" : value === "mysql" ? "MySQL" : "PostgreSQL");
  const icon = option?.querySelector(".driver-picker-icon")?.textContent || (value === "redis" ? "R" : value === "mysql" ? "M" : "PG");
  if (refs.connectionDriverValue) refs.connectionDriverValue.textContent = label;
  if (refs.connectionDriverIcon) refs.connectionDriverIcon.textContent = icon;
  refs.connectionDriverMenu?.querySelectorAll("[data-driver]").forEach((item) => {
    item.setAttribute("aria-selected", String(item.dataset.driver === value));
  });
}
function setConnectionDriver(value) {
  if (!refs.connectionDriver) return;
  if (value !== selectedConnectionDriver()) {
    refs.connectionDatabase.value = defaultConnectionDatabase(value);
    if (["", "localhost", "127.0.0.1"].includes(refs.connectionHost.value)) refs.connectionHost.value = value === "redis" ? "127.0.0.1" : "localhost";
    if (!refs.connectionUser.value || refs.connectionUser.dataset.defaultUser === "true") {
      refs.connectionUser.value = value === "mysql" ? "root" : value === "redis" ? "default" : "postgres";
      refs.connectionUser.dataset.defaultUser = "true";
    }
  }
  refs.connectionDriver.value = value;
  renderConnectionDriver();
  updateConnectionFormForDriver();
}
function closeConnectionDriverMenu() {
  if (!refs.connectionDriverMenu || refs.connectionDriverMenu.hidden) return;
  refs.connectionDriverMenu.hidden = true;
  refs.connectionDriverTrigger?.setAttribute("aria-expanded", "false");
}
function toggleConnectionDriverMenu(force) {
  if (!refs.connectionDriverMenu || !refs.connectionDriverTrigger) return;
  const open = force ?? refs.connectionDriverMenu.hidden;
  refs.connectionDriverMenu.hidden = !open;
  refs.connectionDriverTrigger.setAttribute("aria-expanded", String(open));
  if (open) refs.connectionDriverMenu.querySelector(`[data-driver="${CSS.escape(selectedConnectionDriver())}"]`)?.focus();
}
function updateConnectionFormForDriver() {
  refs.connectionForm.querySelectorAll("input").forEach(input => input.setCustomValidity(""));
  const driver = selectedConnectionDriver();
  const isRedis = driver === "redis";
  const isMysql = driver === "mysql";
  const isTlsDriver = isRedis || isMysql;
  renderConnectionDriver();
  if (refs.connectionModal) refs.connectionModal.classList.toggle("redis-driver", isRedis);
  const eyebrow = refs.connectionModal?.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = isRedis ? "REDIS" : isMysql ? "MYSQL" : "POSTGRESQL";
  if (refs.connectionDatabaseLabel) refs.connectionDatabaseLabel.textContent = "数据库";
  if (refs.connectionUserLabel) refs.connectionUserLabel.textContent = isRedis ? "ACL 用户（可选）" : "用户名";
  if (refs.connectionDatabase) {
    refs.connectionDatabase.removeAttribute("placeholder");
    refs.connectionDatabase.required = driver === "postgres";
  }
  if (refs.connectionDatabaseField) refs.connectionDatabaseField.hidden = isRedis || isMysql;
  if (refs.connectionUser) {
    refs.connectionUser.removeAttribute("placeholder");
    refs.connectionUser.required = !isRedis;
  }
  if (refs.connectionTlsField) refs.connectionTlsField.hidden = !isTlsDriver;
  if (refs.connectionTls) refs.connectionTls.disabled = !isTlsDriver;
  if (refs.connectionTlsLabel) refs.connectionTlsLabel.textContent = isRedis ? "使用 TLS（rediss://）" : "使用 TLS";
  if (refs.connectionCaField) refs.connectionCaField.hidden = !(isRedis && refs.connectionTls?.checked);
  if (refs.connectionCaPath) refs.connectionCaPath.disabled = !isRedis || !refs.connectionTls?.checked;
  if (refs.chooseConnectionCa) refs.chooseConnectionCa.disabled = !isRedis || !refs.connectionTls?.checked;
  if (refs.clearConnectionCa) refs.clearConnectionCa.disabled = !isRedis || !refs.connectionTls?.checked;
  refs.connectionHost?.removeAttribute("placeholder");
  const defaultPort = isRedis ? "6379" : isMysql ? "3306" : "5432";
  if (refs.connectionPort && (!refs.connectionPort.value || ["5432", "6379", "3306"].includes(refs.connectionPort.value)))
    refs.connectionPort.value = defaultPort;
  const note = refs.connectionModal?.querySelector(".form-note");
  if (note) note.textContent = isRedis
    ? "密码存入系统钥匙串。默认连接 DB 0，可在对象树中切换其他 DB。"
    : isMysql
      ? "密码存入系统钥匙串。连接后从对象树中选择数据库。"
    : "密码存入系统钥匙串，连接配置保存在此设备。";
}
function profileFromForm() {
  const driver = selectedConnectionDriver();
  const redisDbText = refs.connectionDatabase.value.trim();
  const redisDb = redisDbText === "" ? 0 : Number(redisDbText);
  return {
    id: refs.connectionModal.dataset.editId || "",
    name: refs.connectionName.value.trim(),
    host: refs.connectionHost.value.trim(),
    driver,
    port: Number(refs.connectionPort.value || (driver === "redis" ? 6379 : driver === "mysql" ? 3306 : 5432)),
    database: refs.connectionDatabase.value.trim(),
    user: refs.connectionUser.value.trim(),
    sslMode: "disable",
    tls: (driver === "redis" || driver === "mysql") && Boolean(refs.connectionTls?.checked),
    redisDb: driver === "redis" ? redisDb : null,
    redisCaCertPath: driver === "redis" ? (refs.connectionCaPath?.value.trim() || null) : null,
  };
}
function fillConnection(profile = null) {
  refs.connectionForm.querySelectorAll("input").forEach(input => input.setCustomValidity(""));
  refs.connectionModal.dataset.editId = profile?.id || "";
  refs.connectionTitle.textContent = profile ? "编辑连接" : "新建连接";
  refs.connectionDriver.value = profile?.driver || "postgres";
  renderConnectionDriver();
  refs.connectionName.value = profile?.name || "";
  refs.connectionHost.value = profile?.host ?? "localhost";
  refs.connectionPort.value = profile?.port || (profile?.driver === "redis" ? 6379 : profile?.driver === "mysql" ? 3306 : 5432);
  if (refs.connectionTls) refs.connectionTls.checked = Boolean(profile?.tls);
  if (refs.connectionCaPath) refs.connectionCaPath.value = profile?.redisCaCertPath || "";
  refs.connectionDatabase.value = profile?.driver === "redis"
    ? String(profile?.redisDb ?? profile?.database ?? 0)
    : profile?.database || defaultConnectionDatabase(selectedConnectionDriver());
  refs.connectionUser.value = profile?.user ?? "postgres";
  refs.connectionUser.dataset.defaultUser = String(!profile);
  refs.connectionPassword.value = "";
  passwordFields.hideAll(refs.connectionModal);
  refs.connectionPassword.placeholder = profile ? "留空保留已保存密码" : "";
  refs.deleteConnection.hidden = !profile;
  updateConnectionFormForDriver();
  showFeedback("");
}
function validateConnectionForm() {
  for (const input of [refs.connectionName, refs.connectionHost, refs.connectionUser, refs.connectionDatabase]) {
    input.setCustomValidity(input.required && !input.value.trim() ? "请填写此项" : "");
  }
  return refs.connectionForm.reportValidity();
}
function setConnectionBusy(busy, action = "save") {
  if (busy) state.connectionFormFocus = document.activeElement;
  state.modalBusy = busy;
  refs.connectionForm.setAttribute("aria-busy", String(busy));
  for (const control of refs.connectionForm.querySelectorAll("button, input")) {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === "true";
      delete control.dataset.wasDisabled;
    }
  }
  refs.saveConnection.textContent = busy && action === "save" ? "保存并连接中…" : "保存并连接";
  refs.testConnection.textContent = busy && action === "test" ? "测试中…" : "测试连接";
  if (!busy && refs.connectionModal.open && state.connectionFormFocus?.isConnected) {
    state.connectionFormFocus.focus({ preventScroll: true });
  }
}
async function saveConnection(event) {
  event?.preventDefault();
  if (state.modalBusy || !validateConnectionForm()) return;
  const profile = profileFromForm();
  if (profile.driver === "redis" && (!Number.isInteger(profile.redisDb) || profile.redisDb < 0)) {
    showFeedback("Redis DB 必须是非负整数", true);
    return;
  }
  setConnectionBusy(true);
  showFeedback("正在保存连接配置…");
  try {
    const saved = await call("save_connection", {
      request: { profile, password: refs.connectionPassword.value },
    });
    state.connectionStatuses[saved.id] = "idle";
    state.treeSessions.delete(saved.id);
    state.queryTargets.clear();
    // The profile has been saved even if establishing the connection fails.
    await loadConnections({ restore: false });
    const tab = activeTab();
    if (tab && !tab.connectionId && !tab.sql.trim() && !tab.browse && !tab.redisKey) {
      tab.connectionId = saved.id;
      tab.database = saved.database || null;
      tab.schema = null;
    }
    persistTabs();
    showFeedback("配置已保存，正在连接数据库…");
    const connected = await selectConnection(saved.id);
    renderTabs();
    if (connected) {
      refs.connectionModal.close();
      showToast("已保存并连接");
    } else {
      refs.connectionModal.dataset.editId = saved.id;
      refs.connectionTitle.textContent = "编辑连接";
      refs.deleteConnection.hidden = false;
      refs.connectionPassword.value = "";
      refs.connectionPassword.placeholder = "留空保留已保存密码";
      showFeedback(`连接配置已保存，但未能连接。${state.connectionErrors[saved.id] || "请检查地址和凭据后重试。"}`, true);
    }
  } catch (error) {
    showFeedback(`保存失败：${errorText(error)}`, true);
  } finally {
    setConnectionBusy(false);
  }
}
async function testConnection() {
  if (state.modalBusy || !validateConnectionForm()) return;
  setConnectionBusy(true, "test");
  showFeedback("正在测试连接…");
  try {
    await call("test_connection", {
      request: { profile: profileFromForm(), password: refs.connectionPassword.value },
    });
    showFeedback("连接成功，可以保存并开始使用");
  } catch (error) {
    showFeedback(`连接失败：${errorText(error)}`, true);
  } finally {
    setConnectionBusy(false);
  }
}
async function deleteConnection() {
  const id = refs.connectionModal.dataset.editId;
  if (!id || !await confirmAction("删除该连接并移除系统钥匙串密码？")) return;
  try {
    await call("delete_connection", { connectionId: id });
    state.treeSessions.delete(id);
    delete state.connectionStatuses[id];
    refs.connectionModal.close();
    if (state.activeConnectionId === id) {
      state.schemaRequest += 1;
      state.redisRequest += 1;
      state.objectRequests.clear();
      state.selectedObject = null;
      state.selectedTreeKey = null;
      state.activeConnectionId = null;
      state.databases = [];
      state.redisDatabases = [];
      state.redisDatabaseError = null;
      state.redisExpanded.clear();
      state.redisPages.clear();
      state.redisScanGenerations.clear();
      state.redisPattern = "";
      state.visibleDatabases.clear();
      state.visibleSchemasByDatabase.clear();
      state.expandedDatabases.clear();
      clearTransactionKeys(id);
      state.expandedSchemas.clear();
      state.schemaPickerDatabase = null;
      state.schemaPickerDraft = null;
      state.schemasByDatabase.clear();
      state.objectsBySchema.clear();
    }
    await loadConnections();
    renderTree();
    showToast("连接已删除");
  } catch (error) {
    showFeedback(`删除失败：${errorText(error)}`, true);
  }
}

function bindEvents() {
  for (const id of dismissibleDialogIds) {
    const dialog = refs[id];
    let startedOnBackdrop = false;
    dialog.addEventListener("pointerdown", (event) => { startedOnBackdrop = isBackdropClick(dialog, event); });
    dialog.addEventListener("click", (event) => {
      if (startedOnBackdrop && isBackdropClick(dialog, event) && !dialogIsBusy(dialog)) dismissDialog(dialog);
      startedOnBackdrop = false;
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!dialogIsBusy(dialog)) dismissDialog(dialog);
    });
    dialog.addEventListener("close", () => clearDialogDraft(dialog));
  }
  refs.createObjectName.addEventListener("input", () => refs.createObjectName.setCustomValidity(""));
  for (const button of [refs.closeCreateObject, refs.cancelCreateObject]) {
    button.addEventListener("click", () => dismissDialog(refs.createObjectModal));
  }
  refs.createObjectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const pending = state.pendingObjectCreate;
    const name = refs.createObjectName.value.trim();
    if (!pending) return;
    if (!name || name.includes("\0")) {
      refs.createObjectName.setCustomValidity("请输入有效名称");
      refs.createObjectName.reportValidity();
      return;
    }
    if (pending.action === "rename-table" && name === pending.target.object.name) {
      refs.createObjectName.setCustomValidity("请输入不同于原表名的新名称");
      refs.createObjectName.reportValidity();
      return;
    }
    dismissDialog(refs.createObjectModal);
    submitContextCreateQuery(pending.target, pending.action, name);
  });
  const closeThemeMenu = (restoreFocus = false) => {
    refs.themeMenu.hidden = true;
    refs.themeButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) refs.themeButton.focus();
  };
  const openThemeMenu = () => {
    refs.themeMenu.hidden = false;
    refs.themeButton.setAttribute("aria-expanded", "true");
    refs.themeMenu.querySelector('[aria-checked="true"]')?.focus();
  };
  refs.themeButton.addEventListener("click", () => refs.themeMenu.hidden ? openThemeMenu() : closeThemeMenu(true));
  refs.themeButton.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); openThemeMenu(); }
  });
  refs.themeMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-theme-option]");
    if (!option) return;
    applyTheme(option.dataset.themeOption);
    closeThemeMenu(true);
  });
  refs.themeMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeThemeMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...refs.themeMenu.querySelectorAll('[data-theme-option]')];
    const current = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  refs.themeMenu.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !refs.themePicker.contains(event.relatedTarget)) closeThemeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#themePicker") && !refs.themeMenu.hidden) closeThemeMenu();
  });
  refs.newConnection.addEventListener("click", () => {
    fillConnection();
    refs.connectionModal.showModal();
    refs.connectionName.focus();
  });
  refs.databaseSearch?.addEventListener("input", renderDatabasePicker);
  refs.databaseSelectAll?.addEventListener("change", () => {
    const query = (refs.databaseSearch?.value || "").trim().toLowerCase();
    const draft = state.databasePickerDraft || state.visibleDatabases;
    for (const database of state.databases) {
      if (!query || database.name.toLowerCase().includes(query)) {
        if (refs.databaseSelectAll.checked) draft.add(database.name);
        else draft.delete(database.name);
      }
    }
    renderDatabasePicker();
  });
  refs.databaseList?.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const draft = state.databasePickerDraft || state.visibleDatabases;
    if (input.checked) draft.add(input.value);
    else draft.delete(input.value);
    renderDatabasePicker();
  });
  refs.databasePickerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await applyDatabasePicker();
  });
  refs.schemaSearch?.addEventListener("input", renderSchemaPicker);
  refs.schemaSelectAll?.addEventListener("change", () => {
    const database = state.schemaPickerDatabase;
    const schemas = state.schemasByDatabase.get(database) || [];
    const query = (refs.schemaSearch?.value || "").trim().toLowerCase();
    const draft =
      state.schemaPickerDraft || state.visibleSchemasByDatabase.get(database) || new Set();
    for (const schema of schemas) {
      if (!query || schema.name.toLowerCase().includes(query)) {
        if (refs.schemaSelectAll.checked) draft.add(schema.name);
        else draft.delete(schema.name);
      }
    }
    state.schemaPickerDraft = draft;
    renderSchemaPicker();
  });
  refs.schemaList?.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const database = state.schemaPickerDatabase;
    const draft =
      state.schemaPickerDraft || state.visibleSchemasByDatabase.get(database) || new Set();
    if (input.checked) draft.add(input.value);
    else draft.delete(input.value);
    state.schemaPickerDraft = draft;
    renderSchemaPicker();
  });
  refs.schemaPickerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await applySchemaPicker();
  });
  const closeSchemaPicker = () => {
    dismissDialog(refs.schemaModal);
  };
  refs.cancelSchemaPicker?.addEventListener("click", closeSchemaPicker);
  refs.closeSchemaPicker?.addEventListener("click", closeSchemaPicker);
  const closeDatabasePicker = () => {
    dismissDialog(refs.databaseModal);
  };
  refs.cancelDatabasePicker?.addEventListener("click", closeDatabasePicker);
  refs.closeDatabasePicker?.addEventListener("click", closeDatabasePicker);
  refs.emptyNewConnection?.addEventListener("click", () => {
    fillConnection();
    refs.connectionModal.showModal();
  });
  refs.closeConnection.addEventListener("click", () => dismissDialog(refs.connectionModal));
  refs.cancelConnection.addEventListener("click", () => dismissDialog(refs.connectionModal));
  refs.connectionForm.addEventListener("submit", saveConnection);
  refs.connectionForm.addEventListener("input", (event) => { event.target.setCustomValidity?.(""); });
  refs.connectionUser.addEventListener("input", () => { refs.connectionUser.dataset.defaultUser = "false"; });
  renderConnectionDriver();
  refs.connectionDriverTrigger?.addEventListener("click", () => toggleConnectionDriverMenu());
  refs.connectionDriverMenu?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-driver]");
    if (!option) return;
    setConnectionDriver(option.dataset.driver);
    closeConnectionDriverMenu();
    refs.connectionDriverTrigger?.focus({ preventScroll: true });
  });
  refs.connectionDriverTrigger?.addEventListener("keydown", (event) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      toggleConnectionDriverMenu(true);
    } else if (event.key === "Escape") closeConnectionDriverMenu();
  });
  refs.connectionDriverMenu?.addEventListener("keydown", (event) => {
    const options = [...refs.connectionDriverMenu.querySelectorAll("[data-driver]")];
    const current = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeConnectionDriverMenu();
      refs.connectionDriverTrigger?.focus({ preventScroll: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[(current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      document.activeElement?.click();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#connectionDriverPicker")) closeConnectionDriverMenu();
  });
  refs.connectionTls?.addEventListener("change", updateConnectionFormForDriver);
  refs.chooseConnectionCa?.addEventListener("click", async () => {
    try {
      const path = await call("choose_redis_ca_file");
      if (path && refs.connectionCaPath) refs.connectionCaPath.value = path;
    } catch (error) {
      showFeedback(`选择 CA 文件失败：${errorText(error)}`, true);
    }
  });
  refs.clearConnectionCa?.addEventListener("click", () => {
    if (refs.connectionCaPath) refs.connectionCaPath.value = "";
  });
  refs.testConnection.addEventListener("click", testConnection);
  refs.deleteConnection.addEventListener("click", deleteConnection);
  refs.connectionSearch.addEventListener("input", renderConnections);
  refs.historySearch.addEventListener("input", renderHistory);
  refs.connectionList.addEventListener("click", async (event) => {
    if (event.target.closest("[data-clear-connection-search]")) {
      refs.connectionSearch.value = "";
      renderConnections();
      refs.connectionSearch.focus();
      return;
    }
    if (event.target.closest("#emptyNewConnection")) {
      fillConnection();
      refs.connectionModal.showModal();
      return;
    }
    const edit = event.target.closest("[data-edit-id]");
    if (edit) {
      fillConnection(state.profiles.find((p) => p.id === edit.dataset.editId));
      refs.connectionModal.showModal();
      return;
    }
    const toggle = event.target.closest("[data-connection-toggle]");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const id = toggle.dataset.connectionToggle;
      if (state.connectionStatuses[id] === "connected") await disconnectConnection(id);
      else if (state.connectionStatuses[id] !== "connecting") await selectConnection(id);
      return;
    }
    const button = event.target.closest("[data-connection-id]");
    if (button) {
      const id = button.dataset.connectionId;
      const tab = activeTab();
      // A table/key tab belongs to the connection it was opened from. Picking
      // another instance changes the browser context without silently sending
      // that tab's later edits to the new server. A blank unbound query may
      // still be conveniently attached to the selected instance.
      if (tab && !tab.connectionId && !tab.redisKey && !tab.browse && !tab.running) {
        tab.connectionId = id;
      }
      persistTabs();
      renderTabs();
      // Selecting an instance only changes the active context. Connection
      // state is controlled by the dedicated plug button beside the card.
      if (state.activeConnectionId !== id || state.connectionStatuses[id] !== "connected")
        await selectConnection(id);
      updateEditorSchema();
      renderOutput();
    }
  });
  refs.disconnectConnection.addEventListener("click", () => disconnectConnection());
  refs.refreshSchema.addEventListener("click", async () => {
    const connectionId = state.activeConnectionId;
    if (!connectionId || state.connectionStatuses[connectionId] !== "connected") return;
    if (driverForConnection(connectionId) === "redis") return refreshRedisContext();
    if (!await refreshDatabaseList({ connectionId }, { notify: false })) return;
    if (connectionId !== state.activeConnectionId) return;
    const refreshed = await loadVisibleSchemas();
    if (connectionId === state.activeConnectionId)
      showToast(refreshed ? "数据库对象已刷新" : "刷新未完成，部分对象读取失败", refreshed ? "info" : "error");
  });
  refs.collapseTree.addEventListener("click", () => {
    state.expandedSchemas.clear();
    state.expandedDatabases.clear();
    renderTree();
  });
  refs.objectTree.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); clearTreeSelection(); return;
    }
    if (event.target.closest('[data-tree-toggle]')) return;
    const row = event.target.closest('.tree-root, summary, .category-summary');
    if (!row || event.target !== row) return;
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      selectTreeTarget(treeTargetFromNode(row));
    } else if (["ArrowRight", "ArrowLeft"].includes(event.key) && !row.matches('.tree-root')) {
      event.preventDefault();
      toggleTreeRow(row, event.key === "ArrowRight");
    }
  });
  refs.objectTree.addEventListener("click", async (event) => {
    const disclosure = event.target.closest('[data-tree-toggle]');
    if (disclosure) {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail < 2) toggleTreeRow(disclosure.closest('summary, .category-summary'));
      return;
    }
    // Native summary clicks otherwise toggle the whole row, including labels.
    if (event.target.closest('summary')) event.preventDefault();
    if (event.target.closest('[data-tree-connect]')) {
      if (!state.profiles.length) refs.newConnection.click();
      else commandPalette.open("连接");
      return;
    }
    if (event.target.closest('[data-clear-object-search]')) {
      refs.objectSearch.value = "";
      renderTree();
      refs.objectSearch.focus();
      return;
    }
    const clickedTarget = treeTargetFromNode(event.target);
    if (clickedTarget) selectTreeTarget(clickedTarget);
    else if (event.target === refs.objectTree) clearTreeSelection();
    const redisKeyRow = event.target.closest("[data-redis-key]");
    if (redisKeyRow) {
      await openRedisValueTab(redisKeyRow.dataset.redisKey, Number(redisKeyRow.dataset.redisDb));
      return;
    }
    if (event.target.closest("[data-refresh-redis]")) return refreshRedisContext();
    const loadMore = event.target.closest("[data-load-more-redis-db]");
    if (loadMore) {
      await loadRedisKeys(Number(loadMore.dataset.loadMoreRedisDb), redisPage(Number(loadMore.dataset.loadMoreRedisDb)).cursor, state.redisPattern);
      return;
    }
    if (event.target.closest("[data-display-databases]")) {
      openDatabasePicker();
      return;
    }
    const schemaPicker = event.target.closest("[data-display-schemas]");
    if (schemaPicker) {
      event.preventDefault();
      event.stopPropagation();
      openSchemaPicker(schemaPicker.dataset.displaySchemas);
      return;
    }
    if (event.target.closest('.category-summary')) return;
    const retrySchema = event.target.closest("[data-retry-schema]");
    if (retrySchema) {
      await loadVisibleSchemas();
      return;
    }
    const retryConnection = event.target.closest("[data-retry-connection]");
    if (retryConnection) {
      await selectConnection(retryConnection.dataset.retryConnection);
      return;
    }
    const row = event.target.closest("[data-object-id]");
    if (!row) return;
    const object = state.objectsBySchema
      .get(schemaKey(row.dataset.database, row.dataset.schema))
      ?.find((o) => o.id === row.dataset.objectId);
    if (!object) return;
    state.selectedObject = object;
    if (event.target.closest(".object-open")) {
      state.objectClickPreviewId = null;
      openObjectQuery(object);
      return;
    }
    if (event.detail >= 2) return;
    state.objectClickPreviewId = null;
    const target = objectTabTarget(object, state.activeConnectionId);
    const existing = findObjectTab(target, "data") || findObjectTab(target, "structure");
    if (existing) activateTab(existing.id);
    else openObjectStructureTab(object, state.activeConnectionId, { fromTreeClick: event.detail === 1 });
  });
  refs.objectTree.addEventListener("contextmenu", (event) => {
    hideContextMenus();
    const target = treeTargetFromNode(event.target);
    if (!target || !target.connectionId || state.connectionStatuses[target.connectionId] !== "connected") return;
    event.preventDefault();
    selectTreeTarget(target);
    if (target.type === "redis-key" || target.type === "redis-database") {
      state.contextRedisKey = target.key;
      state.contextRedisDb = target.database;
      state.contextRedisConnectionId = target.connectionId;
      showContextMenu(target.type === "redis-key" ? refs.redisContextMenu : refs.redisDatabaseContextMenu, event.clientX, event.clientY);
      return;
    }
    state.contextObject = target.object || null;
    state.contextTreeTarget = target;
    prepareObjectContextMenu(target);
    showContextMenu(refs.objectContextMenu, event.clientX, event.clientY);
  });
  refs.objectContextMenu?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-context-action]")?.dataset.contextAction;
    const target = state.contextTreeTarget;
    const object = target?.type === "object" ? target.object : null;
    if (!action || !target) return;
    hideContextMenus();
    if (action === "copy-ddl") return copyContextDdl(target);
    if (action === "new-database-query") return openDatabaseContextQuery(target);
    if (action === "refresh-database") return refreshDatabaseContext(target);
    if (action === "refresh-databases") return refreshDatabaseList(target);
    if (action === "refresh-redis") return refreshRedisContext();
    if (action === "refresh-schema" || action === "refresh-object") return refreshTreeObject(target);
    if (action === "edit-structure") return openTableStructureEditor(target);
    if (["create-database", "create-schema", "create-table", "rename-table"].includes(action)) {
      return openContextCreateQuery(target, action);
    }
    if (!object) return;
    if (action === "open-data") return openObjectQuery(object);
    if (action === "open-structure") return openObjectStructureTab(object);
    if (action === "new-query") {
      const driver = contextDriver(target);
      addTab(`SELECT *\nFROM ${quoteIdentForDriver(object.schema, driver)}.${quoteIdentForDriver(object.name, driver)}\nLIMIT 500;`, target.connectionId, null, { database: object.database, schema: object.schema });
      return;
    }
    if (action === "copy-name") {
      try { await copyText(`${object.schema}.${object.name}`); showToast("已复制完整名称"); }
      catch { showToast("复制失败", "error"); }
      return;
    }
  });
  refs.redisContextMenu?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-redis-context-action]")?.dataset.redisContextAction;
    const key = state.contextRedisKey;
    const contextDatabase = Number(state.contextRedisDb);
    const contextConnectionId = state.contextRedisConnectionId;
    if (!action || !key) return;
    const connectionId = contextConnectionId || state.activeConnectionId;
    const targetTab = activeTab()?.redisKey === key && activeTab()?.connectionId === connectionId && redisTabDatabase(activeTab()) === contextDatabase
      ? activeTab()
      : state.tabs.find((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase);
    const modeTab = targetTab || (activeTab()?.connectionId === connectionId ? activeTab() : null);
    // A selected connection without an open key tab uses the app's default
    // writable mode. Once a key tab exists, its lock controls mutations.
    const readOnly = modeTab ? modeTab.mode !== "write" : false;
    hideContextMenus();
    if (action === "open") return openRedisValueTab(key, contextDatabase);
    if (action === "refresh") {
      const generation = state.redisRequest;
      const current = () => connectionId === state.activeConnectionId && generation === state.redisRequest;
      try {
        const value = await call("get_redis_value", { connectionId, database: contextDatabase, key });
        if (!current()) return;
        for (const tab of state.tabs.filter((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase)) {
          if (!tab.running && !tab.refreshing) applyRedisValueResult(tab, value, connectionId, contextDatabase);
        }
        if (activeTab()?.redisKey === key && activeTab()?.connectionId === connectionId && redisTabDatabase(activeTab()) === contextDatabase) renderOutput();
        const refreshed = await loadRedisKeys(contextDatabase, 0, state.redisPattern, connectionId, generation);
        if (refreshed && current()) showToast("Redis key 已刷新");
        else if (current()) showToast(`刷新 key 列表失败：${redisPage(contextDatabase).error || "请重试"}`, "error");
      } catch (error) {
        if (current()) showToast(`刷新 Redis key 失败：${errorText(error)}`, "error");
      }
      return;
    }
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(key);
        showToast("已复制 Redis key");
      } catch {
        showToast("复制失败", "error");
      }
      return;
    }
    if (!connectionId) return;
    if (action === "delete") {
      if (readOnly) {
        showToast("当前 Redis 标签已锁定为只读，请先解锁", "error");
        return;
      }
      if (!await confirmAction(`确定删除 Redis key「${key}」吗？\n\n该操作不可撤销。`)) return;
      try {
        await call("delete_redis_key", { connectionId, database: contextDatabase, key, readOnly: false });
        closeTabsByIds(state.tabs.filter((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase).map((tab) => tab.id));
        await loadRedisKeys(contextDatabase, 0, state.redisPattern);
        showToast("Redis key 已删除");
      } catch (error) {
        showToast(`删除 Redis key 失败：${errorText(error)}`, "error");
      }
      return;
    }
    if (action === "rename") {
      if (readOnly) {
        showToast("当前 Redis 标签已锁定为只读，请先解锁", "error");
        return;
      }
      state.pendingRedisRename = { key, connectionId, database: contextDatabase };
      refs.redisRenameInput.value = key;
      refs.redisRenameFeedback.textContent = "目标 key 已存在时不会覆盖。";
      refs.redisRenameModal.showModal();
      requestAnimationFrame(() => { refs.redisRenameInput.focus(); refs.redisRenameInput.select(); });
    }
  });
  refs.redisDatabaseContextMenu?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-redis-database-context-action]")?.dataset.redisDatabaseContextAction;
    const database = Number(state.contextRedisDb);
    const connectionId = state.contextRedisConnectionId || state.activeConnectionId;
    hideContextMenus();
    if (!action || !connectionId || !Number.isInteger(database) || database < 0) return;
    if (action === "refresh") {
      if (connectionId === state.activeConnectionId) await refreshRedisContext(database);
      return;
    }
    if (action === "create") {
      const tab = activeExecutionTab();
      if (tab?.connectionId === connectionId && tab.mode === "read") return showToast("当前 Redis 标签已锁定为只读，请先解锁", "error");
      state.pendingRedisCreate = { connectionId, database };
      refs.redisCreateForm.reset();
      redisTypePicker.reset();
      refs.redisCreateFeedback.textContent = "已存在的 key 不会被覆盖。";
      refs.redisCreateFieldRow.hidden = true;
      refs.redisCreateField.required = false;
      refs.redisCreateScoreRow.hidden = true;
      refs.redisCreateModal.showModal();
      refs.redisCreateKey.focus();
      return;
    }
    if (action !== "console") return;
    rememberActiveView();
    state.redisConsole = {
      id: makeId("redis-console"),
      title: `控制台 · DB ${database}`,
      sql: "",
      connectionId,
      database: String(database),
      redisDb: database,
      mode: "write",
      console: true,
      consoleHistory: [],
    };
    renderTabs();
    renderOutput();
    redisEditor?.focus();
  });
  refs.objectTree.addEventListener("dblclick", (event) => {
    const branch = treeBranchForDoubleClick(event.target);
    if (branch) { event.preventDefault(); toggleTreeRow(branch); return; }
    const row = event.target.closest("[data-object-id]");
    const object =
      row &&
      state.objectsBySchema
        .get(schemaKey(row.dataset.database, row.dataset.schema))
        ?.find((o) => o.id === row.dataset.objectId);
    const previewTab = state.tabs.find((tab) => tab.id === state.objectClickPreviewId);
    state.objectClickPreviewId = null;
    if (object) {
      state.selectedObject = object;
      openObjectQuery(object, { previewTab });
    }
  });
  refs.objectSearch.addEventListener("input", async () => {
    if (state.profiles.find((profile) => profile.id === state.activeConnectionId)?.driver === "redis") {
      const search = refs.objectSearch.value.trim();
      state.redisPattern = search ? `*${search}*` : "";
      await Promise.all([...state.redisExpanded].map((database) => loadRedisKeys(database, 0, state.redisPattern)));
      return;
    }
    renderTree();
    if (refs.objectSearch.value.trim() && state.connectionStatuses[state.activeConnectionId] === "connected") {
      await Promise.all([...state.visibleDatabases]
        .filter((database) => !state.schemasByDatabase.has(database))
        .map((database) => loadSchemas(database)));
    }
    if (
      refs.objectSearch.value.trim() &&
      state.connectionStatuses[state.activeConnectionId] === "connected"
    )
      await Promise.all(
        [...state.schemasByDatabase].flatMap(([database, schemas]) =>
          schemas
            .filter(
              (schema) =>
                !state.visibleSchemasByDatabase.has(database) ||
                state.visibleSchemasByDatabase.get(database).has(schema.name),
            )
            .map((schema) => loadSchemaObjects(database, schema.name)),
        ),
      );
  });
  refs.refreshQueryTarget.addEventListener("click", () => { void loadQueryTarget(activeTab(), true); renderTabs(); });
  refs.addQueryTab.addEventListener("click", () => addTab());
  refs.welcomeConnect.addEventListener("click", () => refs.newConnection.click());
  refs.welcomeQuery.addEventListener("click", () => addTab());
  refs.openCommands.addEventListener("click", () => commandPalette.open());
  refs.showShortcuts.addEventListener("click", () => refs.shortcutsModal.showModal());
  refs.closeShortcuts.addEventListener("click", () => dismissDialog(refs.shortcutsModal));
  refs.emptyNextAction.addEventListener("click", () => runEmptyResultAction(activeTab(), {
    stop: () => refs.stopQuery.click(),
    message: () => refs.messageTab.click(),
    connect: () => {
      if (!state.profiles.length) refs.newConnection.click();
      else commandPalette.open("连接");
    },
    tableSql: () => refs.openTableSql.click(),
    refresh: () => refs.refreshTableData.click(),
    editor: () => state.editor?.focus(),
  }));
  refs.queryTabs.addEventListener("keydown", (event) => {
    const target = event.target.closest('[role="tab"]');
    if (!target || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...refs.queryTabs.querySelectorAll('[role="tab"]')];
    const current = buttons.indexOf(target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    const id = buttons[next]?.dataset.tabId;
    if (!id) return;
    event.preventDefault();
    activateTab(id, false);
    refs.queryTabs.querySelector(`.tab-select[data-tab-id="${CSS.escape(id)}"]`)?.focus();
  });
  document.querySelector('.result-tabs').addEventListener('keydown', (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('.result-tabs [role="tab"]')].filter(button => !button.disabled);
    const current = buttons.indexOf(event.target);
    if (current < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  });
  refs.queryTabs.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close-tab]");
    if (close) {
      closeTab(close.dataset.closeTab);
      return;
    }
    const tabButton = event.target.closest("[data-tab-id]");
    if (tabButton) {
      activateTab(tabButton.dataset.tabId);
    }
  });
  refs.queryTabs.addEventListener("contextmenu", (event) => {
    const tab = event.target.closest(".query-tab");
    if (!tab) return;
    event.preventDefault();
    state.contextTabId = tab.dataset.tabId;
    showContextMenu(refs.tabContextMenu, event.clientX, event.clientY);
  });
  refs.tabContextMenu?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-tab-context-action]")?.dataset.tabContextAction;
    if (action) applyTabContextAction(action);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".context-menu")) hideContextMenus();
  });
  refs.openTableSql?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab?.browse && !tab?.redisKey) return;
    if (tab.browse) {
      const query = addTab(tab.sql, tab.connectionId, null, { database: tabDatabase(tab), schema: tabSchema(tab) });
      if (query) {
        query.mode = tab.mode;
        renderTabs();
        persistTabs();
      }
      return;
    }
    tab.tableView = false;
    if (tab.redisKey && !tab.sql) tab.sql = `GET "${tab.redisKey.replaceAll('"', '\\"')}"`;
    if (tab.redisKey) setEditorValue(tab.sql);
    renderTabs();
    renderOutput();
    state.editor?.focus();
  });
  refs.openTableDdl?.addEventListener("click", () => {
    const tab = activeTab();
    const browse = tab?.browse;
    if (!browse) return;
    openObjectStructureTab({
      id: browse.id,
      database: browse.database,
      schema: browse.schema,
      name: browse.name,
      kind: browse.kind,
      qualifiedName: `${browse.schema}.${browse.name}`,
    }, tab.connectionId);
  });
  refs.refreshTableData?.addEventListener("click", async () => {
    const tab = activeTab();
    if (cellWritePending(tab)) return;
    if (!tab || !await confirmDiscardCellEdits([tab]) || activeTab() !== tab) return;
    if (tab?.redisKey) {
      if (tab.refreshing) return;
      const connectionId = tab.connectionId || state.activeConnectionId;
      const database = redisTabDatabase(tab);
      const key = tab.redisKey;
      const request = {};
      tab.redisValueRequest = request;
      const isCurrent = () => state.tabs.includes(tab) && tab.redisValueRequest === request;
      tab.refreshing = true;
      renderTabs();
      renderOutput();
      try {
        if (state.connectionStatuses[connectionId] !== "connected") {
          if (!await selectConnection(connectionId)) {
            if (state.connectionStatuses[connectionId] === "error") throw new Error(state.connectionErrors[connectionId] || "无法连接此 Key 所属的 Redis 连接，请检查连接设置。");
            return;
          }
        }
        const value = await call("get_redis_value", { connectionId, key, database });
        if (!isCurrent() || tab.redisKey !== key) return;
        applyRedisValueResult(tab, value, connectionId, database);
        tab.error = false;
      } catch (error) {
        if (isCurrent() && tab.redisKey === key) {
          tab.error = true;
          tab.message = `刷新 Redis key 失败：${errorText(error)}`;
          if (activeTab() === tab) showToast(tab.message, "error");
        }
      } finally {
        if (isCurrent()) {
          tab.refreshing = false;
          tab.redisValueRequest = null;
          if (activeTab() === tab) {
            renderTabs();
            renderOutput();
          }
        }
      }
      return;
    }
    if (!tab?.browse || tab.running) return;
    if (!tab.browse.detailsLoaded) {
      try { await loadBrowseDetails(tab); } catch (error) { showToast(errorText(error), "error"); return; }
    }
    state.applyingBrowse = true;
    setEditorValue(browseSql(tab.browse));
    state.applyingBrowse = false;
    await runQuery({ preserveResult: true });
  });
  refs.modeBadge?.addEventListener("click", toggleMode);
  refs.beginTransaction?.addEventListener("click", () => changeTransaction("begin"));
  refs.commitTransaction?.addEventListener("click", () => changeTransaction("commit"));
  refs.rollbackTransaction?.addEventListener("click", () => changeTransaction("rollback"));
  refs.newRow?.addEventListener("click", () => openMutation("insert"));
  refs.editRow?.addEventListener("click", () => openMutation("edit"));
  refs.deleteRows?.addEventListener("click", () => openMutation("delete"));
  refs.mutationForm?.addEventListener("submit", applyMutation);
  const closeMutation = () => {
    dismissDialog(refs.mutationModal);
  };
  refs.cancelMutation?.addEventListener("click", closeMutation);
  refs.closeMutation?.addEventListener("click", closeMutation);
  refs.runQuery.addEventListener("click", runQuery);
  redisEditor = createRedisEditor({ parent: refs.redisCommandEditor, getKeys: () => cachedRedisKeys(),
    onChange: value => {
      const tab = activeExecutionTab();
      if (!tab?.console) return;
      tab.sql = value;
      refs.redisConsoleHint.textContent = redisCommandHint(value) || "输入命令查看参数说明";
      persistTabs();
    }, onHint: value => { refs.redisConsoleHint.textContent = redisCommandHint(value) || "输入命令查看参数说明"; }, onRun: () => void runQuery() });
  refs.redisConsoleRun.addEventListener("click", () => void runQuery());
  refs.redisClearEditor.addEventListener("click", () => { redisEditor.setValue(""); redisEditor.focus(); });
  refs.redisClearOutput.addEventListener("click", () => {
    const tab = activeExecutionTab();
    if (!tab?.console || tab.running) return;
    tab.consoleHistory = []; persistTabs(); renderRedisConsole(tab);
  });
  refs.redisConsoleOutput.addEventListener("click", async event => {
    const tab = activeExecutionTab();
    if (!tab?.console) return;
    const reuse = event.target.closest("[data-redis-reuse]");
    const copy = event.target.closest("[data-redis-copy]");
    const example = event.target.closest("[data-redis-example]");
    if (example || reuse) {
      redisEditor.setValue(example?.dataset.redisExample ?? tab.consoleHistory[Number(reuse.dataset.redisReuse)]?.command ?? "");
      redisEditor.focus();
    }
    if (copy) {
      try { await copyText(tab.consoleHistory[Number(copy.dataset.redisCopy)]?.output || "", { allowEmpty: true }); showToast("已复制执行结果"); }
      catch { showToast("复制失败", "error"); }
    }
  });
  redisTypePicker = createRedisTypePicker({ input: refs.redisCreateType, trigger: refs.redisCreateTypeTrigger,
    menu: refs.redisCreateTypeMenu, label: refs.redisCreateTypeValue, icon: refs.redisCreateTypeIcon,
    detail: refs.redisCreateTypeDetail, dialog: refs.redisCreateModal });
  refs.redisCreateType.addEventListener("change", () => {
    refs.redisCreateFieldRow.hidden = refs.redisCreateType.value !== "hash";
    refs.redisCreateField.required = refs.redisCreateType.value === "hash";
    refs.redisCreateScoreRow.hidden = refs.redisCreateType.value !== "zset";
  });
  refs.closeRedisCreate.addEventListener("click", () => dismissDialog(refs.redisCreateModal));
  refs.cancelRedisCreate.addEventListener("click", () => dismissDialog(refs.redisCreateModal));
  refs.redisCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pending = state.pendingRedisCreate;
    if (!pending || refs.applyRedisCreate.disabled) return;
    const tab = activeExecutionTab();
    if (tab?.connectionId === pending.connectionId && tab.mode === "read") {
      refs.redisCreateFeedback.textContent = "当前 Redis 标签已锁定为只读，请先解锁";
      return;
    }
    refs.applyRedisCreate.disabled = true;
    try {
      await call("create_redis_key", { request: { ...pending,
        key: refs.redisCreateKey.value, keyType: refs.redisCreateType.value,
        value: refs.redisCreateValue.value, field: refs.redisCreateField.value,
        score: Number(refs.redisCreateScore.value), ttl: Number(refs.redisCreateTtl.value), readOnly: false } });
      state.pendingRedisCreate = null;
      refs.redisCreateModal.close();
      if (state.activeConnectionId === pending.connectionId) {
        state.redisExpanded.add(pending.database);
        await refreshRedisTree();
      }
      showToast("Redis key 已创建");
    } catch (error) {
      refs.redisCreateFeedback.textContent = errorText(error);
    } finally { refs.applyRedisCreate.disabled = false; }
  });
  refs.closeRedisConsole?.addEventListener("click", closeRedisConsole);
  refs.stopQuery.addEventListener("click", async () => {
    const tab = activeTab();
    if (!tab?.queryId) return;
    tab.cancelRequested = true;
    refs.stopQuery.disabled = true;
    try {
      const ok = await call("cancel_query", { queryId: tab.queryId });
      if (!ok) {
        tab.cancelRequested = false;
        showToast("查询已结束");
      }
    } catch (error) {
      tab.cancelRequested = false;
      showToast(`取消失败：${errorText(error)}`, "error");
    }
  });
  refs.resultTab.addEventListener("click", () => {
    activeTab().outputTab = "result";
    renderOutput();
  });
  refs.structureTab.addEventListener("click", () => { void showQueryStructure(); });
  refs.messageTab.addEventListener("click", () => {
    activeTab().outputTab = "message";
    renderOutput();
  });
  refs.resultFilter.addEventListener("input", () => {
    activeTab().filter = refs.resultFilter.value;
    renderOutput();
  });
  refs.previousPage.addEventListener("click", () => moveBrowsePage(-1));
  refs.nextPage.addEventListener("click", () => moveBrowsePage(1));
  refs.copyResults.addEventListener("click", copyResults);
  refs.exportResults.addEventListener("click", exportResults);
  refs.closeCell.addEventListener("click", () => dismissDialog(refs.cellModal));
  const closeRedisRename = () => dismissDialog(refs.redisRenameModal);
  refs.closeRedisRename?.addEventListener("click", closeRedisRename);
  refs.cancelRedisRename?.addEventListener("click", closeRedisRename);
  refs.redisRenameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pending = state.pendingRedisRename;
    const newKey = refs.redisRenameInput.value.trim();
    if (!pending || !newKey || newKey === pending.key) return closeRedisRename();
    refs.applyRedisRename.disabled = true;
    try {
      const renamed = await call("rename_redis_key", {
        request: { connectionId: pending.connectionId, database: pending.database, key: pending.key, newKey, readOnly: false },
      });
      if (!renamed) {
        refs.redisRenameFeedback.textContent = "目标 key 已存在，未覆盖原数据。";
        return;
      }
      for (const tab of state.tabs) {
        if (tab.redisKey === pending.key && tab.connectionId === pending.connectionId && redisTabDatabase(tab) === pending.database) {
          tab.redisKey = newKey;
          tab.title = newKey;
        }
      }
      persistTabs();
      closeRedisRename();
      await loadRedisKeys(pending.database, 0, state.redisPattern, pending.connectionId, state.redisRequest);
      renderTabs();
      showToast("Redis key 已重命名");
    } catch (error) {
      refs.redisRenameFeedback.textContent = `重命名失败：${errorText(error)}`;
    } finally {
      refs.applyRedisRename.disabled = false;
    }
  });
  refs.saveCell?.addEventListener("click", saveCellEdit);
  refs.cellNull.addEventListener("change", () => {
    refs.cellValue.disabled = refs.cellNull.checked;
    if (state.cellInspector?.capability.editable) refs.saveCell.hidden = false;
    if (!refs.cellNull.checked && !refs.cellValue.hidden) refs.cellValue.focus();
  });
  refs.cellValue.addEventListener("input", () => { refs.cellFeedback.textContent = ""; });
  refs.cellJsonPretty?.addEventListener("click", () => {
    if (!state.cellInspector?.jsonInfo || state.cellInspector.jsonEditing) return;
    state.cellInspector.jsonMode = "pretty";
    renderCellJsonPreview();
  });
  refs.cellJsonCompact?.addEventListener("click", () => {
    if (!state.cellInspector?.jsonInfo || state.cellInspector.jsonEditing) return;
    state.cellInspector.jsonMode = "compact";
    renderCellJsonPreview();
  });
  refs.editCellJson?.addEventListener("click", toggleCellJsonEditing);
  refs.copyCell.addEventListener("click", async () => {
    try {
      const inspector = state.cellInspector;
      const value = inspector?.jsonInfo && !inspector.jsonEditing
        ? refs.cellJsonPreview.textContent
        : refs.cellValue.value;
      await navigator.clipboard.writeText(value);
      showToast("已复制单元格");
    } catch {
      showToast("复制失败", "error");
    }
  });
  refs.formatQuery.addEventListener("click", () => {
    try {
      setEditorValue(
        formatSqlText(state.editor.state.doc.toString(), {
          language: driverForTab() === "mysql" ? "mysql" : "postgresql",
          keywordCase: "upper",
          tabWidth: 2,
        }),
      );
      showToast("SQL 已格式化");
    } catch (error) {
      showToast(`格式化失败：${errorText(error)}`, "error");
    }
  });
  refs.importSql.addEventListener("click", () => refs.sqlFile.click());
  refs.sqlFile.addEventListener("change", async () => {
    const file = refs.sqlFile.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      const current = activeExecutionTab();
      const reusable = current && !current.sql.trim() && !current.browse && !current.redisKey && !current.structureOnly && !current.console && !current.running;
      if (!reusable && !addTab("", current?.connectionId || state.activeConnectionId)) return;
      setEditorValue(content);
      const tab = activeTab();
      tab.title = file.name.replace(/\.(sql|txt)$/i, "") || "SQL 文件";
      persistTabs();
      renderTabs();
      renderOutput();
      state.editor?.focus();
      showToast(`已打开 ${file.name}`);
    } catch (error) {
      showToast(`打开文件失败：${errorText(error)}`, "error");
    } finally {
      refs.sqlFile.value = "";
    }
  });
  refs.saveSql.addEventListener("click", async () => {
    const tab = activeTab();
    state.editor.plugin(sqlIme)?.finish();
    const text = state.editor.state.doc.toString();
    try {
      const nativeResult = invoke
        ? await call("save_text_file", {
            fileName: `${tab.title || "query"}.sql`,
            contents: text,
          })
        : null;
      const outcome = resolveSaveOutcome(Boolean(invoke), nativeResult);
      if (outcome === "saved") {
        showToast("SQL 已保存");
        return;
      }
      if (outcome === "cancelled") {
        showToast("已取消保存");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([text], { type: "text/plain;charset=utf-8" }),
      );
      a.download = `${tab.title || "query"}.sql`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showToast("SQL 已保存");
    } catch (error) {
      showToast(`保存失败：${errorText(error)}`, "error");
    }
  });
  refs.clearHistory?.addEventListener("click", async () => {
    if (!state.history.length) return;
    if (!await confirmAction("清空最近查询记录？SQL 编辑器中已打开的草稿会保留。", { title: "清空最近查询", acceptLabel: "清空记录" })) return;
    state.history = [];
    refs.historySearch.value = "";
    persistHistory();
    renderHistory();
    showToast("最近查询记录已清空");
  });
  refs.recentQueries?.addEventListener("click", (event) => {
    if (event.target.closest('[data-clear-history-search]')) {
      refs.historySearch.value = "";
      renderHistory();
      refs.historySearch.focus();
      return;
    }
    const button = event.target.closest("[data-history-index]");
    if (button) loadHistoryEntry(Number(button.dataset.historyIndex));
  });
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || state.editor?.compositionStarted) return;
    if (refs.confirmActionModal.open) return;
    if (event.key === "Escape") {
      hideContextMenus();
      for (const id of dismissibleDialogIds) {
        const dialog = refs[id];
        if (dialog?.open && !dialogIsBusy(dialog)) dismissDialog(dialog);
      }
    }
    if (
      refs.cellModal.open ||
      refs.connectionModal.open ||
      refs.mutationModal?.open ||
      refs.schemaModal?.open ||
      refs.databaseModal?.open ||
      refs.createObjectModal?.open ||
      document.querySelector('.structure-editor-dialog[open]')
    )
      return;
    if (document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      commandPalette.open();
      return;
    }
    if (!canHandleGlobalShortcut(event.target)) return;
    if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.target.closest?.(".cm-editor")) {
      event.preventDefault();
      refs.shortcutsModal.showModal();
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "enter") {
        event.preventDefault();
        runQuery();
      } else if (key === "t") {
        event.preventDefault();
        addTab();
      } else if (key === "k") {
        event.preventDefault();
        workspaceLayout.showPane("objects");
        refs.objectSearch.focus();
      } else if (key === "s") {
        event.preventDefault();
        if (activeTab() && !refs.saveSql.hidden) refs.saveSql.click();
      }
    }
  });
}

const resultGrid = new ResultGrid(refs.resultGrid, {
  onInspect: openCellInspector,
  onCopyCell: text => copyText(text, { allowEmpty: true }),
  getCellEditState,
  onCommitCell: commitInlineCell,
  onTextFilterChange: (value) => {
    const tab = activeTab();
    if (tab) tab.filter = value;
    refs.resultFilter.value = value;
    state.gridFilter = value;
  },
  onSelectionChange: ({ selectedCount, selectedColumnCount, totalCount }) => {
    refs.selectionCount.textContent = selectedColumnCount ? `已选 ${selectedColumnCount} 列` : selectedCount
      ? `已选 ${selectedCount}/${totalCount} 行`
      : "";
    if (state.editor && state.gridResult === activeTab()?.result) renderOutput();
  },
});
const desktopMenu = initDesktopMenu({
  copyText: text => copyText(text, { allowEmpty: true }),
  onError: error => showToast(errorText(error), "error"),
  getItems(target) {
    if (target.closest('.cm-editor') && state.editor) {
      const isRedis = Boolean(target.closest("#redisCommandEditor"));
      const editor = isRedis ? redisEditor?.view : state.editor;
      if (!editor) return [];
      const tab = isRedis ? activeExecutionTab() : activeTab();
      const original = editor.state;
      const selection = original.selection.main;
      const selected = original.sliceDoc(selection.from, selection.to);
      const current = () => { if ((isRedis ? redisEditor?.view !== editor || activeExecutionTab() !== tab : state.editor !== editor || activeTab() !== tab) || editor.state !== original) throw new Error("查询内容已改变，请重新打开菜单"); };
      return [
        { label: "剪切", disabled: !selected, run: async () => { await copyText(selected); current(); editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } }); editor.focus(); } },
        { label: "复制", disabled: !selected, run: () => copyText(selected) },
        { label: "粘贴", run: async () => { const text = await navigator.clipboard.readText(); current(); editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length } }); editor.focus(); } },
        { label: "全选", run: () => { editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } }); editor.focus(); } },
        ...(isRedis ? [{ label: "执行命令", run: () => { current(); void runQuery(); } }] : [{ label: "格式化 SQL", disabled: refs.formatQuery.disabled, run: () => { current(); refs.formatQuery.click(); } }]),
      ];
    }
    const connection = target.closest('[data-connection-id], [data-connection-toggle], [data-edit-id]');
    if (connection) {
      const id = connection.dataset.connectionId || connection.dataset.connectionToggle || connection.dataset.editId;
      const profile = state.profiles.find(item => item.id === id);
      if (!profile) return [];
      const connected = state.connectionStatuses[id] === "connected";
      return [
        { label: connected ? "断开连接" : "连接", disabled: state.connectionStatuses[id] === "connecting", run: () => connected ? disconnectConnection(id) : selectConnection(id) },
        { label: "编辑连接…", run: () => { fillConnection(profile); refs.connectionModal.showModal(); } },
        { label: "新建查询", run: () => addTab("", id) },
        { label: "复制连接名称", run: () => copyText(profile.name) },
      ];
    }
    if (target.closest('input, textarea, .selectable-text, [contenteditable="true"], dialog[open]')) return null;
    return [
      { label: "新建查询", run: () => addTab() },
      { label: "新建连接…", run: () => refs.newConnection.click() },
      { label: "快速操作…", run: () => commandPalette.open() },
      { label: "重置工作区布局", run: () => refs.resetLayout.click() },
    ];
  },
});
const commandPalette = createCommandPalette({
  getCommands: () => [
    { id: "new-query", title: "新建查询", description: "打开一个 SQL 草稿", keywords: "sql query", shortcut: "⌘ T", group: "常用操作", run: () => addTab() },
    { id: "new-connection", title: "新建连接", description: "PostgreSQL、MySQL 或 Redis", keywords: "connect database", group: "常用操作", run: () => refs.newConnection.click() },
    { id: "search-objects", title: "搜索数据库对象", description: "按表名、字段或备注查找", shortcut: "⌘ K", group: "常用操作", run: () => { workspaceLayout.showPane("objects"); refs.objectSearch.focus(); } },
    { id: "format-sql", title: "格式化 SQL", disabled: refs.formatQuery.disabled || refs.formatQuery.hidden || !activeTab(), group: "当前查询", run: () => refs.formatQuery.click() },
    { id: "open-sql", title: "打开 SQL 文件", disabled: Boolean(activeExecutionTab()?.console || driverForTab(activeExecutionTab()) === "redis"), group: "常用操作", run: () => refs.importSql.click() },
    { id: "save-sql", title: "保存 SQL 文件", shortcut: "⌘ S", disabled: !activeTab() || refs.saveSql.hidden, group: "当前查询", run: () => refs.saveSql.click() },
    { id: "favorite-query", title: "收藏当前查询", description: "收藏全部 SQL 或选中部分", keywords: "favorite bookmark 收藏", disabled: refs.saveQueryFavorite.disabled, group: "当前查询", run: () => queryLibraryUI.saveCurrent() },
    { id: "query-library", title: "打开查询收藏", description: "搜索、重命名、导入或导出常用 SQL", keywords: "favorite bookmark library 收藏", group: "常用操作", run: () => queryLibraryUI.show() },
    ...state.queryLibrary.map(entry => ({ id: `favorite-${entry.id}`, title: entry.title, description: queryTargetDescription(entry), keywords: ["收藏 favorite", entry.sql], group: "查询收藏", run: () => openSavedQuery(entry) })),
    ...state.tabs.map(tab => ({ id: `tab-${tab.id}`, title: tab.title, description: queryTargetDescription(tab), keywords: "标签 query tab", group: "切换标签", run: () => activateTab(tab.id) })),
    ...state.profiles.map(profile => ({ id: `connection-${profile.id}`, title: profile.name, description: `${profile.driver || "postgres"} · ${profile.host}:${profile.port}`, keywords: "连接 connection", group: "数据库连接", run: async () => {
      const tab = activeTab();
      if (tab && !tab.connectionId && !tab.browse && !tab.redisKey && !tab.running) tab.connectionId = profile.id;
      await selectConnection(profile.id);
      updateEditorSchema(); renderTabs(); renderOutput(); persistTabs();
    } })),
    ...Object.entries({ dark: "暗黑", light: "白天", ocean: "海蓝", forest: "森林", contrast: "高对比" }).map(([theme, name]) => ({ id: `theme-${theme}`, title: `切换到${name}主题`, keywords: "theme appearance 外观", group: "外观与布局", run: () => applyTheme(theme) })),
    { id: "reset-layout", title: "重置工作区布局", group: "外观与布局", run: () => refs.resetLayout.click() },
    { id: "shortcuts", title: "键盘快捷键", group: "帮助", run: () => refs.shortcutsModal.showModal() },
  ],
  onError: error => showToast(errorText(error), "error"),
});
applyTheme(readTheme());
const workspaceLayout = initWorkspaceLayout();
const queryLibraryUI = createQueryLibrary({
  refs, getEntries: () => state.queryLibrary, getProfiles: () => state.profiles,
  getCurrentQuery: () => {
    const tab = activeExecutionTab();
    if (!tab || tab.console || tab.structureOnly || driverForTab(tab) === "redis") return null;
    const selection = state.editor?.state.selection.main;
    const selected = selection && state.editor.state.sliceDoc(selection.from, selection.to).trim();
    return { sql: selected || tab.sql, title: /^查询 \d+$/u.test(tab.title) ? "" : tab.title,
      connectionId: tab.connectionId, database: tabDatabase(tab) || null, schema: tabSchema(tab) };
  },
  onChange: saveQueryLibrary, onOpen: openSavedQuery, confirm: confirmAction, notify: showToast,
  showPane: () => workspaceLayout.showPane("connections"),
  onExport: async contents => {
    const nativeResult = invoke ? await call("save_text_file", { fileName: "db-studio-queries.json", contents }) : null;
    const outcome = resolveSaveOutcome(Boolean(invoke), nativeResult);
    if (outcome === "cancelled") { showToast("已取消导出"); return; }
    if (outcome === "download") {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([contents], { type: "application/json;charset=utf-8" }));
      link.download = "db-studio-queries.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    showToast("查询收藏已导出");
  },
});
createEditor();
renderTabs();
renderOutput();
renderHistory();
renderTree();
bindEvents();
window.addEventListener("pagehide", persistTabs);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistTabs();
});
loadConnections();
updateCursor();
