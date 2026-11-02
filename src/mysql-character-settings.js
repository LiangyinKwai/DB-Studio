// The connected MySQL server supplies the available pairs; defaults stay implicit.
export function mysqlCharacterClause(charset = '', collation = '') {
  if (!charset && !collation) return '';
  if (!/^[a-zA-Z0-9_]+$/.test(charset) || (collation && (!/^[a-zA-Z0-9_]+$/.test(collation) || !collation.toLowerCase().startsWith(`${charset.toLowerCase()}_`)))) throw new Error('字符集与排序规则不匹配');
  return ` DEFAULT CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ''}`;
}

export function createMysqlCharacterPicker(settings, inheritLabel = '继承默认值') {
  const wrapper = document.createElement('div'); wrapper.className = 'connection-form';
  const charLabel = document.createElement('label'); charLabel.textContent = '字符集';
  const charset = document.createElement('select'); charset.setAttribute('aria-label', '字符集');
  const collLabel = document.createElement('label'); collLabel.textContent = '排序规则';
  const collation = document.createElement('select'); collation.setAttribute('aria-label', '排序规则');
  const choices = settings.choices || [];
  charset.add(new Option(inheritLabel, ''));
  for (const item of [...new Set(choices.map(item => item.charset))]) charset.add(new Option(item, item));
  function sync() {
    collation.replaceChildren();
    collation.add(new Option(charset.value ? '使用该字符集的默认排序规则' : inheritLabel, ''));
    for (const item of choices.filter(item => item.charset === charset.value)) collation.add(new Option(item.collation + (item.isDefault ? '（默认）' : ''), item.collation));
    collation.disabled = !charset.value;
  }
  charset.addEventListener('change', sync); sync();
  charLabel.append(charset); collLabel.append(collation);
  const hint = document.createElement('p'); hint.className = 'form-note';
  hint.textContent = settings.defaults ? `当前默认：${settings.defaults.charset} / ${settings.defaults.collation}。未选择时继承默认设置。` : '未选择时继承默认设置。';
  wrapper.append(charLabel, collLabel, hint);
  return { element: wrapper, value: () => ({ charset: charset.value, collation: collation.value }) };
}
