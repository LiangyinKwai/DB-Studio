import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/query-library");
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();
const failures = [];
const downloads = [];
page.on("pageerror", error => failures.push(error.message));
page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
page.on("download", download => downloads.push(download));
const libraryKey = "db-studio.query-library.v1";
const editor = page.locator("#sqlEditor .cm-content");
const dialog = page.locator(".query-library-dialog");
const savedEntries = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || "[]"), libraryKey);
const queryCalls = () => fixture.callsFor("execute_query").length + fixture.callsFor("execute_mutation").length;
const upload = data => page.locator("#queryLibraryFile").setInputFiles({ name: "queries.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#addQueryTab").click();
  await editor.fill("SELECT '001' AS id;\nSELECT '保留原目标' AS note;");
  assert.equal(await page.locator("#saveQueryFavorite").isEnabled(), true, "typing must enable favorite action");
  await page.locator("#saveQueryFavorite").click();
  await dialog.locator("input[name=title]").fill("订单核对 <安全文本>");
  await dialog.getByRole("button", { name: "保存收藏", exact: true }).click();
  assert.equal(await page.locator("#queryLibraryPanel").isVisible(), true);
  assert.equal((await savedEntries()).length, 1);
  const original = (await savedEntries())[0];
  assert.equal(original.connectionId, "conn-dev");
  assert.equal(original.database, "app");
  assert.equal(queryCalls(), 0, "saving must never execute SQL");
  await page.locator("#saveQueryFavorite").click();
  await dialog.locator("input[name=title]").fill("常用订单");
  await dialog.getByRole("button", { name: "保存收藏", exact: true }).click();
  assert.equal((await savedEntries()).length, 1, "repeat save deduplicates");
  assert.equal((await savedEntries())[0].id, original.id);
  await page.locator("#queryLibraryList").getByRole("button", { name: "重命名 常用订单", exact: true }).click();
  await page.evaluate(key => {
    window.__originalStorageSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException("full", "QuotaExceededError");
      return window.__originalStorageSet.call(this, name, value);
    };
  }, libraryKey);
  await dialog.locator("input[name=title]").fill("不能假装保存成功");
  await dialog.getByRole("button", { name: "保存收藏", exact: true }).click();
  assert.equal(await dialog.isVisible(), true, "storage failure retains dialog");
  assert.match(await dialog.locator(".dialog-feedback").innerText(), /保存失败/u);
  assert.equal((await savedEntries())[0].title, "常用订单");
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSet; delete window.__originalStorageSet; });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator("#queryLibraryList").getByRole("button", { name: "重命名 常用订单", exact: true }).click();
  await dialog.locator("input[name=title]").fill("订单汇总");
  await dialog.getByRole("button", { name: "保存收藏", exact: true }).click();
  await page.locator("#queryLibrarySearch").fill("订单 app");
  assert.equal(await page.locator(".query-library-card").count(), 1);
  await page.locator("#queryLibrarySearch").fill("无匹配");
  assert.equal(await page.locator(".query-library-card").count(), 0);
  await page.locator("#queryLibrarySearch").fill("");
  await page.locator("[data-connection-id='conn-stage']").click();
  const beforeTabs = await page.locator(".query-tab").count();
  await page.locator(".query-library-open").click();
  assert.equal(await page.locator(".query-tab").count(), beforeTabs + 1);
  assert.equal(await editor.innerText(), original.sql);
  assert.match(await page.locator("#editorHint").innerText(), /开发库.*app/u, "favorite keeps original target after connection switch");
  assert.equal(queryCalls(), 0, "opening never executes SQL");
  await page.locator("#openCommands").click();
  await page.getByRole("combobox", { name: "搜索快速操作" }).fill("订单汇总");
  await page.locator(".command-palette-group[aria-label='查询收藏'] .command-palette-option").filter({ hasText: "订单汇总" }).click();
  assert.equal(await page.locator(".query-tab").count(), beforeTabs + 2);
  await page.locator("#exportQueryLibrary").click();
  await page.getByText("已取消导出", { exact: true }).waitFor();
  assert.equal(downloads.length, 0, "native cancellation must not trigger a browser download");
  const exported = JSON.parse(fixture.callsFor("save_text_file").at(-1).args.contents);
  assert.equal(exported.format, "db-studio-query-library");
  const invalid = { ...exported, entries: [...exported.entries, { sql: "invalid" }] };
  await upload(invalid);
  await page.locator("#toast").filter({ hasText: /导入失败/u }).waitFor();
  assert.equal((await savedEntries()).length, 1, "invalid import is atomic");
  const incoming = { ...original, id: "missing-target", title: "外部连接收藏", connectionId: "unknown-connection", database: "external_db", sql: "SELECT 'external';" };
  await upload({ ...exported, entries: [incoming] });
  await page.getByText(/导入完成 · 新增 1 项/u).waitFor();
  assert.equal((await savedEntries()).length, 2);
  await page.locator(".query-library-open").filter({ hasText: "外部连接收藏" }).click();
  await page.locator("#runQuery").click();
  await page.locator("#toast").filter({ hasText: /原连接已不可用/u }).waitFor();
  assert.equal(queryCalls(), 0, "missing favorite connection must never fall back to active connection");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#showQueryLibrary").click();
  assert.equal((await savedEntries()).length, 2);
  assert.equal(await page.locator(".query-library-open").count(), 2);
  assert.match(await editor.innerText(), /external/u, "missing connection cannot erase restored draft");
  for (const theme of ["dark", "light", "ocean", "forest", "contrast"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    await page.screenshot({ path: resolve(evidence, `${theme}.png`) });
  }
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.locator(".query-library-card").first().getByRole("button", { name: /^重命名/u }).click();
  await page.screenshot({ path: resolve(evidence, "rename-compact.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".query-library-card").first().getByRole("button", { name: /^删除收藏/u }).click();
  await page.locator("#confirmActionModal").getByRole("button", { name: "删除收藏", exact: true }).click();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).length === 1, libraryKey);
  assert.equal((await savedEntries()).length, 1);
  // Restore a complete workspace beyond the previous 24-tab boundary.
  await page.addInitScript(() => {
    localStorage.setItem("db-studio.workspace-tabs.v2", JSON.stringify(Array.from({ length: 35 }, (_, index) => ({
      id: `restore-${index}`, title: `草稿 ${index}`, sql: `SELECT ${index};`, connectionId: "conn-dev", database: "app", schema: "public", tableView: false,
    }))));
    localStorage.setItem("db-studio.workspace-tabs.v2.active", "restore-34");
  });
  await page.reload({ waitUntil: "networkidle" });
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
  assert.deepEqual(failures, []);
  writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ passed: true, restoredTabs: 35, screenshots: 6, checks: ["save", "dedupe", "storage failure", "rename", "search", "exact target", "palette", "native cancellation", "atomic import", "missing target", "persistence", "themes", "delete", "35-tab restore", "result memory release", "build assets"] }, null, 2));
  console.log("PASS: query library workflow, connection binding, import/export, persistence, themes, and 35-tab restoration.");
} finally {
  await context.close();
  await browser.close();
  await new Promise(done => server.close(done));
}
