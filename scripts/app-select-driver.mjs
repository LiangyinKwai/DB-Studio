/** Exercise the same menu users see instead of setting the hidden data source. */
export async function chooseAppSelect(select, value) {
  const info = await select.evaluate((node, value) => ({ id: node.nextElementSibling.dataset.selectId, label: [...node.options].find(option => option.value === String(value))?.label }), value);
  if (!info.label) throw new Error(`Missing select option: ${value}`);
  const page = select.page();
  await page.locator(`.app-select-trigger[data-select-id=${JSON.stringify(info.id)}]`).click();
  const panel = page.locator('.app-select-panel');
  await panel.locator('input').fill(info.label);
  await panel.getByRole('option', { name: info.label, exact: true }).click();
}
