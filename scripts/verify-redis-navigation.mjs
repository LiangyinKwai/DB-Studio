import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/redis-navigation");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ ...fixture.profiles.find((profile) => profile.id === "redis-local"), id: "redis-second", name: "第二个 Redis" });
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
// Seed the old preference to prove that reconnects ignore existing storage.
await context.addInitScript(() => {
  localStorage.setItem("db-studio.redis-expanded-databases.v2.redis-local", "[0,1]");
});
let holdCommand = false;
let releaseCommand;
let holdScan = false;
let releaseScan;
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command, args);
  if (command === "execute_redis_command" && holdCommand) {
    holdCommand = false;
    await new Promise((resolve) => { releaseCommand = resolve; });
  }
  if (command === "list_redis_keys" && holdScan) {
    holdScan = false;
    await new Promise((resolve) => { releaseScan = resolve; });
    return { cursor: 0, keys: ["stale-key-from-previous-view"] };
  }
  return result;
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const expect = (ok, message) => { if (!ok) throw new Error(message); };
const calls = (command) => fixture.callsFor(command);
const until = async (fn, label = "condition") => {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error(`timeout: ${label}`);
};
const connect = async (id) => {
  await page.locator(`[data-connection-id='${id}']`).click();
  await until(async () => (await page.locator(`[data-connection-toggle='${id}']`).getAttribute("data-status")) === "connected", `connect ${id}`);
};
const waitRedis = () => page.locator(".redis-database[data-redis-db='1']").waitFor();
const openConsole = async (database = 1) => {
  await page.locator(`.redis-database[data-redis-db='${database}'] > summary`).click({ button: "right" });
  await page.locator("[data-redis-database-context-action='console']").click();
  await page.locator("#redisConsolePanel").waitFor();
};
const expand = async (index) => {
  const db = page.locator(`.redis-database[data-redis-db='${index}']`);
  await db.waitFor();
  if (await db.getAttribute("open") === null) await db.locator(":scope > summary [data-tree-toggle]").click();
  await db.locator("[data-redis-key]").first().waitFor();
};
const assertCollapsed = async (scanCount) => {
  await waitRedis();
  expect(await page.locator(".redis-database[open]").count() === 0, "Redis DB expansion was restored");
  expect(calls("list_redis_keys").length === scanCount, "reconnect scanned a DB before the user expanded it");
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await connect("conn-dev");
  await page.locator(".tree-database[data-database='app'] > summary [data-tree-toggle]").click();
  await page.locator(".tree-schema[data-schema='public'] > summary [data-tree-toggle]").click();
  await page.locator("[data-object-id='public.orders'] .object-main").dblclick();
  await page.locator("#resultGrid .db-grid-cell").first().waitFor();
  const tableId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  const tableTab = page.locator(`.query-tab[data-tab-id='${tableId}'] .tab-select`);
  const tableSql = await page.locator("#sqlEditor .cm-content").innerText();
  await page.locator(".tree-schema[data-schema='public'] .tree-category[data-kind='view'] .category-summary [data-tree-toggle]").click();
  const scans = calls("list_redis_keys").length;
  await connect("redis-local");
  await assertCollapsed(scans);
  await openConsole(1);
  expect(await page.locator("#tableToolbar").isHidden(), "PostgreSQL table toolbar appears over Redis console");
  expect(await page.locator("#queryToolbar").isHidden(), "SQL toolbar appears over Redis console");
  expect(await page.locator(".query-tab.active").count() === 0, "SQL tab still marked selected under Redis console");
  expect(await page.locator("#queryTargetBar").isHidden(), "SQL schema selector appears over Redis console");
  expect((await page.locator("#redisConsoleContext").innerText()).includes("本地 Redis · DB 1"), "console connection/DB unclear");
  const sqlCalls = calls("execute_query").length;
  const redisCalls = calls("execute_redis_command").length;
  await page.locator("#redisConsoleInput").fill("PING");
  await page.locator("#redisConsoleRun").click();
  await until(() => calls("execute_redis_command").length === redisCalls + 1, "Redis command on top of SQL tab");
  await until(() => page.locator("#redisConsoleRun").isEnabled());
  const request = calls("execute_redis_command").at(-1).args.request;
  expect(request.connectionId === "redis-local" && request.database === 1 && request.sql === "PING" && request.console === true, "console command misrouted");
  expect(calls("execute_query").length === sqlCalls, "console accidentally executed hidden SQL");
  await page.screenshot({ path: resolve(evidence, "console-with-existing-sql-tab.png") });
  // Clicking the previously selected tab must exit the console as well.
  await tableTab.click();
  expect(await page.locator("#redisConsolePanel").isHidden(), "clicking same SQL tab did not exit console");
  expect(await page.locator("#tableToolbar").isVisible() && await page.locator("#resultGrid").isVisible(), "table data view not restored");
  expect(await page.locator("#sqlEditor .cm-content").innerText() === tableSql, "console command replaced SQL draft");
  await openConsole(1);
  holdCommand = true;
  await page.locator("#redisConsoleInput").fill("PING");
  await page.locator("#redisConsoleInput").press("Meta+Enter");
  await until(() => Boolean(releaseCommand), "held command");
  await connect("conn-dev");
  expect(await page.locator(".tree-database[data-database='app'][open]").count() === 1, "switching back collapsed PostgreSQL database");
  expect(await page.locator(".tree-schema[data-schema='public'][open]").count() === 1, "switching back collapsed PostgreSQL schema");
  expect(await page.locator(".tree-schema[data-schema='public'] .tree-category[data-kind='view'] .category-summary").getAttribute("aria-expanded") === "true", "switching back lost object group expansion");
  expect(await page.locator("#redisConsolePanel").isHidden(), "connection switch kept Redis console");
  releaseCommand();
  await until(async () => (await page.locator("#recentQueries").innerText()).includes("PING"));
  await page.waitForTimeout(100);
  expect(await page.locator("#redisConsolePanel").isHidden() && await page.locator("#tableToolbar").isVisible(), "late Redis result resurrected console");
  await page.locator("#openTableDdl").click();
  await page.locator("#structurePanel .structure-title").waitFor();
  expect(await page.locator("#redisConsolePanel").isHidden(), "structure still covered by Redis console");
  await tableTab.click();
  await page.locator("#openTableSql").click();
  await until(() => page.locator("#runQuery").isEnabled());
  const pgBefore = calls("execute_query").length;
  await page.locator("#sqlEditor .cm-content").click();
  await page.keyboard.press("Meta+Enter");
  await until(() => calls("execute_query").length === pgBefore + 1);
  expect(calls("execute_query").at(-1).args.request.connectionId === "conn-dev", "SQL shortcut ran against Redis");
  await until(() => page.locator("#runQuery").isEnabled());
  await page.screenshot({ path: resolve(evidence, "postgres-after-console.png") });

  await connect("redis-local");
  await waitRedis();
  await expand(0);
  await expand(1);
  expect(await page.locator(".redis-database[open]").count() === 2, "manual expansion failed");
  const scansBeforeRefresh = calls("list_redis_keys").length;
  await page.locator("[data-refresh-redis]").click();
  await until(() => calls("list_redis_keys").length >= scansBeforeRefresh + 2, "refresh open DBs");
  expect(await page.locator(".redis-database[open]").count() === 2, "ordinary refresh collapsed user's current selection");
  await openConsole(1);
  await page.locator("[data-connection-toggle='redis-local']").click();
  await until(async () => (await page.locator("[data-connection-toggle='redis-local']").getAttribute("data-status")) === "idle");
  expect(await page.locator("#redisConsolePanel").isHidden(), "disconnect kept stale console");
  const scansBeforeReconnect = calls("list_redis_keys").length;
  await connect("redis-local");
  await assertCollapsed(scansBeforeReconnect);
  await expand(1);
  await connect("conn-dev");
  const scansBeforeSwitch = calls("list_redis_keys").length;
  const connectionsBeforeSwitch = calls("connect_connection").length;
  await connect("redis-local");
  await waitRedis();
  expect(await page.locator(".redis-database[open]").count() === 1 && await page.locator(".redis-database[data-redis-db='1'][open]").count() === 1, "instance switch lost Redis expansion");
  expect(calls("list_redis_keys").length === scansBeforeSwitch, "instance switch rescanned loaded keys");
  expect(calls("connect_connection").length === connectionsBeforeSwitch, "instance selection reconnected an existing connection");
  await connect("redis-second");
  await assertCollapsed(scansBeforeSwitch);
  await expand(0);
  await connect("redis-local");
  expect(await page.locator(".redis-database[data-redis-db='1'][open]").count() === 1 && await page.locator(".redis-database[data-redis-db='0'][open]").count() === 0, "Redis instances share expanded DBs");
  // Disconnecting an inactive instance clears only that instance's session.
  await page.locator("[data-connection-toggle='redis-second']").click();
  await until(async () => await page.locator("[data-connection-toggle='redis-second']").getAttribute("data-status") === "idle");
  expect(await page.locator(".redis-database[data-redis-db='1'][open]").count() === 1, "inactive disconnect cleared active expansion");
  const beforeSecondReconnect = calls("list_redis_keys").length;
  await connect("redis-second");
  await assertCollapsed(beforeSecondReconnect);
  await connect("redis-local");
  await page.locator(".redis-database[data-redis-db='1'] > summary [data-tree-toggle]").click();
  await connect("redis-second");
  await connect("redis-local");
  await assertCollapsed(beforeSecondReconnect);
  // Resume a scan interrupted by navigation, and ignore its old response.
  holdScan = true;
  await page.locator(".redis-database[data-redis-db='0'] > summary [data-tree-toggle]").click();
  await until(() => Boolean(releaseScan), "held Redis scan");
  await connect("conn-dev");
  await connect("redis-local");
  await page.locator(".redis-database[data-redis-db='0'] [data-redis-key='users:1']").waitFor();
  releaseScan();
  await page.waitForTimeout(100);
  expect(await page.locator("[data-redis-key='stale-key-from-previous-view']").count() === 0, "late scan replaced restored Redis tree");

  // Key tabs keep their binding, while the DB tree starts collapsed on restart.
  await expand(0);
  await page.locator(".redis-database[data-redis-db='0'] [data-redis-key='users:1']").click();
  await page.locator("#resultGrid .db-grid-cell").first().waitFor();
  const scansBeforeReload = calls("list_redis_keys").length;
  await page.reload({ waitUntil: "networkidle" });
  await assertCollapsed(scansBeforeReload);
  expect(await page.locator("#redisConsolePanel").isHidden(), "reload restored console");
  await page.screenshot({ path: resolve(evidence, "redis-reconnected-collapsed.png") });
  expect(errors.length === 0, errors.join("; "));
  console.log("PASS: per-instance SQL/Redis expansion and group restoration without reconnect/rescan, inactive disconnect isolation, late scan guards, SQL/Redis view isolation, reconnect/restart collapse and refresh retention.");
} finally {
  releaseCommand?.();
  releaseScan?.();
  await browser.close();
  await new Promise((done) => server.close(done));
}
