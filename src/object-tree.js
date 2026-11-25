const kindOrder = new Map(['table', 'partitioned_table', 'foreign_table', 'view', 'materialized_view', 'routine', 'event', 'sequence'].map((kind, index) => [kind, index]));
const emptyKinds = {
  postgres: ['table', 'view', 'materialized_view', 'routine'],
  mysql: ['table', 'view', 'routine', 'event'],
};

const mysqlSystemDatabases = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const postgresSystemDatabases = new Set(['postgres', 'template0', 'template1']);

export function isSystemDatabase(name, driver) {
  return (driver === 'mysql' ? mysqlSystemDatabases : postgresSystemDatabases).has(name);
}

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

/** Move focus through displayed rows without opening a key or selecting a query target. */
export function navigateTreeRows(tree, event) {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const selector = '.tree-root, summary, .category-summary, .object-main';
  const current = event.target;
  if (!current.matches(selector)) return;
  const walker = document.createTreeWalker(tree, NodeFilter.SHOW_ELEMENT, node => {
    if (node.hidden || node.matches('.collapsed > .category-items, details:not([open]) > :not(summary)')) return NodeFilter.FILTER_REJECT;
    return node.matches(selector) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
  });
  walker.currentNode = current;
  let next;
  if (event.key === 'Home' || event.key === 'End') {
    walker.currentNode = tree;
    next = event.key === 'Home' ? walker.firstChild() : walker.lastChild();
    if (event.key === 'End' && next) while (walker.lastChild()) next = walker.currentNode;
  } else {
    next = event.key === 'ArrowDown' ? walker.nextNode() : walker.previousNode();
  }
  event.preventDefault();
  next?.focus();
}
