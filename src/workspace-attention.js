/**
 * Summarize two separate kinds of work that need attention: local cell drafts
 * and open database transactions. This never saves, discards or commits work.
 * Shared row arrays represent the same drafts and are counted only once.
 */
export function summarizeWorkspaceAttention({ tabs = [], profiles = [], transactionKeys = [], getDrafts = () => [] } = {}) {
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const databaseFor = tab => tab.browse?.database || tab.database || profileById.get(tab.connectionId)?.database || '';
  const seenRows = new Set();
  const draftEntries = [];

  for (const tab of tabs) {
    const rows = tab.result?.rows;
    if (!rows || typeof rows !== 'object' || seenRows.has(rows)) continue;
    seenRows.add(rows);
    const dirtyCount = [...(getDrafts(rows) || [])].filter(draft => draft.dirty || draft.pending).length;
    if (dirtyCount) draftEntries.push({
      tabId: tab.id, title: tab.title || '', connectionId: tab.connectionId || null,
      database: databaseFor(tab), dirtyCount,
    });
  }

  const transactionEntries = [...new Set(transactionKeys)].filter(key => typeof key === 'string').map(key => {
    const separator = key.indexOf('\u0000');
    const connectionId = separator < 0 ? key : key.slice(0, separator);
    const database = separator < 0 ? '' : key.slice(separator + 1);
    const matches = tabs.filter(tab => tab.connectionId === connectionId && databaseFor(tab) === database);
    const tab = matches.find(item => !item.structureOnly) || matches[0];
    return {
      key, connectionId, database,
      connectionName: profileById.get(connectionId)?.name || connectionId,
      tabId: tab?.id ?? null,
    };
  });

  return {
    dirtyCount: draftEntries.reduce((count, entry) => count + entry.dirtyCount, 0),
    transactionCount: transactionEntries.length,
    draftEntries, transactionEntries,
  };
}
