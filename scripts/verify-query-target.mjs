import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/query-target");
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
let failContext = false;
let holdQuery = false;
let releaseQuery;
let holdContext = false;
let releaseContext;
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  const result = await fixture.invoke(command, args);
  if (command === "get_query_context") {
    if (failContext) throw new Error("fixture context unavailable");
    if (holdContext) { holdContext = false; await new Promise((resolve) => { releaseContext = resolve; }); }
  }
  if (command === "execute_query" && holdQuery) {
    holdQuery = false;
    await new Promise((resolve) => { releaseQuery = resolve; });
  }
  return result;
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const expect = (ok, message) => { if (!ok) throw new Error(message); };
const editor = page.locator(".cm-content");
const targetHint = () => page.locator("#editorHint").innerText();
const schema = page.locator("#querySchema");
const selectSchema = async (value) => {
  await schema.click();
  await page.locator(`#querySchemaList [role='option'][data-value='${value}']`).click();
};
const run = page.locator("#runQuery");
const until = async (fn) => {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error("condition timed out");
};
const ready = () => until(() => run.isEnabled());
const execute = async (text) => {
  await editor.fill(text);
  const count = fixture.callsFor("execute_query").length;
  await run.click();
  await until(() => fixture.callsFor("execute_query").length === count + 1);
  await ready();
  return fixture.callsFor("execute_query").at(-1).args.request;
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  // The first tab must keep its generated SQL even though the shared editor
  // still contains the empty workspace document when activation begins.
  expect(await page.locator(".query-tab").count() === 0, "fixture did not start with an empty workspace");
  await page.locator("#objectSearch").fill("orders");
  const firstTable = page.locator("[data-object-id='public.orders'] .object-main");
  const browseStatement = 'SELECT *\nFROM "public"."orders"\nLIMIT 501 OFFSET 0;';
  const readsBeforeFirstTable = fixture.callsFor("execute_query").length;
  await firstTable.dblclick();
  await until(async () => fixture.callsFor("execute_query").length > readsBeforeFirstTable ||
    (await page.locator("#toast").innerText()).includes("请先输入 SQL"));
  expect(fixture.callsFor("execute_query").length === readsBeforeFirstTable + 1,
    "opening the first table lost its generated SQL instead of loading data");
  await until(async () => (await page.locator("#resultCount").innerText()).trim() === "500" &&
    await page.locator("#refreshTableData").isEnabled());
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === browseStatement, "first table executed incorrect SQL");
  expect(await page.locator(".query-tab").count() === 1, "first double-click opened duplicate tabs");
  const firstTableId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await page.locator("#refreshTableData").click();
  await until(() => fixture.callsFor("execute_query").length === readsBeforeFirstTable + 2);
  await until(() => page.locator("#refreshTableData").isEnabled());
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === browseStatement, "first table refresh lost its query");
  await page.locator("#nextPage").click();
  await until(async () => (await page.locator("#resultCount").innerText()).trim() === "37" &&
    await page.locator("#refreshTableData").isEnabled());
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql.endsWith("LIMIT 501 OFFSET 500;"), "first table paging lost its SQL");
  await page.locator("#openTableSql").click();
  await ready();
  expect((await editor.innerText()).includes("OFFSET 500;"), "opening SQL from the first table lost its document");
  await page.locator(`[data-tab-id='${firstTableId}'] .tab-select`).click();
  expect((await page.locator("#resultCount").innerText()).trim() === "37", "switching back lost table results");
  await page.locator(".query-tab.active").click({ button: "right" });
  await page.locator("[data-tab-context-action='close-all']").click();
  await firstTable.click({ button: "right" });
  await page.locator("[data-context-action='new-query']").click();
  await ready();
  const prefilledStatement = 'SELECT *\nFROM "public"."orders"\nLIMIT 500;';
  expect(await editor.innerText() === prefilledStatement, "first prefilled query was overwritten by the empty editor");
  const readsBeforePrefilled = fixture.callsFor("execute_query").length;
  await run.click();
  await until(() => fixture.callsFor("execute_query").length === readsBeforePrefilled + 1);
  await ready();
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === prefilledStatement, "first prefilled query did not execute its document");
  await page.locator(".query-tab.active .tab-close").click();
  expect(await page.locator(".query-tab").count() === 0, "closing the last query left a tab open");
  await firstTable.dblclick();
  await until(() => fixture.callsFor("execute_query").length === readsBeforePrefilled + 2);
  await until(() => page.locator("#refreshTableData").isEnabled());
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === browseStatement, "table SQL was lost after closing the last tab");
  await page.screenshot({ path: resolve(evidence, "first-table-loaded.png") });
  // Start the existing target/history checks with a clean workspace.
  // The departing page persists tabs on pagehide. Clear only after that write,
  // before the replacement document reads storage, and preserve later reloads.
  await page.addInitScript(() => {
    const marker = "db-studio.verify-query-target.workspace-reset";
    if (sessionStorage.getItem(marker)) return;
    localStorage.clear();
    sessionStorage.setItem(marker, "done");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#addQueryTab").click();
  await ready();
  expect((await targetHint()).includes("开发库 / app"), "new query target incorrect");
  expect(await page.locator("#queryConnection, #queryDatabase").count() === 0, "connection/database pickers still present");
  expect(await page.locator("#queryToolbar [aria-haspopup='listbox']").count() === 1, "toolbar should have only one schema selector");
  expect(await page.locator("#modeToggle").count() === 0, "duplicate toolbar write lock is still present");
  expect(await page.locator("#modeBadge").isVisible(), "header mode control was removed");
  expect(await page.locator("#queryTargetDetail").isHidden(), "healthy queries still have a separate context row");
  expect((await schema.innerText()).includes("默认（public）"), "server default not visible");
  const firstId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await selectSchema("analytics");
  await page.locator("[data-connection-id='conn-stage']").click();
  expect((await targetHint()).includes("开发库 / app") && await schema.getAttribute("value") === "analytics", "browser selection rebound query");
  const first = await execute("SELECT 1");
  expect(first.connectionId === "conn-dev" && first.database === "app" && first.schema === "analytics", "query destination differs from visible target");
  await page.locator("#addQueryTab").click();
  await ready();
  expect((await targetHint()).includes("开发库 / app") && await schema.getAttribute("value") === "analytics", "new tab did not inherit query target");
  const secondId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await selectSchema("public");
  const second = await execute("SELECT 1");
  expect(second.schema === "public", "second schema not passed");
  expect(await page.locator("#recentQueries .recent-query").count() === 2, "history collapsed different schemas");
  await page.locator(`.query-tab[data-tab-id='${firstId}'] .tab-select`).click();
  expect(await schema.getAttribute("value") === "analytics", "tabs share a schema binding");
  await page.locator(`.query-tab[data-tab-id='${secondId}'] .tab-select`).click();
  // Changing database means opening a new query from that database in the tree.
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  await page.locator(".tree-database[data-database='app_reporting'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await ready();
  expect((await targetHint()).includes("开发库 / app_reporting") && await schema.getAttribute("value") === "" && (await schema.innerText()).includes("默认（reporting）"), "new database query inherited an unrelated schema");
  await editor.fill("ALTER TABLE reporting.orders ADD COLUMN flag bool;");
  await run.click();
  await page.locator("#confirmActionModal").waitFor();
  const message = await page.locator("#confirmActionMessage").innerText();
  expect(message.includes("开发库 / app_reporting / reporting") && message.includes("fixture.local:5432"), "confirmation destination missing");
  expect(await schema.isDisabled(), "confirmation permits target switch");
  await page.keyboard.press("Escape");
  await ready();
  await selectSchema("reporting");
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  expect((await targetHint()).includes("开发库 / app_reporting") && await schema.getAttribute("value") === "reporting", "schema not persisted");
  holdQuery = true;
  await editor.fill("SELECT 1");
  await run.click();
  await until(() => Boolean(releaseQuery));
  expect(await schema.isDisabled(), "executing permits target switch");
  await page.locator(`.query-tab[data-tab-id='${firstId}'] .tab-select`).click();
  releaseQuery();
  await until(async () => (await page.locator("#recentQueries .recent-query").first().innerText()).includes("reporting"));
  expect(await schema.getAttribute("value") === "analytics", "background completion changed active target");
  // A delayed response for a previous connection must never overwrite controls.
  holdContext = true;
  await page.locator("#refreshQueryTarget").click();
  await until(() => Boolean(releaseContext));
  await page.locator("[data-connection-id='conn-stage']").click();
  await page.locator(".tree-database[data-database='app_stage'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await ready();
  releaseContext();
  await page.waitForTimeout(80);
  expect((await targetHint()).includes("预发布库 / app_stage"), "late context response replaced new target");
  failContext = true;
  await page.locator("#refreshQueryTarget").click();
  await until(async () => (await page.locator("#queryTargetDetail").innerText()).includes("fixture context unavailable"));
  expect(await run.isDisabled(), "unresolved destination permits execution");
  failContext = false;
  await page.locator("#refreshQueryTarget").click();
  await ready();
  await page.locator("#beginTransaction").click();
  await until(() => schema.isDisabled());
  expect((await schema.getAttribute("title")).includes("预发布库 / app_stage"), "transaction lost database binding");
  await page.locator("#rollbackTransaction").click();
  await until(() => schema.isEnabled());
  // Schema context menu creates a query bound to that namespace.
  const stageDatabase = page.locator(".tree-database[data-database='app_stage']");
  if (await stageDatabase.getAttribute("open") === null) await stageDatabase.locator(" > summary [data-tree-toggle]").click();
  await page.locator(".tree-schema[data-schema='analytics'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await ready();
  expect(await schema.getAttribute("value") === "analytics", "schema context menu did not bind schema");
  const fromSchema = await execute("SELECT * FROM events;");
  expect(fromSchema.connectionId === "conn-stage" && fromSchema.database === "app_stage" && fromSchema.schema === "analytics", "schema context did not reach execution");
  // An editor opened from a table has the same namespace and may switch schema
  // without changing its connection/database or carrying old editable results.
  const publicSchema = stageDatabase.locator(".tree-schema[data-schema='public']");
  if (await publicSchema.getAttribute("open") === null) await publicSchema.locator(" > summary [data-tree-toggle]").click();
  await page.locator("[data-object-id='public.orders'] .object-open").click();
  await page.locator("#resultGrid .db-grid-cell").first().waitFor();
  expect(await page.locator("#queryTargetBar").isHidden(), "table view still has a separate target panel");
  const tableId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  const tabsBeforeSql = await page.locator(".query-tab").count();
  await page.locator("#openTableSql").click();
  await ready();
  const queryId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  expect(queryId !== tableId && await page.locator(".query-tab").count() === tabsBeforeSql + 1, "table SQL did not open an independent query");
  expect(/^查询 \d+$/.test(await page.locator(".query-tab.active .tab-label").innerText()), "query still uses the source table as its title");
  expect(await schema.getAttribute("value") === "public" && await schema.isEnabled(), "table editor schema not inherited/editable");
  const detached = await page.evaluate((id) => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find((tab) => tab.id === id), queryId);
  expect(!detached.browse && !detached.openedObject && !detached.openedObjectView && detached.tableView === false, "generic query retained table identity or pagination");
  await page.locator("[data-object-id='public.orders'] .object-open").click();
  expect(await page.locator("#tableToolbar").isVisible(), "opening SQL replaced the table browser");
  expect(await page.locator(".query-tab.active").getAttribute("data-tab-id") === tableId &&
    await page.locator(".query-tab").count() === tabsBeforeSql + 1, "opening a table reused the SQL query or created a duplicate data tab");
  await page.locator(`[data-tab-id='${queryId}'] .tab-select`).click();
  expect(await page.locator("#pageControls").isHidden() && await page.locator("#structureTab").isEnabled(), "query paging or structure entry incorrect");
  await page.locator("[data-object-id='public.orders'] .object-main").click();
  expect(await page.locator(".query-tab.active").getAttribute("data-tab-id") === tableId,
    "single-clicking an opened table did not return to its existing data tab");
  await page.locator("[data-object-id='public.orders'] .object-main").click({ button: "right" });
  await page.locator("[data-context-action='open-structure']").click();
  await page.locator("body.structure-only-mode").waitFor();
  expect(await page.locator(".query-tab.active").getAttribute("data-tab-id") !== queryId, "inspecting a table attached its structure to the generic query");
  await page.locator(`[data-tab-id='${queryId}'] .tab-select`).click();
  expect(await page.locator("#structureTab").isEnabled() && await page.locator("#querySchema").isEnabled(), "generic query lost its structure entry or became table-bound");
  await selectSchema("analytics");
  const fromTable = await execute("SELECT * FROM events;");
  expect(fromTable.database === "app_stage" && fromTable.connectionId === "conn-stage" && fromTable.schema === "analytics", "table editor schema switch changed fixed database");
  // Upgrade an editor persisted by the old in-place table-to-SQL action.
  // Seed after pagehide persistence so the restored app receives legacy data.
  await page.addInitScript(({ tableId, queryId }) => {
    const marker = "db-studio.verify-query-target.legacy-editor-seeded";
    if (sessionStorage.getItem(marker)) return;
    const key = "db-studio.workspace-tabs.v2";
    const saved = JSON.parse(localStorage.getItem(key));
    const source = saved.find((tab) => tab.id === tableId);
    Object.assign(saved.find((tab) => tab.id === queryId), {
      title: source.title, browse: source.browse, openedObject: source.openedObject, openedObjectView: "data", tableView: false,
    });
    localStorage.setItem(key, JSON.stringify(saved));
    sessionStorage.setItem(marker, "done");
  }, { tableId, queryId });
  const readsBeforeRestore = fixture.callsFor("execute_query").length;
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  expect(await schema.getAttribute("value") === "analytics" && await page.locator("#queryToolbar").isVisible(), "restoring a generic query rebound its table");
  expect(/^查询 \d+$/.test(await page.locator(".query-tab.active .tab-label").innerText()), "legacy editor retained its table title");
  expect(fixture.callsFor("execute_query").length === readsBeforeRestore, "restoring a generic query automatically executed table browsing SQL");
  // Opening with no active tabs can also inherit a selected schema directly.
  await page.locator(".query-tab.active").click({ button: "right" });
  await page.locator("[data-tab-context-action='close-all']").click();
  const restoredDatabase = page.locator(".tree-database[data-database='app_stage']");
  if (await restoredDatabase.getAttribute("open") === null) await restoredDatabase.locator(" > summary [data-tree-toggle]").click();
  await page.locator(".tree-schema[data-schema='analytics'] > summary").click();
  await page.locator("#addQueryTab").click();
  await ready();
  expect(await schema.getAttribute("value") === "analytics", "blank workspace ignored selected schema");
  await editor.fill("SELECT * FROM events;");
  // The custom menu keeps large catalogs searchable without changing targets
  // when merely browsing options or closing the menu.
  fixture.schemas.push(...["upsell", "agent_track", "aifeed", "aipage", "bestsourcing", "butler", "gift", "share", "shopify_test", "sonarfulfill", "tracking",
    ...Array.from({ length: 20 }, (_, i) => `warehouse_${i}`), 'team_<demo>_"schema"'].map((name) => ({ name })));
  await page.locator("#refreshQueryTarget").click();
  await ready();
  const search = page.locator("#querySchemaSearch");
  const menu = page.locator("#querySchemaMenu");
  const list = page.locator("#querySchemaList");
  await schema.focus();
  await page.keyboard.press("ArrowDown");
  expect(await search.evaluate((el) => el === document.activeElement), "keyboard opening did not focus search");
  expect(await list.locator("[aria-selected='true']").getAttribute("data-value") === "analytics", "menu lost selected schema");
  await search.fill("UPSELL");
  expect(await list.locator("[role='option']").count() === 1, "schema search is not case insensitive");
  expect(await schema.getAttribute("value") === "analytics", "search changed execution target before confirmation");
  await page.keyboard.press("Enter");
  expect(await schema.getAttribute("value") === "upsell" && await menu.isHidden(), "Enter did not select/close menu");
  await schema.click();
  await search.fill("no_matching_schema");
  await page.locator("#querySchemaEmpty").waitFor();
  await page.keyboard.press("Enter");
  expect(await schema.getAttribute("value") === "upsell", "empty search changed schema");
  await page.keyboard.press("Escape");
  expect(await menu.isHidden() && await schema.evaluate((el) => el === document.activeElement), "Escape did not restore trigger focus");
  await schema.click();
  expect(await search.inputValue() === "", "reopening retained stale filter");
  await search.fill("warehouse_");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await schema.getAttribute("value") === "warehouse_1", "arrow key navigation failed");
  await selectSchema("");
  expect((await schema.innerText()).includes("默认（public）"), "default search path not selectable");
  await selectSchema("public");
  expect(await schema.innerText() === "public", "explicit public schema confused with default search path");
  await schema.click();
  await page.keyboard.press("Tab");
  expect(await menu.isHidden() && await page.locator("#refreshQueryTarget").evaluate((el) => el === document.activeElement), "Tab did not return to toolbar order");
  await schema.click();
  await editor.click();
  expect(await menu.isHidden(), "outside click did not dismiss menu");
  await schema.click();
  await search.fill("team_");
  expect(await list.locator("[role='option']").innerText() === 'team_<demo>_"schema"', "schema name was interpreted as markup");
  await page.keyboard.press("Enter");
  expect(await schema.getAttribute("value") === 'team_<demo>_"schema"', "special schema name changed during selection");
  await schema.click();
  await page.locator("#addQueryTab").click();
  expect(await menu.isHidden(), "new tab retained previous schema menu");
  await selectSchema("upsell");
  for (const theme of ["dark", "light", "ocean", "forest", "contrast"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    for (const width of [1440, 1060]) {
      await page.setViewportSize({ width, height: width === 1060 ? 680 : 900 });
      await page.screenshot({ path: resolve(evidence, `target-${theme}-${width}.png`) });
      const layout = await page.locator("#queryTargetBar").evaluate((bar) => ({ width: bar.clientWidth, scroll: bar.scrollWidth }));
      expect(layout.scroll <= layout.width + 1, `destination clipped in ${theme} at ${width}`);
      expect(await schema.isVisible() && await run.isVisible(), "destination or execution hidden");
      const schemaBox = await schema.boundingBox();
      const runBox = await run.boundingBox();
      expect(Math.abs(schemaBox.y - runBox.y) < 8 && schemaBox.x < runBox.x, "schema is not beside Execute");
      expect(runBox.x + runBox.width <= width, "Execute is clipped");
      await schema.click();
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), "large schema list does not scroll");
      const menuBox = await menu.boundingBox();
      expect(menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y + menuBox.height <= (width === 1060 ? 680 : 900), "schema dropdown leaves viewport");
      const selected = list.locator("[aria-selected='true']");
      expect(await selected.getAttribute("data-value") === "upsell", "dropdown selected marker is stale");
      const contrast = await selected.evaluate((el) => {
        const css = getComputedStyle(el);
        const lum = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((c) => c / 255)
          .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const fg = lum(css.color), bg = lum(css.backgroundColor);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
      expect(contrast >= 4.5, `${theme}: schema selection contrast ${contrast}`);
      await page.screenshot({ path: resolve(evidence, `schema-menu-${theme}-${width}.png`) });
      await page.keyboard.press("Escape");
    }
  }
  await page.setViewportSize({ width: 700, height: 440 });
  await schema.click();
  const compact = await menu.boundingBox();
  expect(compact.x >= 0 && compact.x + compact.width <= 700 && compact.y + compact.height <= 440, "compact schema menu is clipped");
  await search.fill("warehouse_19");
  await page.keyboard.press("Enter");
  expect(await schema.getAttribute("value") === "warehouse_19", "compact menu cannot select last schema");
  expect(errors.length === 0, errors.join("; "));
  console.log("PASS: first table from an empty workspace, refresh/paging, prefilled queries, last-tab closure, searchable themed schema menu, keyboard/focus/dismissal, long catalogs and names, compact layout, toolbar lock removal, target binding/dispatch/isolation, persistence, transaction locks and stale responses.");
} finally {
  releaseQuery?.(); releaseContext?.();
  await browser.close();
  await new Promise((done) => server.close(done));
}
