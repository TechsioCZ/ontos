import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const catalog = JSON.parse(
  await readFile(
    new URL("../../src/mock-storefront/generated/catalog.generated.json", import.meta.url),
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
await mkdir("test-results/product-actions", { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/produkt/${product.slug}`, { waitUntil: "domcontentloaded" });
  await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [
    1920, 1600, 1440, 1280, 1100, 1024, 960, 768, 767, 640, 430, 390, 360, 320,
  ]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.locator(".akros-product-actions").evaluate((root) => {
      const boxes = [...root.querySelectorAll("button")].map((item) =>
        item.getBoundingClientRect(),
      );
      const height = parseFloat(getComputedStyle(root.querySelector("button")).height);
      const bounds = root.getBoundingClientRect();
      return {
        valid:
          boxes.length === 5 &&
          boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1) &&
          height >= (innerWidth < 768 ? 44 : 40) &&
          boxes.every((box) => Math.abs(box.height - height) < 1) &&
          boxes.every((a) =>
            boxes.every(
              (b) =>
                Math.abs(a.top - b.top) > 8 ||
                Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 1,
            ),
          ),
        height,
        boxes: boxes.map((box) => ({ height: box.height, top: box.top })),
      };
    });
    assert.equal(result.valid, true, `action alignment ${width}: ${JSON.stringify(result)}`);
    if ([1920, 1024, 390, 320].includes(width)) {
      await page.locator(".akros-product-actions").screenshot({
        path: `test-results/product-actions/actions-${width}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByRole("button", { name: "Hlídat produkt", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  await dialog.locator("tbody tr").first().waitFor();
  assert.equal(await dialog.locator("tbody tr").count(), product.detail.variants.length);
  const shadow = await dialog.evaluate((root) => getComputedStyle(root).boxShadow);
  assert.ok(shadow.includes("0.1") && !shadow.includes("20px"), shadow);
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--shadow-primary",
      "0px 2px 3px rgba(12, 34, 56, 0.2)",
    ),
  );
  assert.match(await dialog.evaluate((root) => getComputedStyle(root).boxShadow), /12, 34, 56/);
  await page.evaluate(() => document.documentElement.style.removeProperty("--shadow-primary"));
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).check();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
  await page.getByRole("button", { name: "Hlídat produkt", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Hlídat varianty" });
  for (const item of [a, b])
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${item.sku}`, exact: true })
      .check();
  await page.screenshot({ path: "test-results/product-actions/watch-1920.png" });
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
  for (const viewport of [
    { width: 390, height: 900 },
    { width: 320, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    const box = await dialog.getByRole("button", { name: "Uložit hlídání" }).boundingBox();
    assert.ok(box.y + box.height <= viewport.height);
    assert.equal(
      await dialog
        .locator(".akros-favorites-table")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    const visibleRow = await dialog.evaluate((root) => {
      const list = root.querySelector(".akros-favorites-table").getBoundingClientRect();
      const first = root.querySelector("tbody tr").getBoundingClientRect();
      return first.top < list.bottom - 40;
    });
    assert.equal(visibleRow, true, "caption must leave a visible variant row in the list");
  }
  await page.screenshot({ path: "test-results/product-actions/watch-320.png" });
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
  const rows = page.locator(".akros-variant-data-table tbody tr");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  const text = await rows.allTextContents();
  assert.ok(text.some((row) => row.includes(a.sku)) && text.some((row) => row.includes(b.sku)));
  await page.getByRole("link", { name: "Zobrazit všechny varianty", exact: true }).click();
  await page.waitForURL(`**/produkt/${product.slug}#product-variants`);
  assert.equal(await page.locator("[data-shared-variant-selection]").count(), 0);
  await page.goto(`${base}/produkt/${product.slug}?variantIds=not-in-catalog`);
  await page.getByText("Sdílené varianty již nejsou v katalogu.", { exact: true }).waitFor();
  assert.equal(await page.locator(".akros-variant-data-table").count(), 0);
  const standalone = catalog.products.find(
    (item) => item.detail.variants.length === 0 && item.priceMinor > 0,
  );
  await page.goto(`${base}/produkt/${standalone.slug}?variantIds=not-in-catalog`);
  await page.getByText("Sdílené varianty již nejsou v katalogu.", { exact: true }).waitFor();
  assert.equal(await page.locator(".akros-purchase-form").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Product actions passed: 14 alignment/wrapping widths including favorites, semantic shadow propagation, watch selection/cancel/reload, mobile, prefilled questions and exact shared selection links.",
  );
} finally {
  await browser.close();
}
