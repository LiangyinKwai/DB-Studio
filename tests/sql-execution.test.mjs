import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { queryEditRelation, sqlExecutionInfo, sqlTransactionAction } from "../src/sql-execution.js";
import { isQueryCancellation } from "../src/query-status.js";

test("query edits require a single unambiguous source relation", () => {
  assert.deepEqual(queryEditRelation('SELECT o.id, o.name FROM "sales"."Orders" o WHERE o.id > 2 ORDER BY o.id;', "postgres"), ["sales", "Orders"]);
  assert.deepEqual(queryEditRelation("SELECT * FROM `warehouse`.`orders` WHERE name = 'a,b' LIMIT 5;", "mysql"), ["warehouse", "orders"]);
  for (const sql of [
    "SELECT a.id, b.name FROM orders a JOIN orders b ON a.id <> b.id",
    "SELECT a.id, b.name FROM orders a, orders b WHERE a.id <> b.id",
    "SELECT * FROM orders UNION ALL SELECT * FROM old_orders",
    "SELECT * FROM (SELECT * FROM orders) t",
    "WITH orders AS (SELECT * FROM other_orders) SELECT * FROM orders",
    "SELECT * FROM orders; SELECT * FROM old_orders",
    "SELECT * FROM orders /*! JOIN old_orders ON old_orders.id=orders.id */",
  ]) {
    for (const driver of ["postgres", "mysql"]) assert.equal(queryEditRelation(sql, driver), null, sql);
  }
});

test("SQL execution routes full scripts instead of classifying just their first keyword", () => {
  assert.deepEqual(sqlExecutionInfo("SELECT 1; ALTER TABLE t ADD COLUMN flag boolean;"), { count: 2, keywords: ["SELECT", "ALTER"], singleRead: false });
  assert.equal(sqlExecutionInfo("-- comment\n SELECT ';' AS value;").singleRead, true);
  assert.equal(sqlExecutionInfo("SELECT 1; SELECT 2;").singleRead, false);
  assert.equal(sqlExecutionInfo("/* only a comment */").count, 0);
});
test("DDL, Unicode comments, dollar-quoted bodies and quoted separators stay intact", () => {
  const sql = "ALTER TABLE upsell.upsell_cart_modules ADD COLUMN IF NOT EXISTS enable_celebration BOOLEAN NOT NULL DEFAULT FALSE; COMMENT ON COLUMN upsell.upsell_cart_modules.enable_celebration IS '阶梯奖励; 中文注释';";
  assert.deepEqual(sqlExecutionInfo(sql).keywords, ["ALTER", "COMMENT"]);
  assert.equal(sqlExecutionInfo("DO $$ BEGIN PERFORM 1; END $$; SELECT 1;").count, 2);
  assert.equal(sqlExecutionInfo("SELECT `a;b` FROM `t`;", "mysql").count, 1);
});

test("only complete PostgreSQL and MySQL transaction commands use the managed session", () => {
  for (const driver of ["postgres", "mysql"]) {
    for (const [sql, action] of [["BEGIN", "begin"], ["START TRANSACTION;", "begin"], ["-- 注释\n COMMIT; -- done", "commit"], ["rollback /* comment */ work;", "rollback"]]) {
      assert.equal(sqlTransactionAction(sql, driver), action);
    }
    for (const sql of ["BEGIN; UPDATE t SET x=1;", "ROLLBACK TO SAVEPOINT s", "BEGIN READ ONLY", "COMMIT AND CHAIN", "/* BEGIN */", "BEGIN /* unterminated", "/*!40101 COMMIT */ BEGIN", "SELECT 'BEGIN'"]) {
      assert.equal(sqlTransactionAction(sql, driver), null);
    }
  }
});

test("SQL executes directly unless it would discard unsaved cell edits", async () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const description = source.slice(source.indexOf('function queryTargetDescription('), source.indexOf('async function loadQueryTarget('));
  const confirmation = source.slice(source.indexOf('const discardDraftMessage'), source.indexOf('function firstRedisCommand('));
  for (const driver of ['postgres', 'mysql']) {
    const tab = { connectionId: 'test', database: 'test', schema: 'new_schema' };
    const calls = [];
    const profile = { id: 'test', name: '测试环境', host: 'fixture.local', port: driver === 'postgres' ? 5432 : 3306, database: 'shopify', user: 'shopify', driver };
    const context = vm.createContext({
      state: { profiles: [profile] }, sqlExecutionInfo, activeTab: () => tab,
      driverForTab: () => driver, queryTargetData: () => null,
      tabDatabase: value => value.database, tabSchema: value => value.schema,
      confirmAction: async (message, options) => { calls.push({ message, options }); return true; },
    });
    vm.runInContext(description + confirmation, context);
    const sql = 'INSERT INTO example (id) VALUES (1)';
    assert.equal(await context.confirmWrite(sql, tab), true);
    assert.equal(calls.length, 0);
    await context.confirmWrite('SELECT 1', tab);
    assert.equal(calls.length, 0);
    await context.confirmWrite(sql, tab, { hasDrafts: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].message, /尚未保存的单元格修改/u);
    assert.equal(calls[0].options.detail, sql);
    assert.equal(calls[0].options.acceptLabel, "放弃并执行");
  }
});

test("a pending cancel request cannot hide an uncertain PostgreSQL write outcome", async () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const execution = source.slice(source.indexOf('async function runQuery('), source.indexOf('async function changeTransaction('));
  const transactions = source.slice(source.indexOf('function transactionDidRollback('), source.indexOf('function cellWritePending('));
  for (const [message, txOpen, unknown] of [
    ['[PG_OUTCOME_UNKNOWN] execution result unknown', false, true],
    ['[TX_MISSING] [TX_OUTCOME_UNKNOWN] transaction result unknown', true, true],
    ['[TX_ROLLED_BACK] 查询已取消', true, false],
  ]) {
    const tab = { id: 'query', connectionId: 'pg', database: 'app', sql: 'UPDATE items SET value = 1', mode: 'write', result: {} };
    const notices = [];
    const state = {
      tabs: [tab], profiles: [{ id: 'pg', driver: 'postgres' }], connectionStatuses: { pg: 'connected' },
      transactionKeys: new Set(txOpen ? ['pg/app'] : []),
      editor: { plugin: () => null, state: { selection: { main: { from: 0, to: 0 } }, sliceDoc: () => '' } },
    };
    const context = vm.createContext({
      state, sqlIme: {}, sqlExecutionInfo, sqlTransactionAction, isQueryCancellation, performance,
      isSqlQueryTab: () => true,
      runningViewWrites: new Set(),
      activeTab: () => tab, activeExecutionTab: () => tab, cellWritePending: () => false,
      cellDraftsForTabs: () => [], hasSavingCellDrafts: () => false, confirmWrite: async () => true,
      renderTabs() {}, renderOutput() {}, loadQueryTarget: async () => ({ context: { database: 'app' } }),
      tabDatabase: () => 'app', tabSchema: () => 'public', queryTargetDescription: () => 'pg/app',
      transactionKey: () => 'pg/app', makeId: () => 'query-run', emptyResult: () => ({}),
      errorText: error => error.message || String(error), showToast: value => notices.push(value),
      call: async () => { tab.cancelRequested = true; throw new Error(message); },
    });
    vm.runInContext(transactions + execution, context);
    await context.runQuery();
    assert.equal(tab.cancelled, !unknown);
    assert.equal(tab.error, unknown);
    assert.equal(state.transactionKeys.has('pg/app'), false);
    if (unknown) {
      assert.ok(tab.message.includes(message));
      assert.equal(tab.executionSummary.failure.unknown, true);
      assert.equal(tab.executionSummary.failure.detail, message);
      assert.equal(tab.executionSummary.statements[0].sql, tab.sql);
      assert.ok(notices.at(-1).includes(message));
      assert.doesNotMatch(tab.message, /查询已取消|事务已回滚/);
    } else {
      assert.match(tab.message, /查询已取消/);
      assert.equal(tab.executionSummary, null);
    }
  }
});
