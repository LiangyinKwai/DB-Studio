import { mysqlNoBackslashEscapes, mysqlViewDefinition } from './mysql-ddl.js';

export function openViewEditor({ targetLabel, driver, details, qualify, onApply }) {
  const editing = Boolean(details);
  const title = editing ? '编辑视图定义' : '新建视图';
  const dialog = document.createElement('dialog');
  dialog.className = 'view-editor create-object-dialog';
  dialog.setAttribute('aria-labelledby', 'viewEditorTitle');
  dialog.innerHTML = `
    <div class="dialog-header"><div><h2 id="viewEditorTitle"></h2><p></p></div></div>
    <form class="connection-form">
      <label data-view-name>视图名称<input name="name" type="text" autocomplete="off" required></label>
      <label>查询 SQL<textarea name="query" rows="9" spellcheck="false" required></textarea></label>
      <details class="structure-sql-preview"><summary>SQL 预览</summary><pre class="definition"></pre></details>
      <p class="dialog-feedback error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary-btn">取消</button><button type="submit" class="primary-btn">下一步</button></div>
    </form>`;
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('.dialog-header p').textContent = targetLabel;
  const form = dialog.querySelector('form');
  const { name, query } = form.elements;
  const feedback = dialog.querySelector('.dialog-feedback');
  const [cancel, save] = dialog.querySelectorAll('.dialog-actions button');
  const sqlMode = details?.mysql?.sqlMode;
  let header;
  if (editing) {
    name.disabled = true;
    name.closest('label').hidden = true;
    if (driver === 'mysql') {
      const view = mysqlViewDefinition(details.definition, qualify(details.name), sqlMode);
      header = view.header;
      query.value = view.query;
    } else {
      const querySql = details.definition?.trim().replace(/;$/, '');
      const suffix = querySql && `\n${querySql};`;
      if (!suffix || !details.viewDdl?.endsWith(suffix)) throw new Error('无法读取完整的视图定义');
      header = details.viewDdl.slice(0, -suffix.length);
      query.value = querySql;
    }
  }

  const preview = dialog.querySelector('pre');
  const viewName = () => details?.name ?? name.value.trim();
  const statement = () => `${header || `CREATE VIEW ${qualify(viewName())} AS`}\n${query.value.trim()}`;
  const renderPreview = () => {
    preview.textContent = viewName() && query.value.trim() ? statement() : '输入视图名称与查询后显示 SQL';
  };
  form.addEventListener('input', renderPreview);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (save.disabled) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    const objectName = viewName();
    if (!objectName || !query.value.trim()) {
      feedback.textContent = '请输入视图名称与查询';
      return;
    }
    const sql = statement();
    const expectedMysqlNoBackslashEscapes = editing && driver === 'mysql' ? mysqlNoBackslashEscapes(sqlMode) : undefined;
    save.disabled = cancel.disabled = query.readOnly = true;
    name.readOnly = true;
    feedback.textContent = '';
    try {
      if (await onApply({ name: objectName, sql, expectedMysqlNoBackslashEscapes })) dialog.close();
    } catch (error) {
      feedback.textContent = error?.message || String(error);
    } finally {
      save.disabled = cancel.disabled = query.readOnly = name.readOnly = false;
    }
  });
  renderPreview();
  document.body.append(dialog);
  dialog.showModal();
  (editing ? query : name).focus();
}
