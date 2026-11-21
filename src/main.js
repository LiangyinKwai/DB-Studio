import { jsonCellInfo } from './cell-json.js';
import { createMysqlCharacterPicker, mysqlCharacterClause } from './mysql-character-settings.js';
import { initAppSelects } from "./app-select.js";
import { acceptCompletion, autocompletion, closeBrackets, closeCompletion, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { keywordCompletionSource, MySQL, PostgreSQL } from "@codemirror/lang-sql";
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
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
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
import { buildCompletionSchema, catalogCompletionSource, matchingColumns, sqlCompletionNamespaces, objectMatchesSearch, queryStructureObjects } from "./sql-catalog.js";
import { createConfirmationDialog } from "./confirmation-dialog.js";
import { initDialogBackdropDismissal } from "./dialog-backdrop.js";
import { queryEditRelation, sqlExecutionInfo, sqlTransactionAction } from "./sql-execution.js";
import { createSchemaSelect } from "./schema-select.js";
import { sqlIme } from "./sql-ime.js";
import { initPasswordFields } from "./password-fields.js";
import { openStructureEditor, structureFingerprint } from "./structure-editor.js";
import { structureMetadataTabs, mountStructureTabs } from "./structure-tabs.js";
import { MAX_QUERY_TABS, restorableWorkspaceTabs } from "./workspace-tabs.js";
import { createDraftPersistence } from "./draft-persistence.js";
import { estimateResultBytes, selectResultsToRelease } from "./query-memory.js";
import { createCommandPalette } from "./command-palette.js";
import { matchesWorkspaceSearch, historyTimeLabel, emptyResultAction, runEmptyResultAction } from "./workspace-ux.js";
import { createSqlExecutionKeymap } from "./sql-shortcuts.js";
import { getCellEditCapability, buildCellUpdateSql, validateCellDraft, cellColumnName, sqlValueLiteral, sqlTypedValueLiteral } from "./cell-edit.js";
import { buildTableDdl } from "./table-ddl.js";
import { setSelectableText } from "./selectable-text.js";
import { initDesktopMenu } from "./desktop-menu.js";
import { redisCompletionSource, redisCommandHint } from "./redis-completion.js";
import { createRedisTypePicker } from "./redis-type-picker.js";
import { createRedisEditor, redisLanguage } from "./redis-editor.js";
import { resolveRedisDatabase } from "./redis-target.js";
import { initResultControls } from "./result-controls.js";
import { initTextInputIme } from "./text-input-ime.js";
import { writeClipboardText } from "./clipboard.js";
import { buildCopiedRowsSql, createExport, readTransferFile } from "./data-transfer.js";
import { mountRowInputShortcuts, readRowInput } from "./row-input.js";
import { openDataImport } from "./data-import-ui.js";
import { postgresIcon, redisIcon } from "./driver-icons.js";
import { mysqlIcon } from "./mysql-icon.js";
import { mysqlColumns, mysqlDdlTargets, mysqlSqlModeExpectation } from "./mysql-ddl.js";
import { openViewEditor } from "./view-editor.js";
import { buildRoutineEdit, routineKindLabels } from "./routine-ddl.js";
import { openRoutineEditor } from "./routine-editor.js";
import { objectActionPlan, clearTablePlan } from "./object-actions.js";
import { createObjectQuickOpen, collectQuickOpenEntries } from './object-quick-open.js';
import { createColumnNavigator } from './column-navigator.js';
import { summarizeWorkspaceAttention } from './workspace-attention.js';
import { formatShortcut } from './shortcut-labels.js';
import { redisKeyTypePresentation, redisKeyIcon } from './redis-key-icons.js';
import { mergeRedisKeyPage, redisPageKeyType } from './redis-key-metadata.js';
import { createValueReader, valueMetricsLabel, valueReaderSource, inspectorSourceValue } from './value-reader.js';
import { createRedisKeyDetails } from './redis-key-details.js';
import { createRedisKeyOperations, redisTypeActions } from './redis-key-operations.js';
import { initRedisMenus } from './redis-menu.js';
import { redisValueForCopy, redisLocation } from './redis-ui.js';
import { boundConsoleHistory, consoleOutputNotice, consoleOutputForCopy } from './redis-console-history.js';
import { redisKeySearchPattern, redisKeyMatchesSearch, searchRedisDatabases } from './redis-search.js';
import { createConnectionGroups } from "./connection-groups-ui.js";
import { initConnectionReorder, moveConnection, orderConnections, readConnectionOrder, saveConnectionOrder } from "./connection-order.js";
import { isRoutine, isSystemDatabase, orderedObjectGroups, syncTreeToggle, setTreeRowExpanded, treeBranchForDoubleClick } from "./object-tree.js";

const shortcutPlatform = navigator.userAgentData?.platform || navigator.platform || '';
const refreshIcon = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/></svg>';
const canViewObjectDdl = object => ['table', 'partitioned_table', 'view', 'materialized_view', 'function', 'procedure', 'sequence', 'event'].includes(object?.kind);
function shortcut(label) { return formatShortcut(String(label || '').replaceAll('⌘/Ctrl', '⌘'), shortcutPlatform); }
const invoke = window.__TAURI__?.core?.invoke;
const refs = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((node) => [node.id, node]),
);
const cellReader = createValueReader(refs.cellJsonPreview, { label: '单元格内容阅读器', onSearchChange: open => refs.cellFind.setAttribute('aria-pressed', String(open)) });
const markFailedStatement = StateEffect.define();
const failedStatementMark = StateField.define({
  create: () => Decoration.none,
  update(mark, transaction) {
    if (transaction.docChanged) mark = Decoration.none;
    for (const effect of transaction.effects) {
      if (effect.is(markFailedStatement)) {
        const range = effect.value;
        mark = range ? Decoration.set([Decoration.mark({ class: "sql-failed-statement" }).range(range.from, range.to)]) : Decoration.none;
      }
    }
    return mark;
  },
  provide: field => EditorView.decorations.from(field),
});
const redisKeyDetails = createRedisKeyDetails({
  copyText: text => copyText(text, { allowEmpty: true }),
  readTtl: ({ connectionId, database, key }) => call('get_redis_ttl', { connectionId, database, key }),
  onError: error => showToast(errorText(error), 'error'),
});
const redisKeyOperations = createRedisKeyOperations({ apply: applyRedisKeyOperation, onError: error => showToast(errorText(error), 'error') });
const redisMenus = initRedisMenus(refs.redisContextMenu, refs.redisDatabaseContextMenu, { shortcut });
const confirmAction = createConfirmationDialog(refs.confirmActionModal);
const passwordFields = initPasswordFields();
const resultControls = initResultControls(refs);
const textInputIme = initTextInputIme();
const querySchemaSelect = createSchemaSelect({
  trigger: refs.querySchema, label: refs.querySchemaLabel, panel: refs.querySchemaMenu,
  search: refs.querySchemaSearch, list: refs.querySchemaList, empty: refs.querySchemaEmpty,
  count: refs.querySchemaCount, backButton: refs.querySchemaBack, onChange: changeQueryTarget,
  onClose: () => {
    if (!state.queryTargetNavigation) return;
    state.queryTargetNavigation = null;
    queueMicrotask(() => renderQueryTarget());
  },
  onOpen: () => {
    const tab = activeTab();
    if (queryTargetLocked(tab)) return;
    if (driverForTab(tab) === "postgres") {
      const database = postgresMenuDatabase(tab);
      const profile = state.profiles.find(item => item.id === tab.connectionId);
      if (database) void loadQueryTarget({ connectionId: tab.connectionId, database }, true);
      else if (profile && !queryDatabaseOptions(profile.id)) void loadQueryDatabaseList(profile, true);
    } else void loadQueryTarget(tab, true);
    renderQueryTarget(tab);
  },
});
// A newly opened workspace should be empty.  A query is created when the user
// explicitly asks for one (⌘T) or opens an object from the tree; showing a
// pre-filled diagnostic query on first launch makes the app look as if it has
// already started working against an unknown database.
const defaultSql = "";
const tabsKey = "db-studio.workspace-tabs.v2";
const historyKey = "db-studio.query-history.v2";
const themeKey = "db-studio.theme.v1";
const draftPersistence = createDraftPersistence({
  key: tabsKey,
  onStatus({ status, label }) {
    refs.draftSaveStatus.dataset.state = status;
    refs.draftSaveLabel.textContent = label;
    refs.retryDraftSave.hidden = status !== 'error';
  },
  onError() {
    showToast('SQL 草稿保存失败，本机存储空间不足或不可用。请先保存 SQL 文件备份，并点击「草稿未保存」重试。', 'error');
  },
});
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
  procedure: "存储过程",
  routine: "存储过程/函数",
  event: "定时事件",
  query: "查询",
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
const driverIcon = (driver) => driver === "redis" ? redisIcon : driver === "mysql" ? mysqlIcon : postgresIcon;
// Chamfered connector housings stay legible at sidebar size; only the socket moves.
const connectionStateIcon = '<svg class="ui-icon connection-state-icon" viewBox="0 0 28 28" aria-hidden="true"><g transform="rotate(-45 14 14)"><path class="connection-cable" d="M2 14h3"/><path class="connection-housing" d="M5 11l2-2h4v10H7l-2-2v-6Z"/><path d="M11 12h3m-3 4h3"/><g class="connection-socket"><path class="connection-housing" d="M17 9h4l2 2v6l-2 2h-4V9Z"/><path class="connection-cable" d="M23 14h3"/><path class="connection-signal" d="M20 12.5v3"/></g></g></svg>';
const moreDotsIcon = svgIcon('<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>');
const infoCircleIcon = svgIcon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v4.6"/><circle cx="12" cy="8" r=".95" fill="currentColor" stroke="none"/>');
const functionIcon = svgIcon('<rect class="catalog-icon-frame" x="3.5" y="3.5" width="17" height="17" rx="3"/><text class="catalog-icon-letter" x="12" y="16">ƒx</text>');
const procedureIcon = svgIcon('<rect class="catalog-icon-frame" x="3.5" y="3.5" width="17" height="17" rx="3"/><text class="catalog-icon-letter" x="12" y="16">Pₓ</text>');
const kindIcons = {
  table: svgIcon('<rect class="catalog-icon-paper" x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path class="catalog-icon-header" d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5H4V6Z"/><path d="M3.5 8.5h17M3.5 14.2h17M9.5 8.5v12m5-12v12"/>'),
  partitioned_table: svgIcon('<rect class="catalog-icon-paper" x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M9.5 10v10.5M14.5 10v10.5M7 2.5h10"/>'),
  view: svgIcon('<rect class="catalog-icon-paper" x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><circle cx="12" cy="14.2" r="2"/><path d="M7.5 14.2c1.2-2.1 2.8-3.1 4.5-3.1s3.3 1 4.5 3.1"/>'),
  materialized_view: svgIcon('<rect class="catalog-icon-paper" x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path class="catalog-icon-header" d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5H4V6Z"/><circle cx="12" cy="14.5" r="2"/><path d="M7.5 14.5c1.2-2 2.8-3 4.5-3s3.3 1 4.5 3"/>'),
  foreign_table: svgIcon('<path d="M7 7h10M7 17h10M5 12h14M8 4l-3 3 3 3M16 14l3 3-3 3"/>'),
  sequence: svgIcon('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>'),
  function: functionIcon,
  procedure: procedureIcon,
  routine: functionIcon,
  event: svgIcon('<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'),
  query: svgIcon('<rect class="catalog-icon-paper" x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 8h17m-13 4 2.5 2.2L7.5 16.5m4.5 0h4.5"/>'),
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
    (!opened.kind || !target.kind || opened.kind === target.kind) && (!opened.id || !target.id || opened.id === target.id) &&
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
        awaitingDatabase: tab.awaitingDatabase === true,
        schema: Object.hasOwn(tab, "schema") ? tab.schema : tab.browse?.schema ?? tab.openedObject?.schema ?? null,
        awaitingSchema: tab.awaitingSchema === true,
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
function persistTabs() {
  clearTimeout(state.persistTimer);
  state.persistTimer = null;
  return draftPersistence.save(() => {
    const tabs = restorableWorkspaceTabs(
        state.tabs.map(({ id, title, sql, connectionId, database, schema, awaitingDatabase, awaitingSchema, mode, browse, openedObject, openedObjectView, redisKey, redisDb, console, consoleHistory, tableView }) => ({
          id,
          title,
          sql,
          connectionId,
          database,
          schema,
          ...(awaitingDatabase ? { awaitingDatabase: true } : {}),
          ...(awaitingSchema ? { awaitingSchema: true } : {}),
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
    const active = tabs.find((tab) => tab.id === state.activeTabId) || tabs.at(-1);
    return { tabs, activeId: active?.id || "" };
  });
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
const themeLabels = { light: "浅色", dark: "深色", system: "跟随系统" };
const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");
let themePreference = "system";
function readTheme() {
  try {
    const value = localStorage.getItem(themeKey);
    if (Object.hasOwn(themeLabels, value)) return value;
    if (["ocean", "forest", "contrast"].includes(value)) return "dark";
  } catch {
    // The system appearance also works when preferences cannot be read.
  }
  return "system";
}
function renderTheme() {
  const appearance = themePreference === "system" ? (systemDarkMode.matches ? "dark" : "light") : themePreference;
  document.body.dataset.theme = appearance;
  document.documentElement.style.colorScheme = appearance;
  refs.themeButtonLabel.textContent = themeLabels[themePreference];
  refs.themeButtonSwatch.className = `theme-swatch theme-${themePreference}`;
  refs.themeMenu?.querySelectorAll("[data-theme-option]").forEach((option) => {
    option.setAttribute("aria-checked", String(option.dataset.themeOption === themePreference));
  });
}
function applyTheme(theme) {
  themePreference = theme;
  renderTheme();
  try {
    localStorage.setItem(themeKey, themePreference);
  } catch {}
}
function toggleMode(tab) {
  if (tab.running || tab.confirming || tab.resolvingTarget || cellWritePending(tab)) return;
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
function releaseRedisConsoleSession(tab) {
  if (!tab?.console) return;
  tab.closed = true;
  tab.consoleHistory = [];
  tab.result = emptyResult();
  if (!invoke) return;
  return call('release_redis_console', { connectionId: tab.connectionId, consoleId: tab.id }).catch(error => {
    if (!tab.releaseErrorNotified) {
      tab.releaseErrorNotified = true;
      showToast(`控制台已关闭，但会话释放失败：${errorText(error)}；请断开该连接以清理会话`, 'error');
    }
  });
}
function closeRedisConsole({ render = true } = {}) {
  if (!state.redisConsole) return;
  const tab = state.redisConsole;
  state.redisConsole = null;
  void releaseRedisConsoleSession(tab);
  redisEditor?.reset('');
  redisEditorSessionId = null;
  refs.redisConsoleOutput.replaceChildren();
  delete refs.redisConsoleOutput.dataset.renderKey;
  if (render) { renderTabs(); renderOutput(); }
}
function tabDatabase(tab = activeTab()) {
  if (tab?.awaitingDatabase) return "";
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
function queryTreeSession(connectionId) {
  return connectionId === state.activeConnectionId ? state : state.treeSessions.get(connectionId);
}
function queryDatabaseVisibility(connectionId) {
  const tree = queryTreeSession(connectionId);
  return tree?.databasesLoaded ? tree.visibleDatabases : readVisibleDatabases(connectionId);
}
function queryNamespaceVisibility(tab, database) {
  const { connectionId } = tab;
  if (driverForTab(tab) === "mysql")
    return queryDatabaseVisibility(connectionId);
  return queryTreeSession(connectionId)?.visibleSchemasByDatabase.get(database) || readVisibleSchemas(connectionId, database);
}
function queryTargetLocked(tab = activeTab()) {
  return !tab || Boolean(tab.structureOnly || (tab.browse && tab.tableView !== false) || tab.redisKey || tab.console || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction ||
    tab.refreshing || cellWritePending(tab) || (!tab.awaitingSchema && state.transactionKeys.has(queryTargetKey(tab))));
}
function queryTargetDescription(tab = activeTab(), { showVisibility = false } = {}) {
  const profile = state.profiles.find((item) => item.id === tab?.connectionId);
  const data = queryTargetData(tab);
  const database = tabDatabase(tab) || data?.context?.database || "未选择数据库";
  const fixedSchema = tabSchema(tab);
  const searchPath = data?.context?.searchPath || [];
  const schema = fixedSchema || searchPath.join(" → ") || "无默认 schema";
  const postgres = !profile?.driver || profile.driver === "postgres";
  const visibleDatabases = showVisibility && tab?.connectionId && postgres ? queryDatabaseVisibility(tab.connectionId) : null;
  const databaseHidden = !tab?.awaitingDatabase && visibleDatabases && !visibleDatabases.has(database);
  const location = `${profile?.name || (tab?.connectionId ? "原连接不可用" : "未选择连接")} / ${database}${databaseHidden ? "（数据库已隐藏）" : ""}`;
  if (postgres && tab?.awaitingDatabase) return location;
  if (postgres && tab?.awaitingSchema) return `${location} / 未选择 Schema`;
  const visible = showVisibility && tab && postgres ? queryNamespaceVisibility(tab, database) : null;
  const hidden = visible && (fixedSchema ? !visible.has(fixedSchema) : searchPath.some(name => !visible.has(name)));
  return `${location}${postgres ? ` / ${schema}${fixedSchema ? "" : "（默认搜索路径）"}${hidden ? " · 含已隐藏 Schema" : ""}` : ""}`;
}
function visibleQueryNamespaces(catalog, visible) {
  return catalog.map(item => item.name).filter(name => !visible || visible.has(name));
}
function queryDatabaseOptions(connectionId) {
  const tree = queryTreeSession(connectionId);
  if (tree?.databasesLoaded) return visibleQueryNamespaces(tree.databases, tree.visibleDatabases);
  const catalog = state.queryDatabaseLists.get(connectionId)?.databases;
  if (!catalog) return null;
  const visible = visibleQueryNamespaces(catalog, readVisibleDatabases(connectionId));
  return visible.length ? visible : catalog.map(item => item.name);
}
function prepareInitialQuerySchema(tab) {
  if (tab.schema) return;
  tab.awaitingSchema = true;
  tab.chooseInitialSchema = true;
  const target = queryTargetData(tab);
  if (target && !target.pending) initializeQuerySchema(tab, target);
}
function bindNewQueryDatabase(tab, database) {
  tab.database = database;
  tab.schema = null;
  tab.awaitingDatabase = false;
  tab.chooseInitialDatabase = false;
  prepareInitialQuerySchema(tab);
}
function resolveInitialQueryDatabases(profile, visible) {
  const database = visible.length === 1 ? visible[0] : null;
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.connectionId !== profile.id || !tab.chooseInitialDatabase) continue;
    tab.chooseInitialDatabase = false;
    if (!database) continue;
    bindNewQueryDatabase(tab, database);
    changed = true;
  }
  if (changed) persistTabs();
}
async function loadQueryDatabaseList(profile, retry = false) {
  const { id } = profile;
  const cached = state.queryDatabaseLists.get(id);
  if (cached && (cached.loading || !retry)) return;
  const entry = { loading: true };
  state.queryDatabaseLists.set(id, entry);
  try {
    entry.databases = (await call("list_databases", { connectionId: id })).filter(database => database.allowConnections !== false);
  } catch (error) {
    entry.error = errorText(error);
  }
  if (state.queryDatabaseLists.get(id) !== entry) return;
  entry.loading = false;
  const visible = queryDatabaseOptions(id);
  if (visible) resolveInitialQueryDatabases(profile, visible);
  renderTabs();
}
function initializeQuerySchema(tab, data) {
  if (data.catalogError) return false;
  tab.chooseInitialSchema = false;
  const visible = queryNamespaceVisibility(tab, tabDatabase(tab) || data.context?.database);
  const schemas = visibleQueryNamespaces(data.catalog, visible);
  if (schemas.length !== 1) return false;
  tab.schema = schemas[0];
  tab.awaitingSchema = false;
  return true;
}
async function loadQueryTarget(tab = activeTab(), force = false) {
  if (!tab?.connectionId || tab.awaitingDatabase || driverForTab(tab) === "redis") return null;
  const key = queryTargetKey(tab);
  const cached = state.queryTargets.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && !force) return cached;
  const entry = {
    loading: !cached, error: cached?.error, context: cached?.context,
    catalog: cached?.catalog || [], catalogError: cached?.catalogError,
  };
  state.queryTargets.set(key, entry);
  const args = { connectionId: tab.connectionId, database: tabDatabase(tab) || null };
  const mysql = driverForTab(tab) === "mysql";
  entry.pending = (async () => {
    const results = await Promise.allSettled([
      call("get_query_context", args),
      mysql ? call("list_databases", { connectionId: args.connectionId }) : call("list_schemas", args),
    ]);
    if (state.queryTargets.get(key) !== entry) return entry;
    const [context, catalog] = results;
    if (context.status === "fulfilled") {
      entry.context = context.value;
      entry.error = null;
    }
    else entry.error = errorText(context.reason);
    if (catalog.status === "fulfilled") {
      entry.catalog = catalog.value;
      entry.catalogError = null;
    }
    else entry.catalogError = errorText(catalog.reason);
    entry.loading = false;
    entry.pending = null;
    let initialized = false;
    for (const candidate of state.tabs) {
      if (candidate.chooseInitialSchema && queryTargetKey(candidate) === key) {
        initialized = initializeQuerySchema(candidate, entry) || initialized;
      }
    }
    if (initialized) persistTabs();
    renderTabs();
    return entry;
  })();
  return entry.pending;
}
function postgresMenuDatabase(tab) {
  const navigation = state.queryTargetNavigation;
  if (navigation?.tabId === tab.id) return navigation.database;
  const database = tabDatabase(tab);
  const visible = queryDatabaseVisibility(tab.connectionId);
  return database && (!visible || visible.has(database)) ? database : null;
}
function selectPostgresMenuDatabase(tab, database) {
  if (activeTab() !== tab || queryTargetLocked(tab) || !queryDatabaseOptions(tab.connectionId)?.includes(database)) return;
  if (tab.awaitingDatabase || (tab.awaitingSchema && database !== tabDatabase(tab))) {
    bindNewQueryDatabase(tab, database);
    persistTabs();
    renderTabs();
  } else {
    state.queryTargetNavigation = { tabId: tab.id, database };
    renderQueryTarget(tab);
  }
}
function renderPostgresQueryTarget(tab, profile) {
  const database = tabDatabase(tab);
  const schema = tabSchema(tab);
  const visibleDatabases = queryDatabaseVisibility(profile.id);
  const hiddenDatabase = database && visibleDatabases && !visibleDatabases.has(database);
  const visibleSchemas = queryNamespaceVisibility(tab, database);
  const hiddenSchema = schema && visibleSchemas && !visibleSchemas.has(schema);
  const menuDatabase = postgresMenuDatabase(tab);
  if (database && !queryTargetData(tab)) void loadQueryTarget(tab);
  const menuTarget = menuDatabase ? { connectionId: profile.id, database: menuDatabase } : null;
  if (menuTarget && !queryTargetData(menuTarget)) void loadQueryTarget(menuTarget);
  const target = menuTarget ? queryTargetData(menuTarget) : null;
  const databases = menuDatabase ? null : queryDatabaseOptions(profile.id);
  if (!menuDatabase && !databases && !state.queryDatabaseLists.has(profile.id)) void loadQueryDatabaseList(profile);
  const databaseList = state.queryDatabaseLists.get(profile.id);
  const names = menuDatabase
    ? visibleQueryNamespaces(target?.catalog || [], queryNamespaceVisibility(tab, menuDatabase))
    : databases || [];
  const label = !database || hiddenDatabase
    ? "选择数据库"
    : `${database} / ${schema && !hiddenSchema ? schema : tab.awaitingSchema || hiddenSchema ? "选择 Schema" : "默认路径"}`;
  const currentSchema = menuDatabase === database ? schema : null;
  querySchemaSelect.update({
    contextKey: tab.id, level: menuDatabase, hidden: false, disabled: queryTargetLocked(tab),
    refreshing: menuDatabase ? Boolean(target?.pending) : !databases && databaseList?.loading,
    noun: menuDatabase ? "Schema" : "数据库",
    value: currentSchema, selectedValue: menuDatabase ? currentSchema : database,
    label, ariaLabel: `查询目标：${label}`,
    options: names.map(name => ({ value: name, label: name })),
    navigate: menuDatabase ? null : name => selectPostgresMenuDatabase(tab, name),
    selectOption: menuDatabase ? name => changeQueryTarget(name, menuDatabase) : null,
  });
  refs.querySchemaPath.hidden = !menuDatabase;
  refs.querySchemaDatabase.textContent = menuDatabase || "";
  refs.querySchemaDatabase.title = menuDatabase || "";
  refs.queryTargetContext.hidden = true;
  const iconKind = !database || hiddenDatabase ? "database" : "schema";
  if (refs.queryTargetIcon.dataset.kind !== iconKind) {
    refs.queryTargetIcon.dataset.kind = iconKind;
    refs.queryTargetIcon.innerHTML = iconKind === "database" ? databaseIcon : schemaIcon;
  }
  const detail = queryTargetDescription(tab, { showVisibility: true });
  refs.querySchema.title = refs.queryTargetBar.title = refs.editorHint.title = refs.tableToolbarTitle.title = detail;
  const error = menuDatabase ? target?.catalogError || target?.error : !databases && databaseList?.error;
  refs.queryTargetDetail.textContent = error ? `读取${menuDatabase ? " Schema" : "数据库"}失败：${error} · 重新打开下拉列表重试` : "";
  refs.queryTargetDetail.hidden = !error;
  refs.queryTargetDetail.dataset.error = String(Boolean(error));
}
function renderQueryTarget(tab = activeExecutionTab()) {
  refs.queryTargetBar.hidden = !tab || Boolean(tab.console);
  refs.queryTargetDetail.hidden = true;
  if (!tab) {
    refs.querySchemaPath.hidden = true;
    querySchemaSelect.update({ contextKey: null, hidden: true, disabled: true, options: [], value: "", label: "Schema" });
    return;
  }
  const profile = state.profiles.find(item => item.id === tab.connectionId);
  refs.queryTargetBar.dataset.driver = profile ? profile.driver || "postgres" : "";
  if (profile && (profile.driver || "postgres") === "postgres") {
    renderPostgresQueryTarget(tab, profile);
    return;
  }
  refs.querySchemaPath.hidden = true;
  const isMysql = profile?.driver === "mysql";
  if (isMysql && !queryTargetData(tab)) void loadQueryTarget(tab);
  const data = queryTargetData(tab);
  const database = tabDatabase(tab) || data?.context?.database || "";
  const tree = queryTreeSession(tab.connectionId);
  const visible = tree?.databasesLoaded && !tree.databaseVisibilityCustomized ? null : queryDatabaseVisibility(tab.connectionId);
  const catalog = visibleQueryNamespaces((data?.catalog || []).filter(item => item.allowConnections !== false), visible);
  const databases = [...new Set([database, ...catalog].filter(Boolean))];
  querySchemaSelect.update({
    contextKey: `${tab.id}:${queryTargetKey(tab)}`, hidden: !isMysql,
    disabled: queryTargetLocked(tab) || Boolean(data?.loading),
    refreshing: Boolean(data?.pending && !data.loading),
    noun: "数据库", value: database, label: database || "选择数据库",
    options: databases.map(name => ({
      value: name, label: name, detail: visible && !visible.has(name) ? "当前数据库已在对象树中隐藏" : "",
    })),
  });
  if (isMysql && refs.queryTargetIcon.dataset.kind !== "database") {
    refs.queryTargetIcon.dataset.kind = "database";
    refs.queryTargetIcon.innerHTML = databaseIcon;
  }
  const source = profile ? `${profile.name} / ${isMysql ? database || "未选择数据库" : `DB ${redisTabDatabase(tab)}`}` : "请先从左侧选择连接";
  const endpoint = profile ? `${profile.host}:${profile.port}${profile.user ? ` · ${profile.user}` : ""}` : "";
  const scope = isMysql ? "所选数据库用于解析未限定的表名，可用 数据库.表名 访问同一连接上的其他数据库。" : "";
  const detail = [source, endpoint, scope].filter(Boolean).join("\n");
  refs.querySchema.title = refs.queryTargetBar.title = refs.editorHint.title = refs.tableToolbarTitle.title = detail;
  refs.queryTargetContext.hidden = isMysql;
  refs.queryTargetContext.textContent = profile ? `DB ${redisTabDatabase(tab)}` : "未绑定连接";
  refs.queryTargetContext.title = detail;
  refs.queryTargetDetail.textContent = !profile ? tab.connectionId ? "原连接已不可用。SQL 草稿已保留，可复制到新建查询中继续。" : "从左侧选择连接，或在 Schema 上右键新建查询。"
    : data?.error ? `无法确认执行位置：${data.error} · 重新打开下拉列表重试`
    : data?.catalogError ? `数据库列表读取失败：${data.catalogError} · 重新打开下拉列表重试` : "";
  refs.queryTargetDetail.hidden = !refs.queryTargetDetail.textContent || Boolean(tab.console);
  refs.queryTargetDetail.dataset.error = String(Boolean(data?.error || data?.catalogError));
}
async function changeQueryTarget(value, database = null) {
  const tab = activeTab();
  const driver = driverForTab(tab);
  if (queryTargetLocked(tab) || !["postgres", "mysql"].includes(driver)) return renderQueryTarget(tab);
  const drafts = cellDraftsForTabs([tab]);
  if (drafts.length) {
    if (hasSavingCellDrafts(drafts)) return;
    tab.confirming = true;
    renderTabs();
    let accepted;
    try {
      accepted = await confirmAction("切换执行位置会放弃当前结果中尚未保存的单元格修改。", {
        title: "切换执行位置？", acceptLabel: "放弃并切换",
      });
    } catch (error) {
      showToast(errorText(error), "error");
    } finally {
      tab.confirming = false;
      renderTabs();
    }
    if (!accepted || activeTab() !== tab || queryTargetLocked(tab) || !discardCellDrafts(drafts)) return;
  }
  if (driver === "postgres") {
    const visibleDatabases = queryDatabaseVisibility(tab.connectionId);
    const target = queryTargetData({ connectionId: tab.connectionId, database });
    const schemas = visibleQueryNamespaces(target?.catalog || [], queryNamespaceVisibility(tab, database));
    if (!database || (visibleDatabases && !visibleDatabases.has(database)) || !schemas.includes(value)) return renderQueryTarget(tab);
    tab.database = database;
  }
  if (driver === "mysql") tab.database = value;
  tab.chooseInitialSchema = false;
  tab.awaitingSchema = false;
  tab.schema = driver === "postgres" ? value || null : null;
  tab.browse = null;
  tab.openedObject = null;
  tab.openedObjectView = null;
  tab.tableView = false;
  // Previous results belong to their old destination and must not be edited
  // or mistaken for results from the newly selected database.
  tab.result = emptyResult();
  tab.structure = null;
  tab.executionSummary = null;
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
function showToast(message, type = "info", duration = type === "error" ? 7000 : Math.min(5000, 2200 + String(message).length * 60)) {
  refs.toast.textContent = message;
  refs.toast.title = message;
  refs.toast.dataset.type = type;
  refs.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(
    () => { refs.toast.classList.remove("visible"); refs.toast.title = ""; },
    duration,
  );
}
async function copyText(text, { allowEmpty = false } = {}) {
  const value = String(text ?? "");
  if (!value && !allowEmpty) throw new Error("复制内容为空");
  await writeClipboardText(value, { invoke });
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
    const key = visibleDatabaseStorageKey(connectionId);
    if (state.databaseVisibilityCustomized) localStorage.setItem(key, JSON.stringify([...state.visibleDatabases]));
    else localStorage.removeItem(key);
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
  if (!invoke) throw new Error("请使用 Tauri 启动 Keybay");
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
  profiles: [],
  activeConnectionId: null,
  connectionStatuses: {},
  connectionErrors: {},
  disconnectingConnections: new Set(),
  treeSessions: new Map(),
  transactionKeys: new Set(),
  queryTargets: new Map(),
  queryDatabaseLists: new Map(),
  queryTargetNavigation: null,
  redisDatabases: [],
  redisDatabaseError: null,
  redisExpanded: new Set(),
  redisActiveDatabase: 0,
  redisPages: new Map(),
  redisScanGenerations: new Map(),
  redisSearches: new Map(),
  redisSearchTimer: null,
  redisSearchScope: 'db',
  redisGlobalSearch: '',
  redisLocalExpanded: null,
  redisSearchEpoch: 0,
  redisRequest: 0,
  databases: [],
  databasesLoaded: false,
  visibleDatabases: new Set(),
  databaseVisibilityCustomized: false,
  systemDatabasesExpanded: false,
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
function completionConfig(tab, explicitNamespaces, additionalObjects) {
  const driver = driverForTab(tab);
  const target = queryTargetData(tab);
  const database = tabDatabase(tab) || target?.context?.database;
  const catalog = target?.objects || (tab?.connectionId === state.activeConnectionId ? [...state.objectsBySchema.values()].flat() : []);
  const defaultSchema = driver === "mysql" ? database : tabSchema(tab) || (tab.awaitingSchema ? undefined : target?.context?.defaultSchema);
  const visibleNamespaces = queryNamespaceVisibility(tab, database);
  const usableNamespace = name => !visibleNamespaces || visibleNamespaces.has(name) ||
    name === defaultSchema || explicitNamespaces.includes(name);
  const schema = buildCompletionSchema(
    [...catalog, ...additionalObjects].filter(object => usableNamespace(object.schema)),
    database, driver, target.catalog.map(({ name }) => name).filter(usableNamespace),
  );
  return { schema,
    defaultSchema, visibleNamespaces, driver,
    dialect: driver === "mysql" ? MySQL : PostgreSQL };
}

async function loadQueryCatalog(tab) {
  const data = await loadQueryTarget(tab);
  if (!data?.context) return data;
  if (!data.objects) {
    data.objectRequest ||= (async () => {
      const database = tabDatabase(tab) || data.context.database;
      const schemas = driverForTab(tab) === "mysql" ? (database ? [{ name: database }] : []) : data.catalog;
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
  if (!context.state.doc.toString().trim()) return null;
  if (/Comment|String/.test(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  const tab = activeTab();
  if (!tab?.connectionId || driverForTab(tab) === "redis") return null;
  const key = queryTargetKey(tab);
  const schema = tabSchema(tab);
  const data = await loadQueryCatalog(tab);
  const current = () => !context.aborted && activeTab() === tab && queryTargetKey(tab) === key &&
    tabSchema(tab) === schema && queryTargetData(tab) === data;
  if (!data?.context || !current()) return null;
  const driver = driverForTab(tab);
  const explicitNamespaces = sqlCompletionNamespaces(context, driver);
  let additionalObjects = [];
  if (driver === "mysql") {
    const selectedDatabase = tabDatabase(tab) || data.context.database;
    const databases = explicitNamespaces.filter(name =>
      name !== selectedDatabase && data.catalog.some(item => item.name === name));
    data.mysqlCompletionObjects ??= new Map();
    additionalObjects = (await Promise.all(databases.map(database => {
      if (!data.mysqlCompletionObjects.has(database)) {
        const pending = call("get_schema_objects", { connectionId: tab.connectionId, database, schemaName: database })
          .then(objects => objects.map(object => ({ ...object, database })))
          .catch(() => {
            data.mysqlCompletionObjects.delete(database);
            return [];
          });
        data.mysqlCompletionObjects.set(database, pending);
      }
      return data.mysqlCompletionObjects.get(database);
    }))).flat();
  }
  return current() ? catalogCompletionSource(completionConfig(tab, explicitNamespaces, additionalObjects))(context) : null;
}
function makeEditorState(tab) {
  return EditorState.create({
    doc: tab.sql,
    extensions: [
      EditorView.contentAttributes.of({ "aria-label": "SQL 查询编辑器" }),
      failedStatementMark,
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
          if (!currentTab.sql.trim()) queueMicrotask(() => {
            if (!update.view.state.doc.toString().trim()) closeCompletion(update.view);
          });
          currentTab.editorState = update.state;
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
  const completeKeywords = keywordCompletionSource(dialect, true, sqlKeywordCompletion);
  return [dialect.language,
    dialect.language.data.of({ autocomplete: completeCatalog }),
    dialect.language.data.of({ autocomplete: context => context.state.doc.toString().trim() ? completeKeywords(context) : null })];
}
function updateCursor(editorState = state.editor?.state) {
  if (!editorState) return;
  const { head, from, to } = editorState.selection.main;
  const line = editorState.doc.lineAt(head);
  const selection = editorState.sliceDoc(from, to);
  const lineCount = editorState.doc.lineAt(Math.max(from, to - 1)).number - editorState.doc.lineAt(from).number + 1;
  refs.cursorPosition.textContent = `Ln ${line.number}, Col ${head - line.from + 1}` +
    (selection ? ` · 已选 ${selection.length} 字符${lineCount > 1 ? ` / ${lineCount} 行` : ""}` : "");
  updateRunButton(activeExecutionTab(), Boolean(selection.trim()));
  refs.runQuery.title = selection.trim() ? "仅执行选中的 SQL（⌘ Enter）" : "执行编辑器中的全部 SQL（⌘ Enter）";
}
function updateRunButton(tab, selected = Boolean(state.editor?.state.sliceDoc(state.editor.state.selection.main.from, state.editor.state.selection.main.to).trim())) {
  refs.runQuery.setAttribute("aria-busy", String(Boolean(tab?.running)));
  refs.runLabel.textContent = tab?.running ? "执行中…" : selected ? "执行选中" : "执行";
}
function schedulePersistTabs() {
  clearTimeout(state.persistTimer);
  draftPersistence.pending();
  state.persistTimer = setTimeout(persistTabs, 350);
}
function setEditorValue(sqlText) {
  state.editor?.dispatch({
    changes: { from: 0, to: state.editor.state.doc.length, insert: sqlText },
  });
}

const connectionGroups = createConnectionGroups({
  list: refs.connectionList, button: refs.manageConnectionGroups,
  getProfiles: () => state.profiles, onChange: () => renderConnections(),
  onError: error => showToast(`分组保存失败：${errorText(error)}`, 'error'),
});
function renderConnections() {
  const query = refs.connectionSearch.value;
  const profiles = state.profiles.filter(profile => matchesWorkspaceSearch(query, profile.name, profile.driver, profile.host, profile.database, profile.port, connectionGroups.nameFor(profile.id)));
  refs.connectionCount.textContent = query.trim() ? `${profiles.length}/${state.profiles.length}` : String(state.profiles.length);
  refs.connectionSearch.disabled = !state.profiles.length;
  refs.connectionList.innerHTML = !state.profiles.length
    ? '<div class="small-empty">将数据库连接到你的工作区<br/><button class="secondary-btn" id="emptyNewConnection">＋ 新建连接</button></div>'
    : !profiles.length
      ? '<div class="small-empty">没有找到匹配的连接<br/><button data-clear-connection-search>清除搜索</button></div>'
      : connectionGroups.render(profiles, (profile) => {
        const status = state.connectionStatuses[profile.id] || "idle";
        const driver = profile.driver === "redis" ? "Redis" : profile.driver === "mysql" ? "MySQL" : "PostgreSQL";
        const statusLabel = { connected: "已连接", connecting: "连接中", error: "连接失败", idle: "未连接" }[status];
        const toggleLabel = status === "connected" ? "断开连接" : status === "connecting" ? "连接中" : "连接";
        const toggleIcon = connectionStateIcon;
        const description = `${driver} · ${profile.host}:${profile.port}${profile.database ? ` / ${profile.database}` : ""}`;
        return `<div class="connection-card ${profile.id === state.activeConnectionId ? "selected" : ""}" data-driver="${escapeHtml(profile.driver || "postgres")}" data-connection-card="${escapeHtml(profile.id)}"><button class="connection-select" data-connection-id="${escapeHtml(profile.id)}" title="${escapeHtml(description)} · 拖动排序；Alt+↑/↓ 移动" aria-label="${escapeHtml(profile.name)}，${driver}，${statusLabel}" ${profile.id === state.activeConnectionId ? 'aria-current="true"' : ''}><span class="connection-icon connection-driver-icon">${driverIcon(profile.driver)}</span><span class="connection-copy"><strong>${escapeHtml(profile.name)}</strong><small><span class="connection-state-label" data-status="${status}">${statusLabel}</span> · ${driver}</small></span></button><button class="icon-btn connection-toggle" data-connection-toggle="${escapeHtml(profile.id)}" data-status="${status}" title="${toggleLabel}" aria-label="${toggleLabel}：${escapeHtml(profile.name)}" aria-pressed="${status === "connected"}" ${status === "connecting" ? "disabled" : ""}>${toggleIcon}</button><button class="icon-btn connection-edit" data-edit-id="${escapeHtml(profile.id)}" title="编辑连接" aria-label="编辑连接：${escapeHtml(profile.name)}">•••</button></div>`;
      }, query);
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
    ? `浏览实例：${active.name} · ${activeDriverLabel}`
    : "数据库工作区";
  refs.headerContext.title = refs.headerContext.textContent;
  const host = active?.host ?? "";
  refs.serverInfo.textContent = host;
  refs.serverInfo.title = host;
  refs.disconnectConnection.disabled =
    state.connectionStatuses[state.activeConnectionId] !== "connected";
  if (refs.workspaceStats) refs.workspaceStats.textContent = active ? activeDriverLabel : "本地工作区";
  if (refs.editorHint && !activeTab()) refs.editorHint.textContent = active?.driver === "redis"
    ? "Redis 命令 · 只读锁定后仅允许安全读取命令"
    : active?.driver === "mysql"
      ? "MySQL · 选中 SQL 可单独执行"
      : "PostgreSQL · 选中 SQL 可单独执行";
  if (refs.collapseTree) {
    refs.collapseTree.hidden = false;
    const label = active?.driver === "redis" ? "收起所有 Redis 数据库" : "收起所有数据库和 Schema";
    refs.collapseTree.title = label;
    refs.collapseTree.setAttribute("aria-label", label);
  }
  if (refs.refreshSchema) {
    const label = active?.driver === "redis" ? "刷新 Redis 数据库和 Key" : "刷新数据库对象";
    refs.refreshSchema.title = label;
    refs.refreshSchema.setAttribute("aria-label", label);
  }
  if (refs.objectSearch) {
    const label = active?.driver === "redis" ? "搜索 Redis key" : active?.driver === "mysql" ? "搜索数据库或对象" : "搜索数据库、Schema 或对象";
    refs.objectSearch.placeholder = `${label}…`;
    refs.objectSearch.setAttribute("aria-label", label);
    refs.objectSearch.title = active?.driver === "redis" ? "" : "展开数据库后可搜索库内对象";
    refs.redisSearchDatabase.hidden = active?.driver !== 'redis';
    refs.objectSearch.disabled = active?.driver === 'redis' && state.connectionStatuses[state.activeConnectionId] !== 'connected';
    if (active?.driver === 'redis') syncRedisSearchScope();
  }
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
    state.profiles = orderConnections(await call("list_connections"), readConnectionOrder());
    // Missing profiles must never delete restored SQL drafts. Their original
    // binding stays visible and runQuery refuses to execute until it exists.
    renderConnections();
    renderTabs();
    renderHistory();
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
  "databases", "databasesLoaded", "visibleDatabases", "databaseVisibilityCustomized", "systemDatabasesExpanded",
  "visibleSchemasByDatabase", "expandedDatabases",
  "schemasByDatabase", "objectsBySchema", "expandedSchemas", "schemaErrors",
  "expandedCategories", "selectedObject", "selectedTreeKey",
  "redisDatabases", "redisDatabaseError", "redisExpanded", "redisActiveDatabase", "redisSearches", "redisSearchScope", "redisGlobalSearch", "redisLocalExpanded",
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
    if (state.redisSearchScope === 'all' && pendingRedis.length) await searchAllRedisDatabases(profile.id, redisRequest);
    else await Promise.all([...state.redisExpanded].filter((database) => pendingRedis.includes(database) || !state.redisPages.get(database)?.loaded)
      .map((database) => loadRedisKeys(database, 0, redisPatternFor(database), profile.id, redisRequest)));
  } else if (profile.driver === "mysql") {
    await Promise.all([...state.expandedDatabases].filter(database => databaseTreeExpanded(database, profile.driver)).map(database => {
      state.schemasByDatabase.set(database, [{ name: database }]);
      state.visibleSchemasByDatabase.set(database, new Set([database]));
      return loadSchemaObjects(database, database);
    }));
  } else {
    await Promise.all([...state.expandedDatabases].filter(database => databaseTreeExpanded(database, profile.driver) && !state.schemasByDatabase.has(database))
      .map((database) => loadSchemas(database, profile.id, request)));
    if (!current()) return false;
    await Promise.all([...state.expandedSchemas].filter(key => databaseTreeExpanded(key.split("\u0000")[0], profile.driver) && !state.objectsBySchema.has(key))
      .map((key) => loadSchemaObjects(...key.split("\u0000"))));
  }
  if (current()) refs.objectTree.scrollTop = session.scrollTop;
  return current();
}
async function selectConnection(id) {
  if (state.disconnectingConnections.has(id)) { showToast('连接正在断开，请稍后重试'); return false; }
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
  if (session && (profile.driver === "redis" ? session.redisDatabases.length : session.databasesLoaded))
    return restoreTreeSession(session, profile, request, redisRequest);
  state.selectedTreeKey = treeTargetKey({ type: "root", connectionId: id });
  state.expandedCategories.clear();
  state.connectionStatuses[id] = connected ? "connected" : "connecting";
  state.databases = [];
  state.databasesLoaded = false;
  state.databaseVisibilityCustomized = false;
  state.systemDatabasesExpanded = false;
  state.redisDatabases = [];
  state.redisDatabaseError = null;
  state.redisExpanded = new Set();
  state.redisActiveDatabase = redisProfileDatabase(profile);
  state.redisPages.clear();
  state.redisScanGenerations.clear();
  state.redisSearches.clear();
  state.redisSearchScope = 'db'; state.redisGlobalSearch = ''; state.redisLocalExpanded = null; state.redisSearchEpoch++;
  refs.objectSearch.value = "";
  refs.objectSelection.textContent = driverForConnection(state.activeConnectionId) === "mysql" ? "展开数据库，浏览表和视图" : "展开数据库和 schema，浏览对象";
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
            keyCount: database.keyCount != null && Number.isFinite(Number(database.keyCount)) ? Number(database.keyCount) : null,
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
    state.databases = databases.filter(database => database.allowConnections !== false);
    state.databasesLoaded = true;
    const saved = readVisibleDatabases(id);
    const available = state.databases.map(database => database.name);
    const customized = available.filter(name => saved?.has(name));
    state.databaseVisibilityCustomized = customized.length > 0 && customized.length < available.length;
    state.visibleDatabases = new Set(state.databaseVisibilityCustomized ? customized : available);
    if (profile.driver !== "mysql") resolveInitialQueryDatabases(profile, [...state.visibleDatabases]);
    renderTree();
    renderTabs();
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
              `<label class="database-option"><input type="checkbox" value="${escapeHtml(database.name)}" ${visible.has(database.name) ? "checked" : ""}/><span class="database-option-icon">${databaseIcon}</span><span>${escapeHtml(database.name)}</span>${database.current ? '<small>默认</small>' : ""}</label>`,
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
  if (visible.size) refs.databasePickerError.textContent = "";
}
function openDatabasePicker() {
  if (!state.databases.length) return;
  state.databasePickerDraft = new Set(state.visibleDatabases);
  refs.databasePickerError.textContent = "";
  renderDatabasePicker();
  refs.databaseModal?.showModal();
  refs.databaseSearch?.focus({ preventScroll: true });
}
function applyDatabasePicker() {
  const draft = state.databasePickerDraft || state.visibleDatabases;
  const selected = new Set(
    [...draft].filter((name) => state.databases.some((database) => database.name === name)),
  );
  if (!selected.size) {
    refs.databasePickerError.textContent = "至少选择一个要显示的数据库";
    return;
  }
  state.visibleDatabases = selected;
  state.databaseVisibilityCustomized = selected.size < state.databases.length;
  state.databasePickerDraft = null;
  persistVisibleDatabases(state.activeConnectionId);
  refs.databaseModal.close();
  if (state.editor) closeCompletion(state.editor);
  renderTree();
  renderTabs();
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
  if (visible.size) refs.schemaPickerError.textContent = "";
}
function openSchemaPicker(database) {
  if (driverForConnection(state.activeConnectionId) === "mysql") return;
  const schemas = state.schemasByDatabase.get(database) || [];
  if (!schemas.length) return;
  state.schemaPickerDatabase = database;
  state.schemaPickerDraft = new Set(
    state.visibleSchemasByDatabase.get(database) || schemas.map((schema) => schema.name),
  );
  if (refs.schemaSearch) refs.schemaSearch.value = "";
  refs.schemaPickerError.textContent = "";
  renderSchemaPicker();
  refs.schemaModal?.showModal();
  refs.schemaSearch?.focus({ preventScroll: true });
}
async function applySchemaPicker() {
  const database = state.schemaPickerDatabase;
  const schemas = state.schemasByDatabase.get(database) || [];
  const draft = state.schemaPickerDraft || state.visibleSchemasByDatabase.get(database) || new Set();
  const selected = new Set(
    [...draft].filter((name) => schemas.some((schema) => schema.name === name)),
  );
  if (!selected.size) {
    refs.schemaPickerError.textContent = "至少选择一个要显示的 Schema";
    return;
  }
  state.visibleSchemasByDatabase.set(database, selected);
  persistVisibleSchemas(state.activeConnectionId, database, selected);
  state.schemaPickerDraft = null;
  state.schemaPickerDatabase = null;
  refs.schemaModal?.close();
  if (state.editor) closeCompletion(state.editor);
  renderTabs();
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
    refs.objectSelection.textContent = driverForConnection(state.activeConnectionId) === "mysql" ? "展开数据库，浏览表和视图" : "展开数据库和 schema，浏览对象";
  }
  updateEditorSchema();
  renderTree();
}
async function disconnectConnection(connectionId = state.activeConnectionId) {
  if (!connectionId) return;
  if (state.disconnectingConnections.has(connectionId)) return;
  if (anyQueryRunning()) {
    showToast("有查询正在执行，请先停止后再断开连接", "error");
    return;
  }
  const id = connectionId;
  const isActive = state.activeConnectionId === id;
  const profile = state.profiles.find((item) => item.id === id);
  const transactions = [...state.transactionKeys].filter(key => key.startsWith(`${id}\0`));
  if (state.tabs.some(tab => tab.connectionId === id && (tab.cellSaving || tab.cellBatchSaving || tab.changingTransaction))) {
    showToast('当前连接有保存或事务操作正在执行，请完成后再断开', 'error'); return;
  }
  if (transactions.length) {
    if (!await confirmAction(`断开「${profile?.name || id}」会回滚以下数据库中尚未提交的修改：\n${transactions.map(key => key.slice(id.length + 1) || '默认数据库').join('、')}\n\n本地尚未保存的单元格草稿会保留。`, { title: '断开并回滚事务？', acceptLabel: '断开并回滚' })) return;
    const current = [...state.transactionKeys].filter(key => key.startsWith(`${id}\0`));
    if (anyQueryRunning() || state.tabs.some(tab => tab.connectionId === id && (tab.cellSaving || tab.cellBatchSaving || tab.changingTransaction)) || current.length !== transactions.length || current.some(key => !transactions.includes(key))) {
      showToast('当前操作或事务状态已改变，请重新确认断开', 'error'); return;
    }
  }
  state.disconnectingConnections.add(id);
  renderTabs();
  renderOutput();
  if (isActive) {
    ++state.schemaRequest;
    ++state.redisRequest;
    state.objectRequests.clear();
  }
  try {
    await call("disconnect_connection", { connectionId: id });
    state.connectionStatuses[id] = "idle";
    state.treeSessions.delete(id);
    for (const key of transactions) invalidateTransactionResults(id, key.slice(id.length + 1));
    clearTransactionKeys(id);
    renderTabs();
    renderOutput();
    if (state.redisConsole?.connectionId === id) closeRedisConsole();
    if (state.activeConnectionId !== id) {
      renderConnections();
      showToast(`已断开${profile ? `「${profile.name}」` : "连接"}`);
      return;
    }
    state.databases = [];
    state.databasesLoaded = false;
    state.systemDatabasesExpanded = false;
    state.redisDatabases = [];
    state.redisDatabaseError = null;
    state.redisExpanded.clear();
    state.redisPages.clear();
    state.redisScanGenerations.clear();
    state.redisSearches.clear();
    state.redisSearchScope = 'db'; state.redisGlobalSearch = ''; state.redisLocalExpanded = null; state.redisSearchEpoch++;
    state.visibleDatabases.clear();
    state.visibleSchemasByDatabase.clear();
    state.expandedDatabases.clear();
    state.expandedSchemas.clear();
    state.selectedObject = null;
    state.selectedTreeKey = null;
    refs.objectSelection.textContent = driverForConnection(state.activeConnectionId) === "mysql" ? "展开数据库，浏览表和视图" : "展开数据库和 schema，浏览对象";
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
  } finally {
    state.disconnectingConnections.delete(id);
    renderTabs();
    renderOutput();
  }
}

function objectDataAction(object) {
  if (!["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(object.kind)) return "";
  const action = ["table", "partitioned_table"].includes(object.kind) ? "查看表数据" : "查看数据";
  const label = `${action}：${object.qualifiedName || `${object.schema}.${object.name}`}`;
  return `<button class="object-open" type="button" title="${action}" aria-label="${escapeHtml(label)}"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="14" height="14" rx="1"/><path d="M3 9h14M8 9v9"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="m20 20 2 2"/></svg></button>`;
}

function sqlObjectRow(object, database, query) {
  const fields = matchingColumns(object, query).map(column => column.name);
  const label = (object.signature || object.name) + (fields.length ? ` · ${fields.join(", ")}` : "");
  const title = isRoutine(object.kind) ? `${object.qualifiedName} · ${kindLabels[object.kind]}` : object.qualifiedName;
  return `<div class="tree-object" data-object-id="${escapeHtml(object.id)}" data-database="${escapeHtml(database)}" data-schema="${escapeHtml(object.schema)}" data-name="${escapeHtml(object.name)}" data-kind="${escapeHtml(object.kind)}"><span class="object-kind-icon" data-catalog-icon="${escapeHtml(object.kind)}">${kindIcons[object.kind] || "•"}</span><button class="object-main" title="${escapeHtml(title)}">${escapeHtml(label)}</button>${objectDataAction(object)}</div>`;
}
const savedTreeQueryKey = "db-studio.saved-tree-queries.v1";
function readSavedTreeQueries() {
  try {
    const entries = JSON.parse(localStorage.getItem(savedTreeQueryKey) || "[]");
    return Array.isArray(entries) ? entries.filter(entry => entry && ["id", "title", "sql", "connectionId", "database", "schema"].every(key => typeof entry[key] === "string")) : [];
  } catch { return []; }
}
let savedTreeQueries = readSavedTreeQueries();
function writeSavedTreeQueries(entries) {
  try { localStorage.setItem(savedTreeQueryKey, JSON.stringify(entries)); }
  catch (error) { showToast(`保存查询列表失败：${errorText(error)}`, "error"); return false; }
  savedTreeQueries = entries;
  syncTreeQueries();
  return true;
}
function saveTreeQuery(target) {
  const tab = activeTab();
  const schema = tab && (tabSchema(tab) || queryTargetData(tab)?.context?.defaultSchema);
  if (!tab || tab.browse || tab.structureOnly || tab.console || !tab.sql.trim() ||
      tab.connectionId !== target.connectionId || tabDatabase(tab) !== target.database ||
      (target.driver !== "mysql" && schema !== target.schema)) {
    showToast("请先在此数据库和 Schema 中打开要保存的 SQL 查询", "error");
    return;
  }
  const scope = { connectionId: target.connectionId, database: target.database, schema: target.schema };
  const current = savedTreeQueries.find(entry => entry.connectionId === scope.connectionId && entry.database === scope.database &&
    entry.schema === scope.schema && (entry.id === tab.savedTreeQueryId || entry.sql === tab.sql));
  const id = current?.id || makeId("saved-query");
  if (writeSavedTreeQueries([{ ...scope, id, title: tab.title, sql: tab.sql }, ...savedTreeQueries.filter(entry => entry.id !== id)])) {
    tab.savedTreeQueryId = id;
    const key = treeTargetKey(target);
    const heading = [...refs.objectTree.querySelectorAll('.tree-category[data-kind="query"] > .category-summary')]
      .find(row => treeTargetKey(treeTargetFromNode(row)) === key);
    if (heading) toggleTreeRow(heading, true);
    showToast("SQL 已保存到查询");
  }
}
function queryCategory(database, schema) {
  const key = JSON.stringify([database, schema, "query"]);
  return treeCategory("query", 0, state.expandedCategories.has(key), '<div class="query-tree-drafts"></div>');
}

const renderedTreeQueries = new WeakMap();
function syncTreeQueries() {
  for (const group of refs.objectTree.querySelectorAll('.tree-category[data-kind="query"]')) {
    const heading = group.querySelector('.category-summary');
    const target = treeTargetFromNode(heading);
    const entries = savedTreeQueries.filter(entry => entry.connectionId === target.connectionId && entry.database === target.database && entry.schema === target.schema);
    const count = heading.querySelector('.count');
    if (count.textContent !== String(entries.length)) count.textContent = String(entries.length);
    const list = group.querySelector('.query-tree-drafts');
    const rows = entries.map(entry => `<div class="tree-object"><span class="object-kind-icon" data-catalog-icon="query">${kindIcons.query}</span><button class="object-main" type="button" data-tree-saved-query="${escapeHtml(entry.id)}" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</button><button type="button" class="icon-btn tree-category-action" data-tree-remove-query="${escapeHtml(entry.id)}" title="删除已保存查询" aria-label="删除已保存查询">×</button></div>`).join('') || '<div class="tree-status">没有已保存的查询</div>';
    if (renderedTreeQueries.get(list) === rows) continue;
    list.innerHTML = rows;
    renderedTreeQueries.set(list, rows);
  }
}

function treeCategory(kind, count, expanded, contents) {
  const label = kindLabels[kind] || kind;
  return `<div class="tree-category${expanded ? "" : " collapsed"}" data-kind="${escapeHtml(kind)}"><div class="category-summary" tabindex="0" aria-expanded="${expanded}" aria-haspopup="menu">${treeToggle(label, expanded)}<span class="category-kind-icon" data-catalog-icon="${escapeHtml(kind)}">${kindIcons[kind] || "•"}</span><span class="tree-label">${escapeHtml(label)}</span><span class="count">${count}</span></div><div class="category-items">${contents}</div></div>`;
}
function sqlObjectCategories(database, schema, objects, query, driver, filter = query) {
  const groups = orderedObjectGroups(objects.filter(object => objectMatchesSearch(object, filter)), { driver, searching: Boolean(query) });
  if (!query) {
    const position = groups.findIndex(([kind]) => kind === (driver === 'mysql' ? 'routine' : 'sequence'));
    groups.splice(position < 0 ? groups.length : position, 0, ['query', []]);
  }
  return groups.map(([kind, items]) => {
    if (kind === 'query') return queryCategory(database, schema);
    const key = JSON.stringify([database, schema, kind]);
    const expanded = Boolean(query) || state.expandedCategories.has(key);
    const rows = items.map(object => sqlObjectRow(object, database, filter)).join("");
    const empty = `<div class="tree-status">没有可见${escapeHtml(kindLabels[kind] || kind)}</div>`;
    return treeCategory(kind, items.length, expanded, rows || empty);
  }).join("");
}
function databaseTreeExpanded(database, driver = driverForConnection(state.activeConnectionId)) {
  return state.visibleDatabases.has(database) && state.expandedDatabases.has(database) &&
    (state.systemDatabasesExpanded || !isSystemDatabase(database, driver));
}
function defaultDatabaseBadge(database) {
  return database.current ? '<small class="tree-default-database" title="默认数据库">默认</small>' : '';
}
function mysqlDatabaseTree(database, query) {
  const key = schemaKey(database.name, database.name);
  const loaded = state.objectsBySchema.has(key), objects = state.objectsBySchema.get(key) || [];
  const loading = state.objectRequests.has(key), error = state.schemaErrors.get(database.name);
  const databaseMatch = query && database.name.toLowerCase().includes(query);
  const objectMatch = query && objects.some(object => objectMatchesSearch(object, query));
  if (query && !databaseMatch && !objectMatch) return "";
  const searchExpanded = Boolean(objectMatch && !databaseMatch && !state.expandedDatabases.has(database.name));
  const open = searchExpanded || state.expandedDatabases.has(database.name);
  const parts = [`<details class="tree-database mysql-database" data-database="${escapeHtml(database.name)}"${open ? " open" : ""}${searchExpanded ? " data-search-expanded" : ""}><summary>${treeToggle(database.name, open)}<span class="database-icon">${databaseIcon}</span><span class="tree-label">${escapeHtml(database.name)}</span>${defaultDatabaseBadge(database)}<span class="count">${loaded ? objects.length : "…"}</span></summary><div class="database-children mysql-database-objects" data-object-schema="${escapeHtml(database.name)}" data-database="${escapeHtml(database.name)}">`];
  if (error) parts.push(`<div class="tree-status">${loaded ? "刷新" : "读取"}对象失败：${escapeHtml(error)}<br/><button data-retry-mysql-db="${escapeHtml(database.name)}">重试</button></div>`);
  if (loading) parts.push(`<div class="tree-status">${loaded ? "刷新" : "读取"}对象…</div>`);
  if (!loaded && !loading && !error) parts.push('<div class="tree-status">展开数据库以读取表和视图</div>');
  if (loaded) {
    const filter = databaseMatch ? "" : query;
    if (query && !objects.some(object => objectMatchesSearch(object, filter))) parts.push('<div class="tree-status">没有匹配的对象</div>');
    parts.push(sqlObjectCategories(database.name, database.name, objects, query, "mysql", filter));
  }
  parts.push('</div></details>');
  return parts.join("");
}
function postgresTreeObjects(database, schema) {
  return state.objectsBySchema.get(schemaKey(database, schema))?.filter(object => object.kind !== 'sequence');
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
    `<div class="tree-root" tabindex="0" aria-label="数据库实例"><span class="database-icon driver-tree-icon">${driverIcon(activeProfile?.driver)}</span><span class="tree-label">${driverLabel} 数据库</span><small>${state.visibleDatabases.size || "—"}</small><button class="icon-btn tree-root-action" data-display-databases title="选择显示的数据库">${moreDotsIcon}</button></div>`,
  ];
  if (!state.activeConnectionId || state.connectionStatuses[state.activeConnectionId] !== "connected") {
    chunks.push(`<div class="tree-status">连接后加载 ${driverLabel} 数据库</div>`);
    refs.objectTree.innerHTML = chunks.join("");
    applyTreeSelection();
    return;
  }
  if (!state.databasesLoaded || !state.databases.length) {
    chunks.push(state.databasesLoaded ? '<div class="tree-status">没有可访问的数据库</div>' : '<div class="tree-status">正在读取数据库列表…</div>');
    refs.objectTree.innerHTML = chunks.join("");
    applyTreeSelection();
    return;
  }
  const systemRows = [];
  let systemCount = 0;
  for (const database of state.databases) {
    if (!state.visibleDatabases.has(database.name)) continue;
    const system = isSystemDatabase(database.name, activeProfile.driver);
    const rows = system ? systemRows : chunks;
    if (activeProfile.driver === "mysql") {
      const html = mysqlDatabaseTree(database, query);
      if (html) {
        rows.push(html);
        if (system) systemCount++;
      }
      continue;
    }
    const schemas = state.schemasByDatabase.get(database.name) || [];
    const schemaLoading = state.schemaLoading.has(database.name);
    const schemaError = state.schemaErrors.get(database.name);
    const visibleSchemas = state.visibleSchemasByDatabase.get(database.name);
    const databaseMatch = query && database.name.toLowerCase().includes(query);
    const childMatch = query && schemas.some(
        (schema) =>
          (!visibleSchemas || visibleSchemas.has(schema.name)) &&
          (schema.name.toLowerCase().includes(query) ||
            postgresTreeObjects(database.name, schema.name)?.some(object => objectMatchesSearch(object, query))),
      );
    if (query && !databaseMatch && !childMatch) continue;
    if (system) systemCount++;
    const searchExpanded = Boolean(childMatch && !databaseMatch && !state.expandedDatabases.has(database.name));
    const expanded = searchExpanded || state.expandedDatabases.has(database.name);
    const schemaPicker = schemas.length ? `<button type="button" class="icon-btn tree-database-action" data-display-schemas="${escapeHtml(database.name)}" title="选择显示的 schema" aria-label="选择显示的 schema">${moreDotsIcon}</button>` : "";
    rows.push(
      `<details class="tree-database" data-database="${escapeHtml(database.name)}"${expanded ? " open" : ""}${searchExpanded ? " data-search-expanded" : ""}><summary>${treeToggle(database.name, expanded)}<span class="database-icon">${databaseIcon}</span><span class="tree-label">${escapeHtml(database.name)}</span>${defaultDatabaseBadge(database)}<span class="count">${state.visibleSchemasByDatabase.get(database.name)?.size ?? (state.schemasByDatabase.has(database.name) ? schemas.length : "…")}</span>${schemaPicker}</summary><div class="database-children">`,
    );
    if (!state.schemasByDatabase.has(database.name)) {
      rows.push(schemaError
        ? `<div class="tree-status">读取 schema 失败：${escapeHtml(schemaError)}<br/><button data-retry-schema="${escapeHtml(database.name)}">重试</button></div>`
        : `<div class="tree-status">${schemaLoading ? "读取 Schema…" : "展开数据库以读取 Schema"}</div>`);
    } else {
      if (schemaLoading) rows.push('<div class="tree-status">刷新 schema…</div>');
      if (schemaError) rows.push(`<div class="tree-status">刷新 schema 失败：${escapeHtml(schemaError)}<br/><button data-retry-schema="${escapeHtml(database.name)}">重试</button></div>`);
      for (const schema of schemas) {
        const visibleSchemas = state.visibleSchemasByDatabase.get(database.name);
        if (visibleSchemas && !visibleSchemas.has(schema.name)) continue;
        const key = schemaKey(database.name, schema.name);
        const objects = postgresTreeObjects(database.name, schema.name);
        const schemaMatch = query && schema.name.toLowerCase().includes(query);
        const objectMatch = query && objects?.some(object => objectMatchesSearch(object, query));
        const matchesSchema = !query || databaseMatch || schemaMatch || objectMatch;
        if (!matchesSchema) continue;
        const searchSchemaExpanded = Boolean(objectMatch && !state.expandedSchemas.has(key));
        const open = searchSchemaExpanded || state.expandedSchemas.has(key);
        rows.push(
          `<details class="tree-schema" data-database="${escapeHtml(database.name)}" data-schema="${escapeHtml(schema.name)}"${open ? " open" : ""}${searchSchemaExpanded ? " data-search-expanded" : ""}><summary>${treeToggle(schema.name, open)}<span class="schema-icon">${schemaIcon}</span><span class="tree-label">${escapeHtml(schema.name)}</span><span class="count">${objects?.length ?? "…"}</span></summary>`,
        );
        const objectLoading = state.objectRequests.has(key);
        if (!objects) {
          rows.push(`<div class="tree-status">${objectLoading ? "读取对象…" : "展开以读取对象…"}</div>`);
        } else {
          if (objectLoading) rows.push('<div class="tree-status">刷新对象…</div>');
          rows.push(sqlObjectCategories(database.name, schema.name, objects, query, "postgres", databaseMatch || schemaMatch ? "" : query));
        }
        rows.push("</details>");
      }
    }
    rows.push("</div></details>");
  }
  if (systemRows.length) {
    const open = Boolean(query) || state.systemDatabasesExpanded;
    chunks.push(`<details class="system-databases"${open ? " open" : ""}><summary>${treeToggle("系统数据库", open)}<span class="tree-label">系统数据库</span><span class="count">${systemCount}</span></summary><div class="database-children">${systemRows.join("")}</div></details>`);
  }
  if (query && chunks.length === 1) chunks.push('<div class="tree-status">没有匹配的数据库或对象。<br/>可展开数据库后搜索库内对象，或<button data-clear-object-search>清除搜索</button>。</div>');
  refs.objectTree.innerHTML = chunks.join("");
  syncTreeQueries();
  applyTreeSelection();
  const connectionId = state.activeConnectionId;
  const requestId = state.schemaRequest;
  const currentTree = node => node.isConnected && requestId === state.schemaRequest && connectionId === state.activeConnectionId;
  const systemGroup = refs.objectTree.querySelector('.system-databases');
  systemGroup?.addEventListener('toggle', () => {
    syncTreeToggle(systemGroup.querySelector('summary'), systemGroup.open);
    if (!currentTree(systemGroup) || query) return;
    state.systemDatabasesExpanded = systemGroup.open;
    if (systemGroup.open) for (const node of systemGroup.querySelectorAll('details.tree-database[open]')) {
      void loadExpandedDatabase(node.dataset.database, activeProfile.driver);
    }
  });
  refs.objectTree
    .querySelectorAll("details.tree-database[data-database]")
    .forEach((node) => {
      node.addEventListener("toggle", () => {
        syncTreeToggle(node.querySelector('summary'), node.open);
        if (!currentTree(node) || node.closest('.system-databases')?.open === false || node.hasAttribute('data-search-expanded')) return;
        const database = node.dataset.database;
        if (!database) return;
        if (node.open) {
          state.expandedDatabases.add(database);
          void loadExpandedDatabase(database, activeProfile.driver);
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
        if (!currentTree(node) || !node.closest('.tree-database')?.open ||
            node.closest('.system-databases')?.open === false || node.hasAttribute('data-search-expanded')) return;
        const name = node.dataset.schema;
        const database = node.dataset.database;
        const key = schemaKey(database, name);
        const wasOpen = state.expandedSchemas.has(key);
        if (node.open) {
          state.expandedSchemas.add(key);
          loadSchemaObjects(database, name);
        } else if (!node.open && wasOpen) state.expandedSchemas.delete(key);
      });
    });
}
function loadExpandedDatabase(database, driver) {
  if (driver === "mysql") {
    state.schemasByDatabase.set(database, [{ name: database }]);
    state.visibleSchemasByDatabase.set(database, new Set([database]));
    return loadSchemaObjects(database, database);
  }
  if (!state.schemasByDatabase.has(database) && !state.schemaLoading.has(database)) return loadSchemas(database);
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
  if (row.matches(".tree-object")) return null;
  const redis = row.closest(".redis-database");
  if (redis) return { ...scope, type: "redis-database", database: Number(redis.dataset.redisDb) };
  const schema = row.closest(".tree-schema");
  if (schema) return { ...scope, type: row.matches(".category-summary") ? "category" : "schema", database: schema.dataset.database, schema: schema.dataset.schema, kind: row.closest(".tree-category")?.dataset.kind };
  const mysqlScope = row.closest('[data-object-schema]');
  if (mysqlScope && row.matches('.category-summary')) return { ...scope, type: "category", database: mysqlScope.dataset.database, schema: mysqlScope.dataset.objectSchema, kind: row.closest('.tree-category')?.dataset.kind };
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
    if (next) state.expandedCategories.add(key);
    else state.expandedCategories.delete(key);
  }
}
function clearTreeSelection() {
  state.selectedTreeKey = null;
  state.selectedObject = null;
  refs.objectSelection.textContent = driverForConnection(state.activeConnectionId) === "mysql" ? "展开数据库，浏览表和视图" : "展开数据库和 schema，浏览对象";
  applyTreeSelection();
  if (refs.objectTree.contains(document.activeElement)) document.activeElement?.blur();
}
function selectTreeTarget(target) {
  if (!target) return;
  if (['redis-database', 'redis-key'].includes(target.type)) setRedisSearchDatabase(target.database);
  state.selectedTreeKey = treeTargetKey(target);
  refs.objectSelection.textContent = contextTargetLabel(target);
  applyTreeSelection();
}
function redisSearchText(database) { return state.redisSearchScope === 'all' ? state.redisGlobalSearch : state.redisSearches.get(Number(database)) || ''; }
function redisPatternFor(database) { return redisKeySearchPattern(redisSearchText(database)); }
function syncRedisSearchScope() {
  const redis = driverForConnection(state.activeConnectionId) === 'redis';
  refs.redisSearchDatabase.hidden = !redis;
  if (!redis) return;
  const databases = state.redisDatabases.map(item => item.index);
  if (!databases.includes(state.redisActiveDatabase)) databases.push(state.redisActiveDatabase);
  const signature = databases.join(',');
  if (refs.redisSearchDatabase.dataset.options !== signature) {
    refs.redisSearchDatabase.replaceChildren(new Option('全部 DB', 'all'), ...databases.map(database => new Option(`DB ${database}`, String(database))));
    refs.redisSearchDatabase.dataset.options = signature;
  }
  refs.redisSearchDatabase.value = state.redisSearchScope === 'all' ? 'all' : String(state.redisActiveDatabase);
  refs.redisSearchDatabase.disabled = state.connectionStatuses[state.activeConnectionId] !== 'connected';
  refs.objectSearch.disabled = refs.redisSearchDatabase.disabled;
  const text = redisSearchText(state.redisActiveDatabase);
  if (refs.objectSearch.value !== text) refs.objectSearch.value = text;
  const scope = state.redisSearchScope === 'all' ? '全部 DB' : `DB ${state.redisActiveDatabase}`;
  refs.objectSearch.placeholder = `在${scope}查找 Key…`;
  refs.objectSearch.setAttribute('aria-label', `搜索${scope}的 Key`);
  refs.objectSearch.title = '按名称包含查找，区分大小写；全部 DB 指当前 Redis 实例';
}
function setRedisSearchDatabase(database) {
  database = Number(database);
  if (!Number.isInteger(database) || database < 0) return;
  state.redisActiveDatabase = database;
  syncRedisSearchScope();
}
async function searchAllRedisDatabases(connectionId = state.activeConnectionId, requestId = state.redisRequest, epoch = state.redisSearchEpoch) {
  const query = state.redisGlobalSearch;
  const current = () => isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId) && epoch === state.redisSearchEpoch && state.redisSearchScope === 'all' && query === state.redisGlobalSearch;
  const databases = state.redisDatabases.map(db => db.index);
  await searchRedisDatabases(databases, async database => {
    const start = performance.now();
    let cursor = 0;
    // Continue past empty SCAN pages; keep large databases resumable in the UI.
    for (let step = 0; step < 20 && current(); step++) {
      const ok = await loadRedisKeys(database, cursor, redisKeySearchPattern(query), connectionId, requestId);
      if (!ok || !current()) return;
      const page = redisPage(database);
      cursor = page.cursor;
      if (!query || !cursor || page.keys.length >= 200 || performance.now() - start > 1500) return;
    }
  }, current);
}
function queueRedisSearch() {
  const connectionId = state.activeConnectionId, requestId = state.redisRequest;
  const database = state.redisActiveDatabase, global = state.redisSearchScope === 'all';
  const search = refs.objectSearch.value, epoch = ++state.redisSearchEpoch;
  if (global) state.redisGlobalSearch = search;
  else state.redisSearches.set(database, search);
  const databases = global ? state.redisDatabases.map(db => db.index) : [database];
  for (const db of databases) {
    state.redisExpanded.add(db);
    state.redisScanGenerations.set(db, (state.redisScanGenerations.get(db) || 0) + 1);
    redisPage(db).loading = true;
  }
  renderRedisTree();
  clearTimeout(state.redisSearchTimer);
  state.redisSearchTimer = setTimeout(() => {
    if (!isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId)) return;
    if (global) { if (epoch === state.redisSearchEpoch) void searchAllRedisDatabases(connectionId, requestId, epoch); }
    else if (state.redisSearchScope === 'db' && (state.redisSearches.get(database) || '') === search) void loadRedisKeys(database, 0, redisKeySearchPattern(search), connectionId, requestId);
  }, 220);
}
function changeRedisSearchScope(value) {
  const global = value === 'all', wasGlobal = state.redisSearchScope === 'all';
  if (global !== wasGlobal) {
    state.redisSearchEpoch++;
    clearTimeout(state.redisSearchTimer);
    for (const [db, page] of state.redisPages) {
      state.redisScanGenerations.set(db, (state.redisScanGenerations.get(db) || 0) + 1);
      page.loading = false;
    }
    if (global) { state.redisLocalExpanded = new Set(state.redisExpanded); state.redisExpanded = new Set(state.redisDatabases.map(db => db.index)); }
    else { state.redisExpanded = new Set(state.redisLocalExpanded || []); state.redisLocalExpanded = null; }
    state.redisSearchScope = global ? 'all' : 'db';
  }
  if (!global) {
    setRedisSearchDatabase(value);
    selectTreeTarget({ type: 'redis-database', connectionId: state.activeConnectionId, driver: 'redis', database: state.redisActiveDatabase });
    state.redisExpanded.add(state.redisActiveDatabase);
  }
  renderRedisTree();
  if (global) void searchAllRedisDatabases();
  else for (const db of state.redisExpanded) { const page = redisPage(db); if (!page.loaded && !page.loading) void loadRedisKeys(db); }
}
function redisPage(database, pattern = redisPatternFor(database)) {
  const existing = state.redisPages.get(database);
  if (!existing || existing.pattern !== pattern) {
    const page = { keys: [], keyTypes: new Map(), cursor: 0, pattern, loading: false, loaded: false, error: null };
    state.redisPages.set(database, page);
    return page;
  }
  return existing;
}
async function applyRedisKeyOperation(context, operation) {
  const tab = context.tab;
  if (!state.tabs.includes(tab) || tab.connectionId !== context.connectionId || tab.redisKey !== context.key || redisTabDatabase(tab) !== context.database) throw new Error('原 Key 标签已改变，请重新打开操作');
  if (tab.mode !== 'write' || tab.running || tab.refreshing || cellWritePending(tab)) throw new Error('当前只读或有操作正在执行，请稍后重试');
  if (resultGrid.getCellEditDraft(tab.result?.rows)) throw new Error('请先保存或取消表格中的修改');
  tab.cellSaving = true; renderTabs(); renderOutput();
  try {
    await call('operate_redis_key', { request: { connectionId: context.connectionId, database: context.database, key: context.key, keyType: context.keyType, ...operation, readOnly: false } });
    try {
      const value = await call('get_redis_value', { connectionId: context.connectionId, database: context.database, key: context.key });
      if (state.tabs.includes(tab)) { applyRedisValueResult(tab, value, context.connectionId, context.database); tab.error = false; }
      if (state.activeConnectionId === context.connectionId) await loadRedisKeys(context.database, 0, redisPatternFor(context.database));
      showToast('操作已完成');
    } catch (error) { showToast(`操作已成功，重新读取失败，请手动刷新：${errorText(error)}`, 'error'); }
  } finally { tab.cellSaving = false; renderTabs(); renderOutput(); }
}
function openRedisKeyOperation(action) {
  const tab = activeTab();
  if (!tab || tab.redisKey == null || tab.mode !== 'write' || tab.running || tab.refreshing || cellWritePending(tab)) return;
  if (resultGrid.getCellEditDraft(tab.result?.rows)) return showToast('请先保存或取消表格中的修改', 'error');
  const rowIndex = resultGrid.activeCell ? resultGrid.visibleOrder[resultGrid.activeCell.position] : null;
  // Truncated field/member identities must never be offered as mutation targets.
  const entries = tab.result.redisValueTruncated ? [] : tab.result.rows.map(row => Object.fromEntries(tab.result.columns.map((name, index) => [cellColumnName(name), row[index]])));
  const selected = Number.isInteger(rowIndex) ? entries[rowIndex] : null;
  redisKeyOperations.open({ tab, key: tab.redisKey, keyType: tab.redisType, database: redisTabDatabase(tab), connectionId: tab.connectionId,
    connectionName: state.profiles.find(profile => profile.id === tab.connectionId)?.name || '', ttl: tab.redisTtl, selected, entries }, action);
}
refs.redisMemberAction.addEventListener('click', () => openRedisKeyOperation());
refs.redisTtlAction.addEventListener('click', () => openRedisKeyOperation('ttl'));

function redisContextState(key, database, connectionId) {
  const targetTab = state.tabs.find(tab => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === Number(database));
  const modeTab = targetTab || (activeTab()?.connectionId === connectionId ? activeTab() : null);
  const pages = connectionId === state.activeConnectionId ? state.redisPages : state.treeSessions.get(connectionId)?.redisPages;
  return { targetTab, readOnly: modeTab ? modeTab.mode !== 'write' : false,
    busy: Boolean(targetTab?.refreshing || targetTab?.running || cellWritePending(modeTab)),
    type: targetTab?.redisType || redisPageKeyType(pages?.get(Number(database)), key) };
}
function prepareRedisContextMenu(target, returnFocus) {
  const menu = target.type === 'redis-key' ? refs.redisContextMenu : refs.redisDatabaseContextMenu;
  redisMenus.prepare(menu, { key: target.key, database: target.database, ...redisContextState(target.key, target.database, target.connectionId), returnFocus });
  return menu;
}
function syncRedisCreateType() {
  const type = refs.redisCreateType.value;
  refs.redisCreateFieldRow.hidden = !['hash', 'stream'].includes(type);
  refs.redisCreateField.required = ['hash', 'stream'].includes(type);
  refs.redisCreateScoreRow.hidden = type !== 'zset';
  refs.redisCreateValueLabel.textContent = ({ string: '值', hash: '字段值', list: '第一个元素', set: '第一个成员', zset: '第一个成员', stream: '消息字段值' })[type];
  refs.redisCreateValueHint.textContent = ({ string: '文本、数字或 JSON，按原文保存。', hash: '创建第一个字段，后续可继续添加字段。', list: '元素有序且允许重复，后续可从头部或尾部添加。', set: '成员唯一，不保证顺序。', zset: '成员按分数排序，分数支持小数和负数。', stream: '自动生成消息 ID，创建第一条消息。' })[type];
}
function openRedisCreate(connectionId, database, prefix = '') {
  if (redisContextState(null, database, connectionId).readOnly) return showToast('当前 Redis 标签为只读，请先解锁', 'error');
  state.pendingRedisCreate = { connectionId, database };
  refs.redisCreateForm.reset(); redisTypePicker.reset(); syncRedisCreateType();
  refs.redisCreateKey.value = prefix;
  refs.redisCreateLocation.textContent = redisLocation({ database, connectionName: state.profiles.find(profile => profile.id === connectionId)?.name });
  refs.redisCreateFeedback.textContent = '';
  refs.redisCreateModal.showModal(); refs.redisCreateKey.focus();
}
function openRedisNameDialog(key, database, connectionId, duplicate = false) {
  state.pendingRedisRename = { key, connectionId, database, duplicate };
  refs.redisRenameInput.value = duplicate ? `${key}:copy` : key;
  refs.redisRenameTitle.textContent = duplicate ? '复制为新 Key' : '重命名 Key';
  refs.redisRenameSource.textContent = key;
  refs.redisRenameLocation.textContent = redisLocation({ database, connectionName: state.profiles.find(profile => profile.id === connectionId)?.name });
  refs.redisCopyTtlRow.hidden = !duplicate; refs.redisCopyTtl.checked = true;
  refs.redisRenameHint.textContent = duplicate ? '复制完整内容，原 Key 保留；目标已存在时不会覆盖。' : '内容和有效期保留；目标已存在时不会覆盖。';
  refs.applyRedisRename.textContent = duplicate ? '创建副本' : '重命名';
  refs.redisRenameFeedback.textContent = '';
  refs.redisRenameModal.showModal(); refs.redisRenameInput.focus(); refs.redisRenameInput.select();
}

function showRedisKeyDetails(key, database, connectionId = state.activeConnectionId) {
  const profile = state.profiles.find(item => item.id === connectionId);
  const pages = connectionId === state.activeConnectionId ? state.redisPages : state.treeSessions.get(connectionId)?.redisPages;
  const tab = state.tabs.find(item => item.connectionId === connectionId && item.redisKey === key && redisTabDatabase(item) === Number(database));
  redisKeyDetails.open({ key, database: Number(database), connectionId, connectionName: profile?.name || connectionId, type: redisPageKeyType(pages?.get(Number(database)), key) ?? tab?.redisType, ttl: tab?.redisTtl });
}
function renderRedisTree() {
  refs.objectTree.dataset.driver = "redis";
  syncRedisSearchScope();
  const expanded = state.redisExpanded;
  const total = state.redisDatabases.length;
  const loadedCount = [...expanded].reduce((sum, database) => sum + (redisPage(database).keys.length || 0), 0);
  const chunks = [`<div class="tree-root redis-tree-root" tabindex="0" aria-label="Redis 实例"><span class="database-icon driver-tree-icon">${redisIcon}</span><span class="tree-label">Redis 数据库</span><small>${expanded.size}/${total || "—"}</small></div>`];
  if (state.redisSearchScope === 'all') chunks.push('<div class="tree-status redis-global-search-hint">搜索当前实例全部 DB · 结果按 DB 展示<br>扫描未结束时可继续搜索</div>');
  if (!state.activeConnectionId || state.connectionStatuses[state.activeConnectionId] !== "connected") {
    chunks.push('<div class="tree-status">连接后加载 Redis DB</div>');
  } else if (!state.redisDatabases.length) {
    chunks.push(`<div class="tree-status">${state.redisDatabaseError ? `读取 Redis DB 失败：${escapeHtml(state.redisDatabaseError)}` : "正在读取 Redis DB…"}</div>`);
  } else {
    for (const database of state.redisDatabases) {
      const index = database.index;
      const page = redisPage(index);
      const query = redisSearchText(index);
      const keys = page.keys.filter((key) => redisKeyMatchesSearch(key, query));
      const open = expanded.has(index) ? " open" : "";
      const count = query ? `${keys.length}${page.cursor ? "+" : ""} / ${database.keyCount ?? "—"}` : database.keyCount ?? (page.loaded ? `已加载 ${page.keys.length}` : "—");
      chunks.push(`<details class="tree-database redis-database" data-redis-db="${index}"${open}><summary>${treeToggle(`DB ${index}`, Boolean(open))}<span class="database-icon redis-db-icon">${databaseIcon}</span><span class="tree-label">DB ${index}</span>${query ? '<small class="redis-search-badge">筛选中</small>' : ''}<span class="count">${escapeHtml(count)}</span></summary><div class="database-children redis-database-children">`);
      if (page.loading && !page.keys.length) chunks.push('<div class="tree-status">读取 key…</div>');
      else {
        if (page.error) chunks.push(`<div class="tree-status">刷新 key 失败，保留已加载结果：${escapeHtml(page.error)}</div>`);
        if (!keys.length && !page.error) chunks.push(`<div class="tree-status">${page.cursor ? "本页暂无匹配，仍有 Key 待扫描" : query ? "没有匹配的 Redis key" : "没有 Redis key"}</div>`);
        if (keys.length) {
        chunks.push('<div class="redis-key-list">');
        for (const key of keys) {
          const type = redisKeyTypePresentation(redisPageKeyType(page, key));
          chunks.push(`<div class="tree-object redis-key-object" data-redis-key="${escapeHtml(key)}" data-redis-db="${index}" data-redis-type="${type.type}"><span class="object-kind-icon redis-key-kind" title="${type.label}">${type.icon}</span><button class="object-main" title="${escapeHtml(`${key} · ${type.label}`)}">${escapeHtml(key)}</button><button class="icon-btn redis-key-info" data-redis-key-info type="button" title="查看完整 Key" aria-label="查看完整 Key">${infoCircleIcon}</button></div>`);
        }
        chunks.push('</div>');
        }
      }
      if (page.cursor) chunks.push(`<button class="quiet-btn redis-load-more" data-load-more-redis-db="${index}" type="button">${query ? "继续搜索" : "加载更多 key"}</button>`);
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
        selectTreeTarget({ type: 'redis-database', connectionId, driver: 'redis', database });
        state.redisExpanded.add(database);
        const page = redisPage(database);
        if (!page.loading) void loadRedisKeys(database, 0, redisPatternFor(database));
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
      keyCount: database.keyCount != null && Number.isFinite(Number(database.keyCount)) ? Number(database.keyCount) : null,
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
  if (state.redisSearchScope === 'all') { state.redisExpanded = new Set(state.redisDatabases.map(db => db.index)); await searchAllRedisDatabases(connectionId, requestId); return isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId); }
  const results = await Promise.all([...state.redisExpanded].map((database) => loadRedisKeys(database, 0, redisPatternFor(database), connectionId, requestId)));
  return results.every(Boolean) && isCurrentConnectionRequest(requestId, state.redisRequest, connectionId, state.activeConnectionId);
}
async function loadRedisKeys(database = state.redisActiveDatabase, cursor = 0, pattern = redisPatternFor(database), connectionId = state.activeConnectionId, requestId = state.redisRequest) {
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
    const merged = mergeRedisKeyPage(pageState, page, cursor === 0);
    pageState.keys = merged.keys;
    pageState.keyTypes = merged.keyTypes;
    pageState.cursor = Number(page.cursor || 0);
    pageState.pattern = pattern;
    pageState.loading = false;
    pageState.loaded = true;
    const info = state.redisDatabases.find(item => item.index === database);
    if (info) info.keyCount = page.keyCount != null && Number.isSafeInteger(page.keyCount) && page.keyCount >= 0 ? page.keyCount : null;
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
  const existing = state.tabs.find(tab => tab.connectionId === connectionId && tab.redisKey === key && redisTabDatabase(tab) === redisDb && tab.tableView !== false && !tab.console);
  if (existing) {
    activateTab(existing.id);
    if (!existing.result?.executed) await restoreRedisKeyResult(existing);
    return existing;
  }
  const tab = addTab("", connectionId);
  if (!tab) return;
  tab.title = key;
  tab.redisKey = key;
  tab.redisDb = Number.isInteger(redisDb) && redisDb >= 0 ? redisDb : redisProfileDatabase(state.profiles.find((profile) => profile.id === connectionId));
  tab.redisType = redisPageKeyType(state.redisPages.get(tab.redisDb), key);
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
    return tab;
  } catch (error) {
    if (requestId !== state.redisRequest || state.activeConnectionId !== connectionId) return;
    tab.error = true;
    tab.message = `读取 Redis key 失败：${errorText(error)}`;
    tab.outputTab = "message";
    renderOutput();
  }
}
async function restoreRedisKeyResult(tab) {
  if (tab.redisKey == null || tab.result?.executed || tab.refreshing || tab.running || cellWritePending(tab)) return;
  const connectionId = tab.connectionId, database = redisTabDatabase(tab), key = tab.redisKey;
  const request = {}; tab.redisValueRequest = request; tab.refreshing = true;
  const current = () => state.tabs.includes(tab) && tab.redisValueRequest === request && tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === database;
  tab.outputTab = 'result';
  if (activeTab() === tab) { renderTabs(); renderOutput(); }
  try {
    const value = await call('get_redis_value', { connectionId, database, key });
    if (current()) { applyRedisValueResult(tab, value, connectionId, database); tab.error = false; }
  } catch (error) {
    if (current()) { tab.error = true; tab.message = `重新读取 Key 失败：${errorText(error)}。可点击刷新重试。`; tab.outputTab = 'message'; }
  } finally {
    if (current()) {
      tab.refreshing = false; tab.redisValueRequest = null;
      if (activeTab() === tab) { renderTabs(); renderOutput(); }
    }
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
  tab.resultReleased = false;
  tab.redisTotalCount = value.totalCount;
  tab.result.truncated = Boolean(value.partial || value.truncated);
  tab.result.truncatedReason = value.truncatedReason === 'result_size' ? 'redis_result_size' : value.partial || value.truncated ? 'redis_preview' : null;
  tab.result.redisValueTruncated = value.truncatedReason === 'result_size';
  const pages = connectionId === state.activeConnectionId ? state.redisPages : state.treeSessions.get(connectionId)?.redisPages;
  const page = pages?.get(Number(database));
  if (page?.keys.includes(tab.redisKey)) {
    if (!(page.keyTypes instanceof Map)) page.keyTypes = new Map();
    page.keyTypes.set(tab.redisKey, value.keyType);
    if (connectionId === state.activeConnectionId && refs.objectTree.dataset.driver === 'redis') {
      const type = redisKeyTypePresentation(value.keyType);
      for (const node of refs.objectTree.querySelectorAll('[data-redis-key]')) {
        if (node.dataset.redisKey !== tab.redisKey || Number(node.dataset.redisDb) !== Number(database)) continue;
        node.dataset.redisType = type.type;
        const icon = node.querySelector('.redis-key-kind');
        if (icon) { icon.innerHTML = type.icon; icon.title = type.label; }
        node.querySelector('.object-main').title = `${tab.redisKey} · ${type.label}`;
      }
    }
  }
  tab.message = `Redis ${value.keyType} · TTL ${value.ttl}`;
  tab.outputTab = "result";
}
async function loadSchemas(database, connectionId = state.activeConnectionId, request = state.schemaRequest) {
  if (request !== state.schemaRequest || state.activeConnectionId !== connectionId) return false;
  if (driverForConnection(connectionId) === "mysql") {
    state.schemasByDatabase.set(database, [{ name: database }]);
    state.visibleSchemasByDatabase.set(database, new Set([database]));
    return loadSchemaObjects(database, database, { force: true });
  }
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
    const searching = Boolean(refs.objectSearch.value.trim()) && databaseTreeExpanded(database);
    const objectsToLoad = [...selected].filter(schema => searching || state.expandedSchemas.has(schemaKey(database, schema)));
    const results = await Promise.all(objectsToLoad.map(schema => loadSchemaObjects(database, schema)));
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
async function refreshExpandedDatabases() {
  const request = ++state.schemaRequest;
  state.schemaLoading.clear();
  state.objectRequests.clear();
  const expanded = [...state.expandedDatabases].filter(database => databaseTreeExpanded(database));
  for (const database of expanded) {
    state.schemaLoading.add(database);
    state.schemaErrors.delete(database);
  }
  renderTree();
  const results = await Promise.all(
    expanded.map((database) =>
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
      if (driverForConnection(connectionId) === "mysql") state.schemaErrors.delete(database);
      return true;
    } catch (error) {
      if (isCurrent()) {
        if (driverForConnection(connectionId) === "mysql") state.schemaErrors.set(database, errorText(error));
        showToast(`读取 ${database}${driverForConnection(connectionId) === "mysql" ? "" : `.${schemaName}`} 失败：${errorText(error)}`, "error");
      }
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
  return tab;
}
function tabGlyph(tab) {
  if (tab.redisKey != null) return `<span class="tab-glyph redis-tab-glyph">${redisKeyIcon(tab.redisType)}</span>`;
  const kind = tab.openedObject?.kind || tab.inspectedObject?.kind;
  if (tab.structureOnly && isRoutine(kind)) {
    return `<span class="tab-glyph" data-catalog-icon="${kind}" title="${kindLabels[kind]}">${kindIcons[kind]}</span>`;
  }
  return `<span class="tab-glyph">${tab.console ? "CLI" : tab.structureOnly ? "DDL" : tab.browse ? "表" : "SQL"}</span>`;
}
function renderTabs() {
  syncTreeQueries();
  scheduleWorkspaceAttention();
  const focusedTab = refs.queryTabs.contains(document.activeElement) ? document.activeElement : null;
  const focusedTabId = focusedTab?.dataset.tabId;
  const focusedCloseId = focusedTab?.dataset.closeTab;
  refs.queryTabs.innerHTML = state.tabs
    .map(
      (tab) =>
        `<div class="query-tab ${!state.redisConsole && tab.id === state.activeTabId ? "active" : ""} ${tab.running ? "running" : ""}" data-tab-id="${escapeHtml(tab.id)}" role="presentation"><button class="tab-select" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${!state.redisConsole && tab.id === state.activeTabId}" tabindex="${tab.id === state.activeTabId ? 0 : -1}" title="${escapeHtml(`${tab.title} · ${queryTargetDescription(tab)}${tab.mode === "read" ? " · 只读" : ""}`)}">${tabGlyph(tab)}<span class="tab-label">${escapeHtml(tab.title)}</span>${tab.mode === "read" ? '<span class="tab-readonly">只读</span>' : ""}</button><button class="tab-close" data-close-tab="${escapeHtml(tab.id)}" title="关闭标签" aria-label="关闭 ${escapeHtml(tab.title)}">×</button></div>`,
    )
    .join("");
  if (focusedTabId) refs.queryTabs.querySelector(`.tab-select[data-tab-id="${CSS.escape(focusedTabId)}"]`)?.focus({ preventScroll: true });
  if (focusedCloseId) {
    const target = refs.queryTabs.querySelector(`[data-close-tab="${CSS.escape(focusedCloseId)}"]`) || refs.queryTabs.querySelector('[aria-selected="true"]') || refs.addQueryTab;
    target.focus({ preventScroll: true });
  }
  const tab = activeExecutionTab();
  updateRunButton(tab);
  renderQueryTarget(tab);
  const activeDriver = state.profiles.find((profile) => profile.id === tab?.connectionId)?.driver;
  if (tab && activeDriver !== "redis") {
    refs.editorHint.textContent = `${activeDriver === "mysql" ? "MySQL" : "PostgreSQL"} · ${queryTargetDescription(tab, { showVisibility: true })} · 选中 SQL 可单独执行`;
  }
  const isRedis = activeDriver === "redis";
  refs.transactionState.hidden = true;
  if (isRedis) refs.editorHint.textContent = "Redis 命令 · 只读锁定后仅允许安全读取命令";
  const isConsole = tab?.console === true;
  if (refs.beginTransaction) refs.beginTransaction.hidden = isRedis;
  if (refs.commitTransaction) refs.commitTransaction.hidden = isRedis;
  if (refs.rollbackTransaction) refs.rollbackTransaction.hidden = isRedis;
  if (refs.formatQuery) refs.formatQuery.hidden = isConsole;
  if (refs.importSql) refs.importSql.hidden = isConsole;
  if (refs.saveSql) refs.saveSql.hidden = isConsole;
  if (!tab) {
    renderWorkspaceMode(undefined);
    if (refs.formatQuery) refs.formatQuery.disabled = true;
    if (refs.beginTransaction) refs.beginTransaction.disabled = true;
    if (refs.commitTransaction) refs.commitTransaction.disabled = true;
    if (refs.rollbackTransaction) refs.rollbackTransaction.disabled = true;
    refs.runQuery.disabled = true;
    refs.stopQuery.disabled = true;
    refs.resultTab.disabled = refs.structureTab.disabled = refs.messageTab.disabled = true;
    return;
  }
  refs.resultTab.disabled = refs.messageTab.disabled = false;
  refs.structureTab.disabled = !tab.connectionId || Boolean(tab.awaitingDatabase);
  if (refs.formatQuery) {
    refs.formatQuery.disabled = activeDriver === "redis";
    refs.formatQuery.title = activeDriver === "redis" ? "Redis 命令不使用 SQL 格式化" : "格式化 SQL";
  }
  renderWorkspaceMode(tab);
  const mode = tab?.mode === "write" ? "write" : "read";
  const database = tabDatabase(tab) || queryTargetData(tab)?.context?.database;
  const txOpen = Boolean(tab.connectionId && state.transactionKeys.has(transactionKey(tab.connectionId, database)));
  refs.transactionState.hidden = isRedis || !tab.connectionId;
  const transactionLabel = tab.transactionScriptRunning ? "事务脚本执行中" : txOpen ? "事务中 · 未提交" : "自动提交";
  if (refs.transactionState.textContent !== transactionLabel) refs.transactionState.textContent = transactionLabel;
  refs.transactionState.dataset.active = String(txOpen || Boolean(tab.transactionScriptRunning));
  refs.transactionState.title = tab.transactionScriptRunning ? "脚本结束后将自动提交或回滚"
    : txOpen
    ? `同一连接和数据库的标签共用事务：${queryTargetDescription(tab)}`
    : "写入成功后自动提交。可点击「开始事务」，或单独执行 BEGIN。";
  refs.beginTransaction.hidden = isRedis || txOpen || mode === "read";
  refs.commitTransaction.hidden = isRedis || !txOpen;
  refs.rollbackTransaction.hidden = isRedis || !txOpen;
  const busy = Boolean(tab?.paging || tab?.running || tab?.confirming || tab?.resolvingTarget || tab?.changingTransaction || cellWritePending(tab));
  if (refs.beginTransaction) refs.beginTransaction.disabled = !tab.connectionId || !database || txOpen || mode === "read" || busy || Boolean(tab.awaitingSchema || queryTargetData(tab)?.loading || queryTargetData(tab)?.error);
  if (refs.commitTransaction) refs.commitTransaction.disabled = !txOpen || busy;
  if (refs.rollbackTransaction) refs.rollbackTransaction.disabled = !txOpen || busy;
  const target = queryTargetData(tab);
  refs.runQuery.disabled = Boolean(busy || (!isRedis && (tab.awaitingDatabase || tab.awaitingSchema || target?.loading || target?.error || !tab?.connectionId)));
  refs.stopQuery.disabled = !tab?.running;
}
// Objects with nothing to browse or run show one page, named for what it holds.
const detailNouns = { function: "定义", procedure: "定义", sequence: "详情", event: "详情" };
const structureNoun = object => detailNouns[object?.kind] ?? "结构";
function isSqlQueryTab(tab) {
  return Boolean(tab && !tab.structureOnly && !tab.browse && !tab.console && driverForTab(tab) !== "redis");
}
function renderWorkspaceMode(tab = activeExecutionTab()) {
  const structureView = Boolean(tab?.structureOnly);
  const sqlQuery = isSqlQueryTab(tab);
  const hasMessage = tab?.outputTab === "message" && (!tab.running || tab.error || tab.cancelled);
  const editorOnly = sqlQuery && !tab.result.executed && !tab.executionSummary && !hasMessage;
  const summaryOnly = sqlQuery && Boolean(tab.executionSummary) && !tab.result.columns.length;
  refs.editorResult.classList.toggle("sql-editor-only", editorOnly);
  refs.editorResult.classList.toggle("sql-query-workspace", sqlQuery);
  refs.editorResult.classList.toggle("sql-summary-only", summaryOnly);
  refs.editorResult.classList.toggle("has-editor-footer", Boolean(tab && !tab.structureOnly && !tab.browse && !tab.console && !tab.redisKey));
  refs.editorSplitter.hidden = editorOnly;
  refs.resultsPane.hidden = editorOnly;
  document.body.classList.toggle("empty-workspace-mode", !tab);
  document.body.classList.toggle("structure-only-mode", structureView);
  refs.resultsPane.setAttribute("aria-label", structureView ? "对象结构" : "查询结果区");
  refs.resultTab.hidden = structureView || (sqlQuery && !tab.result.columns.length);
  refs.messageTab.hidden = structureView;
  const statusHost = sqlQuery ? refs.queryFooterStatus : refs.resultFooterStatus;
  if (refs.resultMeta.parentElement !== statusHost) statusHost.prepend(refs.resultMeta);
  const gridFooterHost = sqlQuery ? refs.queryFooterGrid : refs.resultGrid;
  if (resultGrid.footer.parentElement !== gridFooterHost) gridFooterHost.append(resultGrid.footer);
  refs.queryFooterStatus.hidden = !sqlQuery || (editorOnly && !tab.running);
  refs.queryFooterGrid.hidden = !sqlQuery || tab.outputTab === "message" || !tab.result.columns.length;
  const messageLabel = sqlQuery && tab.executionSummary ? "摘要" : "消息";
  if (refs.messageTab.textContent.trim() !== messageLabel) refs.messageTab.textContent = messageLabel;
  const detailLabel = structureView && detailNouns[(tab.inspectedObject || tab.openedObject)?.kind];
  refs.objectDetailTab.hidden = !detailLabel;
  document.body.classList.toggle("object-detail-mode", Boolean(detailLabel));
  if (detailLabel) refs.objectDetailTab.textContent = detailLabel;
  const tableView = Boolean((tab?.browse || tab?.redisKey) && tab.tableView !== false);
  refs.structureTab.hidden = !tableView || !tab.browse || structureView;
  refs.structureTab.title = ["table", "partitioned_table", "foreign_table"].includes(tab?.browse?.kind) ? "查看表结构" : "查看结构";
  const objectView = tableView || structureView;
  const actionHost = objectView ? refs.tableActionHost : refs.resultActionHost;
  if (refs.resultActions.parentElement !== actionHost) actionHost.append(refs.resultActions);
  const transactionButtons = [refs.transactionState, refs.beginTransaction, refs.commitTransaction, refs.rollbackTransaction];
  if (tableView && refs.beginTransaction.parentElement !== refs.tableTransactionActions) refs.tableTransactionActions.append(...transactionButtons);
  else if (!tableView && refs.beginTransaction.parentElement !== refs.queryToolbar) refs.queryTransactionAnchor.after(...transactionButtons);
  refs.tableTransactionActions.hidden = !tableView || !['postgres', 'mysql'].includes(driverForTab(tab));
  refs.refreshTableData.hidden = !objectView;
  document.body.classList.toggle("table-browse-mode", tableView);
  if (refs.queryToolbar) refs.queryToolbar.hidden = !tab || tableView || Boolean(tab?.console);
  if (refs.tableToolbar) refs.tableToolbar.hidden = !objectView;
  refs.redisValueActions.hidden = !tableView || !redisTypeActions[tab?.redisType] || tab?.redisKey == null;
  refs.redisMemberAction.hidden = tab?.redisType === 'string';
  refs.redisMemberAction.textContent = ({ hash: '字段操作', list: '添加元素', set: '成员操作', zset: '成员与分数', stream: '消息操作' })[tab?.redisType] || '成员操作';
  refs.redisMemberAction.disabled = refs.redisTtlAction.disabled = !tab || tab.mode !== 'write' || Boolean(tab.refreshing || tab.running || cellWritePending(tab));
  if (objectView) {
    const browse = tab.browse || tab.inspectedObject || tab.openedObject;
    refs.tableToolbarTitle.textContent = tab.redisKey || `${browse.schema}.${browse.name}`;
    if (tab.redisKey != null) {
      refs.tableToolbarTitle.setAttribute('role', 'button'); refs.tableToolbarTitle.tabIndex = 0; refs.tableToolbarTitle.title = '查看完整 Key、类型和过期时间';
    } else { refs.tableToolbarTitle.removeAttribute('role'); refs.tableToolbarTitle.removeAttribute('tabindex'); refs.tableToolbarTitle.title = refs.tableToolbarTitle.textContent; }
    refs.tableToolbarMeta.textContent = tab.redisKey ? `DB ${redisTabDatabase(tab)} · ${redisKeyTypePresentation(tab.redisType).label}` : browse.pageSize ? `${browse.pageSize} 行/页` : '';
    if (refs.openTableSql) refs.openTableSql.hidden = Boolean(tab.redisKey);
    refs.viewTableDdl.hidden = !canViewObjectDdl(browse);
    if (refs.refreshTableData) {
      refs.refreshTableData.disabled = Boolean(tab.running || tab.refreshing || tab.structurePending || cellWritePending(tab));
      refs.refreshTableData.title = tab.outputTab === 'structure' ? `刷新${structureNoun(browse)}` : '刷新数据';
      refs.refreshTableData.setAttribute('aria-label', refs.refreshTableData.title);
    }
  } else {
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
  rememberActiveView();
  closeRedisConsole({ render: false });
  state.activeTabId = id;
  if (next.redisKey != null && next.connectionId === state.activeConnectionId) setRedisSearchDatabase(redisTabDatabase(next));
  state.editor.setState(
    next.editorState || (next.editorState = makeEditorState(next)),
  );
  updateEditorSchema();
  state.editor.scrollDOM.scrollTop = next.editorScroll?.top || 0;
  state.editor.scrollDOM.scrollLeft = next.editorScroll?.left || 0;
  refs.resultFilter.value = next.filter || "";
  renderTabs();
  renderOutput();
  revealFailedStatement(next);
  updateCursor();
  persistTabs();
  if (next.redisKey != null && !next.result?.executed && state.connectionStatuses[next.connectionId] === 'connected') void restoreRedisKeyResult(next);
  if (next.autoLoadPending && next.browse && next.outputTab === 'result' && !next.opening) {
    next.autoLoadPending = false;
    void loadOpenedObjectData(next);
  }
  const structureObject = next.inspectedObject || next.browse;
  if (next.outputTab === 'structure' && structureObject && !next.structure && !next.structurePending && !next.structureError &&
      state.connectionStatuses[next.connectionId] === 'connected' && next.structureNeedsReload) {
    next.structureNeedsReload = false;
    void inspectObject(structureObject, { connectionId: next.connectionId, tab: next });
  }
  if (focus) {
    if (next.console) redisEditor?.focus();
    else state.editor.focus();
  }
  refs.queryTabs
    .querySelector(`[data-tab-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function addTab(sql = "", connectionId, browse = null, options = {}) {
  if (state.tabs.length >= MAX_QUERY_TABS) {
    showToast(`最多打开 ${MAX_QUERY_TABS} 个查询，请先关闭不需要的标签`);
    return null;
  }
  let defaultDatabase;
  let defaultSchema;
  const newQuery = connectionId === undefined || options.newQuery;
  if (connectionId === undefined) {
    // A blank query starts from the browser's current destination. Existing
    // tabs can remain bound to a different connection.
    const current = activeExecutionTab();
    connectionId = state.activeConnectionId || current?.connectionId;
    if (state.activeConnectionId) {
      const selected = refs.objectTree.querySelector('[aria-current="true"]');
      const target = selected ? treeTargetFromNode(selected) : null;
      if (target && treeTargetKey(target) === state.selectedTreeKey) {
        defaultDatabase = target.object?.database ?? target.database;
        defaultSchema = target.object?.schema ?? target.schema;
      }
    } else if (current) {
      defaultDatabase = tabDatabase(current);
      defaultSchema = tabSchema(current);
    }
    if (current?.connectionId && current.connectionId === connectionId &&
        (!state.activeConnectionId || defaultDatabase == null) &&
        state.profiles.some(profile => profile.id === connectionId && profile.driver === "redis")) {
      defaultDatabase = redisTabDatabase(current);
    }
    const activeProfile = state.profiles.find(profile => profile.id === connectionId);
    if (!defaultDatabase && current?.connectionId === connectionId && activeProfile?.driver === "mysql" && !activeProfile.database) {
      defaultDatabase = tabDatabase(current) || queryTargetData(current)?.context?.database;
    }
  }
  const profile = state.profiles.find((item) => item.id === connectionId);
  const tabBrowse = browse
    ? { ...browse, connectionId: browse.connectionId || connectionId }
    : null;
  const openedObject = objectTabTarget(options.openedObject || tabBrowse, connectionId);
  const structureOnly = Boolean(openedObject && options.openedObjectView === "structure" && !tabBrowse);
  const requestedDatabase = options.database ?? browse?.database ?? defaultDatabase;
  const database = requestedDatabase ?? profile?.database ?? null;
  const redisDb = profile?.driver === "redis" ? resolveRedisDatabase({ database }, profile) : null;
  const tab = {
    id: makeId("query"),
    title: options.title || browse?.name || `查询 ${nextQueryNumber()}`,
    sql,
    connectionId,
    database: redisDb === null ? database : String(redisDb),
    redisDb,
    schema: options.schema ?? browse?.schema ?? defaultSchema ?? null,
    mode: options.mode === "read" ? "read" : "write",
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
  if (newQuery && !openedObject && !tabBrowse && profile && (profile.driver || "postgres") === "postgres") {
    const visible = queryDatabaseOptions(connectionId);
    const contextualDatabase = options.database ?? (state.activeConnectionId === connectionId ? defaultDatabase : null);
    if (contextualDatabase && (!visible || visible.includes(contextualDatabase))) {
      prepareInitialQuerySchema(tab);
    } else {
      tab.database = visible?.length === 1 ? visible[0] : null;
      tab.schema = null;
      tab.awaitingDatabase = !tab.database;
      tab.chooseInitialDatabase = !visible;
      if (tab.database) prepareInitialQuerySchema(tab);
    }
  }
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}
async function closeTab(id) {
  const target = state.tabs.find((tab) => tab.id === id);
  if (!target) return;
  if (target.paging || target.running || target.opening || target.confirming || target.resolvingTarget || target.changingTransaction || target.cellSaving || target.cellBatchSaving) {
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
  const paging = Boolean(tab?.paging);
  refs.resultContent.dataset.paging = String(paging && tab.outputTab === "result");
  refs.resultGrid.setAttribute("aria-busy", String(paging));
  refs.pageControls.setAttribute("aria-busy", String(paging));
  refs.pageControls.hidden =
    !browse || (tab.outputTab || "result") !== "result";
  if (!browse) return;
  const busy = Boolean(paging || tab.running || tab.confirming || tab.resolvingTarget || tab.refreshing || tab.changingTransaction || cellWritePending(tab));
  const page = (tab.paging?.page ?? browse.page) + 1;
  refs.pageLabel.textContent = paging ? `加载第 ${page} 页…` : `第 ${page} 页`;
  refs.pageJumpToggle.title = `每页 ${browse.pageSize} 行 · 点击跳转到指定页`;
  refs.pageJumpToggle.disabled = busy;
  refs.previousPage.disabled = browse.page === 0 || busy;
  refs.nextPage.disabled = !browse.hasNext || busy;
  if (refs.pageJumpInput.dataset.tabId !== tab.id || document.activeElement !== refs.pageJumpInput) refs.pageJumpInput.value = String(page);
  refs.pageJumpInput.dataset.tabId = tab.id;
  refs.pageJumpInput.disabled = refs.pageJumpButton.disabled = busy;
}
function trimResultMemory(current) {
  const tabs = selectResultsToRelease(state.tabs, {
    currentTab: current, activeTab: activeTab(),
    isProtected: tab => Boolean(resultGrid.getCellEditDraft(tab.result.rows)),
  });
  for (const oldest of tabs) {
    oldest.result = emptyResult();
    oldest.executionSummary = null;
    oldest.gridState = null;
    oldest.resultReleased = true;
    oldest.message = oldest.redisKey != null ? '此 Key 的预览缓存已释放，再次打开会自动读取。'
      : driverForTab(oldest) === 'redis' ? '命令结果缓存已释放，命令已保留。重新执行可加载结果。'
        : '已释放此查询的结果内存，SQL 已保留。重新执行可加载结果。';
    oldest.outputTab = oldest.redisKey != null ? 'result' : 'message';
  }
}

let executionDetails = null;
function openExecutionDetails(trigger, sql, failure) {
  executionDetails = { trigger, pointerDismissal: false };
  refs.executionDetailsTitle.textContent = failure
    ? failure.unknown ? "执行结果未知" : "执行失败"
    : "查看 SQL";
  refs.executionDetailsTarget.textContent = failure?.target || "";
  refs.executionDetailsTarget.hidden = !failure?.target;
  refs.executionDiagnostic.hidden = refs.copyExecutionError.hidden = !failure;
  refs.executionErrorMessage.textContent = failure?.detail || "";
  refs.executionDetailsSql.textContent = sql;
  trigger.focus({ preventScroll: true });
  refs.executionDetailsModal.showModal();
  refs.executionDetailsBody.scrollTop = 0;
}

function renderSummaryPreview(cell, text, label, onOpen) {
  const preview = document.createElement("div");
  preview.className = "summary-preview";
  setSelectableText(preview, text).title = text;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => onOpen(button));
  preview.append(button);
  cell.append(preview);
}

function renderExecutionSummary(summary) {
  refs.executionSummary.hidden = !summary;
  refs.queryMessage.hidden = Boolean(summary);
  if (state.renderedExecutionSummary === summary) return;
  state.renderedExecutionSummary = summary;
  refs.executionSummaryRows.replaceChildren();
  refs.executionSummary.classList.toggle("has-failure", Boolean(summary?.failure));
  if (!summary) return;
  const rows = document.createDocumentFragment();
  const failure = summary.failure;
  for (const [index, statement] of summary.statements.entries()) {
    const { sql, elapsed_ms, row_count, has_result_set, truncated } = statement;
    const row = document.createElement("tr");
    rows.append(row);
    row.insertCell().textContent = failure ? String(failure.number ?? "—") : String(index + 1);
    renderSummaryPreview(row.insertCell(), sql, "查看 SQL", button => openExecutionDetails(button, sql));
    row.insertCell().textContent = `${Number(elapsed_ms).toFixed(1)} ms`;
    const status = row.insertCell();
    if (failure) {
      status.textContent = failure.unknown ? "结果未知" : "失败";
      status.className = failure.unknown ? "summary-unknown" : "summary-failure";
      // Keep the server's diagnostic and code visible in the compact result cell.
      const diagnostic = failure.number == null ? failure.message
        : failure.message.replace(/^第 \d+ 条 (?:MySQL )?SQL 执行失败(?:[:：]\s*(?:Server error:\s*)?)?/u, "");
      renderSummaryPreview(row.insertCell(), diagnostic, "详情", button => openExecutionDetails(button, sql, failure));
      continue;
    }
    status.textContent = "成功";
    status.className = "summary-success";
    const transactionOutcome = index === summary.statements.length - 1 && summary.outcome;
    const outcome = statement.outcome || (row_count == null ? transactionOutcome || "已执行"
      : has_result_set ? truncated ? `已加载 ${row_count} 行（结果已截断）` : `返回 ${row_count} 行`
        : `影响 ${row_count} 行`);
    setSelectableText(row.insertCell(), outcome).title = outcome;
  }
  refs.executionSummaryRows.append(rows);
  refs.messagePanel.scrollTop = 0;
}

function renderOutput() {
  if (refs.locateColumn) refs.locateColumn.disabled = !activeTab()?.result?.columns?.length || (activeTab()?.outputTab || 'result') !== 'result' || Boolean(state.redisConsole);
  resultControls.close();
  refs.resultSelection.hidden = true;
  refs.saveTableChanges.hidden = refs.discardTableChanges.hidden = true;
  refs.dataImportButton.disabled = true;
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
    renderExecutionSummary(null);
    refs.resultFilter.hidden = true;
    refs.resultCount.textContent = "—";
    refs.resultMeta.textContent = "尚未打开查询";
    refs.resultMeta.classList.remove("error", "summary-unknown");
    refs.copyResults.disabled = refs.exportResults.disabled = true;
    refs.resultMore.disabled = true;
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
  const sqlQuery = isSqlQueryTab(tab);
  resultGrid.viewport.setAttribute("aria-readonly", String(tab.mode !== "write" || (!tab.browse && !result.editTable && !tab.redisKey)));
  const mode = tab.structureOnly ? "structure" : tab.outputTab === "message" ? "message" : "result";
  const summary = mode === "message" ? tab.executionSummary || null : null;
  renderWorkspaceMode(tab);
  for (const button of [refs.dataImportButton, refs.resultMore, refs.locateColumn]) button.hidden = mode !== 'result';
  const filter = (tab.filter || "").trim().toLowerCase();
  refs.resultFilter.value = tab.filter || "";
  for (const [key, name] of [
    ["resultTab", "result"],
    ["messageTab", "message"],
  ]) {
    refs[key].classList.toggle("active", mode === name);
    refs[key].setAttribute("aria-selected", String(mode === name));
    refs[key].tabIndex = mode === name ? 0 : -1;
  }
  refs.emptyActions.hidden = true;
  refs.welcomeFeatures.hidden = true;
  const loadingBrowse = Boolean(tab.opening && tab.browse && !result.executed);
  refs.resultEmpty.dataset.state = tab.running ? "running" : tab.error ? "error" : "idle";
  refs.emptyNextAction.hidden = loadingBrowse || result.columns.length > 0 || (result.executed && !tab.error);
  const emptyAction = emptyResultAction(tab);
  refs.emptyNextAction.textContent = emptyAction.label;
  refs.emptyNextAction.disabled = Boolean(emptyAction.disabled);
  refs.resultEmpty.hidden = mode !== "result" || result.columns.length > 0;
  refs.resultEmpty.querySelector("h2").textContent = tab.running
    ? "查询执行中…"
    : loadingBrowse ? "正在加载表数据…"
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
    : loadingBrowse ? "正在读取表结构和数据。"
    : tab.cancelled
      ? "可以修改 SQL 后重新执行。"
    : tab.error
      ? tab.executionSummary?.failure ? "在摘要页查看错误详情。" : "在消息页查看错误详情。"
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
  const rowStatus = sqlQuery ? (filtered ? " · 已过滤" : "")
    : ` · ${result.rowCount} 行${filtered ? ` · 已过滤为 ${count} 行（已加载数据）` : ""}`;
  refs.resultMeta.textContent = result.schemaChanged ? "表结构已改变，请刷新数据后继续编辑"
    : result.transactionOutcomeUnknown
    ? `${result.writeOutcomeUnknown ? "写入" : "事务"}结果未知 · 请刷新并核对数据库`
    : result.transactionRolledBack
    ? "事务已回滚 · 当前结果已失效，请刷新数据"
    : tab.running
    ? `${source} · 执行中…`
    : tab.refreshing
      ? `${source} · 刷新中…`
    : tab.cancelled
      ? `${source} · 查询已取消`
    : tab.error
      ? tab.executionSummary?.failure
        ? `${tab.executionSummary.failure.unknown ? "执行结果未知" : "执行失败"} · ${summary ? `${summary.elapsedMs.toFixed(1)} ms` : "查看摘要"}`
        : `${source} · 查询失败，查看消息`
      : summary
        ? `${summary.count} 条语句 · ${Number(summary.elapsedMs || 0).toFixed(1)} ms${summary.outcome ? ` · ${summary.outcome}` : ""}`
      : !result.executed
        ? "尚未执行查询"
        : `${sqlQuery ? "" : `${source} · `}${Number(result.elapsedMs || 0).toFixed(1)} ms${rowStatus}${result.truncated ? !tab.redisKey && driverForTab(tab) === "redis" ? " · 当前为部分输出，复制/导出仅包含预览" : result.truncatedReason === 'redis_result_size' ? ' · 当前值已截断，仅可查看/导出预览；请分段读取' : result.truncatedReason === 'redis_preview' ? ` · 当前为部分预览${Number.isFinite(tab.redisTotalCount) ? `（共 ${tab.redisTotalCount} 项）` : ''}，可在控制台继续读取` : ` · 已达${result.truncatedReason === "result_size" ? " 8 MiB" : " 1000 行"}上限` : ""}${tab.browse?.orderNotice ? ` · ${tab.browse.orderNotice}` : ""}`;
  refs.resultMeta.title = refs.resultMeta.textContent;
  if (driverForTab(tab) === 'redis' && tab.redisKey != null && result.executed && !tab.error) {
    const ttl = tab.redisTtl;
    const ttlLabel = ttl === -1 ? '无过期时间' : ttl === -2 ? 'Key 已不存在' : Number.isFinite(ttl) ? `TTL ${ttl} 秒（读取时）` : '';
    refs.resultMeta.textContent += ` · ${redisKeyTypePresentation(tab.redisType).label}${ttlLabel ? ` · ${ttlLabel}` : ''}`;
    refs.resultMeta.title = refs.resultMeta.textContent;
  }
  refs.resultMeta.classList.toggle("error", Boolean(tab.error || result.transactionRolledBack || result.transactionOutcomeUnknown || result.schemaChanged));
  refs.resultMeta.classList.toggle("summary-unknown", Boolean(tab.executionSummary?.failure?.unknown));
  renderExecutionSummary(summary);
  setSelectableText(refs.queryMessage, tab.message || "执行查询后显示数据库消息");
  refs.copyResults.disabled = refs.exportResults.disabled =
    mode !== "result" || !result.columns.length;
  refs.resultMore.disabled = refs.copyResults.disabled;
  const transferDriver = driverForTab(tab);
  const transferTable = Boolean(tab.browse && ["table", "partitioned_table"].includes(tab.browse.kind) && ["postgres", "mysql"].includes(transferDriver));
  refs.resultMoreMenu.querySelectorAll('[data-export-format]').forEach(button => {
    button.disabled = refs.copyResults.disabled || (button.dataset.exportFormat === "sql" && !transferTable);
    if (button.dataset.exportFormat === "sql") button.title = transferTable ? "导出 INSERT 语句" : "请从数据表导出 SQL";
  });
  refs.dataImportButton.disabled = !tab.connectionId || !["postgres", "mysql"].includes(transferDriver) || Boolean(tab.running || tab.paging || tab.refreshing || cellWritePending(tab));
  refs.dataImportMenu.querySelectorAll('[data-import-format]').forEach(button => {
    button.disabled = button.dataset.importFormat !== "sql" && (!transferTable || tab.mode !== "write" || tab.result.transactionRolledBack || tab.result.transactionOutcomeUnknown);
  });
  refs.resultSelection.hidden = mode !== "result" || !(resultGrid.selected.size || resultGrid.selectedColumns?.size);
  const editableTable = Boolean(
    tab.mode === "write" && tab.browse && ["table", "partitioned_table"].includes(tab.browse.kind),
  );
  const selectedRows = typeof resultGrid.getSelectedRows === "function"
    ? resultGrid.getSelectedRows()
    : [];
  const hasPrimaryKey = Boolean(tab.browse?.primaryKeys?.length);
  refs.saveTableChanges.hidden = refs.discardTableChanges.hidden = mode !== "result" || !(tab.browse || result.editTable || tab.redisKey);
  resultGrid.updateFooter();
  if (refs.newRow) {
    refs.newRow.hidden = !editableTable || mode !== "result";
    refs.newRow.disabled = Boolean(tab.paging || tab.running || tab.refreshing);
  }
  if (refs.editRow) {
    refs.editRow.hidden = !editableTable || !hasPrimaryKey || mode !== "result" || !selectedRows.length;
    refs.editRow.disabled = selectedRows.length !== 1 || Boolean(tab.paging || tab.running || tab.refreshing);
  }
  if (refs.deleteRows) {
    refs.deleteRows.hidden = !editableTable || !hasPrimaryKey || mode !== "result";
    refs.deleteRows.disabled = selectedRows.length === 0 || Boolean(tab.paging || tab.running || tab.refreshing);
  }
  if (mode === "structure") {
    if (tab.structure && (state.structureRendered?.details !== tab.structure || state.structureRendered?.tab !== tab)) {
      renderStructure(tab.structure, tab);
      state.structureRendered = { details: tab.structure, tab };
    } else if (!tab.structure) {
      renderStructureLoading(
        tab.structureError ||
          structurePlaceholder(tab),
      );
      state.structureRendered = null;
    }
    refs.structurePanel.setAttribute("aria-busy", String(Boolean(tab.structurePending)));
    const status = refs.structurePanel.querySelector(".structure-refresh-status");
    if (status) {
      status.textContent = tab.structureError ? `刷新失败：${tab.structureError} · 当前显示上次加载的${structureNoun(tab.inspectedObject || tab.browse)}` : "";
      status.classList.toggle("error", Boolean(tab.structureError));
    }
  }
  updatePageControls();
}

let structureDefinitionReader;
function renderStructureLoading(title = "选择一个对象查看结构") {
  structureDefinitionReader?.destroy();
  structureDefinitionReader = null;
  const tab = activeTab();
  const object = tab?.inspectedObject || tab?.browse;
  const hint = { function: "参数与定义会按需读取。", procedure: "参数与定义会按需读取。", sequence: "属性与定义会按需读取。", event: "调度与定义会按需读取。" }[object?.kind] || "列、索引、约束与定义会按需读取。";
  refs.structurePanel.innerHTML = `<div class="empty-state"><div class="empty-symbol">◇</div><h2>${escapeHtml(title)}</h2><p>${hint}</p></div>`;
  if (object && tab.structureError && !tab.structurePending) {
    const refresh = document.createElement("button");
    refresh.className = "secondary-btn";
    refresh.innerHTML = `${refreshIcon}<span>刷新${structureNoun(object)}</span>`;
    refresh.addEventListener("click", () => inspectObject(object, { tab, connectionId: object.connectionId || tab.connectionId }));
    refs.structurePanel.querySelector(".empty-state").append(refresh);
  }
}

function queryReferences(tab, text, data) {
  return queryStructureObjects(text, data.objects || [], {
    database: tabDatabase(tab) || data.context.database, schema: tabSchema(tab),
    searchPath: data.context.searchPath || [data.context.defaultSchema].filter(Boolean), driver: driverForTab(tab),
  });
}
// Opens the structure of the one table a SQL text refers to. With none or several, hands over to
// quick open, which already searches every loaded table and shows structure on Shift+Enter.
async function showReferencedStructure() {
  const tab = activeTab();
  if (!tab?.connectionId || driverForTab(tab) === "redis" || tab.console) return;
  const key = queryTargetKey(tab), schema = tabSchema(tab), text = tab.sql;
  const current = () => activeTab() === tab && state.tabs.includes(tab) && queryTargetKey(tab) === key && tabSchema(tab) === schema && tab.sql === text;
  try {
    const data = await loadQueryCatalog(tab);
    if (!current()) return;
    if (!data?.context) throw new Error(data?.error || "无法读取当前查询的执行位置");
    const { referenced, unresolved } = queryReferences(tab, text, data);
    if (referenced.length === 1 && !unresolved.length && !data.objectError) return void openObjectStructureTab(referenced[0], tab.connectionId);
    if (data.objectError) showToast(`部分表列表读取失败：${data.objectError}`, "error");
    else if (referenced.length > 1) showToast(`当前 SQL 引用了 ${referenced.length} 张表，请选择要查看的表（Shift+↵ 查看结构）`);
    objectQuickOpen.open();
  } catch (error) {
    if (current()) showToast(`无法查看结构：${errorText(error)}`, "error");
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
  refs.closeRedisConsole.disabled = false;
  if (redisEditorSessionId !== tab.id) { redisEditor?.reset(tab.sql || ""); redisEditorSessionId = tab.id; }
  else redisEditor?.setValue(tab.sql || "");
  refs.redisConsoleHint.textContent = redisCommandHint(redisEditor?.currentLine() || "") || "输入命令查看参数说明";
  const history = tab.consoleHistory || [];
  refs.redisOutputCount.textContent = history.length;
  refs.redisClearOutput.disabled = !history.length || Boolean(tab.running);
  refs.redisClearEditor.disabled = Boolean(tab.running);
  const renderKey = `${tab.id}:${tab.consoleRevision || 0}`;
  if (refs.redisConsoleOutput.dataset.renderKey === renderKey) return;
  const output = refs.redisConsoleOutput;
  const sameConsole = output.dataset.renderKey?.startsWith(`${tab.id}:`);
  const follow = !sameConsole || output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const scrollTop = output.scrollTop;
  output.dataset.renderKey = renderKey;
  refs.redisConsoleOutput.innerHTML = history.length
    ? history.map((entry, index) => {
      const entryDatabase = entry.database ?? database;
      const notice = [entry.commandTruncated ? '命令过长，历史仅保留前段，不能复用此记录。' : '', consoleOutputNotice(entry)].filter(Boolean).join(' ');
      return `<article class="redis-console-entry${entry.error ? " has-error" : ""}"><div class="redis-entry-header"><span class="redis-entry-status ${entry.pending ? "pending" : entry.error ? "error" : "success"}">${entry.pending ? "执行中" : entry.error ? "失败" : entry.truncated || entry.outputTruncated ? "完成 · 部分输出" : "完成"}</span><span class="redis-entry-database">DB ${entryDatabase}</span><span class="redis-entry-meta">${entry.elapsedMs != null ? `${Number(entry.elapsedMs).toFixed(1)} ms` : ""}</span><span class="toolbar-spacer"></span><button type="button" class="quiet-btn" data-redis-reuse="${index}" title="将命令放回编辑器"${entry.commandTruncated ? ' disabled' : ''}>复用</button><button type="button" class="quiet-btn" data-redis-copy="${index}"${entry.pending || entry.outputReleased ? " disabled" : ""}>${entry.truncated || entry.outputTruncated ? '复制预览' : '复制结果'}</button></div><pre class="redis-console-command selectable-text">${escapeHtml(entry.command || "")}</pre>${notice ? `<p class="redis-console-notice">${escapeHtml(notice)}</p>` : ''}${entry.output ? `<pre class="redis-console-result${entry.error ? " error" : ""} selectable-text">${escapeHtml(entry.output)}</pre>` : ""}</article>`;
    }).join("")
    : `<div class="redis-console-empty"><div class="redis-empty-symbol" aria-hidden="true">›_</div><h3>从一条命令开始</h3><p>命令、参数说明和 Key 补全，随输入出现。</p><div class="redis-command-examples"><button type="button" data-redis-example="PING"><code>PING</code><span>检查连接</span></button><button type="button" data-redis-example="INFO server"><code>INFO server</code><span>实例信息</span></button><button type="button" data-redis-example="SCAN 0 MATCH * COUNT 100"><code>SCAN 0</code><span>浏览 Key</span></button></div></div>`;
  output.scrollTop = follow ? output.scrollHeight : scrollTop;
}
function structurePlaceholder(tab) {
  const noun = structureNoun(tab?.inspectedObject || tab?.browse);
  if (tab?.structurePending) return `正在读取 ${tab.inspectedObject?.name || tab.browse?.name || tab.title || "对象"} ${noun}…`;
  if (tab?.structureOnly) return `正在准备 ${tab.inspectedObject?.name || "对象"} 的${noun}`;
  if (tab?.redisKey) return "Redis key 没有表结构";
  if (tab?.browse) return "尚未加载对象结构";
  return "当前查询未绑定对象";
}
function renderStructure(details, tab) {
  structureDefinitionReader?.destroy();
  structureDefinitionReader = null;
  const columns = details.columns || [];
  const nativeColumns = details.mysql && ["table", "partitioned_table"].includes(details.kind) ? mysqlColumns(details) : null;
  const text = value => `<span class="selectable-text">${escapeHtml(value)}</span>`;
  const code = value => `<code class="selectable-text">${escapeHtml(value)}</code>`;
  const properties = entries => `<dl class="object-properties">${entries.map(([label, value]) => `<dt>${label}</dt><dd>${text(value ?? "—")}</dd>`).join("")}</dl>`;
  const sequence = details.sequence;
  const event = details.event;
  const object = tab.inspectedObject || tab.openedObject;
  const routine = isRoutine(details.kind);
  const hasFields = !["function", "procedure", "sequence", "event", "trigger"].includes(details.kind);
  refs.structurePanel.innerHTML = `
    <h2 class="structure-title"><span class="schema-icon"${routine ? ` data-catalog-icon="${details.kind}"` : ""}>${kindIcons[details.kind] || "◇"}</span><span class="structure-title-name selectable-text">${escapeHtml(details.qualifiedName)}</span><span class="structure-kind">${escapeHtml(kindLabels[details.kind] || details.kind)}</span></h2>
    ${details.signature ? `<div class="structure-comment">${text(details.signature)}</div>` : ""}
    ${details.comment ? `<p class="structure-comment">${text(details.comment)}</p>` : ""}
    ${sequence ? properties([
      ["归属列", sequence.ownedBy], ["数据类型", sequence.dataType], ["起始值", sequence.start],
      ["步长", sequence.increment], ["最小值", sequence.min], ["最大值", sequence.max],
      ["缓存", sequence.cache], ["循环", sequence.cycle ? "是" : "否"],
      ["最近记录值", sequence.lastValue ?? "不可用"],
    ]) : ""}
    ${event ? properties([
      ["事件状态", ({ ENABLED: "启用", DISABLED: "停用", SLAVESIDE_DISABLED: "副本停用", REPLICA_SIDE_DISABLED: "副本停用" })[event.status] || event.status],
      ["事件调度器", event.scheduler], ["调度规则", event.schedule], ["时区", event.timeZone],
      ["开始时间", event.starts], ["结束时间", event.ends],
    ]) : ""}
    ${details.autoIncrement != null ? properties([["AUTO_INCREMENT（读取时）", details.autoIncrement]]) : ""}
    ${hasFields ? "" : details.definition ? (routine ? '<div class="routine-definition"></div>' : `<pre class="definition">${text(details.definition)}</pre>`) : routine ? '<p class="structure-comment">当前账号无法读取例程定义。</p>' : ""}`;
  if (hasFields) {
    const fields = document.createElement("div");
    fields.innerHTML = `<table class="structure-table"><thead><tr><th>名称</th><th>类型</th><th>可为空</th><th>默认值</th><th>备注</th></tr></thead><tbody>
      ${columns.map((c, index) => `<tr><td>${code(c.name)}${c.primaryKey ? '<span class="pk-badge">PK</span>' : ""}</td><td>${text(c.dataType)}</td><td>${text(c.nullable ? "是" : "否")}</td><td>${code(nativeColumns?.get(c.name)?.defaultValue || c.defaultValue || "—")}${c.sequence ? ` <button type="button" class="quiet-btn" data-column-sequence="${index}" title="${escapeHtml(c.sequence.name)}" aria-label="${escapeHtml(`查看 ${c.name} 的序列`)}">查看序列</button>` : ""}</td><td>${text(c.comment || "—")}</td></tr>`).join("") || '<tr><td colspan="5">此对象没有列信息</td></tr>'}
    </tbody></table>`;
    mountStructureTabs(refs.structurePanel, [
      { id: "fields", label: "字段", content: fields },
      ...structureMetadataTabs(details, driverForTab(tab), {
        showTrigger: (trigger) => void showObjectDdl({ ...trigger, schema: details.schema || object?.schema, kind: "trigger", database: object?.database || tabDatabase(tab) }, tab),
      }),
    ], {
      selected: tab.structureCategory,
      onSelect: (category) => { tab.structureCategory = category; },
    });
  }
  const routineDefinition = refs.structurePanel.querySelector(".routine-definition");
  if (routineDefinition) {
    routineDefinition.style.height = `min(48dvh, ${Math.max(160, details.definition.split("\n").length * 23 + 28)}px)`;
    structureDefinitionReader = createValueReader(routineDefinition, { label: "SQL 定义" });
    structureDefinitionReader.show(details.definition, { sqlDriver: driverForTab(tab) });
  }
  for (const button of refs.structurePanel.querySelectorAll('[data-column-sequence]')) {
    button.addEventListener('click', () => openObjectStructureTab({
      ...columns[Number(button.dataset.columnSequence)].sequence, kind: 'sequence', database: object?.database || tabDatabase(tab),
    }, tab.connectionId));
  }
  const toolbar = document.createElement("div");
  toolbar.className = "structure-actions";
  if (object) {
    if (["table", "partitioned_table"].includes(details.kind)) {
      const edit = document.createElement("button");
      edit.className = "primary-btn";
      edit.textContent = "编辑表结构";
      edit.dataset.editStructure = "";
      edit.addEventListener("click", () => editTableStructure(activeTab()));
      toolbar.append(edit);
    }
    const target = { type: 'object', object, connectionId: tab.connectionId };
    const routineActions = [
      ...(details.definition ? [["编辑定义", () => editRoutine(target), true, "data-edit-routine"]] : []),
      ["生成调用 SQL", () => openRoutineCall(target)],
    ];
    const actions = ({
      view: [["编辑视图定义…", () => editView(target)]],
      materialized_view: [["刷新物化视图…", () => refreshMaterializedView(target)]],
      function: routineActions,
      procedure: routineActions,
    })[details.kind] || [];
    for (const [label, run, primary, marker] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = primary ? 'primary-btn' : 'secondary-btn';
      button.textContent = label;
      if (marker) button.setAttribute(marker, '');
      button.addEventListener('click', run);
      toolbar.append(button);
    }
  }
  refs.structurePanel.prepend(toolbar);
  const status = document.createElement("span");
  status.className = "structure-refresh-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  toolbar.append(status);
}
async function inspectObject(object, { connectionId = state.activeConnectionId, tab = activeTab(), prefetched = null } = {}) {
  if (!tab) return openObjectStructureTab(object, connectionId);
  const previous = tab.inspectedObject || tab.browse;
  const sameObject = previous && previous.id === object.id && previous.kind === object.kind &&
    (previous.connectionId || tab.connectionId) === connectionId &&
    (previous.database || tabDatabase(tab)) === (object.database || tabDatabase(tab));
  if (sameObject && tab.structurePending) return false;
  const previousStructure = sameObject ? tab.structure : null;
  const request = ++state.structureRequest;
  tab.structureNeedsReload = false;
  tab.structureRequest = request;
  tab.inspectedObject = { ...object, connectionId };
  state.selectedObject = object;
  refs.objectSelection.textContent = `${object.schema}.${object.name}`;
  tab.outputTab = "structure";
  tab.structurePending = true;
  tab.structure = previousStructure;
  tab.structureError = null;
  if (activeTab() === tab) renderOutput();
  if (previousStructure && activeTab() === tab && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    refs.structurePanel.getAnimations().forEach(animation => animation.cancel());
    refs.structurePanel.animate(
      [{ opacity: 1 }, { opacity: 0.88, offset: 0.4 }, { opacity: 1 }],
      { duration: 160, easing: "ease-out" },
    );
  }
  let pending;
  try {
    pending = prefetched || call("get_object_details", {
      connectionId,
      objectId: object.id,
      kind: object.kind,
      database: object.database,
    });
    tab.structureLoad = pending;
    const details = await pending;
    if (tab.structureRequest === request) {
      // Keep the same DOM, text selection and scroll position for unchanged metadata.
      tab.structure = previousStructure && JSON.stringify(previousStructure) === JSON.stringify(details) ? previousStructure : details;
      if (tab.browse && tab.browse.id === object.id && ['table', 'partitioned_table'].includes(tab.browse.kind)) {
        tab.browse.columns = details.columns || [];
        tab.browse.primaryKeys = tab.browse.columns.filter(column => column.primaryKey).map(column => column.name);
        tab.browse.detailsLoaded = true;
        tab.browse.engine = details.mysql?.engine || null;
      }
      tab.structurePending = false;
      if (activeTab() === tab) {
        const view = previousStructure && tab.outputTab === "structure"
          ? { top: refs.structurePanel.scrollTop, left: refs.structurePanel.scrollLeft } : null;
        renderTabs();
        renderOutput();
        if (view) {
          refs.structurePanel.scrollTop = view.top;
          refs.structurePanel.scrollLeft = view.left;
          showToast("已刷新", "info", 1200);
        }
      }
      return true;
    }
  } catch (error) {
    if (tab.structureRequest !== request) return false;
    tab.structurePending = false;
    tab.structureError = errorText(error);
    if (activeTab() === tab) {
      renderOutput();
      // Self-contained on purpose: tests evaluate inspectObject in isolation.
      if (previousStructure) showToast(`${({ function: "定义", procedure: "定义", sequence: "详情", event: "详情" })[object.kind] ?? "结构"}刷新失败：${tab.structureError}，已保留上次加载的内容`, "error");
    }
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
function openObjectStructureTab(object, connectionId = state.activeConnectionId, { fromTreeClick = false, prefetched = null, mode } = {}) {
  if (!object) return;
  const target = objectTabTarget(object, connectionId);
  const existing = findObjectTab(target, "structure");
  if (existing) {
    activateTab(existing.id);
    if (!existing.structure && !existing.structurePending) void inspectObject(object, { connectionId, tab: existing, prefetched });
    return existing;
  }
  const tab = addTab("", connectionId, null, {
    database: object.database,
    schema: object.schema,
    title: isRoutine(object.kind) ? object.name : detailNouns[object.kind] ? `${detailNouns[object.kind]} · ${object.name}` : `结构 · ${object.name}`,
    openedObject: target,
    openedObjectView: "structure",
    mode,
  });
  if (!tab) return;
  if (fromTreeClick) state.objectClickPreviewId = tab.id;
  tab.outputTab = "structure";
  tab.structureOnly = true;
  renderTabs();
  return inspectObject(object, { connectionId, tab, prefetched }).then(loaded => loaded && tab);
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
  if (target.type === "category") return `${target.schema || target.database} · ${kindLabels[target.kind] || target.kind}`;
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
    actions.add("create-view");
    actions.add("drop-database");
    if (driver === "mysql") actions.add("mysql-characters");
  } else if (target?.type === "schema" && ["postgres", "mysql"].includes(driver)) {
    actions.add("refresh-schema");
    actions.add("new-database-query");
    actions.add("copy-ddl");
    actions.add("create-table");
    actions.add("create-view");
    if (driver === "postgres") actions.add("drop-schema");
  } else if (target?.type === "category") {
    actions.add("refresh-schema");
    if (target.kind === "query") actions.add("save-tree-query");
    if (target.kind === "routine") { actions.add("create-function"); actions.add("create-procedure"); }
    if (target.kind === "materialized_view") actions.add("create-materialized-view");
    if (["table", "partitioned_table", "foreign_table"].includes(target.kind)) actions.add("new-database-query");
    if (["table", "partitioned_table"].includes(target.kind)) actions.add("create-table");
    if (target.kind === "view") actions.add("create-view");
  } else if (target?.type === "object") {
    if (["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(target.object.kind)) {
      actions.add("open-data");
    }
    if (isTable || target.object.kind === "foreign_table") actions.add("new-query");
    actions.add("open-structure");
    actions.add("copy-name");
    if (canViewObjectDdl(target.object) || target.object.kind === 'foreign_table') actions.add("copy-ddl");
    actions.add("refresh-object");
    if (target.object.kind === "view") actions.add("edit-view");
    if (target.object.kind === "materialized_view" && driver === "postgres") actions.add("refresh-matview");
    if (["function", "procedure"].includes(target.object.kind)) { actions.add("edit-routine"); actions.add("call-routine"); }
    if (isTable) {
      actions.add("create-table");
      actions.add("edit-structure");
      actions.add("rename-table");
      actions.add("clear-table");
      actions.add("drop-table");
      if (driver === "mysql") actions.add("mysql-characters");
    }
  }
  for (const button of contextMenuActionButtons()) {
    button.setAttribute("role", "menuitem");
    button.hidden = !actions.has(button.dataset.contextAction);
  }
  refs.objectContextTitle.textContent = contextTargetLabel(target);
  refs.objectContextMenu.querySelector('[data-context-action="refresh-schema"] [data-context-label]').textContent = target?.kind === "query" ? "刷新查询列表" : "刷新对象列表";
  refs.objectContextMenu.querySelector('[data-context-action="open-data"] [data-context-label]').textContent = isTable ? "打开表数据" : "打开数据";
  refs.objectContextMenu.querySelector('[data-context-action="open-structure"] [data-context-label]').textContent = isTable ? "查看表结构" : detailNouns[target?.object?.kind] ? `查看${detailNouns[target.object.kind]}` : "查看结构 / 定义";
  refs.objectContextMenu.querySelector('[data-context-action="copy-ddl"] [data-context-label]').textContent = isTable ? "复制建表 SQL" : "复制 DDL";
  const hasDivider = refs.objectContextMenu?.querySelector("[data-context-divider]");
  if (hasDivider) hasDivider.hidden = !actions.has("copy-ddl");
  refs.objectContextMenu.querySelector("[data-danger-divider]").hidden = !["clear-table", "drop-table", "drop-schema", "drop-database"].some(action => actions.has(action));
}

function contextTableDdl(object, details, driver) {
  return buildTableDdl(object, details, driver);
}

function contextObjectDdl(object, details, driver) {
  if (["table", "partitioned_table", "foreign_table"].includes(object.kind)) return contextTableDdl(object, details, driver);
  const quote = (name) => contextIdentifier(name, driver);
  const qualified = `${quote(object.schema)}.${quote(object.name)}`;
  if (details?.viewDdl) return details.viewDdl;
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
  return "";
}

async function showObjectDdl(object, tab) {
  if ((!canViewObjectDdl(object) && object?.kind !== 'trigger') || !tab?.connectionId) return;
  const connectionId = object.connectionId || tab.connectionId;
  const driver = driverForConnection(connectionId);
  const dialog = document.createElement('dialog');
  dialog.className = 'ddl-view-dialog';
  dialog.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', 'ddlViewTitle');
  dialog.innerHTML = `<div class="dialog-header"><div><h2 id="ddlViewTitle">查看 DDL</h2><p class="ddl-view-target"></p></div><button type="button" class="icon-btn ddl-view-close" aria-label="关闭">×</button></div><details class="ddl-view-info" hidden><summary>DDL 范围说明</summary><p>包含字段、序列、约束、索引及表/列注释。不含数据、权限/所有者、触发器、规则和行级安全策略；依赖的 schema、类型及外部表需已存在。</p></details><div class="ddl-view-tools"><span class="ddl-view-caption">DDL 定义</span><button type="button" class="quiet-btn ddl-view-wrap" aria-pressed="true" disabled>自动换行</button></div><div class="ddl-view-code value-reader"><p class="ddl-view-status" role="status">正在读取 DDL…</p></div><div class="dialog-actions"><button type="button" class="secondary-btn ddl-view-copy" disabled>复制 DDL</button><button type="button" class="primary-btn ddl-view-done">关闭</button></div>`;
  dialog.querySelector('.ddl-view-target').textContent = driver === 'mysql' ? `${object.database || object.schema || tabDatabase(tab)}.${object.name}` : [object.database || tabDatabase(tab), object.qualifiedName || `${object.schema}.${object.name}`].filter(Boolean).join(' · ');
  dialog.querySelector('.ddl-view-info').hidden = driver !== 'postgres' || !['table', 'partitioned_table'].includes(object.kind);
  const code = dialog.querySelector('.ddl-view-code');
  const copy = dialog.querySelector('.ddl-view-copy');
  const wrapButton = dialog.querySelector('.ddl-view-wrap');
  const reader = createValueReader(code, { label: 'DDL 定义' });
  wrapButton.addEventListener('click', () => {
    const wrap = wrapButton.getAttribute('aria-pressed') !== 'true';
    wrapButton.setAttribute('aria-pressed', String(wrap));
    reader.setWrap(wrap);
  });
  for (const close of dialog.querySelectorAll('.ddl-view-close, .ddl-view-done')) close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { reader.destroy(); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  dialog.focus({ preventScroll: true });
  try {
    const details = await call('get_object_ddl_details', { connectionId, objectId: object.id, kind: object.kind, database: object.database || tabDatabase(tab) });
    if (!dialog.open) return;
    const ddl = contextObjectDdl(object, details, driver);
    if (!ddl || ddl.startsWith('-- DDL for ')) throw new Error('当前对象没有可用的 DDL 定义');
    code.replaceChildren();
    // Short definitions should not leave a large empty editor. Long ones keep
    // a bounded scrollable area; wrapping never changes the copied source.
    code.style.height = `min(52dvh, ${Math.min(520, Math.max(180, (ddl.split('\n').length + 2) * 23))}px)`;
    reader.show(ddl, { sqlDriver: driver });
    wrapButton.disabled = false;
    copy.disabled = false;
    copy.addEventListener('click', async () => {
      try { await copyText(reader.getValue()); showToast('已复制 DDL'); }
      catch (error) { showToast(`复制 DDL 失败：${errorText(error)}`, 'error'); }
    });
  } catch (error) {
    if (dialog.open) { code.textContent = `读取 DDL 失败：${errorText(error)}`; code.classList.add('error'); }
  }
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

async function copyContextDdl(target) {
  const driver = target?.driver || contextDriver(target);
  let ddl = "";
  try {
    if (target?.type === "object") {
      const object = target.object;
      const details = await call("get_object_ddl_details", {
        connectionId: target.connectionId || state.activeConnectionId,
        objectId: object.id,
        kind: object.kind,
        database: object.database,
      });
      ddl = contextObjectDdl(object, details, driver);
    } else if (target?.type === "database" && driver === 'mysql') {
      const settings = await call('mysql_character_settings', { connectionId: target.connectionId, database: target.database, table: null });
      if (!settings.defaults) throw new Error('无法读取数据库字符集与排序规则');
      ddl = `CREATE DATABASE ${contextIdentifier(target.database, driver)}${mysqlCharacterClause(settings.defaults.charset, settings.defaults.collation)};`;
    } else if (target?.type === "database") ddl = contextDatabaseDdl(target, driver);
    else if (target?.type === "schema") ddl = contextSchemaDdl(target, driver);
    if (!ddl) throw new Error("当前对象没有可复制的 DDL");
    await copyText(ddl);
    showToast("已复制 DDL");
  } catch (error) {
    showToast(`复制 DDL 失败：${errorText(error)}`, "error");
  }
}

const pendingViewOperations = new Set();
const runningViewWrites = new Set();
function viewOperationTarget(target) {
  const { object, connectionId } = target;
  const profile = state.profiles.find(item => item.id === connectionId);
  const database = object?.database || target.database;
  const schema = object?.schema || target.schema || (profile?.driver === 'mysql' ? database : null);
  return { connectionId, database, schema, profile };
}

function guardViewOperation(location) {
  const { connectionId, database, profile } = location;
  if (!profile || !state.profiles.includes(profile) || state.connectionStatuses[connectionId] !== 'connected') {
    throw new Error('连接已变化或断开，请重新选择目标');
  }
  const tabs = state.tabs.filter(tab => tab.connectionId === connectionId && tabDatabase(tab) === database);
  if (activeTab()?.connectionId === connectionId && tabDatabase(activeTab()) === database && activeTab().mode !== 'write') {
    throw new Error('当前数据库已锁定为只读，请先解锁');
  }
  if (state.transactionKeys.has(transactionKey(connectionId, database)) || tabs.some(tab => tab.changingTransaction)) {
    throw new Error('请先提交或回滚目标数据库的事务');
  }
  if (tabs.some(tab => tab.running || tab.opening || tab.paging || tab.refreshing || cellWritePending(tab))) {
    throw new Error('目标数据库有正在执行的操作，请稍后重试');
  }
  if (runningViewWrites.has(transactionKey(connectionId, database))) throw new Error('目标数据库正在保存或刷新视图');
}

async function applyViewOperation(location, { sql, name, expectedMysqlNoBackslashEscapes }, object, refresh = false, original = null) {
  const { connectionId, database, schema, profile } = location;
  guardViewOperation(location);
  const key = JSON.stringify([connectionId, database, schema, name]);
  if (pendingViewOperations.has(key)) throw new Error('此视图已有操作正在执行');
  pendingViewOperations.add(key);
  const title = refresh ? '刷新物化视图' : object ? '保存视图定义' : '创建视图';
  try {
    const locationLabel = `${profile.name} · ${profile.host}:${profile.port} / ${database} / ${schema}.${name}`;
    const message = refresh ? '重新运行定义查询并替换已存储的结果。刷新期间可能阻塞读取。' : profile.driver === 'mysql' ? 'MySQL 视图 DDL 会隐式提交。' : '将保存此视图定义。';
    if ((refresh || object) && !await confirmAction(`${locationLabel}\n\n${message}`, { title, detail: sql, acceptLabel: title })) return false;
    if (original) {
      const latest = await call('get_object_ddl_details', { connectionId, database, objectId: object.id, kind: object.kind });
      if (latest.definition !== original.definition || latest.viewDdl !== original.viewDdl) throw new Error('数据库中的视图定义已改变，请重新打开编辑窗口');
    }
    guardViewOperation(location);
    const databaseKey = transactionKey(connectionId, database);
    if (refresh) showToast('正在刷新物化视图…');
    runningViewWrites.add(databaseKey);
    try {
      await call('execute_mutation', { request: { connectionId, database, schema, sql,
        queryId: makeId(refresh ? 'refresh-matview' : 'save-view'), readOnly: false,
        outsideTransaction: true, singleStatement: true, expectedMysqlNoBackslashEscapes } });
    } finally { runningViewWrites.delete(databaseKey); }
    try {
      const active = activeTab();
      const matches = candidate => candidate?.schema === schema && candidate.name === name &&
        candidate.kind === (refresh ? 'materialized_view' : 'view');
      const affected = state.tabs.filter(tab => tab.connectionId === connectionId && tabDatabase(tab) === database);
      for (const tab of affected) {
        if (matches(tab.inspectedObject || tab.browse)) {
          tab.structure = null;
          tab.structureError = null;
          tab.structurePending = false;
          tab.structureRequest = ++state.structureRequest;
          tab.structureNeedsReload = true;
        }
        if (matches(tab.browse)) {
          tab.result = emptyResult();
          tab.gridState = null;
          tab.autoLoadPending = true;
        }
      }
      recordHistory(sql, location);
      renderOutput();
      let synced = true;
      if (!refresh) {
        state.queryTargets.delete(transactionKey(connectionId, database));
        state.treeSessions.get(connectionId)?.objectsBySchema.delete(schemaKey(database, schema));
        if (state.activeConnectionId === connectionId) synced = await loadSchemaObjects(database, schema, { force: true });
        updateEditorSchema();
      }
      if (active && activeTab() === active && affected.includes(active)) {
        if (matches(active.browse) && active.outputTab === 'result') {
          active.autoLoadPending = false;
          await loadOpenedObjectData(active);
          synced = synced && active.result.executed;
        } else if (active.outputTab === 'structure' && matches(active.inspectedObject || active.browse)) {
          synced = await inspectObject(active.inspectedObject || active.browse, { connectionId, tab: active }) && synced;
        }
      }
      showToast(synced ? `${title}成功` : `${title}成功，界面刷新失败，请手动刷新`, synced ? 'info' : 'error');
    } catch (error) { showToast(`${title}成功，界面刷新失败：${errorText(error)}`, 'error'); }
    return true;
  } finally {
    pendingViewOperations.delete(key);
  }
}

async function editView(target) {
  if (document.querySelector('.view-editor')) return;
  const location = viewOperationTarget(target);
  const { connectionId, database, profile } = location;
  try {
    guardViewOperation(location);
    if (!location.schema) {
      const queryTarget = await loadQueryTarget({ connectionId, database, schema: null });
      location.schema = queryTarget?.context?.defaultSchema;
      if (!location.schema) throw new Error('没有可用的默认 schema，请从 schema 节点新建视图');
    }
    const details = target.object ? await call('get_object_ddl_details', {
      connectionId, database, objectId: target.object.id, kind: 'view',
    }) : null;
    if (document.querySelector('.view-editor')) return;
    const qualify = name => [location.schema, name].map(part => contextIdentifier(part, profile.driver)).join('.');
    openViewEditor({
      targetLabel: `${profile.name} / ${database} / ${location.schema}`, driver: profile.driver, details, qualify,
      onApply: plan => applyViewOperation(location, plan, target.object, false, details),
    });
  } catch (error) { showToast(errorText(error), 'error'); }
}

async function refreshMaterializedView(target) {
  const location = viewOperationTarget(target);
  const { schema } = location;
  const name = target.object.name;
  const qualified = [schema, name].map(quoteIdent).join('.');
  try { await applyViewOperation(location, { name, sql: `REFRESH MATERIALIZED VIEW ${qualified};` }, target.object, true); }
  catch (error) { showToast(`刷新物化视图失败：${errorText(error)}`, 'error'); }
}

async function openRoutineCall(target) {
  const { connectionId, object } = target;
  const driver = contextDriver(target);
  try {
    const details = await call('get_object_ddl_details', { connectionId, database: object.database, objectId: object.id, kind: object.kind });
    if (!Array.isArray(details.parameters)) throw new Error('当前账号无法读取例程参数');
    if (driver === 'postgres' && /^\s*RETURNS\s+(?:trigger|event_trigger)\b/im.test(details.definition || '')) {
      throw new Error('此函数由触发器调用');
    }
    const qualified = [object.schema, object.name].map(part => contextIdentifier(part, driver)).join('.');
    const mysqlOut = [];
    const args = details.parameters.map((param, index) => {
      if (driver === 'mysql' && param.mode !== 'IN') {
        const variable = `@arg_${index + 1}`;
        mysqlOut.push({ variable, mode: param.mode });
        return variable;
      }
      if (driver === 'mysql' || param.mode === 'OUT') return 'NULL';
      return `${param.mode === 'VARIADIC' ? 'VARIADIC ' : ''}NULL::${param.dataType}`;
    });
    const invocation = `${object.kind === 'procedure' ? 'CALL' : 'SELECT'} ${qualified}(${args.join(', ')});`;
    const setup = mysqlOut.filter(arg => arg.mode === 'INOUT').map(arg => `SET ${arg.variable} = NULL;\n`).join('');
    const output = mysqlOut.length ? `\nSELECT ${mysqlOut.map(arg => arg.variable).join(', ')};` : '';
    const sql = `${args.length ? '-- 将输入参数的 NULL 替换为实际值。\n' : ''}${setup}${invocation}${output}`;
    addTab(sql, connectionId, null, { database: object.database, schema: object.schema, title: `调用 · ${object.name}` });
    state.editor?.focus();
  } catch (error) { showToast(`生成调用 SQL 失败：${errorText(error)}`, 'error'); }
}

async function editRoutine(target) {
  if (document.querySelector('.routine-editor')) return;
  const { object } = target;
  const label = routineKindLabels[object?.kind];
  if (!label) return;
  const location = viewOperationTarget(target);
  const { connectionId, database, profile } = location;
  try {
    guardViewOperation(location);
    const details = await call('get_object_ddl_details', { connectionId, database, objectId: object.id, kind: object.kind });
    if (!details?.definition?.trim()) throw new Error(`当前账号无法读取${label}定义，不能编辑`);
    if (document.querySelector('.routine-editor')) return;
    const driver = profile.driver;
    const quoteIdentifier = name => contextIdentifier(name, driver);
    openRoutineEditor({
      kind: object.kind, driver,
      targetLabel: `${profile.name} / ${database}${driver === 'mysql' ? '' : ` / ${location.schema}`} · ${object.name}`,
      definition: details.definition.replace(/\s+$/, ''),
      plan: edited => buildRoutineEdit({
        driver, kind: object.kind, schema: location.schema, name: object.name, original: details.definition, edited, quoteIdentifier,
      }),
      confirmDiscard: () => confirmAction(`放弃尚未保存的${label}修改？`, { title: '放弃修改', acceptLabel: '放弃修改' }),
      onApply: plan => applyRoutineEdit(location, object, details, plan),
    });
  } catch (error) { showToast(errorText(error), 'error'); }
}

async function applyRoutineEdit(location, object, original, plan) {
  const { connectionId, database, schema, profile } = location;
  const label = routineKindLabels[object.kind];
  guardViewOperation(location);
  const key = JSON.stringify([connectionId, database, schema, object.kind, object.name]);
  if (pendingViewOperations.has(key)) throw new Error(`此${label}已有保存操作正在执行`);
  pendingViewOperations.add(key);
  const mysql = profile.driver === 'mysql';
  const run = (sql, prefix) => call('execute_mutation', { request: {
    connectionId, database, schema, sql, queryId: makeId(prefix), readOnly: false,
    outsideTransaction: true, singleStatement: plan.singleStatement,
    ...(mysql ? mysqlSqlModeExpectation(sql, original.mysql?.sqlMode) : {}),
  } });
  const fetchDefinition = () => call('get_object_ddl_details', { connectionId, database, objectId: object.id, kind: object.kind });
  try {
    const where = `${profile.name} · ${profile.host}:${profile.port} / ${database} / ${schema}.${object.name}`;
    const summary = mysql
      ? `MySQL 会先删除再重建这个${label}，DDL 会隐式提交，不能回滚；创建失败时会尝试恢复原定义。`
      : `将用 CREATE OR REPLACE 替换这个${label}，在一个事务内完成。`;
    const notice = plan.warnings.length ? `\n\n注意：\n${plan.warnings.join('\n')}` : '';
    if (!await confirmAction(`${where}\n\n${summary}${notice}`, { title: `保存${label}`, detail: plan.preview, acceptLabel: `保存${label}` })) return false;
    const latest = await fetchDefinition();
    if (latest.definition !== original.definition) throw new Error(`数据库中的${label}定义已被修改，请关闭后重新打开编辑窗口`);
    guardViewOperation(location);
    const databaseKey = transactionKey(connectionId, database);
    runningViewWrites.add(databaseKey);
    try {
      try { await run(plan.sql, 'save-routine'); }
      catch (failure) {
        if (!plan.restore.length) throw failure;
        // The DROP may already have committed. Put the original back before reporting.
        let present = null;
        try { present = await fetchDefinition(); } catch { /* treated as missing */ }
        if (present?.definition === original.definition) throw new Error(`${errorText(failure)}\n\n原${label}未被改动。`);
        if (present?.definition) throw new Error(`${errorText(failure)}\n\n${label}的当前定义与保存前不同，请核对后再处理。`);
        let restored = -1;
        for (const [index, script] of plan.restore.entries()) {
          try { await run(script, 'restore-routine'); restored = index; break; }
          catch { /* try the next form of the original definition */ }
        }
        if (restored >= 0) throw new Error(`${errorText(failure)}\n\n已自动恢复原${label}${restored ? '（DEFINER 已改为当前账号）' : ''}。`);
        addTab(original.definition, connectionId, null, { database, schema, title: `原定义 · ${object.name}` });
        throw new Error(`${errorText(failure)}\n\n无法确认原${label}是否仍然存在，原定义已放入新的查询标签，请核对后处理。`);
      }
    } finally { runningViewWrites.delete(databaseKey); }
    try {
      const active = activeTab();
      const matches = candidate => candidate?.schema === schema && candidate.name === object.name && candidate.kind === object.kind;
      const affected = state.tabs.filter(tab => tab.connectionId === connectionId && tabDatabase(tab) === database && matches(tab.inspectedObject));
      for (const tab of affected) {
        tab.structure = null;
        tab.structureError = null;
        tab.structurePending = false;
        tab.structureRequest = ++state.structureRequest;
        tab.structureNeedsReload = true;
      }
      recordHistory(plan.sql, location);
      renderOutput();
      state.treeSessions.get(connectionId)?.objectsBySchema.delete(schemaKey(database, schema));
      let synced = state.activeConnectionId !== connectionId || await loadSchemaObjects(database, schema, { force: true });
      if (active && activeTab() === active && affected.includes(active) && active.outputTab === 'structure') {
        synced = await inspectObject(active.inspectedObject, { connectionId, tab: active }) && synced;
      }
      showToast(synced ? `${label}已保存` : `${label}已保存，界面刷新失败，请手动刷新`, synced ? 'info' : 'error');
    } catch (error) { showToast(`${label}已保存，界面刷新失败：${errorText(error)}`, 'error'); }
    return true;
  } finally {
    pendingViewOperations.delete(key);
  }
}

async function showMysqlCharacterSettings(target) {
  const database = target.object?.database || target.database;
  const table = target.type === 'object' ? target.object.name : null;
  try {
    const data = await call('mysql_character_settings', { connectionId: target.connectionId, database, table });
    const dialog = document.createElement('dialog'); dialog.className = 'redis-operation-dialog';
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.textContent = '字符集和排序规则';
    const info = document.createElement('pre'); info.className = 'selectable-text';
    const lines = [`数据库 ${database}：${data.defaults?.charset || '未知'} / ${data.defaults?.collation || '未知'}`];
    if (table) {
      lines.push(`表 ${target.object.schema}.${table}：${data.tableCharset || '未知'} / ${data.tableCollation || '未知'}`, '', '字符列：');
      for (const column of data.columns || []) lines.push(`${column.name}：${column.charset} / ${column.collation}`);
      if (!data.columns?.length) lines.push('没有字符列，或没有权限查看');
    }
    info.textContent = lines.join('\n');
    const close = document.createElement('button'); close.textContent = '关闭'; close.className = 'secondary-btn';
    form.append(title, info, close); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  } catch (error) { showToast(`读取字符集失败：${errorText(error)}`, 'error'); }
}

const pendingTableClears = new Set();
async function clearTableData(context, method) {
  const target = { ...context, object: { ...context.object } };
  const driver = target.driver || contextDriver(target);
  const connectionId = target.connectionId;
  const database = target.object.database || target.database;
  const profile = state.profiles.find(item => item.id === connectionId);
  const endpoint = profile && JSON.stringify([profile.driver, profile.host, profile.port, profile.user, profile.database]);
  const key = JSON.stringify([connectionId, database, target.object.schema, target.object.name]);
  if (pendingTableClears.has(key)) return;
  const guard = () => {
    const current = state.profiles.find(item => item.id === connectionId);
    if (!current || JSON.stringify([current.driver, current.host, current.port, current.user, current.database]) !== endpoint || state.connectionStatuses[connectionId] !== 'connected') throw new Error('连接已变化或断开，请重新选择目标');
    if (state.transactionKeys.has(transactionKey(connectionId, database))) throw new Error('请先提交或回滚目标数据库的事务');
    if (state.tabs.some(tab => tab.connectionId === connectionId && tabDatabase(tab) === database && (tab.running || tab.changingTransaction || tab.cellSaving || tab.cellBatchSaving || (tab.result?.rows && resultGrid.getCellEditDraft(tab.result.rows))))) throw new Error('目标数据库有正在执行的操作或未保存的单元格修改，请先处理');
  };
  let plan;
  try { guard(); plan = clearTablePlan(target, method, driver); }
  catch (error) { showToast(`无法清空表：${errorText(error)}`, 'error'); return; }
  pendingTableClears.add(key);
  try {
      if (!await confirmAction(`${profile.name} · ${profile.host}:${profile.port} / ${database} / ${plan.schema}.${plan.name}\n\n${plan.description}\n\n此操作会删除数据，确认继续？`, { title: '确认清空表数据', detail: plan.sql, acceptLabel: '确认清空' })) return;
      guard();
      await call('execute_mutation', { request: { connectionId, database, schema: plan.schema, sql: plan.sql, queryId: makeId('clear-table'), readOnly: false } });
      try {
        for (const tab of state.tabs) {
          if (tab.connectionId !== connectionId || tabDatabase(tab) !== database) continue;
          if (tab.browse?.id !== target.object.id && tab.inspectedObject?.id !== target.object.id && tab.openedObject?.id !== target.object.id) continue;
          tab.result = emptyResult(); tab.gridState = null; tab.message = '清空操作已执行，请刷新数据核对。';
        }
        renderTabs(); renderOutput();
        showToast('清空操作已执行，请刷新数据核对');
      } catch {
        showToast('清空操作已执行，但界面更新失败；请刷新核对，不要重复执行', 'error');
      }
  } catch (error) { showToast(`清空表数据失败：${errorText(error)}`, 'error'); }
  finally { pendingTableClears.delete(key); }
}

const pendingDatabaseDeletes = new Set();
async function deleteDatabaseObject(target, action) {
  const driver = target.driver || contextDriver(target);
  const connectionId = target.connectionId;
  const database = target.object?.database || target.database;
  const name = action === 'drop-table' ? target.object?.name : action === 'drop-schema' ? target.schema : database;
  const profile = state.profiles.find(item => item.id === connectionId);
  const pendingKey = JSON.stringify([connectionId, action, database, name]);
  if (pendingDatabaseDeletes.has(pendingKey)) return;
  pendingDatabaseDeletes.add(pendingKey);
  try {
    const plan = objectActionPlan(target, action, name, driver);
    const guard = () => {
      if (state.connectionStatuses[connectionId] !== 'connected') throw new Error('连接已断开，请重新连接');
      if (state.transactionKeys.has(transactionKey(connectionId, database)) || (action === 'drop-database' && [...state.transactionKeys].some(key => key.startsWith(`${connectionId}\u0000`)))) throw new Error('请先提交或回滚连接中的事务');
      if (state.tabs.some(tab => tab.connectionId === connectionId && tabDatabase(tab) === database && (tab.running || tab.changingTransaction || tab.cellSaving || tab.cellBatchSaving || resultGrid.getCellEditDraft(tab.result?.rows)))) throw new Error('目标数据库有正在执行的操作或未保存的单元格修改，请先处理');
      if (action === 'drop-database' && profile?.database === database) throw new Error('不能删除连接配置中的默认数据库，请先修改连接配置并重新连接');
    };
    guard();
    const description = action === 'drop-database' ? `数据库 ${database} 中的表及数据将被删除。` : action === 'drop-schema' ? `将删除数据库 ${database} 中的 schema ${name}。仅允许删除空 schema；如果存在对象或依赖，数据库会拒绝删除。` : `表 ${plan.schema}.${name} 及其数据将被删除。`;
    if (!await confirmAction(`${profile?.name || connectionId} · ${profile?.host || ''}:${profile?.port || ''}\n${description}此操作不可恢复。${driver === 'mysql' ? ' MySQL DDL 会隐式提交。' : ''}`, { title: plan.label, detail: plan.sql, acceptLabel: plan.label })) return;
    guard();
    if (action === 'drop-database' && driver === 'postgres') await call('release_postgres_catalog', { connectionId, database });
    const executionDatabase = action === 'drop-database' ? profile.database : database;
    await call('execute_mutation', { request: { connectionId, database: executionDatabase, schema: action === 'drop-table' ? plan.schema : null, sql: plan.sql, queryId: makeId(action), readOnly: false } });
    // The destructive statement has succeeded. Never imply a refresh failure
    // means the user should run it again.
    for (const tab of state.tabs) {
      if (tab.connectionId !== connectionId || tabDatabase(tab) !== database) continue;
      if (action === 'drop-schema' && tabSchema(tab) !== name && tab.browse?.schema !== name && tab.inspectedObject?.schema !== name && tab.openedObject?.schema !== name) continue;
      if (action === 'drop-table' && tab.browse?.id !== target.object.id && tab.inspectedObject?.id !== target.object.id && tab.openedObject?.id !== target.object.id) continue;
      tab.result = emptyResult(); tab.gridState = null; tab.structure = null; tab.structureRequest = ++state.structureRequest;
      tab.message = `${plan.label}已完成；此标签的数据已失效。`; tab.error = true;
    }
    state.treeSessions.delete(connectionId); state.queryTargets.delete(transactionKey(connectionId, database));
    let refreshed = true;
    try {
      if (action === 'drop-database' && driver === 'mysql') await call('release_mysql_database_pool', { connectionId, database });
      if (state.activeConnectionId === connectionId) refreshed = action === 'drop-database' ? await refreshDatabaseList({ connectionId }, { notify: false }) : action === 'drop-schema' ? await loadSchemas(database, connectionId) : await loadSchemaObjects(database, plan.schema, { force: true });
      renderTabs(); renderOutput(); updateEditorSchema();
    } catch { refreshed = false; }
    showToast(plan.success + (refreshed ? '' : '；目录刷新失败，请手动刷新，不要重复执行'), refreshed ? 'info' : 'error');
  } catch (error) { showToast(`${action === 'drop-table' ? '删除表' : action === 'drop-schema' ? '删除 schema' : '删除数据库'}失败：${errorText(error)}`, 'error'); }
  finally { pendingDatabaseDeletes.delete(pendingKey); }
}

async function openContextObjectDialog(target, action) {
  if (action === "create-table") return openCreateTableEditor(target);
  const profile = state.profiles.find((item) => item.id === target.connectionId);
  target = { ...target, database: target.object?.database || target.database || profile?.database || null, object: target.object ? { ...target.object } : null };
  state.pendingObjectCreate = { target, action, driver: target.driver || contextDriver(target), busy: false };
  refs.createObjectCharacterSettings.replaceChildren(); refs.createObjectCharacterSettings.hidden = true;
  if (action === 'create-database' && state.pendingObjectCreate.driver === 'mysql') {
    try {
      const settings = await call('mysql_character_settings', { connectionId: target.connectionId, database: null, table: null });
      if (!state.pendingObjectCreate || state.pendingObjectCreate.target !== target) return;
      const picker = createMysqlCharacterPicker(settings, '继承服务器默认值');
      state.pendingObjectCreate.characterPicker = picker;
      refs.createObjectCharacterSettings.append(picker.element); refs.createObjectCharacterSettings.hidden = false;
      picker.element.addEventListener('change', updateObjectActionPreview);
    } catch (error) { state.pendingObjectCreate = null; showToast(`读取字符集失败：${errorText(error)}`, 'error'); return; }
  }
  const rename = action === "rename-table";
  const kind = action.replace("create-", "");
  const labels = { database: "数据库", schema: "schema", table: "表" };
  refs.createObjectTitle.textContent = rename ? "重命名表" : `新建${labels[kind]}`;
  refs.createObjectNameLabel.textContent = rename ? "新表名" : `${labels[kind]}名称`;
  refs.createObjectContext.textContent = `${profile?.name || ""} / ${target.object?.database || target.database || profile?.database || "服务器"}${rename ? ` / ${target.object.schema}.${target.object.name}` : ""}`;
  refs.createObjectHint.textContent = `点击「${rename ? "重命名" : "创建"}」直接完成${rename ? "重命名" : "创建"}，成功后自动刷新目录。`;
  refs.applyCreateObject.textContent = rename ? "重命名" : "创建";
  refs.createObjectFeedback.textContent = "";
  refs.createObjectPreview.open = false;
  refs.createObjectName.value = rename ? target.object.name : "";
  refs.createObjectName.placeholder = rename ? "new_table_name" : `new_${kind}`;
  refs.createObjectName.setCustomValidity("");
  updateObjectActionPreview();
  refs.createObjectModal.showModal();
  refs.createObjectName.focus();
  if (rename) refs.createObjectName.select();
}

function updateObjectActionPreview() {
  const pending = state.pendingObjectCreate;
  if (!pending) return;
  refs.createObjectFeedback.textContent = "";
  refs.createObjectPreview.hidden = !refs.createObjectName.value.trim();
  try { setSelectableText(refs.createObjectSql, objectActionPlan(pending.target, pending.action, refs.createObjectName.value, pending.driver, pending.characterPicker?.value()).sql); }
  catch (error) { setSelectableText(refs.createObjectSql, errorText(error)); }
}

function renameObjectTabs(target, name, driver) {
  const old = target.object, object = { ...old, name, qualifiedName: `${old.schema}.${name}`, id: driver === "mysql" ? `${old.schema}.${name}` : old.id };
  for (const tab of state.tabs) {
    if (tab.connectionId !== target.connectionId || tabDatabase(tab) !== old.database) continue;
    let changed = false;
    for (const key of ["browse", "openedObject", "inspectedObject"]) {
      if (tab[key]?.id !== old.id || tab[key]?.schema !== old.schema || (tab[key]?.kind && tab[key].kind !== old.kind)) continue;
      tab[key] = { ...tab[key], ...object }; changed = true;
    }
    if (!changed) continue;
    if (tab.title === old.name) tab.title = name;
    else if (tab.title === `结构 · ${old.name}`) tab.title = `结构 · ${name}`;
    tab.structure = null; tab.structureRequest = ++state.structureRequest;
    if (tab.browse) {
      tab.browse.detailsLoaded = false; tab.result = emptyResult(); tab.gridState = null;
      tab.sql = browseSql(tab.browse); tab.editorState = null;
      if (tab === activeTab()) state.editor.setState(tab.editorState = makeEditorState(tab));
    }
    tab.message = `表已重命名为 ${name}，刷新后读取最新数据或结构`;
  }
  persistTabs(); renderTabs(); renderOutput();
  return object;
}

async function submitContextObjectAction(pending, name) {
  const { target, action, driver } = pending, connectionId = target.connectionId;
  const plan = objectActionPlan(target, action, name, driver, pending.characterPicker?.value());
  const key = transactionKey(connectionId, plan.database);
  if (state.connectionStatuses[connectionId] !== "connected") throw new Error("连接已断开，请重新连接后重试");
  if (state.transactionKeys.has(key)) throw new Error("请先提交或回滚当前数据库的事务，再执行此操作");
  if (state.tabs.some(tab => tab.connectionId === connectionId && tabDatabase(tab) === plan.database && (tab.running || tab.changingTransaction || tab.cellSaving || tab.cellBatchSaving))) throw new Error("当前数据库有操作正在执行，请稍后重试");
  if (action === "rename-table" && state.tabs.some(tab => tab.connectionId === connectionId && tabDatabase(tab) === plan.database && (tab.browse?.id === target.object.id || tab.inspectedObject?.id === target.object.id) && resultGrid.getCellEditDraft(tab.result.rows))) throw new Error("目标表还有未保存的修改，请先保存或取消后再重命名");
  await call("execute_mutation", { request: { connectionId, database: plan.database, schema: plan.schema, sql: plan.sql, queryId: makeId(action), readOnly: false } });
  // Everything below is refresh work. Its failure must never invite a second
  // CREATE/RENAME execution after the server has already succeeded.
  let refreshError = false;
  try {
    recordHistory(plan.sql, { connectionId, database: plan.database, schema: plan.schema });
    state.queryTargets.delete(key);
    if (action === "rename-table") renameObjectTabs(target, plan.name, driver);
    if (state.activeConnectionId === connectionId) {
      if (action === "create-database") refreshError = !await refreshDatabaseList(target, { notify: false });
      else if (action === "create-schema") {
        refreshError = !await loadSchemas(plan.database, connectionId);
        if (!refreshError) { const selected = state.visibleSchemasByDatabase.get(plan.database); selected?.add(plan.name); persistVisibleSchemas(connectionId, plan.database, selected || new Set([plan.name])); renderTree(); }
      } else {
        state.objectsBySchema.delete(schemaKey(plan.database, plan.schema));
        refreshError = !await loadSchemaObjects(plan.database, plan.schema, { force: true });
        const renamed = state.objectsBySchema.get(schemaKey(plan.database, plan.schema))?.find(object => object.name === plan.name && object.kind === target.object.kind);
        if (renamed) selectTreeTarget({ ...target, object: renamed });
        const tab = activeTab();
        if (tab?.structureOnly && tab.inspectedObject?.id === (driver === "mysql" ? `${plan.schema}.${plan.name}` : target.object.id)) refreshError ||= !await inspectObject(tab.inspectedObject, { connectionId, tab });
      }
      rememberTreeSession();
    } else state.treeSessions.delete(connectionId);
    updateEditorSchema();
  } catch { refreshError = true; }
  return { message: plan.success + (refreshError ? "；目录刷新失败，请手动刷新，不要重复执行" : ""), refreshError };
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
    const mysqlCharacterSettings = driver === 'mysql' ? await call('mysql_character_settings', { connectionId: target.connectionId, database: target.database, table: null }) : null;
    guard();
    openStructureEditor({
      mysqlCharacterSettings, create: true, details: { schema: target.schema, ...(driver === 'mysql' ? { mysql: { sqlMode: mysqlCharacterSettings?.sqlMode } } : {}) }, driver, targetLabel: queryTargetDescription(target),
      confirmDiscard: () => confirmAction('放弃尚未保存的表结构？', { title: '放弃新建表', acceptLabel: '放弃草稿' }),
      onClose: () => {},
      onApply: async plan => {
        guard();
        await call('execute_mutation', { request: { ...target, sql: plan.sql, expectedMysqlNoBackslashEscapes: plan.expectedMysqlNoBackslashEscapes, queryId: makeId('create-table'), readOnly: false } });
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
  const tab = await openObjectStructureTab(target.object, target.connectionId);
  if (tab?.structureLoad) {
    try { await tab.structureLoad; } catch { return; }
  }
  if (tab && activeTab() === tab) await editTableStructure(tab);
}

async function editTableStructure(tab) {
  const object = tab?.inspectedObject || tab?.browse;
  if (!object || !tab.structure || tab.structurePending || tab.running || tab.confirming || tab.editingStructure) return;
  const connectionId = object.connectionId || tab.connectionId;
  const database = object.database || tabDatabase(tab);
  const schema = object.schema;
  const target = { connectionId, database, schema };
  const key = transactionKey(connectionId, database);
  const guard = () => {
    if (tab.mode !== "write") throw new Error("当前窗口为只读，请先点击顶部锁切换为可写");
    if (state.transactionKeys.has(key)) throw new Error("请先提交或回滚当前数据库的事务，再编辑表结构");
    if (state.tabs.some(item => item.connectionId === connectionId && tabDatabase(item) === database &&
        (item.browse?.id === object.id || item.inspectedObject?.id === object.id) && resultGrid.getCellEditDraft(item.result.rows))) throw new Error("目标表还有未保存的单元格修改，请先保存或取消后再编辑结构");
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
        const changes = [plan.changed ? `${plan.changed} 项字段变更` : "", plan.indexesChanged ? `${plan.indexesChanged} 项索引变更` : "",
          plan.constraintsChanged ? `${plan.constraintsChanged} 项约束变更` : "", plan.tableCommentChanged ? "修改表注释" : ""].filter(Boolean).join("，");
        if (!await confirmAction(`执行位置：${queryTargetDescription(target)} / ${object.name}\n\n${changes}。${plan.dropped ? `将删除 ${plan.dropped} 列及其数据。` : ""}${plan.keysDropped ? `将删除 ${plan.keysDropped} 项索引或约束。` : ""}${driverForConnection(connectionId) === "mysql" ? "MySQL DDL 会直接提交。" : "PostgreSQL 将在一个事务中应用，失败会回滚。"}`, {
          title: "确认修改表结构", detail: plan.sql, acceptLabel: "应用结构修改",
        })) return false;
        guard();
        const fresh = normalize(await fetchDetails());
        if (structureFingerprint(fresh) !== fingerprint) throw new Error("表结构已被其他操作修改。草稿已保留，请复制 SQL 预览后取消并刷新结构，核对后重新编辑");
        tab.running = true;
        renderTabs();
        await call("execute_mutation", { request: { ...target, sql: plan.sql, expectedMysqlNoBackslashEscapes: plan.expectedMysqlNoBackslashEscapes, queryId: makeId("structure"), readOnly: false } });
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
  addTab("", target.connectionId, null, { database: target.database, schema: target.schema || null, title: `查询 · ${target.schema || target.database}`, newQuery: true });
}

function refreshTreeCategory(target) {
  if (target.kind !== "query") return refreshTreeObject(target);
  savedTreeQueries = readSavedTreeQueries();
  syncTreeQueries();
  showToast("已刷新查询列表");
}

function createFromTreeCategory(target, kind) {
  const mysql = target.driver === "mysql";
  const qualified = `${contextIdentifier(target.schema, target.driver)}.${contextIdentifier("new_" + kind, target.driver)}`;
  const templates = {
    materialized_view: `CREATE MATERIALIZED VIEW ${qualified} AS\nSELECT 1 AS value;`,
    function: mysql ? `CREATE FUNCTION ${qualified}() RETURNS INTEGER DETERMINISTIC RETURN 1;`
      : `CREATE FUNCTION ${qualified}() RETURNS integer LANGUAGE sql AS $$\n  SELECT 1;\n$$;`,
    procedure: mysql ? `CREATE PROCEDURE ${qualified}() SELECT 1;`
      : `CREATE PROCEDURE ${qualified}() LANGUAGE sql AS $$\n  SELECT 1;\n$$;`,
  };
  const sql = templates[kind];
  if (sql) addTab(sql, target.connectionId, null, { database: target.database, schema: target.schema, title: `新建${kindLabels[kind]}` });
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
      : await loadRedisKeys(database, 0, redisPatternFor(database), connectionId, generation);
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
    const databases = (await call("list_databases", { connectionId })).filter(database => database.allowConnections !== false);
    if (!isCurrent()) return;
    const previous = new Set(state.databases.map((database) => database.name));
    const available = new Set(databases.map((database) => database.name));
    state.databases = databases;
    state.databasesLoaded = true;
    state.visibleDatabases = new Set([...available].filter(name =>
      !state.databaseVisibilityCustomized || state.visibleDatabases.has(name) || !previous.has(name)));
    state.databaseVisibilityCustomized = state.visibleDatabases.size > 0 && state.visibleDatabases.size < available.size;
    if (!state.databaseVisibilityCustomized) state.visibleDatabases = available;
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
    if (driverForConnection(connectionId) === "mysql") {
      for (const [key, entry] of state.queryTargets) {
        if (key.startsWith(`${connectionId}\u0000`) && !entry.loading) {
          entry.catalog = databases;
          entry.catalogError = null;
        }
      }
    }
    renderTabs();
    if (notify) showToast("数据库列表已刷新");
    return true;
  } catch (error) {
    if (isCurrent()) showToast(`刷新数据库列表失败：${errorText(error)}`, "error");
    return false;
  }
}

let clearSubmenuTimer;
function closeClearSubmenu() {
  clearTimeout(clearSubmenuTimer);
  if (refs.clearTableSubmenu) refs.clearTableSubmenu.hidden = true;
  refs.objectContextMenu?.querySelector('[data-context-action="clear-table"]')?.setAttribute('aria-expanded', 'false');
}
function openClearSubmenu(focus = false) {
  clearTimeout(clearSubmenuTimer);
  const button = refs.objectContextMenu.querySelector('[data-context-action="clear-table"]');
  if (!button || button.hidden || refs.objectContextMenu.hidden) return;
  const menu = refs.clearTableSubmenu; menu.hidden = false;
  const rect = button.getBoundingClientRect(), width = menu.offsetWidth, height = menu.offsetHeight;
  const left = rect.right + width + 8 <= window.innerWidth ? rect.right : rect.left - width;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - height - 8))}px`;
  button.setAttribute('aria-expanded', 'true');
  if (focus) menu.querySelector('button')?.focus({ preventScroll: true });
}

function hideContextMenus() {
  closeClearSubmenu();
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
  const blocked = state.tabs.filter((tab) => idSet.has(tab.id) && (tab.running || tab.opening || tab.confirming || tab.resolvingTarget || tab.changingTransaction || tab.cellSaving || tab.cellBatchSaving));
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
  if (action === "toggle-readonly") toggleMode(state.tabs[index]);
  if (action === "close") closeTabsByIds([id]);
  if (action === "close-others") closeTabsByIds(state.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  if (action === "close-right") closeTabsByIds(state.tabs.slice(index + 1).map((tab) => tab.id));
  if (action === "close-all") closeTabsByIds(state.tabs.map((tab) => tab.id));
  hideContextMenus();
}
const discardDraftMessage = "继续执行会放弃当前结果中尚未保存的单元格修改。";
async function confirmWrite(sql, { hasDrafts = false } = {}) {
  return !hasDrafts || confirmAction(discardDraftMessage, { title: "执行 SQL？", detail: sql, acceptLabel: "放弃并执行" });
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
function confirmRedisCommand(sql, hasDrafts = false) {
  if (isRedisReadCommand(sql)) {
    return !hasDrafts || confirmAction(discardDraftMessage, { title: "执行 Redis 命令？", detail: sql, acceptLabel: "放弃并执行" });
  }
  const command = firstRedisCommand(sql);
  const dangerous = new Set([
    "FLUSHALL", "FLUSHDB", "CONFIG", "DEBUG", "MODULE", "SHUTDOWN",
    "REPLICAOF", "SLAVEOF", "ACL", "EVAL", "EVALSHA",
  ]).has(command);
  const scope = dangerous
    ? "这可能清空数据、改变 Redis 服务配置或执行高风险脚本。"
    : "这会修改 Redis 中的数据或状态。";
  const discard = hasDrafts ? `\n\n${discardDraftMessage}` : "";
  return confirmAction(`即将执行 Redis 命令（${command || "未知"}）。\n\n${scope}${discard}`, { detail: sql, acceptLabel: hasDrafts ? "放弃并执行" : "确认执行" });
}
async function loadBrowseDetails(tab, prefetched = null) {
  const browse = tab?.browse;
  const connectionId = tab?.connectionId || state.activeConnectionId;
  if (!browse || !connectionId || !["table", "partitioned_table"].includes(browse.kind)) return null;
  const pending = prefetched || call("get_object_details", {
    connectionId,
    objectId: browse.id,
    kind: browse.kind,
    database: browse.database,
  });
  tab.structureLoad = pending;
  let details;
  try { details = await pending; }
  finally { if (tab.structureLoad === pending) tab.structureLoad = null; }
  browse.columns = details.columns || [];
  browse.primaryKeys = browse.columns.filter((column) => column.primaryKey).map((column) => column.name);
  browse.detailsLoaded = true;
  browse.engine = details.mysql?.engine || null;
  tab.structure = details;
  tab.structurePending = false;
  tab.structureError = null;
  return details;
}

async function loadQueryEditTable(tab, result, source, driver) {
  const attributes = source?.attributes;
  if (!source?.objectId || !Array.isArray(attributes) || attributes.length !== result.columns.length) return;
  result.editReason = "正在核对查询结果的源表和主键";
  try {
    const table = await call("get_object_details", {
      connectionId: result.connectionId,
      database: result.database,
      objectId: source.objectId,
      ...(driver === "mysql" ? { kind: "table" } : {}),
    });
    if (tab.result !== result || !state.tabs.includes(tab)) return;
    if (table.id !== source.objectId || table.schema !== source.schema || table.name !== source.name ||
        !["table", "partitioned_table"].includes(table.kind)) return;
    const labels = result.columns.map(cellColumnName);
    const sourceFields = attributes.map(attribute => table.columns.find(field =>
      driver === "mysql" ? field.name === attribute : field.ordinalPosition === attribute));
    if (new Set(labels).size !== labels.length || !sourceFields.every((field, index) => field?.name === labels[index])) return;
    const primaryKeys = table.columns.filter(field => field.primaryKey).map(field => field.name);
    if (!primaryKeys.length || !primaryKeys.every(key => labels.includes(key))) {
      result.editReason = "查询结果缺少完整主键，无法定位要更新的行";
      return;
    }
    result.editTable = {
      id: table.id, schema: table.schema, name: table.name, kind: table.kind, columns: table.columns,
      primaryKeys, engine: table.mysql?.engine, only: driver === "postgres" && table.kind === "table",
    };
  } catch {
    result.editReason = "无法读取源表结构，查询结果暂不可编辑";
  } finally {
    if (result.editReason === "正在核对查询结果的源表和主键") delete result.editReason;
    if (tab.result === result && activeTab() === tab) renderOutput();
  }
}

async function showTableData() {
  const tab = activeTab();
  if (!tab) return;
  const object = tab.inspectedObject || tab.openedObject;
  if (tab.structureOnly && object && ["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(object.kind)) {
    await openObjectQuery(object, { previewTab: tab, connectionId: tab.connectionId });
    return;
  }
  tab.outputTab = "result";
  renderOutput();
  if (tab.autoLoadPending && tab.browse && !tab.opening) {
    tab.autoLoadPending = false;
    await loadOpenedObjectData(tab);
  }
}

async function openObjectQuery(object, { previewTab = null, connectionId = state.activeConnectionId } = {}) {
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
  const target = objectTabTarget(object, connectionId);
  const existing = findObjectTab(target, "data");
  if (existing) {
    activateTab(existing.id);
    existing.outputTab = "result";
    renderOutput();
    if (!existing.result?.executed) await loadOpenedObjectData(existing);
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
    // Reuse the structure preview when opening data, including a double-click.
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
  await loadOpenedObjectData(tab, prefetched);
}

async function loadOpenedObjectData(tab, prefetched = null) {
  if (!tab || tab.opening || tab.running || tab.refreshing || tab.paging || tab.result?.executed) return;
  tab.opening = true;
  try {
    if (!tab.browse?.detailsLoaded) {
      const loadsStructure = ['table', 'partitioned_table'].includes(tab.browse?.kind);
      if (loadsStructure) { tab.structurePending = true; tab.structureError = null; if (activeTab() === tab) renderOutput(); }
      try { await loadBrowseDetails(tab, prefetched); }
      catch (error) { tab.structureError = errorText(error); showToast(`读取表结构失败：${tab.structureError}`, "error"); }
      finally { if (loadsStructure) { tab.structurePending = false; if (activeTab() === tab) renderOutput(); } }
    }
    if (activeTab() === tab && state.tabs.includes(tab) && !tab.result?.executed) {
      renderOutput();
      await runQuery({ preserveOutputMode: true });
    }
  } finally {
    tab.opening = false;
    if (state.tabs.includes(tab) && activeTab() !== tab && !tab.result?.executed && !tab.error) tab.autoLoadPending = true;
    if (activeTab() === tab && state.tabs.includes(tab)) renderOutput();
  }
}
async function runRedisCommand(tab, sqlText, connectionId, drafts = []) {
  if (tab.closed) return;
  const writeMode = tab.mode === "write";
  const database = redisTabDatabase(tab);
  if (state.connectionStatuses[connectionId] !== "connected") {
    const ok = await selectConnection(connectionId);
    if (!ok) return;
  }
  if (tab.closed) return;
  if (drafts.length && !discardCellDrafts(drafts)) return;
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
    boundConsoleHistory(tab.consoleHistory);
    tab.consoleRevision = (tab.consoleRevision || 0) + 1;
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
    if (tab.closed) return;
    const rows = payload.rows || [];
    tab.result = {
      columns: payload.columns || ["result"],
      rows: tab.console ? [] : rows,
      rowCount: payload.rowCount ?? rows.length,
      elapsedMs: payload.elapsedMs ?? payload.elapsed_ms ?? 0,
      truncated: Boolean(payload.truncated),
      truncatedReason: payload.truncatedReason || payload.truncated_reason || null,
      executed: true,
      connectionId,
    };
    tab.result.finishedAt = Date.now();
    tab.result.bytes = estimateResultBytes(tab.result);
    trimResultMemory(tab);
    tab.message = `Redis 命令成功 · ${tab.result.rowCount} 行 · ${Number(tab.result.elapsedMs).toFixed(1)} ms${tab.result.truncated ? ' · 当前为部分输出，请分段读取完整数据' : ''}`;
    const selectMatch = tab.console && /^\s*SELECT\s+(\d+)\s*$/i.exec(sqlText);
    if (selectMatch) {
      tab.redisDb = Number(selectMatch[1]);
      tab.database = selectMatch[1];
    }
    if (consoleEntry) {
      consoleEntry.output = redisConsoleOutput(payload);
      consoleEntry.truncated = Boolean(payload.truncated);
      consoleEntry.elapsedMs = tab.result.elapsedMs;
      consoleEntry.pending = false;
      boundConsoleHistory(tab.consoleHistory);
      tab.consoleRevision = (tab.consoleRevision || 0) + 1;
      persistTabs();
    }
    if (!consoleEntry?.commandTruncated) recordHistory(sqlText, tab);
    tab.outputTab = "result";
    if (isActive()) renderOutput();
  } catch (error) {
    if (tab.closed) return;
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
      boundConsoleHistory(tab.consoleHistory);
      tab.consoleRevision = (tab.consoleRevision || 0) + 1;
      persistTabs();
    }
    tab.outputTab = "message";
    if (isActive()) {
      renderOutput();
      showToast(cancelled ? "Redis 命令已取消" : `Redis 命令失败：${errorText(error)}`, cancelled ? "info" : "error");
    }
  } finally {
    // Release again after the invoke settles in case IPC delivered close before
    // the execution request had entered the backend. Never reuse a closed ID.
    if (tab.closed) void releaseRedisConsoleSession(tab);
    tab.running = false;
    tab.queryId = null;
    tab.cancelRequested = false;
    renderTabs();
    if (isActive()) renderOutput();
  }
}
async function jumpBrowsePage(value) {
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    showToast("请输入大于 0 的整数页码", "error");
    return;
  }
  await changeBrowsePage(Number(text) - 1);
}
async function moveBrowsePage(delta) {
  const tab = activeTab();
  if (tab?.browse) await changeBrowsePage(Math.max(0, tab.browse.page + delta));
}
async function changeBrowsePage(page) {
  const tab = activeTab();
  if (!tab?.browse || tab.paging || tab.running || tab.refreshing || tab.confirming || tab.resolvingTarget || tab.changingTransaction || cellWritePending(tab)) return;
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * tab.browse.pageSize)) {
    showToast("页码超出可查询范围", "error");
    return;
  }
  if (page === tab.browse.page) return;
  const previousSql = tab.sql;
  const view = resultGrid.getViewState();
  const paging = { page, view: { widths: view.widths, scrollLeft: view.scrollLeft, scrollTop: 0 } };
  tab.paging = paging;
  renderOutput();
  let success = false;
  try {
    state.applyingBrowse = true;
    try { setEditorValue(browseSql({ ...tab.browse, page })); }
    finally { state.applyingBrowse = false; }
    success = await runQuery({ preserveResult: true, pagingRequest: paging });
    if (success) {
      tab.browse.page = page;
      if (!tab.result.rows.length && activeTab() === tab) showToast(`第 ${page + 1} 页没有数据，可返回前面的页码`);
    }
  } finally {
    if (!success && tab.sql !== previousSql) {
      tab.sql = previousSql;
      tab.editorState = makeEditorState(tab);
      if (activeTab() === tab) state.editor.setState(tab.editorState);
    }
    if (tab.paging === paging) tab.paging = null;
    if (activeTab() === tab) renderOutput();
    persistTabs();
  }
}

async function runQuery({ preserveResult = false, pagingRequest = null, preserveOutputMode = false } = {}) {
  const tab = activeExecutionTab();
  if (tab?.paging && tab.paging !== pagingRequest) return;
  if (!tab || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction || cellWritePending(tab)) return;
  if (runningViewWrites.has(transactionKey(tab.connectionId, tabDatabase(tab)))) {
    showToast('目标数据库正在保存或刷新视图');
    return;
  }
  if (tab.console) redisEditor?.finishComposition();
  else state.editor.plugin(sqlIme)?.finish();
  const editorState = tab.console ? null : state.editor.state;
  const selection = editorState?.selection.main;
  const rawSelection = selection ? editorState.sliceDoc(selection.from, selection.to) : "";
  const selected = rawSelection.trim();
  const rawSql = tab.sql;
  const sqlText = tab.console
    ? (redisEditor?.executionText() || tab.sql || "").trim()
    : selected || rawSql.trim();
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
  if (tab.awaitingDatabase) { querySchemaSelect.open(); return; }
  if (profile?.driver === "redis") {
    if (tab.console) return runRedisCommand(tab, sqlText, connectionId);
    const drafts = cellDraftsForTabs([tab]);
    if (hasSavingCellDrafts(drafts)) return;
    tab.confirming = true;
    renderTabs();
    try {
      if (await confirmRedisCommand(sqlText, Boolean(drafts.length)) && activeExecutionTab() === tab) {
        await runRedisCommand(tab, sqlText, connectionId, drafts);
      }
    } finally {
      tab.confirming = false;
      renderTabs();
    }
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
  if (activeExecutionTab() !== tab) { renderTabs(); return; }
  if (tab.awaitingSchema) { renderTabs(); querySchemaSelect.open(); return; }
  if (cellWritePending(tab)) { renderTabs(); return; }
  if (runningViewWrites.has(transactionKey(connectionId, tabDatabase(tab)))) {
    renderTabs();
    showToast('目标数据库正在保存或刷新视图');
    return;
  }
  // Capture the destination before confirmation/connection awaits; never read
  // the active browser or another tab when dispatching or recording history.
  const executionTarget = { connectionId, database: tabDatabase(tab) || target.context.database || null, schema: tabSchema(tab) };
  const transactionAction = sqlTransactionAction(sqlText, profile.driver);
  if (transactionAction) return changeTransaction(transactionAction, { tab, database: executionTarget.database, sql: sqlText });
  const executionInfo = sqlExecutionInfo(sqlText, profile.driver);
  const transactionScript = /^(BEGIN|START)$/.test(executionInfo.keywords[0]);
  if (transactionScript && (tab.mode !== "write" || state.transactionKeys.has(transactionKey(connectionId, executionTarget.database)))) {
    renderTabs();
    showToast(tab.mode !== "write" ? "请先在标签菜单关闭只读模式" : "请先提交或回滚当前事务，再执行事务脚本", "error");
    return;
  }
  const scriptDocument = transactionScript ? editorState.doc : null;
  const scriptOffset = transactionScript
    ? (selected ? selection.from + rawSelection.length - rawSelection.trimStart().length
      : rawSql.length - rawSql.trimStart().length)
    : 0;
  const targetDescription = queryTargetDescription(tab);
  const writeMode = tab.mode === "write";
  const drafts = cellDraftsForTabs([tab]);
  if (hasSavingCellDrafts(drafts)) { renderTabs(); return; }
  const keepPreviousResult = preserveResult || drafts.length > 0;
  const previousResult = keepPreviousResult ? tab.result : null;
  const previousGridState = keepPreviousResult ? tab.gridState : null;
  tab.confirming = true;
  renderTabs();
  try {
    if (!await confirmWrite(sqlText, { hasDrafts: drafts.length > 0 })) {
      showToast("已取消执行");
      return;
    }
    if (state.connectionStatuses[connectionId] !== "connected") {
      if (!await selectConnection(connectionId)) return;
    }
    if (activeExecutionTab() !== tab || cellWritePending(tab)) return;
    tab.running = true;
    tab.transactionScriptRunning = transactionScript;
  } finally {
    tab.confirming = false;
    renderTabs();
  }
  const readStatement = executionInfo.singleRead;
  const txOpen = state.transactionKeys.has(transactionKey(connectionId, executionTarget.database));
  tab.queryId = makeId("query-run");
  if (editorState?.field?.(failedStatementMark, false)?.size) {
    state.editor.dispatch({ effects: markFailedStatement.of(null) });
  }
  tab.failedStatement = null;
  tab.error = false;
  tab.cancelled = false;
  tab.gridState = null;
  tab.refreshing = keepPreviousResult;
  tab.executionSummary = null;
  tab.message = `正在执行 ${selected ? "选中的 SQL" : "查询"}…`;
  if (!keepPreviousResult) tab.result = emptyResult();
  renderTabs();
  renderOutput();
  const isActive = () => activeTab() === tab;
  const started = performance.now();
  try {
    const editRelation = readStatement && !txOpen && !tab.browse ? queryEditRelation(sqlText, profile.driver) : null;
    const payload = await call(writeMode && (!readStatement || txOpen) ? "execute_mutation" : "execute_query", {
      request: {
        ...executionTarget,
        sql: sqlText,
        queryId: tab.queryId,
        readOnly: !writeMode,
        ...(editRelation ? { queryEditRelation: editRelation } : {}),
        ...(transactionScript ? { transactionScript: true } : {}),
      },
    });
    discardCellDrafts(drafts);
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
      cellEditsInTransaction: writeMode && txOpen,
    };
    if (editRelation && payload.editSource && rows.length &&
        (profile.driver !== "mysql" || editRelation.length === 2 || payload.editSource.schema === executionTarget.database)) {
      void loadQueryEditTable(tab, tab.result, payload.editSource, profile.driver);
    }
    tab.refreshing = false;
    tab.gridState = tab.paging ? tab.paging.view : null;
    const statementCount = payload.statement_count || 1;
    const scriptOutcome = payload.transaction_script === "commit" ? "事务脚本已提交"
      : payload.transaction_script === "rollback" ? "事务脚本已回滚" : "";
    if (isSqlQueryTab(tab)) {
      const statements = payload.statement_summaries?.length ? payload.statement_summaries : [{
        sql: sqlText,
        elapsed_ms: tab.result.elapsedMs,
        row_count: tab.result.rowCount,
        has_result_set: tab.result.columns.length > 0,
        truncated: tab.result.truncated,
      }];
      tab.executionSummary = {
        statements,
        count: payload.statement_summaries?.length || statementCount,
        outcome: scriptOutcome,
        elapsedMs: tab.result.elapsedMs,
      };
    }
    tab.result.finishedAt = Date.now();
    tab.result.bytes = estimateResultBytes(tab.result, tab.executionSummary?.statements);
    trimResultMemory(tab);
    if (tab.executionSummary && !tab.result.columns.length) tab.outputTab = "message";
    else if (!preserveOutputMode || (tab.outputTab || 'result') === 'result') tab.outputTab = "result";
    tab.message = `${scriptOutcome || "执行成功"}${statementCount > 1 ? ` · ${statementCount} 条语句` : ""} · ${tab.result.rowCount} 行 · ${Number(tab.result.elapsedMs).toFixed(1)} ms${tab.result.truncated ? `\n结果已限制（${truncatedReason === "result_size" ? "8 MiB" : "1000 行"}）。` : ""}\n执行位置：${targetDescription}`;
    recordHistory(sqlText, executionTarget);
    let catalogRefreshFailed = false;
    if (profile.driver === "mysql" && sqlExecutionInfo(sqlText, "mysql").keywords.some(keyword => /^(CREATE|ALTER|DROP|RENAME|TRUNCATE)$/i.test(keyword))) {
      for (const object of mysqlDdlTargets(sqlText, executionTarget.database)) {
        for (const item of state.tabs) {
          if (item.connectionId !== connectionId || !item.browse || tabDatabase(item)?.toLowerCase() !== object.database?.toLowerCase() || item.browse.name.toLowerCase() !== object.name.toLowerCase()) continue;
          item.result.schemaChanged = true; item.structure = null; item.structureError = "表结构已改变，请刷新读取最新结构";
          item.structureRequest = ++state.structureRequest; item.browse.detailsLoaded = false; item.browse.columns = []; item.browse.primaryKeys = [];
        }
      }
      state.queryTargets.delete(transactionKey(connectionId, executionTarget.database));
      state.treeSessions.get(connectionId)?.objectsBySchema.delete(schemaKey(executionTarget.database, executionTarget.database));
      try {
        if (state.activeConnectionId === connectionId) {
          if (/\b(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b/i.test(sqlText)) await refreshDatabaseList({ connectionId }, { notify: false });
          else if (state.expandedDatabases.has(executionTarget.database)) catalogRefreshFailed = !await loadSchemaObjects(executionTarget.database, executionTarget.database, { force: true });
        }
      } catch { catalogRefreshFailed = true; }
    }
    if (isActive()) {
      renderOutput();
      if (catalogRefreshFailed) showToast("SQL 已执行，目录刷新失败，请手动刷新", "error");
    }
    return true;
  } catch (error) {
    const elapsedMs = performance.now() - started;
    const unknown = transactionOutcomeUnknown(error);
    const cancelled = !unknown && (tab.cancelRequested || isQueryCancellation(error));
    tab.refreshing = false;
    tab.executionSummary = null;
    if (keepPreviousResult && previousResult?.executed) {
      tab.result = previousResult;
      tab.gridState = previousGridState;
    } else {
      tab.result = emptyResult();
    }
    if (txOpen && transactionDidEnd(error)) invalidateTransactionResults(connectionId, executionTarget.database, unknown);
    tab.error = !cancelled;
    tab.cancelled = cancelled;
    const cancellation = transactionScript && transactionDidRollback(error) ? "查询已取消，事务脚本已回滚" : "查询已取消";
    tab.message = cancelled
      ? `${cancellation}\n\n${sqlText}`
      : `查询失败：${errorText(error)}\n执行位置：${targetDescription}\n\n${sqlText}`;
    if (!preserveOutputMode || (tab.outputTab || 'result') === 'result') tab.outputTab = (tab.paging || drafts.length) && previousResult?.executed ? "result" : "message";
    let notification = cancelled ? cancellation : `查询失败：${errorText(error)}`;
    let range = null;
    if (transactionScript) {
      const status = scriptRollbackLabels[error?.rollback] || "未收到回滚状态";
      range = scriptFailureRange(error?.statement, scriptDocument, scriptOffset, sqlText.length);
      const location = range ? `第 ${error.statement.number} 条 SQL（第 ${scriptDocument.lineAt(range.from).number} 行）` : "事务脚本";
      if (unknown) invalidateWriteResult(tab, previousResult);
      notification = `${location}${cancelled ? "已取消" : "失败"} · ${status}`;
      tab.message = [notification, errorText(error), error?.rollbackDetail, `执行位置：${targetDescription}`].filter(Boolean).join("\n\n");
      tab.outputTab = "message";
      if (range && !cancelled) tab.failedStatement = { document: scriptDocument, range, keepSelection: Boolean(selected) };
    }
    if (!cancelled && isSqlQueryTab(tab)) {
      tab.executionSummary = executionFailureSummary({
        sql: range ? scriptDocument.sliceString(range.from, range.to) : sqlText,
        number: range ? error.statement.number : executionInfo.count === 1 ? 1 : null,
        error, elapsedMs, target: targetDescription, unknown,
      });
      if (!previousResult?.executed) tab.outputTab = "message";
    }
    if (isActive()) {
      renderOutput();
      if (transactionScript) revealFailedStatement(tab);
      if (!tab.executionSummary || unknown || tab.outputTab !== "message") {
        showToast(notification, cancelled ? "info" : "error");
      }
    }
  } finally {
    tab.refreshing = false;
    tab.running = false;
    tab.transactionScriptRunning = false;
    tab.queryId = null;
    tab.cancelRequested = false;
    renderTabs();
    if (isActive()) renderOutput();
  }
}

function executionFailureSummary({ sql, number, error, elapsedMs, target, unknown }) {
  const message = errorText(error);
  const rollback = scriptRollbackLabels[error?.rollback];
  return {
    statements: [{ sql, elapsed_ms: elapsedMs }],
    elapsedMs,
    failure: {
      number,
      target,
      message,
      unknown,
      detail: [message, rollback, error?.rollbackDetail].filter(Boolean).join("\n\n"),
    },
  };
}

const scriptRollbackLabels = {
  not_started: "事务未开始",
  succeeded: "回滚成功",
  failed: "回滚失败",
  incomplete: "回滚不完整，请核对数据库",
  unconfirmed: "回滚结果无法确认，请核对数据库",
};

function scriptFailureRange(statement, document, offset, length) {
  if (!statement || !document) return null;
  const { from, to } = statement;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > length || offset + to > document.length) return null;
  return { from: offset + from, to: offset + to };
}

function revealFailedStatement(tab) {
  const failure = tab.failedStatement;
  if (!failure) return;
  tab.failedStatement = null;
  const editor = state.editor;
  if (!editor.state.doc.eq(failure.document)) return;
  const { range } = failure;
  editor.focus();
  editor.dispatch({
    ...(failure.keepSelection ? {} : { selection: { anchor: range.from } }),
    effects: [markFailedStatement.of(range), EditorView.scrollIntoView(range.from, { y: "center" })],
  });
}

async function changeTransaction(action, { tab = activeTab(), database = tabDatabase(tab) || queryTargetData(tab)?.context?.database, sql = null } = {}) {
  if (!tab || tab.running || tab.confirming || tab.resolvingTarget || tab.changingTransaction || cellWritePending(tab)) return;
  if (action === "begin" && (tab.awaitingDatabase || tab.awaitingSchema)) { querySchemaSelect.open(); return; }
  const connectionId = tab.connectionId;
  if (!connectionId || !database) {
    showToast(connectionId ? "请先选择数据库" : "请先选择数据库连接", "error");
    if (connectionId && driverForTab(tab) === "mysql") querySchemaSelect.open();
    return;
  }
  const key = transactionKey(connectionId, database);
  if (runningViewWrites.has(key)) {
    showToast('目标数据库正在保存或刷新视图');
    return;
  }
  if (action === "begin" && tab.mode === "read") {
    showToast("请先在标签菜单关闭只读模式", "error");
    return;
  }
  if (action === "begin" && driverForTab(tab) === "mysql" && tab.browse?.engine && !/^innodb$/i.test(tab.browse.engine)) {
    showToast(`当前表使用 ${tab.browse.engine}，不能保证事务回滚；请使用事务型存储引擎`, "error"); return;
  }
  const relatedTabs = state.tabs.filter(item => item.connectionId === connectionId && tabDatabase(item) === database);
  if (relatedTabs.some(item => item !== tab && (item.running || item.confirming || item.resolvingTarget || item.changingTransaction || item.cellSaving || item.cellBatchSaving))) {
    showToast("当前数据库有操作正在执行，请完成后再改变事务状态", "error"); return;
  }
  const hasTransaction = state.transactionKeys.has(key);
  if (action === "begin" && hasTransaction) {
    showToast("当前数据库已有未提交事务");
    return;
  }
  if (action !== "begin" && !hasTransaction) {
    showToast("当前数据库处于自动提交模式，没有未提交事务");
    return;
  }
  const drafts = action === "rollback" ? cellDraftsForTabs(relatedTabs) : [];
  if (hasSavingCellDrafts(drafts)) return;
  tab.changingTransaction = true;
  renderTabs();
  let started = null;
  try {
    if (drafts.length && !await confirmAction(
      "回滚会撤销当前事务，并放弃该数据库下尚未保存的单元格修改。",
      { title: "回滚事务？", detail: sql || "", acceptLabel: "放弃修改并回滚" },
    )) return;
    if (state.connectionStatuses[connectionId] !== "connected") {
      const ok = await selectConnection(connectionId);
      if (!ok) return;
    }
    started = performance.now();
    await call(`${action}_transaction`, { connectionId, database });
    const elapsedMs = performance.now() - started;
    if (action === "begin") state.transactionKeys.add(key);
    else state.transactionKeys.delete(key);
    if (action === "rollback") {
      discardCellDrafts(drafts);
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
    const message = action === "begin" ? "事务已开始" : action === "commit" ? "事务已提交" : "事务已回滚";
    if (sql) {
      recordHistory(sql, { connectionId, database, schema: tabSchema(tab) });
      const target = queryTargetDescription(tab);
      if (isSqlQueryTab(tab)) {
        tab.executionSummary = {
          statements: [{ sql, elapsed_ms: elapsedMs, outcome: message }],
          count: 1,
          elapsedMs,
        };
      }
      tab.message = `${message}\n执行位置：${target}`;
      tab.outputTab = "message";
      tab.error = false;
      tab.cancelled = false;
      if (activeTab() === tab) renderOutput();
    }
    renderTabs();
    showToast(message);
  } catch (error) {
    const unknown = transactionOutcomeUnknown(error);
    const transactionMissing = errorText(error).includes("[TX_MISSING]");
    if (transactionMissing) {
      invalidateTransactionResults(connectionId, database, unknown);
    }
    if (started !== null && sql && isSqlQueryTab(tab)) {
      const target = queryTargetDescription(tab);
      tab.error = true;
      tab.cancelled = false;
      tab.outputTab = "message";
      tab.executionSummary = executionFailureSummary({
        sql, number: 1, error, elapsedMs: performance.now() - started, target, unknown,
      });
      if (activeTab() === tab) renderOutput();
    } else {
      if (transactionMissing) renderOutput();
      showToast(`${action === "begin" ? "开始事务" : action === "commit" ? "提交事务" : "回滚事务"}失败：${errorText(error)}`, "error");
    }
  } finally {
    tab.changingTransaction = false;
    renderTabs();
  }
}

function sqlLiteral(value, driver = driverForTab(), dataType) {
  return sqlTypedValueLiteral(value, dataType, driver);
}

function mutationInputValue(value, original) {
  if (typeof original === "boolean") {
    const trimmed = String(value).trim();
    if (/^(?:true|t|yes|y|on|1)$/i.test(trimmed)) return true;
    if (/^(?:false|f|no|n|off|0)$/i.test(trimmed)) return false;
  }
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
  if (field.identity) {
    if (driverForTab(tab) === "postgres" && field.identityGeneration !== "byDefault") {
      return { disabled: true, hint: "GENERATED ALWAYS identity 由数据库生成" };
    }
    if (type === "edit") return { disabled: false, hint: isKey ? "保存时使用原主键定位，成功后更新主键值" : "自增字段可修改已有值" };
    return { disabled: false, hint: "留空由数据库自动生成，也可手动指定" };
  }
  if (type === "edit" && isKey) return { disabled: false, hint: "保存时使用原主键定位，成功后更新主键值" };
  return { disabled: false, hint: type === "insert" && field.defaultValue ? "留空使用数据库默认值" : "" };
}

function openMutation(type) {
  const tab = activeTab();
  if (tab?.paging || tab?.running || tab?.refreshing) return;
  if (tab?.mode !== "write") {
    showToast("请先在标签菜单关闭只读模式", "error");
    return;
  }
  const browse = tab?.browse;
  if (!browse || !["table", "partitioned_table"].includes(browse.kind)) return;
  if (tab.result.schemaChanged) { showToast("表结构已改变，请先刷新数据", "error"); return; }
  if (tab.result.transactionOutcomeUnknown) { showToast("写入结果未知，请先刷新并核对数据库", "error"); return; }
  if (resultGrid.getCellEditDraft(tab.result.rows)) { showToast("请先保存或取消当前表的单元格修改", "error"); return; }
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
  state.mutation = { type, tab, columns, primaryKeys, selectedRows, result: tab.result };
  const labels = { insert: "新增行", edit: "编辑行", delete: "删除行" };
  refs.mutationTitle.textContent = labels[type];
  refs.mutationHint.textContent = `${browse.schema}.${browse.name}${type === "delete" ? ` · 将删除 ${selectedRows.length} 行`
    : type === "insert" ? " · 留空使用数据库默认值" : " · 仅保存有改动的字段"}`;
  refs.mutationFeedback.textContent = "";
  refs.mutationFeedback.classList.remove("error");
  const source = selectedRows[0] || [];
  refs.mutationFields.innerHTML = type === "delete"
    ? '<div class="form-note">删除操作会按主键匹配选中行，执行前仍会再次确认。</div>'
    : columns
        .map((column, index) => {
          const isKey = primaryKeys.includes(column);
          const field = mutationFieldState(tab, column, type);
          const value = type === "edit" && source[index] != null ? cellText(source[index]) : "";
          return `<div class="mutation-field"><label for="mutation-${index}">${escapeHtml(column)}${isKey ? " · 主键" : ""}</label><div class="mutation-field-value"><input id="mutation-${index}" data-mutation-column="${escapeHtml(column)}" value="${escapeHtml(value ?? "")}"${field.disabled ? " disabled" : ""}/>${field.hint ? `<small>${escapeHtml(field.hint)}</small>` : ""}</div></div>`;
        })
        .join("");
  if (type === "insert") {
    const metadata = new Map(browse.columns.map(field => [field.name, field]));
    for (const input of refs.mutationFields.querySelectorAll("[data-mutation-column]:not(:disabled)")) {
      const field = metadata.get(input.dataset.mutationColumn);
      if (field) mountRowInputShortcuts(input, field, driverForTab(tab), { primaryKey: primaryKeys.includes(field.name) });
    }
  }
  refs.mutationModal.showModal();
  (refs.mutationFields.querySelector('[data-mutation-column]:not(:disabled)') || refs.cancelMutation)?.focus({ preventScroll: true });
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
  let sql, editedRow;
  try {
    if (tab.mode !== "write" || tab.result.schemaChanged || tab.result.transactionRolledBack || tab.result.transactionOutcomeUnknown || (mutation.result && mutation.result !== tab.result)) throw new Error("表数据或可写状态已改变，请关闭窗口并刷新后重试");
    if (driver === "mysql" && state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab))) && browse.engine && !/^innodb$/i.test(browse.engine)) throw new Error("当前表的存储引擎不能保证回滚，请结束事务后再修改数据");
    if (type === "delete") {
      const keyIndexes = primaryKeys.map((key) => columns.indexOf(key));
      const predicates = selectedRows.map((row) =>
        `(${primaryKeys.map((key, index) => sqlEquality(quote(key), sqlLiteral(row[keyIndexes[index]], driver, browse.columns.find(field => field.name === key)?.dataType), driver)).join(" AND ")})`,
      );
      sql = `DELETE FROM ${table}\nWHERE ${predicates.join(" OR ")};`;
    } else if (type === "insert") {
      const fields = new Map(browse.columns.map(field => [field.name, field]));
      const entries = [];
      for (const input of refs.mutationFields.querySelectorAll("[data-mutation-column]")) {
        const column = input.dataset.mutationColumn;
        if (mutationFieldState(tab, column, type).disabled) continue;
        const { dataType, nullable } = fields.get(column) || {};
        const { expression, value } = readRowInput(input, dataType, driver);
        if (!expression && value === undefined) continue;
        if (value === null || typeof value === "string") {
          try { validateCellDraft(value, { dataType, allowNull: nullable === true && !primaryKeys.includes(column) }); }
          catch (error) { throw new Error(`${column}：${errorText(error)}`); }
        }
        entries.push({ column, literal: expression || sqlLiteral(value, driver, dataType) });
      }
      sql = entries.length
        ? `INSERT INTO ${table} (${entries.map(({ column }) => quote(column)).join(", ")})\nVALUES (${entries.map(({ literal }) => literal).join(", ")});`
        : driver === "mysql" ? `INSERT INTO ${table} () VALUES ();` : `INSERT INTO ${table} DEFAULT VALUES;`;
    } else {
      const values = Object.fromEntries(
        [...refs.mutationFields.querySelectorAll("[data-mutation-column]")].map((input) => [input.dataset.mutationColumn, input.value]),
      );
      const source = selectedRows[0] || [];
      const changed = columns.filter((column, index) => !mutationFieldState(tab, column, type).disabled && typeof values[column] === "string" && values[column].trim() !== "" &&
        values[column] !== (source[index] == null ? "" : cellText(source[index])));
      if (!changed.length) {
        refs.mutationFeedback.textContent = "尚未修改任何字段";
        refs.mutationFeedback.classList.add("error");
        return;
      }
      const keyPredicates = primaryKeys.map((key) => {
        const index = columns.indexOf(key);
        return sqlEquality(quote(key), sqlLiteral(source[index], driver, browse.columns.find(field => field.name === key)?.dataType), driver);
      });
      sql = `UPDATE ${table}\nSET ${changed.map((column) => `${quote(column)} = ${sqlLiteral(mutationInputValue(values[column], source[columns.indexOf(column)]), driver, tab.browse.columns.find(field => field.name === column)?.dataType)}`).join(", ")}\nWHERE ${keyPredicates.join(" AND ")};`;
      editedRow = { source, row: source.map((value, index) => changed.includes(columns[index]) ? mutationInputValue(values[columns[index]], value) : value) };
    }
  } catch (error) {
    refs.mutationFeedback.textContent = `无法生成写入语句：${errorText(error)}`;
    refs.mutationFeedback.classList.add("error");
    return;
  }
  if (!await confirmWrite(sql, tab)) return;
  refs.applyMutation.disabled = true;
  let mutationBackendError = false;
  const mutationResult = tab.result;
  const mutationTxOpen = state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab)));
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
    }).catch(error => { mutationBackendError = true; throw error; });
    const txOpen = state.transactionKeys.has(transactionKey(tab.connectionId || state.activeConnectionId, tabDatabase(tab)));
    if (type === "edit") {
      if (payload.row_count !== 1) throw new Error("数据库未报告唯一匹配行，请刷新核对后再编辑");
      const index = tab.result.rows.indexOf(editedRow.source);
      if (index >= 0) {
        tab.result.rows[index] = editedRow.row;
        resultGrid.updateCellEditContexts?.(tab.result.rows, draft => {
          const context = draft.context;
          if (context?.tab === tab && context.result === tab.result && context.rowRef === editedRow.source && context.value === editedRow.row[context.columnIndex]) {
            context.rowRef = editedRow.row; context.row = [...editedRow.row];
          }
        });
        if (activeTab() === tab && state.gridResult === tab.result) resultGrid.refreshRows();
      }
      if (txOpen) tab.result.cellEditsInTransaction = true;
    }
    refs.mutationModal.close();
    state.mutation = null;
    tab.message = `写入成功 · ${payload.row_count ?? 0} 行受影响`;
    tab.outputTab = "message";
    showToast(`写入成功 · ${payload.row_count ?? 0} 行受影响`);
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
    if (mutationBackendError && mutationTxOpen && transactionDidEnd(error)) invalidateTransactionResults(tab.connectionId, tabDatabase(tab), transactionOutcomeUnknown(error));
    else if (mutationBackendError && transactionOutcomeUnknown(error)) invalidateWriteResult(tab, mutationResult);
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
function selectedRowCopyActions({ columns, rows }) {
  const tab = activeTab();
  const result = tab?.result;
  if (!rows.length || !result?.executed || result.rows !== resultGrid.rows) return [];
  const data = { columns: columns.map(cellColumnName), rows };
  const driver = driverForTab(tab);
  const table = tab.browse || result.editTable;
  const makeAction = (id, label, serialize, disabledReason) => ({
    id, label, disabledReason,
    run: async () => {
      if (activeTab() !== tab || tab.result !== result) return;
      try {
        await copyText(serialize());
        showToast(`已复制 ${rows.length} 行 · ${id.toUpperCase()}`);
      } catch (error) { showToast(`复制失败：${errorText(error)}`, "error"); }
    },
  });
  const actions = [makeAction("tsv", "复制所选行为 TSV", () => formatClipboardRows(columns, rows))];
  if (!["postgres", "mysql"].includes(driver) || !["table", "partitioned_table"].includes(table?.kind)) return actions;
  const primaryKeys = table.primaryKeys || [];
  const fields = data.columns.map(name => table.columns?.find(field => field.name === name));
  const reason = result.schemaChanged || result.transactionRolledBack || result.transactionOutcomeUnknown
    ? "请刷新表数据后复制 SQL" : fields.some(field => !field) ? "请先加载完整表结构"
      : resultGrid.getCellEditDraft(result.rows) ? "请先保存或取消单元格草稿" : "";
  const hasUpdateField = fields.some(field => field && !primaryKeys.includes(field.name) && !field.generated &&
    !(driver === "postgres" && field.identity && field.identityGeneration !== "byDefault"));
  actions.push(makeAction("insert", "复制所选行为 INSERT", () => buildCopiedRowsSql(data, table, driver, "insert"),
    reason || (!fields.some(field => field && !field.generated) ? "没有可插入的字段" : "")));
  actions.push(makeAction("update", "复制所选行为 UPDATE", () => buildCopiedRowsSql(data, table, driver, "update"),
    reason || (!primaryKeys.length || primaryKeys.some(key => !data.columns.includes(key)) ? "需要完整主键才能生成 UPDATE"
      : !hasUpdateField ? "没有可更新的非主键字段" : "")));
  return actions;
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
async function exportResults(format = "csv") {
  const tab = activeTab();
  const data = resultData();
  if (!tab || !data?.columns.length || tab.exporting) return;
  const target = { ...tab.browse, columns: tab.browse?.columns || [] };
  const preview = driverForTab(tab) === 'redis' && tab.result?.truncated;
  tab.exporting = true;
  try {
    const output = await createExport(data, format, { table: tab.browse ? target : null, driver: driverForTab(tab), title: `${tab.title || 'query'}${preview ? '-preview' : ''}` });
    const nativeResult = invoke ? await call(output.bytes ? "save_binary_file" : "save_text_file", output.bytes
      ? { fileName: output.name, contents: Array.from(output.bytes) }
      : { fileName: output.name, contents: output.contents }) : null;
    const outcome = resolveSaveOutcome(Boolean(invoke), nativeResult);
    if (outcome === "cancelled") { showToast("已取消导出"); return; }
    if (outcome === "download") {
      const anchor = document.createElement("a");
      const url = URL.createObjectURL(new Blob([output.bytes || output.contents], { type: output.mime }));
      anchor.href = url; anchor.download = output.name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    showToast(`已导出${preview ? '当前预览 ' : ' '}${data.rows.length} 行 · ${format.toUpperCase()}${preview ? '（非完整值）' : ''}`);
  } catch (error) { showToast(`导出失败：${errorText(error)}`, "error"); }
  finally { tab.exporting = false; }
}

let importTarget = null;
function chooseTableImport(format) {
  const tab = activeTab();
  if (!tab?.connectionId || !["postgres", "mysql"].includes(driverForTab(tab)) || tab.running || tab.paging || cellWritePending(tab)) return;
  if (format !== "sql" && (tab.mode !== "write" || !tab.browse || !["table", "partitioned_table"].includes(tab.browse.kind))) return;
  if (format !== "sql" && tab.result.transactionOutcomeUnknown) return showToast("写入结果未知，请先刷新并核对数据库", "error");
  if (resultGrid.getCellEditDraft(tab.result.rows)) return showToast("请先保存或取消当前表的单元格修改", "error");
  importTarget = { tab, format, destination: cellDestination(tab), driver: driverForTab(tab) };
  refs.tableImportFile.value = "";
  refs.tableImportFile.accept = `.${format}`;
  refs.tableImportFile.click();
}
async function readTableImport() {
  const file = refs.tableImportFile.files[0], target = importTarget;
  if (!file || !target) return;
  importTarget = null;
  const { tab, format, driver, destination } = target;
  const guard = () => {
    if (!state.tabs.includes(tab) || cellDestination(tab) !== destination) throw new Error("原表或连接已改变，请重新选择导入文件");
    if (tab.mode !== "write" || tab.running || tab.paging || tab.refreshing || cellWritePending(tab)) throw new Error("当前表不可写或有操作正在执行");
    if (tab.result.transactionOutcomeUnknown) throw new Error("写入结果未知，请关闭导入窗口并刷新核对数据库后重试");
    if (tab.result.transactionRolledBack) throw new Error("当前事务已回滚，请关闭导入窗口并刷新数据后重试");
    if (driver === "mysql" && state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab))) && tab.browse?.engine && !/^innodb$/i.test(tab.browse.engine)) throw new Error("当前表的存储引擎不能保证回滚，请结束事务后再导入");
    if (resultGrid.getCellEditDraft(tab.result.rows)) throw new Error("请先保存或取消单元格修改");
  };
  try {
    if (!state.tabs.includes(tab) || cellDestination(tab) !== destination) throw new Error("原查询已改变，请重新导入");
    if (format === "sql") {
      const { sql } = await readTransferFile(file, { format });
      if (!state.tabs.includes(tab) || cellDestination(tab) !== destination) throw new Error("原查询已改变，请重新导入");
      const draft = addTab(sql, tab.connectionId, null, { database: tabDatabase(tab), schema: tabSchema(tab), title: file.name });
      if (draft) { draft.mode = tab.mode; renderTabs(); renderOutput(); persistTabs(); showToast("SQL 已打开，请查看后执行"); }
      return;
    }
    guard();
    if (!tab.browse.detailsLoaded) throw new Error("请先加载表结构后再导入");
    guard();
    const capturedDestination = cellDestination(tab);
    const connectionId = tab.connectionId, database = tabDatabase(tab), schema = tabSchema(tab);
    openDataImport({ file, format, table: { ...tab.browse, columns: tab.browse.columns.map(column => ({ ...column })) }, driver,
      targetLabel: `${queryTargetDescription(tab)} / ${tab.browse.name}`,
      onApply: async ({ sql, rowCount }) => {
        if (cellDestination(tab) !== capturedDestination) throw new Error("目标表结构已改变，请关闭后重新导入");
        guard();
        const txKey = transactionKey(connectionId, database), txOpen = state.transactionKeys.has(txKey);
        const capturedResult = tab.result;
        tab.importing = true; tab.cellBatchSaving = {};
        renderTabs();
        try {
          const result = await call("execute_mutation", { request: { connectionId, database, schema, sql, queryId: makeId("data-import"), readOnly: false } });
          recordHistory(sql, { connectionId, database, schema });
          if (txOpen) tab.result.cellEditsInTransaction = true;
          return { rowCount: result.row_count ?? rowCount, txOpen };
        } catch (error) {
          if (txOpen && transactionDidEnd(error)) invalidateTransactionResults(connectionId, database, transactionOutcomeUnknown(error));
          else if (transactionOutcomeUnknown(error)) invalidateWriteResult(tab, capturedResult);
          throw error;
        } finally { tab.importing = false; tab.cellBatchSaving = null; renderTabs(); }
      },
      onComplete: async outcome => {
        if (outcome.txOpen) {
          showToast(`已导入 ${outcome.rowCount} 行，尚未提交事务；提交或回滚后刷新查看`);
          return;
        }
        let refreshFailed = false;
        if (activeTab() === tab) {
          try { await runQuery({ preserveResult: true }); if (tab.error) throw new Error(tab.message); }
          catch { refreshFailed = true; }
        }
        showToast(`已导入 ${outcome.rowCount} 行${outcome.txOpen ? "，尚未提交事务" : ""}${refreshFailed ? "；刷新失败，请手动刷新，不要重复导入" : ""}`, refreshFailed ? "error" : "info");
      },
    });
  } catch (error) { showToast(`导入失败：${errorText(error)}`, "error"); }
}

function cellDraftsForTabs(tabs) {
  return tabs.map(tab => tab.result?.rows).filter(rows => Array.isArray(rows) && resultGrid.getCellEditDraft(rows));
}
function hasSavingCellDrafts(drafts) {
  const pending = drafts.some(rows => resultGrid.getCellEditDraft(rows)?.pending);
  if (pending) showToast("请等待单元格保存完成");
  return pending;
}
function discardCellDrafts(drafts) {
  return drafts.every(rows => resultGrid.discardCellEdit(rows));
}
async function confirmDiscardCellEdits(tabs) {
  const drafts = cellDraftsForTabs(tabs);
  if (!drafts.length) return true;
  if (hasSavingCellDrafts(drafts)) return false;
  if (!await confirmAction("当前有尚未保存的单元格修改。继续操作会放弃这些修改。", { title: "放弃单元格修改？", acceptLabel: "放弃并继续" })) return false;
  return discardCellDrafts(drafts);
}

function cellDestination(tab) {
  const profile = state.profiles.find(item => item.id === tab.connectionId);
  const table = tab.browse || tab.result?.editTable;
  return JSON.stringify({
    connection: tab.connectionId, driver: driverForTab(tab), database: tabDatabase(tab), schema: tabSchema(tab),
    endpoint: profile && [profile.host, profile.port, profile.user, profile.driver, profile.database],
    table: table && [table.schema, table.name, table.kind, table.primaryKeys, table.id],
    key: tab.redisKey, keyType: tab.redisType, redisDb: tab.redisKey != null ? redisTabDatabase(tab) : null,
  });
}
function transactionDidRollback(error, driver) {
  return error?.rollback === "succeeded" || (errorText(error).includes("[TX_ROLLED_BACK]") && !errorText(error).includes("[TX_OUTCOME_UNKNOWN]"));
}
function transactionDidEnd(error) {
  return transactionDidRollback(error) || errorText(error).includes("[TX_MISSING]");
}
function transactionOutcomeUnknown(error) {
  return ["failed", "incomplete", "unconfirmed"].includes(error?.rollback) ||
    /\[(?:TX_OUTCOME_UNKNOWN|PG_OUTCOME_UNKNOWN)\]/.test(errorText(error)) || (errorText(error).includes("[TX_MISSING]") && !transactionDidRollback(error));
}
function invalidateWriteResult(tab, result) {
  // This request used an isolated session. Only invalidate its original
  // result; a transaction started later in the same database is unrelated.
  if (!result) return;
  result.transactionOutcomeUnknown = true;
  result.writeOutcomeUnknown = true;
  result.transactionRolledBack = false;
  if (tab.result === result) tab.message = "写入结果未知，修改草稿已保留，请刷新并核对数据库后再操作。";
}
function invalidateTransactionResults(connectionId, database, outcomeUnknown = false) {
  state.transactionKeys.delete(transactionKey(connectionId, database));
  for (const item of state.tabs) {
    if (item.connectionId === connectionId && tabDatabase(item) === database && item.result) {
      item.result.transactionRolledBack = !outcomeUnknown;
      item.result.transactionOutcomeUnknown = outcomeUnknown;
      item.result.writeOutcomeUnknown = false;
      item.message = outcomeUnknown ? "事务结果未知，先前的数据结果已失效，修改草稿已保留，请刷新并核对数据库。" : "当前事务已回滚，先前未提交的数据结果已失效，请刷新核对。";
    }
  }
}
function cellWritePending(tab) {
  return Boolean(tab && (state.disconnectingConnections?.has(tab.connectionId) || state.tabs.some(item => (item.cellSaving || item.cellBatchSaving || item.changingTransaction) && item.connectionId === tab.connectionId && tabDatabase(item) === tabDatabase(tab))));
}
function captureCellEdit(tab, cell, capability) {
  const result = tab.result;
  const table = tab.browse || result.editTable;
  return {
    tab, result, ...cell, capability, rowRef: result.rows[cell.rowIndex], row: [...result.rows[cell.rowIndex]],
    columns: result.columns.map(cellColumnName), destination: cellDestination(tab),
    connectionId: tab.connectionId, database: tabDatabase(tab), schema: tabSchema(tab), driver: driverForTab(tab),
    browse: table ? { ...table, primaryKeys: [...(table.primaryKeys || [])] } : null,
    key: tab.redisKey, keyType: tab.redisType, redisDb: tab.redisKey != null ? redisTabDatabase(tab) : null,
    location: result.editTable ? `${queryTargetDescription(tab)} · ${table.schema}.${table.name}` : queryTargetDescription(tab),
  };
}
function shouldInspectJsonCell(cell) {
  const tab = activeTab();
  const session = resultGrid.cellEditSession(cell.rowIndex, cell.columnIndex);
  const value = session ? (session.isNull ? null : session.draftValue) : cell.value;
  const displayed = value?.$dbStudio === 'mysql-binary' ? cellText(value) : value;
  const metadata = tab?.browse?.columns?.find(item => item.name === cell.column);
  const column = tab?.result?.columns?.[cell.columnIndex];
  const dataType = metadata?.dataType || (typeof column === 'object' ? column?.dataType : '') || '';
  return Boolean(jsonCellInfo(displayed, dataType, { allowJavaLong: driverForTab(tab) === 'redis' }));
}

function getCellEditState(cell) {
  const tab = activeTab();
  const capability = getCellEditCapability(tab, cell, driverForTab(tab));
  const table = tab?.browse || tab?.result?.editTable;
  if (capability.editable && driverForTab(tab) === "mysql" && state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab))) && table?.engine && !/^innodb$/i.test(table.engine)) return { ...capability, editable: false, reason: "当前表引擎不能保证事务回滚，请先结束事务" };
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
  if (tab.result.transactionOutcomeUnknown) throw new Error(`${tab.result.writeOutcomeUnknown ? "写入" : "事务"}结果未知，请先复制需要保留的修改，再刷新核对数据库`);
  if (tab.result.transactionRolledBack) throw new Error("当前事务已回滚，结果需要刷新；请先复制需要保留的修改后刷新数据");
  if (context.driver === "mysql" && state.transactionKeys.has(transactionKey(context.connectionId, context.database)) && context.browse?.engine && !/^innodb$/i.test(context.browse.engine)) throw new Error("当前表引擎不能保证事务回滚，请先结束事务");
  const capability = getCellEditCapability(ownSave ? { ...tab, cellSaving: false, cellBatchSaving: false } : tab, context, context.driver);
  if (!capability.editable) throw new Error(capability.reason);
  return capability;
}
async function commitCellValue(context, newValue, isNull = false, { confirm = true, quiet = false, batchToken = null } = {}) {
  const ownBatch = batchToken && context?.tab?.cellBatchSaving === batchToken;
  const capability = assertCellEditCurrent(context, Boolean(ownBatch));
  if (!ownBatch && cellWritePending(context.tab)) throw new Error("请等待当前单元格保存完成");
  const value = validateCellDraft(isNull ? null : newValue, capability);
  if ((value === null && context.value === null) || (value !== null && context.value !== null && value === cellText(context.value))) return true;
  const tab = context.tab;
  const txKey = transactionKey(context.connectionId, context.database);
  const txOpen = state.transactionKeys.has(txKey);
  const isRedis = context.driver === "redis";
  const sql = isRedis ? null : buildCellUpdateSql({ ...context.browse, ...context, schema: context.browse.schema, value,
    keyTypes: Object.fromEntries((context.browse.columns || []).map(field => [field.name, field.dataType])),
  });
  const redisIdentityColumn = { hash: 'field', list: 'index', zset: 'member' }[context.keyType];
  const field = isRedis && redisIdentityColumn ? String(context.row[context.columns.indexOf(redisIdentityColumn)]) : null;
  tab.cellSaving = true;
  renderTabs();
  try {
    const accepted = !confirm || await confirmAction(
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
      // Only the backend can confirm rollback. A lost transaction still
      // invalidates its results and retains drafts, with an unknown outcome.
      if (!isRedis && txOpen && transactionDidEnd(error)) invalidateTransactionResults(context.connectionId, context.database, transactionOutcomeUnknown(error));
      else if (!isRedis && transactionOutcomeUnknown(error)) invalidateWriteResult(tab, context.result);
      throw error;
    }
    if (!changedRows) throw new Error("数据库没有报告行变更，请刷新核对记录后再编辑");
    if (tab.result === context.result && tab.result.rows[context.rowIndex] === context.rowRef) {
      const row = [...context.row];
      const localValue = value !== null && context.driver === "postgres" &&
        (typeof context.value === "boolean" || /^(?:pg_catalog\.)?bool(?:ean)?$/i.test(capability.dataType))
        ? (/^\s*(?:true|t|yes|y|on|1)\s*$/i.test(value) ? true : /^\s*(?:false|f|no|n|off|0)\s*$/i.test(value) ? false : value)
        : value;
      row[context.columnIndex] = localValue;
      tab.result.rows[context.rowIndex] = row;
      // Saved text/JSON can change the retained size substantially. Re-estimate
      // on the next budget check, avoiding a full scan for every batch cell.
      delete tab.result.bytes;
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
    if (!quiet) showToast(txOpen ? "单元格已写入当前事务，尚未提交" : "单元格已保存");
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

async function commitTableCellEdits(drafts) {
  if (!drafts.length) return [];
  const tab = drafts[0].context?.tab;
  const result = drafts[0].context?.result;
  // Validate the entire captured set before the first write. A batch never
  // follows the active tab or the visible sort/filter order.
  if (!tab || cellWritePending(tab)) throw new Error("请等待当前保存完成");
  for (const draft of drafts) {
    if (draft.context?.tab !== tab || draft.context?.result !== result) throw new Error("只能保存当前表的修改");
    const capability = assertCellEditCurrent(draft.context);
    validateCellDraft(draft.isNull ? null : draft.newValue, capability);
    if (draft.context.driver !== "redis") buildCellUpdateSql({ ...draft.context.browse, ...draft.context, schema: draft.context.browse.schema, value: draft.isNull ? null : draft.newValue,
      keyTypes: Object.fromEntries((draft.context.browse.columns || []).map(field => [field.name, field.dataType])),
    });
  }
  const batchToken = {};
  tab.cellBatchSaving = batchToken;
  renderTabs();
  const outcomes = [];
  try {
    for (const draft of drafts) {
      try {
        const saved = await commitCellValue(draft.context, draft.newValue, draft.isNull, { confirm: false, quiet: true, batchToken });
        if (!saved) throw new Error("未能保存，修改已保留");
        outcomes.push({ saved: true });
      } catch (error) {
        const message = errorText(error);
        if (result.transactionRolledBack || (result.transactionOutcomeUnknown && !result.writeOutcomeUnknown)) {
          const status = result.transactionOutcomeUnknown ? "事务结果未知" : "事务已回滚";
          outcomes.length = 0;
          while (outcomes.length < drafts.length) outcomes.push({ saved: false, error: `${status}，草稿已保留，请刷新核对` });
          showToast(`保存失败，${status}；修改草稿已保留，请刷新核对`, "error");
        } else {
          const saved = outcomes.length;
          while (outcomes.length < drafts.length) outcomes.push({ saved: false, error: message });
          showToast(`已保存 ${saved} 格，剩余 ${drafts.length - saved} 格修改已保留：${message}`, "error");
        }
        return outcomes;
      }
    }
    const txOpen = state.transactionKeys.has(transactionKey(tab.connectionId, tabDatabase(tab)));
    showToast(`已保存 ${outcomes.length} 格${txOpen ? "，已写入当前事务，尚未提交" : ""}`);
    return outcomes;
  } finally {
    if (tab.cellBatchSaving === batchToken) tab.cellBatchSaving = null;
    renderTabs();
  }
}

function openCellInspector({ column, columnIndex, value, rowIndex, context = null, draftValue, draftIsNull }) {
  const tab = context?.tab || activeTab();
  const capability = getCellEditCapability(tab, { column, columnIndex, rowIndex }, driverForTab(tab));
  if (!context && capability.editable) context = captureCellEdit(tab, { column, columnIndex, value, rowIndex }, capability);
  const hasDraft = typeof draftValue === "string";
  const displayedValue = hasDraft ? draftValue : value?.$dbStudio === "mysql-binary" ? cellText(value) : value;
  const columnMetadata = tab?.browse?.columns?.find((item) => item.name === column);
  const dataType = columnMetadata?.dataType || "";
  const jsonInfo = jsonCellInfo(displayedValue, dataType, { allowJavaLong: driverForTab(tab) === 'redis' });
  state.cellInspector = { tab, column, columnIndex, value, rowIndex, context, capability, jsonInfo, jsonMode: 'pretty', jsonEditing: false, reading: false };
  refs.cellModal.classList.remove('cell-expanded');
  refs.cellModal.classList.toggle('cell-json-view', Boolean(jsonInfo));
  refs.expandCell.setAttribute('aria-pressed', 'false');
  refs.expandCell.textContent = '放大窗口';
  refs.expandCell.title = '放大详情窗口';
  cellReader.setWrap(true); refs.cellWrap.setAttribute('aria-pressed', 'true');
  refs.cellTitle.textContent = column;
  refs.cellMeta.textContent = `第 ${rowIndex + 1} 行 · ${dataType || (value === null ? 'NULL' : typeof value)}`;
  refs.cellValue.value = hasDraft ? draftValue : jsonInfo?.raw ?? (value === null ? "" : cellText(value));
  state.cellInspector.sourceText = hasDraft ? draftValue : jsonInfo?.raw ?? (value === null ? '' : cellText(value));
  state.cellInspector.textBaseline = refs.cellValue.value;
  refs.cellNull.checked = hasDraft ? Boolean(draftIsNull) : value === null;
  refs.cellFeedback.textContent = "";
  const canEdit = capability.editable;
  refs.cellNullControl.hidden = !canEdit || !capability.allowNull;
  refs.setCellEmpty.hidden = !canEdit || !capability.allowEmpty;
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
  if (!jsonInfo && (!canEdit || refs.cellValue.value.length > 800 || refs.cellValue.value.split('\n').length > 8)) setCellReading(true);
  syncCellReadingTools();
  refs.cellModal.tabIndex = -1;
  if (!refs.cellModal.open) refs.cellModal.showModal();
  requestAnimationFrame(() => {
    if (state.cellInspector?.reading || (jsonInfo && !state.cellInspector?.jsonEditing)) refs.cellModal.focus({ preventScroll: true });
    else {
      refs.cellValue.focus({ preventScroll: true });
      refs.cellValue.select();
    }
  });
}
function renderCellJsonPreview() {
  const inspector = state.cellInspector;
  if (!inspector?.jsonInfo) return;
  const isJson = inspector.jsonInfo.valid !== false;
  let source = inspector.jsonInfo.raw;
  refs.cellJsonFormatControls.hidden = !isJson;
  refs.cellJsonCaption.textContent = isJson ? (inspector.jsonInfo.compatible ? '非标准 JSON，已兼容预览' : 'JSON 预览') : (source === '' ? '空字符串预览' : '文本预览');
  refs.editCellJson.textContent = isJson ? '编辑 JSON' : '编辑内容';
  if (isJson && inspector.jsonMode !== 'raw') {
    try { source = formatJsonSource(source, inspector.jsonMode === 'pretty'); }
    catch (error) { inspector.jsonMode = 'raw'; refs.cellFeedback.textContent = errorText(error); }
  }
  const pretty = inspector.jsonMode === 'pretty';
  cellReader.show(refs.cellNull.checked ? 'NULL' : source, { isJson: isJson && !refs.cellNull.checked });
  refs.cellJsonPretty.setAttribute("aria-pressed", String(pretty));
  refs.cellJsonCompact.setAttribute("aria-pressed", String(inspector.jsonMode === 'compact'));
  refs.cellJsonPretty.classList.toggle("active", pretty);
  refs.cellJsonCompact.classList.toggle("active", inspector.jsonMode === 'compact');
  refs.cellJsonRaw.setAttribute('aria-pressed', String(inspector.jsonMode === 'raw'));
  syncCellReadingTools();
}
function syncCellJsonSaveState() {
  const inspector = state.cellInspector;
  if (!inspector) return;
  const current = inspectorSourceValue(inspector, refs.cellValue.value);
  const changed = refs.cellNull.checked ? inspector.value !== null : inspector.value === null || current !== cellText(inspector.value);
  refs.restoreCellValue.hidden = !inspector.capability.editable || !changed;
  if (inspector.jsonInfo) refs.saveCell.hidden = !inspector.capability.editable || !changed;
}

function syncCellReadingTools() {
  const inspector = state.cellInspector; if (!inspector) return;
  syncCellJsonSaveState();
  const reading = inspector.reading || (inspector.jsonInfo && !inspector.jsonEditing);
  if (!reading) cellReader.closeFind();
  refs.cellFind.disabled = refs.cellWrap.disabled = !reading;
  refs.cellReadMode.hidden = Boolean(inspector.jsonInfo) || !inspector.capability.editable;
  refs.cellReadMode.textContent = reading ? '编辑内容' : '阅读模式';
  refs.cellSize.textContent = refs.cellNull.checked ? 'NULL' : valueMetricsLabel(inspector.jsonInfo && !inspector.jsonEditing ? inspector.jsonInfo.raw : refs.cellValue.value);
  if (inspector.jsonInfo && !refs.cellNull.checked) refs.cellSize.textContent = `原文 ${refs.cellSize.textContent}`;
  refs.cellSize.title = '原始内容的字符、行数和 UTF-8 大小；显示格式不会改变保存内容';
}
function setCellReading(reading) {
  const inspector = state.cellInspector; if (!inspector || inspector.jsonInfo) return;
  inspector.reading = reading;
  refs.cellValue.hidden = reading; refs.cellJsonPreview.hidden = !reading;
  if (reading) cellReader.show(refs.cellNull.checked ? 'NULL' : inspectorSourceValue(inspector, refs.cellValue.value));
  else refs.cellValue.focus({ preventScroll: true });
  syncCellReadingTools();
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
  const chunks = []; let size = 0, last = '', stringStart = 0;
  const emit = value => {
    size += value.length;
    if (size > 8 * 1024 * 1024) throw new Error('格式化后的 JSON 过大，已保留完整原文视图');
    chunks.push(value); if (value.length) last = value[value.length - 1];
  };
  let depth = 0;
  let inString = false;
  let escaped = false;
  const indent = () => "  ".repeat(Math.min(depth, 60));
  const nextToken = (from) => {
    let index = from;
    while (index < text.length && /\s/.test(text[index])) index++;
    return text[index];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') { inString = false; emit(text.slice(stringStart, index + 1)); }
      continue;
    }
    if (/\s/.test(character)) continue;
    if (character === '"') {
      inString = true;
      stringStart = index;
    } else if (character === "{" || character === "[") {
      emit(character);
      depth++;
      if (nextToken(index + 1) !== (character === "{" ? "}" : "]")) emit(`\n${indent()}`);
    } else if (character === "}" || character === "]") {
      depth--;
      if (last !== (character === "}" ? "{" : "[")) emit(`\n${indent()}`);
      emit(character);
    } else if (character === ",") emit(`,\n${indent()}`);
    else if (character === ":") emit(': ');
    else {
      const start = index;
      while (index + 1 < text.length && !/[\s{}\[\],:"]/.test(text[index + 1])) index++;
      emit(text.slice(start, index + 1));
    }
  }
  return chunks.join('');
}
function toggleCellJsonEditing() {
  const inspector = state.cellInspector;
  if (!inspector?.jsonInfo) return;
  if (!inspector.jsonEditing) {
    inspector.jsonEditing = true;
    refs.cellValue.value = inspector.jsonInfo.raw;
    inspector.jsonEditBaseline = refs.cellValue.value;
    refs.cellValue.readOnly = false;
    refs.cellValue.hidden = false;
    refs.cellJsonPreview.hidden = true;
    refs.cellJsonFormatControls.hidden = true;
    refs.cellJsonCaption.textContent = inspector.jsonInfo.valid === false ? "文本编辑" : "JSON 编辑";
    refs.editCellJson.textContent = "返回预览";
    refs.saveCell.hidden = false;
    syncCellReadingTools();
    refs.cellValue.focus({ preventScroll: true });
    refs.cellValue.select();
    return;
  }
  let valid = true, compatible = false;
  const source = inspectorSourceValue(inspector, refs.cellValue.value);
  try { JSON.parse(source); }
  catch {
    compatible = Boolean(jsonCellInfo(source, '', { allowJavaLong: driverForTab(inspector.tab) === 'redis' })?.compatible);
    if (!compatible && !inspector.capability.allowEmpty) {
      showToast("JSON 格式无效，请修正后再返回预览", "error");
      refs.cellValue.focus();
      return;
    }
    valid = compatible;
  }
  inspector.jsonInfo = { raw: source, valid, ...(compatible ? { compatible: true } : {}) };
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
  const newValue = inspectorSourceValue(edit, refs.cellValue.value);
  refs.saveCell.disabled = true;
  refs.setCellEmpty.disabled = true;
  refs.restoreCellValue.disabled = true;
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
    refs.setCellEmpty.disabled = false;
    refs.restoreCellValue.disabled = false;
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
  if (dialog === refs.cellModal && state.cellInspector?.capability.editable) {
    const inspector = state.cellInspector;
    const current = inspectorSourceValue(inspector, refs.cellValue.value);
    const changed = refs.cellNull.checked ? inspector.value !== null : inspector.value === null || current !== cellText(inspector.value);
    if (changed) {
      inspector.closing = true;
      void confirmAction('当前单元格有尚未保存的修改，确定放弃并关闭？', { title: '放弃单元格修改', acceptLabel: '放弃修改' }).then(accepted => {
        inspector.closing = false;
        if (accepted && state.cellInspector === inspector) { clearDialogDraft(dialog); dialog.close(); }
      }).catch(error => { inspector.closing = false; showToast(errorText(error), 'error'); });
      return;
    }
  }
  clearDialogDraft(dialog);
  dialog.close();
}
function dialogIsBusy(dialog) {
  return (dialog === refs.connectionModal && (refs.saveConnection.disabled || refs.testConnection.disabled)) ||
    (dialog === refs.createObjectModal && state.pendingObjectCreate?.busy) ||
    (dialog === refs.cellModal && (refs.saveCell.disabled || state.cellInspector?.closing)) ||
    (dialog === refs.redisCreateModal && refs.applyRedisCreate.disabled) ||
    (dialog === refs.redisRenameModal && refs.applyRedisRename.disabled) ||
    (dialog === refs.mutationModal && refs.applyMutation.disabled);
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
    state.queryDatabaseLists.delete(saved.id);
    // The profile has been saved even if establishing the connection fails.
    await loadConnections({ restore: false });
    const tab = activeTab();
    if (tab && !tab.connectionId && !tab.sql.trim() && !tab.browse && !tab.redisKey) {
      tab.connectionId = saved.id;
      const postgres = (saved.driver || "postgres") === "postgres";
      tab.database = postgres ? null : saved.database || null;
      tab.awaitingDatabase = postgres;
      tab.chooseInitialDatabase = postgres;
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
    state.queryDatabaseLists.delete(id);
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
      state.databasesLoaded = false;
      state.systemDatabasesExpanded = false;
      state.redisDatabases = [];
      state.redisDatabaseError = null;
      state.redisExpanded.clear();
      state.redisPages.clear();
      state.redisScanGenerations.clear();
      state.redisSearches.clear();
      state.redisSearchScope = 'db'; state.redisGlobalSearch = ''; state.redisLocalExpanded = null; state.redisSearchEpoch++;
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
  initDialogBackdropDismissal();
  refs.retryDraftSave.addEventListener('click', () => {
    if (persistTabs()) showToast('SQL 草稿已保存至本机');
  });
  for (const id of dismissibleDialogIds) {
    const dialog = refs[id];
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!dialogIsBusy(dialog)) dismissDialog(dialog);
    });
    dialog.addEventListener("close", () => { if (!dialog.open) clearDialogDraft(dialog); });
  }
  refs.createObjectName.addEventListener("input", () => { refs.createObjectName.setCustomValidity(""); updateObjectActionPreview(); });
  for (const button of [refs.closeCreateObject, refs.cancelCreateObject]) {
    button.addEventListener("click", () => dismissDialog(refs.createObjectModal));
  }
  refs.createObjectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pending = state.pendingObjectCreate;
    const name = refs.createObjectName.value.trim();
    if (!pending || pending.busy) return;
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
    pending.busy = true;
    for (const input of refs.createObjectForm.querySelectorAll("input,select,button")) input.disabled = true;
    refs.createObjectFeedback.textContent = "";
    try {
      const result = await submitContextObjectAction(pending, name);
      pending.busy = false;
      dismissDialog(refs.createObjectModal);
      showToast(result.message, result.refreshError ? "error" : "info");
    } catch (error) {
      refs.createObjectFeedback.textContent = errorText(error);
      refs.createObjectFeedback.classList.add("error");
    } finally {
      pending.busy = false;
      for (const input of refs.createObjectForm.querySelectorAll("input,select,button")) input.disabled = false;
    }
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
  initConnectionReorder(refs.connectionList, (source, drop) => {
    if (!state.profiles.some(profile => profile.id === source)) return;
    const group = drop.groupId ?? connectionGroups.groupFor(drop.connectionId);
    const target = drop.connectionId ?? state.profiles.findLast(profile => profile.id !== source && connectionGroups.groupFor(profile.id) === group)?.id;
    let moved;
    try { moved = connectionGroups.moveTo(source, group); }
    catch (error) { showToast(`分组保存失败：${errorText(error)}`, 'error'); return; }
    const reordered = target ? moveConnection(state.profiles, source, target, drop.placement === 'into' ? 'after' : drop.placement) : state.profiles;
    const orderChanged = reordered.some((profile, index) => profile.id !== state.profiles[index]?.id);
    if (!moved && !orderChanged) return;
    if (orderChanged) state.profiles = reordered;
    const saved = !orderChanged || saveConnectionOrder(state.profiles);
    renderConnections();
    const message = moved ? `连接已移至「${connectionGroups.nameFor(source)}」` : "实例顺序已保存";
    showToast(saved ? message : moved ? `${message}，顺序保存失败` : "顺序已调整，本地保存失败", saved ? "info" : "error", saved ? 1200 : 7000);
  });
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
    const refreshed = await refreshExpandedDatabases();
    if (connectionId === state.activeConnectionId)
      showToast(refreshed ? "数据库对象已刷新" : "刷新未完成，部分对象读取失败", refreshed ? "info" : "error");
  });
  refs.collapseTree.addEventListener("click", () => {
    if (driverForConnection(state.activeConnectionId) === "redis") {
      state.redisExpanded.clear();
      if (state.redisLocalExpanded) state.redisLocalExpanded.clear();
      renderRedisTree();
      return;
    }
    state.expandedSchemas.clear();
    state.expandedDatabases.clear();
    state.systemDatabasesExpanded = false;
    renderTree();
  });
  refs.objectTree.addEventListener("keydown", (event) => {
    const keyRow = event.target.closest('[data-redis-key]');
    if (keyRow && !event.isComposing && !event.altKey && !event.shiftKey) {
      const action = event.key === 'F2' ? 'rename' : ['Backspace', 'Delete'].includes(event.key) ? 'delete'
        : (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' ? 'copy'
        : (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r' ? 'refresh' : null;
      if (action) {
        event.preventDefault(); event.stopPropagation();
        const target = treeTargetFromNode(keyRow);
        state.contextRedisKey = target.key; state.contextRedisDb = target.database; state.contextRedisConnectionId = target.connectionId;
        prepareRedisContextMenu(target, event.target);
        refs.redisContextMenu.querySelector(`[data-redis-context-action="${action}"]`).click();
        return;
      }
    }
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault(); event.stopPropagation();
      // A tree row keeps focus after its context menu opens: the first Esc closes the menu, not the selection.
      if ([refs.objectContextMenu, refs.redisContextMenu, refs.redisDatabaseContextMenu].some(menu => menu && !menu.hidden)) hideContextMenus();
      else clearTreeSelection();
      return;
    }
    if (event.target.closest('[data-tree-toggle]')) return;
    const row = event.target.closest('.tree-root, summary, .category-summary');
    if (!row || event.target !== row) return;
    if (row.matches(".category-summary") && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      const target = treeTargetFromNode(row);
      if (!target?.connectionId || state.connectionStatuses[target.connectionId] !== "connected") return;
      event.preventDefault();
      hideContextMenus();
      selectTreeTarget(target);
      state.contextObject = null;
      state.contextTreeTarget = target;
      prepareObjectContextMenu(target);
      const { left, bottom } = row.getBoundingClientRect();
      showContextMenu(refs.objectContextMenu, left, bottom);
      refs.objectContextMenu.querySelector('button:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
    } else if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (row.matches('.system-databases > summary')) toggleTreeRow(row);
      else selectTreeTarget(treeTargetFromNode(row));
    } else if (["ArrowRight", "ArrowLeft"].includes(event.key) && !row.matches('.tree-root')) {
      event.preventDefault();
      toggleTreeRow(row, event.key === "ArrowRight");
    }
  });
  refs.objectTree.addEventListener("click", async (event) => {
    const saved = event.target.closest("[data-tree-saved-query], [data-tree-remove-query]");
    if (saved) {
      const entry = savedTreeQueries.find(item => item.id === (saved.dataset.treeSavedQuery || saved.dataset.treeRemoveQuery));
      if (!entry) return;
      if (saved.hasAttribute("data-tree-remove-query")) {
        if (await confirmAction(`删除已保存的查询「${entry.title}」？`, { title: "删除查询", acceptLabel: "删除查询" })) {
          writeSavedTreeQueries(savedTreeQueries.filter(item => item.id !== entry.id));
        }
        return;
      }
      const tab = state.tabs.find(item => item.savedTreeQueryId === entry.id);
      if (tab) return activateTab(tab.id);
      const opened = openSavedQuery(entry);
      if (opened) opened.savedTreeQueryId = entry.id;
      return;
    }
    const keyInfo = event.target.closest('[data-redis-key-info]');
    if (keyInfo) { const row = keyInfo.closest('[data-redis-key]'); showRedisKeyDetails(row.dataset.redisKey, row.dataset.redisDb); return; }
    const disclosure = event.target.closest('[data-tree-toggle]');
    if (disclosure) {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail < 2) toggleTreeRow(disclosure.closest('summary, .category-summary'));
      return;
    }
    const systemHeader = event.target.closest('.system-databases > summary');
    if (systemHeader) {
      event.preventDefault();
      if (event.detail < 2) toggleTreeRow(systemHeader);
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
    const loadMore = event.target.closest("[data-load-more-redis-db]");
    if (loadMore) {
      await loadRedisKeys(Number(loadMore.dataset.loadMoreRedisDb), redisPage(Number(loadMore.dataset.loadMoreRedisDb)).cursor, redisPatternFor(Number(loadMore.dataset.loadMoreRedisDb)));
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
    const mysqlRetry = event.target.closest('[data-retry-mysql-db]');
    if (mysqlRetry) { await loadSchemas(mysqlRetry.dataset.retryMysqlDb); return; }
    const retrySchema = event.target.closest("[data-retry-schema]");
    if (retrySchema) {
      await loadSchemas(retrySchema.dataset.retrySchema);
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
    if (existing) {
      activateTab(existing.id);
      if (existing.browse && !existing.result?.executed && !existing.error) void loadOpenedObjectData(existing);
      else if (existing.structureOnly && !existing.structure && !existing.structurePending && !existing.structureError) void inspectObject(object, { tab: existing, connectionId: existing.connectionId });
    } else if (["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(object.kind)) {
      void openObjectQuery(object);
    } else openObjectStructureTab(object, state.activeConnectionId, { fromTreeClick: event.detail === 1 });
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
      const menu = prepareRedisContextMenu(target, event.target.closest('[data-redis-key]')?.querySelector('.object-main') || event.target);
      showContextMenu(menu, event.clientX, event.clientY);
      menu.querySelector('button:not(:disabled):not([hidden])')?.focus({ preventScroll: true });
      return;
    }
    state.contextObject = target.object || null;
    state.contextTreeTarget = target;
    prepareObjectContextMenu(target);
    showContextMenu(refs.objectContextMenu, event.clientX, event.clientY);
  });
  const clearParent = refs.objectContextMenu.querySelector('[data-context-action="clear-table"]');
  const catalogIcons = { ...kindIcons, database: databaseIcon, schema: schemaIcon };
  for (const icon of refs.objectContextMenu.querySelectorAll('.catalog-create-icon')) {
    icon.innerHTML = catalogIcons[icon.dataset.catalogIcon];
  }
  clearParent.addEventListener('pointerenter', () => openClearSubmenu());
  clearParent.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); openClearSubmenu(true); }
  });
  refs.objectContextMenu.addEventListener('pointerover', event => {
    const item = event.target.closest('[data-context-action]');
    if (item && item !== clearParent) closeClearSubmenu();
  });
  refs.objectContextMenu.addEventListener('pointerleave', () => { clearSubmenuTimer = setTimeout(closeClearSubmenu, 200); });
  refs.clearTableSubmenu.addEventListener('pointerenter', () => clearTimeout(clearSubmenuTimer));
  refs.clearTableSubmenu.addEventListener('pointerleave', () => { clearSubmenuTimer = setTimeout(closeClearSubmenu, 200); });
  refs.clearTableSubmenu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); closeClearSubmenu(); clearParent.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const buttons = [...refs.clearTableSubmenu.querySelectorAll('button')];
      buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  });
  refs.clearTableSubmenu.addEventListener('click', event => {
    const method = event.target.closest('[data-clear-method]')?.dataset.clearMethod;
    const target = state.contextTreeTarget;
    if (!method || !target) return;
    hideContextMenus(); void clearTableData(target, method);
  });
  refs.objectContextMenu?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-context-action]")?.dataset.contextAction;
    const target = state.contextTreeTarget;
    const object = target?.type === "object" ? target.object : null;
    if (!action || !target) return;
    if (action === "clear-table") { openClearSubmenu(true); return; }
    hideContextMenus();
    if (action === "copy-ddl") return copyContextDdl(target);
    if (action === "new-database-query") return openDatabaseContextQuery(target);
    if (action === "save-tree-query") return saveTreeQuery(target);
    if (action === "refresh-database") return refreshDatabaseContext(target);
    if (action === "refresh-databases") return refreshDatabaseList(target);
    if (action === "refresh-redis") return refreshRedisContext();
    if (action === "refresh-schema" && target.type === "category") return refreshTreeCategory(target);
    if (action === "refresh-schema" || action === "refresh-object") return refreshTreeObject(target);
    if (action === "create-function") return createFromTreeCategory(target, "function");
    if (action === "create-procedure") return createFromTreeCategory(target, "procedure");
    if (action === "create-materialized-view") return createFromTreeCategory(target, "materialized_view");
    if (action === "edit-structure") return openTableStructureEditor(target);
    if (action === "create-view" || action === "edit-view") return editView(target);
    if (action === "refresh-matview") return refreshMaterializedView(target);
    if (action === "edit-routine") return editRoutine(target);
    if (action === "call-routine") return openRoutineCall(target);
    if (action === "mysql-characters") return showMysqlCharacterSettings(target);
    if (action === "drop-table" || action === "drop-schema" || action === "drop-database") return deleteDatabaseObject(target, action);
    if (["create-database", "create-schema", "create-table", "rename-table"].includes(action)) {
      return openContextObjectDialog(target, action);
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
    if (!action || key == null) return;
    const connectionId = contextConnectionId || state.activeConnectionId;
    const targetTab = activeTab()?.redisKey === key && activeTab()?.connectionId === connectionId && redisTabDatabase(activeTab()) === contextDatabase
      ? activeTab()
      : state.tabs.find((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase);
    const modeTab = targetTab || (activeTab()?.connectionId === connectionId ? activeTab() : null);
    // A selected connection without an open key tab uses the app's default
    // writable mode. Once a key tab exists, its lock controls mutations.
    const readOnly = modeTab ? modeTab.mode !== "write" : false;
    hideContextMenus();
    if (action === 'details') return showRedisKeyDetails(key, contextDatabase, connectionId);
    if (action === "open") return openRedisValueTab(key, contextDatabase);
    if (['create', 'duplicate', 'ttl', 'member', 'rename', 'delete'].includes(action) && (readOnly || cellWritePending(modeTab))) return showToast(readOnly ? '当前 Redis 标签为只读，请先解锁' : '请等待当前写入完成', 'error');
    if (action === 'create') return openRedisCreate(connectionId, contextDatabase, key.includes(':') ? key.slice(0, key.lastIndexOf(':') + 1) : '');
    if (action === 'duplicate') {
      if (targetTab && resultGrid.getCellEditDraft(targetTab.result?.rows)) return showToast('请先保存或取消这个 Key 的未保存修改', 'error');
      return openRedisNameDialog(key, contextDatabase, connectionId, true);
    }
    if (action === 'ttl' || action === 'member') {
      const tab = await openRedisValueTab(key, contextDatabase);
      if (tab && state.activeConnectionId === connectionId && activeTab() === tab) openRedisKeyOperation(action === 'ttl' ? 'ttl' : 'add');
      return;
    }
    if (action === 'copy-value') {
      try {
        const value = await call('get_redis_value', { connectionId, database: contextDatabase, key });
        await copyText(redisValueForCopy(value), { allowEmpty: true }); showToast('已复制值');
      } catch (error) { showToast(errorText(error), 'error'); }
      return;
    }
    if (action === "refresh") {
      if (targetTab && !await confirmDiscardCellEdits([targetTab])) return;
      const generation = state.redisRequest;
      const current = () => connectionId === state.activeConnectionId && generation === state.redisRequest;
      try {
        const value = await call("get_redis_value", { connectionId, database: contextDatabase, key });
        if (!current()) return;
        for (const tab of state.tabs.filter((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase)) {
          if (!tab.running && !tab.refreshing) applyRedisValueResult(tab, value, connectionId, contextDatabase);
        }
        if (activeTab()?.redisKey === key && activeTab()?.connectionId === connectionId && redisTabDatabase(activeTab()) === contextDatabase) renderOutput();
        const refreshed = await loadRedisKeys(contextDatabase, 0, redisPatternFor(contextDatabase), connectionId, generation);
        if (refreshed && current()) showToast("Redis key 已刷新");
        else if (current()) showToast(`刷新 key 列表失败：${redisPage(contextDatabase).error || "请重试"}`, "error");
      } catch (error) {
        if (current()) showToast(`刷新 Redis key 失败：${errorText(error)}`, "error");
      }
      return;
    }
    if (action === "copy") {
      try {
        await copyText(key);
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
      if (targetTab && resultGrid.getCellEditDraft(targetTab.result?.rows)) return showToast('请先保存或取消这个 Key 的未保存修改', 'error');
      if (!await confirmAction(`删除后无法恢复。请确认执行位置和 Key 名称。`, { title: '删除 Key', detail: `${redisLocation({ database: contextDatabase, connectionName: state.profiles.find(profile => profile.id === connectionId)?.name })}\n${key}`, acceptLabel: '删除 Key' })) return;
      try {
        await call("delete_redis_key", { connectionId, database: contextDatabase, key, readOnly: false });
        closeTabsByIds(state.tabs.filter((tab) => tab.redisKey === key && tab.connectionId === connectionId && redisTabDatabase(tab) === contextDatabase).map((tab) => tab.id));
        await loadRedisKeys(contextDatabase, 0, redisPatternFor(contextDatabase));
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
      if (targetTab && resultGrid.getCellEditDraft(targetTab.result?.rows)) return showToast('请先保存或取消这个 Key 的未保存修改', 'error');
      openRedisNameDialog(key, contextDatabase, connectionId);
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
      return openRedisCreate(connectionId, database);
    }
    if (action !== "console") return;
    rememberActiveView();
    closeRedisConsole({ render: false });
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
    const connectionId = state.activeConnectionId;
    const driver = driverForConnection(connectionId);
    if (driver === "redis") {
      queueRedisSearch();
      return;
    }
    renderTree();
    const query = refs.objectSearch.value.trim();
    if (driver === "mysql" || !query || state.connectionStatuses[connectionId] !== "connected") return;
    const expanded = [...state.expandedDatabases].filter(database => databaseTreeExpanded(database, driver));
    await Promise.all(expanded.map(database => loadExpandedDatabase(database, driver)));
    if (state.activeConnectionId !== connectionId || refs.objectSearch.value.trim() !== query) return;
    await Promise.all(expanded.filter(database => databaseTreeExpanded(database, driver)).flatMap(database =>
      (state.schemasByDatabase.get(database) || [])
        .filter(schema => state.visibleSchemasByDatabase.get(database)?.has(schema.name))
        .map(schema => loadSchemaObjects(database, schema.name)),
    ));
  });
  refs.redisSearchDatabase.addEventListener('change', () => changeRedisSearchScope(refs.redisSearchDatabase.value));
  refs.addQueryTab.addEventListener("click", () => addTab());
  refs.querySchemaBack.addEventListener("click", () => {
    const tab = activeTab();
    if (queryTargetLocked(tab)) return;
    state.queryTargetNavigation = { tabId: tab.id, database: null };
    renderQueryTarget(tab);
    refs.querySchemaSearch.focus();
  });
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
    const buttons = [...document.querySelectorAll('.result-tabs [role="tab"]')].filter(button => !button.disabled && !button.hidden);
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
    const row = event.target.closest(".query-tab");
    const tab = state.tabs.find(item => item.id === row?.dataset.tabId);
    if (!tab) return;
    event.preventDefault();
    hideContextMenus();
    state.contextTabId = tab.id;
    refs.tabReadOnly.setAttribute("aria-checked", String(tab.mode === "read"));
    refs.tabReadOnly.disabled = Boolean(tab.running || tab.confirming || tab.resolvingTarget || cellWritePending(tab));
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
    if (tab?.structureOnly) {
      const object = tab.inspectedObject || tab.openedObject;
      if (!object) return;
      const sql = ["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(object.kind)
        ? browseSql({ ...object, connectionId: tab.connectionId, page: 0, pageSize: 500 }) : "";
      addTab(sql, tab.connectionId, null, { database: object.database || tabDatabase(tab), schema: object.schema });
      return;
    }
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
  refs.viewTableDdl.addEventListener("click", () => {
    const tab = activeTab();
    const object = tab?.browse || tab?.inspectedObject || tab?.openedObject;
    if (object) void showObjectDdl(object, tab);
  });
  refs.refreshTableData?.addEventListener("click", async () => {
    const tab = activeTab();
    if (cellWritePending(tab)) return;
    if (tab?.outputTab === "structure" && (tab.inspectedObject || tab.browse)) {
      if (!tab.running && !tab.confirming) await inspectObject(tab.inspectedObject || tab.browse, { connectionId: tab.connectionId, tab });
      return;
    }
    if (!tab) return;
    if (tab?.redisKey) {
      if (tab.refreshing || !await confirmDiscardCellEdits([tab]) || activeTab() !== tab) return;
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
    if (!tab?.browse || tab.paging || tab.running) return;
    if (!tab.browse.detailsLoaded) {
      try { await loadBrowseDetails(tab); } catch (error) { showToast(errorText(error), "error"); return; }
    }
    state.applyingBrowse = true;
    setEditorValue(browseSql(tab.browse));
    state.applyingBrowse = false;
    await runQuery({ preserveResult: true });
  });
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
    tab.consoleHistory = []; tab.consoleRevision = (tab.consoleRevision || 0) + 1; persistTabs(); renderRedisConsole(tab);
  });
  refs.redisConsoleOutput.addEventListener("click", async event => {
    const tab = activeExecutionTab();
    if (!tab?.console) return;
    const reuse = event.target.closest("[data-redis-reuse]");
    const copy = event.target.closest("[data-redis-copy]");
    const example = event.target.closest("[data-redis-example]");
    if (example || reuse) {
      if (reuse && tab.consoleHistory[Number(reuse.dataset.redisReuse)]?.commandTruncated) return;
      redisEditor.setValue(example?.dataset.redisExample ?? tab.consoleHistory[Number(reuse.dataset.redisReuse)]?.command ?? "");
      redisEditor.focus();
    }
    if (copy) {
      try { const entry = tab.consoleHistory[Number(copy.dataset.redisCopy)]; await copyText(consoleOutputForCopy(entry), { allowEmpty: true }); showToast(entry.truncated || entry.outputTruncated ? "已复制部分输出预览" : "已复制执行结果"); }
      catch { showToast("复制失败", "error"); }
    }
  });
  redisTypePicker = createRedisTypePicker({ input: refs.redisCreateType, trigger: refs.redisCreateTypeTrigger,
    menu: refs.redisCreateTypeMenu, label: refs.redisCreateTypeValue, icon: refs.redisCreateTypeIcon,
    detail: refs.redisCreateTypeDetail, dialog: refs.redisCreateModal });
  refs.redisCreateType.addEventListener("change", syncRedisCreateType);
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
    const key = refs.redisCreateKey.value;
    const activeTabId = state.activeTabId, activeConsole = state.redisConsole, connectionRequest = state.schemaRequest;
    const sameDestination = () => state.activeConnectionId === pending.connectionId && state.schemaRequest === connectionRequest;
    const canOpenCreatedKey = () => sameDestination() && Number(state.redisActiveDatabase) === Number(pending.database) &&
      state.activeTabId === activeTabId && state.redisConsole === activeConsole && activeExecutionTab() === tab;
    refs.applyRedisCreate.disabled = true;
    let created = false;
    try {
      await call("create_redis_key", { request: { ...pending,
        key, keyType: refs.redisCreateType.value,
        value: refs.redisCreateValue.value, field: refs.redisCreateField.value,
        score: Number(refs.redisCreateScore.value), ttl: Number(refs.redisCreateTtl.value), readOnly: false } });
      created = true;
      state.pendingRedisCreate = null;
      refs.redisCreateModal.close();
      let refreshFailed = false, readFailed = false, protectedDraft = false;
      if (sameDestination()) {
        state.redisExpanded.add(pending.database);
        try { refreshFailed = await refreshRedisTree() === false && canOpenCreatedKey(); }
        catch { refreshFailed = true; }
      }
      if (canOpenCreatedKey()) {
        const existing = state.tabs.find(item => item.connectionId === pending.connectionId && item.redisKey === key &&
          redisTabDatabase(item) === Number(pending.database) && item.tableView !== false && !item.console);
        protectedDraft = Boolean(existing && (resultGrid.getCellEditDraft(existing.result?.rows) || existing.refreshing || cellWritePending(existing)));
        if (!protectedDraft) {
          // A recreated Key can reuse an expired Key's tab. Do not display its
          // old cached value, or replace drafts still attached to that result.
          try {
            if (existing) {
              existing.result = emptyResult(); existing.gridState = null;
              await restoreRedisKeyResult(existing);
              readFailed = !existing.result?.executed || Boolean(existing.error);
            }
            if (!readFailed && canOpenCreatedKey()) {
              const opened = await openRedisValueTab(key, Number(pending.database));
              readFailed = !opened?.result?.executed || Boolean(opened.error);
            }
          } catch { readFailed = true; }
        }
      }
      showToast(protectedDraft ? "Redis key 已创建；原标签仍有未保存修改或操作，请处理后刷新查看"
        : readFailed ? "Redis key 已创建，但读取失败；请在对象树中打开 Key 重试"
        : refreshFailed ? "Redis key 已创建，但目录刷新失败；请手动刷新"
        : "Redis key 已创建", readFailed || refreshFailed ? "error" : "info");
    } catch (error) {
      // Only a failed CREATE leaves an actionable form. Read/refresh failures
      // after success must never invite replaying the mutation.
      if (created) showToast(`Redis key 已创建，但刷新失败：${errorText(error)}`, "error");
      else refs.redisCreateFeedback.textContent = errorText(error);
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
  refs.resultTab.addEventListener("click", () => { void showTableData(); });
  refs.structureTab.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.browse) void openObjectStructureTab(tab.browse, tab.connectionId, { prefetched: tab.structureLoad || tab.structure, mode: tab.mode });
  });
  refs.messageTab.addEventListener("click", () => {
    activeTab().outputTab = "message";
    renderOutput();
  });
  const executionCopyActions = [
    [refs.copyExecutionError, refs.executionErrorMessage, "复制错误"],
    [refs.copyExecutionSql, refs.executionDetailsSql, "复制 SQL"],
  ];
  for (const [button, source] of executionCopyActions) {
    button.addEventListener("click", async () => {
      const details = executionDetails;
      let feedback;
      try {
        await copyText(source.textContent);
        feedback = "已复制";
      } catch {
        feedback = "复制失败，重试";
      }
      if (refs.executionDetailsModal.open && executionDetails === details) button.textContent = feedback;
    });
  }
  refs.closeExecutionDetails.addEventListener("click", event => {
    if (executionDetails) executionDetails.pointerDismissal = event.detail > 0;
  });
  refs.executionDetailsModal.addEventListener("cancel", event => {
    if (executionDetails) executionDetails.pointerDismissal = event.detail === "backdrop";
  });
  refs.executionDetailsModal.addEventListener("close", () => {
    if (refs.executionDetailsModal.open) return;
    const details = executionDetails;
    executionDetails = null;
    if (details?.pointerDismissal && document.activeElement === details.trigger) details.trigger.blur();
    for (const [button, source, label] of executionCopyActions) {
      button.textContent = label;
      source.textContent = "";
    }
    refs.executionDetailsTarget.textContent = "";
  });
  refs.resultFilter.addEventListener("input", () => {
    activeTab().filter = refs.resultFilter.value;
    renderOutput();
  });
  refs.previousPage.addEventListener("click", () => moveBrowsePage(-1));
  refs.nextPage.addEventListener("click", () => moveBrowsePage(1));
  refs.pageJumpForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void jumpBrowsePage(refs.pageJumpInput.value);
  });
  refs.copyResults.addEventListener("click", copyResults);
  refs.resultMoreMenu.querySelectorAll('[data-export-format]').forEach(button => button.addEventListener("click", () => void exportResults(button.dataset.exportFormat)));
  refs.dataImportMenu.querySelectorAll('[data-import-format]').forEach(button => button.addEventListener("click", () => chooseTableImport(button.dataset.importFormat)));
  refs.tableImportFile.addEventListener("change", () => void readTableImport());
  refs.closeCell.addEventListener("click", () => dismissDialog(refs.cellModal));
  const keyTitleDetails = () => { const tab = activeTab(); if (tab?.redisKey != null) showRedisKeyDetails(tab.redisKey, redisTabDatabase(tab), tab.connectionId); };
  refs.tableToolbarTitle.addEventListener('click', keyTitleDetails);
  refs.tableToolbarTitle.addEventListener('keydown', event => { if (event.currentTarget.getAttribute('role') === 'button' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); keyTitleDetails(); } });
  refs.expandCell.addEventListener('click', () => {
    const expanded = refs.cellModal.classList.toggle('cell-expanded'); refs.expandCell.textContent = expanded ? '恢复窗口' : '放大窗口'; refs.expandCell.title = expanded ? '恢复详情窗口大小' : '放大详情窗口'; refs.expandCell.setAttribute('aria-pressed', String(expanded)); cellReader.measure();
  });
  refs.cellModal.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && !event.isComposing && event.keyCode !== 229 && (state.cellInspector?.reading || (state.cellInspector?.jsonInfo && !state.cellInspector.jsonEditing))) {
      event.preventDefault(); event.stopPropagation(); cellReader.toggleFind(); return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopPropagation(); textInputIme.finish();
      if (!refs.saveCell.hidden && !refs.saveCell.disabled) refs.saveCell.click();
    }
  }, true);
  refs.cellWrap.addEventListener('click', () => { const wrap = refs.cellWrap.getAttribute('aria-pressed') !== 'true'; refs.cellWrap.setAttribute('aria-pressed', String(wrap)); cellReader.setWrap(wrap); });
  refs.cellFind.addEventListener('click', () => cellReader.toggleFind());
  refs.cellReadMode.addEventListener('click', () => setCellReading(!state.cellInspector?.reading));
  const closeRedisRename = () => dismissDialog(refs.redisRenameModal);
  refs.closeRedisRename?.addEventListener("click", closeRedisRename);
  refs.cancelRedisRename?.addEventListener("click", closeRedisRename);
  refs.redisRenameInput.addEventListener('input', () => { refs.redisRenameFeedback.textContent = ''; });
  refs.redisRenameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pending = state.pendingRedisRename;
    const newKey = refs.redisRenameInput.value;
    if (!pending || refs.applyRedisRename.disabled) return;
    if (!newKey || newKey === pending.key) { refs.redisRenameFeedback.textContent = '请填写不同的新 Key 名称'; return; }
    if (redisContextState(pending.key, pending.database, pending.connectionId).readOnly) { refs.redisRenameFeedback.textContent = '当前标签为只读，请先解锁'; return; }
    refs.applyRedisRename.disabled = true;
    refs.redisRenameInput.disabled = true;
    try {
      const renamed = await call(pending.duplicate ? 'copy_redis_key' : "rename_redis_key", {
        request: { connectionId: pending.connectionId, database: pending.database, key: pending.key, newKey, preserveTtl: refs.redisCopyTtl.checked, readOnly: false },
      });
      if (!pending.duplicate && !renamed) {
        refs.redisRenameFeedback.textContent = "目标 key 已存在，未覆盖原数据。";
        return;
      }
      for (const tab of state.tabs) {
        if (!pending.duplicate && tab.redisKey === pending.key && tab.connectionId === pending.connectionId && redisTabDatabase(tab) === pending.database) {
          tab.redisKey = newKey;
          tab.title = newKey;
        }
      }
      persistTabs();
      state.pendingRedisRename = null; refs.redisRenameModal.close();
      const refreshed = state.activeConnectionId === pending.connectionId ? await loadRedisKeys(pending.database, 0, redisPatternFor(pending.database), pending.connectionId, state.redisRequest) : true;
      renderTabs();
      showToast(`${pending.duplicate ? 'Key 副本已创建' : 'Redis key 已重命名'}${refreshed ? '' : '；列表刷新失败，请手动刷新'}`, refreshed ? 'info' : 'error');
    } catch (error) {
      refs.redisRenameFeedback.textContent = errorText(error);
    } finally {
      refs.applyRedisRename.disabled = false;
      refs.redisRenameInput.disabled = false;
    }
  });
  refs.saveCell?.addEventListener("click", saveCellEdit);
  refs.restoreCellValue.addEventListener('click', () => {
    const inspector = state.cellInspector;
    if (!inspector?.capability.editable || refs.saveCell.disabled) return;
    const expanded = refs.cellModal.classList.contains('cell-expanded');
    const wrap = refs.cellWrap.getAttribute('aria-pressed') === 'true';
    const { column, columnIndex, value, rowIndex, context } = inspector;
    openCellInspector({ column, columnIndex, value, rowIndex, context });
    refs.cellModal.classList.toggle('cell-expanded', expanded);
    refs.expandCell.setAttribute('aria-pressed', String(expanded));
    refs.expandCell.textContent = expanded ? '恢复窗口' : '放大窗口';
    refs.expandCell.title = expanded ? '恢复详情窗口大小' : '放大详情窗口';
    refs.cellWrap.setAttribute('aria-pressed', String(wrap));
    cellReader.setWrap(wrap); cellReader.measure();
  });
  refs.setCellEmpty.addEventListener('click', () => {
    const inspector = state.cellInspector;
    if (!inspector?.capability.editable || !inspector.capability.allowEmpty) return;
    if (inspector.jsonInfo && !inspector.jsonEditing) toggleCellJsonEditing();
    refs.cellNull.checked = false; refs.cellValue.disabled = false;
    refs.cellValue.value = ''; refs.cellFeedback.textContent = '';
    if (inspector.jsonInfo && inspector.jsonEditing) toggleCellJsonEditing();
    else if (inspector.reading) setCellReading(false);
    refs.saveCell.hidden = false; syncCellReadingTools();
    if (inspector.jsonInfo && !inspector.jsonEditing) cellReader.focus(); else refs.cellValue.focus();
  });
  refs.cellNull.addEventListener("change", () => {
    refs.cellValue.disabled = refs.cellNull.checked;
    if (state.cellInspector?.capability.editable) refs.saveCell.hidden = false;
    if (!refs.cellNull.checked && !refs.cellValue.hidden) refs.cellValue.focus();
    if (state.cellInspector?.jsonInfo && !state.cellInspector.jsonEditing) renderCellJsonPreview();
    else if (state.cellInspector?.reading) setCellReading(true);
    syncCellReadingTools();
  });
  let cellMetricsTimer;
  refs.cellValue.addEventListener("input", () => { refs.cellFeedback.textContent = ""; syncCellJsonSaveState(); clearTimeout(cellMetricsTimer); cellMetricsTimer = setTimeout(syncCellReadingTools, 120); });
  refs.cellModal.addEventListener('close', () => { if (!refs.cellModal.open) { cellReader.destroy(); clearTimeout(cellMetricsTimer); } });
  refs.cellJsonRaw.addEventListener('click', () => { if (state.cellInspector?.jsonInfo && !state.cellInspector.jsonEditing) { state.cellInspector.jsonMode = 'raw'; renderCellJsonPreview(); } });
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
      const value = refs.cellNull.checked ? 'NULL' : inspector?.jsonInfo && !inspector.jsonEditing
        ? cellReader.getValue()
        : inspectorSourceValue(inspector, refs.cellValue.value);
      await copyText(value, { allowEmpty: true });
      showToast("已复制单元格");
    } catch (error) {
      refs.cellFeedback.textContent = `复制失败：${errorText(error)}`;
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
      if (!reusable && !addTab("", current?.connectionId || state.activeConnectionId, null, { newQuery: true })) return;
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
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229 || resultGrid.editorComposing || document.querySelector('dialog[open]')) return;
    const tab = activeTab();
    if (state.redisConsole || !tab || !(tab.browse || tab.redisKey) || (tab.outputTab || "result") !== "result" ||
        (tab.tableView === false && !event.target.closest?.('#resultGrid'))) return;
    event.preventDefault();
    event.stopPropagation();
    textInputIme.finish();
    void resultGrid.commitAllCellEdits();
  }, true);
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
  // Grid editors deliberately stop bubbling key events. Navigation shortcuts
  // must be consumed before that boundary, just like save-all, without ever
  // treating an IME candidate key as a workspace command.
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!['p', 'k', 'j'].includes(key) || (key === 'j' && event.shiftKey)) return;
    if (event.isComposing || event.keyCode === 229 || resultGrid.editorComposing || state.editor?.compositionStarted || document.querySelector('dialog[open]')) return;
    event.preventDefault(); event.stopPropagation(); textInputIme.finish();
    if (key === 'p') commandPalette.open();
    else if (key === 'k' && event.shiftKey) { workspaceLayout.showPane('objects'); refs.objectSearch.focus(); }
    else if (key === 'k') objectQuickOpen.open();
    else if (!refs.locateColumn.disabled) columnNavigator.open(refs.locateColumn);
    else showToast('请先打开表数据或执行查询，再定位列');
  }, true);
}

let attentionScheduled = false;
const resultGrid = new ResultGrid(refs.resultGrid, {
  onDraftChange: () => scheduleWorkspaceAttention(),
  onInspect: openCellInspector,
  shouldInspectCell: shouldInspectJsonCell,
  onCopyCell: text => copyText(text, { allowEmpty: true }),
  getRowActions: selectedRowCopyActions,
  getCellEditState,
  onCommitCell: commitInlineCell,
  onCommitCells: async drafts => {
    try { return await commitTableCellEdits(drafts); }
    catch (error) { showToast(`保存失败：${errorText(error)}`, "error"); throw error; }
  },
  editActions: { save: refs.saveTableChanges, cancel: refs.discardTableChanges },
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
function scheduleWorkspaceAttention() {
  if (attentionScheduled) return;
  attentionScheduled = true;
  queueMicrotask(() => { attentionScheduled = false; renderWorkspaceAttention(); });
}
function workspaceAttentionSummary() {
  return summarizeWorkspaceAttention({ ...state, getDrafts: rows => resultGrid.getCellEditDrafts(rows) });
}
function renderWorkspaceAttention() {
  const summary = workspaceAttentionSummary();
  for (const tab of state.tabs) {
    const element = refs.queryTabs.querySelector(`.query-tab[data-tab-id="${CSS.escape(tab.id)}"]`);
    if (!element) continue;
    const count = summary.draftEntries.find(entry => entry.tabId === tab.id)?.dirtyCount || 0;
    element.dataset.dirtyCount = String(count);
    let badge = element.querySelector('.tab-dirty');
    if (!badge) { badge = document.createElement('span'); badge.className = 'tab-dirty'; element.querySelector('.tab-select').append(badge); }
    badge.hidden = !count; badge.textContent = String(count);
    badge.title = `${count} 格修改尚未保存`;
    element.querySelector('.tab-select').setAttribute('aria-label', `${tab.title}${count ? `，${count} 格修改尚未保存` : ''}`);
  }
  const parts = [summary.dirtyCount ? `${summary.dirtyCount} 格未保存` : '', summary.transactionCount ? `${summary.transactionCount} 个事务未提交` : ''].filter(Boolean);
  refs.workspaceAttention.hidden = !parts.length;
  refs.workspaceAttention.textContent = parts.join(' · ');
  refs.workspaceAttention.title = '查看待处理事项；每张表单独保存，事务按数据库提交';
}
const columnNavigator = createColumnNavigator({ getGrid: () => refs.locateColumn.disabled ? null : resultGrid, getColumnMetadata: () => activeTab()?.browse?.columns || [], onError: error => showToast(errorText(error), 'error') });
refs.locateColumn.addEventListener('click', () => columnNavigator.toggle(refs.locateColumn));
const objectQuickOpen = createObjectQuickOpen({
  getEntries: () => collectQuickOpenEntries(state),
  onOpen: async (entry, { structure }) => {
    if (state.connectionStatuses[entry.connectionId] !== 'connected') throw new Error('原连接已断开，请先重新连接');
    if (state.activeConnectionId !== entry.connectionId && !await selectConnection(entry.connectionId)) return;
    if (state.activeConnectionId !== entry.connectionId || state.connectionStatuses[entry.connectionId] !== 'connected') return;
    if (entry.kind === 'redis-key') return openRedisValueTab(entry.key, Number(entry.database));
    const object = { ...entry.object, schema: entry.schema, database: entry.database };
    if (structure) return openObjectStructureTab(object, entry.connectionId);
    return openObjectQuery(object, { connectionId: entry.connectionId });
  },
  onError: error => showToast(errorText(error), 'error'),
});
const attentionPalette = createCommandPalette({
  title: '待处理修改', subtitle: '每张表单独保存，事务按数据库提交', placeholder: '搜索表名、连接或数据库…',
  emptyTitle: '没有待处理修改', emptyDescription: '当前没有未保存的单元格修改或未提交的事务。', actionLabel: '打开',
  getCommands: () => {
    const summary = workspaceAttentionSummary();
    return [
      ...summary.draftEntries.map(entry => ({ id: `draft-${entry.tabId}`, title: entry.title, description: `${entry.dirtyCount} 格未保存 · ${queryTargetDescription(state.tabs.find(tab => tab.id === entry.tabId))}`, group: '未保存的表', run: () => {
        const tab = state.tabs.find(tab => tab.id === entry.tabId); if (!tab) return;
        tab.outputTab = 'result'; activateTab(tab.id); renderOutput();
      } })),
      ...summary.transactionEntries.map(entry => ({ id: `tx-${entry.key}`, title: entry.database || '默认数据库', description: `${entry.connectionName} · 事务尚未提交`, group: '未提交的事务', disabled: !state.profiles.some(profile => profile.id === entry.connectionId), run: () => {
        const existing = state.tabs.find(tab => tab.id === entry.tabId && !tab.structureOnly);
        if (existing) activateTab(existing.id);
        else addTab('', entry.connectionId, null, { database: entry.database, title: `事务 · ${entry.database}` });
      } })),
    ];
  }, onError: error => showToast(errorText(error), 'error'),
});
refs.workspaceAttention.addEventListener('click', () => attentionPalette.open());
refs.openObjectQuick.addEventListener('click', () => objectQuickOpen.open());
const desktopMenu = initDesktopMenu({
  copyText: text => copyText(text, { allowEmpty: true }),
  onError: error => showToast(errorText(error), "error"),
  getItems(target) {
    if (target.closest('.value-reader .cm-editor')) {
      // Reader panels must never route copy/paste through the SQL editor.
      if (target.closest('input, textarea')) return null;
      const editor = EditorView.findFromDOM(target);
      if (!editor) return null;
      const range = editor.state.selection.main, native = window.getSelection();
      const selected = native && editor.contentDOM.contains(native.anchorNode) && editor.contentDOM.contains(native.focusNode) && !native.isCollapsed ? native.toString() : editor.state.sliceDoc(range.from, range.to);
      return [
        { label: '复制选中内容', disabled: !selected, run: () => copyText(selected) },
        { label: '复制全部内容', run: () => copyText(valueReaderSource(editor), { allowEmpty: true }) },
        { label: '全选', run: () => { editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } }); editor.contentDOM.focus(); } },
      ];
    }
    if (target.closest('.cm-editor') && state.editor) {
      const isRedis = Boolean(target.closest("#redisCommandEditor"));
      const editor = isRedis ? redisEditor?.view : state.editor;
      if (!editor) return [];
      const tab = isRedis ? activeExecutionTab() : activeTab();
      const original = editor.state;
      const selection = original.selection.main;
      const selected = original.sliceDoc(selection.from, selection.to);
      const current = ({ documentOnly = false } = {}) => {
        const sameEditor = isRedis ? redisEditor?.view === editor && activeExecutionTab() === tab : state.editor === editor && activeTab() === tab;
        const unchanged = documentOnly ? editor.state.doc === original.doc : editor.state === original;
        if (!sameEditor || !unchanged) throw new Error("查询内容已改变，请重新打开菜单");
      };
      return [
        { label: "剪切", disabled: !selected, run: async () => { await copyText(selected); current(); editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } }); editor.focus(); } },
        { label: "复制", disabled: !selected, run: () => copyText(selected) },
        { label: "粘贴", run: async () => { const text = await navigator.clipboard.readText(); current(); editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length } }); editor.focus(); } },
        { label: "全选", run: () => { editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } }); editor.focus(); } },
        ...(isRedis ? [{ label: "执行命令", run: () => { current(); void runQuery(); } }] : [
          { label: "查看引用表的结构", disabled: !tab?.connectionId || Boolean(tab?.console), run: () => { current({ documentOnly: true }); void showReferencedStructure(); } },
          { label: "格式化 SQL", disabled: refs.formatQuery.disabled, run: () => { current(); refs.formatQuery.click(); } },
        ]),
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
        { label: "移动到分组…", run: () => connectionGroups.open(id) },
        { label: "新建查询", run: () => addTab("", id, null, { newQuery: true }) },
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
    { id: "search-objects", title: "快速打开对象", description: "搜索已加载的表、字段和 Redis key；Shift+Enter 看结构", shortcut: shortcut('⌘ K'), group: "常用操作", run: () => objectQuickOpen.open() },
    { id: 'locate-column', title: '定位结果列', description: '按列名、类型或序号定位宽表中的字段', shortcut: shortcut('⌘ J'), group: '当前查询', disabled: refs.locateColumn.disabled, run: () => columnNavigator.open(refs.locateColumn) },
    { id: 'pending-work', title: '查看待处理修改', description: '查找未保存的表和未提交的事务', group: '常用操作', run: () => attentionPalette.open() },
    { id: "query-structure", title: "查看 SQL 引用的表结构", description: "只引用一张表时直接打开；引用多张表时用快速打开选择", group: "当前查询",
      disabled: !activeTab()?.connectionId || driverForTab(activeTab()) === "redis" || Boolean(activeTab()?.console), run: () => void showReferencedStructure() },
    { id: "format-sql", title: "格式化 SQL", disabled: refs.formatQuery.disabled || refs.formatQuery.hidden || !activeTab(), group: "当前查询", run: () => refs.formatQuery.click() },
    { id: "open-sql", title: "打开 SQL 文件", disabled: Boolean(activeExecutionTab()?.console || driverForTab(activeExecutionTab()) === "redis"), group: "常用操作", run: () => refs.importSql.click() },
    { id: "save-sql", title: "保存 SQL 文件", shortcut: "⌘ S", disabled: !activeTab() || refs.saveSql.hidden, group: "当前查询", run: () => refs.saveSql.click() },
    ...state.tabs.map(tab => ({ id: `tab-${tab.id}`, title: tab.title, description: queryTargetDescription(tab), keywords: "标签 query tab", group: "切换标签", run: () => activateTab(tab.id) })),
    ...state.profiles.map(profile => ({ id: `connection-${profile.id}`, title: profile.name, description: `${profile.driver || "postgres"} · ${profile.host}:${profile.port}`, keywords: "连接 connection", group: "数据库连接", run: async () => {
      const tab = activeTab();
      if (tab && !tab.connectionId && !tab.browse && !tab.redisKey && !tab.running) tab.connectionId = profile.id;
      await selectConnection(profile.id);
      updateEditorSchema(); renderTabs(); renderOutput(); persistTabs();
    } })),
    ...Object.entries(themeLabels).map(([theme, name]) => ({ id: `theme-${theme}`, title: theme === "system" ? "跟随系统外观" : `切换到${name}主题`, keywords: "theme appearance 外观", group: "外观与布局", run: () => applyTheme(theme) })),
    { id: "reset-layout", title: "重置工作区布局", group: "外观与布局", run: () => refs.resetLayout.click() },
    { id: "shortcuts", title: "键盘快捷键", group: "帮助", run: () => refs.shortcutsModal.showModal() },
  ].map(command => command.shortcut ? { ...command, shortcut: shortcut(command.shortcut) } : command),
  onError: error => showToast(errorText(error), "error"),
});
for (const node of document.querySelectorAll('kbd')) if (node.textContent.includes('⌘')) node.textContent = shortcut(node.textContent);
for (const node of document.querySelectorAll('[title]')) if (node.title.includes('⌘')) node.title = shortcut(node.title);
applyTheme(readTheme());
systemDarkMode.addEventListener("change", () => {
  if (themePreference === "system") renderTheme();
});
const workspaceLayout = initWorkspaceLayout();
createEditor();
renderTabs();
renderOutput();
renderHistory();
renderTree();
bindEvents();
initAppSelects();
window.addEventListener("pagehide", persistTabs);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistTabs();
});
loadConnections();
updateCursor();
