import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidenceDir = join(root, "output", "playwright");
mkdirSync(evidenceDir, { recursive: true });

function serve(directory) {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const file = resolve(directory, relative);
    if (!file.startsWith(`${directory}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port })));
}

const fixture = createWorkspaceFixture();
const checks = [];
const failures = [];
const check = async (name, fn) => {
  process.stdout.write(`CHECK ${name} ... `);
  try { await fn(); checks.push({ name, ok: true }); console.log("ok"); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); failures.push({ name, error: error.message }); console.log(`FAIL: ${error.message}`); }
};
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const calls = (command) => fixture.callsFor(command);
const waitFor = async (predicate, label, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error(`timeout waiting for ${label}`);
};

if (!existsSync(join(dist, "index.html"))) throw new Error("dist missing; run npm run build:frontend first");
const { server, port } = await serve(dist);
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ profiles }) => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  window.__FIXTURE_PROFILES__ = profiles;
}, { profiles: fixture.profiles });
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("console", (message) => { if (message.type() === "error") console.log(`[browser error] ${message.text()}`); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.screenshot({ path: join(evidenceDir, "workspace-initial.png"), fullPage: true });
await waitFor(() => page.locator("#connectionList [data-connection-id]").count().then((count) => count === 3), "fixture connections");
expect(await page.locator(".query-tab").count() === 0, "workspace opened a default query tab");
const ensureConnection = async (id) => {
  const card = page.locator(`#connectionList [data-connection-id='${id}']`);
  if (await page.locator(`.connection-card.selected [data-connection-id='${id}']`).count() && await page.locator("#connectionMode").innerText() === "已连接") {
    return;
  }
  await card.click();
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "已连接"), `connection ${id}`);
};
const expandDatabase = async (name) => {
  const database = page.locator(`.tree-database[data-database='${name}']`);
  await waitFor(() => database.count().then((count) => count === 1), `database ${name}`);
  if (await database.getAttribute("open") === null) await database.locator("> summary > [data-tree-toggle]").click();
  await waitFor(() => database.getAttribute("open").then((value) => value !== null), `expanded database ${name}`);
  await waitFor(() => database.locator(".tree-schema").count().then((count) => count > 0), `schemas for ${name}`);
  return database;
};
const expandRedisDatabase = async (index) => {
  const database = page.locator(`.redis-database[data-redis-db='${index}']`);
  await waitFor(() => database.count().then((count) => count === 1), `Redis DB ${index}`);
  if (await database.getAttribute("open") === null) await database.locator("> summary > [data-tree-toggle]").click();
  await waitFor(() => database.getAttribute("open").then((value) => value !== null), `expanded Redis DB ${index}`);
  return database;
};
const inspectCell = async (cell) => {
  await cell.click({ button: "right" });
  await page.locator('[data-cell-action="inspect"]').click();
  await waitFor(() => page.locator("#cellModal").isVisible(), "cell details dialog");
};

await check("connection and object browser icons follow the database driver", async () => {
  const postgresIcon = await page.locator("#connectionList [data-connection-id='conn-dev'] .connection-driver-icon").innerHTML();
  const redisIcon = await page.locator("#connectionList [data-connection-id='redis-local'] .connection-driver-icon").innerHTML();
  expect(postgresIcon !== redisIcon, "PostgreSQL and Redis connection icons are identical");
  await ensureConnection("conn-dev");
  await waitFor(() => page.locator(".tree-root .driver-tree-icon").count().then((count) => count === 1), "PostgreSQL object root icon");
  const postgresRootIcon = await page.locator(".tree-root .driver-tree-icon").innerHTML();
  await waitFor(() => page.locator(".tree-database[data-database='app'] .database-icon").count().then((count) => count === 1), "PostgreSQL database icon");
  expect(await page.locator(".tree-database[data-database='app'] .database-icon").innerHTML() !== postgresRootIcon, "PostgreSQL database node still uses the driver icon");
  await ensureConnection("redis-local");
  await waitFor(() => page.locator(".redis-tree-root .driver-tree-icon").count().then((count) => count === 1), "Redis object root icon");
  const redisRootIcon = await page.locator(".redis-tree-root .driver-tree-icon").innerHTML();
  expect(postgresRootIcon !== redisRootIcon, "PostgreSQL and Redis object root icons are identical");
  await waitFor(() => page.locator(".redis-database[data-redis-db='0'] .database-icon").count().then((count) => count === 1), "Redis database icon");
  expect(await page.locator(".redis-database[data-redis-db='0'] .database-icon").innerHTML() !== redisRootIcon, "Redis database node still uses the driver icon");
});

await check("theme picker exposes readable preset themes without a color palette", async () => {
  await page.locator("#themeButton").click();
  expect(await page.locator("#themeMenu [data-theme-option]").count() === 5, "theme picker should expose five presets");
  expect(await page.locator("#themeMenu input[type='color']").count() === 0, "theme picker still exposes custom color controls");
  await page.locator("#themeMenu [data-theme-option='light']").click();
  expect(await page.locator("body").getAttribute("data-theme") === "light", "light theme did not apply");
  await page.screenshot({ path: join(evidenceDir, "theme-light.png"), fullPage: true });
  await page.locator("#themeButton").click();
  await page.locator("#themeMenu [data-theme-option='dark']").click();
  expect(await page.locator("body").getAttribute("data-theme") === "dark", "dark theme did not restore");
});

await check("Redis DB context menu replaces the browser default menu", async () => {
  await ensureConnection("redis-local");
  const db = page.locator(".redis-database[data-redis-db='0']");
  await waitFor(() => db.count().then((count) => count === 1), "Redis DB 0");
  await db.locator("> summary").click({ button: "right" });
  expect(await page.locator("#redisDatabaseContextMenu").isVisible(), "Redis DB context menu did not open");
  const labels = await page.locator("#redisDatabaseContextMenu button").allTextContents();
  expect(labels.includes("刷新当前 DB") && labels.includes("打开控制台"), "Redis DB context menu has unexpected actions");
  expect(await page.locator("#redisContextMenu").isVisible() === false, "Redis key menu opened for a DB node");
  const before = calls("list_redis_keys").length;
  await page.locator("#redisDatabaseContextMenu [data-redis-database-context-action='refresh']").click();
  await waitFor(() => calls("list_redis_keys").length > before, "Redis DB refresh");
  expect(calls("list_redis_keys").at(-1).args?.database === 0, "DB refresh used the wrong Redis database");
  await db.locator("> summary").click({ button: "right" });
  await page.locator("#redisDatabaseContextMenu [data-redis-database-context-action='console']").click();
  expect(await page.locator("#redisConsolePanel").isVisible(), "Redis console panel did not open");
  expect(await page.locator(".query-tab").count() === 0, "Redis console incorrectly opened a query tab");
  expect(await page.locator("#redisConsoleInput").evaluate((node) => getComputedStyle(node).minHeight).then((value) => Number.parseFloat(value) >= 100), "Redis console input is too short by default");
  expect(await page.locator(".redis-command-editor-shell").evaluate((node) => getComputedStyle(node).resize) === "vertical", "Redis console input is not resizable");
  expect(await page.locator("#redisConsoleInput .cm-placeholder").isVisible(), "Redis console was not empty on open");
  expect((await page.locator("#redisConsoleOutput").innerText()).includes("从一条命令开始"), "Redis console did not show its command prompt hint");
  expect(await page.locator("#redisConsoleInput").evaluate((node) => document.activeElement === node), "Redis console did not focus its command input");
  expect(await page.locator("#beginTransaction").isHidden(), "Redis query toolbar still exposes begin transaction");
  expect(await page.locator("#commitTransaction").isHidden() && await page.locator("#rollbackTransaction").isHidden(), "Redis query toolbar still exposes transaction controls");
  const beforeConsoleCommand = calls("execute_redis_command").length;
  await page.locator("#redisConsoleInput").fill("PING");
  await page.locator("#redisConsoleRun").click();
  await waitFor(() => calls("execute_redis_command").length > beforeConsoleCommand, "Redis console command");
  await waitFor(() => page.locator("#redisConsoleOutput").innerText().then((value) => value.includes("OK")), "Redis console output");
  expect(calls("execute_redis_command").at(-1).args.request.console === true, "Redis console request lost console mode");
  expect(calls("execute_redis_command").at(-1).args.request.readOnly === false, "Redis console request remained read-only");
  const beforeSelect = calls("execute_redis_command").length;
  await page.locator("#redisConsoleInput").fill("SELECT 1");
  await page.locator("#redisConsoleRun").click();
  await waitFor(() => calls("execute_redis_command").length > beforeSelect, "Redis console SELECT");
  expect(calls("execute_redis_command").at(-1).args.request.sql === "SELECT 1", "Redis console did not send SELECT");
  await waitFor(() => page.locator("#redisConsoleContext").innerText().then((value) => value.includes("DB 1")), "Redis console DB prompt update");
  const beforeKeys = calls("execute_redis_command").length;
  await page.locator("#redisConsoleInput").fill("KEYS *");
  await page.locator("#redisConsoleRun").click();
  await waitFor(() => calls("execute_redis_command").length > beforeKeys, "Redis console KEYS");
  await page.screenshot({ path: join(evidenceDir, "redis-console.png"), fullPage: true });
  await page.locator("#closeRedisConsole").click();
  await waitFor(() => page.locator("#redisConsolePanel").isVisible().then((visible) => !visible), "close Redis console");
  await page.locator("#addQueryTab").click();
  await waitFor(() => page.locator(".query-tab").count().then((count) => count === 1), "explicit new query after console");
});

await check("connection cards can disconnect and reconnect", async () => {
  await ensureConnection("conn-dev");
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "已连接"), "dev connection");
  const toggle = page.locator("[data-connection-toggle='conn-dev']");
  expect(await toggle.isEnabled(), "connection toggle is disabled for a connected card");
  expect((await toggle.getAttribute("aria-label")).includes("断开连接"), "connected card did not expose a disconnect label");
  expect(!(await toggle.innerText()).includes("×"), "connection toggle still uses a close glyph");
  await toggle.click();
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "未连接"), "disconnected connection");
  expect((await page.locator("[data-connection-toggle='conn-dev']").getAttribute("aria-label")).includes("连接"), "idle card did not expose a connect label");
  await ensureConnection("conn-dev");
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "已连接"), "reconnected connection");
  const reconnectCalls = calls("connect_connection").length;
  await page.locator("#connectionList [data-connection-id='conn-dev']").click();
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "已连接"), "instance click keeps connection");
  expect(calls("connect_connection").length === reconnectCalls, "clicking the instance unexpectedly reconnected it");
  await page.locator("[data-connection-toggle='conn-dev']").click();
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "未连接"), "icon click disconnect");
  await ensureConnection("conn-dev");
});

await check("database visibility picker can add and remove displayed databases", async () => {
  await ensureConnection("conn-dev");
  await waitFor(() => page.locator("[data-display-databases]").count().then((count) => count === 1), "database picker action");
  await page.locator("[data-display-databases]").click();
  expect(await page.locator("#databaseModal").isVisible(), "database picker did not open");
  expect(await page.locator("#databaseList .database-option").count() === 2, "database picker did not list all databases");
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  await waitFor(() => page.locator(".tree-database[data-database='app_reporting']").count().then((count) => count === 1), "additional database tree");
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").uncheck();
  await page.locator("#applyDatabasePicker").click();
  await waitFor(() => page.locator(".tree-database[data-database='app_reporting']").count().then((count) => count === 0), "database removal");
});

await check("clicking a dialog backdrop dismisses without applying draft changes", async () => {
  await page.locator("[data-display-databases]").click();
  expect(await page.locator("#databaseModal").isVisible(), "database picker did not reopen");
  const dialog = await page.locator("#databaseModal").boundingBox();
  expect(dialog, "database picker has no bounds");
  await page.mouse.click(Math.max(2, dialog.x - 8), dialog.y + 12);
  await waitFor(() => page.locator("#databaseModal").isVisible().then((visible) => !visible), "database backdrop dismissal");
});

await check("schema visibility picker can hide and restore schemas per database", async () => {
  const appDatabase = page.locator(".tree-database[data-database='app']");
  await expandDatabase("app");
  await waitFor(() => appDatabase.locator(".tree-schema").count().then((count) => count === 2), "fixture schemas");
  expect(await appDatabase.locator(".tree-schema[data-schema='public']").count() === 1, "public schema missing before picker");
  expect(await appDatabase.locator(".tree-schema[data-schema='analytics']").count() === 1, "analytics schema missing before picker");

  await appDatabase.locator("[data-display-schemas]").click();
  expect(await page.locator("#schemaModal").isVisible(), "schema picker did not open");
  expect((await page.locator("#schemaPickerDatabaseName").innerText()).trim() === "app", "schema picker opened for the wrong database");
  expect(await page.locator("#schemaList input[value='public']").isChecked(), "public schema is not selected by default");
  expect(await page.locator("#schemaList input[value='analytics']").isChecked(), "analytics schema is not selected by default");

  await page.locator("#schemaList input[value='analytics']").uncheck();
  await page.locator("#applySchemaPicker").click();
  await waitFor(() => appDatabase.locator(".tree-schema[data-schema='analytics']").count().then((count) => count === 0), "analytics schema removal");
  expect(await appDatabase.locator(".tree-schema[data-schema='public']").count() === 1, "hiding analytics also hid public");

  await appDatabase.locator("[data-display-schemas]").click();
  await page.locator("#schemaList input[value='analytics']").check();
  await page.locator("#applySchemaPicker").click();
  await waitFor(() => appDatabase.locator(".tree-schema[data-schema='analytics']").count().then((count) => count === 1), "analytics schema restore");

  // Schema preferences are scoped by database as well as connection. Open a
  // second database and make sure its picker does not reuse app's schema list.
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  const reportingDatabase = page.locator(".tree-database[data-database='app_reporting']");
  await expandDatabase("app_reporting");
  await waitFor(() => reportingDatabase.locator(".tree-schema[data-schema='reporting']").count().then((count) => count === 1), "reporting schema");
  await reportingDatabase.locator("[data-display-schemas]").click();
  expect((await page.locator("#schemaPickerDatabaseName").innerText()).trim() === "app_reporting", "schema picker leaked the app database");
  expect(await page.locator("#schemaList input[value='reporting']").count() === 1, "reporting schema missing from its database picker");
  expect(await page.locator("#schemaList input[value='analytics']").count() === 0, "app schema leaked into reporting database picker");
  await page.locator("#cancelSchemaPicker").click();
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").uncheck();
  await page.locator("#applyDatabasePicker").click();
  await waitFor(() => page.locator(".tree-database[data-database='app_reporting']").count().then((count) => count === 0), "reporting database cleanup");

  // Leave conn-dev with a distinct preference before switching instances. The
  // stage picker should still default to all of its own schemas, and switching
  // back should recover dev's hidden analytics selection.
  await appDatabase.locator("[data-display-schemas]").click();
  await page.locator("#schemaList input[value='analytics']").uncheck();
  await page.locator("#applySchemaPicker").click();
  await waitFor(() => appDatabase.locator(".tree-schema[data-schema='analytics']").count().then((count) => count === 0), "dev analytics preference");

  // Connection identity is part of the preference key. Switching instances
  // must not replace conn-dev's schema selection with conn-stage's catalog.
  await ensureConnection("conn-stage");
  const stageDatabase = page.locator(".tree-database[data-database='app_stage']");
  await expandDatabase("app_stage");
  await waitFor(() => stageDatabase.locator(".tree-schema[data-schema='analytics']").count().then((count) => count === 1), "stage analytics schema");
  await stageDatabase.locator("[data-display-schemas]").click();
  expect((await page.locator("#schemaPickerDatabaseName").innerText()).trim() === "app_stage", "schema picker did not follow the selected connection");
  expect(await page.locator("#schemaList input[value='analytics']").isChecked(), "stage schema preferences leaked from conn-dev");
  await page.locator("#cancelSchemaPicker").click();
  await ensureConnection("conn-dev");
  await expandDatabase("app");
  await waitFor(() => page.locator(".tree-database[data-database='app'] .tree-schema[data-schema='analytics']").count().then((count) => count === 0), "dev connection preference restore");
  await page.locator(".tree-database[data-database='app'] [data-display-schemas]").click();
  await page.locator("#schemaList input[value='analytics']").check();
  await page.locator("#applySchemaPicker").click();
  await waitFor(() => page.locator(".tree-database[data-database='app'] .tree-schema[data-schema='analytics']").count().then((count) => count === 1), "dev analytics preference cleanup");

  const schemaCalls = calls("list_schemas").filter((entry) => entry.args?.database === "app");
  expect(schemaCalls.length >= 1, "schema picker flow did not load app schemas");
  expect(schemaCalls.every((entry) => entry.args?.connectionId === "conn-dev"), "schema listing used the wrong connection id");
});

await check("multi-tab SQL stays isolated and undo does not cross the first tab", async () => {
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT 'fixture_tab_a'");
  await page.locator("#addQueryTab").click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT 'fixture_tab_b'");
  await page.locator(".query-tab").nth(0).locator(".tab-select").click();
  await waitFor(() => editor.innerText().then((value) => value.includes("fixture_tab_a")), "first tab text restore");
  await page.locator(".query-tab").nth(1).locator(".tab-select").click();
  await waitFor(() => editor.innerText().then((value) => value.includes("fixture_tab_b")), "second tab text restore");
  await editor.click();
  await page.keyboard.press("Meta+Z");
  expect(!(await editor.innerText()).includes("fixture_tab_b"), "undo did not affect the focused second editor");
  await page.locator(".query-tab").nth(0).locator(".tab-select").click();
  expect((await editor.innerText()).includes("fixture_tab_a"), "undo history crossed into first tab");
});

await check("closing all tabs returns to the empty workspace without creating a query", async () => {
  await page.locator(".query-tab.active").click({ button: "right" });
  await page.locator("#tabContextMenu [data-tab-context-action='close-all']").click();
  await waitFor(() => page.locator(".query-tab").count().then((count) => count === 0), "all query tabs closed");
  expect(await page.locator("body").evaluate(node => node.classList.contains("empty-workspace-mode")), "close all did not enter the empty workspace");
  expect(await page.locator("#resultEmpty").isVisible(), "close all did not display the welcome state");
  expect(await page.locator("#editorPane").isHidden(), "close all left the SQL editor visible");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2") || "[]").length) === 0, "closed tabs remained in the saved workspace");
});

await check("write mode confirms mutations and supports transaction rollback", async () => {
  await page.locator("#addQueryTab").click();
  expect((await page.locator(".tab-label").innerText()).trim() === "查询 1", "query numbering did not restart at the first available number");
  expect(await page.locator(".tab-close").count() === 1, "single query tab is missing its close button");
  await ensureConnection("conn-dev");
  await expandDatabase("app");
  await waitFor(() => page.locator("#modeBadge").isEnabled(), "query mode toggle");
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("UPDATE public.orders SET status = 'PAID'");
  const beforeMutation = calls("execute_mutation").length;
  await page.locator("#runQuery").click();
  await page.locator("#confirmActionAccept").click();
  await waitFor(() => calls("execute_mutation").length > beforeMutation, "write SQL invoke");
  const beforeBegin = calls("begin_transaction").length;
  await page.locator("#beginTransaction").click();
  await waitFor(() => calls("begin_transaction").length > beforeBegin, "begin transaction invoke");
  expect(await page.locator("#commitTransaction").isEnabled(), "commit button is disabled in an open transaction");
  const beforeRollback = calls("rollback_transaction").length;
  await page.locator("#rollbackTransaction").click();
  await waitFor(() => calls("rollback_transaction").length > beforeRollback, "rollback transaction invoke");
  if (await page.locator("#modeBadge").getAttribute("aria-pressed") === "false") await page.locator("#modeBadge").click();
});

await check("query tabs scroll horizontally while the add button stays fixed", async () => {
  await page.setViewportSize({ width: 1060, height: 680 });
  const removeExtraTabs = async () => {
    while (await page.locator(".query-tab").count() > 1) {
      await page.locator(".query-tab").last().locator(".tab-close").click();
    }
  };
  try {
    for (let index = 0; index < 18; index += 1) await page.locator("#addQueryTab").click();
    await waitFor(() => page.locator("#queryTabs .query-tab").count().then((count) => count >= 18), "overflow query tabs");
    const before = await page.evaluate(() => {
      const tabs = document.querySelector("#queryTabs");
      const add = document.querySelector("#addQueryTab");
      const bar = document.querySelector(".tabbar");
      const tabsRect = tabs.getBoundingClientRect();
      const addRect = add.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return {
        overflow: tabs.scrollWidth > tabs.clientWidth + 1,
        tabsRight: tabsRect.right,
        addLeft: addRect.left,
        addRight: addRect.right,
        barRight: barRect.right,
      };
    });
    expect(before.overflow, "query tabs did not become horizontally scrollable");
    expect(before.addLeft >= before.tabsRight - 2, "add button moved into the scrolling tab strip");
    expect(before.addRight <= before.barRight + 1, "add button is clipped outside the tab bar");
    await page.locator("#queryTabs").evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    await waitFor(() => page.locator("#queryTabs").evaluate((node) => node.scrollLeft > 0), "query tab horizontal scroll");
    const after = await page.locator("#addQueryTab").boundingBox();
    expect(after && Math.abs(after.x - before.addLeft) < 1, "add button moved when tab strip scrolled");
  } finally {
    await removeExtraTabs();
  }
});

await check("browse page 1 has 500 rows, next sends OFFSET 500, and last page disables next", async () => {
  await page.locator(".query-tab").nth(0).locator(".tab-select").click();
  await ensureConnection("conn-dev");
  await expandDatabase("app");
  await waitFor(() => page.locator(".tree-schema[data-schema='public']").count().then((count) => count === 1), "public schema");
  const publicSchema = page.locator(".tree-schema[data-schema='public']");
  if (await publicSchema.getAttribute("open") === null) await publicSchema.locator(" > summary > [data-tree-toggle]").click();
  const categorySummary = publicSchema.locator(".category-summary").first();
  if (await categorySummary.count() && await categorySummary.getAttribute("aria-expanded") !== "true") await categorySummary.locator("> [data-tree-toggle]").click();
  await waitFor(() => page.locator("[data-object-id='public.orders']").count().then((count) => count === 1), "orders object");
  await page.locator("[data-object-id='public.orders'] .object-main").dblclick();
  expect(await page.locator("#tableToolbar").isVisible(), "table toolbar did not replace the SQL toolbar");
  expect(await page.locator("#queryToolbar").isVisible().then((visible) => !visible), "SQL toolbar remained visible in table view");
  expect((await page.locator("#tableToolbarMeta").innerText()).includes("500"), "table view did not use 500 rows per page");
  await waitFor(() => page.locator("#resultCount").innerText().then((value) => value.trim() === "500"), "first browse page");
  expect(await page.locator("#nextPage").isEnabled(), "next page is disabled on page 1");
  await page.locator("#nextPage").click();
  await waitFor(() => calls("execute_query").some((entry) => /OFFSET 500/i.test(entry.args?.request?.sql || "")), "offset 500 query");
  await waitFor(() => page.locator("#resultCount").innerText().then((value) => value.trim() === "37"), "last browse page");
  expect(!(await page.locator("#nextPage").isEnabled()), "next page remains enabled on final page");
});

await check("PostgreSQL cells edit only in write mode and keep the primary key read-only", async () => {
  // The browse check above leaves the table on its final page. Return to the
  // first page so the fixture's first row gives us a stable id/status pair.
  if (await page.locator("#previousPage").isEnabled()) await page.locator("#previousPage").click();
  await waitFor(() => page.locator("#resultCount").innerText().then((value) => value.trim() === "500"), "first page before cell edit");
  await waitFor(() => page.locator("#editRow").isVisible(), "PostgreSQL primary-key metadata");
  if (!(await page.locator("#modeBadge").innerText()).includes("可写")) await page.locator("#modeBadge").click();
  await waitFor(() => page.locator("#modeBadge").innerText().then((value) => value.includes("可写")), "PostgreSQL write mode");

  const closeCell = async () => {
    if (await page.locator("#cellModal").evaluate((node) => node.open)) await page.locator("#closeCell").click();
  };
  try {
    const statusCell = page.locator("#resultGrid .db-grid-row[data-row-index='0'] [data-column-index='1']");
    await inspectCell(statusCell);
    await waitFor(() => page.locator("#cellModal").isVisible(), "PostgreSQL editable cell modal");
    expect(await page.locator("#cellValue").isEditable(), "non-primary PostgreSQL cell is read-only in write mode");
    expect(await page.locator("#saveCell").isVisible(), "PostgreSQL cell save action is hidden in write mode");

    await page.locator("#cellValue").fill("PAID");
    const beforeMutation = calls("execute_mutation").length;
    await page.locator("#saveCell").click();
    await page.locator("#confirmActionAccept").click();
    await waitFor(() => calls("execute_mutation").length > beforeMutation, "PostgreSQL cell mutation");
    const request = calls("execute_mutation").at(-1)?.args?.request;
    expect(/^UPDATE\s+"public"\."orders"/i.test(request?.sql || ""), `cell edit did not issue an UPDATE for public.orders: ${request?.sql || "<missing>"}`);
    expect(/"status"\s*=\s*E?'PAID'/i.test(request?.sql || ""), `cell edit did not send the changed status: ${request?.sql || "<missing>"}`);
    expect(/"id"\s+IS\s+NOT\s+DISTINCT\s+FROM\s+(?:E?'1'|1)(?:\s|;|$)/i.test(request?.sql || ""), `cell edit did not retain the primary-key predicate: ${request?.sql || "<missing>"}`);
    await waitFor(() => page.locator("#cellModal").isVisible().then((visible) => !visible), "PostgreSQL cell modal close");
    await waitFor(() => page.locator("#modeBadge").innerText().then((value) => value.includes("可写")), "PostgreSQL write mode restore");

    const primaryKeyCell = page.locator("#resultGrid .db-grid-row[data-row-index='0'] [data-column-index='0']");
    await inspectCell(primaryKeyCell);
    await waitFor(() => page.locator("#cellModal").isVisible(), "PostgreSQL primary-key cell modal");
    expect(!(await page.locator("#cellValue").isEditable()), "primary-key cell became editable");
    expect(!(await page.locator("#saveCell").isVisible()), "primary-key cell exposed a save action");
    await closeCell();

    await page.locator("#modeBadge").click();
    await waitFor(() => page.locator("#modeBadge").innerText().then((value) => value.includes("只读")), "PostgreSQL read-only mode");
    await inspectCell(statusCell);
    await waitFor(() => page.locator("#cellModal").isVisible(), "PostgreSQL read-only cell modal");
    expect(!(await page.locator("#cellValue").isEditable()), "PostgreSQL cell remained editable in read-only mode");
    expect(!(await page.locator("#saveCell").isVisible()), "read-only PostgreSQL cell exposed a save action");
  } finally {
    await closeCell();
    if ((await page.locator("#modeBadge").innerText()).includes("只读")) await page.locator("#modeBadge").click();
  }
});

await check("stop query enables cancel and leaves a cancellation message", async () => {
  const editor = page.locator("#sqlEditor .cm-content");
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("SELECT /* fixture_delay */ 1");
  const before = calls("cancel_query").length;
  await page.locator("#runQuery").click();
  await waitFor(() => page.locator("#stopQuery").isEnabled(), "stop button");
  await page.locator("#stopQuery").click();
  await waitFor(() => calls("cancel_query_effective").length > before, "effective cancel");
  await waitFor(() => page.locator("#messagePanel").innerText().then((value) => /取消|cancel/i.test(value)), "cancel message");
  expect(!(await page.locator("#resultMeta").innerText()).includes("查询失败"), "cancelled query was presented as a failure");
});

await check("delayed query from another tab does not pollute the active tab", async () => {
  const editor = page.locator("#sqlEditor .cm-content");
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT /* fixture_big_grid */ 1");
  await page.locator("#runQuery").click();
  await waitFor(() => page.locator("#resultGrid .db-grid-viewport").getAttribute("aria-rowcount").then((value) => value === "1001"), "large grid");
  const viewport = page.locator("#resultGrid .db-grid-viewport");
  await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; node.scrollLeft = node.scrollWidth; });
  await waitFor(() => viewport.evaluate((node) => node.scrollTop > 0 && node.scrollLeft > 0), "grid scroll");
  const before = await viewport.evaluate((node) => ({ top: node.scrollTop, left: node.scrollLeft }));
  const selected = page.locator("#resultGrid [data-select-row='999']");
  if (await selected.count()) await selected.check();
  await page.locator("#messageTab").click();
  const messageTabId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await page.locator("#addQueryTab").click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT /* fixture_delay */ 1");
  await page.locator("#runQuery").click();
  await waitFor(() => calls("execute_query").some((entry) => /fixture_delay/.test(entry.args?.request?.sql || "")), "delayed query");
  const queryId = calls("execute_query").at(-1).args.request.queryId;
  await page.locator(`.query-tab[data-tab-id="${messageTabId}"] .tab-select`).click();
  expect(await page.locator("#messagePanel").isVisible(), "active tab did not remain on message output");
  expect(fixture.resolvePending(queryId), "delayed query was not pending");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(await page.locator("#messagePanel").isVisible(), "late result changed active tab output");
  await page.locator("#resultTab").click();
  const after = await viewport.evaluate((node) => ({ top: node.scrollTop, left: node.scrollLeft }));
  expect(Math.abs(after.top - before.top) < 80 && Math.abs(after.left - before.left) < 80, "late result reset grid scroll");
  if (await selected.count()) expect(await selected.isChecked(), "late result cleared selected row");
});

await check("late errors remain attached to the background tab", async () => {
  await page.locator("#messageTab").click();
  const activeBeforeError = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await page.locator("#addQueryTab").click();
  const editor = page.locator("#sqlEditor .cm-content");
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT /* fixture_delay_error */ 1");
  await page.locator("#runQuery").click();
  await waitFor(() => calls("execute_query").some((entry) => /fixture_delay_error/.test(entry.args?.request?.sql || "")), "delayed error query");
  const queryId = calls("execute_query").at(-1).args.request.queryId;
  await page.locator(`.query-tab[data-tab-id="${activeBeforeError}"] .tab-select`).click();
  expect(await page.locator("#messagePanel").isVisible(), "active tab output changed before error");
  expect(fixture.rejectPending(queryId), "delayed error was not pending");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(await page.locator("#messagePanel").isVisible(), "late error changed active tab output");
});

await check("result filter changes the visible count and exported data per tab", async () => {
  await page.locator(".query-tab").first().locator(".tab-select").click();
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT /* fixture_filter */ 1");
  await page.locator("#runQuery").click();
  await waitFor(() => page.locator("#resultCount").innerText().then((value) => value.trim() === "4"), "filter result");
  await page.locator("#resultFilter").fill("needle");
  await waitFor(() => page.locator("#resultCount").innerText().then((value) => value.trim() === "2/4"), "filtered result count");
  const before = calls("save_text_file").length;
  await page.locator("#exportResults").click();
  await waitFor(() => calls("save_text_file").length > before, "filtered export");
  const contents = calls("save_text_file").at(-1).args.contents;
  expect(contents.includes("needle") && !contents.includes("other"), "export ignored active filter");
  await page.locator("#addQueryTab").click();
  expect((await page.locator("#resultFilter").inputValue()) === "", "filter leaked into new tab");
  await page.locator(".query-tab").first().locator(".tab-select").click();
  expect((await page.locator("#resultFilter").inputValue()) === "needle", "filter was not restored on first tab");
});

await check("Ctrl/Cmd+Enter in connection modal does not run SQL", async () => {
  const before = calls("execute_query").length;
  await page.locator("#newConnection").click();
  expect(await page.locator("#connectionModal").evaluate((node) => node.open), "connection modal did not open");
  await page.keyboard.press("Meta+Enter");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(calls("execute_query").length === before, "modal shortcut executed a query");
  await page.locator("#cancelConnection").click();
});

await check("connection driver choices switch fields and submit the selected driver", async () => {
  await page.locator("#newConnection").click();
  const modal = page.locator("#connectionModal");
  expect(await modal.locator("#connectionHost").inputValue() === "localhost", "new connection host was not filled");
  expect(await modal.locator("#connectionUser").inputValue() === "postgres", "new connection username was not filled");
  await modal.locator("#connectionName").fill("Fixture driver validation");
  await modal.locator("#connectionHost").fill("fixture.local");
  expect(await modal.locator("#connectionDriver").inputValue() === "postgres", "new connection did not default to PostgreSQL");
  expect(await modal.locator("#connectionDatabase").inputValue() === "postgres", "new PostgreSQL connection did not default to postgres database");
  await modal.screenshot({ path: join(evidenceDir, "connection-postgres.png") });
  await modal.locator("#connectionDriverTrigger").click();
  await modal.screenshot({ path: join(evidenceDir, "connection-driver-menu.png") });
  await modal.locator("#connectionDriverMenu [data-driver='redis']").click();
  await modal.screenshot({ path: join(evidenceDir, "connection-redis.png") });
  expect(!(await modal.locator("#connectionDatabaseField").isVisible()), "Redis DB input should be removed from the connection form");
  expect(await modal.locator("#connectionPort").inputValue() === "6379", "Redis port did not update");
  expect(await modal.locator("#connectionTlsField").isVisible(), "Redis TLS field did not appear");
  const before = calls("test_connection").length;
  await modal.locator("#testConnection").click();
  await waitFor(() => calls("test_connection").length > before, "Redis test connection invoke");
  expect(calls("test_connection").at(-1).args.request.profile.driver === "redis", "test connection used the wrong driver");
  expect(calls("test_connection").at(-1).args.request.profile.redisDb === 0, "Redis test connection did not default to DB 0");
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='postgres']").click();
  expect(await modal.locator("#connectionPort").inputValue() === "5432", "PostgreSQL port did not restore");
  expect(await modal.locator("#connectionDatabase").inputValue() === "postgres", "Redis database leaked into PostgreSQL connection");
  expect(!(await modal.locator("#connectionTlsField").isVisible()), "Redis TLS field remained visible for PostgreSQL");
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='mysql']").click();
  expect(await modal.locator("#connectionPort").inputValue() === "3306", "MySQL port did not default to 3306");
  expect(await modal.locator("#connectionUser").inputValue() === "root", "MySQL username did not default to root");
  expect(!(await modal.locator("#connectionDatabaseField").isVisible()), "MySQL default database field should be omitted");
  expect(await modal.locator("#connectionDatabase").inputValue() === "", "MySQL connection unexpectedly defaulted to a database");
  expect(await modal.locator("#connectionTlsField").isVisible(), "MySQL TLS field is missing");
  const beforeMysql = calls("test_connection").length;
  await modal.locator("#testConnection").click();
  await waitFor(() => calls("test_connection").length > beforeMysql, "MySQL test connection invoke");
  expect(calls("test_connection").at(-1).args.request.profile.database === "", "MySQL connection request unexpectedly selected a database");
  expect(calls("test_connection").at(-1).args.request.profile.user === "root", "MySQL connection request did not use root");
  await modal.screenshot({ path: join(evidenceDir, "connection-mysql.png") });
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='postgres']").click();
  expect(await modal.locator("#connectionDatabase").inputValue() === "postgres", "MySQL database leaked into PostgreSQL connection");
  expect(await modal.locator("#connectionUser").inputValue() === "postgres", "PostgreSQL username did not restore its default");
  await modal.locator("#connectionUser").fill("custom_user");
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='mysql']").click();
  expect(await modal.locator("#connectionUser").inputValue() === "custom_user", "changing driver replaced a custom username");
  await modal.locator("#cancelConnection").click();
});

await check("password controls toggle without changing credentials or submitting the form", async () => {
  await page.locator("#newConnection").click();
  const modal = page.locator("#connectionModal");
  const password = modal.locator("#connectionPassword");
  const toggle = modal.locator(".password-toggle");
  const before = calls("save_connection").length + calls("test_connection").length;
  await password.fill("fixture-only-password");
  await password.evaluate(el => el.setSelectionRange(3, 7));
  await toggle.click();
  expect(await password.getAttribute("type") === "text", "password did not become visible");
  expect(await toggle.getAttribute("aria-label") === "隐藏密码", "visible password has the wrong action label");
  expect(await password.evaluate(el => el.selectionStart === 3 && el.selectionEnd === 7 && document.activeElement === el), "toggle lost input focus or selection");
  expect(await password.inputValue() === "fixture-only-password", "toggle changed password text");
  await toggle.focus();
  await page.keyboard.press("Space");
  expect(await password.getAttribute("type") === "password", "keyboard could not hide the password");
  await page.keyboard.press("Enter");
  expect(await password.getAttribute("type") === "text", "keyboard could not show the password");
  expect(calls("save_connection").length + calls("test_connection").length === before, "password toggle submitted a connection request");
  await modal.locator("#cancelConnection").click();
  await page.waitForFunction(() => document.querySelector('#connectionPassword').type === 'password');
  await page.locator("#newConnection").click();
  expect(await password.inputValue() === "", "new connection retained password text");
  expect(await toggle.getAttribute("aria-pressed") === "false", "new connection retained reveal state");
  await modal.locator("#cancelConnection").click();
});

await check("global password controls cover dynamic fields and reset independently", async () => {
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'passwordControlFixture';
    dialog.innerHTML = '<form><label for="fixtureSecretA">测试密码 A</label><input type="password" id="fixtureSecretA" value="fixture-a"><label for="fixtureSecretB">测试密码 B</label><input type="password" id="fixtureSecretB" value="fixture-b"><input type="password" disabled aria-label="禁用密码"><button type="reset">重置</button></form>';
    document.body.append(dialog);
    dialog.showModal();
  });
  try {
    const dialog = page.locator('#passwordControlFixture');
    await dialog.locator('.password-toggle').nth(2).waitFor();
    expect(await dialog.locator('.password-toggle').count() === 3, "dynamic fields did not each get one toggle");
    await dialog.locator('[aria-controls="fixtureSecretA"]').click();
    expect(await dialog.locator('#fixtureSecretA').getAttribute('type') === 'text', 'first field did not toggle');
    expect(await dialog.locator('#fixtureSecretB').getAttribute('type') === 'password', 'revealing one field also revealed another');
    expect(await dialog.locator('.password-toggle').nth(2).isDisabled(), 'disabled field has an enabled toggle');
    await dialog.locator('input[disabled]').evaluate(el => { el.disabled = false; });
    await page.waitForFunction(() => !document.querySelectorAll('#passwordControlFixture .password-toggle')[2].disabled);
    await dialog.getByRole('button', { name: '重置' }).click();
    expect(await dialog.locator('input[type="password"]').count() === 3, 'reset did not hide every password');
    await dialog.locator('[aria-controls="fixtureSecretB"]').click();
    await dialog.evaluate(el => el.close());
    await page.waitForFunction(() => document.querySelector('#fixtureSecretB').type === 'password');
  } finally {
    await page.locator('#passwordControlFixture').evaluate(el => el.remove());
  }
});

await check("editing connections preserves custom databases and resets Redis DB on driver changes", async () => {
  expect(await page.locator("#queryConnection, #queryDatabase").count() === 0, "connection/database pickers are still present");
  await page.locator("[data-edit-id='conn-dev']").click();
  const modal = page.locator("#connectionModal");
  expect(await modal.locator("#connectionUser").inputValue() === "fixture", "editing replaced the saved username");
  expect(await modal.locator("#connectionDatabase").inputValue() === "app", "editing replaced the saved PostgreSQL database");
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='postgres']").click();
  expect(await modal.locator("#connectionDatabase").inputValue() === "app", "reselecting the same driver replaced the custom database");
  await modal.locator("#cancelConnection").click();

  await page.locator("[data-edit-id='redis-local']").click();
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='mysql']").click();
  expect(!(await modal.locator("#connectionDatabaseField").isVisible()), "MySQL default database field should be omitted when editing");
  expect(await modal.locator("#connectionDatabase").inputValue() === "", "saved Redis DB leaked into MySQL connection");
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='redis']").click();
  await modal.locator("#connectionDriverTrigger").click();
  await modal.locator("#connectionDriverMenu [data-driver='postgres']").click();
  expect(await modal.locator("#connectionDatabase").inputValue() === "postgres", "saved Redis DB leaked into PostgreSQL connection");
  await modal.locator("#connectionUser").fill("fixture");
  const before = calls("test_connection").length;
  await modal.locator("#testConnection").click();
  await waitFor(() => calls("test_connection").length > before, "edited PostgreSQL test connection invoke");
  expect(calls("test_connection").at(-1).args.request.profile.database === "postgres", "edited PostgreSQL request used the wrong database");
  await modal.locator("#cancelConnection").click();
});

await check("refresh schema passes a string connection id", async () => {
  const before = calls("list_schemas").length;
  await page.locator("#refreshSchema").click();
  await waitFor(() => calls("list_schemas").length > before, "refresh schema invoke");
  const args = calls("list_schemas").at(-1)?.args;
  expect(typeof args?.connectionId === "string", `refresh list_schemas received ${typeof args?.connectionId}`);
});

await check("collapsing an object category does not toggle or reload its schema", async () => {
  await expandDatabase("app");
  const beforeSchemas = calls("list_schemas").length;
  const beforeObjects = calls("get_schema_objects").length;
  const schema = page.locator(".tree-schema[data-schema='public']");
  if (await schema.getAttribute("open") === null) await schema.locator("> summary > [data-tree-toggle]").click();
  await waitFor(() => schema.locator(".tree-category").count().then((count) => count > 0), "public category");
  const category = schema.locator(".tree-category").first();
  const expandedBefore = await category.locator(".category-summary").getAttribute("aria-expanded");
  await category.locator(".category-summary > [data-tree-toggle]").click();
  expect(await category.locator(".category-summary").getAttribute("aria-expanded") !== expandedBefore, "category disclosure did not toggle");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calls("list_schemas").length === beforeSchemas, "category collapse invoked schema listing");
  expect(calls("get_schema_objects").length === beforeObjects, "category collapse reloaded schema objects");
});

await check("native save cancellation does not download or report success", async () => {
  const downloads = [];
  const onDownload = (download) => downloads.push(download);
  page.on("download", onDownload);
  await page.locator("#saveSql").click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  page.off("download", onDownload);
  expect(downloads.length === 0, "save cancel triggered a browser download");
  expect(!(await page.locator("#toast").innerText()).includes("已保存"), "save cancel reported success");
});

await check("extreme window sizes keep panes bounded and scrollable", async () => {
  for (const viewport of [{ width: 1060, height: 680 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const metrics = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
      panes: [...document.querySelectorAll(".scroll-area")].map((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })),
    }));
    expect(metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1, `${viewport.width}: horizontal page clipping (${metrics.bodyScrollWidth}/${metrics.bodyClientWidth})`);
    expect(metrics.bodyScrollHeight <= metrics.bodyClientHeight + 1, `${viewport.width}: vertical page clipping (${metrics.bodyScrollHeight}/${metrics.bodyClientHeight})`);
    expect(metrics.panes.some((pane) => pane.scrollHeight >= pane.clientHeight), `${viewport.width}: no independent scroll pane found`);
  }
});

await check("1000x100 result grid keeps bounded DOM while exposing two-axis scroll", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  await page.locator("#resultFilter").fill("");
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT /* fixture_big_grid */ 1");
  await page.locator("#runQuery").click();
  await waitFor(() => page.locator("#resultGrid .db-grid-viewport").getAttribute("aria-rowcount").then((value) => value === "1001"), "large result grid");
  const metrics = await page.locator("#resultGrid .db-grid-viewport").evaluate((node) => ({
    rowCount: node.getAttribute("aria-rowcount"),
    colCount: node.getAttribute("aria-colcount"),
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    rowDom: node.querySelectorAll(".db-grid-row").length,
    cellDom: node.querySelectorAll(".db-grid-cell").length,
  }));
  expect(metrics.scrollWidth > metrics.clientWidth, "large grid has no horizontal scroll");
  expect(metrics.scrollHeight > metrics.clientHeight, "large grid has no vertical scroll");
  expect(metrics.rowDom < 80 && metrics.cellDom < 2000, `large grid DOM is not bounded (${metrics.rowDom} rows/${metrics.cellDom} cells)`);
  const viewport = page.locator("#resultGrid .db-grid-viewport");
  await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; node.scrollLeft = node.scrollWidth; });
  await waitFor(() => page.locator("#resultGrid .db-grid-viewport [aria-rowindex='1001']").count().then((count) => count > 0), "last virtual row");
  await page.screenshot({ path: join(evidenceDir, "workspace-populated-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.screenshot({ path: join(evidenceDir, "workspace-populated-1060.png"), fullPage: true });
});

await check("structure detail and PostgreSQL syntax highlighting are visible", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".query-tab").first().locator(".tab-select").click();
  await expandDatabase("app");
  const structureSchema = page.locator(".tree-schema[data-schema='public']");
  if (await structureSchema.getAttribute("open") === null) await structureSchema.locator(" > summary > [data-tree-toggle]").click();
  if (await structureSchema.locator(".category-summary").count() && await structureSchema.locator(".category-summary").first().getAttribute("aria-expanded") !== "true") await structureSchema.locator(".category-summary").first().locator("> [data-tree-toggle]").click();
  await waitFor(() => page.locator("[data-object-id='public.orders']").count().then((count) => count === 1), "orders structure object");
  await page.locator("[data-object-id='public.orders'] .object-main").click({ button: "right" });
  await page.locator('#objectContextMenu [data-context-action="open-structure"]').click();
  await waitFor(() => page.locator("#structurePanel").innerText().then((value) => /public\.orders|列/.test(value)), "structure details");
  await page.screenshot({ path: join(evidenceDir, "workspace-structure-1440.png"), fullPage: true });
  await page.locator("#addQueryTab").click();
  const editor = page.locator("#sqlEditor .cm-content");
  if (await page.locator("#openTableSql").isVisible()) await page.locator("#openTableSql").click();
  await editor.click(); await page.keyboard.press("Meta+A"); await page.keyboard.type("SELECT * FROM public.orders WHERE status = 'ACTIVE'");
  const classes = await page.locator(".cm-line span").evaluateAll((nodes) => nodes.map((node) => node.className).filter(Boolean));
  expect(classes.some((name) => /tok-|ͼ/.test(name)), `SQL syntax spans missing (${classes.join(",")})`);
});

await check("steady rendering keeps an observable animation frame cadence", async () => {
  const metrics = await page.evaluate(() => new Promise((resolve) => {
    const started = performance.now(); let frames = 0; let last = started; let maxGap = 0;
    const tick = (now) => { frames += 1; maxGap = Math.max(maxGap, now - last); last = now; if (now - started >= 350) resolve({ frames, maxGap }); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  expect(metrics.frames >= 4 && metrics.maxGap < 250, `frame cadence unavailable (${JSON.stringify(metrics)})`);
});

await check("Redis keyspace browsing, value editing, and key management stay driver-specific", async () => {
  await ensureConnection("redis-local");
  await expandRedisDatabase(0);
  await waitFor(() => page.locator("[data-redis-key]").count().then((count) => count === 2), "Redis key browser");
  const redisCallsBefore = calls("list_redis_keys").length;
  await page.locator("[data-redis-key='users:1']").click();
  await waitFor(() => page.locator("#tableToolbarTitle").innerText().then((value) => value.trim() === "users:1"), "Redis value tab");
  expect(calls("get_redis_value").length >= 1, "Redis value was not loaded");
  expect(await page.locator("#editorHint").innerText() === "Redis 命令 · 只读锁定后仅允许安全读取命令", "Redis editor hint did not switch");
  if (!(await page.locator("#modeBadge").innerText()).includes("可写")) await page.locator("#modeBadge").click();
  await waitFor(() => page.locator("#modeBadge").innerText().then((value) => value.includes("可写")), "Redis write mode");
  await inspectCell(page.locator("#resultGrid .db-grid-cell").nth(1));
  await waitFor(() => page.locator("#cellModal").isVisible(), "Redis cell inspector");
  expect(await page.locator("#saveCell").isVisible(), "Redis hash value was not editable in write mode");
  await page.locator("#closeCell").click();
  await page.locator("[data-redis-key='users:1']").click({ button: "right" });
  await waitFor(() => page.locator("#redisContextMenu").isVisible(), "Redis context menu");
  const deleteCallsBefore = calls("delete_redis_key").length;
  await page.locator("#redisContextMenu [data-redis-context-action='delete']").click();
  await page.locator("#confirmActionAccept").click();
  await waitFor(() => calls("delete_redis_key").length > deleteCallsBefore, "Redis key delete");
  expect(calls("list_redis_keys").length > redisCallsBefore, "Redis key list did not refresh after delete");
  await ensureConnection("conn-dev");
});

await page.screenshot({ path: join(evidenceDir, "workspace-after-regression.png"), fullPage: true });
await context.close();
await browser.close();
await new Promise((resolve) => server.close(resolve));

const report = { fixtureOnly: true, generatedAt: new Date().toISOString(), checks, failures, screenshots: ["output/playwright/workspace-initial.png", "output/playwright/workspace-populated-1440.png", "output/playwright/workspace-populated-1060.png", "output/playwright/workspace-after-regression.png"] };
writeFileSync(join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
