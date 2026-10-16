// Keep native selection on actual text, leaving the surrounding layout inert.
export function setSelectableText(container, value) {
  const text = String(value ?? "");
  let content = container.firstElementChild;
  if (container.childNodes.length !== 1 || content?.tagName !== "SPAN" || content.className !== "selectable-text") {
    content = (container.ownerDocument || document).createElement("span");
    content.className = "selectable-text";
    container.replaceChildren(content);
  }
  // Reusing unchanged text also preserves any native selection within it.
  if (content.textContent !== text) content.textContent = text;
  return content;
}
