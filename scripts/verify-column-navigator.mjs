import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'output/playwright/column-navigator');
mkdirSync(output, { recursive: true });
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/themes.css"><link rel="stylesheet" href="/src/result-grid.css"><link rel="stylesheet" href="/src/column-navigator.css"><style>*{box-sizing:border-box}body{margin:24px;font-family:system-ui}#grid{height:500px;margin-top:16px;border:1px solid var(--app-border)}#open{height:32px;color:var(--app-text);background:var(--app-panel);border:1px solid var(--app-border);border-radius:5px}</style></head><body><button id="open">定位列</button><div id="grid"></div><script type="module">
import { ResultGrid } from '/src/result-grid.js';
import { createColumnNavigator } from '/src/column-navigator.js';
const columns = Array.from({ length: 100 }, (_, index) => ({ name: index === 80 ? '<unsafe & duplicate>' : index === 10 ? '重复列' : index === 90 ? '重复列' : 'field_' + index, dataType: index === 75 ? 'jsonb' : 'varchar(255)' }));
const rows = Array.from({ length: 400 }, (_, row) => columns.map((_, column) => row + ':' + column));
window.draftNotifications = [];
window.grid = new ResultGrid(document.querySelector('#grid'), { getCellEditState: () => ({ editable: true }), onCommitCell: async () => true, onDraftChange: value => window.draftNotifications.push(value) });
grid.setResult({ columns, rows });
window.navigatorPanel = createColumnNavigator({ getGrid: () => grid });
document.querySelector('#open').addEventListener('click', event => navigatorPanel.open(event.currentTarget));
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'j') { event.preventDefault(); navigatorPanel.toggle(); } });
window.ready = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  const file = resolve(root, pathname.slice(1));
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'text/plain' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    grid.selected.add(3);
    grid.selectedColumns = new Set([1, 7]);
    grid.sortColumn(0);
    grid.viewport.scrollTop = 3200;
    window.before = JSON.stringify(grid.getSelectedData());
  });
  await page.locator('#open').click();
  const search = page.getByRole('combobox', { name: '搜索列' });
  await search.fill('jsonb');
  assert.equal(await page.getByRole('option').count(), 1);
  await search.press('Enter');
  await page.waitForFunction(() => grid.activeCell?.column === 75);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.columnIndex), '75');
  assert.equal(await page.evaluate(() => JSON.stringify(grid.getSelectedData()) === before), true);
  assert.equal(await page.evaluate(() => grid.activeCell.position), 100);
  assert.equal(await page.evaluate(() => grid.viewport.scrollTop), 3200);
  assert.ok(await page.evaluate(() => grid.viewport.scrollLeft > 6000));
  // Navigation preserves unsaved edits even when the originating cell is virtualized away.
  await page.evaluate(() => grid.startCellEdit(document.activeElement));
  await page.locator('.db-grid-edit-input').fill('preserved draft');
  await page.locator('#open').click();
  await search.fill('重复列');
  assert.equal(await page.getByRole('option').count(), 2);
  await search.press('ArrowDown');
  await search.press('Enter');
  assert.equal(await page.evaluate(() => grid.activeCell.column), 90);
  assert.equal(await page.evaluate(() => grid.getCellEditDrafts().find(item => item.dirty)?.draftValue), 'preserved draft');
  assert.ok(await page.evaluate(() => draftNotifications.some(item => item.dirtyCount === 1)));
  // Esc restores the launching control, and empty searches cannot activate an old choice.
  await page.locator('#open').click();
  await search.fill('missing column');
  await search.press('Enter');
  assert.equal(await page.evaluate(() => navigatorPanel.isOpen), true);
  await search.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open');
  // Escape/Enter during composition must be handled by the IME, not the chooser.
  await page.locator('#open').click();
  await search.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => navigatorPanel.isOpen), true);
  // A result replacement while the chooser is open must never navigate another result.
  await page.evaluate(() => grid.setResult({ columns: ['replacement'], rows: [[1]] }));
  await search.press('Enter');
  assert.match(await page.locator('.column-navigator-empty').textContent(), /结果已变化/);
  assert.equal(await page.evaluate(() => grid.activeCell), null);
  await search.press('Escape');
  // Header-only results remain navigable. Untrusted names remain plain text.
  await page.evaluate(() => grid.setResult({ columns: Array.from({ length: 100 }, (_, index) => ({ name: index === 80 ? '<unsafe & duplicate>' : 'field_' + index, dataType: 'text' })), rows: [] }));
  await page.locator('#open').click();
  await search.fill('unsafe');
  assert.equal(await page.locator('.column-navigator-name').textContent(), '<unsafe & duplicate>');
  assert.equal(await page.locator('.column-navigator-name unsafe').count(), 0);
  await search.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.selectColumn), '80');
  // All themes and small viewports keep the panel inside the visible window.
  for (const theme of ['dark', 'light', 'ocean', 'forest', 'contrast']) {
    await page.evaluate(theme => document.body.dataset.theme = theme, theme);
    await page.locator('#open').click();
    await search.fill('field');
    await page.screenshot({ path: resolve(output, `${theme}.png`) });
    await search.press('Escape');
  }
  await page.setViewportSize({ width: 360, height: 400 });
  await page.locator('#open').click();
  const box = await page.locator('dialog.column-navigator').boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 360 && box.y + box.height <= 400);
  await page.screenshot({ path: resolve(output, 'narrow.png') });
  await search.press('Escape');
  await page.keyboard.press('Control+j');
  assert.equal(await page.evaluate(() => navigatorPanel.isOpen), true);
  await page.keyboard.press('Control+j');
  assert.equal(await page.evaluate(() => navigatorPanel.isOpen), false);
  assert.deepEqual(errors, []);
  console.log('Column navigation browser verification passed (100 columns, 400 rows, preserved edits/selections, 5 themes, narrow viewport).');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
