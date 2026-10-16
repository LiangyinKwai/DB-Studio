import test from "node:test";
import assert from "node:assert/strict";
import { setSelectableText } from "../src/selectable-text.js";

function fixture() {
  const created = [];
  const ownerDocument = {
    createElement(tag) {
      const element = {
        tagName: tag.toUpperCase(), ownerDocument, className: "", childNodes: [],
        _textContent: "", textWrites: 0, replacements: 0,
        get firstElementChild() { return this.childNodes.find(child => child.tagName) || null; },
        get textContent() { return this.childNodes.length ? this.childNodes.map(child => child.textContent).join("") : this._textContent; },
        set textContent(value) { this._textContent = String(value); this.childNodes = []; this.textWrites++; },
        set innerHTML(_) { assert.fail("Selectable content must never be interpreted as HTML"); },
        replaceChildren(...children) { this.childNodes = children; this._textContent = ""; this.replacements++; },
      };
      created.push(element);
      return element;
    },
  };
  return { created, container: ownerDocument.createElement("pre") };
}

test("selectable content preserves SQL, JSON and HTML-looking values as literal text", () => {
  const { container, created } = fixture();
  const value = 'SELECT \'<img src=x onerror="run()"> & </span><script>run()</script>\';\n{"html":"<b>value</b>"}';
  const content = setSelectableText(container, value);
  assert.equal(content.tagName, "SPAN");
  assert.equal(content.className, "selectable-text");
  assert.equal(container.textContent, value);
  assert.equal(content.childNodes.length, 0);
  assert.deepEqual(created.map(node => node.tagName), ["PRE", "SPAN"]);
});

test("clearing a preview removes its previous content and keeps its empty selectable wrapper", () => {
  const { container } = fixture();
  const content = setSelectableText(container, "old SQL");
  for (const value of ["", null, undefined]) {
    assert.equal(setSelectableText(container, value), content);
    assert.equal(container.textContent, "");
    assert.equal(container.childNodes.length, 1);
  }
});

test("updating content preserves the pre container and reuses unchanged text nodes", () => {
  const { container } = fixture();
  container.id = "preview";
  container.className = "definition";
  container.tabIndex = 0;
  container.scrollTop = 120;
  container.childNodes = [{ textContent: "legacy plain text" }];
  const content = setSelectableText(container, "SELECT 1;");
  assert.equal(setSelectableText(container, "SELECT 1;"), content);
  assert.equal(content.textWrites, 1);
  assert.equal(container.replacements, 1);
  assert.equal(setSelectableText(container, "SELECT 2;"), content);
  assert.equal(content.textContent, "SELECT 2;");
  assert.equal(container.tagName, "PRE");
  assert.equal(container.id, "preview");
  assert.equal(container.className, "definition");
  assert.equal(container.tabIndex, 0);
  assert.equal(container.scrollTop, 120);
  assert.equal(container.replacements, 1);
});
