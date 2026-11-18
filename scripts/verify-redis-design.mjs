import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const evidence = resolve(root, "output/playwright/redis-design");
mkdirSync(evidence, { recursive: true });
const fixture = createWorkspaceFixture();
const originalInvoke = fixture.invoke;
const keys = new Map([[0, ["users:1", "cache:home", "key with space"]], [1, ["isolated:db1"]]]);
const requests = [];
fixture.invoke = async (command, args) => {
  if (command === "list_redis_keys") return { cursor: 0, keys: keys.get(Number(args.database)) || [] };
  if (command !== "execute_redis_command") return originalInvoke(command, args);
  const request = args.request;
  requests.push(request);
  if (request.sql === "BOGUS") throw new Error("ERR unknown command 'BOGUS'");
  const raw = request.sql === "PING" ? "PONG" : { database: Number(request.database), command: request.sql, value: "Redis fixture value" };
  return { columns: ["result"], rows: [[raw]], rowCount: 1, elapsedMs: 1.7, raw };
};
const server = createServer((req, res) => {
  const relative = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//, "") || "index.html";
  const file = resolve(dist, relative);
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" }[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__REDIS_COPIED__ = value; } } });
});
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();
const errors = [];
const checks = [];
const measurements = [];
page.on("pageerror", error => errors.push(error.message));
const check = async (name, fn) => {
  process.stdout.write(`CHECK ${name} ... `);
  try { await fn(); checks.push({ name, ok: true }); console.log("ok"); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); console.log(`FAIL: ${error.message}`); }
};
const until = async (predicate, name, duration = 6000) => {
  const start = Date.now();
  while (Date.now() - start < duration) { if (await predicate()) return; await new Promise(done => setTimeout(done, 40)); }
  throw new Error(`Timed out: ${name}`);
};
const input = page.locator("#redisConsoleInput");
const editorText = async () => input.locator(".cm-line").evaluateAll(lines => lines.map(line => {
  const copy = line.cloneNode(true); copy.querySelectorAll(".cm-placeholder").forEach(node => node.remove()); return copy.textContent;
}).join("\n"));
const shortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const setInput = async value => { await input.fill(value); await input.press("End"); };
const openConsole = async database => {
  await page.locator(`.redis-database[data-redis-db='${database}'] > summary`).click({ button: "right" });
  await page.locator("[data-redis-database-context-action='console']").click();
  await page.locator("#redisConsolePanel").waitFor();
};
const run = async (text, viaShortcut = false) => {
  await setInput(text);
  await input.press("Escape");
  const before = requests.length;
  if (viaShortcut) await input.press(shortcut); else await page.locator("#redisConsoleRun").click();
  await until(() => requests.length === before + 1, "one Redis request");
  await until(() => page.locator("#redisConsoleRun").isEnabled(), "Redis command completion");
};
const checkBounds = async (theme, width, height) => {
  const data = await page.evaluate(() => {
    const result = {};
    for (const id of ["redisConsolePanel", "redisConsoleRun", "redisClearEditor", "redisClearOutput", "closeRedisConsole", "redisCommandEditor", "redisConsoleOutput"]) {
      const node = document.getElementById(id);
      const r = node.getBoundingClientRect();
      result[id] = { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    }
    return { viewport: { width: innerWidth, height: innerHeight }, body: { width: document.body.scrollWidth, height: document.body.scrollHeight }, nodes: result };
  });
  measurements.push({ theme, width, height, ...data });
  for (const [id, r] of Object.entries(data.nodes)) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.right <= width + 1 && r.bottom <= height + 1 && r.width > 0 && r.height > 0, `${theme} ${width}x${height}: ${id} outside viewport: ${JSON.stringify(r)}`);
  }
  assert.ok(data.nodes.redisConsoleOutput.height >= 100, `${theme}: output workspace too short`);
  assert.ok(data.body.width <= width, `${theme}: horizontal document overflow`);
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator("[data-connection-id='redis-local']").click();
  await until(async () => await page.locator("#connectionMode").innerText() === "已连接", "Redis connected");
  await page.locator(".redis-database[data-redis-db='0'] > summary .tree-toggle").click();
  await page.locator("[data-redis-key='cache:home']").waitFor();
  await openConsole(0);
  await check("command completion accepts Enter without executing", async () => {
    await setInput(""); await input.click(); await page.keyboard.type("hg");
    await page.locator("#redisCommandEditor .cm-tooltip-autocomplete").waitFor();
    const labels = await page.locator("#redisCommandEditor .cm-completionLabel").allTextContents();
    assert.ok(labels.includes("HGET"));
    const before = requests.length;
    await input.press("Enter");
    assert.equal((await editorText()).trim(), "HGET");
    assert.equal(requests.length, before);
    assert.match(await page.locator("#redisConsoleHint").innerText(), /key field/);
  });
  await check("Key completion uses the active Redis DB and quotes spaces", async () => {
    await setInput("GET ca");
    await input.press("Control+Space");
    await page.locator("#redisCommandEditor .cm-tooltip-autocomplete").waitFor();
    assert.ok((await page.locator("#redisCommandEditor .cm-completionLabel").allTextContents()).includes("cache:home"));
    assert.ok(!(await page.locator("#redisCommandEditor .cm-completionLabel").allTextContents()).includes("isolated:db1"));
    await input.press("Tab");
    assert.equal((await editorText()).trim(), "GET cache:home");
    await setInput("GET key"); await input.press("Control+Space");
    await page.locator("#redisCommandEditor .cm-tooltip-autocomplete").waitFor();
    await input.press("Tab");
    assert.equal((await editorText()).trim(), 'GET "key with space"');
  });
  await check("shortcut and button execute once while retaining editable commands", async () => {
    await run('GET "key with space"', true);
    assert.equal(requests.at(-1).connectionId, "redis-local");
    assert.equal(requests.at(-1).database, 0);
    assert.equal(requests.at(-1).sql, 'GET "key with space"');
    assert.equal((await editorText()).trim(), 'GET "key with space"');
    await run("PING");
    assert.equal(await page.locator(".redis-console-entry").count(), 2);
    assert.equal((await editorText()).trim(), "PING");
    assert.equal(await page.locator("#redisOutputCount").innerText(), "2");
  });
  await check("reuse restores commands, copy returns results, clears preserve the other surface", async () => {
    await page.locator("[data-redis-reuse='0']").click();
    assert.equal((await editorText()).trim(), 'GET "key with space"');
    await page.locator("[data-redis-copy='1']").click();
    assert.equal(await page.evaluate(() => window.__REDIS_COPIED__), "PONG");
    await page.locator("#redisClearEditor").click();
    assert.equal((await editorText()).trim(), "");
    assert.equal(await page.locator(".redis-console-entry").count(), 2);
    await setInput("INFO server");
    await page.locator("#redisClearOutput").click();
    assert.equal(await page.locator(".redis-console-entry").count(), 0);
    assert.equal((await editorText()).trim(), "INFO server");
  });
  await check("errors keep the command and render a failed result", async () => {
    await run("BOGUS");
    assert.equal((await editorText()).trim(), "BOGUS");
    assert.match(await page.locator(".redis-console-entry").last().innerText(), /失败.*BOGUS.*ERR unknown/s);
  });
  await check("cursor line drives usage hints and selections execute independently", async () => {
    await setInput("PING\nHGET users:1 name");
    assert.match(await page.locator("#redisConsoleHint").innerText(), /HGET key field/);
    await input.press("ArrowUp");
    assert.match(await page.locator("#redisConsoleHint").innerText(), /PING/);
    await input.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home"); await input.press("Shift+End");
    const before = requests.length;
    await input.press(shortcut);
    await until(() => requests.length === before + 1, "selected command");
    await until(() => page.locator("#redisConsoleRun").isEnabled(), "selected command complete");
    assert.equal(requests.at(-1).sql, "PING");
    assert.equal(await editorText(), "PING\nHGET users:1 name");
  });
  await run("PING");
  await check("command and result blocks preserve separate lines and JSON formatting", async () => {
    const layout = await page.locator(".redis-console-entry").last().evaluate(entry => {
      const command = entry.querySelector(".redis-console-command");
      const result = entry.querySelector(".redis-console-result");
      return { commandDisplay: getComputedStyle(command).display, resultDisplay: getComputedStyle(result).display, resultSpace: getComputedStyle(result).whiteSpace, commandBottom: command.getBoundingClientRect().bottom, resultTop: result.getBoundingClientRect().top };
    });
    assert.equal(layout.commandDisplay, "block");
    assert.equal(layout.resultDisplay, "block");
    assert.equal(layout.resultSpace, "pre-wrap");
    assert.ok(layout.resultTop >= layout.commandBottom, "result appears beside command");
  });
  await until(async () => !(await page.locator("#toast").getAttribute("class")).includes("visible"), "toast settled");
  for (const theme of ["light", "dark"]) {
    await check(`${theme} at desktop and minimum window sizes`, async () => {
      await page.locator("#themeButton").click();
      await page.locator(`[data-theme-option='${theme}']`).click();
      for (const [width, height] of [[1440, 900], [1060, 680]]) {
        await page.setViewportSize({ width, height });
        await setInput("HGET users:1 name");
        await input.press("Escape");
        await checkBounds(theme, width, height);
        await page.screenshot({ path: resolve(evidence, `${theme}-${width}x${height}.png`) });
        await setInput("hg"); await input.press("Control+Space");
        await page.locator("#redisCommandEditor .cm-tooltip-autocomplete").waitFor();
        await page.locator("#redisCommandEditor .cm-completionInfo").waitFor();
        const infoVisible = await page.locator("#redisCommandEditor .cm-completionInfo").evaluate(info => {
          const r = info.getBoundingClientRect();
          const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return Boolean(target && info.contains(target));
        });
        assert.ok(infoVisible, "completion details are clipped by an ancestor");
        const popupBounds = await page.locator("#redisCommandEditor .cm-tooltip").evaluateAll(nodes => nodes.map(node => {
          const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }));
        for (const r of popupBounds) assert.ok(r.x >= 0 && r.y >= 0 && r.right <= width + 1 && r.bottom <= height + 1, `completion outside viewport: ${JSON.stringify(r)}`);
        await page.screenshot({ path: resolve(evidence, `${theme}-${width}x${height}-completion.png`) });
        await input.press("Escape");
      }
    });
  }
  await check("DB 1 offers only its loaded keys", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#closeRedisConsole").click();
    await page.locator(".redis-database[data-redis-db='1'] > summary .tree-toggle").click();
    await page.locator("[data-redis-key='isolated:db1']").waitFor();
    await openConsole(1);
    await setInput("GET iso"); await input.press("Control+Space");
    await page.locator("#redisCommandEditor .cm-tooltip-autocomplete").waitFor();
    const labels = await page.locator("#redisCommandEditor .cm-completionLabel").allTextContents();
    assert.ok(labels.includes("isolated:db1"));
    assert.ok(!labels.includes("cache:home"));
    await input.press("Tab"); await input.press(shortcut);
    await until(() => requests.at(-1)?.sql === "GET isolated:db1", "DB 1 shortcut");
    assert.equal(requests.at(-1).database, 1);
  });
  await check("new console sessions isolate undo history across databases", async () => {
    await until(() => page.locator("#redisConsoleRun").isEnabled(), "DB 1 command completed");
    await page.locator("#closeRedisConsole").click();
    await openConsole(0);
    assert.equal(await editorText(), "");
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.equal(await editorText(), "", "undo restored another console's command");
    await page.keyboard.type("PING");
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.equal(await editorText(), "");
  });
  assert.deepEqual(errors, []);
} finally {
  await page.screenshot({ path: resolve(evidence, "last-state.png") }).catch(() => {});
  writeFileSync(resolve(evidence, "checks.json"), JSON.stringify({ checks, errors, measurements, requests }, null, 2));
  await browser.close();
  await new Promise(done => server.close(done));
}
console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
if (checks.some(check => !check.ok)) process.exitCode = 1;
