import assert from "node:assert/strict";

export async function checkVariantFilterRecovery(page, product) {
  const dimensions = product.detail.variants.map((variant) => {
    const match = variant.label.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/);
    assert.ok(match);
    return [Number(match[1].replace(",", ".")), Number(match[2].replace(",", "."))];
  });
  const diameters = [...new Set(dimensions.map(([diameter]) => diameter))];
  const lengths = [...new Set(dimensions.map(([, length]) => length))];
  const missing = diameters
    .flatMap((diameter) => lengths.map((length) => [diameter, length]))
    .find(([diameter, length]) => !dimensions.some(([d, l]) => d === diameter && l === length));
  assert.ok(missing, "source fixture needs an unavailable dimension combination");
  const form = page.getByRole("form", { name: "Filtrování variant" });
  assert.equal(await form.getByRole("checkbox").count(), 0);
  assert.equal(await form.getByRole("button", { name: "Filtruj" }).count(), 0);
  assert.equal(await form.getByRole("spinbutton", { name: /Cena/ }).count(), 0);
  const begin = performance.now();
  for (const [label, value] of [
    ["Průměr (mm)", missing[0]],
    ["Délka (mm)", missing[1]],
  ]) {
    await form.getByRole("spinbutton", { name: `Minimum – ${label}` }).fill(String(value));
    await form.getByRole("spinbutton", { name: `Maximum – ${label}` }).fill(String(value));
  }
  await page.locator(".akros-variant-purchase__empty").waitFor();
  const emptyFilterMs = Math.round(performance.now() - begin);
  const reset = performance.now();
  await form.getByRole("button", { name: "Obnovit filtry" }).click();
  const rows = page.locator(".akros-variant-data-table__table tbody tr");
  await rows.last().waitFor();
  assert.equal(await rows.count(), product.detail.variants.length);
  return { emptyFilterMs, restoreFilterMs: Math.round(performance.now() - reset) };
}
