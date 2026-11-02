import { createValueReader } from './value-reader.js';
import { redisKeyTypePresentation } from './redis-key-icons.js';

/** A cache-only name inspector. Opening it never fetches the key's value. */
export function createRedisKeyDetails({ copyText, onError = console.error }) {
  const dialog = document.createElement('dialog'); dialog.className = 'redis-key-details';
  dialog.setAttribute('aria-labelledby', 'redis-key-detail-title');
  dialog.innerHTML = '<div class="dialog-header"><h2 id="redis-key-detail-title">Key 详情</h2><button class="icon-btn" type="button" aria-label="关闭 Key 详情">×</button></div><div class="key-context"></div><div class="value-reader"></div><div class="dialog-actions"><span class="toolbar-spacer"></span><button class="secondary-btn" type="button" data-key-copy>复制完整 Key</button></div>';
  document.body.append(dialog);
  const reader = createValueReader(dialog.querySelector('.value-reader'), { label: '完整 Redis Key', showLineNumbers: false });
  let current = null, previousFocus = null, backdropPointerDown = false;
  const close = () => { current = null; backdropPointerDown = false; dialog.close(); previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }); reader.destroy(); };
  dialog.querySelector('[aria-label="关闭 Key 详情"]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); reader.find();
    }
  }, true);
  const isBackdrop = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { backdropPointerDown = event.button === 0 && isBackdrop(event); });
  dialog.addEventListener('pointercancel', () => { backdropPointerDown = false; });
  dialog.addEventListener('click', event => {
    const dismiss = backdropPointerDown && isBackdrop(event);
    backdropPointerDown = false;
    if (dismiss) close();
  });
  dialog.querySelector('[data-key-copy]').addEventListener('click', async () => {
    const entry = current; if (!entry) return;
    try { await copyText(entry.key); if (current === entry && dialog.open) dialog.querySelector('[data-key-copy]').textContent = '已复制完整 Key'; }
    catch (error) {
      if (current === entry && dialog.open) { const button = dialog.querySelector('[data-key-copy]'); button.textContent = '复制失败，请重试'; button.title = error?.message || String(error); }
      onError(error);
    }
  });
  return {
    open(entry) {
      if (typeof entry?.key !== 'string') return;
      current = { ...entry }; previousFocus = document.activeElement;
      const type = redisKeyTypePresentation(entry.type);
      const context = dialog.querySelector('.key-context'); context.replaceChildren();
      const icon = document.createElement('span'); icon.innerHTML = type.icon; context.append(icon);
      const ttl = entry.ttl === -1 ? '无过期时间' : entry.ttl === -2 ? 'Key 已不存在' : Number.isFinite(entry.ttl) ? `TTL ${entry.ttl} 秒（读取时）` : 'TTL 未读取';
      for (const value of [entry.connectionName, `DB ${entry.database}`, ttl]) { const span = document.createElement('span'); span.textContent = value; context.append(span); }
      dialog.querySelector('[data-key-copy]').textContent = '复制完整 Key';
      dialog.querySelector('[data-key-copy]').title = '';
      reader.setWrap(true); reader.show(entry.key); dialog.showModal(); reader.measure(); reader.focus();
    }, close,
  };
}
