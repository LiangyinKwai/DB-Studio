import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/visibility-focus');
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const server = createServer((request, response) => {
  const relative = decodeURIComponent((request.url || '/').split('?')[0]).replace(/^\//, '') || 'index.html';
  const file = resolve(dist, relative);
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
const checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__DB_STUDIO_FIXTURE__ = true;
    window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  });
  await context.exposeFunction('__FIXTURE_INVOKE__', fixture.invoke);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator("[data-connection-id='conn-dev']").click();
  const database = page.locator(".tree-database[data-database='app']");
  await database.waitFor();
  if (await database.getAttribute('open') === null) await database.locator(':scope > summary > [data-tree-toggle]').click();
  await database.locator('.tree-schema').first().waitFor();

  for (const theme of ['dark', 'light']) {
    await page.locator('#themeButton').click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    for (const kind of ['database', 'schema']) {
      const databasePicker = kind === 'database';
      const modal = databasePicker ? '#databaseModal' : '#schemaModal';
      const input = databasePicker ? '#databaseSearch' : '#schemaSearch';
      const close = databasePicker ? '#closeDatabasePicker' : '#closeSchemaPicker';
      await page.locator(databasePicker ? '[data-display-databases]' : "[data-display-schemas='app']").click();
      await page.locator(modal).waitFor();
      await page.mouse.move(0, 0);
      assert.equal(await page.locator(input).evaluate(node => node === document.activeElement), true, `${theme}/${kind}: mouse opening must focus search`);
      assert.equal(await page.locator(close).evaluate(node => node.matches(':focus-visible')), false, `${theme}/${kind}: close button should not receive initial focus ring`);
      await page.screenshot({ path: resolve(evidence, `${theme}-${kind}-initial.png`) });

      // Shift+Tab from search reaches the header close button. Its keyboard
      // indicator must remain present; suppressing outlines would fail here.
      await page.keyboard.press('Shift+Tab');
      const keyboard = await page.locator(close).evaluate(node => {
        const style = getComputedStyle(node);
        return { active: node === document.activeElement, visible: node.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle };
      });
      assert.equal(keyboard.active, true, `${theme}/${kind}: Shift+Tab should reach close`);
      assert.equal(keyboard.visible, true, `${theme}/${kind}: close needs keyboard focus-visible`);
      assert.ok(keyboard.outlineWidth > 0 && keyboard.outlineStyle !== 'none', `${theme}/${kind}: close needs a visible keyboard outline`);
      await page.screenshot({ path: resolve(evidence, `${theme}-${kind}-keyboard.png`) });
      await page.keyboard.press('Enter');
      assert.equal(await page.locator(modal).isVisible(), false, `${theme}/${kind}: keyboard close should dismiss picker`);
      checks.push({ theme, kind, keyboard });
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Visibility picker focus: ${checks.length} theme/picker combinations passed`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
