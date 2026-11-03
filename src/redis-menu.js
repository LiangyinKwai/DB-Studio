import { redisKeyTypePresentation } from './redis-key-icons.js';
const paths = {
  open: '<path d="M3 5h7l2 3h9v12H3z"/>', details: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.1 7a8 8 0 0 1 13.2-2L20 7M4 17l1.7 2A8 8 0 0 0 18.9 17"/>',
  create: '<path d="M4 5h7l2 3h7v5M4 5v15h9m5-5v7m-4-3.5h8"/>',
  duplicate: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  'copy-value': '<path d="M8 3h10v14H8zM5 7H3v14h12v-2M11 7h4m-4 4h4"/>',
  rename: '<path d="m4 16 12-12 4 4-12 12H4zm10-10 4 4"/>',
  ttl: '<circle cx="12" cy="13" r="8"/><path d="M12 9v5l3 2M9 2h6"/>',
  member: '<path d="M4 5h16M4 12h9M4 19h9m5-7v8m-4-4h8"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  console: '<path d="m5 7 5 5-5 5m8 0h6"/>',
};
const writeActions = new Set(['create', 'duplicate', 'rename', 'ttl', 'member', 'delete']);
export function initRedisMenus(keyMenu, databaseMenu, { shortcut }) {
  const render = (menu, attribute, groups) => {
    menu.classList.add('redis-context-menu');
    menu.innerHTML = '<div class="redis-menu-caption"></div>' + groups.map(group => group.map(([action, label, keys]) => `<button type="button" role="menuitem" ${attribute}="${action}"${action === 'delete' ? ' class="redis-menu-danger"' : ''}><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[action] || paths.member}</svg><span data-menu-label>${label}</span>${keys ? `<kbd>${shortcut(keys)}</kbd>` : ''}</button>`).join('')).join('<div class="context-menu-divider" role="separator"></div>');
    menu.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const buttons = [...menu.querySelectorAll('button:not(:disabled):not([hidden])')];
      const index = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.hidden = true; menu.returnFocus?.isConnected && menu.returnFocus.focus({ preventScroll: true }); }
    });
  };
  render(keyMenu, 'data-redis-context-action', [
    [['open', '打开值'], ['details', '查看完整 Key'], ['refresh', '刷新', '⌘ R']],
    [['create', '新建 Key…'], ['duplicate', '复制为新 Key…']],
    [['member', '成员操作…'], ['ttl', '设置过期时间…'], ['rename', '重命名…', 'F2']],
    [['copy', '复制 Key', '⌘ C'], ['copy-value', '复制值']],
    [['delete', '删除 Key…', 'Backspace']],
  ]);
  render(databaseMenu, 'data-redis-database-context-action', [[['create', '新建 Key…']], [['refresh', '刷新当前 DB'], ['console', '打开控制台']]]);
  return { prepare(menu, { key, database, type, readOnly, busy, returnFocus }) {
    const caption = menu.querySelector('.redis-menu-caption');
    caption.textContent = key == null ? `Redis · DB ${database}` : `DB ${database} · ${key}`;
    caption.title = caption.textContent; menu.returnFocus = returnFocus;
    for (const button of menu.querySelectorAll('button')) {
      const action = button.dataset.redisContextAction || button.dataset.redisDatabaseContextAction;
      button.disabled = writeActions.has(action) && (readOnly || busy);
      button.title = button.disabled ? readOnly ? '当前标签为只读，请先解锁' : '请等待当前写入完成' : '';
      if (action === 'member') {
        button.hidden = !['hash', 'list', 'set', 'zset', 'stream'].includes(type);
        button.querySelector('[data-menu-label]').textContent = ({ hash: '添加字段…', list: '添加元素…', set: '添加成员…', zset: '添加成员…', stream: '追加消息…' })[type] || '成员操作…';
      }
    }
  } };
}
