import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/improvements");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "mysql-local", name: "MySQL 开发库", driver: "mysql", host: "mysql.fixture", port: 3306, database: "warehouse", user: "fixture" });
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
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();

const expect = (ok, message) => { if (!ok) throw new Error(message); };
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#connectionMode").getByText("已连接", { exact: true }).waitFor();
  await page.locator("#addQueryTab").click();
  const editor = page.locator("#sqlEditor .cm-content");
  async function typeSql(text) {
    await editor.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText(text);
    await page.keyboard.press("Control+Space");
  }
  await typeSql("SELECT * FROM orders WHERE st");
  await page.locator(".cm-completionLabel").filter({ hasText: /^status$/ }).waitFor();
  expect(fixture.callsFor("get_schema_objects").length > 0, "completion did not load the catalog without expanding the tree");
  await page.keyboard.press("Escape");
  for (const text of ["SELECT * FROM public.orders o WHERE o.st", 'SELECT * FROM "public"."orders" o WHERE o.st']) {
    await typeSql(text);
    await page.locator(".cm-completionLabel").filter({ hasText: /^status$/ }).waitFor();
    await page.keyboard.press("Escape");
  }
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("SELECT * FROM orders WHERE st", { delay: 15 });
  await page.locator(".cm-completionLabel").filter({ hasText: /^status$/ }).waitFor();
  await page.screenshot({ path: resolve(evidence, "field-completion.png") });
  await page.keyboard.press("Escape");
  const before = fixture.callsFor("get_schema_objects").length;
  await typeSql("SELECT * FROM orders WHERE sta");
  await page.locator(".cm-completionLabel").filter({ hasText: /^status$/ }).waitFor();
  expect(fixture.callsFor("get_schema_objects").length === before, "cached completion reloaded schema objects");
  await page.keyboard.press("Escape");
  await page.locator(".tree-database[data-database='app'] > summary [data-tree-toggle]").click();
  await page.locator(".tree-schema[data-database='app'][data-schema='analytics']").waitFor();
  await page.locator("#objectSearch").fill("event_name");
  await page.locator("[data-object-id='analytics.events'] .object-main").waitFor();
  expect(await page.locator("[data-object-id='analytics.events'] .object-main").isVisible(), "field match stayed collapsed");
  expect(!(await page.locator("[data-object-id='public.orders']").count()), "field search included unmatched tables");
  await page.locator("#objectSearch").fill("");
  expect(await page.locator(".header-actions #toggleConnections, .header-actions #toggleObjects, .header-actions #resetLayout").count() === 0, "panel controls remain in the far header");
  const draftBeforeHide = await editor.innerText();
  for (const kind of ["connections", "objects"]) {
    const pane = page.locator(`#${kind}Pane`);
    const toggle = page.locator(kind === "connections" ? "#toggleConnections" : "#toggleObjects");
    const before = await pane.boundingBox();
    await page.locator(`[data-hide-pane='${kind}']`).click();
    expect(await pane.isHidden(), `${kind} failed to hide`);
    expect(await toggle.getAttribute("aria-expanded") === "false", `${kind} toggle state stale`);
    expect(await pane.evaluate((node) => node.inert), `${kind} hidden pane still focusable`);
    const rail = await page.locator(`#${kind}Rail`).boundingBox();
    expect(rail.width === 32 && Math.abs(rail.x - before.x) <= 1, `${kind} restore tab is not at the pane edge`);
    expect(await toggle.evaluate((node) => document.activeElement === node), `${kind} focus lost when hiding pane`);
    await page.keyboard.press("Enter");
    expect(await pane.isVisible(), `${kind} failed to restore`);
    expect(await page.locator(`[data-hide-pane='${kind}']`).evaluate((node) => document.activeElement === node), `${kind} restore did not move focus into pane`);
    expect(await toggle.isHidden(), `${kind} restore tab remains beside expanded pane`);
    expect(Math.abs((await pane.boundingBox()).width - before.width) <= 1, `${kind} restore lost preferred width`);
  }
  expect(await editor.innerText() === draftBeforeHide, "hiding sidebars changed SQL draft");
  await page.locator("[data-hide-pane='connections']").click();
  await page.locator("[data-hide-pane='objects']").click();
  for (const theme of ["dark", "light"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    await page.screenshot({ path: resolve(evidence, `side-tabs-${theme}.png`) });
  }
  await page.reload({ waitUntil: "networkidle" });
  expect(await page.locator("#connectionsPane").isHidden() && await page.locator("#objectsPane").isHidden(), "hidden panes not persisted");
  expect(await page.locator("#toggleConnections").isVisible() && await page.locator("#toggleObjects").isVisible(), "collapsed layout has no local restore controls");
  await page.keyboard.press("Meta+Shift+k");
  expect(await page.locator("#objectsPane").isVisible(), "search shortcut did not restore objects");
  expect(await page.locator("#objectSearch").evaluate((node) => document.activeElement === node), "search shortcut failed to focus search");
  expect(await page.locator("#connectionsPane").isHidden(), "search shortcut changed the other pane");
  await page.screenshot({ path: resolve(evidence, "side-tabs-objects-open.png") });
  await page.locator("#resetLayout").click();
  await page.setViewportSize({ width: 700, height: 600 });
  await page.locator("#toggleConnections").click();
  expect(await page.locator("#connectionsPane").isVisible(), "compact window did not show connections");
  expect(await page.locator("#objectsPane").isHidden(), "compact window clipped both panes");
  await page.locator("#toggleObjects").click();
  expect(await page.locator("#objectsPane").isVisible(), "compact window did not show objects");
  expect(await page.locator("#connectionsPane").isHidden(), "compact window did not switch panes");
  const main = await page.locator("#mainPane").boundingBox();
  expect(main.width >= 400, "restore rail clipped compact editor");
  await page.screenshot({ path: resolve(evidence, "side-tabs-compact.png") });
  expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth), "compact header overflowed");
  expect(!failures.length, failures.join("\n"));
  console.log("PASS: local side tabs, keyboard focus, preferred widths, persistence, search shortcut, compact layout and existing completion/search behavior.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
