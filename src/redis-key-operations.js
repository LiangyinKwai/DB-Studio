import { redisKeyTypePresentation } from './redis-key-icons.js';
import { initRedisDialog, redisLocation, redisTtlSummary } from './redis-ui.js';

export const redisTypeActions = Object.freeze({
  string: [['ttl', '设置过期时间']],
  hash: [['add', '添加字段'], ['remove', '删除字段'], ['ttl', '设置过期时间']],
  list: [['add', '追加到尾部'], ['prepend', '插入到头部'], ['ttl', '设置过期时间']],
  set: [['add', '添加成员'], ['remove', '移除成员'], ['ttl', '设置过期时间']],
  zset: [['add', '添加成员'], ['score', '修改分数'], ['remove', '移除成员'], ['ttl', '设置过期时间']],
  stream: [['add', '追加消息'], ['remove', '删除消息'], ['ttl', '设置过期时间']],
});

export function createRedisKeyOperations({ apply, onError = console.error }) {
  const dialog = document.createElement('dialog'); dialog.className = 'redis-operation-dialog redis-form-dialog';
  dialog.setAttribute('aria-labelledby', 'redisOperationTitle');
  dialog.innerHTML = `<form><div class="dialog-header"><div><h2 id="redisOperationTitle">操作 Key</h2><p class="redis-dialog-location"></p></div><button type="button" class="icon-btn" data-close aria-label="关闭 Redis 操作">×</button></div>
    <div class="redis-target-card"><span class="redis-target-type"></span><code class="redis-operation-target"></code></div>
    <label class="redis-action-switch">切换操作<select name="action"></select></label>
    <label data-picker>选择已加载的条目<select data-entry-picker><option value="">手动填写</option></select></label>
    <label data-field>字段名称<input name="field" autocomplete="off" spellcheck="false"></label>
    <label data-value><span data-value-label>值</span><textarea name="value" rows="3" spellcheck="false"></textarea></label>
    <label data-score>分数<input name="score" type="number" step="any" value="0" required><small class="form-note">支持小数和负数，保存后按分数排序。</small></label>
    <div data-ttl><p class="redis-current-ttl"></p><label>有效期（秒）<input name="ttl" type="number" min="0" max="2147483647" step="1" value="0" required></label><div class="redis-ttl-presets" aria-label="常用有效期"><button type="button" data-ttl-preset="0">永久</button><button type="button" data-ttl-preset="60">1 分钟</button><button type="button" data-ttl-preset="600">10 分钟</button><button type="button" data-ttl-preset="3600">1 小时</button><button type="button" data-ttl-preset="86400">1 天</button></div><p class="form-note">0 表示永久；设置有效期从操作成功时开始计时。</p></div>
    <p class="redis-operation-hint form-note" data-hint></p><p class="dialog-feedback" role="status" aria-live="polite"></p>
    <div class="dialog-actions"><button type="button" class="secondary-btn" data-close>取消</button><button class="primary-btn" type="submit">添加</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), action = form.elements.action, picker = dialog.querySelector('[data-entry-picker]');
  const feedback = dialog.querySelector('.dialog-feedback'), submit = form.querySelector('[type=submit]');
  let context, busy = false;
  const modal = initRedisDialog(dialog, { canClose: () => !busy, onClose: () => { context = null; } });
  const actionLabel = () => redisTypeActions[context.keyType].find(([value]) => value === action.value)?.[1] || '操作 Key';
  function selectEntry(row) {
    if (!row) return;
    form.elements.field.value = row.field ?? '';
    form.elements.value.value = row.member ?? row.id ?? row.value ?? '';
    form.elements.score.value = row.score ?? '0';
  }
  function syncIdentityFields() {
    if (!['remove', 'score'].includes(action.value)) return;
    const chosen = picker.value !== '';
    if (context.keyType === 'hash') dialog.querySelector('[data-field]').hidden = chosen;
    else dialog.querySelector('[data-value]').hidden = chosen;
  }
  function render() {
    const type = context.keyType, mode = action.value, remove = mode === 'remove', ttl = mode === 'ttl';
    dialog.classList.toggle('redis-stream-remove', type === 'stream' && remove);
    const field = type === 'hash' || (type === 'stream' && mode === 'add');
    for (const [name, visible] of Object.entries({ field: !ttl && field, value: !ttl && !(type === 'hash' && remove), score: type === 'zset' && ['add', 'score'].includes(mode), ttl })) {
      dialog.querySelector(`[data-${name}]`).hidden = !visible;
      form.elements[name].disabled = !visible;
    }
    dialog.querySelector('.redis-action-switch').hidden = context.onlyTtl || redisTypeActions[type].length === 1;
    form.elements.field.required = !ttl && field && !remove;
    form.elements.value.required = type === 'stream' && remove;
    form.elements.value.rows = type === 'stream' && remove ? 1 : 3;
    form.elements.value.placeholder = type === 'stream' && remove ? '例如 1730000000000-0' : ['set', 'zset'].includes(type) ? '输入成员，可包含空格和换行' : '输入内容，允许空字符串';
    dialog.querySelector('[data-value-label]').textContent = type === 'stream' && remove ? '消息 ID' : ['set', 'zset'].includes(type) ? '成员' : type === 'stream' ? '字段值' : '值';
    dialog.querySelector('[data-picker]').hidden = !(['remove', 'score'].includes(mode) && context.entries?.length);
    picker.replaceChildren(new Option('手动填写', ''), ...(context.entries || []).map((row, index) => {
      const value = String(row.field ?? row.member ?? row.id ?? row.value ?? '');
      return new Option(value.length > 65 ? `${value.slice(0, 65)}…` : value || '（空字符串）', String(index));
    }));
    if (['remove', 'score'].includes(mode)) {
      selectEntry(context.selected);
      const index = context.entries?.indexOf(context.selected); if (index >= 0) picker.value = String(index);
    }
    syncIdentityFields();
    dialog.querySelector('[data-hint]').textContent = ttl ? '' : remove ? type === 'stream' ? '仅删除这条消息，其他消息保留。空的消息流仍然存在。' : '移除最后一个成员或字段时，Redis 会自动删除该 Key。' : type === 'stream' ? '自动生成消息 ID，追加一组字段和值，历史消息保留。' : type === 'list' ? '列表允许重复值；插入到头部会改变后续元素的下标。' : type === 'set' ? '成员不保证顺序；重复添加同一成员不会产生副本。' : type === 'hash' ? '已有字段不会覆盖。修改字段值可在表格中双击编辑。' : type === 'zset' ? mode === 'score' ? '仅修改所选成员的分数，保留其他成员。' : '成员唯一。已有成员请使用「修改分数」。' : '';
    dialog.querySelector('#redisOperationTitle').textContent = actionLabel();
    submit.textContent = ttl ? '保存有效期' : actionLabel();
    submit.className = remove ? 'danger-btn' : 'primary-btn'; feedback.textContent = '';
  }
  action.addEventListener('change', render);
  picker.addEventListener('change', () => { if (picker.value !== '') selectEntry(context.entries[Number(picker.value)]); syncIdentityFields(); });
  dialog.querySelectorAll('[data-ttl-preset]').forEach(button => button.addEventListener('click', () => { form.elements.ttl.value = button.dataset.ttlPreset; syncPresets(); }));
  function syncPresets() { dialog.querySelectorAll('[data-ttl-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.ttlPreset === form.elements.ttl.value))); }
  form.elements.ttl.addEventListener('input', syncPresets);
  form.addEventListener('input', () => { feedback.textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!context || busy || !form.reportValidity()) return;
    const entry = context, operation = { action: action.value, field: form.elements.field.value, value: form.elements.value.value,
      score: form.elements.score.disabled ? 0 : Number(form.elements.score.value), ttl: form.elements.ttl.disabled ? 0 : Number(form.elements.ttl.value) };
    busy = true; const enabled = [...form.elements].filter(control => !control.disabled); enabled.forEach(control => { control.disabled = true; });
    try { await apply(entry, operation); busy = false; modal.close(); }
    catch (error) { feedback.textContent = error?.message || String(error); onError(error); }
    finally { busy = false; enabled.forEach(control => { control.disabled = false; }); }
  });
  return { open(entry, initialAction) {
    if (busy || !redisTypeActions[entry.keyType]) return;
    context = { ...entry, onlyTtl: initialAction === 'ttl' }; form.reset();
    dialog.querySelector('.redis-dialog-location').textContent = redisLocation(entry);
    dialog.querySelector('.redis-target-type').innerHTML = redisKeyTypePresentation(entry.keyType).icon;
    dialog.querySelector('.redis-operation-target').textContent = entry.key;
    dialog.querySelector('.redis-current-ttl').textContent = `当前：${redisTtlSummary(entry.ttl)}`;
    action.replaceChildren(...redisTypeActions[entry.keyType].map(([value, text]) => new Option(text, value)));
    if (redisTypeActions[entry.keyType].some(([value]) => value === initialAction)) action.value = initialAction;
    form.elements.ttl.value = String(Math.max(0, entry.ttl || 0));
    render(); syncPresets(); modal.open();
    (form.querySelector('[data-field]:not([hidden]) input, [data-value]:not([hidden]) textarea, [data-ttl]:not([hidden]) input') || action).focus();
  } };
}
