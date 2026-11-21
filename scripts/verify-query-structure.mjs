import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Query output and dedicated table structure use the browser fixture.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const file = resolve(dist, (req.url || "/").split("?")[0].slice(1) || "index.html");
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction("__FIXTURE_INVOKE__", (command, args) => fixture.invoke(command, args));
const page = await context.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const editor = page.locator("#sqlEditor .cm-content");
const quickOpen = page.locator("dialog.object-quick-open");
const resultTabs = async () => (await page.locator(".result-tabs .result-tab:visible").allInnerTexts()).map((text) => text.replace(/\s.*$/, ""));
const editorMenuItem = async (name) => {
  await editor.click({ button: "right" });
  await page.locator(".app-context-menu").getByRole("menuitem", { name, exact: true }).click();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#addQueryTab").click();
  await page.locator("#runQuery").waitFor();
  await page.waitForFunction(() => !document.querySelector("#runQuery").disabled);
  const queryId = await page.locator(".query-tab.active").getAttribute("data-tab-id");

  const structurePanel = page.locator("#structurePanel");
  const switchToQuery = () => page.locator(`[data-tab-id='${queryId}'] .tab-select`).click();
  assert.deepEqual(await resultTabs(), []);

  await editor.fill("SELECT * FROM orders WHERE id > 1");
  await page.locator("#runQuery").click();
  await page.locator("#resultGrid").waitFor();
  assert.deepEqual(await resultTabs(), ["数据", "摘要"]);
  assert.ok(await structurePanel.isHidden());
  assert.ok(await page.locator("#structureTab").isHidden());
  await page.locator("#messageTab").click();
  assert.match(await page.locator("#executionSummary").innerText(), /成功/);

  await editorMenuItem("查看引用表的结构");
  await structurePanel.getByRole("tab", { name: "字段" }).waitFor();
  const structureId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  assert.notEqual(structureId, queryId);
  assert.equal(await structurePanel.locator(".structure-title-name").innerText(), "public.orders");
  assert.deepEqual(await resultTabs(), []);
  assert.ok(await page.locator("#resultFooter").isHidden());
  assert.ok(await page.locator("#resultGrid").isHidden());
  assert.ok(await page.locator("#messagePanel").isHidden());
  assert.ok(await quickOpen.isHidden());
  const categories = structurePanel.getByRole("tab");
  assert.deepEqual(await categories.allInnerTexts(), ["字段", "索引", "约束", "定义"]);
  assert.match(await structurePanel.getByRole("tabpanel").innerText(), /id[\s\S]*integer[\s\S]*status[\s\S]*text/);
  await categories.first().press("ArrowRight");
  assert.equal(await structurePanel.getByRole("tab", { selected: true }).innerText(), "索引");
  assert.ok(await structurePanel.getByRole("tabpanel").getByRole("columnheader", { name: "属性" }).isVisible());

  await switchToQuery();
  assert.equal(await editor.innerText(), "SELECT * FROM orders WHERE id > 1");
  assert.ok(await page.locator("#messagePanel").isVisible());
  assert.deepEqual(await resultTabs(), ["数据", "摘要"]);
  await editorMenuItem("查看引用表的结构");
  assert.equal(await page.locator(".query-tab.active").getAttribute("data-tab-id"), structureId);
  assert.equal(await structurePanel.getByRole("tab", { selected: true }).innerText(), "索引");

  await switchToQuery();
  const saved = await page.evaluate(id => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find(tab => tab.id === id), queryId);
  assert.equal(saved.browse, null);
  assert.equal(saved.openedObject, null);
  assert.equal(saved.openedObjectView, null);

  // Several tables: quick open takes over, and says why.
  await editor.fill("SELECT * FROM orders JOIN exact_100 ON true");
  await page.locator("#openCommands").click();
  await page.getByRole("combobox", { name: "搜索快速操作" }).fill("引用的表");
  await page.keyboard.press("Enter");
  await quickOpen.waitFor({ state: "visible" });
  assert.match(await page.locator("#toast").innerText(), /引用了 2 张表/);
  await page.keyboard.press("Escape");
  await quickOpen.waitFor({ state: "hidden" });

  // No table at all: also quick open, with nothing claimed.
  await editor.fill("SELECT 1");
  await editorMenuItem("查看引用表的结构");
  await quickOpen.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, []);
  console.log("PASS: query output shows data and summaries; the editor menu and command palette open dedicated, categorized structure.");
} finally {
  await browser.close();
  server.close();
}
