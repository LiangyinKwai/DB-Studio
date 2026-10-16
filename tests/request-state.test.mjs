import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentConnectionRequest } from "../src/request-state.js";

test("accepts a response for the active request and connection", () => {
  assert.equal(isCurrentConnectionRequest(4, 4, "primary", "primary"), true);
});

test("rejects responses from an older request generation", () => {
  assert.equal(isCurrentConnectionRequest(3, 4, "primary", "primary"), false);
});

test("rejects responses after the active connection changes", () => {
  assert.equal(isCurrentConnectionRequest(4, 4, "primary", "replica"), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function applyWhenCurrent(state, request, connectionId, response) {
  const value = await response;
  if (!isCurrentConnectionRequest(request, state.request, connectionId, state.connectionId)) return false;
  state.value = value;
  return true;
}

test("late connection responses cannot replace the latest connection state", async () => {
  const state = { request: 1, connectionId: "primary", value: null };
  const oldResponse = deferred();
  const oldApply = applyWhenCurrent(state, 1, "primary", oldResponse.promise);

  state.request = 2;
  state.connectionId = "replica";
  const latestResponse = deferred();
  const latestApply = applyWhenCurrent(state, 2, "replica", latestResponse.promise);
  latestResponse.resolve(["replica-db"]);
  assert.equal(await latestApply, true);

  oldResponse.resolve(["primary-db"]);
  assert.equal(await oldApply, false);
  assert.deepEqual(state.value, ["replica-db"]);
});

test("a second Redis refresh supersedes an older refresh on the same connection", async () => {
  const state = { request: 7, connectionId: "redis", value: null };
  const firstResponse = deferred();
  const firstApply = applyWhenCurrent(state, 7, "redis", firstResponse.promise);

  state.request = 8;
  const secondResponse = deferred();
  const secondApply = applyWhenCurrent(state, 8, "redis", secondResponse.promise);
  secondResponse.resolve({ keys: ["latest"] });
  assert.equal(await secondApply, true);

  firstResponse.resolve({ keys: ["stale"] });
  assert.equal(await firstApply, false);
  assert.deepEqual(state.value, { keys: ["latest"] });
});
