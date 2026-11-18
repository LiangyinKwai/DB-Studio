import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/editor-assistance");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
fixture.profiles.push({ id: "mysql-local", name: "MySQL 开发库", driver: "mysql", host: "mysql.fixture", port: 3306, database: "warehouse", user: "fixture" });
fixture.objectsBySchema.analytics.push({ id: "analytics.orders", schema: "analytics", name: "orders", kind: "table",
  columns: [{ name: "archived_status", dataType: "text" }] });
fixture.objectsBySchema.warehouse = [{ id: "warehouse.inventory", schema: "warehouse", name: "inventory", kind: "table",
  columns: [{ name: "sku", dataType: "varchar(50)" }] }];
fixture.objectsBySchema.warehouse_reporting = [{ id: "warehouse_reporting.private_inventory", schema: "warehouse_reporting", name: "private_inventory", kind: "table",
  columns: [{ name: "private_sku" }] }];
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
fixture.tableObjects[0].columns.push({ name: "Order Status", dataType: "text", comment: "带空格的字段" });
const page = await context.newPage();

const expect = (ok, message) => { if (!ok) throw new Error(message); };
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
const measurements = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='conn-dev']").click();
  await page.locator("#connectionMode").getByText("已连接", { exact: true }).waitFor();
  await page.locator("#addQueryTab").click();
  const editor = page.locator("#sqlEditor .cm-content");
  const selectedOption = page.locator(".cm-tooltip-autocomplete li[aria-selected='true']");
  async function suggest(sql) {
    await editor.fill(sql);
    await page.keyboard.press("Control+Space");
    await selectedOption.waitFor();
    // CodeMirror deliberately ignores acceptance keys just after opening.
    await page.waitForTimeout(100);
  }
  for (const theme of ["dark", "light"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    await suggest("SELECT * FROM orders WHERE st");
    expect(await selectedOption.locator(".cm-completionLabel").innerText() === "status", `${theme}: field ranked behind keywords`);
    expect(await selectedOption.locator(".cm-completionKind").innerText() === "字段", "field category missing");
    expect((await selectedOption.innerText()).includes("text · public.orders"), "field source/type missing");
    await page.locator(".cm-completionInfo").getByText("订单状态").waitFor();
    await page.screenshot({ path: resolve(evidence, `${theme}-completion.png`) });
    await page.keyboard.press("Tab");
    expect((await editor.innerText()).endsWith("WHERE status"), "Tab failed to accept field");
    expect(await page.locator(".cm-tooltip-autocomplete").isHidden(), "Tab left menu open");

    await editor.fill("SELECT status, status, status_code FROM orders;");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+Home");
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.locator(".cm-selectionMatch").waitFor();
    expect(await page.locator(".cm-selectionMatch").count() === 1, "occurrences matched partial identifier or selection itself");
    expect(await page.locator("#runLabel").innerText() === "执行选中", "execution scope label missing");
    expect((await page.locator("#cursorPosition").innerText()).includes("已选 6 字符"), "selection count missing");
    await page.screenshot({ path: resolve(evidence, `${theme}-occurrences.png`) });

    await editor.fill("SELECT status, 'ACTIVE', 123\nFROM orders\nWHERE status = 'ACTIVE'; -- 订单状态");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+A");
    await page.locator(".cm-selectionBackground").first().waitFor();
    expect((await page.locator("#cursorPosition").innerText()).includes("/ 3 行"), "multiline selection count missing");
    const contrast = await page.evaluate(() => {
      const rgba = (v) => { const c = v.match(/[\d.]+/g).map(Number); return [...c.slice(0, 3), c[3] ?? 1]; };
      const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
      const luminance = (c) => c.slice(0, 3).map((x) => x / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
        .reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const selection = getComputedStyle(document.querySelector(".cm-selectionBackground"));
      const bg = rgba(selection.backgroundColor);
      const colors = [...document.querySelectorAll(".cm-line, .cm-line span")].map((el) => {
        const style = getComputedStyle(el);
        return { text: el.textContent, color: style.color, lineBackground: getComputedStyle(el.closest(".cm-line")).backgroundColor,
          ratio: ratio(rgba(style.color), blend(rgba(getComputedStyle(el.closest(".cm-line")).backgroundColor), bg)) };
      });
      return { background: selection.backgroundColor, edge: selection.boxShadow,
        line: getComputedStyle(document.querySelector(".cm-activeLine")).backgroundColor, colors };
    });
    measurements.push({ theme, ...contrast });
    writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ measurements, failures }, null, 2));
    await page.screenshot({ path: resolve(evidence, `${theme}-selection.png`) });
    expect(contrast.background !== contrast.line, `${theme}: selection and current line indistinct`);
    expect(contrast.edge === "none", `${theme}: selection still has a per-line outline`);
    for (const item of contrast.colors) expect(item.ratio >= 4.5, `${theme}: selected ${item.text} contrast ${item.ratio.toFixed(2)}`);
    await page.locator("#runQuery").focus();
    expect(await page.locator(".cm-selectionBackground").first().isVisible(), "selection disappears when editor loses focus");
    await editor.focus();
    await editor.fill('SELECT *\nFROM "upsell"."shop_accounts"\nLIMIT 501 OFFSET 0;');
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+A");
    await page.screenshot({ path: resolve(evidence, `${theme}-table-query-selection.png`) });
    await page.keyboard.press("ArrowRight");
    expect(await page.locator("#runLabel").innerText() === "执行", "execution scope label did not reset");
  }
  await suggest("SELECT * FROM public.orders o WHERE o.Or");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "Order Status", "quoted field suggestion missing");
  await page.keyboard.press("Enter");
  expect((await editor.innerText()).endsWith('o."Order Status"'), "Enter inserted invalid quoted identifier");
  await editor.fill("SELECT 1;");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Home");
  await page.keyboard.press("Tab");
  expect(/^\s+SELECT/.test(await editor.innerText()), "Tab no longer indents with menu closed");

  await suggest("SELECT * FROM or");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "orders", "current schema did not rank first");
  expect(await selectedOption.locator(".cm-completionDetail").innerText() === "public", "current schema table source missing");
  const secondary = page.locator(".cm-tooltip-autocomplete li").filter({ has: page.locator(".cm-completionLabel").getByText("analytics.orders", { exact: true }) });
  await secondary.waitFor();
  await page.screenshot({ path: resolve(evidence, "same-db-schema-completion.png") });
  await secondary.click();
  expect((await editor.innerText()).endsWith("FROM analytics.orders"), "other schema table inserted without qualification");
  await suggest("SELECT * FROM analytics.orders o WHERE o.arc");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "archived_status", "explicit cross-schema relation did not determine fields");
  expect(!(await page.locator(".cm-completionLabel").getByText("status", { exact: true }).count()), "fields leaked from an unrelated current-schema table");
  await page.keyboard.press("Escape");
  await page.locator("#querySchema").click();
  await page.locator("#querySchemaList [data-value='analytics']").click();
  await suggest("SELECT * FROM or");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "orders" &&
    await selectedOption.locator(".cm-completionDetail").innerText() === "analytics", "schema switch retained the old completion priority");
  expect(await page.locator(".cm-completionLabel").getByText("public.orders", { exact: true }).count() === 1, "previous schema disappeared from same-database alternatives");
  await page.keyboard.press("Escape");

  await page.locator("[data-connection-id='mysql-local']").click();
  await page.locator(".tree-database[data-database='warehouse'] > summary").click({ button: "right" });
  await page.locator("[data-context-action='new-database-query']").click();
  await page.locator("#runQuery").waitFor({ state: "visible" });
  await suggest("SELECT * FROM inv");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "inventory", "MySQL current-database table not suggested");
  expect(await page.locator("#querySchema").isHidden(), "MySQL exposes a PostgreSQL schema selector");
  expect(fixture.callsFor("get_schema_objects").filter((call) => call.args.connectionId === "mysql-local")
    .every((call) => call.args.database === "warehouse" && call.args.schemaName === "warehouse"), "MySQL completion queried another database");
  expect(!(await page.locator(".cm-completionLabel").getByText("private_inventory", { exact: true }).count()), "MySQL suggests another database");
  await page.screenshot({ path: resolve(evidence, "mysql-current-db-completion.png") });
  await suggest("SELECT * FROM inventory i WHERE i.sk");
  expect(await selectedOption.locator(".cm-completionLabel").innerText() === "sku", "MySQL alias fields do not follow SQL relations");
  await page.keyboard.press("Tab");
  expect((await editor.innerText()).endsWith("i.sku"), "MySQL field completion inserted an invalid identifier");
  expect(!failures.length, failures.join("\n"));
  writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ measurements, failures }, null, 2));
  console.log("PASS: schema priority and qualified alternatives, SQL relation fields, MySQL database isolation, metadata, Tab/Enter acceptance and editor assistance in light and dark themes.");
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
