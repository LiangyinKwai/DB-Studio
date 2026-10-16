export function matchesWorkspaceSearch(query, ...values) {
  const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const content = values.filter(value => value != null).join(' ').toLocaleLowerCase();
  return terms.every(term => content.includes(term));
}

export function historyTimeLabel(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const age = Math.max(0, now - value);
  if (age < 60_000) return '刚刚';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前`;
  if (age < 604_800_000) return `${Math.floor(age / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(value);
}

/** Keep an empty-state button's label and destination tied to the visible view. */
export function emptyResultAction(tab) {
  if (tab?.running) return { action: 'stop', label: '停止查询' };
  if (tab?.refreshing || tab?.resolvingTarget || tab?.confirming || tab?.opening) {
    return { action: null, label: '正在加载…', disabled: true };
  }
  if (tab?.error) return { action: 'message', label: '查看错误详情' };
  if (!tab?.connectionId) return { action: 'connect', label: '选择数据库连接' };
  if (tab.tableView !== false) {
    if (tab.redisKey) return { action: 'refresh', label: '加载 Key 数据' };
    if (tab.browse) return { action: 'tableSql', label: '打开 SQL 编辑器' };
  }
  return { action: 'editor', label: '开始编写 SQL' };
}

export function runEmptyResultAction(tab, actions) {
  const next = emptyResultAction(tab);
  if (!next.disabled) actions[next.action]?.();
}
