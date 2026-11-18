import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, revealObject } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/result-toolbar');
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
let failPage = false;
let holdDetails = false;
let releaseDetails;
let failDetails = false;
let structureRevision = 0;
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || '/').split('?')[0]).slice(1) || 'index.html');
  if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction('__FIXTURE_INVOKE__', async (command, args) => {
  if (failPage && ['execute_query', 'execute_mutation'].includes(command) && /OFFSET 1000/.test(args?.request?.sql || '')) throw new Error('fixture page failed');
  const output = await fixture.invoke(command, args);
  if (command === 'get_object_details') {
    if (holdDetails) await new Promise(resolve => { releaseDetails = resolve; });
    if (failDetails) throw new Error('fixture structure refresh failed');
    return { ...output, definition: output.definition.repeat(120) + structureRevision };
  }
  return output;
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const label = text => page.waitForFunction(text => document.querySelector('#pageLabel').textContent === text, text);
const noOverflow = async () => {
  const measurements = await page.evaluate(() => ['.result-heading', '#resultFooter', '#resultSelection', '#tableToolbar'].map(selector => {
    const element = document.querySelector(selector);
    if (element.hidden) return { selector, hidden: true };
    const rect = element.getBoundingClientRect();
    const clipped = [...element.querySelectorAll('button,input')].filter(child => child.getClientRects().length).filter(child => {
      const box = child.getBoundingClientRect();
      return box.left < rect.left - 1 || box.right > rect.right + 1 || box.top < rect.top - 1 || box.bottom > rect.bottom + 1;
    }).map(child => child.id);
    return { selector, width: element.clientWidth, scrollWidth: element.scrollWidth, bottom: rect.bottom, viewportHeight: window.innerHeight, clipped };
  }));
  for (const item of measurements.filter(item => !item.hidden)) {
    assert.ok(item.scrollWidth <= item.width + 1, JSON.stringify(item));
    assert.deepEqual(item.clipped, [], JSON.stringify(item));
    assert.ok(item.bottom <= item.viewportHeight, JSON.stringify(item));
  }
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('.tree-database[data-database="app"] > summary [data-tree-toggle]').click();
  await page.locator('.tree-schema[data-schema="public"] > summary [data-tree-toggle]').click();
  await revealObject(page.locator('[data-object-id="public.orders"] .object-main'));
  await page.locator('[data-object-id="public.orders"] .object-main').dblclick();
  await label('第 1 页');
  await page.locator('#resultGrid .db-grid-cell').first().waitFor();
  assert.ok(await page.locator('#resultSelection').isHidden());
  assert.ok(await page.locator('#pageJumpPanel').isHidden());
  await page.locator('#nextPage').click();
  await label('第 2 页');
  assert.ok(await page.locator('#nextPage').isDisabled());
  await page.locator('#pageJumpToggle').click();
  await page.locator('#pageJumpInput').fill('1');
  await page.locator('#pageJumpInput').press('Enter');
  await label('第 1 页');
  assert.ok(await page.locator('#pageJumpPanel').isHidden());
  await page.locator('#pageJumpToggle').click();
  await page.locator('#pageJumpInput').fill('0');
  await page.locator('#pageJumpButton').click();
  assert.equal(await page.locator('#pageLabel').innerText(), '第 1 页');
  assert.ok(await page.locator('#pageJumpPanel').isVisible());
  await page.locator('#pageJumpInput').press('Escape');
  assert.ok(await page.locator('#pageJumpPanel').isHidden());
  assert.equal(await page.locator('#pageJumpToggle').getAttribute('aria-expanded'), 'false');
  failPage = true;
  await page.locator('#pageJumpToggle').click();
  await page.locator('#pageJumpInput').fill('3');
  await page.locator('#pageJumpButton').click();
  await page.waitForFunction(() => document.querySelector('#resultMeta').classList.contains('error'));
  await label('第 1 页');
  assert.ok(await page.locator('#resultGrid').isVisible());
  failPage = false;
  await page.locator('#refreshTableData').click();
  await page.waitForFunction(() => !document.querySelector('#resultMeta').classList.contains('error'));
  await page.locator('#resultFilter').fill('value-12');
  await page.waitForFunction(() => document.querySelector('#resultCount').textContent === '11/500');
  await page.locator('#resultMore').click();
  await page.locator('#copyResults').click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clipboard.includes('value-12'));
  assert.ok(!clipboard.includes('value-13'));
  for (const [triggerId, menuId] of [['resultMore', 'resultMoreMenu'], ['dataImportButton', 'dataImportMenu']]) {
    const trigger = page.locator(`#${triggerId}`), menu = page.locator(`#${menuId}`);
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await menu.evaluate(node => node.contains(document.activeElement)), false, 'mouse opening must not focus a menu item');
    const first = menu.locator('button:not(:disabled)').first();
    assert.equal(await first.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.keyboard.press('ArrowDown');
    assert.equal(await first.evaluate(node => node === document.activeElement), true, 'keyboard navigation should focus the first item');
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape should restore trigger focus');
    await trigger.click();
    await trigger.evaluate(node => node.blur()); // macOS WebViews may leave buttons unfocused after a mouse click.
    await page.keyboard.press('ArrowDown');
    assert.equal(await first.evaluate(node => node === document.activeElement), true, 'keyboard must reach a mouse-opened menu even when the trigger did not take focus');
    await page.keyboard.press('Escape');
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await first.evaluate(node => node === document.activeElement), true, 'keyboard opening should focus the first item');
    await page.keyboard.press('Escape');
  }
  await page.locator('#resultMore').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#resultMore').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'exportResults');
  await page.keyboard.press('Enter');
  const saved = fixture.callsFor('save_text_file').at(-1);
  assert.ok(saved.args.contents.includes('value-12'));
  assert.ok(!saved.args.contents.includes('value-13'));
  await page.locator('#resultMore').click();
  await page.locator('#tableToolbarTitle').click();
  assert.ok(await page.locator('#resultMoreMenu').isHidden());
  await page.locator('#resultFilter').fill('');
  const gridBounds = () => page.locator('#resultGrid').boundingBox();
  const unselectedBounds = await gridBounds();
  await page.locator('[data-select-row="0"]').check();
  await page.locator('#resultSelection').waitFor();
  assert.equal(await page.locator('#selectionCount').innerText(), '已选 1/500 行');
  assert.deepEqual(await gridBounds(), unselectedBounds);
  await page.locator('[data-select-row="1"]').check();
  assert.equal(await page.locator('#selectionCount').innerText(), '已选 2/500 行');
  assert.ok(await page.locator('#editRow').isDisabled());
  assert.deepEqual(await gridBounds(), unselectedBounds);
  await page.locator('[data-select-row="1"]').uncheck();
  await page.locator('[data-select-row="0"]').uncheck();
  assert.ok(await page.locator('#resultSelection').isHidden());
  assert.deepEqual(await gridBounds(), unselectedBounds);
  await page.locator('[data-select-row="0"]').check();
  await page.locator('#editRow').click();
  await page.locator('#mutationModal').waitFor();
  await page.locator('#cancelMutation').click();
  await page.locator('#deleteRows').click();
  await page.locator('#mutationModal').waitFor();
  await page.locator('#cancelMutation').click();
  for (const theme of ['light', 'dark']) {
    await page.locator('#themeButton').click();
    await page.locator(`[data-theme-option="${theme}"]`).click();
    for (const width of [1440, 1060]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 680 });
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      await noOverflow();
      await page.screenshot({ path: resolve(evidence, `${theme}-${width}.png`) });
    }
  }
  await page.locator('[data-select-row="0"]').uncheck();
  assert.ok(await page.locator('#resultSelection').isHidden());
  const dataTabId = await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator('#structureTab').click();
  await page.locator('#structurePanel').getByRole('tab', { name: '定义' }).click();
  assert.ok(await page.locator('#pageControls').isHidden());
  await page.evaluate(() => {
    window.__structureHeading = document.querySelector('#structurePanel h2');
    const panel = document.querySelector('#structurePanel');
    panel.scrollTop = 300;
    window.__structureRefreshAnimations = 0;
    const animate = panel.animate.bind(panel);
    panel.animate = (...args) => { window.__structureRefreshAnimations++; return animate(...args); };
  });
  holdDetails = true;
  await page.locator('#refreshTableData').click();
  await page.waitForFunction(() => document.querySelector('#structurePanel').getAttribute('aria-busy') === 'true');
  assert.ok(await page.evaluate(() => window.__structureHeading.isConnected));
  assert.equal(await page.locator('.structure-refresh-status').textContent(), '');
  assert.ok(await page.locator('#refreshTableData').isDisabled());
  const detailRequests = fixture.callsFor('get_object_details').length;
  assert.equal(fixture.callsFor('get_object_details').length, detailRequests);
  assert.equal(await page.evaluate(() => window.__structureRefreshAnimations), 1);
  await page.evaluate(() => { document.querySelector('#structurePanel').scrollTop = 420; });
  holdDetails = false; releaseDetails();
  await page.waitForFunction(() => document.querySelector('#structurePanel').getAttribute('aria-busy') === 'false');
  assert.ok(await page.evaluate(() => window.__structureHeading === document.querySelector('#structurePanel h2')));
  assert.equal(await page.locator('#toast').textContent(), '已刷新');
  assert.equal(await page.locator('#structurePanel').evaluate(panel => panel.scrollTop), 420);
  await page.locator('#structurePanel').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
  assert.equal(await page.locator('#structurePanel').evaluate(panel => getComputedStyle(panel).opacity), '1');
  failDetails = true;
  await page.locator('#refreshTableData').click();
  await page.waitForFunction(() => document.querySelector('.structure-refresh-status')?.textContent.includes('刷新失败'));
  assert.ok(await page.evaluate(() => window.__structureHeading.isConnected));
  failDetails = false; structureRevision++;
  const queriesBeforeRefresh = fixture.callsFor('execute_query').length;
  await page.locator('#refreshTableData').click();
  await page.waitForFunction(() => !window.__structureHeading.isConnected);
  assert.equal(fixture.callsFor('execute_query').length, queriesBeforeRefresh);
  assert.equal(await page.locator('#structurePanel').evaluate(panel => panel.scrollTop), 420);
  await page.locator(`[data-tab-id="${dataTabId}"] .tab-select`).click();
  await label('第 1 页');
  await page.locator('#newRow').click();
  await page.locator('#mutationModal').waitFor();
  await page.locator('#cancelMutation').click();
  assert.deepEqual(errors, []);
  console.log('PASS: toolbar/footer fit light and dark themes at 1440/1060px; paging/jump/failure retention, filtered copy/export, keyboard/outside dismissal, contextual edit/delete, insert, structure/data navigation, structure refresh DOM reuse, failure retention, changed metadata and scroll preservation.');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
