import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidence = resolve(root, "output/playwright/object-quick-open");
mkdirSync(evidence, { recursive: true });
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/themes.css"><link rel="stylesheet" href="/src/object-quick-open.css"><body data-theme="dark"><button id="origin">打开对象</button><script type="module">
      import { createObjectQuickOpen } from '/src/object-quick-open.js';
      window.calls = []; window.errors = [];
      const entries = [
        {name:'orders',kind:'table',connectionName:'开发环境',database:'shop',schema:'public',columns:[{name:'customer_id'}]},
        {name:'lookup',kind:'function',connectionName:'开发环境',database:'shop',schema:'public',columns:[]},
        {name:'session:1',key:'session:1',kind:'redis-key',driver:'redis',connectionName:'缓存',database:0,columns:[]},
        {name:'<img src=x onerror=alert(1)>',kind:'table',connectionName:'HTML 安全测试',database:'db',schema:'public',columns:[]},
        ...Array.from({length:150},(_,i)=>({name:'table_'+i,kind:'table',database:'many',schema:'public',columns:[]}))
      ];
      window.quickOpen=createObjectQuickOpen({getEntries:()=>entries,onOpen:(entry,options)=>window.calls.push({name:entry.name,...options}),onError:error=>window.errors.push(String(error))});
      document.querySelector('#origin').onclick=()=>window.quickOpen.open();
    </script>`);
    return;
  }
  const file = resolve(root, (req.url || "/").split("?")[0].slice(1));
  if (!file.startsWith(root + "/src/") || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": { ".js": "text/javascript", ".css": "text/css" }[extname(file)] || "text/plain" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  const input = page.getByRole("combobox", { name: "搜索对象" });
  const open = () => page.locator("#origin").click();
  await open();
  assert.equal(await page.getByRole("option").count(), 80);
  assert.match(await page.locator(".object-quick-open-count").innerText(), /80 \/ 154/);
  await input.fill("col:customer");
  assert.equal(await page.getByRole("option").count(), 1);
  assert.match(await page.getByRole("option").innerText(), /匹配字段：customer_id/);
  await input.press("Shift+Enter");
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), { name: "orders", structure: true });
  assert.equal(await page.evaluate(() => document.activeElement.id), "origin");
  await open();
  await input.fill("orders");
  await input.press("Enter");
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), { name: "orders", structure: false });
  await open();
  await input.fill("lookup");
  await input.press("Enter");
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), { name: "lookup", structure: true });
  await open();
  await input.fill("db:0 session:1");
  await input.press("Shift+Enter");
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), { name: "session:1", structure: false });
  await open();
  await input.fill("no-matching-object");
  assert.ok(await page.locator(".object-quick-open-empty").isVisible());
  await input.press("Enter");
  assert.equal(await page.evaluate(() => calls.length), 4);
  await input.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "origin");
  await open();
  await input.fill("db:shop");
  await input.press("ArrowUp");
  assert.equal(await page.getByRole("option", { selected: true }).locator("strong").innerText(), "lookup");
  await input.press("ArrowDown");
  assert.equal(await page.getByRole("option", { selected: true }).locator("strong").innerText(), "orders");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  assert.equal(await page.evaluate(() => calls.length), 4);
  assert.ok(await page.locator("dialog").isVisible());
  await input.press("Escape");
  assert.ok(await page.locator("dialog").isVisible());
  await input.dispatchEvent("compositionend");
  await input.press("Escape");
  assert.ok(await page.locator("dialog").isHidden());
  await open();
  await input.fill("<img");
  assert.equal(await page.locator(".object-quick-open-results img").count(), 0);
  assert.match(await page.getByRole("option").innerText(), /<img src=x/);
  await input.fill("db:shop");
  await page.screenshot({ path: resolve(evidence, "dark.png") });
  await page.evaluate(() => document.body.dataset.theme = "light");
  await page.screenshot({ path: resolve(evidence, "light.png") });
  await page.setViewportSize({ width: 420, height: 620 });
  assert.ok(await page.locator("dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1));
  await page.screenshot({ path: resolve(evidence, "narrow.png") });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  console.log("Object quick-open browser regression passed: keyboard, scopes, data/structure actions, IME, focus, XSS, empty state and responsive themes.");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
