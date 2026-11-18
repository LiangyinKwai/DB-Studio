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
  let drag = null;
  let guide = null;
  let scrollFrame = 0;
  let suppressClick = false;
  const cardSelector = '[data-connection-card]';
  const groupSelector = '[data-connection-group]';
  const cardFor = target => target?.closest?.(cardSelector);
  const visibleCards = (container = root) => [...container.querySelectorAll(cardSelector)].filter(card => card.getClientRects().length);
  const view = root.ownerDocument.defaultView;
  const inList = (x, y, bounds) => x >= bounds.left && x < bounds.left + root.clientWidth &&
    y >= bounds.top && y < bounds.top + root.clientHeight;

  function dropAt(x, y, bounds = root.getBoundingClientRect()) {
    if (!inList(x, y, bounds)) return null;
    const hit = root.ownerDocument.elementFromPoint(x, y);
    if (!root.contains(hit)) return null;
    const group = hit.closest(groupSelector);
    const groupTarget = group && group.dataset.connectionGroup !== drag.sourceGroup
      ? { element: group.firstElementChild, groupId: group.dataset.connectionGroup, placement: 'into' } : null;
    if (hit.closest('.connection-group > summary, .connection-group-empty')) return groupTarget;
    let card = cardFor(hit);
    let rect = card?.getBoundingClientRect();
    // Gaps between cards belong to the next card, or to the end of the list.
    if (!card) {
      for (const item of visibleCards(group || root)) {
        const candidate = item.getBoundingClientRect();
        if (candidate.bottom <= bounds.top || candidate.top >= bounds.top + root.clientHeight) continue;
        card = item;
        rect = candidate;
        if (y <= rect.bottom) break;
      }
    }
    if (!card) return groupTarget;
    if (card.dataset.connectionCard === drag.source) return null;
    return { element: card, connectionId: card.dataset.connectionCard, placement: y < rect.top + rect.height / 2 ? 'before' : 'after' };
  }

  function paintGuide(drop) {
    if (guide && (guide !== drop?.element || guide.dataset.dropPosition !== drop.placement)) {
      guide.removeAttribute('data-drop-position');
      guide = null;
    }
    if (drop && !guide) {
      guide = drop.element;
      guide.dataset.dropPosition = drop.placement;
    }
  }

  function updateDrag() {
    const bounds = root.getBoundingClientRect();
    const { x, y } = drag;
    paintGuide(dropAt(x, y, bounds));
    const edge = 24;
    if (!inList(x, y, bounds)) return;
    const delta = y < bounds.top + edge ? -9 : y > bounds.top + root.clientHeight - edge ? 9 : 0;
    if (!delta) return;
    const before = root.scrollTop;
    root.scrollTop += delta;
    if (root.scrollTop !== before) scrollFrame = view.requestAnimationFrame(updateDrag);
  }

  function finish(drop = null) {
    if (!drag) return;
    const { active, pointerId, source, card } = drag;
    drag = null;
    if (!active) return;
    view.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    paintGuide(null);
    root.classList.remove('reordering-connections');
    card.classList.remove('connection-dragging');
    if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
    suppressClick = true;
    if (drop) onMove(source, drop);
  }

  view.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    suppressClick = false;
    const card = cardFor(event.target);
    if (!card || !root.contains(card) || event.target.closest('[data-connection-toggle], [data-edit-id]')) return;
    drag = { card, source: card.dataset.connectionCard, sourceGroup: card.closest(groupSelector)?.dataset.connectionGroup, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, active: false };
  });
  view.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const { clientX: x, clientY: y } = event;
    if (!drag.active) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < 5) return;
      drag.active = true;
      drag.card.classList.add('connection-dragging');
      root.classList.add('reordering-connections');
      root.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    drag.x = x;
    drag.y = y;
    view.cancelAnimationFrame(scrollFrame);
    updateDrag();
  });
  view.addEventListener('pointerup', event => {
    if (drag?.pointerId === event.pointerId) finish(drag.active ? dropAt(event.clientX, event.clientY) : null);
  });
  const cancelDrag = event => { if (drag?.pointerId === event.pointerId) finish(); };
  view.addEventListener('pointercancel', cancelDrag);
  root.addEventListener('lostpointercapture', cancelDrag);
  view.addEventListener('blur', () => finish());
  view.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag?.active) {
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  }, true);
  root.addEventListener('click', event => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  root.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const button = event.target.closest?.('[data-connection-id]');
    if (!button) return;
    const cards = visibleCards();
    const index = cards.findIndex(card => card.dataset.connectionCard === button.dataset.connectionId);
    const target = cards[index + (event.key === 'ArrowUp' ? -1 : 1)];
    event.preventDefault(); event.stopPropagation();
    if (!target) return;
    const id = button.dataset.connectionId;
    onMove(id, { connectionId: target.dataset.connectionCard, placement: event.key === 'ArrowUp' ? 'before' : 'after' });
    [...root.querySelectorAll('[data-connection-id]')].find(button => button.dataset.connectionId === id)?.focus({ preventScroll: true });
  });
}
