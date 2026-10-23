import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const widths = [1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320];
const output = "test-results/reorder";
await mkdir(output, { recursive: true });
const { products } = JSON.parse(
  await readFile("src/mock-storefront/generated/catalog.generated.json", "utf8"),
);
const product = products.find((row) => row.id === "product-20532");
function item(id, quantity, priceMinor) {
  const variant = product.detail.variants.find((row) => row.id === id);
  return {
    productId: product.id,
    variantId: id,
    name: product.name,
    slug: product.slug,
    sku: variant.sku,
    imageSrc: product.imageSrc,
    imageAlt: product.imageAlt,
    unit: variant.unit,
    minimumQuantity: variant.minimumQuantity,
    stockCount: variant.stockCount,
    priceMinor: priceMinor ?? variant.priceMinor,
    quantity,
  };
}
const seed = {
  version: 1,
  activeCartId: "project",
  carts: [
    { id: "default", name: "Výchozí košík", cart: { version: 3, lines: [item("item-5423", 1)] } },
    {
      id: "project",
      name: "Projekt",
      cart: { version: 3, lines: [item("item-4746", 10, 1), item("item-5422", 1)] },
    },
  ],
};
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript((seed) => {
      if (!localStorage.getItem("akros-demo-carts-v1"))
        localStorage.setItem("akros-demo-carts-v1", JSON.stringify(seed));
    }, seed);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const readCart = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem("akros-demo-carts-v1")));
    const active = (stored) =>
      stored.carts.find((cart) => cart.id === stored.activeCartId).cart.lines;
    async function repeat(number) {
      const button = page
        .getByRole("button", { name: `Objednat znovu #2024-${number}`, exact: true })
        .filter({ visible: true });
      assert.ok((await button.boundingBox()).height >= 44, "reorder touch target");
      await button.click();
      await page.getByRole("link", { name: "Přejít do košíku" }).waitFor();
    }
    async function bounds(label) {
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${label}: overflow at ${width}`,
      );
      assert.deepEqual(errors, [], `${label}: runtime errors at ${width}`);
    }
    async function screenshot(name) {
      await page.evaluate(async () => {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
      });
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
    await page.goto(base + "/historie-objednavek");
    await page.evaluate(() => document.fonts.ready);
    if ([1920, 390].includes(width)) await screenshot("history-idle");
    const firstRow = page
      .locator("[data-account-table] tbody tr")
      .filter({ has: page.getByRole("link", { name: "#2024-00847", exact: true }) });
    const rowBefore =
      width >= 1280
        ? await firstRow.evaluate((row) => ({
            height: row.getBoundingClientRect().height,
            widths: [...row.cells].map((cell) => cell.getBoundingClientRect().width),
          }))
        : null;
    await repeat("00847");
    if (rowBefore) {
      const rowAfter = await firstRow.evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        widths: [...row.cells].map((cell) => cell.getBoundingClientRect().width),
      }));
      assert.deepEqual(
        rowAfter,
        rowBefore,
        "confirmation must not resize the order row or its columns",
      );
    }
    assert.equal(
      await page.locator("[data-account-table] [data-akros-cart-notification]").count(),
      0,
    );
    assert.equal(await page.locator('[data-scope="toast"][data-part="root"]').count(), 1);
    assert.equal(new URL(page.url()).pathname, "/historie-objednavek");
    let stored = await readCart();
    assert.equal(stored.activeCartId, "project");
    assert.deepEqual(
      active(stored).map((row) => [row.variantId, row.quantity]),
      [
        ["item-4746", 30],
        ["item-5422", 1],
        ["item-5419", 40],
        ["item-5294", 10],
      ],
    );
    assert.equal(active(stored)[0].priceMinor, 159, "existing stale price refreshed");
    assert.deepEqual(stored.carts[0], seed.carts[0], "other named cart preserved");
    await bounds("history with success");
    if ([1920, 1024, 768, 390, 320].includes(width)) await screenshot("history");
    await page.reload();
    await repeat("00847");
    stored = await readCart();
    assert.equal(active(stored).find((row) => row.variantId === "item-4746").quantity, 50);
    await page.goto(base + "/detail-objednavky?order=2024-00812");
    await repeat("00812");
    await page.getByText(/10799700030025: přidáno 0/).waitFor();
    stored = await readCart();
    assert.equal(active(stored).find((row) => row.variantId === "item-5420").quantity, 20);
    assert.equal(
      active(stored).some((row) => row.variantId === "item-6543"),
      false,
    );
    await bounds("unavailable variant");
    if ([1920, 390, 320].includes(width)) await screenshot("partial");
    await page.goto(base + "/detail-objednavky?order=2024-00790");
    await repeat("00790");
    await page.getByText(/10799700050025: přidáno 30 z 100/).waitFor();
    stored = await readCart();
    assert.equal(active(stored).find((row) => row.variantId === "item-4709").quantity, 30);
    await bounds("stock limit");
    await page.getByRole("link", { name: "Přejít do košíku", exact: true }).click();
    await page.getByRole("heading", { name: "Obsah košíku", exact: true }).waitFor();
    await bounds("cart");
    await context.close();
    console.log(
      `Reorder at ${width}px: real cart, merge, current prices, named cart isolation, reload, missing stock and limits passed.`,
    );
  }
} finally {
  await browser.close();
}
