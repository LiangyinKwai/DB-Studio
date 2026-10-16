import test from "node:test";
import assert from "node:assert/strict";
import { canHandleGlobalShortcut } from "../src/keyboard-shortcuts.js";

const target = (tagName, { contentEditable = false, editor = false } = {}) => ({
  tagName,
  isContentEditable: contentEditable,
  closest: (selector) => (editor && selector === ".cm-editor" ? {} : null),
});

test("allows document shortcuts from the SQL editor", () => {
  assert.equal(canHandleGlobalShortcut(target("div", { editor: true })), true);
});

test("keeps text input shortcuts inside ordinary controls", () => {
  for (const tagName of ["input", "textarea", "select"]) {
    assert.equal(canHandleGlobalShortcut(target(tagName)), false, tagName);
  }
  assert.equal(canHandleGlobalShortcut(target("div", { contentEditable: true })), false);
});

test("allows document shortcuts from non-editable controls", () => {
  assert.equal(canHandleGlobalShortcut(target("button")), true);
  assert.equal(canHandleGlobalShortcut(target("div")), true);
  assert.equal(canHandleGlobalShortcut(null), true);
});
