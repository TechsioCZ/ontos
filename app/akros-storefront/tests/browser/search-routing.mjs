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
const fixtures = [
  {
    sku: "10197200040300",
    slug: "matice-nytovaci-se-zapustnou-hlavou-an-1972-a2",
    ids: ["item-9025"],
  },
  { sku: "10908200100180", slug: "zavitove-vruty-an-9082-a2", ids: ["item-10997"] },
  {
    sku: "3dn31028000000025",
    slug: "dvojniply-typ-310-mat-1-4404",
    ids: ["item-2238", "item-37855"],
  },
  {
    sku: "3typts21000005030",
    slug: "tyce-ploche-tazene-za-studena-h-11-mat-1-4301",
    ids: ["item-33477", "item-37123"],
  },
  {
    sku: "10799700050025",
    slug: "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
    ids: ["item-4709"],
  },
];
const normalize = (text) => text.replace(/\s/g, " ").trim();
const price = (minor) =>
  normalize(
    new Intl.NumberFormat("cs-CZ", {
      style: "currency",
      currency: "CZK",
      minimumFractionDigits: 2,
    }).format(minor / 100),
  );
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
await mkdir("test-results/search-routing", { recursive: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors = [];
  const report = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  const search = page.getByRole("combobox", { name: "Vyhledat v katalogu" });
  const assertRows = async (ids) => {
    const rows = page.locator("[data-variant-detail-link]");
    await rows.first().waitFor();
    assert.deepEqual(
      (
        await rows.evaluateAll((links) => links.map((link) => link.dataset.variantDetailLink))
      ).sort(),
      [...ids].sort(),
    );
  };
  const checkHref = (href, fixture) => {
    const url = new URL(href, base);
    assert.equal(url.pathname, `/produkt/${fixture.slug}`);
    if (fixture.ids.length === 1) {
      assert.equal(url.searchParams.get("variantIds"), fixture.ids[0]);
      assert.equal(url.searchParams.has("variant"), false);
    } else {
      assert.equal(url.searchParams.get("variant"), fixture.sku);
      assert.equal(url.searchParams.has("variantIds"), false);
    }
  };
  for (const width of [1920, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const fixture of fixtures) {
      const product = products.find((product) => product.slug === fixture.slug);
      const variant = product.detail.variants.find((variant) => variant.id === fixture.ids[0]);
      const expectedPrice =
        fixture.ids.length === 1 ? price(variant.priceMinor) : "Cena dle varianty";
      await page.goto(base, { waitUntil: "networkidle" });
      await search.fill(fixture.sku);
      const option = page
        .getByRole("group", { name: "Produkty", exact: true })
        .getByRole("option")
        .filter({ hasText: product.name });
      await option.waitFor();
      assert.equal(await option.count(), 1);
      assert.equal(normalize(await option.locator("strong").innerText()), expectedPrice);
      const href = await option.getAttribute("href");
      checkHref(href, fixture);
      const popup = page.locator('.akros-header__search [data-part="content"]');
      const bounds = await popup.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      if ([fixtures[0], fixtures[2]].includes(fixture) && [1920, 390, 320].includes(width)) {
        await page.screenshot({
          path: `test-results/search-routing/${fixture.sku}-${width}.png`,
          animations: "disabled",
        });
      }
      if (width >= 1024) {
        const optionId = await option.getAttribute("id");
        for (
          let index = 0;
          index < 12 && (await search.getAttribute("aria-activedescendant")) !== optionId;
          index++
        ) {
          await search.press("ArrowDown");
        }
        assert.equal(await search.getAttribute("aria-activedescendant"), optionId);
        await search.press("Enter");
      } else await option.click();
      await page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === href);
      await assertRows(fixture.ids);
      await page.reload({ waitUntil: "networkidle" });
      await assertRows(fixture.ids);
      await page.locator(`[data-variant-detail-link="${variant.id}"]`).click();
      const dialog = page.locator(".akros-variant-detail");
      await dialog.waitFor();
      assert.equal(new URL(page.url()).searchParams.get("variantDetail"), variant.id);
      assert.equal(await dialog.locator("[data-variant-detail-sku]").innerText(), variant.sku);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await assertRows(fixture.ids);

      await page.goto(base, { waitUntil: "networkidle" });
      await search.fill(fixture.sku);
      await page.getByRole("link", { name: /Zobrazit všechny produkty/ }).click();
      await page.waitForURL(
        (url) => url.pathname === "/vyhledavani" && url.searchParams.get("q") === fixture.sku,
      );
      const selector = `.akros-catalog-product-card__image-link[href^="/produkt/${fixture.slug}"]`;
      const resultLink = page.locator(selector);
      await resultLink.waitFor();
      const resultHref = await resultLink.getAttribute("href");
      checkHref(resultHref, fixture);
      const card = page.locator("article").filter({ has: page.locator(selector) });
      assert.equal(
        normalize(await card.locator("[data-akros-product-price]").innerText()),
        expectedPrice,
      );
      await resultLink.click();
      await page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === resultHref);
      await assertRows(fixture.ids);
      report.push({ sku: fixture.sku, width, ids: fixture.ids, href, resultHref });
    }
    console.log(
      `Search routing passed ${width}px: exact and prefix-colliding SKUs, duplicate SKUs, prices, results, reload and modal identity.`,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile("test-results/search-routing/report.json", JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
