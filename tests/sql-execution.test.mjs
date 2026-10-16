import test from "node:test";
import assert from "node:assert/strict";
import { sqlExecutionInfo } from "../src/sql-execution.js";

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
