import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
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
const redisCalls = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (command, args) => { const entry = { command, args, at: Date.now() }; redisCalls.push(entry); fixture.calls.push(entry); return entry; };
const requireConnection = (args, command) => {
  if (typeof args?.connectionId !== "string" || !args.connectionId) throw new Error(`${command}: connectionId must be a string`);
  return args.connectionId;
};
const storeFor = (connectionId) => redis.get(connectionId) || new Map();
function valuePayload(connectionId, key) {
  const item = storeFor(connectionId).get(key);
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
if (!["list_redis_keys", "get_redis_value", "execute_redis_command", "save_redis_cell", "delete_redis_key", "rename_redis_key"].includes(command)) return originalInvoke(command, args);
  record(command, args);
  if (command === "list_redis_keys") {
    const connectionId = requireConnection(args, command);
    if (args.database === 1) return { cursor: 0, keys: ["otherdb:key"] };
    if (String(args.pattern || "").includes("slow")) await wait(350);
    const pattern = String(args.pattern || "").replace(/^\*|\*$/g, "");
    if (pattern === "empty") return { cursor: args.cursor ? 0 : 12, keys: [] };
    if (pattern === "slow") return { cursor: 0, keys: ["stale:remote"] };
    const keys = [...storeFor(connectionId).keys()].filter((key) => !pattern || key.includes(pattern));
    return { cursor: 0, keys };
  }
  if (command === "get_redis_value") {
    const connectionId = requireConnection(args, command);
    return valuePayload(connectionId, String(args.key));
  }
  if (command === "save_redis_cell") {
    const request = args?.request || {};
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const item = storeFor(connectionId).get(String(request.key));
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
    const set = sql.match(/^SET\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/i);
    const hash = sql.match(/^HSET\s+"((?:[^"\\]|\\.)*?)"\s+"((?:[^"\\]|\\.)*?)"\s+"((?:[^"\\]|\\.)*)"/i);
    if (set) storeFor(connectionId).get(set[1].replaceAll('\\"', '"')).value = set[2];
    if (hash) storeFor(connectionId).get(hash[1]).fields.set(hash[2], hash[3]);
    return { columns: ["result"], rows: [["OK"]], rowCount: 1, elapsedMs: 0.1 };
  }
  if (command === "delete_redis_key") {
    const connectionId = requireConnection(args, command);
    if (args.readOnly) throw new Error("Redis mutation is read-only");
    return storeFor(connectionId).delete(String(args.key)) ? 1 : 0;
  }
  if (command === "rename_redis_key") {
    const request = args?.request || {};
    const connectionId = requireConnection(request, command);
    if (request.readOnly) throw new Error("Redis mutation is read-only");
    const current = storeFor(connectionId);
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
  if ((await database.getAttribute("open")) !== "") await database.locator("> summary").click();
  return database;
};

await check("Redis logical databases can be expanded independently", async () => {
  await ensureConnection("redis-local");
  await waitFor(() => page.locator(".redis-database[data-redis-db='0']").count().then((count) => count === 1), "Redis DB 0");
  await waitFor(() => page.locator(".redis-database[data-redis-db='1']").count().then((count) => count === 1), "Redis DB 1");
  expect(await page.locator(".redis-database[open]").count() === 0, "Redis DB 0 opened by default");
  const before = calls("list_redis_keys").length;
  await expandRedisDatabase(0);
  await waitFor(() => calls("list_redis_keys").slice(before).some((entry) => entry.args?.database === 0), "Redis DB 0 scan");
  await page.locator(".redis-database[data-redis-db='1'] > summary").click();
  await waitFor(() => calls("list_redis_keys").slice(before).some((entry) => entry.args?.database === 1), "Redis DB 1 scan");
  expect(await page.locator(".redis-database[open]").count() === 2, "multiple Redis DBs were not kept expanded");
});

await check("Redis hash cell save uses CAS request and preserves connection scope", async () => {
  await ensureConnection("redis-local");
  await expandRedisDatabase(0);
  await waitFor(() => page.locator("[data-redis-key='users:1']").count().then((count) => count === 1), "local Redis keys");
  await page.locator("[data-redis-key='users:1']").click();
  await waitFor(() => page.locator("#tableToolbarTitle").innerText().then((value) => value.trim() === "users:1"), "local Redis tab");
  expect(await page.locator("#queryConnection, #queryDatabase").count() === 0, "connection/database pickers are still present");
  await ensureConnection("redis-remote");
  await ensureConnection("redis-local");
  await ensureRedisMode(page, "write");
  await page.locator("#resultGrid .db-grid-cell").nth(1).dblclick();
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
  await page.locator("#resultGrid .db-grid-cell").nth(1).dblclick();
  await waitFor(() => page.locator("#cellModal").isVisible(), "second hash cell modal");
  await page.locator("#cellValue").fill("Rejected");
  const before = calls("save_redis_cell").length;
  await page.locator("#saveCell").click();
  await page.locator("#confirmActionCancel").click();
  await wait(120);
  expect(calls("save_redis_cell").length === before, "cancelled confirmation still sent mutation");
  expect(redis.get("redis-local").get("users:1").fields.get("name") === "Grace", "cancelled confirmation mutated value");
  await page.locator("#closeCell").click();
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
  await page.locator("#redisContextMenu [data-redis-context-action='delete']").click();
  await wait(120);
  expect(calls("delete_redis_key").length === before, "read-only Redis menu sent delete");
  expect(await page.locator("#confirmActionModal").isHidden(), "read-only Redis menu opened a delete confirmation");
  expect(redis.get("redis-remote").has("cache:home"), "read-only Redis menu deleted key");
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
  const editor = page.locator(".cm-content");
  await editor.click();
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
