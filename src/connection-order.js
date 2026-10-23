export const CONNECTION_ORDER_KEY = 'db-studio.connection-order.v1';

export function orderConnections(profiles, order) {
  if (!Array.isArray(order)) return [...profiles];
  const positions = new Map();
  order.forEach(id => { if (typeof id === 'string' && !positions.has(id)) positions.set(id, positions.size); });
  return profiles.map((profile, index) => ({ profile, index })).sort((a, b) =>
    (positions.get(a.profile.id) ?? Infinity) - (positions.get(b.profile.id) ?? Infinity) || a.index - b.index,
  ).map(item => item.profile);
}

export function moveConnection(profiles, source, target, placement = 'before') {
  if (source === target || !profiles.some(profile => profile.id === source) || !profiles.some(profile => profile.id === target)) return [...profiles];
  const moving = profiles.find(profile => profile.id === source);
  const result = profiles.filter(profile => profile.id !== source);
  const index = result.findIndex(profile => profile.id === target) + (placement === 'after' ? 1 : 0);
  result.splice(index, 0, moving);
  return result;
}

export function readConnectionOrder(storage) {
  try { const value = JSON.parse((storage || globalThis.localStorage).getItem(CONNECTION_ORDER_KEY) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

export function saveConnectionOrder(profiles, storage) {
  try { (storage || globalThis.localStorage).setItem(CONNECTION_ORDER_KEY, JSON.stringify(profiles.map(profile => profile.id))); return true; }
  catch { return false; }
}

export function initConnectionReorder(root, onMove) {
  let source = null, suppressClickUntil = 0;
  const cardFor = target => target.closest?.('[data-connection-card]');
  function clearGuide() {
    root.querySelectorAll('[data-drop-position]').forEach(card => card.removeAttribute('data-drop-position'));
  }
  function finish() {
    clearGuide(); root.querySelectorAll('.connection-dragging').forEach(card => card.classList.remove('connection-dragging')); source = null;
  }
  root.addEventListener('dragstart', event => {
    const card = cardFor(event.target);
    if (!card || !root.contains(card)) return;
    source = card.dataset.connectionCard;
    card.classList.add('connection-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-db-studio-connection', source);
    event.dataTransfer.setData('text/plain', source);
  });
  root.addEventListener('dragover', event => {
    const card = cardFor(event.target);
    if (!source || !card || !root.contains(card)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; clearGuide();
    if (card.dataset.connectionCard === source) return;
    const rect = card.getBoundingClientRect();
    card.dataset.dropPosition = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    // Keep long lists usable while dragging near their viewport edges.
    const bounds = root.getBoundingClientRect();
    if (event.clientY < bounds.top + 24) root.scrollTop -= 12;
    else if (event.clientY > bounds.bottom - 24) root.scrollTop += 12;
  });
  root.addEventListener('drop', event => {
    const card = cardFor(event.target);
    if (!source || !card || !root.contains(card)) return;
    event.preventDefault(); event.stopPropagation();
    const id = source, target = card.dataset.connectionCard;
    const rect = card.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    suppressClickUntil = Date.now() + 250;
    finish(); onMove(id, target, placement);
  });
  root.addEventListener('dragend', finish);
  root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) clearGuide(); });
  root.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const button = event.target.closest?.('[data-connection-id]');
    if (!button) return;
    const cards = [...root.querySelectorAll('[data-connection-card]')];
    const index = cards.findIndex(card => card.dataset.connectionCard === button.dataset.connectionId);
    const target = cards[index + (event.key === 'ArrowUp' ? -1 : 1)];
    event.preventDefault(); event.stopPropagation();
    if (!target) return;
    const id = button.dataset.connectionId;
    onMove(id, target.dataset.connectionCard, event.key === 'ArrowUp' ? 'before' : 'after');
    [...root.querySelectorAll('[data-connection-id]')].find(button => button.dataset.connectionId === id)?.focus({ preventScroll: true });
  });
}
