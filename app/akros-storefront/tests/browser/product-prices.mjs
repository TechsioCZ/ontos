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
const product = products.find(
  (p) => p.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const variant = product.detail.variants.find(
  (v) => v.priceMinor > 0 && v.stockCount >= v.minimumQuantity,
);
const single = products.find(
  (p) => p.detail.variants.length === 1 && p.detail.variants[0].priceMinor > 0,
);
const normalize = (text) => text.replace(/\s/g, " ").trim();
const price = (minor) =>
  normalize(
    new Intl.NumberFormat("cs-CZ", {
      style: "currency",
      currency: "CZK",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(minor / 100),
  );
const fromPrice = /(?:^|\s)od\s+\d[\d\s.,]*Kč/i;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
await mkdir("test-results/product-prices", { recursive: true });
const report = [];
try {
  for (const width of [1920, 1024, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (reference) => localStorage.setItem("akros-demo-favorites-v1", JSON.stringify([reference])),
      { productId: product.id, productSlug: product.slug, variantId: variant.id },
    );
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
    });
    let cardsChecked = 0;
    for (const route of [
      "/",
      "/kategorie/vruty",
      "/vyhledavani?q=DIN",
      "/novinky-a-akce",
      `/produkt/${product.slug}`,
      "/oblibene",
      `/vyhledavani?q=${variant.sku}`,
      `/produkt/${single.slug}`,
    ]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      const cards = page
        .locator(".akros-product-card")
        .filter({ has: page.locator("[data-akros-product-price]") });
      await cards.first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${route} ${width}px: page overflow`,
      );
      for (const card of await cards.all()) {
        const url = new URL(
          await card.locator(".akros-catalog-product-card__image-link").getAttribute("href"),
          base,
        );
        const source = products.find(
          (p) => p.slug === decodeURIComponent(url.pathname.split("/").at(-1)),
        );
        assert.ok(source);
        const requestedIds = (url.searchParams.get("variantIds") ?? "").split(",").filter(Boolean);
        const selected =
          source.detail.variants.find(
            (v) =>
              v.sku === url.searchParams.get("variant") ||
              (requestedIds.length === 1 && v.id === requestedIds[0]),
          ) ?? (source.detail.variants.length === 1 ? source.detail.variants[0] : undefined);
        const label = card.locator("[data-akros-product-price]");
        const text = normalize(await label.innerText());
        assert.equal(fromPrice.test(text), false);
        if (source.detail.variants.length > 1 && !selected)
          assert.equal(
            text,
            "Cena dle varianty",
            `${route}: unselected group must not advertise its minimum price`,
          );
        else {
          const amount = selected?.priceMinor ?? source.priceMinor;
          assert.ok(
            text.includes(amount > 0 ? price(amount) : "Cena na dotaz"),
            `${route}: concrete price for ${source.slug}: ${text}`,
          );
        }
        assert.equal(
          await label.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
          false,
          `${route}: price label clipped at ${width}px`,
        );
        cardsChecked++;
      }
      await cards.first().scrollIntoViewIfNeeded();
      if (route === "/" || route === "/oblibene")
        await page.screenshot({
          path: `test-results/product-prices/${route === "/" ? "home" : "favorites"}-${width}.png`,
        });
    }
    await page.goto(base, { waitUntil: "networkidle" });
    const search = page.getByRole("combobox", { name: "Vyhledat v katalogu" });
    await search.fill("DIN7997");
    const suggestionPrices = page.getByRole("option").locator("strong");
    await suggestionPrices.first().waitFor();
    assert.ok(
      (await suggestionPrices.allTextContents()).some((value) => value === "Cena dle varianty"),
    );
    assert.ok((await suggestionPrices.allTextContents()).every((value) => !fromPrice.test(value)));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    await page.screenshot({
      path: `test-results/product-prices/search-${width}.png`,
      animations: "disabled",
    });
    await search.fill(variant.sku);
    const exact = page.getByRole("option").filter({ hasText: product.name });
    await exact.waitFor();
    assert.equal(normalize(await exact.locator("strong").innerText()), price(variant.priceMinor));
    await page.keyboard.press("Escape");
    await page.goto(`${base}/produkt/${product.slug}?variant=${variant.sku}`, {
      waitUntil: "networkidle",
    });
    const row = page.locator(".akros-variant-data-table__table tbody tr");
    await row.waitFor();
    assert.ok(
      normalize(await row.locator(".akros-variant-table__price").innerText()).includes(
        price(variant.priceMinor),
      ),
    );
    await row
      .locator(".akros-variant-table__order--minimum .akros-variant-table__buy-button")
      .click();
    await page.waitForFunction(
      ({ id, amount, minor }) =>
        JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null")?.lines.some(
          (line) => line.variantId === id && line.quantity === amount && line.priceMinor === minor,
        ),
      { id: variant.id, amount: variant.minimumQuantity, minor: variant.priceMinor },
    );
    await page.goto(`${base}/kosik`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Obsah košíku", exact: true }).waitFor();
    assert.ok(
      normalize(await page.locator("body").innerText()).includes(
        price(variant.priceMinor * variant.minimumQuantity),
      ),
    );
    assert.deepEqual(errors, []);
    report.push({ width, cardsChecked });
    console.log(
      `Prices passed ${width}px: ${cardsChecked} source-checked cards, group/exact suggestions, exact variant and cart total.`,
    );
    await context.close();
  }
  await writeFile(
    "test-results/product-prices/report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
