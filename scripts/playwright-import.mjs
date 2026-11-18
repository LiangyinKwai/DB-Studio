const moduleName = process.env.DB_STUDIO_PLAYWRIGHT_MODULE || "playwright";
export const { chromium } = await import(moduleName);

export async function revealObject(locator) {
  await locator.waitFor({ state: "attached" });
  const disclosure = locator.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' tree-category ')][1]").locator(":scope > .category-summary [data-tree-toggle]");
  if (await disclosure.count() && await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
}

export async function setTabReadOnly(page, readOnly) {
  await page.locator(".query-tab.active .tab-select").click({ button: "right" });
  const toggle = page.locator("#tabReadOnly");
  if (await toggle.getAttribute("aria-checked") !== String(readOnly)) await toggle.click();
  else await page.keyboard.press("Escape");
}
