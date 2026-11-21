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

export async function selectPostgresTarget(page, database, schema) {
  await page.locator('#querySchema').click();
  const list = page.locator('#querySchemaList');
  const databaseOption = list.getByRole('option', { name: database, exact: true });
  const schemaStep = page.locator('#querySchemaBack:visible');
  await databaseOption.or(schemaStep).first().waitFor();
  if (await schemaStep.isHidden()) await databaseOption.click();
  await list.getByRole('option', { name: schema, exact: true }).click();
}
