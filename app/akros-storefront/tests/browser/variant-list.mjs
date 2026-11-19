import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { checkVariantFilterRecovery } from "./variant-filter-checks.mjs";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000/cs";
const { products } = JSON.parse(
  await readFile(
    new URL("../../src/catalog-import/generated/catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const largest = [...products].sort(
  (a, b) => b.detail.variants.length - a.detail.variants.length,
)[0];
const standard = products.find(
  (item) => item.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const errors = [];
try {
  for (const product of [standard, largest]) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
    });
    const url = `${base}/produkt/${product.slug}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const table = page.locator(".sf-variant-data-table__table");
    const rows = table.locator("tbody tr");
    const links = table.locator("[data-variant-detail-link]");
    await links.last().waitFor();
    await page.locator(".sf-product-actions__watch:not(:disabled)").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await rows.count(), product.detail.variants.length);
    assert.equal(await page.getByRole("navigation", { name: "Stránkování variant" }).count(), 0);
    const ids = await links.evaluateAll((items) =>
      items.map((item) => item.dataset.variantDetailLink),
    );
    assert.deepEqual(
      [...ids].sort((left, right) => left.localeCompare(right)),
      product.detail.variants
        .map((item) => item.id)
        .sort((left, right) => left.localeCompare(right)),
    );
    assert.ok(
      (await table.locator(".sf-variant-table__name").allTextContents()).every(
        (name) => !name.includes(product.name),
      ),
    );
    for (const width of [1920, 1440, 1280, 1024, 768, 767, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await table.locator("thead").scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const tail = links.last();
      await tail.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await tail.focus();
      assert.equal(await tail.evaluate((element) => document.activeElement === element), true);
      await page.keyboard.press("Escape");
      const bounds = await tail.boundingBox();
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y >= 0 &&
          bounds.y + bounds.height <= 1001,
        `${width}px: last variant reachable`,
      );
    }

    await page.setViewportSize({ width: 1920, height: 1000 });
    const buyable = rows
      .filter({
        has: page.locator(
          ".sf-variant-table__order--minimum .sf-variant-table__buy-button:not(:disabled)",
        ),
      })
      .last();
    const variantId = await buyable
      .locator("[data-variant-detail-link]")
      .getAttribute("data-variant-detail-link");
    const variant = product.detail.variants.find((item) => item.id === variantId);
    const quantity = buyable.locator(".sf-variant-table__order--minimum input");
    const amount =
      variant.stockCount >= variant.minimumQuantity * 2
        ? variant.minimumQuantity * 2
        : variant.minimumQuantity;
    await quantity.scrollIntoViewIfNeeded();
    await quantity.fill(String(amount));
    await quantity.press("Tab");
    assert.equal(Number(await quantity.inputValue()), amount);
    await buyable
      .locator(".sf-variant-table__order--minimum .sf-variant-table__buy-button")
      .click();
    await page.waitForFunction(
      ({ id, amount }) =>
        JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null")?.lines.some(
          (line) => line.variantId === id && line.quantity === amount,
        ),
      { id: variant.id, amount },
    );

    const lastId = ids.at(-1);
    const lastVariant = product.detail.variants.find((item) => item.id === lastId);
    await links.last().focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator(".sf-variant-detail");
    await dialog.waitFor();
    assert.equal(await dialog.locator("[data-variant-detail-sku]").innerText(), lastVariant.sku);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      (id) => document.activeElement?.getAttribute("data-variant-detail-link") === id,
      lastId,
    );
    assert.equal(await rows.count(), ids.length);

    await checkVariantFilterRecovery(page, product);

    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await links.last().waitFor();
    await page.locator(".sf-product-actions__watch:not(:disabled)").waitFor();
    assert.equal(await rows.count(), ids.length);
    await quantity.scrollIntoViewIfNeeded();
    await quantity.fill(String(amount));
    await quantity.press("Tab");
    assert.equal(Number(await quantity.inputValue()), amount);

    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const shared = new URL(url);
      shared.searchParams.set("variantIds", [ids[0], lastId].join(","));
      await page.goto(shared.href, { waitUntil: "domcontentloaded" });
      await links.last().waitFor();
      assert.deepEqual(
        (
          await links.evaluateAll((items) => items.map((item) => item.dataset.variantDetailLink))
        ).sort((left, right) => left.localeCompare(right)),
        [ids[0], lastId].sort((left, right) => left.localeCompare(right)),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await links.last().waitFor();
      assert.equal(await rows.count(), 2);
      const searched = new URL(url);
      searched.searchParams.set("variant", lastVariant.sku);
      await page.goto(searched.href, { waitUntil: "domcontentloaded" });
      await links.first().waitFor();
      assert.equal(await rows.count(), 1);
      assert.equal(await links.first().getAttribute("data-variant-detail-link"), lastId);
    }
    console.log(
      `Variant list: ${product.slug}, purchase, last-row reachability, filter recovery and shared links passed.`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
