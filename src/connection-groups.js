export const CONNECTION_GROUPS_KEY = 'db-studio.connection-groups.v1';

export function normalizeConnectionGroups(value) {
  const groups = [], ids = new Set(), names = new Set();
  for (const group of Array.isArray(value?.groups) ? value.groups : []) {
    const name = typeof group?.name === 'string' ? group.name.trim().slice(0, 60) : '';
    if (!name || typeof group.id !== 'string' || !group.id || ids.has(group.id) || names.has(name.toLowerCase())) continue;
    ids.add(group.id); names.add(name.toLowerCase()); groups.push({ id: group.id, name });
  }
  return {
    groups,
    assignments: Object.fromEntries(Object.entries(value?.assignments || {}).filter(([, id]) => ids.has(id))),
    collapsed: (Array.isArray(value?.collapsed) ? value.collapsed : []).filter(id => id === '' || ids.has(id)),
  };
}

export function createConnectionGroupStore(storage) {
  let value;
  try { storage ||= globalThis.localStorage; value = normalizeConnectionGroups(JSON.parse(storage.getItem(CONNECTION_GROUPS_KEY) || 'null')); }
  catch { value = normalizeConnectionGroups(null); }
  const commit = update => {
    const next = structuredClone(value);
    update(next);
    const normalized = normalizeConnectionGroups(next);
    storage.setItem(CONNECTION_GROUPS_KEY, JSON.stringify(normalized));
    value = normalized;
  };
  const validateName = (name, excluding) => {
    name = name.trim();
    if (!name || name.length > 60) throw new Error('分组名称需要 1–60 个字符');
    if (value.groups.some(g => g.id !== excluding && g.name.toLowerCase() === name.toLowerCase())) throw new Error('已有同名分组');
    return name;
  };
  return {
    snapshot: () => structuredClone(value),
    groupFor: id => Object.hasOwn(value.assignments, id) ? value.assignments[id] : '',
    add(name) {
      name = validateName(name);
      const id = globalThis.crypto.randomUUID();
      commit(next => next.groups.push({ id, name }));
      return id;
    },
    rename(id, name) {
      name = validateName(name, id);
      if (!value.groups.some(g => g.id === id)) throw new Error('分组已不存在');
      commit(next => { next.groups.find(g => g.id === id).name = name; });
    },
    remove(id) {
      commit(next => { next.groups = next.groups.filter(g => g.id !== id); next.assignments = Object.fromEntries(Object.entries(next.assignments).filter(([, group]) => group !== id)); });
    },
    move(connectionId, groupId) {
      if (groupId && !value.groups.some(g => g.id === groupId)) throw new Error('分组已不存在');
      commit(next => { if (groupId) next.assignments[connectionId] = groupId; else delete next.assignments[connectionId]; });
    },
    collapse(id, collapsed) { commit(next => { next.collapsed = next.collapsed.filter(item => item !== id); if (collapsed) next.collapsed.push(id); }); },
  };
}
