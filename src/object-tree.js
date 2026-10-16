const kindOrder = new Map(['table', 'partitioned_table', 'foreign_table', 'view', 'materialized_view', 'sequence', 'function', 'procedure'].map((kind, index) => [kind, index]));

// Catalog rows are ordered by object name. Group order must not depend on
// which kind happens to own the alphabetically first object in a schema.
export function orderedObjectGroups(objects) {
  const groups = new Map();
  for (const object of objects) {
    if (!groups.has(object.kind)) groups.set(object.kind, []);
    groups.get(object.kind).push(object);
  }
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
