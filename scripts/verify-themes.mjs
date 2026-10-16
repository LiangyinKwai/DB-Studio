import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

// Fixture data verifies visual states, not database runtime behavior.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/themes");
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
const failures = [];
const measurements = [];
page.on("pageerror", (error) => failures.push(error.message));
const expect = (ok, message) => { if (!ok) throw new Error(message); };
const themeOptions = ["dark", "light", "ocean", "forest", "contrast"];
async function selectTheme(theme) {
  await page.locator("#themeButton").click();
  await page.locator(`[data-theme-option='${theme}']`).click();
  expect(await page.locator("body").getAttribute("data-theme") === theme, `failed to select ${theme}`);
}

async function measure(selector, label, minRatio = 4.5) {
  await page.locator(selector).first().waitFor();
  const result = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`missing ${selector}`);
    const rgba = (value) => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const chain = [];
    for (let el = node; el; el = el.parentElement) chain.unshift(el);
    let background = [255, 255, 255];
    for (const el of chain) background = blend(rgba(getComputedStyle(el).backgroundColor), background);
    const css = getComputedStyle(node);
    const foreground = blend(rgba(css.color), background);
    const luminance = (color) => color.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(foreground), b = luminance(background);
    return { color: css.color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  }, selector);
  measurements.push({ theme: await page.locator("body").getAttribute("data-theme"), label, ...result });
  expect(result.ratio >= minRatio, `${label}: contrast ${result.ratio.toFixed(2)} < ${minRatio}`);
  return result.color;
}

async function verifyVisibilityPicker(theme, kind) {
  const database = kind === "database";
  const modal = database ? "#databaseModal" : "#schemaModal";
  const close = database ? "#closeDatabasePicker" : "#closeSchemaPicker";
  try {
    // Query completion loads its own catalog; the object tree is lazy-loaded.
    if (!database) {
      const treeDatabase = page.locator(".tree-database[data-database='app']");
      if (await treeDatabase.getAttribute("open") === null) await treeDatabase.locator(":scope > summary").click();
      await treeDatabase.locator(".tree-schema").first().waitFor();
    }
    await page.locator(database ? "[data-display-databases]" : "[data-display-schemas='app']").click();
    await page.locator(modal).waitFor();
    const colors = await page.locator(modal).evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      surface: getComputedStyle(document.body).getPropertyValue("--app-surface").trim(),
    }));
    const expectedBackground = await page.evaluate((color) => {
      const node = document.createElement("span");
      node.style.backgroundColor = color;
      document.body.append(node);
      const rgb = getComputedStyle(node).backgroundColor;
      node.remove();
      return rgb;
    }, colors.surface);
    expect(colors.background === expectedBackground, `${kind} picker background ${colors.background} differs from theme surface ${expectedBackground}`);
    const options = page.locator(`${modal} .database-option input`);
    await options.first().check();
    await options.last().uncheck();
    for (const [selector, label] of [
      ["h2", "title"], [".eyebrow", "caption"],
      [".database-search input", "search text"],
      [".database-select-all > span", "select all"],
      [".database-select-all small", "selection count"],
      [".database-option:has(input:checked) > span:last-of-type", "checked name"],
      [".database-option:has(input:not(:checked)) > span:last-of-type", "unchecked name"],
      [".secondary-btn", "cancel button"], [".primary-btn", "apply button"],
    ]) await measure(`${modal} ${selector}`, `${kind} picker ${label}`);
    await measure(`${modal} .database-option-icon`, `${kind} picker icon`, 3);
    await page.locator(`${modal} .database-option`).first().hover();
    await measure(`${modal} .database-option:first-child > span:last-of-type`, `${kind} picker hover name`);
    for (const selector of [".secondary-btn", ".primary-btn"]) {
      await page.locator(`${modal} ${selector}`).hover();
      await measure(`${modal} ${selector}`, `${kind} picker ${selector} hover`);
    }
    const input = `${modal} .database-search input`;
    await page.locator(input).fill("no_matching_visibility_item");
    await measure(`${modal} .tree-status`, `${kind} picker empty state`);
    await page.locator(input).fill("");
    await page.screenshot({ path: resolve(evidence, `${theme}-${kind}-picker.png`), fullPage: true });
  } catch (error) {
    failures.push(`${theme}/${kind}-picker: ${error.message}`);
  } finally {
    if (await page.locator(modal).isVisible()) await page.locator(close).click();
  }
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='mysql-local']").waitFor();
  for (const theme of themeOptions) {
    await selectTheme(theme);
    for (const [driver, id, database] of [["postgres", "conn-dev", "app"], ["mysql", "mysql-local", "warehouse"], ["redis", "redis-local", 0]]) {
      try {
        await page.locator(`[data-connection-id='${id}']`).click();
        await page.locator(`#objectTree[data-driver='${driver}']`).waitFor();
        const db = driver === "redis" ? `.redis-database[data-redis-db='${database}']` : `.tree-database[data-database='${database}']`;
        await page.locator(db).waitFor();
        if (await page.locator(db).getAttribute("open") === null) await page.locator(`${db} > summary`).click();
        const cardColor = await measure(`[data-connection-id='${id}'] .connection-driver-icon`, `${driver} card icon`, 3);
        await page.locator(".tree-root").click();
        await measure(".tree-root.selected > span:nth-child(2)", `${driver} selected instance text`);
        await measure(".tree-root.selected small", `${driver} selected instance count`);
        await page.locator(`${db} > summary`).click({ button: "right" });
        await page.keyboard.press("Escape");
        for (const [selector, label] of [[".tree-root .driver-tree-icon", "root"], [`${db} > summary .database-icon`, "DB"]]) {
          expect(await measure(selector, `${driver} ${label} icon`, 3) === cardColor, `${driver} ${label} and card colors differ`);
        }
        await measure(`${db} > summary > span:nth-child(2)`, `${driver} DB text`);
        await measure(`${db} > summary .count`, `${driver} DB count`);
        await page.locator(`${db} > summary`).hover();
        await measure(`${db} > summary > span:nth-child(2)`, `${driver} DB hover text`);
        expect(await measure(`${db} .database-icon`, `${driver} DB hover icon`, 3) === cardColor, `${driver} hover changed identity color`);
        if (driver === "redis") {
          await page.locator(".redis-key-object").first().waitFor();
          expect(await measure(".redis-key-icon", "Redis key icon", 3) === cardColor, "Redis key and root colors differ");
          await measure(".redis-key-object .object-main", "Redis key text");
          await page.locator(".redis-key-object .object-main").first().hover();
          await measure(".redis-key-object .object-main", "Redis key hover text");
          await page.locator(`${db} > summary`).click({ button: "right" });
          await measure("#redisDatabaseContextMenu [data-redis-database-context-action='console']", "Redis DB menu text");
          await page.locator("#redisDatabaseContextMenu [data-redis-database-context-action='console']").click();
          await page.locator("#redisConsolePanel").waitFor();
          expect(await page.locator(".query-tab").count() === 0, "Redis console opened an unnecessary query tab");
          await measure("#redisConsolePrompt", "Redis console prompt", 3);
          expect(await measure("#redisConsolePrompt", "Redis console identity", 3) === cardColor, "Redis console and root colors differ");
          await page.locator("#redisConsoleInput").fill("PING");
          await page.locator("#redisConsoleInput").press("Enter");
          await page.locator(".redis-console-result").waitFor();
          await measure(".redis-console-command > span:last-child", "Redis command text");
          await measure(".redis-console-result", "Redis console output");
          await page.screenshot({ path: resolve(evidence, `${theme}-console.png`), fullPage: true });
          await page.locator("#closeRedisConsole").click();
          await page.locator(`#objectTree[data-driver='redis']`).waitFor();
        } else {
          const schema = `${db} .tree-schema[data-schema='public']`;
          await page.locator(schema).waitFor();
          if (await page.locator(schema).getAttribute("open") === null) await page.locator(`${schema} > summary`).click();
          await page.locator(`${schema} .tree-object`).first().waitFor();
          await measure(`${schema} > summary > span:nth-child(2)`, `${driver} schema text`);
          await page.locator(`${schema} > summary`).hover();
          await measure(`${schema} > summary > span:nth-child(2)`, `${driver} schema hover text`);
          expect(await measure(`${schema} .schema-icon`, `${driver} schema icon`, 3) === cardColor, `${driver} schema color differs`);
          expect(await measure(`${schema} .object-kind-icon`, `${driver} object icon`, 3) === cardColor, `${driver} object color differs`);
          await measure(`${schema} .category-summary > span:nth-child(2)`, `${driver} category text`);
          await measure(`${schema} .category-summary .count`, `${driver} category count`);
          await page.locator(`${schema} .object-main`).first().hover();
          await measure(`${schema} .object-main`, `${driver} object hover text`);
          await page.locator(`${schema} .tree-object`).first().click({ button: "right" });
          await measure(`${schema} .tree-object.selected .object-main`, `${driver} selected table text`);
          await measure("#objectContextMenu [data-context-action='rename-table']", `${driver} rename table menu`);
          await page.keyboard.press("Escape");
        }
        await page.screenshot({ path: resolve(evidence, `${theme}-${driver}.png`), fullPage: true });
      } catch (error) { failures.push(`${theme}/${driver}: ${error.message}`); }
    }

    try {
      for (const id of ["themeButton", "resetLayout", "modeBadge"]) {
        await measure(`#${id}`, `${id} text`);
        await page.locator(`#${id}`).hover();
        await measure(`#${id}`, `${id} hover text`);
      }
      for (const kind of ["connections", "objects"]) {
        await page.locator(`[data-hide-pane='${kind}']`).click();
        const toggle = kind === "connections" ? "#toggleConnections" : "#toggleObjects";
        await measure(toggle, `${kind} restore tab`);
        await page.locator(toggle).hover();
        await measure(toggle, `${kind} restore tab hover`);
        await page.locator(toggle).click();
      }
      await page.locator("#themeButton").click();
      await measure(".theme-option strong", "theme menu text");
      await measure(".theme-option small", "theme menu description");
      await page.locator("#themeButton").click();
      await page.locator("[data-connection-id='conn-dev']").click();
      await page.locator(".tree-database[data-database='app']").waitFor();
      await page.locator("#addQueryTab").click();
      await page.locator(".cm-content").click();
      await page.keyboard.type("SELECT 'readable', 123 /* theme check */");
      const syntaxColors = await page.locator(".cm-line span").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
      expect(syntaxColors.length > 0, "syntax highlighting missing");
      for (const node of await page.locator(".cm-line span").all()) {
        const index = await node.evaluate((el) => [...el.parentElement.children].indexOf(el));
        await measure(`.cm-line span:nth-child(${index + 1})`, "SQL syntax text");
      }
      await page.locator(".cm-content").click();
      await page.keyboard.press("Meta+A");
      await page.keyboard.insertText("SELECT * FROM public.orders o WHERE o.st");
      await page.keyboard.press("Control+Space");
      await page.locator(".cm-completionLabel").filter({ hasText: /^status$/ }).waitFor();
      await measure(".cm-tooltip-autocomplete li[aria-selected='true'] .cm-completionLabel", "selected completion text");
      await measure(".cm-completionDetail", "completion type text");
      await page.screenshot({ path: resolve(evidence, `${theme}-completion.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await page.locator(".cm-content").click();
      await page.keyboard.press("Meta+f");
      await measure(".cm-search label", "editor search label");
      await measure(".cm-search .cm-button", "editor search button");
      await page.locator(".cm-search button[name=close]").click();
      await page.locator("#runQuery").hover();
      await measure("#runQuery", "execute button hover text");
      await page.locator("#runQuery").click();
      await page.locator(".db-grid-cell").first().waitFor();
      await measure(".db-grid-cell", "result cell text");
      await page.locator(".db-grid-row input").first().check();
      await measure(".db-grid-row[aria-selected='true'] .db-grid-cell", "selected row text");
      await page.locator(".db-grid-row[aria-selected='true'] .db-grid-cell").first().hover();
      await measure(".db-grid-row[aria-selected='true'] .db-grid-cell", "selected row hover text");
      await page.screenshot({ path: resolve(evidence, `${theme}-results.png`), fullPage: true });
      await page.locator("#newConnection").click();
      await measure("#connectionTitle", "dialog title");
      await measure(".driver-picker-value", "driver picker text");
      await page.screenshot({ path: resolve(evidence, `${theme}-dialog.png`), fullPage: true });
      await page.locator("#cancelConnection").click();
      await page.locator(".query-tab.active .tab-close").click();
    } catch (error) { failures.push(`${theme}/workspace: ${error.message}`); }
    try {
      await page.locator(".tree-database[data-database='app'] > summary").click({ button: "right" });
      await measure("#objectContextTitle", "database context title");
      await measure("#objectContextMenu [data-context-action='refresh-database']", "database context action");
      await page.locator("#objectContextMenu [data-context-action='create-schema']").click();
      await measure("#createObjectTitle", "create dialog title");
      await measure("#createObjectContext", "create dialog database");
      await measure("#createObjectNameLabel", "create dialog field label");
      await measure("#createObjectModal .form-note", "create dialog hint");
      await measure("#createObjectModal .primary-btn", "create dialog button");
      await page.screenshot({ path: resolve(evidence, `${theme}-create-dialog.png`), fullPage: true });
    } catch (error) { failures.push(`${theme}/create-dialog: ${error.message}`); }
    finally { if (await page.locator("#createObjectModal").isVisible()) await page.locator("#cancelCreateObject").click(); }
    await verifyVisibilityPicker(theme, "database");
    await verifyVisibilityPicker(theme, "schema");
    process.stdout.write(`${theme}: ${failures.filter((failure) => failure.startsWith(`${theme}/`)).length} failures\n`);
  }
  writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ fixtureOnly: true, measurements, failures }, null, 2));
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log(`PASS: ${measurements.length} rendered color and contrast checks across five themes and three drivers.`);
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}
