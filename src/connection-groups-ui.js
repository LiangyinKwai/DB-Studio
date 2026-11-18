import { createConnectionGroupStore } from './connection-groups.js';

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export function createConnectionGroups({ list, button, getProfiles, onChange, onError }) {
  const store = createConnectionGroupStore();
  const dialog = document.createElement('dialog');
  dialog.className = 'connection-groups-dialog';
  dialog.setAttribute('aria-labelledby', 'connectionGroupsTitle');
  dialog.innerHTML = `<div class="dialog-header"><div><h2 id="connectionGroupsTitle">管理连接分组</h2><p>按环境或项目整理连接，分组可在侧栏折叠。</p></div><button class="icon-btn" type="button" data-close-groups aria-label="关闭分组管理">×</button></div><form class="connection-group-create"><input name="name" maxlength="60" required aria-label="新分组名称" placeholder="例如：生产环境" autocomplete="off"><button class="secondary-btn" type="submit">新建分组</button></form><div class="connection-group-settings"></div><div class="connection-group-members-heading"><strong>连接归属</strong><input type="search" aria-label="搜索要分组的连接" placeholder="搜索连接名称或地址…"></div><div class="connection-group-members"></div><p class="connection-group-feedback" role="status" aria-live="polite"></p><div class="dialog-actions"><span>删除分组后，连接会移至「未分组」。</span><button class="secondary-btn" type="button" data-close-groups>完成</button></div>`;
  document.body.append(dialog);
  const settings = dialog.querySelector('.connection-group-settings'), members = dialog.querySelector('.connection-group-members');
  const search = dialog.querySelector('input[type="search"]'), feedback = dialog.querySelector('[role="status"]');
  function options(selected) {
    return `<option value="">未分组</option>${store.snapshot().groups.map(g => `<option value="${escape(g.id)}"${g.id === selected ? ' selected' : ''}>${escape(g.name)}</option>`).join('')}`;
  }
  function renderMembers(focusId) {
    const query = search.value.trim().toLowerCase();
    const profiles = getProfiles().filter(p => `${p.name} ${p.host} ${p.driver}`.toLowerCase().includes(query));
    members.innerHTML = profiles.length ? profiles.map(p => `<label class="connection-group-member"><span><strong>${escape(p.name)}</strong><small>${escape(p.host)} · ${escape(p.driver || 'postgres')}</small></span><select data-group-connection="${escape(p.id)}" aria-label="${escape(p.name)}的分组">${options(store.groupFor(p.id))}</select></label>`).join('') : '<p class="connection-group-empty">没有匹配的连接</p>';
    if (focusId) [...members.querySelectorAll('select')].find(select => select.dataset.groupConnection === focusId)?.focus();
  }
  function renderSettings() {
    settings.innerHTML = store.snapshot().groups.map(g => `<form class="connection-group-setting" data-group-id="${escape(g.id)}"><input name="name" value="${escape(g.name)}" maxlength="60" required aria-label="重命名分组 ${escape(g.name)}"><button class="quiet-btn" type="submit">保存名称</button><button class="quiet-btn" type="button" data-delete-group="${escape(g.id)}" aria-label="删除分组 ${escape(g.name)}">删除</button></form>`).join('');
    renderMembers();
  }
  function update(action, message) {
    try { action(); feedback.textContent = message; feedback.classList.remove('error'); onChange(); return true; }
    catch (error) { feedback.textContent = error.message; feedback.classList.add('error'); return false; }
  }
  function open(connectionId) {
    search.value = connectionId ? getProfiles().find(p => p.id === connectionId)?.name || '' : '';
    feedback.textContent = '';
    renderSettings(); dialog.showModal();
    if (connectionId) renderMembers(connectionId); else dialog.querySelector('.connection-group-create input').focus();
  }
  button.addEventListener('click', () => open());
  dialog.querySelectorAll('[data-close-groups]').forEach(close => close.addEventListener('click', () => dialog.close()));
  dialog.querySelector('.connection-group-create').addEventListener('submit', event => {
    event.preventDefault(); const input = event.currentTarget.elements.name;
    if (update(() => store.add(input.value), '分组已创建')) { input.value = ''; renderSettings(); input.focus(); }
  });
  settings.addEventListener('submit', event => {
    event.preventDefault(); const form = event.target;
    if (update(() => store.rename(form.dataset.groupId, form.elements.name.value), '分组名称已保存')) renderSettings();
  });
  settings.addEventListener('click', event => {
    const target = event.target.closest('[data-delete-group]');
    if (target && update(() => store.remove(target.dataset.deleteGroup), '分组已删除，连接已移至未分组')) renderSettings();
  });
  search.addEventListener('input', () => renderMembers());
  members.addEventListener('change', event => {
    const select = event.target.closest('[data-group-connection]');
    if (select && !update(() => store.move(select.dataset.groupConnection, select.value), '连接分组已保存')) renderMembers(select.dataset.groupConnection);
  });
  list.addEventListener('click', event => {
    const summary = event.target.closest('.connection-group > summary');
    if (!summary || !list.contains(summary)) return;
    event.preventDefault();
    const details = summary.parentElement, open = !details.open;
    try {
      if (details.dataset.searching !== 'true') store.collapse(details.dataset.connectionGroup, !open);
      details.open = open;
    } catch (error) { onError(error); }
  });
  return {
    open,
    nameFor(id) { return store.snapshot().groups.find(g => g.id === store.groupFor(id))?.name || '未分组'; },
    groupFor: store.groupFor,
    moveTo(id, group) {
      if (store.groupFor(id) === group) return false;
      store.move(id, group);
      return true;
    },
    render(profiles, renderCard, query) {
      const { groups, collapsed } = store.snapshot();
      if (!groups.length) return profiles.map(renderCard).join('');
      const searching = Boolean(query.trim());
      return [...groups, { id: '', name: '未分组' }].map(group => {
        const items = profiles.filter(p => store.groupFor(p.id) === group.id);
        if (!items.length && searching) return '';
        return `<details class="connection-group" data-connection-group="${escape(group.id)}" data-searching="${searching}"${searching || !collapsed.includes(group.id) ? ' open' : ''}><summary><span class="connection-group-chevron" aria-hidden="true">›</span><span class="connection-group-name">${escape(group.name)}</span><small>${items.length}</small></summary><div class="connection-group-items">${items.length ? items.map(renderCard).join('') : '<p class="connection-group-empty">拖动连接到这里</p>'}</div></details>`;
      }).join('');
    },
  };
}
