import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, selectPostgresTarget } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/execution");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "mysql-execution", name: "MySQL test", driver: "mysql", database: "", host: "fixture", port: 3306, user: "tester" });
const editSources = {
  "conn-dev": { objectId: "8001", schema: "reporting", name: "orders", attributes: [1, 2] },
  "mysql-execution": { objectId: 'mysql:table:["warehouse","orders"]', schema: "warehouse", name: "orders", attributes: ["id", "name"] },
};
const ddlStatements = [
  `ALTER TABLE upsell.upsell_cart_modules
  ADD COLUMN IF NOT EXISTS enable_celebration BOOLEAN NOT NULL DEFAULT FALSE`,
  `COMMENT ON COLUMN upsell.upsell_cart_modules.enable_celebration IS
  '阶梯奖励解锁特效开关; 仅 TIERED_REWARDS 使用，默认关闭，不影响奖励计算'`,
];
const sql = `${ddlStatements.join(";\n\n")};`;
const mixedStatements = ["SELECT 1", "ALTER TABLE app.orders ADD COLUMN flag boolean"];
const mixedSql = `${mixedStatements.join("; ")};`;
const insertSql = "INSERT INTO app.orders (note) VALUES ('<b>test</b>');";
const manyInserts = Array.from({ length: 20 }, (_, index) => `INSERT INTO app.orders (note) VALUES ('row ${index + 1}')`);
const manyInsertsSql = `${manyInserts.join(";\n")};`;
const returningSql = "INSERT INTO app.orders (note) VALUES ('test') RETURNING id;";
const emptySelect = "SELECT id FROM app.orders WHERE FALSE;";
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
let failureMessage = "";
let copiedError = "";
let mysqlContextUnavailable = false;
const mysqlDatabases = [{ name: "warehouse" }, { name: "archive" }];
await context.exposeFunction("__FIXTURE_INVOKE__", async (command, args) => {
  if (command === "write_clipboard_text") {
    copiedError = args.text;
    return;
  }
  if (command === "get_object_details" && Object.values(editSources).some(source => source.objectId === args.objectId)) {
    const source = editSources[args.connectionId];
    return { id: source.objectId, schema: source.schema, name: source.name, kind: "table", columns: [
      { name: "id", ordinalPosition: 1, primaryKey: true, dataType: "bigint" },
      { name: "name", ordinalPosition: 2, nullable: true, dataType: "text" },
    ] };
  }
  if (command === "get_query_context" && args?.connectionId === "mysql-execution") {
    if (mysqlContextUnavailable) throw new Error("fixture MySQL context unavailable");
    return { database: args.database || "", defaultSchema: args.database || null, searchPath: [] };
  }
  if (command === "list_databases" && args?.connectionId === "mysql-execution") {
    return mysqlDatabases;
  }
  const result = await fixture.invoke(command, args);
  const text = args?.request?.sql;
  if (failureMessage && ["execute_query", "execute_mutation", "begin_transaction"].includes(command)) {
    throw new Error(failureMessage);
  }
  if (command === "execute_query" && /^SELECT (\*|name) FROM orders WHERE/u.test(text)) {
    const source = editSources[args.request.connectionId];
    const full = text.startsWith("SELECT *");
    expect(JSON.stringify(args.request.queryEditRelation) === '["orders"]', "single-table SELECT did not request editing metadata");
    return { columns: full ? ["id", "name"] : ["name"], rows: full ? [["42", "old"]] : [["old"]],
      editSource: full ? source : { ...source, attributes: source.attributes.slice(1) } };
  }
  if (command === "execute_mutation") {
    if (text === sql || text === mixedSql) {
      return {
        columns: [], rows: [], row_count: 0, elapsed_ms: 4.2, statement_count: 2,
        statement_summaries: (text === sql ? ddlStatements : mixedStatements).map((sql, index) => {
          const has_result_set = text === mixedSql && index === 0;
          return { sql, elapsed_ms: index === 0 ? 1.2 : 3, row_count: has_result_set ? 1 : 0, has_result_set };
        }),
      };
    }
    if (text === returningSql) return { columns: ["id"], rows: [["1"]], row_count: 1, elapsed_ms: 2.1 };
    if (text === manyInsertsSql) return {
      ...result,
      statement_summaries: manyInserts.map(sql => ({ sql, elapsed_ms: 0.4, row_count: 1, has_result_set: false })),
    };
  }
  if (command === "execute_query" && text === emptySelect) return { columns: ["id"], rows: [], row_count: 0, elapsed_ms: 0.5 };
  return result;
});
await context.addInitScript(() => { window.confirm = () => { throw new Error("browser confirmation must not be used"); }; });
const page = await context.newPage();

const expect = (ok, message) => { if (!ok) throw new Error(message); };
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const modal = page.locator("#confirmActionModal");
const editor = page.locator("#sqlEditor .cm-content");
const accept = page.locator("#confirmActionAccept");
const resultPane = page.locator("#resultsPane");
const resultHeading = resultPane.locator(".result-heading");
const editorPane = page.locator("#editorPane");
const editorSplitter = page.locator("#editorSplitter");
const dataTab = page.locator("#resultTab");
const summaryTab = page.locator("#messageTab");
const summary = page.locator("#executionSummary");
const summaryRows = summary.locator("tbody tr");
const detailModal = page.locator("#executionDetailsModal");
const assertPointerDismissal = async trigger => {
  await detailModal.waitFor({ state: "hidden" });
  await page.waitForFunction(button => document.activeElement !== button, await trigger.elementHandle());
};
const verifyFailure = async ({ sql, error, database, number, preview }) => {
  const row = summaryRows.first();
  const details = row.getByRole("button", { name: /详情/ });
  await row.getByText("失败", { exact: true }).waitFor();
  expect(await summaryRows.count() === 1, "failed attempt displayed invented success rows");
  expect(await row.locator("td").first().textContent() === number, "failed attempt displayed a misleading statement number");
  expect(await row.locator(".summary-failure").count() === 1, "failed row has no error styling");
  expect((await row.locator("td").last().innerText()).includes(preview), "result cell is missing the database diagnostic");
  expect(await dataTab.isHidden() && await summaryTab.innerText() === "摘要", "failure did not use the compact summary layout");
  expect(await page.locator("#queryMessage").isHidden(), "failure showed duplicate raw output");
  await details.focus();
  await page.keyboard.press("Enter");
  await detailModal.waitFor();
  expect(await detailModal.locator("#executionErrorMessage").textContent() === error, "details lost the original error");
  expect(await detailModal.locator("#executionDetailsSql").textContent() === sql, "details lost the executed SQL");
  expect((await detailModal.locator("#executionDetailsTarget").textContent()).includes(database), "details lost the execution target");
  await detailModal.getByRole("button", { name: "复制错误" }).click();
  await detailModal.getByRole("button", { name: "已复制" }).waitFor();
  expect(copiedError === error, "copied error was truncated or changed");
  await page.keyboard.press("Escape");
  await detailModal.waitFor({ state: "hidden" });
  expect(await details.evaluate(button => document.activeElement === button), "closing the dialog did not restore focus");
  await details.click();
  await detailModal.waitFor();
  const diagnostic = await detailModal.locator("#executionErrorMessage").boundingBox();
  await page.mouse.move(diagnostic.x + 16, diagnostic.y + 16);
  await page.mouse.down();
  await page.mouse.move(10, 10, { steps: 5 });
  await page.mouse.up();
  expect(await detailModal.isVisible(), "dragging out of the failure details closed the dialog");
  await page.mouse.click(10, 10);
  await assertPointerDismissal(details);
};
const verifyQueryEditing = async updateSql => {
  const grid = page.locator("#resultGrid .db-grid-viewport");
  const editable = page.locator('#resultGrid [data-position="0"][data-column-index="1"]');
  await editor.fill("SELECT * FROM orders WHERE id = 42 ORDER BY id;");
  await page.locator("#runQuery").click();
  await grid.and(page.locator('[aria-readonly="false"]')).waitFor();
  await editable.dblclick();
  await page.locator(".db-grid-edit-input").fill("updated");
  await page.locator("#saveTableChanges").click();
  await page.waitForFunction(() => document.querySelector('#resultGrid [data-position="0"][data-column-index="1"]')?.textContent === "updated").catch(async error => {
    throw new Error(`${error.message}\nGrid: ${await editable.innerText()}\nToast: ${await page.locator("#toast").textContent()}\nCalls: ${JSON.stringify(fixture.callsFor("execute_mutation").slice(-1))}\n${errors.join("\n")}`);
  });
  expect(fixture.callsFor("execute_mutation").at(-1).args.request.sql === updateSql, "query edit used the wrong write target or row identifier");
  await editor.fill("SELECT name FROM orders WHERE id = 42;");
  await page.locator("#runQuery").click();
  await page.waitForFunction(() => !document.querySelector("#runQuery").disabled && document.querySelector("#resultCount").textContent === "1");
  await page.locator('#resultGrid [data-position="0"][data-column-index="0"]').click({ button: "right" });
  expect(await page.locator('[data-cell-action="edit"]').isDisabled(), "projection without primary key was editable");
  await page.keyboard.press("Escape");
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("[data-display-databases]").click();
  await page.locator("#databaseList input[value='app_reporting']").check();
  await page.locator("#applyDatabasePicker").click();
  await page.locator(".tree-database[data-database='app_reporting'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  expect(await resultPane.isHidden() && await page.locator("#editorSplitter").isHidden(), "new SQL editor reserved space for results");
  const footer = page.locator("#editorFooter");
  const footerAtBottom = async () => Math.abs((await footer.boundingBox()).y + (await footer.boundingBox()).height - ((await page.locator('#editorResult').boundingBox()).y + (await page.locator('#editorResult').boundingBox()).height)) <= 1;
  expect(await footerAtBottom(), "editor status bar is not at the bottom of the workspace");
  const alignedFooters = async () => Math.abs((await footer.boundingBox()).y - (await page.locator('#draftSaveStatus').boundingBox()).y) <= 1 && Math.abs((await footer.boundingBox()).y - (await page.locator('#objectSelection').boundingBox()).y) <= 1;
  expect(await alignedFooters(), "editor status bar does not align with sidebar footers");
  await editor.fill(sql);
  const before = fixture.callsFor("execute_mutation").length;
  await page.locator("#runQuery").click();
  await summary.waitFor();
  expect(await modal.isHidden(), "SQL unexpectedly prompted for confirmation");
  expect(fixture.callsFor("execute_mutation").length === before + 1, "SQL was not executed once");
  const request = fixture.callsFor("execute_mutation").at(-1).args.request;
  expect(request.database === "app_reporting" && request.sql === sql, "batch lost SQL/database binding");
  expect(await dataTab.isHidden() && await summaryTab.getAttribute("aria-selected") === "true", "DDL showed an empty data tab");
  expect(await summaryRows.count() === 2, "batch did not show both statement summaries");
  const ddlPreview = summaryRows.nth(1).locator("td").nth(1);
  expect(await ddlPreview.locator(".selectable-text").textContent() === ddlStatements[1], "SQL text with a semicolon was split incorrectly");
  expect((await summaryRows.first().innerText()).includes("1.2 ms\t成功\t影响 0 行"), "statement elapsed time, status or affected rows missing");
  const twoRowHeight = (await resultPane.boundingBox()).height;
  const viewSql = ddlPreview.getByRole("button", { name: "查看 SQL" });
  await viewSql.click();
  await detailModal.getByRole("heading", { name: "查看 SQL" }).waitFor();
  expect(await detailModal.locator("#executionDetailsSql").textContent() === ddlStatements[1], "SQL preview truncated a multi-line statement");
  expect(await detailModal.locator("#executionDiagnostic").isHidden(), "successful SQL preview contained an error");
  await detailModal.getByRole("button", { name: "复制 SQL" }).click();
  await detailModal.getByRole("button", { name: "已复制" }).waitFor();
  expect(copiedError === ddlStatements[1], "copied SQL lost the original text");
  await detailModal.getByRole("button", { name: "关闭" }).click();
  await assertPointerDismissal(viewSql);
  await page.screenshot({ path: resolve(evidence, "execution-summary-dark.png") });
  failureMessage = "第 2 条 SQL 执行失败（42703）：fixture missing column";
  await page.locator("#runQuery").click();
  await verifyFailure({ sql, error: failureMessage, database: "app_reporting", number: "—", preview: "第 2 条 SQL" });
  await page.screenshot({ path: resolve(evidence, "execution-failure-dark.png") });
  expect(await page.locator("#runQuery").isEnabled(), "failed query left execution disabled");
  failureMessage = "";
  await editor.fill(mixedSql);
  await page.locator("#runQuery").click();
  await summaryRows.first().getByText("返回 1 行").waitFor();
  expect(fixture.callsFor("execute_mutation").at(-1).args.request.sql.startsWith("SELECT 1; ALTER"), "mixed script incorrectly sent to read-only path");
  expect(await dataTab.isHidden(), "mixed script showed a data tab for its final DDL statement");

  await editor.fill(insertSql);
  await page.locator("#runQuery").click();
  await summaryRows.first().getByText("影响 1 行").waitFor();
  expect((await summaryRows.first().locator(".summary-preview .selectable-text").first().textContent()) === insertSql, "statement did not render as literal SQL text");
  expect(await summary.locator("b").count() === 0, "SQL was interpreted as HTML");
  expect(await dataTab.isHidden() && await page.locator("#resultGrid").isHidden(), "INSERT displayed an empty data result");
  const oneRowHeight = (await resultPane.boundingBox()).height;
  const tableHeight = (await summary.boundingBox()).height;
  const headingHeight = (await resultHeading.boundingBox()).height;
  expect(oneRowHeight <= 86, "single-row summary is not compact");
  expect(Math.abs(oneRowHeight - tableHeight - headingHeight) <= 1, "single INSERT reserved space beyond its tabs and summary table");
  expect(Math.abs(twoRowHeight - oneRowHeight - (await summaryRows.first().boundingBox()).height) <= 1, "summary pane did not grow by one row");
  expect(await editorSplitter.isVisible(), "summary resize handle is hidden");
  const compactHeight = (await resultPane.boundingBox()).height;
  const summaryHeight = async () => (await resultPane.boundingBox()).height;
  const handle = await editorSplitter.boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  expect(Math.abs(await summaryHeight() - compactHeight) <= 1, "pressing the divider jumped away from the compact height");
  await page.mouse.up();
  expect(Math.abs(await summaryHeight() - compactHeight) <= 1, "clicking the divider expanded the summary");
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 6 });
  expect(Math.abs(await summaryHeight() - compactHeight - 60) <= 2, "summary did not follow the pointer during an upward drag");
  expect(await footerAtBottom(), "editor status bar moved while resizing the summary");
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs(await summaryHeight() - compactHeight) <= 1, "dragging back down could not restore the compact height");
  await editorSplitter.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(100);
  expect(Math.abs(await summaryHeight() - compactHeight - 10) <= 2, "keyboard resize did not move one step");
  const resizedHeight = await summaryHeight();
  const executionCount = fixture.callsFor("execute_mutation").length;
  await page.locator('#runQuery').click();
  await page.waitForFunction(() => !document.querySelector('#runQuery').disabled && document.querySelector('#executionSummary tbody tr'));
  expect(fixture.callsFor("execute_mutation").length === executionCount + 1, "repeat execution did not complete");
  expect(Math.abs(await summaryHeight() - resizedHeight) <= 1, "repeat execution reset the summary height");
  expect(await alignedFooters(), "editor status bar moved away from sidebar footers");
  await editorSplitter.dblclick();
  expect(Math.abs(await summaryHeight() - compactHeight) <= 1, "double-click did not restore the compact height");
  await page.locator("#themeButton").click();
  await page.locator("[data-theme-option='light']").click();
  await page.screenshot({ path: resolve(evidence, "execution-summary-light.png") });

  await editor.fill(manyInsertsSql);
  await page.locator("#runQuery").click();
  await summaryRows.nth(19).waitFor({ state: "attached" });
  for (const height of [900, 600]) {
    await page.setViewportSize({ width: 1440, height });
    expect((await editorPane.boundingBox()).height > (await resultPane.boundingBox()).height, "many summaries took most of the editor space");
    const scrollState = await page.locator("#messagePanel").evaluate(panel => {
      panel.scrollTop = panel.scrollHeight;
      const bounds = panel.getBoundingClientRect();
      return {
        scrollTop: panel.scrollTop,
        headerOffset: panel.querySelector("thead th").getBoundingClientRect().top - bounds.top,
        finalRowOverflow: panel.querySelector("tbody tr:last-child").getBoundingClientRect().bottom - bounds.bottom,
      };
    });
    expect(scrollState.scrollTop > 0 && Math.abs(scrollState.headerOffset) <= 1 && scrollState.finalRowOverflow <= 1,
      `long summary did not scroll with a sticky header at ${height}px: ${JSON.stringify(scrollState)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await editor.fill(returningSql);
  await page.locator("#runQuery").click();
  await page.locator("#resultGrid").waitFor();
  expect(await footerAtBottom(), "editor status bar is not at the bottom when data is shown");
  expect(await dataTab.getAttribute("aria-selected") === "true", "INSERT RETURNING did not open data");
  const dataHeadingHeight = (await resultHeading.boundingBox()).height;
  expect(dataHeadingHeight > headingHeight && dataHeadingHeight >= 44, "data controls lost their toolbar height");
  expect(await page.locator("#resultFooter").isHidden(), "SQL data showed a second status bar");
  expect(await page.locator("#editorFooter .db-grid-footer-status").isVisible(), "data grid status did not move to the shared bar");
  expect(await editorSplitter.isVisible(), "data result did not restore the resize handle");
  await page.screenshot({ path: resolve(evidence, "execution-data-light.png") });
  await page.setViewportSize({ width: 960, height: 680 });
  expect(Math.abs((await resultHeading.boundingBox()).height - dataHeadingHeight) <= 1, "data toolbar wrapped in a narrow desktop window");
  await page.locator("#resultFilter").fill("no-match");
  expect(await page.locator("#editorFooter #resultMeta").getAttribute("title").then(title => title.includes("已过滤")), "data filter status is missing");
  await page.locator("#resultFilter").fill("");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dividerTop = (await editorSplitter.boundingBox()).y;
  await summaryTab.click();
  await summaryRows.first().getByText("返回 1 行").waitFor();
  expect(Math.abs((await editorSplitter.boundingBox()).y - dividerTop) <= 1, "switching output tabs moved the divider");
  await page.setViewportSize({ width: 1440, height: 900 });

  await editor.fill(emptySelect);
  await page.locator("#runQuery").click();
  await page.locator("#resultGrid").waitFor();
  expect(await page.locator("#resultCount").innerText() === "0", "SELECT with zero rows lost its data tab");
  failureMessage = "查询失败（42P01）：relation does not exist";
  await page.locator("#runQuery").click();
  await verifyFailure({ sql: emptySelect, error: failureMessage, database: "app_reporting", number: "1", preview: "42P01" });
  failureMessage = "";

  // Selection remains authoritative: execute only the selected SELECT.
  await editor.fill("SELECT 42;\nALTER TABLE app.orders ADD COLUMN flag boolean;");
  await page.keyboard.press("Meta+Home");
  await page.keyboard.press("Shift+End");
  await page.locator("#runQuery").click();
  await page.waitForFunction(() => !document.querySelector("#runQuery").disabled && document.querySelector("#resultCount").textContent === "2");
  expect(fixture.callsFor("execute_query").at(-1).args.request.sql === "SELECT 42;", "selected SQL execution included unselected mutation");
  expect(await modal.isHidden(), "read-only selection unexpectedly prompted");

  await page.locator("#addQueryTab").click();
  await selectPostgresTarget(page, "app_reporting", "reporting");
  await editor.fill("SELECT /* fixture_delay */ 1;");
  await page.locator("#runQuery").click();
  await page.waitForFunction(() => !document.querySelector("#stopQuery").disabled);
  expect(await resultPane.isHidden(), "running a new query opened the output before its response");
  await page.locator("#stopQuery").click();
  await page.locator("#queryMessage").getByText("查询已取消", { exact: false }).waitFor();
  expect(await dataTab.isHidden(), "cancelled query showed an empty data tab");
  await verifyQueryEditing(`UPDATE ONLY "reporting"."orders" SET "name" = E'updated' WHERE "id" IS NOT DISTINCT FROM E'42';`);

  const originalTabId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  await page.locator("[data-connection-id='conn-stage']").click();
  const stageDatabase = page.locator(".tree-database[data-database='app_stage']");
  await stageDatabase.locator(":scope > summary [data-tree-toggle]").click();
  const analytics = stageDatabase.locator(".tree-schema[data-schema='analytics']");
  await analytics.locator(":scope > summary [data-tree-toggle]").click();
  await analytics.locator(".tree-category[data-kind='table'] .category-summary").click();
  expect(await page.locator(".query-tab.active").getAttribute("data-tab-id") === originalTabId, "tree selection changed the active query before opening a new tab");
  await page.locator("#addQueryTab").click();
  expect(await page.locator('#querySchema').getAttribute('value') === 'analytics', "new query did not inherit the selected Schema");
  await editor.fill("SELECT 43;");
  await page.locator("#runQuery").click();
  await page.locator("#resultGrid").waitFor();
  const stageRequest = fixture.callsFor("execute_query").at(-1).args.request;
  expect(stageRequest.connectionId === "conn-stage" && stageRequest.database === "app_stage" && stageRequest.schema === "analytics",
    "new query ignored the browser's selected connection, database or schema");
  await page.locator(`.query-tab[data-tab-id="${originalTabId}"] .tab-select`).click();
  expect((await page.locator("#editorHint").textContent()).includes("开发库 / app_reporting"), "new query rebound the older tab to the browser");

  await page.locator("[data-connection-id='mysql-execution']").click();
  await page.locator(".mysql-database[data-database='warehouse']").waitFor();
  await page.locator("#addQueryTab").click();
  const mysqlTarget = page.locator("#querySchema");
  await page.waitForFunction(() => !document.querySelector("#runQuery").disabled);
  expect(await mysqlTarget.innerText() === "选择数据库", "a MySQL connection without a default only showed an inert status");
  const mysqlRun = async text => {
    await editor.fill(text);
    await page.locator("#runQuery").click();
    await page.waitForFunction(() => !document.querySelector("#runQuery").disabled);
  };
  await mysqlRun("SELECT 1;");
  expect(fixture.callsFor("execute_query").at(-1).args.request.database === null, "SQL that can run without a database was blocked or assigned an arbitrary target");
  mysqlDatabases.push({ name: "newly_added" });
  await mysqlTarget.click();
  await page.getByRole("option", { name: "newly_added" }).waitFor();
  await page.getByRole("combobox", { name: "搜索数据库" }).fill("archive");
  await page.getByRole("option", { name: "archive" }).click();
  await page.waitForFunction(() => !document.querySelector("#runQuery").disabled);
  expect(await editor.innerText() === "SELECT 1;" && await page.locator("#resultGrid").isHidden(), "changing database lost SQL or retained old results");
  await mysqlRun("SELECT 42;");
  expect(fixture.callsFor("execute_query").at(-1).args.request.database === "archive", "selected MySQL database was not used");
  const archiveTabId = await page.locator(".query-tab.active").getAttribute("data-tab-id");
  const savedDatabase = await page.evaluate(id => JSON.parse(localStorage.getItem("db-studio.workspace-tabs.v2")).find(tab => tab.id === id)?.database, archiveTabId);
  expect(savedDatabase === "archive", "selected MySQL database was not persisted");
  await page.locator("#addQueryTab").click();
  expect(await mysqlTarget.innerText() === "archive", "new query lost the current database on the same MySQL connection");
  await page.locator(".mysql-database[data-database='warehouse'] > summary .tree-label").click();
  expect(await mysqlTarget.innerText() === "archive", "selecting a tree database silently changed an existing tab");
  mysqlContextUnavailable = true;
  await page.locator("#addQueryTab").click();
  const targetFeedback = page.locator("#queryTargetDetail");
  await targetFeedback.getByText(/fixture MySQL context unavailable/).waitFor();
  mysqlContextUnavailable = false;
  await mysqlTarget.click();
  await targetFeedback.waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  const mysqlSelect = "SELECT 42;";
  const mysqlInsert = "INSERT INTO `warehouse`.`orders` (`name`) VALUES ('test');";
  const run = mysqlRun;
  await run(mysqlSelect);
  await page.locator("#resultGrid").waitFor();
  expect((await page.locator("#editorHint").innerText()).startsWith("MySQL ·"), "MySQL target is missing from the shared status bar");
  expect(await page.locator("#editorFooter .db-grid-footer-status").isVisible(), "MySQL data grid status has a different layout");
  expect(Math.abs((await resultHeading.boundingBox()).height - dataHeadingHeight) <= 1, "MySQL data has a different header");
  expect(await page.locator("#refreshQueryTarget").count() === 0, "MySQL showed a separate refresh button");
  await run(mysqlInsert);
  await summaryRows.first().getByText("影响 1 行").waitFor();
  expect(await dataTab.isHidden() && await summaryTab.isVisible(), "MySQL INSERT should display the shared summary tab");
  expect(await page.locator("#editorFooter #resultMeta").isVisible(), "MySQL summary status is missing");
  expect(Math.abs((await resultHeading.boundingBox()).height - headingHeight) <= 1, "MySQL summary has a different header");
  await editorSplitter.focus();
  await page.keyboard.press("ArrowUp");
  const mysqlSummaryHeight = await summaryHeight();
  await run(mysqlInsert);
  expect(Math.abs(await summaryHeight() - mysqlSummaryHeight) <= 1, "MySQL repeat execution reset the summary height");
  const mysqlRequest = fixture.callsFor("execute_mutation").at(-1).args.request;
  expect(mysqlRequest.connectionId === "mysql-execution" && mysqlRequest.database === "warehouse", "MySQL query used another connection or database");
  failureMessage = "第 1 条 MySQL SQL 执行失败：Server error: `ERROR 1062 (23000): Duplicate entry '255' for key 'orders.PRIMARY'`";
  await run(mysqlInsert);
  await verifyFailure({ sql: mysqlInsert, error: failureMessage, database: "warehouse", number: "1", preview: "ERROR 1062 (23000): Duplicate entry" });
  expect(Math.abs(await summaryHeight() - mysqlSummaryHeight) <= 1, "failure reset the manually resized summary height");
  expect(await alignedFooters(), "failure moved the status bar");
  await page.screenshot({ path: resolve(evidence, "execution-failure-light.png") });
  await summaryRows.first().getByRole("button", { name: /详情/ }).click();
  await page.screenshot({ path: resolve(evidence, "execution-error-details-light.png"), animations: "disabled" });
  await detailModal.getByRole("button", { name: "关闭" }).click();
  failureMessage = "开启 MySQL 事务失败：fixture transaction error";
  await run("BEGIN;");
  await verifyFailure({ sql: "BEGIN;", error: failureMessage, database: "warehouse", number: "1", preview: "fixture transaction error" });
  failureMessage = "";
  await verifyQueryEditing("UPDATE `warehouse`.`orders` SET `name` = CONVERT(X'75706461746564' USING utf8mb4) WHERE `id` <=> 42;");
  expect(errors.length === 0, errors.join("\n"));
  console.log("PASS: PostgreSQL and MySQL share compact execution summaries with failure details, a status bar and retained resize height.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
