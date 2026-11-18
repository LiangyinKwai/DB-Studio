import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';

// Bundle only the real dialog and shared select enhancer into a browser harness.
// This keeps native-app testing on the existing dist build undisturbed.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = resolve(root, 'output/playwright/create-table-layout'); mkdirSync(evidence, { recursive: true });
const observe = process.env.DB_STUDIO_LAYOUT_OBSERVE === '1';
const bundled = await build({ stdin: { contents: `
  import { openStructureEditor } from './src/structure-editor.js';
  import { initAppSelects } from './src/app-select.js';
  initAppSelects();
  window.openDesigner = driver => openStructureEditor({
    create: true, driver, details: { schema: driver === 'mysql' ? 'test_database' : 'new_schema' },
    targetLabel: driver === 'mysql' ? 'UI fixture / test_database' : 'UI fixture / test / new_schema',
    mysqlCharacterSettings: { defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }, choices: [{ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', isDefault: true }] },
    confirmDiscard: async () => true, onClose() {},
    onApply: async () => { throw new Error('模拟数据库返回：当前账号没有创建权限，请保留字段并重试。'.repeat(8)); },
  });
  window.layoutHarnessReady = true;
`, resolveDir: root, sourcefile: 'create-table-layout-harness.js', loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${['styles', 'themes', 'workspace', 'app-select', 'selection', 'scrollbars'].map(name => `<link rel="stylesheet" href="/src/${name}.css">`).join('')}</head><body data-theme="dark"><script type="module" src="/harness.js"></script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  if (req.url === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundled.outputFiles[0].text); return; }
  const file = resolve(root, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//u, ''));
  if (!file.startsWith(`${root}/src/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': extname(file) === '.css' ? 'text/css' : 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const reports = [];
const snapshot = dialog => dialog.evaluate(node => {
  const box = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
  return {
    dialog: box(node), add: box(node.querySelector('.structure-editor-toolbar button')), footer: box(node.querySelector('.structure-editor-footer')),
    preview: box(node.querySelector('.structure-sql-preview')), scroller: box(node.querySelector('.structure-editor-scroll')),
    outerScroll: { height: node.scrollHeight, visible: node.clientHeight, top: node.scrollTop },
  };
});
const delta = (first, second) => Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(first[key] - second[key])));
try {
  for (const driver of ['postgres', 'mysql']) for (const viewport of [{ width: 1060, height: 680 }, { width: 1440, height: 1000 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.layoutHarnessReady);
      await page.evaluate(driver => window.openDesigner(driver), driver);
      const dialog = page.locator('.create-table-dialog'); await dialog.waitFor();
      const initial = await snapshot(dialog), samples = [];
      const check = async name => {
        const current = await snapshot(dialog); samples.push({ name, ...current });
        if (!observe) {
          assert.ok(delta(initial.dialog, current.dialog) <= 1, `${driver} ${viewport.width} ${name}: dialog moved/resized`);
          assert.ok(delta(initial.add, current.add) <= 1, `${name}: add button moved`);
          assert.ok(delta(initial.footer, current.footer) <= 1, `${name}: footer moved`);
          assert.ok(current.footer.y + current.footer.height <= viewport.height - 12, `${name}: footer outside viewport`);
          assert.ok(current.outerScroll.height <= current.outerScroll.visible + 1, `${name}: the outer dialog acquired scrolling`);
        }
      };
      for (let index = 1; index <= 10; index++) {
        await dialog.getByRole('button', { name: '＋ 添加字段', exact: true }).click();
        await check(`add empty row ${index}`);
        const row = dialog.locator('tbody > tr').last();
        await row.locator('[data-field="name"]').fill(`field_${index}`);
        await row.locator('[data-field="dataType"]').fill(index % 2 ? 'varchar(128)' : driver === 'mysql' ? 'decimal(18,4)' : 'numeric(18,4)');
        await row.locator('[data-field="comment"]').fill(`第 ${index} 个字段的备注`);
        await check(`configure row ${index}`);
      }
      await dialog.locator('.structure-editor-scroll').evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
      await dialog.screenshot({ path: resolve(evidence, `${observe ? 'before-' : ''}${driver}-${viewport.width}-fields.png`) });
      const save = dialog.getByRole('button', { name: '保存…', exact: true }); await save.click();
      const naming = await snapshot(dialog);
      if (!observe) {
        assert.ok(Math.abs(initial.dialog.height - naming.dialog.height) <= 1, 'naming preserves the dialog height');
        assert.ok(Math.abs(initial.dialog.y - naming.dialog.y) <= 1, 'naming preserves the vertical position');
      }
      for (const value of ['layout_probe', '', 'layout_probe_with_a_long_name']) {
        await dialog.getByLabel('表名', { exact: true }).fill(value);
        const current = await snapshot(dialog);
        if (!observe) assert.ok(delta(naming.dialog, current.dialog) <= 1, 'table-name edits resize the dialog');
      }
      await dialog.getByRole('button', { name: '创建表', exact: true }).click();
      await dialog.locator('.dialog-feedback').filter({ hasText: '模拟数据库返回' }).waitFor();
      const failed = await snapshot(dialog);
      if (!observe) {
        assert.ok(delta(naming.dialog, failed.dialog) <= 1, 'database error resized naming');
        assert.ok(failed.footer.y + failed.footer.height <= viewport.height - 12, 'error pushed submit outside viewport');
        assert.ok(failed.outerScroll.height <= failed.outerScroll.visible + 1, 'error caused outer scrolling');
      }
      await dialog.screenshot({ path: resolve(evidence, `${observe ? 'before-' : ''}${driver}-${viewport.width}-naming.png`) });
      await dialog.getByRole('button', { name: '返回编辑', exact: true }).click(); await check('return to fields');
      while (await dialog.locator('tbody > tr').count() > 1) {
        const count = await dialog.locator('tbody > tr').count();
        await dialog.locator('tbody > tr').last().getByRole('button', { name: '删除', exact: true }).click(); await check(`delete row ${count - 1}`);
      }
      await dialog.locator('.structure-sql-preview summary').click(); await check('collapse SQL');
      await dialog.locator('.structure-sql-preview summary').click(); await check('expand SQL');
      assert.deepEqual(errors, []);
      reports.push({ driver, viewport, initial, maxDialogDelta: Math.max(...samples.map(sample => delta(initial.dialog, sample.dialog))), naming, failed, samples });
    } finally { await context.close(); }
  }
  writeFileSync(resolve(evidence, observe ? 'before-report.json' : 'report.json'), JSON.stringify({ passed: !observe, reports }, null, 2));
  console.log(JSON.stringify({ mode: observe ? 'baseline' : 'verified', layouts: reports.map(report => ({ driver: report.driver, viewport: report.viewport, maxDialogDelta: report.maxDialogDelta })) }));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
