// Small, shared presentation helpers. All external names enter via textContent.
export function redisLocation(entry) {
  return `${entry.connectionName || 'Redis'} · DB ${entry.database}`;
}
export function initRedisDialog(dialog, { canClose = () => true, onClose = () => {} } = {}) {
  let previousFocus, backdrop = false;
  const close = () => { if (canClose()) { dialog.close(); onClose(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); } };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const outside = event => { const r = dialog.getBoundingClientRect(); return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom); };
  dialog.addEventListener('pointerdown', event => { backdrop = event.button === 0 && outside(event); });
  dialog.addEventListener('pointercancel', () => { backdrop = false; });
  dialog.addEventListener('click', event => { const dismiss = backdrop && outside(event); backdrop = false; if (dismiss) close(); });
  return { close, open() { previousFocus = document.activeElement; backdrop = false; dialog.showModal(); } };
}

export function redisValueForCopy(payload) {
  if (payload?.keyType === 'none') throw new Error('Key 已过期或被删除，请刷新');
  // Never label a bounded preview as the entire value.
  if (payload?.partial || payload?.truncated) throw new Error('当前 Key 仅加载了部分内容，请在数据页导出预览或分段读取完整值');
  return typeof payload.raw === 'string' ? payload.raw : JSON.stringify(payload.raw, null, 2);
}

export const redisTtlSummary = ttl => ttl === -1 ? '永久保留' : ttl === -2 ? 'Key 已不存在' : Number.isFinite(ttl) ? `剩余 ${ttl.toLocaleString()} 秒（读取时）` : '尚未读取有效期';
