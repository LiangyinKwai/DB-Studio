import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { cellColumnName, sqlValueLiteral, sqlTypedValueLiteral } from "../src/cell-edit.js";
import { formatCellValue } from "../src/result-grid.js";

const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const mutationSource = mainSource.slice(mainSource.indexOf("function sqlLiteral(value"), mainSource.indexOf("function resultData() {"));
const transactionSource = mainSource.slice(mainSource.indexOf("function transactionDidRollback("), mainSource.indexOf("function cellWritePending("));

function fixture(type, { driver = "mysql", row = ["001", "001", { ok: true }, true], values = {} } = {}) {
  const columns = ["id", "code", "payload", "active"];
  const tab = {
    connectionId: "db", mode: "write", database: "app", schema: "public",
    browse: { schema: "public", name: "items", kind: "table", primaryKeys: ["id"], columns: columns.map(name => ({ name })) },
    result: { executed: true, columns, rows: [row] },
  };
  const inputs = columns.map((name, index) => ({
    dataset: { mutationColumn: name }, value: Object.hasOwn(values, name) ? values[name] : row[index] == null ? "" : formatCellValue(row[index]),
  }));
  const state = {
    tabs: [tab],
    mutation: { type, tab, columns, primaryKeys: ["id"], selectedRows: type === "insert" ? [] : [row] },
    activeConnectionId: "db", transactionKeys: new Set(["db/app"]),
  };
  const calls = [];
  const confirmations = [];
  const refs = {
    mutationFields: { innerHTML: "", querySelectorAll: () => inputs },
    mutationFeedback: { textContent: "", classList: { add() {}, remove() {} } },
    mutationTitle: {}, mutationHint: {}, applyMutation: {},
    mutationModal: { showModal() {}, close() {} },
  };
  const sandbox = {
    refs, state, sqlValueLiteral, sqlTypedValueLiteral, cellColumnName, cellText: formatCellValue,
    activeTab: () => tab, driverForTab: () => driver, cellWritePending: () => false,
    resultGrid: { getSelectedRows: () => [tab.result.rows[0]], getCellEditDraft: () => null },
    quoteIdentForDriver: (name, selectedDriver) => {
      const quote = selectedDriver === "mysql" ? "`" : '"';
      return quote + name.replaceAll(quote, quote + quote) + quote;
    },
    sqlEquality: (left, right, selectedDriver) => `${left} ${selectedDriver === "mysql" ? "<=>" : "IS NOT DISTINCT FROM"} ${right}`,
    confirmWrite: async sql => { confirmations.push(sql); return true; },
    call: async (command, args) => { calls.push({ command, args }); return { row_count: 1 }; },
    tabDatabase: () => "app", tabSchema: () => "public", makeId: () => "mutation-test",
    transactionKey: () => "db/app", renderTabs() {}, renderOutput() {}, showToast() {},
    errorText: error => error.message, escapeHtml: value => String(value).replaceAll('"', "&quot;"),
  };
  const runtime = vm.createContext(sandbox);
  vm.runInContext(transactionSource + mutationSource, runtime, { filename: "main-row-mutation.js" });
  return { tab, state, refs, calls, confirmations, runtime, submit: () => runtime.applyMutation() };
}

test("shared SQL literals distinguish real values from numeric-looking and boolean-looking text", () => {
  assert.equal(sqlValueLiteral("001"), "E'001'");
  assert.equal(sqlValueLiteral("true"), "E'true'");
  assert.equal(sqlValueLiteral(""), "E''");
  assert.equal(sqlValueLiteral("  "), "E'  '");
  assert.equal(sqlValueLiteral(1), "1");
  assert.equal(sqlValueLiteral(true), "true");
  assert.equal(sqlValueLiteral(false), "false");
  assert.equal(sqlValueLiteral(null), "NULL");
  assert.equal(sqlValueLiteral({ ok: true, items: [1, null] }), 'E\'{"ok":true,"items":[1,null]}\'');
  for (const value of [undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sqlValueLiteral(value));
});

test("real MySQL delete handler keeps text primary keys as exact UTF-8 values", async () => {
  for (const key of ["001", "1", "true", "O'Reilly\\path", "", " "]) {
    const f = fixture("delete", { row: [key, "001", { ok: true }, true] });
    await f.submit();
    assert.equal(f.calls.length, 1);
    const expected = `DELETE FROM \`public\`.\`items\`\nWHERE (\`id\` <=> CONVERT(X'${Buffer.from(key).toString("hex")}' USING utf8mb4));`;
    assert.equal(f.calls[0].args.request.sql, expected);
    assert.equal(f.confirmations[0], expected);
  }
});

test("real PostgreSQL delete handler preserves actual numeric and text key types", async () => {
  for (const key of ["001", 12, false]) {
    const f = fixture("delete", { driver: "postgres", row: [key, "001", { ok: true }, true] });
    await f.submit();
    assert.equal(f.calls[0].args.request.sql, `DELETE FROM "public"."items"\nWHERE ("id" IS NOT DISTINCT FROM ${sqlValueLiteral(key)});`);
  }
});

test("MySQL row deletion locates BIT and binary primary keys without coercing them to text", async () => {
  for (const [value, dataType, literal] of [['255', 'bit(8)', '255'], [{ $dbStudio: 'mysql-binary', hex: '00ff' }, 'varbinary(8)', "X'00ff'"]]) {
    const f = fixture('delete', { row: [value, '001', {}, true] });
    f.tab.browse.columns[0].dataType = dataType;
    await f.submit();
    assert.ok(f.calls[0].args.request.sql.includes('`id` <=> ' + literal));
  }
});

test("MySQL row mutation synchronizes a confirmed rollback while retaining an unexecuted rejection", async () => {
  for (const [message, retained] of [['[TX_ROLLED_BACK] conflict', false], ['current transaction retained; DDL blocked', true]]) {
    const f = fixture('edit', { values: { code: 'changed' } });
    f.tab.result.cellEditsInTransaction = true;
    f.runtime.call = async () => { throw new Error(message); };
    await f.submit();
    assert.equal(f.state.transactionKeys.has('db/app'), retained);
    assert.equal(Boolean(f.tab.result.transactionRolledBack), !retained);
  }
});

test("row mutation refuses stale results, readonly state and nontransactional MySQL writes in a transaction", async () => {
  for (const change of [f => { f.tab.mode = 'read'; }, f => { f.tab.result.schemaChanged = true; }, f => { f.tab.result.transactionRolledBack = true; }, f => { f.tab.browse.engine = 'MyISAM'; }, f => { f.state.mutation.result = {}; }]) {
    const f = fixture('edit', { values: { code: 'changed' } }); change(f); await f.submit();
    assert.equal(f.calls.length, 0); assert.equal(f.confirmations.length, 0);
    assert.match(f.refs.mutationFeedback.textContent, /状态已改变|引擎不能保证回滚/);
  }
});

test("real row edit only writes changed fields and leaves untouched JSON and leading-zero text alone", async () => {
  const f = fixture("edit", { values: { code: "002" } });
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.request.sql, "UPDATE `public`.`items`\nSET `code` = CONVERT(X'303032' USING utf8mb4)\nWHERE `id` <=> CONVERT(X'303031' USING utf8mb4);");
});

test("real row edit retains actual boolean semantics when its boolean field changes", async () => {
  const f = fixture("edit", { values: { active: "false" } });
  await f.submit();
  assert.ok(f.calls[0].args.request.sql.includes("SET `active` = false"));
});

test("opening and submitting an unchanged row performs no write", async () => {
  const f = fixture("edit");
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.refs.mutationFeedback.textContent, "尚未修改任何字段");
});

test("real insert handler does not interpret input text as a numeric or boolean expression", async () => {
  const f = fixture("insert", { values: { id: "", code: "001", payload: '{"n":9007199254740993}', active: "true" } });
  await f.submit();
  const sql = f.calls[0].args.request.sql;
  assert.ok(sql.includes("CONVERT(X'303031' USING utf8mb4)"));
  assert.ok(sql.includes(`CONVERT(X'${Buffer.from('{"n":9007199254740993}').toString("hex")}' USING utf8mb4)`));
  assert.ok(sql.includes("CONVERT(X'74727565' USING utf8mb4)"));
});

test("invalid key values fail before confirmation or dispatch and preserve the row dialog", async () => {
  const f = fixture("delete", { row: [Number.MAX_SAFE_INTEGER + 1, "001", {}, true] });
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.ok(f.refs.mutationFeedback.textContent.includes("无法生成写入语句"));
  assert.ok(f.state.mutation);
});

test("row dialogs follow actual result column order and format JSON as editable source", () => {
  const f = fixture("edit");
  f.tab.result.columns = ["code", { name: "id" }, "payload", "active"];
  f.runtime.openMutation("edit");
  assert.deepEqual([...f.state.mutation.columns], ["code", "id", "payload", "active"]);
  assert.ok(f.refs.mutationFields.innerHTML.includes("{&quot;ok&quot;:true}"));
  assert.ok(!f.refs.mutationFields.innerHTML.includes("[object Object]"));
});

test("insert and edit dialogs allow primary key values", () => {
  const f = fixture("insert", { driver: "postgres" });
  f.runtime.openMutation("insert");
  assert.match(f.refs.mutationFields.innerHTML, /data-mutation-column="id" value=""\/>/);
  f.runtime.openMutation("edit");
  assert.match(f.refs.mutationFields.innerHTML, /data-mutation-column="id" value="001"\/>/);
});

test('row edit updates a primary key using its old value and later delete uses its new value within the transaction', async () => {
  const f = fixture('edit', { values: { id: '9007199254740995', code: 'changed' } });
  f.tab.browse.columns[0] = { name: 'id', primaryKey: true, identity: true, dataType: 'bigint' };
  await f.submit();
  const sql = f.calls[0].args.request.sql;
  assert.match(sql, /SET `id` = CONVERT\(X'39303037313939323534373430393935'/);
  assert.match(sql, /WHERE `id` <=> CONVERT\(X'303031'/);
  assert.equal(f.tab.result.rows[0][0], '9007199254740995');
  assert.equal(f.tab.result.cellEditsInTransaction, true);
  f.runtime.openMutation('delete'); await f.submit();
  assert.match(f.calls[1].args.request.sql, /WHERE \(`id` <=> CONVERT\(X'39303037313939323534373430393935'/);
});

test('row edit can update both composite key components in one statement with the original predicate', async () => {
  const f = fixture('edit', { driver: 'postgres', values: { id: '9007199254740995', code: 'tenant-new' } });
  f.tab.browse.primaryKeys = f.state.mutation.primaryKeys = ['id', 'code'];
  await f.submit();
  assert.equal(f.calls[0].args.request.sql, 'UPDATE "public"."items"\nSET "id" = E\'9007199254740995\', "code" = E\'tenant-new\'\nWHERE "id" IS NOT DISTINCT FROM E\'001\' AND "code" IS NOT DISTINCT FROM E\'001\';');
  assert.deepEqual(Array.from(f.tab.result.rows[0]).slice(0, 2), ['9007199254740995', 'tenant-new']);
});

test('a missing row cannot apply a new key locally or incorrectly close a live PostgreSQL transaction', async () => {
  const f = fixture('edit', { driver: 'postgres', values: { id: 'new-key' } });
  f.runtime.call = async () => ({ row_count: 0 }); await f.submit();
  assert.equal(f.tab.result.rows[0][0], '001');
  assert.equal(f.state.transactionKeys.has('db/app'), true);
  assert.match(f.refs.mutationFeedback.textContent, /未报告唯一匹配行/);
});

test("inserts exclude generated and ALWAYS identity fields even if disabled inputs contain text", async () => {
  const f = fixture("insert", { driver: "postgres", values: { id: "99", code: "generated", payload: "{}", active: "true" } });
  f.tab.browse.columns[0] = { name: "id", primaryKey: true, identity: true, identityGeneration: "always" };
  f.tab.browse.columns[1] = { name: "code", generated: true };
  await f.submit();
  assert.equal(f.calls[0].args.request.sql, 'INSERT INTO "public"."items" ("payload", "active")\nVALUES (E\'{}\', E\'true\');');
});

test("BY DEFAULT identity permits an explicit key without losing precision", async () => {
  const f = fixture("insert", { driver: "postgres", values: { id: "9007199254740993", code: "", payload: "", active: "" } });
  f.tab.browse.columns[0] = { name: "id", primaryKey: true, identity: true, identityGeneration: "byDefault" };
  await f.submit();
  assert.equal(f.calls[0].args.request.sql, 'INSERT INTO "public"."items" ("id")\nVALUES (E\'9007199254740993\');');
});

test("an all-default insert uses each database's default-row syntax", async () => {
  for (const driver of ["postgres", "mysql"]) {
    const f = fixture("insert", { driver, values: { id: "", code: "", payload: "", active: "" } });
    await f.submit();
    assert.equal(f.calls[0].args.request.sql, driver === "postgres"
      ? 'INSERT INTO "public"."items" DEFAULT VALUES;'
      : 'INSERT INTO `public`.`items` () VALUES ();');
  }
});

test("row edits exclude generated fields even if stale inputs contain a changed value", async () => {
  const f = fixture("edit", { driver: "postgres", values: { code: "002", payload: "changed generated value" } });
  f.tab.browse.columns[2] = { name: "payload", generated: true };
  await f.submit();
  assert.equal(f.calls[0].args.request.sql, 'UPDATE "public"."items"\nSET "code" = E\'002\'\nWHERE "id" IS NOT DISTINCT FROM E\'001\';');
});
