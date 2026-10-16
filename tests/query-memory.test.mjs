import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateResultBytes,
  MAX_CACHED_RESULTS,
  MAX_RESULT_BYTES,
  selectResultsToRelease,
} from "../src/query-memory.js";

function tab(id, bytes = 1, finishedAt = id) {
  return { id, result: { executed: true, columns: ["value"], rows: [["data"]], bytes, finishedAt } };
}

test("estimates nested JSON values and UTF-16 text without serializing results", () => {
  const plain = { columns: [{ name: "payload" }], rows: [[{ items: [null, true, 42, "hello"] }]] };
  const longer = { columns: [{ name: "payload" }], rows: [[{ items: [null, true, 42, "hello中文😀"] }]] };
  assert.ok(estimateResultBytes(plain) > 0);
  assert.equal(estimateResultBytes(longer) - estimateResultBytes(plain), "中文😀".length * 2);
  const noSerialization = { columns: ["x"], rows: [[{ toJSON() { throw new Error("must not serialize"); }, text: "x" }]] };
  assert.doesNotThrow(() => estimateResultBytes(noSerialization));
  assert.equal(estimateResultBytes(null), 0);
});

test("estimation tolerates shared references and deeply nested values", () => {
  const shared = { value: "data" };
  const cyclic = [shared, shared];
  cyclic.push(cyclic);
  assert.ok(Number.isFinite(estimateResultBytes({ rows: cyclic })));
  let deep = "text";
  for (let index = 0; index < 20_000; index++) deep = [deep];
  assert.doesNotThrow(() => estimateResultBytes({ rows: deep }));
});

test("keeps results at both budget boundaries and ignores unexecuted tabs", () => {
  assert.equal(MAX_CACHED_RESULTS, 6);
  assert.equal(MAX_RESULT_BYTES, 24 * 1024 * 1024);
  const tabs = Array.from({ length: MAX_CACHED_RESULTS }, (_, id) => tab(id, MAX_RESULT_BYTES / MAX_CACHED_RESULTS));
  assert.deepEqual(selectResultsToRelease([...tabs, { result: { executed: false, bytes: MAX_RESULT_BYTES } }]), []);
  assert.deepEqual(selectResultsToRelease(null), []);
});

test("releases the oldest result first when result count exceeds the budget", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5), tab(6), tab(7)];
  const original = [...tabs];
  assert.deepEqual(selectResultsToRelease([...tabs].reverse()), [tabs[0]]);
  assert.deepEqual(tabs, original);
  assert.ok(tabs.every((item) => item.result.executed));
});

test("releases enough old results to satisfy bytes and uses estimates when metadata is missing", () => {
  const tabs = [tab(1, 10 * 1024 * 1024), tab(2, 10 * 1024 * 1024), tab(3, 20 * 1024 * 1024)];
  assert.deepEqual(selectResultsToRelease(tabs), [tabs[0], tabs[1]]);
  const large = { id: "large", result: { executed: true, columns: ["value"], rows: [["x".repeat(MAX_RESULT_BYTES / 2 + 1)]] } };
  assert.deepEqual(selectResultsToRelease([large]), [large]);
});

test("protects active/current tabs, running work, pending edits and uncommitted transactions", () => {
  const tabs = Array.from({ length: 10 }, (_, index) => tab(index + 1, 4 * 1024 * 1024));
  tabs[2].running = true;
  tabs[3].refreshing = true;
  tabs[4].cellSaving = true;
  tabs[5].result.cellEditsInTransaction = true;
  const release = selectResultsToRelease(tabs, { activeTab: tabs[0], currentTab: tabs[1], isProtected: (item) => item === tabs[6] });
  assert.deepEqual(release, tabs.slice(7));
});

test("accounts for protected results when deciding whether an older candidate must be released", () => {
  const active = tab("active", MAX_RESULT_BYTES);
  const candidate = tab("candidate", 1);
  assert.deepEqual(selectResultsToRelease([active, candidate], { activeTab: active }), [candidate]);
  assert.deepEqual(selectResultsToRelease([active], { activeTab: active }), []);
});

test("missing timestamps release before newer results and ties retain workspace order", () => {
  const first = tab(1, MAX_RESULT_BYTES);
  delete first.result.finishedAt;
  const second = tab(2, MAX_RESULT_BYTES);
  delete second.result.finishedAt;
  const newer = tab(3, 1);
  assert.deepEqual(selectResultsToRelease([newer, first, second]), [first, second]);
});
