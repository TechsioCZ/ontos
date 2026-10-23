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
  (p) => p.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const [a, b] = product.detail.variants;
const key = "akros-demo-favorites-v1";
const refs = [a, b].map((v) => ({
  productId: product.id,
  productSlug: product.slug,
  variantId: v.id,
}));
await mkdir("test-results/task-13", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  for (const width of [
    1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320,
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ key, refs }) => localStorage.setItem(key, JSON.stringify(refs)), {
      key,
      refs,
    });
    await page.goto(`${base}/oblibene`);
    const cards = page.locator("[data-account-products] article");
    await cards.first().waitFor();
    assert.equal(await cards.count(), 2);
    for (const [index, variant] of [a, b].entries()) {
      const href = await cards
        .nth(index)
        .locator(".akros-product-card__name-link")
        .getAttribute("href");
      assert.equal(new URL(href, base).searchParams.get("variantIds"), variant.id);
      assert.match(await cards.nth(index).innerText(), new RegExp(variant.sku));
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    if ([1920, 768, 390, 320].includes(width))
      await page.screenshot({
        path: `test-results/task-13/favorites-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
    await cards.first().locator(".akros-product-card__name-link").click();
    await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
    assert.equal(await page.locator("#product-variants tbody tr").count(), 1);
    assert.match(await page.locator("#product-variants tbody").innerText(), new RegExp(a.sku));
    await page.reload();
    await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
    assert.equal(await page.locator("#product-variants tbody tr").count(), 1);
    await page.goto(`${base}/oblibene`);
    await cards.first().waitFor();
    await cards.first().locator(".akros-product-card__favorite").click();
    await cards.first().waitFor();
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), new RegExp(b.sku));
    await page.reload();
    await cards.first().waitFor();
    assert.equal(await cards.count(), 1);
    await cards.first().locator(".akros-product-card__favorite").click();
    await page.locator("[data-favorites-empty]").waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(
    "TASK 13: exact links, selected rows/reload, independent removal and empty state at 14 widths passed.",
  );
} finally {
  await browser.close();
}
