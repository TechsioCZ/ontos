import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const slug = "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2";
const { products } = JSON.parse(
  await readFile(
    new URL("../../src/mock-storefront/generated/catalog.generated.json", import.meta.url),
  ),
);
const product = products.find((item) => item.slug === slug);
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const style = (locator, property) =>
  locator.evaluate((element, name) => getComputedStyle(element)[name], property);

async function probe(scope, tokens, assertions) {
  const previous = await scope.getAttribute("style");
  try {
    await scope.evaluate((element, values) => {
      for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value);
    }, tokens);
    await assertions();
  } finally {
    await scope.evaluate((element, value) => {
      if (value === null) element.removeAttribute("style");
      else element.setAttribute("style", value);
    }, previous);
  }
}

try {
  for (const width of [1920, 1024, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(120000);
    await page.goto(new URL(`/produkt/${slug}`, baseUrl).href, { waitUntil: "networkidle" });
    const table = page.locator(".akros-variant-data-table__table");
    const form = page.getByRole("form", { name: "Filtrování variant" });
    const submit = form.getByRole("button", { name: "Filtruj" });
    await probe(submit, { "--font-weight-button": "600" }, async () => {
      assert.equal(await style(submit, "fontWeight"), "600");
    });
    const quantity = table.locator(".akros-variant-table__quantity-control").first();
    await probe(
      quantity,
      { "--padding-input-md": "1px 9px", "--padding-numeric-input-input-sm": "7px" },
      async () => {
        const input = quantity.locator("input");
        assert.equal(await style(input, "paddingTop"), "1px");
        assert.equal(await style(input, "paddingInlineStart"), "7px");
        assert.equal(await style(input, "paddingInlineEnd"), "9px");
      },
    );
    const containerWidth = await page
      .locator(".akros-variant-purchase")
      .evaluate((element) => element.getBoundingClientRect().width);
    if (containerWidth >= 1000) {
      await probe(table, { "--padding-table-cell-sm": "7px 9px" }, async () => {
        assert.equal(await style(table.locator("tbody td").first(), "padding"), "7px 9px");
      });
      const header = table.locator("thead");
      await probe(header, { "--text-table-sm": "12px" }, async () => {
        assert.equal(await style(header.locator("th").first(), "fontSize"), "12px");
      });
    } else {
      const buy = table.locator(".akros-variant-table__buy-button").first();
      await probe(
        buy,
        { "--padding-button-sm": "3px 7px", "--height-form-control-sm": "60px" },
        async () => {
          assert.equal(await style(buy, "padding"), "3px 7px");
          assert.equal(await style(buy, "height"), "60px");
        },
      );
    }

    const firstRow = table
      .locator("tbody tr")
      .filter({
        has: page.locator(
          ".akros-variant-table__order--package .akros-variant-table__buy-button:not(:disabled)",
        ),
      })
      .first();
    const sku = await firstRow.locator(".akros-variant-table__sku > span").last().textContent();
    const variant = product.detail.variants.find((item) => item.sku === sku);
    assert.ok(variant, `Source variant for ${sku} exists`);
    await firstRow
      .locator(".akros-variant-table__order--minimum .akros-variant-table__buy-button")
      .click();
    await firstRow
      .locator(".akros-variant-table__order--package .akros-variant-table__buy-button")
      .click();
    await page.waitForFunction(
      ({ variantId, expected }) => {
        const cart = JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null");
        return cart?.lines.find((line) => line.variantId === variantId)?.quantity === expected;
      },
      { variantId: variant.id, expected: variant.minimumQuantity + variant.packageQuantity },
    );

    assert.equal(await table.locator("tbody tr").count(), product.detail.variants.length);
    assert.equal(await page.getByRole("navigation", { name: "Stránkování variant" }).count(), 0);
    assert.equal(
      await table
        .locator(".akros-variant-table__name")
        .allTextContents()
        .then((names) => names.some((name) => name.includes(product.name))),
      false,
    );

    // Selecting no materials must show the empty state; restoring them brings rows back.
    const checkboxes = form.getByRole("checkbox");
    const count = await checkboxes.count();
    assert.ok(count > 0);
    for (let index = 0; index < count; index++) {
      const checkbox = checkboxes.nth(index);
      if (await checkbox.isChecked()) await checkbox.locator("..").click();
    }
    await submit.click();
    await page.locator(".akros-variant-purchase__empty").waitFor();
    for (let index = 0; index < count; index++) await checkboxes.nth(index).locator("..").click();
    await submit.click();
    await table.locator("tbody tr").first().waitFor();
    assert.equal(await table.locator("tbody tr").count(), product.detail.variants.length);

    const slider = form.getByRole("slider").first();
    const before = Number(await slider.getAttribute("aria-valuenow"));
    await slider.focus();
    await slider.press("ArrowRight");
    assert.ok(Number(await slider.getAttribute("aria-valuenow")) > before);
    await submit.click();
    await table.locator("tbody tr").first().waitFor();

    for (const route of ["/kategorie/vruty", "/vyhledavani?q=DIN"]) {
      await page.goto(new URL(route, baseUrl).href, { waitUntil: "networkidle" });
      const card = page.locator(".akros-catalog-product-card__image-link").first();
      const firstHref = await card.getAttribute("href");
      const next = page.locator('.akros-catalog-pagination [data-part="next-trigger"]');
      const target = new URL(await next.getAttribute("href"), baseUrl);
      assert.equal(target.searchParams.get("page"), "2");
      if (route.startsWith("/vyhledavani")) assert.equal(target.searchParams.get("q"), "DIN");
      await next.click();
      await page.waitForURL((url) => url.searchParams.get("page") === "2");
      assert.notEqual(await card.getAttribute("href"), firstHref);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
    }
    await context.close();
    console.log(
      `Catalog passed ${width}px: tokens, minimum/package purchase, all variants, filters, slider and catalog pagination.`,
    );
  }
} finally {
  await browser.close();
}
