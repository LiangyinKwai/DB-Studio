import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/query-workspace");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const file = resolve(dist, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//u, "") || "index.html");
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: [] });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();
const failures = [];
page.on("pageerror", error => failures.push(error.message));
page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
const editor = page.locator("#sqlEditor .cm-content");
const libraryKey = "db-studio.query-library.v1";
const legacyFavorites = JSON.stringify([{ title: "旧收藏", sql: "SELECT 17;", connectionId: "conn-dev", database: "app" }]);
const themeKey = "db-studio.theme.v1";
const selectTheme = async theme => {
  await page.locator("#themeButton").click();
  await page.locator(`[data-theme-option='${theme}']`).click();
};
const expectTheme = (appearance, preference) => page.waitForFunction(
  ({ appearance, preference, themeKey }) => document.body.dataset.theme === appearance
    && getComputedStyle(document.body).colorScheme === appearance
    && document.querySelector('#themeMenu [aria-checked="true"]')?.dataset.themeOption === preference
    && localStorage.getItem(themeKey) === preference,
  { appearance, preference, themeKey },
);
try {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: libraryKey, value: legacyFavorites });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  assert.deepEqual(await page.locator('#themeMenu [data-theme-option]').evaluateAll(options => options.map(option => option.dataset.themeOption)), ["light", "dark", "system"]);
  await expectTheme("light", "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme("dark", "system");
  await selectTheme("light");
  await expectTheme("light", "light");
  await page.reload({ waitUntil: "networkidle" });
  await expectTheme("light", "light");
  await selectTheme("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme("dark", "dark");
  await page.evaluate(key => localStorage.setItem(key, "forest"), themeKey);
  await page.reload({ waitUntil: "networkidle" });
  await expectTheme("dark", "dark");
  await page.locator("#openCommands").click();
  await page.getByRole("combobox", { name: "搜索快速操作" }).fill("跟随系统");
  await page.getByRole("option", { name: /跟随系统外观/ }).click();
  await expectTheme("light", "system");
  await page.reload({ waitUntil: "networkidle" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme("dark", "system");

  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#addQueryTab").click();
  const historyToggle = page.locator("#toggleHistory");
  assert.equal(await historyToggle.getAttribute("aria-expanded"), "false");
  for (const selector of ["#historySearchBox", "#recentQueries", "#clearHistory"]) assert.ok(await page.locator(selector).isHidden());
  await editor.fill("SELECT 19;");
  await page.locator("#runQuery").click();
  await page.locator('#recentQueries [data-history-index]').filter({ hasText: 'SELECT 19' }).waitFor({ state: "attached" });
  assert.ok(await page.locator("#recentQueries").isHidden());
  await historyToggle.press("Enter");
  assert.equal(await historyToggle.getAttribute("aria-expanded"), "true");
  assert.ok(await page.locator("#historySearchBox").isVisible());
  const splitter = page.locator("#historySplitter");
  const historyPane = page.locator("#historyPane");
  const start = await splitter.boundingBox();
  const connections = await page.locator("#connectionList").boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + 70, { steps: 10 });
  await page.mouse.up();
  const resized = await historyPane.boundingBox();
  assert.equal(resized.y, start.y + 71);
  assert.equal((await page.locator("#connectionList").boundingBox()).height, connections.height + 70);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("db-studio.layout.v1")).historyHeight), resized.height);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await historyToggle.getAttribute("aria-expanded"), "true");
  assert.equal((await historyPane.boundingBox()).y, resized.y);
  await page.locator("#historySearch").fill("SELECT 19");
  await page.locator("#recentQueries").getByRole("button", { name: /SELECT 19/ }).click();
  await historyToggle.click();
  assert.ok(await page.locator("#recentQueries").isHidden());
  await historyToggle.click();
  assert.equal((await historyPane.boundingBox()).height, resized.height);
  await splitter.press("End");
  assert.ok(await page.locator("#recentQueries").isHidden());
  const collapsed = await splitter.boundingBox();
  await page.mouse.move(collapsed.x + collapsed.width / 2, collapsed.y);
  await page.mouse.down();
  await page.mouse.move(collapsed.x + collapsed.width / 2, collapsed.y - 150, { steps: 12 });
  await page.mouse.up();
  assert.equal(await historyToggle.getAttribute("aria-expanded"), "true");
  assert.equal((await historyPane.boundingBox()).height, 198);
  await historyToggle.click();
  assert.equal(await editor.innerText(), "SELECT 19;");
  assert.equal(await page.locator(".query-tab").count(), 2);
  assert.equal(await page.locator("#saveQueryFavorite, #queryLibraryPanel, #showQueryLibrary").count(), 0);
  await page.locator("#openCommands").click();
  const commandSearch = page.getByRole("combobox", { name: "搜索快速操作" });
  await commandSearch.fill("收藏");
  assert.equal(await page.locator(".command-palette-option").count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), libraryKey), legacyFavorites);

  // Restore a complete workspace beyond the previous 24-tab boundary.
  await page.addInitScript(() => {
    localStorage.setItem("db-studio.workspace-tabs.v2", JSON.stringify(Array.from({ length: 35 }, (_, index) => ({
      id: `restore-${index}`, title: `草稿 ${index}`, sql: `SELECT ${index};`, connectionId: "conn-dev", database: "app", schema: "public", tableView: false,
    }))));
    localStorage.setItem("db-studio.workspace-tabs.v2.active", "restore-34");
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await historyToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".query-tab").count(), 35);
  assert.equal(await editor.innerText(), "SELECT 34;");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).length), 35);
  // Eight executed tabs must release the oldest inactive results, keeping SQL.
  for (let index = 0; index < 8; index += 1) {
    await page.locator(`.tab-select[data-tab-id='restore-${index}']`).click();
    await page.locator("#runQuery").click();
    await page.waitForFunction(() => document.getElementById("resultCount").textContent === "2" && document.getElementById("stopQuery").disabled);
  }
  await page.locator(".tab-select[data-tab-id='restore-0']").click();
  assert.match(await page.locator("#messagePanel").innerText(), /已释放.*结果内存/u);
  assert.equal(await editor.innerText(), "SELECT 0;");
  await page.locator(".tab-select[data-tab-id='restore-7']").click();
  assert.equal(await page.locator("#resultCount").innerText(), "2");
  for (const theme of ["dark", "light"]) {
    await selectTheme(theme);
    await page.screenshot({ path: resolve(evidence, `${theme}.png`) });
  }
  assert.deepEqual(failures, []);
  writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ passed: true, restoredTabs: 35, screenshots: 2 }, null, 2));
  console.log("PASS: system appearance switching, manual overrides, theme migration, recent history, 35-tab restoration and result memory release.");
} finally {
  await context.close();
  await browser.close();
  await new Promise(done => server.close(done));
}
