import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/execution");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const server = createServer((req, res) => {
  const relative = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//, "") || "index.html";
  const file = resolve(dist, relative);
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
let failExecution = false;
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command, args);
  if (command === "execute_mutation") {
    if (failExecution) throw new Error("第 2 条 SQL 执行失败：fixture missing column");
    return { ...result, statement_count: 2 };
  }
  return result;
});
await context.addInitScript(() => { window.confirm = () => { throw new Error("browser confirmation must not be used"); }; });
const page = await context.newPage();

const expect = (ok, message) => { if (!ok) throw new Error(message); };
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const sql = `ALTER TABLE upsell.upsell_cart_modules
  ADD COLUMN IF NOT EXISTS enable_celebration BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN upsell.upsell_cart_modules.enable_celebration IS
  '阶梯奖励解锁特效开关; 仅 TIERED_REWARDS 使用，默认关闭，不影响奖励计算';`;
const modal = page.locator("#confirmActionModal");
const editor = page.locator("#sqlEditor .cm-content");
const accept = page.locator("#confirmActionAccept");
const waitForDone = () => page.locator("#toast").getByText("查询完成", { exact: true }).waitFor();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  await page.locator(".tree-database[data-database='app_reporting'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await editor.fill(sql);
  for (const theme of ["light", "dark"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    const before = fixture.callsFor("execute_mutation").length;
    await page.locator("#runQuery").click();
    await modal.waitFor();
    expect((await page.locator("#confirmActionMessage").innerText()).includes("app_reporting"), "confirmation lost database");
    expect((await page.locator("#confirmActionMessage").innerText()).includes("2 条 SQL"), "batch statement count incorrect");
    expect(await modal.locator("[data-confirm-detail]").innerText() === sql, "SQL preview differs from execution");
    expect(fixture.callsFor("execute_mutation").length === before, "executed before confirmation");
    await page.screenshot({ path: resolve(evidence, `execution-confirm-${theme}.png`) });
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    expect(fixture.callsFor("execute_mutation").length === before, "Escape still executed SQL");
  }
  await editor.click();
  await page.keyboard.press("Meta+Enter");
  await modal.waitFor();
  const before = fixture.callsFor("execute_mutation").length;
  await page.evaluate(() => document.querySelector("#runQuery").click());
  await accept.click();
  await waitForDone();
  expect(fixture.callsFor("execute_mutation").length === before + 1, "duplicate execution while confirmation was pending");
  const request = fixture.callsFor("execute_mutation").at(-1).args.request;
  expect(request.database === "app_reporting" && request.sql === sql, "batch lost SQL/database binding");
  await page.locator("#messageTab").click();
  expect((await page.locator("#messagePanel").innerText()).includes("2 条语句"), "batch success count missing");
  failExecution = true;
  await page.locator("#runQuery").click();
  await accept.click();
  await page.locator("#messagePanel").getByText("第 2 条 SQL 执行失败", { exact: false }).waitFor();
  expect(await page.locator("#runQuery").isEnabled(), "failed query left execution disabled");
  failExecution = false;
  await editor.fill("SELECT 1; ALTER TABLE app.orders ADD COLUMN flag boolean;");
  await page.locator("#runQuery").click();
  await modal.waitFor();
  await accept.click();
  await waitForDone();
  expect(fixture.callsFor("execute_mutation").at(-1).args.request.sql.startsWith("SELECT 1; ALTER"), "mixed script incorrectly sent to read-only path");

  // Selection remains authoritative: execute only the selected SELECT.
  await editor.fill("SELECT 42;\nALTER TABLE app.orders ADD COLUMN flag boolean;");
  await page.keyboard.press("Meta+Home");
  await page.keyboard.press("Shift+End");
  await page.locator("#runQuery").click();
  await waitForDone();
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === "SELECT 42;", "selected SQL execution included unselected mutation");
  expect(await modal.isHidden(), "read-only selection unexpectedly prompted");
  expect(errors.length === 0, errors.join("\n"));
  console.log("PASS: WebView-compatible confirmation, batch routing, SQL/database snapshot, keyboard, duplicate guard, Escape cancellation, selected SQL and error recovery.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
