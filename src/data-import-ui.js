import { autoMapColumns, buildImportSql, readTransferFile } from './data-transfer.js';

export function openDataImport({ file, format, table, driver, targetLabel, onApply, onComplete }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'data-import-dialog';
  dialog.setAttribute('aria-label', '导入数据');
  dialog.innerHTML = `<form class="data-import-form">
    <div class="dialog-header"><h2>导入数据</h2><button class="icon-btn" type="button" data-close aria-label="关闭">×</button></div>
    <div class="data-import-target"></div><div class="data-import-file"></div>
    <p class="form-note">首行为字段名。仅新增记录，不覆盖已有数据；空字符串与 NULL 分开处理。CSV/TXT 的未加引号 \\N 表示 NULL。</p>
    <div class="data-import-options"><label data-delimiter-label>分隔符<select data-delimiter><option value=",">逗号</option><option value="\t">制表符</option><option value=";">分号</option></select></label><label data-sheet-label hidden>工作表<select data-sheet></select></label></div>
    <div class="data-import-mapping" aria-label="字段映射"></div>
    <div class="data-import-preview" tabindex="0" aria-label="导入数据预览"></div>
    <details class="data-import-sql"><summary>查看 INSERT SQL</summary><pre class="selectable-text"></pre></details>
    <div class="data-import-feedback" role="status" aria-live="polite"></div>
    <div class="dialog-actions"><button class="secondary-btn" type="button" data-close>取消</button><button class="primary-btn" type="submit" data-apply disabled>确认导入</button></div>
  </form>`;
  const find = selector => dialog.querySelector(selector);
  const delimiter = find('[data-delimiter]'), sheet = find('[data-sheet]');
  const mappingPanel = find('.data-import-mapping'), preview = find('.data-import-preview');
  const feedback = find('.data-import-feedback'), apply = find('[data-apply]');
  find('.data-import-target').textContent = `目标：${targetLabel}`;
  find('.data-import-file').textContent = `${file.name} · ${format.toUpperCase()}`;
  find('[data-delimiter-label]').hidden = !['csv', 'txt'].includes(format);
  delimiter.value = format === 'txt' ? '\t' : ',';
  let data, mapping = [], sql = '', busy = false, generation = 0;
  const close = () => { if (!busy) dialog.close(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; dialog.remove(); });
  function compile() {
    try {
      sql = buildImportSql(data, mapping, table, driver);
      find('.data-import-sql pre').textContent = sql.length > 16000 ? sql.slice(0, 16000) + '\n-- 预览已省略后续内容，导入将使用全部数据。' : sql;
      feedback.textContent = `${data.rows.length} 行 · ${mapping.filter(Boolean).length} 个目标字段 · 预览前 ${Math.min(10, data.rows.length)} 行`;
      feedback.classList.remove('error'); apply.disabled = false;
    } catch (error) { sql = ''; apply.disabled = true; feedback.textContent = error.message; feedback.classList.add('error'); }
  }
  function renderPreview() {
    preview.replaceChildren();
    const grid = document.createElement('table');
    const head = document.createElement('tr');
    data.columns.forEach(column => { const th = document.createElement('th'); th.textContent = column; head.append(th); });
    const thead = document.createElement('thead'); thead.append(head); grid.append(thead);
    const tbody = document.createElement('tbody');
    data.rows.slice(0, 10).forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(value => { const td = document.createElement('td'); td.textContent = value === null ? 'NULL' : value === undefined ? 'DEFAULT' : typeof value === 'object' ? JSON.stringify(value) : String(value); tr.append(td); });
      tbody.append(tr);
    });
    grid.append(tbody); preview.append(grid);
    mappingPanel.replaceChildren();
    data.columns.forEach((column, index) => {
      const label = document.createElement('label'), name = document.createElement('span'), select = document.createElement('select');
      name.textContent = column; select.setAttribute('aria-label', `目标字段 ${column}`); select.dataset.sourceColumn = String(index);
      const skip = document.createElement('option'); skip.value = ''; skip.textContent = '跳过此列'; select.append(skip);
      table.columns.filter(field => !field.generated).forEach(field => { const option = document.createElement('option'); option.value = field.name; option.textContent = field.name + (field.identity ? ' · 自增' : ''); select.append(option); });
      select.value = mapping[index]; select.addEventListener('change', () => { mapping[index] = select.value; compile(); });
      label.append(name, document.createTextNode(' → '), select); mappingPanel.append(label);
    });
    compile();
  }
  async function load() {
    const request = ++generation;
    sql = ''; data = null; mapping = []; mappingPanel.replaceChildren(); preview.replaceChildren();
    find('.data-import-sql pre').textContent = '';
    apply.disabled = true; feedback.textContent = '正在读取文件…';
    try {
      const parsed = await readTransferFile(file, { format, delimiter: delimiter.value, sheet: Number(sheet.value || 0) });
      if (request !== generation || !dialog.open) return;
      data = parsed;
      if (parsed.sheets) {
        const index = sheet.value || '0'; sheet.replaceChildren();
        parsed.sheets.forEach((name, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = name; sheet.append(option); });
        sheet.value = index; find('[data-sheet-label]').hidden = parsed.sheets.length < 2;
      }
      if (parsed.error) throw new Error(parsed.error);
      mapping = autoMapColumns(data.columns, table.columns); renderPreview();
    } catch (error) { if (request === generation) { feedback.textContent = `读取失败：${error.message}`; feedback.classList.add('error'); } }
  }
  delimiter.addEventListener('change', load); sheet.addEventListener('change', load);
  find('form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !sql || apply.disabled) return;
    busy = true; apply.disabled = true; apply.textContent = '正在导入…';
    dialog.querySelectorAll('select,[data-close]').forEach(control => { control.disabled = true; });
    try {
      const outcome = await onApply({ sql, rowCount: data.rows.length });
      busy = false; dialog.close();
      await onComplete?.(outcome);
    } catch (error) {
      feedback.textContent = `导入失败：${error.message}。请核对目标表状态后再重试，文件与映射已保留。`;
      feedback.classList.add('error');
    } finally {
      busy = false; apply.disabled = !sql; apply.textContent = '确认导入';
      dialog.querySelectorAll('select,[data-close]').forEach(control => { control.disabled = false; });
    }
  });
  document.body.append(dialog); dialog.showModal(); void load();
  return dialog;
}
