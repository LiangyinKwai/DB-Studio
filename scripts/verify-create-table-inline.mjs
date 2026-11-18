import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { chooseAppSelect } from './app-select-driver.mjs';
import { mysqlCommentLiteral } from '../src/mysql-ddl.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = resolve(root, 'output/playwright/create-table-inline'); mkdirSync(evidence, { recursive: true });
const bundle = await build({ stdin: { contents: `
  import { openStructureEditor } from './src/structure-editor.js';
  import { initAppSelects } from './src/app-select.js';
  initAppSelects();
  window.openDesigner = driver => openStructureEditor({ create: true, driver, details: { schema: 'test_schema', ...(driver === 'mysql' ? {mysql:{sqlMode:''}} : {}) }, targetLabel: 'UI fixture / test_schema',
    confirmDiscard: async () => true, onClose() {}, onApply: async plan => { window.appliedPlan = plan; return false; } });
  window.openExisting = ({driver,details}) => openStructureEditor({ driver, details, targetLabel: 'UI fixture / existing',
    confirmDiscard: async () => true, onClose() {}, onApply: async plan => { window.appliedPlan = plan; return false; } });
  window.harnessReady = true;
`, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', write: false });
const html = `<!doctype html><html><head><meta charset="utf-8">${['styles', 'themes', 'workspace', 'app-select', 'selection', 'scrollbars'].map(name => `<link rel="stylesheet" href="/src/${name}.css">`).join('')}</head><body data-theme="dark"><script type="module" src="/harness.js"></script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  if (req.url === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
  const file = resolve(root, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//u, ''));
  if (!file.startsWith(`${root}/src/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/css' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const reports = [];
try {
  for (const driver of ['postgres', 'mysql']) for (const viewport of [{ width: 1240, height: 840 }, { width: 1060, height: 680 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.harnessReady);
      await page.evaluate(driver => window.openDesigner(driver), driver);
      const dialog = page.locator('.create-table-dialog'), rows = dialog.locator('.structure-editor-table tbody > tr'); await dialog.waitFor();
      const field = (index, key) => rows.nth(index).locator(`[data-field="${key}"]`);
      const add = async (name, type) => {
        await dialog.getByRole('button', { name: '＋ 添加字段', exact: true }).click(); const index = await rows.count() - 1;
        await field(index, 'name').fill(name); await field(index, 'dataType').fill(type); await field(index, 'comment').click(); return index;
      };
      const label = await add('label', 'varchar(128)');
      await chooseAppSelect(rows.nth(label).locator('[data-default-mode]'), 'text'); await field(label, 'defaultValue').fill('未命名');
      const amount = await add('amount', driver === 'mysql' ? 'decimal(18,4)' : 'numeric(18,4)');
      await chooseAppSelect(rows.nth(amount).locator('[data-default-mode]'), 'expression');
      await chooseAppSelect(rows.nth(amount).locator('[data-default-preset]'), '0');
      const enabled = await add('enabled', 'boolean');
      await chooseAppSelect(rows.nth(enabled).locator('[data-default-mode]'), 'expression');
      await chooseAppSelect(rows.nth(enabled).locator('[data-default-preset]'), 'TRUE');
      await field(label, 'comment').fill('prefix suffix');
      const geometry = await rows.evaluateAll(nodes => nodes.map(row => {
        const controls = [...row.querySelectorAll('input:not([type=checkbox]), button, .app-select-trigger')].filter(node => node.getClientRects().length);
        const positions = controls.map(node => {
          const rect = node.getBoundingClientRect(), cell = node.closest('td').getBoundingClientRect();
          return { name: node.getAttribute('aria-label') || node.textContent, y: rect.y, height: rect.height, width: rect.width, left: rect.left, right: rect.right, cellLeft: cell.left, cellRight: cell.right,
            step: node.hasAttribute('data-parameter-step'), numeric: node.hasAttribute('data-type-parameter'), field: node.dataset.field };
        });
        return { height: row.getBoundingClientRect().height, positions };
      }));
      for (const row of geometry) {
        const baseline = row.positions.find(position => position.field === 'name');
        assert.ok(row.height <= 48, `a field wrapped to ${row.height}px`);
        assert.ok(baseline.width >= 125, `name only ${baseline.width}px`);
        for (const position of row.positions) {
          assert.ok(Math.abs(position.y + position.height / 2 - baseline.y - baseline.height / 2) <= 1, `${position.name}: controls no longer share a row`);
          assert.ok(position.left >= position.cellLeft - 1 && position.right <= position.cellRight + 1, `${position.name}: overflowed its cell`);
          if (position.step) { assert.equal(position.width, 28); assert.equal(position.height, 32); }
          if (position.numeric) assert.ok(position.width >= 34);
          if (position.field === 'dataType') assert.ok(position.width >= 100);
          if (position.field === 'defaultValue') assert.ok(position.width >= 90);
        }
      }
      const overflow = await dialog.locator('.structure-editor-scroll').evaluate(node => node.scrollWidth - node.clientWidth);
      assert.ok(overflow <= (viewport.width === 1240 ? 2 : 200), `unexpected horizontal overflow: ${overflow}px`);
      const headers = await dialog.locator('thead th:nth-child(4), thead th:nth-child(5), thead th:nth-child(6)').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, whiteSpace: getComputedStyle(node).whiteSpace })));
      assert.ok(headers.every(header => header.height <= 38 && header.whiteSpace === 'nowrap'), 'constraint headers stay on one line');
      await dialog.locator('.structure-editor-scroll').evaluate(node => { node.scrollLeft = 0; });
      await dialog.screenshot({ path: resolve(evidence, `${driver}-${viewport.width}-inline.png`) });

      // Multiline paste is intercepted before input[type=text] strips newlines.
      await field(label, 'comment').evaluate(node => {
        node.focus(); node.setSelectionRange(7, 13);
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'first line\r\nsecond line\rthird line');
        const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
        node.dispatchEvent(event); if (!event.defaultPrevented) throw new Error('multiline paste was not intercepted');
      });
      const comment = page.locator('.structure-comment-dialog'); await comment.waitFor();
      const textarea = comment.locator('textarea');
      assert.equal(await textarea.inputValue(), 'prefix first line\nsecond line\nthird line');
      await textarea.press('Escape');
      assert.equal(await field(label, 'comment').getAttribute('readonly'), '');
      assert.equal(await field(label, 'comment').inputValue(), 'prefix first line ⏎ second line ⏎ third line');
      assert.equal(await field(label, 'comment').getAttribute('title'), 'prefix first line\r\nsecond line\rthird line');
      await field(label, 'comment').focus(); await field(label, 'comment').press('Enter'); await comment.waitFor();
      const original = "第一行 O'Reilly\r\n第二行 \\ path\r第三行\n" + '很长的备注，可完整阅读和编辑。'.repeat(45);
      await textarea.evaluate((node, text) => {
        node.focus(); node.select(); const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
      }, original);
      assert.equal(await field(label, 'comment').getAttribute('title'), original);
      assert.equal(await dialog.getByRole('button', { name: '保存…', exact: true }).isEnabled(), true, 'backslash comments remain saveable with known SQL_MODE');
      await textarea.evaluate(node => { node.setSelectionRange(node.value.indexOf('第二行') + 3, node.value.indexOf('第二行') + 3); });
      await page.keyboard.insertText('修改');
      assert.equal(await field(label, 'comment').getAttribute('title'), original.replace('第二行', '第二行修改'));
      await textarea.press('ControlOrMeta+Z'); assert.equal(await field(label, 'comment').getAttribute('title'), original);
      await textarea.press('ControlOrMeta+Shift+Z'); assert.equal(await field(label, 'comment').getAttribute('title'), original.replace('第二行', '第二行修改'));
      await textarea.press('ControlOrMeta+Z');
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
        const box = await comment.boundingBox(); assert.ok(box.x >= 12 && box.y >= 12 && box.x + box.width <= viewport.width - 12 && box.y + box.height <= viewport.height - 12);
        assert.equal(await textarea.inputValue(), original.replace(/\r\n?/g, '\n'));
        await comment.screenshot({ path: resolve(evidence, `${driver}-${viewport.width}-comment-${theme}.png`) });
      }
      await comment.getByRole('button', { name: '完成', exact: true }).click();
      await add('after_comment', 'text');
      await rows.nth(label).locator('.column-comment-expand').click();
      assert.equal(await textarea.inputValue(), original.replace(/\r\n?/g, '\n'), 'row rerender must preserve full multiline comment');
      assert.equal(await field(label, 'comment').getAttribute('title'), original);
      await textarea.press('Escape');
      await dialog.getByRole('button', { name: '保存…', exact: true }).click();
      await dialog.getByLabel('表名', { exact: true }).fill('inline_layout_test');
      await dialog.getByLabel('表注释', { exact: true }).fill('主表说明');
      const sql = await dialog.locator('.structure-sql-preview pre').textContent();
      assert.ok(sql.includes(driver === 'mysql' ? "COMMENT='主表说明'" : "IS E'主表说明'"));
      assert.ok(sql.includes("O''Reilly")); assert.ok(sql.includes('\r\n第二行'), 'DDL must retain literal CRLF');
      assert.ok(sql.includes('\r第三行\n'), 'DDL must retain separate CR and LF');
      assert.ok(!sql.includes(' ⏎ '), 'the collapsed preview must never become the DDL source');
      assert.equal(await page.evaluate(() => window.appliedPlan || null), null, 'comment editing never executes the parent form');
      assert.deepEqual(errors, []); reports.push({ driver, viewport, overflow, rowHeights: geometry.map(row => row.height), commentCharacters: original.length });
    } finally { await context.close(); }
  }
  const existingReports = [];
  for (const [driver, sqlMode] of [['postgres', null], ['mysql', ''], ['mysql', 'NO_BACKSLASH_ESCAPES'], ['mysql', null]]) {
    const context = await browser.newContext({ viewport: { width: 1240, height: 840 } }); const page = await context.newPage();
    const original = "first\r\nsecond\rthird\npath\\'end";
    const details = { schema: 'test_schema', name: 'existing', qualifiedName: 'test_schema.existing', kind: 'table', columns: [
      { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, identity: true, comment: 'identity' },
      { name: 'note', dataType: 'varchar(128)', nullable: true, defaultValue: "'draft'", comment: original },
      { name: 'updated', dataType: 'timestamp(6)', nullable: false, defaultValue: 'CURRENT_TIMESTAMP(6)', comment: 'updated' },
      { name: 'computed', dataType: 'integer', nullable: true, generated: true, comment: 'generated' },
    ] };
    if (driver === 'mysql' && sqlMode !== null) {
      details.mysql = { sqlMode, engine: 'InnoDB' };
      details.definition = "CREATE TABLE `existing` (`id` bigint NOT NULL AUTO_INCREMENT, `note` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT 'draft' COMMENT " + mysqlCommentLiteral(original, sqlMode) + ", `updated` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), `computed` int GENERATED ALWAYS AS ((`id` % 97)) STORED INVISIBLE, PRIMARY KEY (`id`)) ENGINE=InnoDB";
    }
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.harnessReady);
      await page.evaluate(value => window.openExisting(value), { driver, details });
      const parent = page.locator('.structure-editor-dialog'), row = parent.locator('.structure-editor-table tbody > tr').nth(1);
      const input = row.locator('[data-field="comment"]'), expand = row.locator('.column-comment-expand');
      assert.equal(await input.getAttribute('title'), original);
      assert.equal(await input.getAttribute('readonly'), '');
      if (driver === 'mysql' && sqlMode === null) {
        assert.equal(await input.isDisabled(), true); assert.equal(await expand.isDisabled(), true);
        existingReports.push({ driver, nativeMetadata: false, readonlyPreserved: true }); continue;
      }
      await expand.click(); const editor = page.locator('.structure-comment-dialog'), text = editor.locator('textarea');
      assert.equal(await text.inputValue(), original.replace(/\r\n?/g, '\n'));
      await text.press('Escape'); assert.equal(await parent.getByRole('button', { name: '预览并应用', exact: true }).isDisabled(), true);
      await expand.click(); await text.evaluate(node => { const start = node.value.indexOf('second'); node.setSelectionRange(start, start + 6); });
      await page.keyboard.insertText('第二行'); const edited = original.replace('second', '第二行');
      assert.equal(await input.getAttribute('title'), edited);
      await text.press('ControlOrMeta+Z'); assert.equal(await input.getAttribute('title'), original);
      await text.press('ControlOrMeta+Shift+Z'); assert.equal(await input.getAttribute('title'), edited);
      await text.press('Escape');
      let sql = await parent.locator('.structure-sql-preview pre').textContent();
      assert.ok(sql.includes('first\r\n第二行\rthird\n'));
      if (driver === 'mysql') {
        assert.match(sql, /CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/); assert.match(sql, /DEFAULT 'draft'/);
        for (const index of [2, 3]) {
          await parent.locator('.structure-editor-table tbody > tr').nth(index).locator('.column-comment-expand').click();
          await text.fill(`special ${index}`); await text.press('Escape');
        }
        sql = await parent.locator('.structure-sql-preview pre').textContent();
        assert.match(sql, /ON UPDATE CURRENT_TIMESTAMP\(6\)/); assert.match(sql, /GENERATED ALWAYS AS .* STORED INVISIBLE/);
      }
      await parent.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
      await parent.locator('.structure-editor-table tbody > tr').last().getByRole('button', { name: '删除', exact: true }).click();
      assert.equal(await input.getAttribute('title'), edited);
      await row.getByRole('button', { name: '删除', exact: true }).click();
      assert.equal(await expand.isDisabled(), true); assert.equal(await input.isDisabled(), true);
      await row.getByRole('button', { name: '撤销删除', exact: true }).click();
      assert.equal(await expand.isEnabled(), true); assert.equal(await input.getAttribute('title'), edited);
      assert.equal(await page.evaluate(() => window.appliedPlan || null), null);
      existingReports.push({ driver, sqlMode, exactLineEndings: true, attributesPreserved: true });
    } finally { await context.close(); }
  }
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ passed: true, reports, existingReports }, null, 2));
  console.log(JSON.stringify({ passed: true, layouts: reports }));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
