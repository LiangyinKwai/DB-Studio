export const MAX_QUERY_TABS = 100;

const legacyStructureHint = /^-- (?:"[^\r\n]*"\."[^\r\n]*"|`[^\r\n]*`\.`[^\r\n]*`)\r?\n-- 在此编写索引、约束或其他结构变更 SQL。\r?\n?$/;

/** Structure inspectors are temporary; SQL drafts and data browsers can resume. */
export function restorableWorkspaceTabs(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tab) => {
    if (!tab || typeof tab.sql !== "string" || tab.console === true) return [];
    const sql = legacyStructureHint.test(tab.sql) ? "" : tab.sql;
    const structure = tab.openedObjectView === "structure" || tab.structureOnly === true ||
      (!tab.browse && !tab.redisKey && /^结构 · /u.test(tab.title || ""));
    if (!structure) return [{ ...tab, sql }];
    if (!sql.trim()) return [];
    // Earlier versions exposed an editor inside restored structure tabs.
    // Keep any SQL the user wrote there as an ordinary query draft.
    return [{ ...tab, sql, title: null, browse: null, openedObject: null,
      openedObjectView: null, structureOnly: false, tableView: false }];
  }).slice(0, MAX_QUERY_TABS);
}
