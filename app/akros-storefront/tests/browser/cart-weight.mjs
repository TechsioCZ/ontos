import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import { cartFixture } from "./cart-layout-fixtures.mjs";
const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const { products } = JSON.parse(
  await readFile("src/mock-storefront/generated/catalog.generated.json", "utf8"),
);
const widths = [1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320];
function catalogLine(productId, variantId, quantity) {
  const product = products.find((row) => row.id === productId);
  const variant = product.detail.variants.find((row) => row.id === variantId);
  return {
    productId,
    variantId,
    quantity,
    slug: product.slug,
    name: product.name,
    variantLabel: variant.label,
    sku: variant.sku,
    imageSrc: product.imageSrc,
    imageAlt: product.imageAlt,
    unit: variant.unit,
    minimumQuantity: variant.minimumQuantity,
    stockCount: variant.stockCount,
    priceMinor: variant.priceMinor,
  };
}
const cart = {
  version: 3,
  lines: cartFixture.lines
    .slice(0, 2)
    .map((l, i) => ({ ...l, unitWeightKg: i ? 1.2 : 0.0034, quantity: i ? 2.5 : 400 })),
};
const collection = {
  version: 1,
  activeCartId: "default",
  carts: [
    { id: "default", name: "Hlavní košík", cart },
    {
      id: "unknown",
      name: "Neznámá hmotnost",
      cart: { version: 3, lines: [{ ...cartFixture.lines[0] }] },
    },
  ],
};
await mkdir("test-results/task-16", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.evaluate((collection) => {
    localStorage.setItem("akros-demo-cart-v3", JSON.stringify(collection.carts[0].cart));
    localStorage.setItem("akros-demo-carts-v1", JSON.stringify(collection));
  }, collection);
  await page.goto(`${base}/kosik`);
  const weight = page.locator("[data-cart-weight] output");
  await weight.waitFor();
  assert.equal(await weight.innerText(), "4,36 kg");
  for (const width of [
    1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320,
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    if ([1920, 768, 390, 320].includes(width))
      await page.screenshot({
        path: `test-results/task-16/cart-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
  }
  await page
    .getByRole("spinbutton", { name: `Množství: ${cart.lines[0].variantLabel}` })
    .fill("200");
  await page
    .getByRole("spinbutton", { name: `Množství: ${cart.lines[0].variantLabel}` })
    .press("Enter");
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "3,68 kg",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "3,68 kg",
  );
  await page.getByRole("button", { name: `Odebrat ${cart.lines[0].name}`, exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "3 kg",
  );
  await page.getByText("Neznámá hmotnost", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "Nelze určit",
  );
  await page.getByText("Hlavní košík", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "3 kg",
  );

  async function loadCatalogCart(lines) {
    await page.evaluate((lines) => {
      const cart = { version: 3, lines };
      localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
      localStorage.setItem(
        "akros-demo-carts-v1",
        JSON.stringify({
          version: 1,
          activeCartId: "default",
          carts: [{ id: "default", name: "Hlavní košík", cart }],
        }),
      );
    }, lines);
    await page.goto(`${base}/kosik`);
    if (lines.length) await weight.waitFor();
    else await page.getByText("Košík je zatím prázdný.", { exact: true }).waitFor();
  }
  const screw = catalogLine("product-20532", "item-4746", 20);
  const rope = catalogLine("product-21599", "item-966", 3);
  await loadCatalogCart([screw, rope]);
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "0,248 kg",
  );
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await weight.innerText(), "0,248 kg");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    if ([1920, 390, 320].includes(width))
      await page.screenshot({
        path: `test-results/task-16/catalog-known-${width}.png`,
        fullPage: true,
      });
  }
  const input = page.getByRole("spinbutton", {
    name: `Množství: ${screw.variantLabel}`,
    exact: true,
  });
  await input.fill("40");
  await input.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "0,316 kg",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "0,316 kg",
  );
  await loadCatalogCart([screw, rope, catalogLine("product-19408", "item-3967", 1)]);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await weight.innerText(), "0,248 kg");
    await page.getByText("Hmotnost známých položek", { exact: true }).waitFor();
    assert.ok((await page.locator("[data-cart-weight]").innerText()).includes("Neúplný součet"));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    if ([1920, 390, 320].includes(width))
      await page.screenshot({
        path: `test-results/task-16/catalog-partial-${width}.png`,
        fullPage: true,
      });
  }
  await loadCatalogCart([
    catalogLine("product-20532", "item-4746", 40),
    catalogLine("product-20532", "item-5419", 80),
    catalogLine("product-20532", "item-5294", 20),
    catalogLine("product-20724", "item-6263", 100),
  ]);
  assert.equal(await weight.innerText(), "0,576 kg");
  await page.getByText("Celková hmotnost", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-cart-weight] p").count(), 0);
  await loadCatalogCart([]);
  await page.setViewportSize({ width: 1920, height: 1000 });
  const product = products.find((row) => row.id === screw.productId);
  const variant = product.detail.variants.find((row) => row.id === screw.variantId);
  await page.goto(`${base}/produkt/${product.slug}`);
  await page
    .getByRole("button", { name: `Koupit celé balení ${variant.label}`, exact: true })
    .click();
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem("akros-demo-cart-v3"))?.lines[0]?.quantity === 200,
  );
  await page.goto(`${base}/kosik`);
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "0,68 kg",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("[data-cart-weight] output")?.textContent === "0,68 kg",
  );
  await page.getByRole("button", { name: `Odebrat ${product.name}`, exact: true }).click();
  await page.getByText("Košík je zatím prázdný.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "TASK 16: 14 widths, normalized fixtures and actual catalog kg/piece + kg/metre, partial weights, legacy carts, quantity changes, real package purchase, removal/reload and named carts passed.",
  );
} finally {
  await browser.close();
}
