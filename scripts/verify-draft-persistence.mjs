import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from './playwright-import.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/draft-persistence');
mkdirSync(evidence, { recursive: true });
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//u, '') || 'index.html');
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1060, height: 740 } });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
const key = 'db-studio.workspace-tabs.v2';
const editor = page.locator('#sqlEditor .cm-content');
const storedSql = () => page.evaluate(key => JSON.parse(localStorage.getItem(key))[0].sql, key);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#draftSaveStatus').getAttribute('data-state'), 'idle');
  assert.equal(await page.locator('#retryDraftSave').isVisible(), false);
  await page.locator('#addQueryTab').click();
  await editor.fill('SELECT 1 AS baseline;');
  await page.waitForFunction(() => document.getElementById('draftSaveStatus').dataset.state === 'saved');
  assert.equal(await storedSql(), 'SELECT 1 AS baseline;');

  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.__draftSaveTest = { fail: true, errorNotifications: 0, restore() { Storage.prototype.setItem = original; } };
    Storage.prototype.setItem = function (name, value) {
      if (window.__draftSaveTest.fail && name === key) throw new DOMException('Storage is full', 'QuotaExceededError');
      return original.call(this, name, value);
    };
    new MutationObserver(records => {
      if (document.getElementById('toast').textContent.startsWith('SQL 草稿保存失败'))
        window.__draftSaveTest.errorNotifications += records.filter(record => record.type === 'childList').length;
    }).observe(document.getElementById('toast'), { childList: true });
  }, key);
  await editor.fill("SELECT 'draft to keep' AS important_note;");
  await page.waitForFunction(() => document.getElementById('draftSaveStatus').dataset.state === 'error');
  assert.equal(await page.locator('#retryDraftSave').isVisible(), true);
  assert.equal(await storedSql(), 'SELECT 1 AS baseline;', 'failed writes must preserve the last saved draft');
  await page.waitForFunction(() => window.__draftSaveTest.errorNotifications === 1);
  const latest = "SELECT 'latest unsaved version' AS important_note;";
  await editor.fill(latest);
  // Wait beyond the editor save debounce before checking repeated-failure feedback.
  await page.waitForTimeout(500);
  await page.locator('#retryDraftSave').click();
  assert.equal(await page.evaluate(() => window.__draftSaveTest.errorNotifications), 1);
  assert.equal(await page.locator('#draftSaveStatus').getAttribute('data-state'), 'error');

  await page.locator('#themeButton').click();
  await page.locator('[data-theme-option="dark"]').click();
  await page.screenshot({ path: resolve(evidence, 'dark-1060-failure.png'), fullPage: true });
  await page.locator('[data-hide-pane="connections"]').click();
  await page.waitForFunction(() => document.getElementById('connectionsPane').inert);
  assert.equal(await page.locator('#retryDraftSave').isVisible(), true, 'the retry action must survive a collapsed sidebar');
  await page.locator('#themeButton').click();
  await page.locator('[data-theme-option="light"]').click();
  const button = await page.locator('#retryDraftSave').boundingBox();
  assert.ok(button && button.x >= 0 && button.x + button.width <= 1060, 'failure action must fit the compact header');
  await page.screenshot({ path: resolve(evidence, 'light-1060-collapsed-failure.png'), fullPage: true });

  await page.evaluate(() => window.__draftSaveTest.restore());
  await page.locator('#retryDraftSave').click();
  await page.waitForFunction(() => document.getElementById('draftSaveStatus').dataset.state === 'saved');
  assert.equal(await page.locator('#retryDraftSave').isVisible(), false);
  assert.equal(await storedSql(), latest, 'retry must write the latest live draft');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await editor.innerText(), latest, 'saved SQL must survive a reload');
  assert.deepEqual(failures, []);
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ passed: true, checks: ['initial state', 'successful save', 'quota failure', 'prior content preserved', 'latest draft preserved', 'deduplicated notifications', 'retry with collapsed sidebar', 'dark and light at 1060px', 'recovery and reload'], screenshots: 2 }, null, 2));
  console.log('PASS: draft save states, quota failure, deduplicated notifications, collapsed-sidebar retry, recovery, reload and compact themes.');
} finally {
  await context.close();
  await browser.close();
  await new Promise(done => server.close(done));
}
