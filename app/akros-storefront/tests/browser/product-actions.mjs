import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000/cs";
const catalog = JSON.parse(
  await readFile(
    new URL("../../src/catalog-import/generated/catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const product = catalog.products.find(
  (item) => item.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const [a, b] = product.detail.variants;
const key = "akros-demo-watched-variants-v1";
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/produkt/${product.slug}`, { waitUntil: "domcontentloaded" });
  await page.locator(".sf-product-actions__watch:not(:disabled)").waitFor();
  await page.getByRole("button", { name: "Hlídat produkt", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  await dialog.locator("tbody tr").first().waitFor();
  assert.equal(await dialog.locator("tbody tr").count(), product.detail.variants.length);
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).check();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
  await page.getByRole("button", { name: "Hlídat produkt", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  for (const item of [a, b])
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${item.sku}`, exact: true })
      .check();
  await dialog.getByRole("button", { name: "Uložit hlídání" }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
  assert.deepEqual(
    saved.map((item) => item.variantId),
    [a.id, b.id],
  );
  assert.equal(await page.evaluate(() => localStorage.getItem("akros-demo-favorites-v1")), null);
  await page.reload();
  await page.getByRole("button", { name: "Upravit hlídání (2)", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true })
      .isChecked(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByRole("button", { name: "Upravit hlídání (2)", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  for (const item of [a, b])
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${item.sku}`, exact: true })
      .uncheck();
  await dialog.getByRole("button", { name: "Uložit hlídání" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key), []);
  await page.getByRole("button", { name: "Dotaz na produkt", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Dotaz na varianty" });
  for (const item of [a, b])
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${item.sku}`, exact: true })
      .check();
  await dialog.getByRole("button", { name: "Pokračovat k dotazu" }).click();
  await page.waitForURL("**/kontakty?**");
  await page.locator("#contact-subject").waitFor();
  assert.match(await page.locator("#contact-subject").inputValue(), /VRUTY/);
  const message = await page.locator("#contact-message").inputValue();
  assert.ok(message.includes(a.sku) && message.includes(b.sku));
  const href = `/produkt/${product.slug}?${new URLSearchParams({ variantIds: [a.id, b.id].join(",") })}#product-variants`;
  await page.goto(`${base}${href}`);
  await page.locator("[data-shared-variant-selection]").waitFor();
  const rows = page.locator(".sf-variant-data-table tbody tr");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  const text = await rows.allTextContents();
  assert.ok(text.some((row) => row.includes(a.sku)) && text.some((row) => row.includes(b.sku)));
  await page.getByRole("link", { name: "Zobrazit všechny varianty", exact: true }).click();
  await page.waitForURL(`**/produkt/${product.slug}#product-variants`);
  assert.equal(await page.locator("[data-shared-variant-selection]").count(), 0);
  await page.goto(`${base}/produkt/${product.slug}?variantIds=not-in-catalog`);
  await page.getByText("Sdílené varianty již nejsou v katalogu.", { exact: true }).waitFor();
  assert.equal(await page.locator(".sf-variant-data-table").count(), 0);
  const standalone = catalog.products.find(
    (item) => item.detail.variants.length === 0 && item.priceMinor > 0,
  );
  await page.goto(`${base}/produkt/${standalone.slug}?variantIds=not-in-catalog`);
  await page.getByText("Sdílené varianty již nejsou v katalogu.", { exact: true }).waitFor();
  assert.equal(await page.locator(".sf-purchase-form").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Product actions passed: watch selection/cancel/reload, prefilled questions and exact shared selection links.",
  );
} finally {
  await browser.close();
}
