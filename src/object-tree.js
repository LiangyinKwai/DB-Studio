const kindOrder = new Map(['table', 'partitioned_table', 'foreign_table', 'view', 'materialized_view', 'routine', 'event', 'sequence'].map((kind, index) => [kind, index]));
const emptyKinds = {
  postgres: ['table', 'view', 'materialized_view', 'routine'],
  mysql: ['table', 'view', 'routine', 'event'],
};

export function isRoutine(kind) {
  return kind === 'function' || kind === 'procedure';
}

// Catalog rows are ordered by object name. Group order must not depend on
// which kind happens to own the alphabetically first object in a schema.
export function orderedObjectGroups(objects, { driver, searching = false } = {}) {
  const groups = new Map((searching ? [] : emptyKinds[driver] || []).map(kind => [kind, []]));
  for (const object of objects) {
    const group = isRoutine(object.kind) ? 'routine' : object.kind;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(object);
  }
  groups.get('routine')?.sort((left, right) => Number(left.kind === 'procedure') - Number(right.kind === 'procedure'));
  return [...groups].sort(([left], [right]) => (kindOrder.get(left) ?? 99) - (kindOrder.get(right) ?? 99) || String(left).localeCompare(String(right)));
}

export function syncTreeToggle(row, expanded) {
  const button = row.querySelector('[data-tree-toggle]');
  if (!button) return;
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${button.dataset.treeLabel}`);
}

export function setTreeRowExpanded(row, expanded) {
  if (row.matches('summary')) row.parentElement.open = expanded;
  else if (row.matches('.category-summary')) {
    row.parentElement.classList.toggle('collapsed', !expanded);
    row.setAttribute('aria-expanded', String(expanded));
  } else return false;
  syncTreeToggle(row, expanded);
  return true;
}

export function treeBranchForDoubleClick(target) {
  if (target.closest('button, input, a')) return null;
  return target.closest('summary, .category-summary');
}
