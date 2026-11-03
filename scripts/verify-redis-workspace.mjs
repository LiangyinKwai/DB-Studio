import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright-import.mjs";
import { createWorkspaceFixture } from "./fixtures/workspace-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
function serve(directory) {
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
fixture.profiles.push({ id: "redis-remote", name: "远端 Redis", driver: "redis", host: "redis.remote", port: 6379, database: "0", redisDb: 0, user: "", tls: false });
const redis = new Map([
  ["redis-local", new Map([
    ["users:1", { keyType: "hash", ttl: 120, fields: new Map([["name", "Ada"], ["role", "admin"]]) }],
    ["cache:home", { keyType: "string", ttl: 90, value: "home" }],
  ])],
  ["redis-remote", new Map([
    ["users:1", { keyType: "hash", ttl: 600, fields: new Map([["name", "Remote Ada"], ["role", "admin"]]) }],
    ["cache:home", { keyType: "string", ttl: 500, value: "remote-home" }],
  ])],
]);
const redisOtherDatabases = new Map([
  ["redis-local:1", new Map([["otherdb:key", { keyType: "string", ttl: -1, value: "db1-only" }]])],
]);
const redisCalls = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (command, args) => { const entry = { command, args, at: Date.now() }; redisCalls.push(entry); fixture.calls.push(entry); return entry; };
const requireConnection = (args, command) => {
  if (typeof args?.connectionId !== "string" || !args.connectionId) throw new Error(`${command}: connectionId must be a string`);
  return args.connectionId;
};
const storeFor = (connectionId, database = 0) => {
  if (Number(database) === 0) return redis.get(connectionId) || new Map();
  const target = `${connectionId}:${database}`;
  if (!redisOtherDatabases.has(target)) redisOtherDatabases.set(target, new Map());
  return redisOtherDatabases.get(target);
};
function valuePayload(connectionId, key, database = 0) {
  const item = storeFor(connectionId, database).get(key);
  if (!item) throw new Error(`missing Redis key: ${key}`);
  if (item.keyType === "string") return { key, keyType: "string", ttl: item.ttl, columns: ["value"], rows: [[item.value]], raw: item.value };
  return { key, keyType: "hash", ttl: item.ttl, columns: ["field", "value"], rows: [...item.fields].map(([field, value]) => [field, value]), raw: Object.fromEntries(item.fields) };
}
const originalInvoke = fixture.invoke;
fixture.invoke = async (command, args) => {
if (command === "list_redis_databases") {
  record(command, args);
  return [
    { index: 0, keyCount: 2, current: true },
    { index: 1, keyCount: 0, current: false },
  ];
}
if (!["list_redis_keys", "get_redis_value", "execute_redis_command", "save_redis_cell", "create_redis_key", "delete_redis_key", "rename_redis_key"].includes(command)) return originalInvoke(command, args);
  record(command, args);
  if (command === "list_redis_keys") {
    const connectionId = requireConnection(args, command);
    if (String(args.pattern || "").includes("slow")) await wait(350);
    const pattern = String(args.pattern || "").replace(/^\*|\*$/g, "");
    if (pattern === "empty") return { cursor: args.cursor ? 0 : 12, keys: [] };
    if (pattern === "slow") return { cursor: 0, keys: ["stale:remote"] };
    const keys = [...storeFor(connectionId, args.database).keys()].filter((key) => !pattern || key.includes(pattern));
    return { cursor: 0, keys };
  }
  if (command === "get_redis_value") {
    const connectionId = requireConnection(args, command);
    return valuePayload(connectionId, String(args.key), args.database);
  }
  if (command === "save_redis_cell") {
    const request = args?.request || {};
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const item = storeFor(connectionId, request.database).get(String(request.key));
    if (!item) throw new Error("missing Redis key");
    if (item.keyType !== request.keyType) throw new Error("Redis type changed");
    const old = request.field == null ? item.value : item.fields.get(String(request.field));
    if (String(old ?? "") !== String(request.expectedValue ?? "")) throw new Error("Redis value changed");
    if (request.field == null) item.value = String(request.value ?? "");
    else item.fields.set(String(request.field), String(request.value ?? ""));
    return { ok: true };
  }
  if (command === "execute_redis_command") {
    const request = args?.request || {};
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const sql = String(request.sql || "");
    const get = sql.match(/^GET\s+"?([^"\s]+)"?\s*$/i);
    if (get) {
      const value = storeFor(connectionId, request.database).get(get[1])?.value ?? null;
      return { columns: ["result"], rows: [[value]], rowCount: 1, elapsedMs: 0.1, raw: value };
    }
    const set = sql.match(/^SET\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/i);
    const hash = sql.match(/^HSET\s+"((?:[^"\\]|\\.)*?)"\s+"((?:[^"\\]|\\.)*?)"\s+"((?:[^"\\]|\\.)*)"/i);
    if (set) storeFor(connectionId, request.database).get(set[1].replaceAll('\\"', '"')).value = set[2];
    if (hash) storeFor(connectionId, request.database).get(hash[1]).fields.set(hash[2], hash[3]);
    return { columns: ["result"], rows: [["OK"]], rowCount: 1, elapsedMs: 0.1 };
  }
  if (command === "create_redis_key") {
    const request = args.request;
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const current = storeFor(connectionId, request.database);
    if (current.has(request.key)) throw new Error("目标 key 已存在，未覆盖原数据");
    current.set(request.key, { keyType: request.keyType, value: request.value, ttl: request.ttl || -1, fields: new Map([[request.field, request.value]]) });
    return null;
  }
  if (command === "delete_redis_key") {
    const connectionId = requireConnection(args, command);
    if (args.readOnly) throw new Error("Redis mutation is read-only");
    return storeFor(connectionId, args.database).delete(String(args.key)) ? 1 : 0;
  }
  if (command === "rename_redis_key") {
    const request = args?.request || {};
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const current = storeFor(connectionId, request.database);
    if (current.has(request.newKey)) return false;
    const item = current.get(request.key);
    if (!item) return false;
    current.delete(request.key); current.set(request.newKey, item); return true;
  }
};

const checks = [];
const check = async (name, fn) => {
  process.stdout.write(`CHECK ${name} ... `);
  try { await fn(); checks.push({ name, ok: true }); console.log("ok"); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); console.log(`FAIL: ${error.message}`); }
};
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const calls = (command) => redisCalls.filter((entry) => entry.command === command);
const waitFor = async (predicate, label, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await predicate()) return; await wait(40); }
  throw new Error(`timeout waiting for ${label}`);
};
const ensureRedisMode = async (page, mode) => {
  const badge = page.locator("#modeBadge");
  const isWrite = (await badge.innerText()).includes("可写");
  if ((mode === "write") !== isWrite) await badge.click();
  await waitFor(() => badge.innerText().then((value) => value.includes(mode === "write" ? "可写" : "只读")), `Redis ${mode} mode`);
};

if (!existsSync(join(dist, "index.html"))) throw new Error("dist missing; run npm run build:frontend first");
const { server, port } = await serve(dist);
const browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ profiles }) => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
  window.__FIXTURE_PROFILES__ = profiles;
}, { profiles: fixture.profiles });
await context.exposeFunction("__FIXTURE_INVOKE__", fixture.invoke);
const page = await context.newPage();
page.on("pageerror", error => console.log(`[page error] ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") console.log(`[browser error] ${message.text()}`); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await waitFor(() => page.locator("#connectionList [data-connection-id]").count().then((count) => count === 4), "connections");
const ensureConnection = async (id) => {
  if (await page.locator(`.connection-card.selected [data-connection-id='${id}']`).count() && await page.locator("#connectionMode").innerText() === "已连接") return;
  await page.locator(`#connectionList [data-connection-id='${id}']`).click();
  await waitFor(() => page.locator("#connectionMode").innerText().then((value) => value === "已连接"), `connection ${id}`);
};
const expandRedisDatabase = async (index) => {
  const database = page.locator(`.redis-database[data-redis-db='${index}']`);
  await waitFor(() => database.count().then((count) => count === 1), `Redis DB ${index}`);
  if ((await database.getAttribute("open")) !== "") await database.locator("> summary .tree-toggle").click();
  return database;
};

await check("new connections fill defaults and preserve custom values across drivers", async () => {
  await page.locator("#newConnection").click();
  expect(await page.locator("#connectionHost").inputValue() === "localhost", "host default missing");
  expect(await page.locator("#connectionUser").inputValue() === "postgres", "user default missing");
  expect(await page.locator("#connectionDatabase").inputValue() === "postgres", "database default missing");
  for (const [driver, host, user, port] of [["redis", "127.0.0.1", "default", "6379"], ["mysql", "localhost", "root", "3306"], ["postgres", "localhost", "postgres", "5432"]]) {
    await page.locator("#connectionDriverTrigger").click();
    await page.locator(`#connectionDriverMenu [data-driver='${driver}']`).click();
    expect(await page.locator("#connectionHost").inputValue() === host, `${driver} host missing`);
    expect(await page.locator("#connectionUser").inputValue() === user, `${driver} user missing`);
    expect(await page.locator("#connectionPort").inputValue() === port, `${driver} port missing`);
  }
  await page.locator("#connectionHost").fill("custom.host");
  await page.locator("#connectionUser").fill("custom-user");
  await page.locator("#connectionDriverTrigger").click();
  await page.locator("#connectionDriverMenu [data-driver='redis']").click();
  expect(await page.locator("#connectionHost").inputValue() === "custom.host", "custom host replaced");
  expect(await page.locator("#connectionUser").inputValue() === "custom-user", "custom user replaced");
  await page.locator("#cancelConnection").click();
});

await check("Redis logical databases can be expanded independently", async () => {
  await ensureConnection("redis-local");
  await waitFor(() => page.locator(".redis-database[data-redis-db='0']").count().then((count) => count === 1), "Redis DB 0");
  await waitFor(() => page.locator(".redis-database[data-redis-db='1']").count().then((count) => count === 1), "Redis DB 1");
  expect(await page.locator(".redis-database[open]").count() === 0, "Redis DB 0 opened by default");
  const before = calls("list_redis_keys").length;
  await expandRedisDatabase(0);
  await waitFor(() => calls("list_redis_keys").slice(before).some((entry) => entry.args?.database === 0), "Redis DB 0 scan");
  await page.locator(".redis-database[data-redis-db='1'] > summary .tree-toggle").click();
  await waitFor(() => calls("list_redis_keys").slice(before).some((entry) => entry.args?.database === 1), "Redis DB 1 scan");
  expect(await page.locator(".redis-database[open]").count() === 2, "multiple Redis DBs were not kept expanded");
  const collapse = page.locator('#collapseTree');
  expect(await collapse.isVisible(), 'Redis collapse-all control missing');
  expect(await collapse.getAttribute('aria-label') === '收起所有 Redis 数据库', 'Redis collapse-all label missing');
  const beforeCollapse = calls('list_redis_keys').length;
  await collapse.click();
  expect(await page.locator('.redis-database[open]').count() === 0, 'collapse-all did not close every Redis DB');
  expect(calls('list_redis_keys').length === beforeCollapse, 'collapse-all unexpectedly scanned Redis');
  await expandRedisDatabase(0);
  await expandRedisDatabase(1);

});

await check("Redis type picker supports keyboard selection, dismiss and reset", async () => {
  await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='create']").click();
  const trigger = page.locator("#redisCreateTypeTrigger");
  await trigger.focus();
  await trigger.press("ArrowDown");
  expect(await page.locator("#redisCreateTypeMenu [role='option']").count() === 6, "type options incomplete");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await page.locator("#redisCreateType").inputValue() === "hash", "keyboard did not choose Hash");
  expect(await page.locator("#redisCreateFieldRow").isVisible(), "Hash field missing");
  await trigger.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  expect(await page.locator("#redisCreateType").inputValue() === "stream", "Stream option missing");
  expect(await page.locator("#redisCreateFieldRow").isVisible(), "Stream field missing");
  await trigger.click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  expect(await page.locator("#redisCreateScoreRow").isVisible(), "Sorted Set score missing");
  expect(await page.locator("#redisCreateFieldRow").isHidden(), "Hash field stayed visible");
  await trigger.click();
  await page.keyboard.press("Escape");
  expect(await page.locator("#redisCreateTypeMenu").isHidden(), "Escape did not close picker");
  expect(await page.locator("#redisCreateModal").isVisible(), "Escape also closed dialog");
  await trigger.click();
  await page.locator("#redisCreateKey").click();
  expect(await page.locator("#redisCreateTypeMenu").isHidden(), "outside click kept picker open");
  await page.locator("#cancelRedisCreate").click();
  const screenshots = join(root, "output/playwright/redis-type-picker");
  mkdirSync(screenshots, { recursive: true });
  for (const theme of ["dark", "light", "ocean", "forest", "contrast"]) {
    await page.locator("#themeButton").click();
    await page.locator(`[data-theme-option='${theme}']`).click();
    await page.setViewportSize({ width: 1060, height: 680 });
    await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
    await page.locator("[data-redis-database-context-action='create']").click();
    expect(await page.locator("#redisCreateType").inputValue() === "string", "reopen did not reset type");
    await trigger.click();
    const bounds = await page.locator("#redisCreateTypeMenu").evaluate(menu => {
      const r = menu.getBoundingClientRect();
      const last = menu.lastElementChild.getBoundingClientRect();
      const hit = document.elementFromPoint(last.x + last.width / 2, last.y + last.height / 2);
      return { bottom: r.bottom, right: r.right, height: r.height, visible: menu.lastElementChild.contains(hit) };
    });
    expect(bounds.bottom <= 680 && bounds.right <= 1060 && bounds.height > 200 && bounds.visible, `${theme} type menu clipped`);
    for (const slot of await page.locator('#redisCreateTypeIcon, #redisCreateTypeMenu .redis-type-option .driver-picker-icon').all()) {
      const geometry = await slot.evaluate(node => {
        const wrapper = node.getBoundingClientRect(), badge = node.querySelector('.redis-key-icon').getBoundingClientRect();
        const style = getComputedStyle(node);
        return { wrapper: [wrapper.width, wrapper.height], badge: [badge.width, badge.height], border: style.borderTopWidth, background: style.backgroundColor };
      });
      expect(geometry.wrapper[0] === geometry.badge[0] && geometry.wrapper[1] === geometry.badge[1], `${theme} type badge has surrounding whitespace: ${JSON.stringify(geometry)}`);
      expect(geometry.border === '0px' && geometry.background === 'rgba(0, 0, 0, 0)', `${theme} type badge wrapper has an extra surface: ${JSON.stringify(geometry)}`);
    }
    await page.screenshot({ path: join(screenshots, `${theme}-1060.png`) });
    await page.keyboard.press("Escape");
    await page.locator("#cancelRedisCreate").click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check("Redis create key stays scoped to DB and rejects duplicates", async () => {
  await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='create']").click();
  await page.locator("#redisCreateKey").fill("new:hash");
  await page.locator("#redisCreateTypeTrigger").click();
  await page.locator('[data-redis-type="hash"]').click();
  await page.locator("#redisCreateField").fill("name");
  await page.locator("#redisCreateValue").fill("中文 value");
  await page.locator("#redisCreateTtl").fill("60");
  await page.locator("#applyRedisCreate").click();
  await waitFor(() => page.locator("#redisCreateModal").isHidden(), "created key modal close");
  const request = calls("create_redis_key").at(-1).args.request;
  expect(request.connectionId === "redis-local" && request.database === 1, "creation target changed");
  expect(request.keyType === "hash" && request.field === "name" && request.ttl === 60, "creation payload incomplete");
  await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='create']").click();
  await page.locator("#redisCreateKey").fill("new:hash");
  await page.locator("#applyRedisCreate").click();
  await waitFor(() => page.locator("#redisCreateFeedback").innerText().then(text => text.includes("已存在")), "duplicate rejection");
  await page.locator("#cancelRedisCreate").click();
});

await check("Redis console completes commands and shows argument hints without executing", async () => {
  await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='console']").click();
  const input = page.locator("#redisConsoleInput");
  const before = calls("execute_redis_command").length;
  await input.fill("hget");
  await waitFor(() => page.locator("#redisCommandEditor .cm-tooltip-autocomplete").isVisible(), "command suggestions");
  await input.press("Enter");
  expect(await input.innerText() === "HGET", "Enter did not accept completion");
  expect(calls("execute_redis_command").length === before, "completion executed a command");
  expect((await page.locator("#redisConsoleHint").innerText()).includes("key field"), "parameter hint missing");
  await page.locator("#closeRedisConsole").click();
});

await check("Redis queries inherit DB 1 from consoles and keys and reopen history in DB 1", async () => {
  const run = async () => {
    const before = calls("execute_redis_command").length;
    await page.locator("#runQuery").click();
    await waitFor(() => calls("execute_redis_command").length > before, "DB 1 query");
    await waitFor(() => page.locator("#runQuery").isEnabled(), "DB 1 query complete");
    expect(calls("execute_redis_command").at(-1).args.request.database === 1, "query fell back to DB 0");
    expect((await page.locator("#resultGrid").innerText()).includes("db1-only"), "DB 1 value missing");
  };
  const fillQuery = async () => {
    const editor = page.locator("#sqlEditor .cm-content");
    await editor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type('GET "otherdb:key"');
  };
  await page.locator(".redis-database[data-redis-db='1'] > summary").click({ button: "right" });
  await page.locator("[data-redis-database-context-action='console']").click();
  await page.locator("#addQueryTab").click();
  expect(await page.locator("#queryTargetContext").innerText() === "DB 1", "console DB not inherited");
  await fillQuery();
  await run();
  await page.locator("#recentQueries .recent-query").filter({ hasText: 'GET "otherdb:key"' }).first().click();
  expect(await page.locator("#queryTargetContext").innerText() === "DB 1", "history DB not restored");
  await run();
  await expandRedisDatabase(1);
  await page.locator("[data-redis-db='1'][data-redis-key='otherdb:key']").click();
  await waitFor(() => page.locator("#tableToolbarTitle").innerText().then(value => value === "otherdb:key"), "DB 1 key tab");
  await page.locator("#addQueryTab").click();
  expect(await page.locator("#queryTargetContext").innerText() === "DB 1", "key DB not inherited");
  await fillQuery();
  await run();
});

await check("Redis hash cell save uses CAS request and preserves connection scope", async () => {
  await ensureConnection("redis-local");
  await expandRedisDatabase(0);
  await waitFor(() => page.locator("[data-redis-key='users:1']").count().then((count) => count === 1), "local Redis keys");
  await page.locator("[data-redis-key='users:1']").click();
  await waitFor(() => page.locator("#tableToolbarTitle").innerText().then((value) => value.trim() === "users:1"), "local Redis tab");
  expect(await page.locator('#viewTableDdl').isHidden(), 'DDL button must not appear for Redis keys');
  expect(await page.locator("#queryConnection, #queryDatabase").count() === 0, "connection/database pickers are still present");
  await ensureConnection("redis-remote");
  await ensureConnection("redis-local");
  await ensureRedisMode(page, "write");
  await page.locator("#resultGrid .db-grid-cell").nth(1).click({ button: "right" });
  await page.locator('[data-cell-action="inspect"]').click();
  await waitFor(() => page.locator("#cellModal").isVisible(), "hash cell modal");
  const before = calls("save_redis_cell").length;
  await page.locator("#cellValue").fill("Grace");
  await page.locator("#saveCell").click();
  await page.locator("#confirmActionAccept").click();
  await waitFor(() => calls("save_redis_cell").length > before, "CAS cell save");
  const request = calls("save_redis_cell").at(-1)?.args?.request;
  expect(request?.connectionId === "redis-local", "cell save used wrong Redis connection");
  expect(request?.key === "users:1" && request?.keyType === "hash", "cell save omitted Redis key type");
  expect(request?.field === "name" && request?.expectedValue === "Ada" && request?.value === "Grace", "cell save was not CAS-shaped");
  expect(redis.get("redis-local").get("users:1").fields.get("name") === "Grace", "hash value was not persisted");
  expect(redis.get("redis-remote").get("users:1").fields.get("name") === "Remote Ada", "same key on remote Redis was changed");
});

await check("cancelled Redis cell confirmation does not mutate", async () => {
  await page.locator("#resultGrid .db-grid-cell").nth(1).click({ button: "right" });
  await page.locator('[data-cell-action="inspect"]').click();
  await waitFor(() => page.locator("#cellModal").isVisible(), "second hash cell modal");
  await page.locator("#cellValue").fill("Rejected");
  const before = calls("save_redis_cell").length;
  await page.locator("#saveCell").click();
  await page.locator("#confirmActionCancel").click();
  await wait(120);
  expect(calls("save_redis_cell").length === before, "cancelled confirmation still sent mutation");
  expect(redis.get("redis-local").get("users:1").fields.get("name") === "Grace", "cancelled confirmation mutated value");
  await page.locator("#closeCell").click();
  await page.locator("#confirmActionAccept").click();
  await page.locator("#cellModal").waitFor({ state: "hidden" });
});

await check("same-name Redis keys rename and delete stay scoped to the selected connection", async () => {
  await ensureConnection("redis-remote");
  await expandRedisDatabase(0);
  await waitFor(() => page.locator("[data-redis-key='users:1']").count().then((count) => count === 1), "remote Redis keys");
  const localTab = page.locator(".query-tab").filter({ hasText: "users:1" });
  expect(await localTab.count() >= 1, "local Redis value tab was rebound or lost");
  await page.locator("[data-redis-key='users:1']").click({ button: "right" });
  await waitFor(() => page.locator("#redisContextMenu").isVisible(), "remote Redis context menu");
  await page.locator("#redisContextMenu [data-redis-context-action='rename']").click();
  await waitFor(() => page.locator("#redisRenameModal").isVisible(), "Redis rename modal");
  await page.locator("#redisRenameInput").fill("users:renamed");
  const beforeRename = calls("rename_redis_key").length;
  await page.locator("#applyRedisRename").click();
  await waitFor(() => calls("rename_redis_key").length > beforeRename, "remote rename");
  const renameRequest = calls("rename_redis_key").at(-1)?.args?.request;
  expect(renameRequest?.connectionId === "redis-remote", "rename used wrong Redis connection");
  expect(redis.get("redis-local").has("users:1"), "rename changed local same-name key");
  expect(redis.get("redis-remote").has("users:renamed") && !redis.get("redis-remote").has("users:1"), "remote rename did not apply");

  await page.locator("[data-redis-key='users:renamed']").click({ button: "right" });
  await waitFor(() => page.locator("#redisContextMenu").isVisible(), "renamed Redis context menu");
  const beforeDelete = calls("delete_redis_key").length;
  await page.locator("#redisContextMenu [data-redis-context-action='delete']").click();
  await page.locator("#confirmActionAccept").click();
  await waitFor(() => calls("delete_redis_key").length > beforeDelete, "remote delete");
  const deleteArgs = calls("delete_redis_key").at(-1)?.args;
  expect(deleteArgs?.connectionId === "redis-remote", "delete used wrong Redis connection");
  expect(redis.get("redis-local").has("users:1"), "delete changed local same-name key");
});

await check("read-only Redis menu cannot delete a key", async () => {
  await expandRedisDatabase(0);
  // Lock a tab on the target connection; another instance's tab has its own mode.
  await page.locator("[data-redis-key='cache:home'] .object-main").click();
  await waitFor(() => page.locator(".db-grid-cell").count().then((count) => count > 0), "remote key value");
  await ensureRedisMode(page, "read");
  await waitFor(() => page.locator("#modeBadge").innerText().then((value) => value.includes("只读")), "Redis read-only mode");
  await page.locator("[data-redis-key='cache:home']").click({ button: "right" });
  await waitFor(() => page.locator("#redisContextMenu").isVisible(), "read-only Redis context menu");
  const before = calls("delete_redis_key").length;
  expect(await page.locator("#redisContextMenu [data-redis-context-action='delete']").isDisabled(), "read-only delete should be disabled");
  await page.keyboard.press('Escape');
  expect(calls("delete_redis_key").length === before, "read-only Redis menu sent delete");
  expect(await page.locator("#confirmActionModal").isHidden(), "read-only Redis menu opened a delete confirmation");
  expect(redis.get("redis-remote").has("cache:home"), "read-only Redis menu deleted key");
  await page.locator(".redis-database[data-redis-db='0'] > summary").click({ button: "right" });
  expect(await page.locator("[data-redis-database-context-action='create']").isDisabled(), "read-only create should be disabled");
  await page.keyboard.press('Escape');
  expect(await page.locator("#redisCreateModal").isHidden(), "read-only database opened creation dialog");
});

await check("Redis SCAN empty pages retain a load-more control", async () => {
  await expandRedisDatabase(0);
  await ensureRedisMode(page, "write");
  await page.locator("#objectSearch").fill("empty");
  await waitFor(() => calls("list_redis_keys").some((entry) => entry.args?.pattern === "*empty*"), "empty Redis scan");
  expect(await page.locator("[data-load-more-redis-db]").count() === 1, "empty Redis page lost load-more control");
  const before = calls("list_redis_keys").length;
  await page.locator("[data-load-more-redis-db]").click();
  await waitFor(() => calls("list_redis_keys").length > before, "empty Redis next page");
});

await check("Redis MEMORY PURGE requires write confirmation", async () => {
  await page.locator("#addQueryTab").click();
  const editor = page.locator("#sqlEditor .cm-content");
  await editor.click();
  await page.keyboard.type("HG");
  await waitFor(() => page.locator(".cm-tooltip-autocomplete").isVisible(), `Redis editor completion: ${await editor.innerText()}`);
  expect((await page.locator(".cm-tooltip-autocomplete").innerText()).includes("HGET"), "Redis editor commands missing");
  await page.keyboard.press("Escape");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("MEMORY PURGE");
  const before = calls("execute_redis_command").length;
  let prompted = false;
  await page.locator("#runQuery").click();
  await page.locator("#confirmActionModal").waitFor();
  prompted = true;
  await page.locator("#confirmActionCancel").click();
  await wait(100);
  expect(prompted, "MEMORY PURGE was treated as a read-only command without confirmation");
  expect(calls("execute_redis_command").length === before, "cancelled MEMORY PURGE was executed");
});

await check("stale Redis scan cannot overwrite a newer connection", async () => {
  await page.locator("#objectSearch").fill("slow");
  await waitFor(() => calls("list_redis_keys").some((entry) => entry.args?.pattern === "*slow*"), "slow Redis scan");
  await ensureConnection("redis-local");
  await expandRedisDatabase(0);
  await page.locator("#objectSearch").fill("");
  await waitFor(() => page.locator("[data-redis-key='users:1']").count().then((count) => count === 1), "local Redis after race");
  await wait(450);
  expect(await page.locator("#connectionMode").innerText() === "已连接", "connection state was lost after stale scan");
  expect(await page.locator("#connectionList .connection-card.selected [data-connection-id]").getAttribute("data-connection-id") === "redis-local", "stale scan changed selected connection");
  expect(await page.locator("[data-redis-key='stale:remote']").count() === 0, "stale Redis response overwrote current keyspace");
});

console.log(JSON.stringify({ checks, redisCalls: redisCalls.length }, null, 2));
await context.close();
await browser.close();
await new Promise((resolveServer) => server.close(resolveServer));
if (checks.some((check) => !check.ok)) process.exitCode = 1;
