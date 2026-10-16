import assert from "node:assert/strict";
import test from "node:test";
import { resolveSaveOutcome } from "../src/save-outcome.js";

test("native save cancellation is terminal", () => {
  assert.equal(resolveSaveOutcome(true, false), "cancelled");
  assert.equal(resolveSaveOutcome(true, undefined), "cancelled");
  assert.equal(resolveSaveOutcome(true, 1), "cancelled");
});

test("native success never falls back to a browser download", () => {
  assert.equal(resolveSaveOutcome(true, true), "saved");
});

test("browser-only previews use the download fallback", () => {
  assert.equal(resolveSaveOutcome(false, undefined), "download");
});
