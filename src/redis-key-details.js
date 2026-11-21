import { createValueReader } from './value-reader.js';
import { redisKeyTypePresentation } from './redis-key-icons.js';

/** Inspect the full name and refresh TTL without fetching the key's value. */
export function createRedisKeyDetails({ copyText, readTtl, onError = console.error }) {
  const dialog = document.createElement('dialog'); dialog.className = 'redis-key-details';
  dialog.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', 'redis-key-detail-title');
  dialog.innerHTML = '<div class="dialog-header"><h2 id="redis-key-detail-title">Key 详情</h2><button class="icon-btn" type="button" aria-label="关闭 Key 详情">×</button></div><div class="key-context"></div><div class="value-reader"></div><div class="dialog-actions"><span class="toolbar-spacer"></span><button class="secondary-btn" type="button" data-key-copy>复制完整 Key</button></div>';
  document.body.append(dialog);
  const reader = createValueReader(dialog.querySelector('.value-reader'), { label: '完整 Redis Key', showLineNumbers: false });
  let current = null, previousFocus = null;
  let ttlRequest = 0;
  const ttlLabel = ttl => ttl === -1 ? '无过期时间' : ttl === -2 ? 'Key 已不存在' : Number.isFinite(ttl) ? `TTL ${ttl} 秒（读取时）` : 'TTL 未读取';
  async function refreshTtl(entry, status, retry) {
    if (!readTtl) return;
    const request = ++ttlRequest;
    retry.hidden = true; status.textContent = 'TTL 读取中…'; status.title = '';
    try {
      const ttl = await readTtl(entry);
      if (current !== entry || !dialog.open || request !== ttlRequest) return;
      if (!Number.isInteger(ttl) || ttl < -2) throw new Error('返回的 TTL 无效');
      entry.ttl = ttl; status.textContent = ttlLabel(ttl);
    } catch (error) {
      if (current !== entry || !dialog.open || request !== ttlRequest) return;
      status.textContent = 'TTL 读取失败'; status.title = error?.message || String(error); retry.hidden = false;
    }
  }
  const close = () => { current = null; dialog.close(); previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }); reader.destroy(); };
  dialog.querySelector('[aria-label="关闭 Key 详情"]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); reader.find();
    }
  }, true);
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
      for (const value of [entry.connectionName, `DB ${entry.database}`]) { const span = document.createElement('span'); span.textContent = value; context.append(span); }
      const status = document.createElement('span'); status.dataset.keyTtl = ''; status.setAttribute('role', 'status'); status.textContent = ttlLabel(entry.ttl); context.append(status);
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'quiet-btn'; retry.dataset.keyTtlRetry = ''; retry.textContent = '重试 TTL'; retry.hidden = true; context.append(retry);
      const target = current;
      retry.addEventListener('click', () => void refreshTtl(target, status, retry));
      dialog.querySelector('[data-key-copy]').textContent = '复制完整 Key';
      dialog.querySelector('[data-key-copy]').title = '';
      reader.setWrap(true); reader.show(entry.key); dialog.showModal(); dialog.focus({ preventScroll: true }); reader.measure();
      void refreshTtl(target, status, retry);
    }, close,
  };
}
