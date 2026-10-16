import assert from "node:assert/strict";
import test from "node:test";
import { isQueryCancellation } from "../src/query-status.js";

test("recognizes localized and PostgreSQL cancellation errors", () => {
  assert.equal(isQueryCancellation("查询已取消"), true);
  assert.equal(isQueryCancellation(new Error("query cancelled by user")), true);
  assert.equal(isQueryCancellation("ERROR 57014: canceling statement due to user request"), true);
  assert.equal(isQueryCancellation({ code: "57014", message: "canceling statement" }), true);
});

test("does not turn ordinary query failures into cancellations", () => {
  assert.equal(isQueryCancellation("连接超时"), false);
  assert.equal(isQueryCancellation(new Error("permission denied for table orders")), false);
  assert.equal(isQueryCancellation(null), false);
});
