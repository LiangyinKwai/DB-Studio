/**
 * Browser-only Tauri invoke fixture. It deliberately rejects malformed
 * connection ids so UI handlers cannot hide argument-shape regressions.
 * This is not a PostgreSQL emulator and must never be used as a product
 * runtime or a substitute for an end-to-end database test.
 */
export function createWorkspaceFixture() {
  const calls = [];
  const pending = new Map();
  const profiles = [
    { id: "conn-dev", name: "开发库", driver: "postgres", host: "fixture.local", port: 5432, database: "app", user: "fixture", sslMode: "disable" },
    { id: "conn-stage", name: "预发布库", driver: "postgres", host: "stage.local", port: 5432, database: "app_stage", user: "fixture", sslMode: "disable" },
    { id: "redis-local", name: "本地 Redis", driver: "redis", host: "redis.local", port: 6379, database: "0", redisDb: 0, user: "", tls: false },
  ];
  // Keep the fixture's catalog database-aware. The real Tauri command opens
  // the selected database before listing its schemas, so returning one global
  // list here would hide regressions where the picker applies a schema from a
  // different database.
  const schemas = [{ name: "public" }, { name: "analytics" }];
  const schemasByDatabase = {
    app: schemas,
    app_reporting: [{ name: "reporting" }],
    app_stage: schemas,
    app_stage_reporting: [{ name: "reporting" }],
  };
  const rowsFor = (count, width = 3, start = 0) => Array.from({ length: count }, (_, index) => {
    const id = start + index + 1;
    return Array.from({ length: width }, (_, col) => col === 0 ? String(id) : col === 1 ? `value-${id}` : `2026-09-${String((id % 28) + 1).padStart(2, "0")}`);
  });
  const tableObjects = [
    { id: "public.orders", schema: "public", name: "orders", kind: "table", qualifiedName: "public.orders", columns: [{ name: "id", dataType: "bigint" }, { name: "status", dataType: "text", comment: "订单状态" }] },
    { id: "public.exact_100", schema: "public", name: "exact_100", kind: "table", qualifiedName: "public.exact_100", columns: [{ name: "id", dataType: "bigint" }, { name: "status", dataType: "text", comment: "订单状态" }] },
    { id: "public.orders_view", schema: "public", name: "orders_view", kind: "view", qualifiedName: "public.orders_view", columns: [{ name: "id", dataType: "bigint" }, { name: "status", dataType: "text", comment: "订单状态" }] },
    { id: "public.refresh_proc", schema: "public", name: "refresh_orders", kind: "procedure", signature: "refresh_orders()", qualifiedName: "public.refresh_orders" },
  ];
  const objectsBySchema = {
    public: tableObjects,
    analytics: [
      { id: "analytics.events", schema: "analytics", name: "events", kind: "table", qualifiedName: "analytics.events", columns: [{ name: "id" }, { name: "event_name" }] },
    ],
    reporting: [
      { id: "reporting.daily_orders", schema: "reporting", name: "daily_orders", kind: "view", qualifiedName: "reporting.daily_orders", columns: [{ name: "day" }, { name: "order_count" }] },
    ],
  };
  const callsFor = (command) => calls.filter((entry) => entry.command === command);
  const record = (command, args) => {
    const entry = { command, args, at: Date.now() };
    calls.push(entry);
    return entry;
  };
  const requireStringConnection = (args, command) => {
    const connectionId = args?.connectionId;
    if (typeof connectionId !== "string" || !connectionId) throw new Error(`${command}: connectionId must be a string`);
    return connectionId;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const execute = async (args) => {
    const request = args?.request || {};
    requireStringConnection(request, "execute_query");
    const queryId = request.queryId;
    const sql = String(request.sql || "");
    if (/fixture_delay/i.test(sql)) {
      return new Promise((resolve, reject) => {
        pending.set(queryId, { resolve, reject, sql });
      });
    }
    if (/fixture_big_grid/i.test(sql)) {
      return { columns: Array.from({ length: 100 }, (_, index) => `c${index + 1}`), rows: rowsFor(1000, 100), elapsed_ms: 2.5, truncated: false };
    }
    const offset = Number(sql.match(/OFFSET\s+(\d+)/i)?.[1] || 0);
    const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] || 100);
    if (/FROM\s+"public"\."orders"/i.test(sql)) {
      const available = offset >= 500 ? 37 : Math.min(limit, 501);
      return { columns: ["id", "status", "created_at"], rows: rowsFor(available, 3, offset), elapsed_ms: 4.2, truncated: false };
    }
    if (/FROM\s+"public"\."exact_100"/i.test(sql)) {
      return { columns: ["id", "status", "created_at"], rows: rowsFor(100, 3, offset), elapsed_ms: 4.2, truncated: false };
    }
    if (/fixture_filter/i.test(sql)) {
      return {
        columns: ["id", "label", "note"],
        rows: [["1", "needle", "comma, value"], ["2", "other", "line\none"], ["3", "needle", 'quote "value"'], ["4", "other", "plain"]],
        elapsed_ms: 1.4,
        truncated: false,
      };
    }
    if (/fixture_tab_a/i.test(sql)) return { columns: ["source", "value"], rows: [["tab-a", "A"]], elapsed_ms: 1.1, truncated: false };
    if (/fixture_tab_b/i.test(sql)) return { columns: ["source", "value"], rows: [["tab-b", "B"]], elapsed_ms: 1.1, truncated: false };
    return { columns: ["status", "count"], rows: [["ACTIVE", "3"], ["DRAFT", "1"]], elapsed_ms: 3.1, truncated: false };
  };
  const settlePending = (queryId, error = false) => {
    const active = pending.get(queryId);
    if (!active) return false;
    pending.delete(queryId);
    if (error) active.reject(new Error(`fixture delayed error (${active.sql})`));
    else active.resolve({ columns: ["status"], rows: [["late"]], elapsed_ms: 8.8, truncated: false });
    return true;
  };
  const invoke = async (command, args) => {
    record(command, args);
    switch (command) {
      case "list_connections": return profiles;
      case "save_connection": return args?.request?.profile || profiles[0];
      case "test_connection": return true;
      case "delete_connection": return true;
      case "connect_connection": requireStringConnection(args, command); return true;
      case "disconnect_connection": requireStringConnection(args, command); return true;
      case "list_databases": {
        const connectionId = requireStringConnection(args, command);
        const profile = profiles.find((item) => item.id === connectionId) || profiles[0];
        return [
          { name: profile.database, allowConnections: true, current: true },
          { name: `${profile.database}_reporting`, allowConnections: true, current: false },
        ];
      }
      case "mysql_character_settings": requireStringConnection(args, command); return {
        defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
        choices: [ { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', isDefault: true }, { charset: 'utf8mb4', collation: 'utf8mb4_bin', isDefault: false }, { charset: 'latin1', collation: 'latin1_swedish_ci', isDefault: true } ],
        tableCharset: 'utf8mb4', tableCollation: 'utf8mb4_bin', columns: [{ name: 'title', charset: 'utf8mb4', collation: 'utf8mb4_bin' }],
      };
      case "release_mysql_database_pool": requireStringConnection(args, command); return true;
      case "release_postgres_catalog": requireStringConnection(args, command); return true;
      case "get_query_context": {
        const connectionId = requireStringConnection(args, command);
        const profile = profiles.find((item) => item.id === connectionId) || profiles[0];
        const database = args?.database || profile.database;
        const schema = database.endsWith("_reporting") ? "reporting" : "public";
        return { database, defaultSchema: schema, searchPath: [schema] };
      }
      case "list_schemas": {
        requireStringConnection(args, command);
        return schemasByDatabase[args?.database] || schemas;
      }
      case "get_schema_objects": {
        requireStringConnection(args, command);
        return args?.schemaName ? (objectsBySchema[args.schemaName] || []) : tableObjects;
      }
      case "get_object_details": requireStringConnection(args, command); return {
        kind: "table", qualifiedName: "public.orders", columns: [{ name: "id", dataType: "integer", nullable: false, primaryKey: true }, { name: "status", dataType: "text", nullable: false }], indexes: [], constraints: [], definition: "CREATE TABLE public.orders (...);",
      };
      case "begin_transaction": requireStringConnection(args, command); return true;
      case "commit_transaction": requireStringConnection(args, command); return true;
      case "rollback_transaction": requireStringConnection(args, command); return true;
      case "execute_mutation": {
        const request = args?.request || {};
        requireStringConnection(request, command);
        if (/^\s*(?:\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))*\s*(SELECT|WITH|EXPLAIN|SHOW|VALUES)\b/i.test(request.sql || ""))
          return execute({ request });
        return { columns: [], rows: [], row_count: /DELETE|UPDATE|INSERT/i.test(request.sql || "") ? 1 : 0, elapsed_ms: 1.2, truncated: false };
      }
      case "execute_query": return execute(args);
      case "list_redis_keys": {
        requireStringConnection(args, command);
        return { cursor: 0, keys: ["users:1", "cache:home"] };
      }
      case "list_redis_databases": {
        requireStringConnection(args, command);
        return [
          { index: 0, keyCount: 2, current: true },
          { index: 1, keyCount: 0, current: false },
        ];
      }
      case "get_redis_value": {
        requireStringConnection(args, command);
        return { key: args.key, keyType: "hash", ttl: 120, columns: ["field", "value"], rows: [["name", "Ada"], ["role", "admin"]], raw: { name: "Ada", role: "admin" } };
      }
      case "execute_redis_command": {
        const request = args?.request || {};
        requireStringConnection(request, command);
        return { columns: ["result"], rows: [["OK"]], rowCount: 1, elapsedMs: 0.4, raw: "OK" };
      }
      case "delete_redis_key": requireStringConnection(args, command); return 1;
      case "rename_redis_key": requireStringConnection(args?.request, command); return true;
      case "cancel_query": {
        const queryId = args?.queryId;
        record("cancel_query_effective", args);
        const active = pending.get(queryId);
        if (!active) return false;
        pending.delete(queryId);
        active.reject(new Error("query cancelled by user"));
        return true;
      }
      // Native dialog cancellation is represented by false. The browser
      // fixture intentionally exposes the old fallback so the regression is
      // visible as a failed check until the UI handles false as cancellation.
      case "save_text_file": return false;
      default: throw new Error(`fixture has no command: ${command}`);
    }
  };
  return {
    calls,
    callsFor,
    pending,
    profiles,
    schemas,
    schemasByDatabase,
    tableObjects,
    objectsBySchema,
    invoke,
    resolvePending: (queryId) => settlePending(queryId, false),
    rejectPending: (queryId) => settlePending(queryId, true),
  };
}
