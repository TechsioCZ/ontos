import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const { products } = JSON.parse(
  await readFile(
    new URL("../../src/mock-storefront/generated/catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const largest = [...products].sort(
  (a, b) => b.detail.variants.length - a.detail.variants.length,
)[0];
const standard = products.find(
  (item) => item.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const output = "test-results/variant-list";
await mkdir(output, { recursive: true });
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const errors = [];
const report = [];
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
    const start = performance.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const table = page.locator(".akros-variant-data-table__table");
    const rows = table.locator("tbody tr");
    const links = table.locator("[data-variant-detail-link]");
    await links.last().waitFor();
    await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await rows.count(), product.detail.variants.length);
    assert.equal(await page.getByRole("navigation", { name: "Stránkování variant" }).count(), 0);
    const ids = await links.evaluateAll((items) =>
      items.map((item) => item.dataset.variantDetailLink),
    );
    assert.deepEqual([...ids].sort(), product.detail.variants.map((item) => item.id).sort());
    assert.ok(
      (await table.locator(".akros-variant-table__name").allTextContents()).every(
        (name) => !name.includes(product.name),
      ),
    );
    const measurement = {
      slug: product.slug,
      variants: ids.length,
      readyMs: Math.round(performance.now() - start),
      layouts: [],
    };
    console.log(`All ${ids.length} variants rendered: ${measurement.readyMs}ms (${product.slug}).`);

    for (const width of [1920, 1440, 1280, 1024, 768, 767, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await table.locator("thead").scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${width}px: page overflow`,
      );
      assert.equal(await rows.count(), ids.length);
      if ([1920, 1024, 390, 320].includes(width)) {
        await page.screenshot({
          path: `${output}/${product === largest ? "largest" : "standard"}-${width}.png`,
        });
      }
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
      if (product === largest && [1920, 390].includes(width)) {
        await page.screenshot({ path: `${output}/largest-last-${width}.png` });
      }
      measurement.layouts.push(width);
    }

    await page.setViewportSize({ width: 1920, height: 1000 });
    const buyable = rows
      .filter({
        has: page.locator(
          ".akros-variant-table__order--minimum .akros-variant-table__buy-button:not(:disabled)",
        ),
      })
      .last();
    const variantId = await buyable
      .locator("[data-variant-detail-link]")
      .getAttribute("data-variant-detail-link");
    const variant = product.detail.variants.find((item) => item.id === variantId);
    const quantity = buyable.locator(".akros-variant-table__order--minimum input");
    const amount =
      variant.stockCount >= variant.minimumQuantity * 2
        ? variant.minimumQuantity * 2
        : variant.minimumQuantity;
    await quantity.scrollIntoViewIfNeeded();
    const editing = performance.now();
    await quantity.fill(String(amount));
    await quantity.press("Tab");
    assert.equal(Number(await quantity.inputValue()), amount);
    measurement.editQuantityMs = Math.round(performance.now() - editing);
    const purchase = performance.now();
    await buyable
      .locator(".akros-variant-table__order--minimum .akros-variant-table__buy-button")
      .click();
    await page.waitForFunction(
      ({ id, amount }) =>
        JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null")?.lines.some(
          (line) => line.variantId === id && line.quantity === amount,
        ),
      { id: variant.id, amount },
    );
    measurement.purchaseMs = Math.round(performance.now() - purchase);

    const lastId = ids.at(-1);
    const lastVariant = product.detail.variants.find((item) => item.id === lastId);
    await links.last().focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator(".akros-variant-detail");
    await dialog.waitFor();
    assert.equal(await dialog.locator("[data-variant-detail-sku]").innerText(), lastVariant.sku);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      (id) => document.activeElement?.getAttribute("data-variant-detail-link") === id,
      lastId,
    );
    assert.equal(await rows.count(), ids.length);

    const filter = page.getByRole("form", { name: "Filtrování variant" });
    const checkboxes = filter.getByRole("checkbox");
    assert.ok(await checkboxes.count());
    for (const checkbox of await checkboxes.all()) await checkbox.locator("..").click();
    const filtering = performance.now();
    await filter.getByRole("button", { name: "Filtruj" }).click();
    await page.locator(".akros-variant-purchase__empty").waitFor();
    measurement.emptyFilterMs = Math.round(performance.now() - filtering);
    for (const checkbox of await checkboxes.all()) await checkbox.locator("..").click();
    const restore = performance.now();
    await filter.getByRole("button", { name: "Filtruj" }).click();
    await links.last().waitFor();
    assert.equal(await rows.count(), ids.length);
    measurement.restoreFilterMs = Math.round(performance.now() - restore);

    await page.setViewportSize({ width: 390, height: 1000 });
    const mobileStart = performance.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await links.last().waitFor();
    await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
    assert.equal(await rows.count(), ids.length);
    measurement.mobileReadyMs = Math.round(performance.now() - mobileStart);
    await quantity.scrollIntoViewIfNeeded();
    const mobileEditing = performance.now();
    await quantity.fill(String(amount));
    await quantity.press("Tab");
    assert.equal(Number(await quantity.inputValue()), amount);
    measurement.mobileEditQuantityMs = Math.round(performance.now() - mobileEditing);

    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const shared = new URL(url);
      shared.searchParams.set("variantIds", [ids[0], lastId].join(","));
      await page.goto(shared.href, { waitUntil: "domcontentloaded" });
      await links.last().waitFor();
      assert.deepEqual(
        (
          await links.evaluateAll((items) => items.map((item) => item.dataset.variantDetailLink))
        ).sort(),
        [ids[0], lastId].sort(),
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
    report.push(measurement);
    console.log(JSON.stringify(measurement));
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
