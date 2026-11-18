import test from "node:test";
import assert from "node:assert/strict";
import { createConfirmationDialog } from "../src/confirmation-dialog.js";
import { createSchemaSelect } from "../src/schema-select.js";
import { initWorkspaceLayout } from "../src/workspace-layout.js";

class Element extends EventTarget {
  constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
  children = [];
  _textContent = "";
  attributes = new Map();
  dataset = {};
  style = { setProperty() {}, removeProperty() {} };
  classList = { toggle() {}, add() {}, remove() {} };
  value = "";
  hidden = false;
  disabled = false;
  scrolls = 0;
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._textContent; }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
  focus() { document.activeElement = this; }
  scrollIntoView() { this.scrolls++; }
  closest() { return this; }
  getBoundingClientRect() { return { left: 100, right: 400, top: 100, bottom: 300 }; }
}

function emit(element, type, details = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(details)) Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
  return event;
}

function environment(t) {
  const document = new Element();
  document.createElement = (tag) => new Element(tag);
  document.body = new Element();
  document.documentElement = new Element();
  const window = new Element();
  window.innerWidth = 1000;
  window.innerHeight = 700;
  for (const [key, value] of Object.entries({ document, window })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return { document, window };
}

function picker(t) {
  const env = environment(t);
  const names = ["trigger", "label", "panel", "search", "list", "empty", "count"];
  const elements = Object.fromEntries(names.map((name) => [name, new Element()]));
  elements.panel.append(elements.search, elements.list);
  elements.panel.hidden = true;
  elements.list.id = "schema-list";
  const choices = [];
  const select = createSchemaSelect({ ...elements, onChange: (value) => choices.push(value) });
  select.update({ contextKey: "database", value: "public", label: "public", options: [
    { value: "public", label: "public" }, { value: "analytics", label: "analytics" },
  ] });
  return { ...env, ...elements, select, choices };
}

test("viewport dismissal restores picker focus and clears its active descendant", (t) => {
  const { select, search, trigger, panel, window, document } = picker(t);
  select.open();
  assert.equal(document.activeElement, search);
  emit(window, "resize");
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.equal(search.getAttribute("aria-activedescendant"), undefined);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("pointer browsing does not scroll options or commit the query target", (t) => {
  const { select, list, choices, search } = picker(t);
  select.open();
  const row = list.children[1];
  emit(list, "pointermove", { target: row });
  assert.equal(row.scrolls, 0);
  assert.equal(search.getAttribute("aria-activedescendant"), row.id);
  assert.deepEqual(choices, []);
  emit(search, "keydown", { key: "Enter" });
  assert.deepEqual(choices, ["analytics"]);
});

test("picker filtering announces match counts and composition cannot commit a selection", (t) => {
  const { select, search, count, choices } = picker(t);
  select.open();
  search.value = "ana";
  emit(search, "input");
  assert.equal(count.textContent, "1 个匹配项");
  assert.equal(count.getAttribute("aria-live"), "polite");
  emit(search, "keydown", { key: "Enter", isComposing: true });
  assert.deepEqual(choices, []);
});

function confirmation(t) {
  environment(t);
  const dialog = new Element();
  const parts = Object.fromEntries(["[data-confirm-title]", "[data-confirm-message]", "[data-confirm-detail]", "[value='accept']", "[value='cancel']"].map((selector) => [selector, new Element()]));
  dialog.querySelector = (selector) => parts[selector];
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = (value) => { dialog.returnValue = value; dialog.open = false; emit(dialog, "close"); };
  return { dialog, parts, confirm: createConfirmationDialog(dialog) };
}

test("confirmation ignores drags from content to backdrop but dismisses an intentional backdrop click", async (t) => {
  const { dialog, confirm } = confirmation(t);
  const result = confirm("执行 SQL？");
  emit(dialog, "pointerdown", { button: 0, clientX: 200, clientY: 200 });
  emit(dialog, "click", { clientX: 20, clientY: 20 });
  assert.equal(dialog.open, true);
  emit(dialog, "pointerdown", { button: 0, clientX: 20, clientY: 20 });
  emit(dialog, "click", { clientX: 20, clientY: 20 });
  assert.equal(await result, false);
});

test("confirmation resets long details, focuses cancel and recovers from a modal opening error", async (t) => {
  const { dialog, confirm, parts } = confirmation(t);
  const show = dialog.showModal;
  dialog.showModal = () => { throw new Error("temporarily unavailable"); };
  await assert.rejects(confirm("first"), /temporarily unavailable/);
  dialog.showModal = show;
  const preview = parts["[data-confirm-detail]"];
  preview.scrollTop = 200;
  const result = confirm("second", { detail: "ALTER TABLE inventory ADD quantity INT;" });
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, parts["[value='cancel']"]);
  assert.equal(preview.scrollTop, 0);
  assert.equal(preview.tabIndex, 0);
  assert.equal(preview.textContent, "ALTER TABLE inventory ADD quantity INT;");
  assert.equal(preview.firstElementChild.className, "selectable-text");
  dialog.close("accept");
  assert.equal(await result, true);
});

test("responsive pane collapse returns a focused separator to its restore button", (t) => {
  const { document } = environment(t);
  const ids = ["workspaceBody", "editorResult", "connectionsPane", "objectsPane", "connectionsRail", "objectsRail", "editorPane",
    "connectionsSplitter", "objectsSplitter", "editorSplitter", "toggleConnections", "toggleObjects", "resetLayout",
    "sidebarSplit", "historySplitter", "toggleHistory", "historySearchBox", "recentQueries", "clearHistory"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements.workspaceBody.clientWidth = 1200;
  elements.editorResult.clientHeight = 600;
  elements.sidebarSplit.clientHeight = 640;
  document.getElementById = (id) => elements[id];
  document.querySelectorAll = () => [];
  const frames = [];
  let resize;
  const globals = {
    localStorage: { getItem() { return null; }, setItem() {} },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const layout = initWorkspaceLayout();
  elements.connectionsSplitter.focus();
  elements.workspaceBody.clientWidth = 700;
  resize();
  frames.pop()();
  assert.equal(elements.connectionsPane.inert, true);
  assert.equal(elements.connectionsRail.hidden, false);
  assert.equal(document.activeElement, elements.toggleConnections);
  layout.destroy();
});
