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
    slug: "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
    description: "Popis není k dispozici.",
  },
  {
    slug: "srouby-s-sestihrannou-hlavou-din-933-a4-70",
    description: "Tuto položku zadávejte v případě, že trváte na přesném dodání materiálu A4 - 70.",
  },
  {
    slug: "profilovana-stresni-krytina-product-35919",
    description: "Kompletní sortiment pro fotovoltaické panely",
  },
  { slug: products.find((p) => p.detail.variants.length <= 1 && p.priceMinor > 0)?.slug },
];
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
await mkdir("test-results/product-information", { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const report = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  for (const [index, fixture] of fixtures.entries()) {
    assert.ok(fixture.slug);
    for (const width of [1920, 1440, 1280, 1024, 768, 767, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/produkt/${fixture.slug}`, { waitUntil: "networkidle" });
      const description = page.getByRole("region", { name: "Popis produktu", exact: true });
      const delivery = page.getByRole("region", { name: "Doprava a platba", exact: true });
      assert.equal(await description.count(), 1);
      if (fixture.description)
        assert.ok((await description.innerText()).includes(fixture.description));
      assert.equal((await description.innerText()).includes("Limity množstevních slev"), false);
      const link = delivery.getByRole("link", { name: "Více o dopravě a platbě" });
      assert.equal(await link.getAttribute("href"), "/doprava-a-platba");
      assert.equal(/Kč|pracovní dny|zítra|do 24 hodin/.test(await delivery.innerText()), false);
      const layout = await page.evaluate(() => {
        const overview = document
          .querySelector(".akros-product-detail__overview")
          .getBoundingClientRect();
        const description = document
          .querySelector('[aria-labelledby="description-title"]')
          .getBoundingClientRect();
        const delivery = document
          .querySelector(".akros-product-detail__delivery")
          .getBoundingClientRect();
        const actions = document
          .querySelector(".akros-product-detail__summary > .akros-product-actions")
          .getBoundingClientRect();
        const variants = document.getElementById("product-variants")?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          descriptionAfterOverview: description.top >= overview.bottom,
          descriptionBeforeVariants: !variants || description.bottom <= variants.top,
          deliveryAfterActions: delivery.top >= actions.bottom,
          deliveryInsideOverview: delivery.bottom <= overview.bottom,
          oldSummary: !!document.querySelector(".akros-product-detail__description"),
        };
      });
      assert.deepEqual(
        layout,
        {
          overflow: false,
          descriptionAfterOverview: true,
          descriptionBeforeVariants: true,
          deliveryAfterActions: true,
          deliveryInsideOverview: true,
          oldSummary: false,
        },
        JSON.stringify({ fixture, width, layout }),
      );
      if ([1920, 1024, 390, 320].includes(width)) {
        await page.screenshot({
          path: `test-results/product-information/${index}-${width}.png`,
          animations: "disabled",
          fullPage: false,
        });
        await description.screenshot({
          path: `test-results/product-information/${index}-${width}-description.png`,
          animations: "disabled",
        });
        await delivery.screenshot({
          path: `test-results/product-information/${index}-${width}-delivery.png`,
          animations: "disabled",
        });
      }
      report.push({ slug: fixture.slug, width, ...layout });
      console.log(`Product information: ${fixture.slug} at ${width}px passed.`);
      if (index === 1 && [1920, 390, 320].includes(width)) {
        const product = products.find((p) => p.slug === fixture.slug);
        const variant = product.detail.variants[0];
        await page.goto(`${base}/produkt/${product.slug}?variantDetail=${variant.id}`, {
          waitUntil: "networkidle",
        });
        const dialog = page.locator(".akros-variant-detail");
        await dialog.waitFor();
        assert.ok(
          (
            await dialog.getByRole("region", { name: "Popis varianty", exact: true }).innerText()
          ).includes(fixture.description),
        );
        assert.equal((await dialog.innerText()).includes("Limity množstevních slev"), false);
        const weight = dialog
          .locator(".akros-variant-detail__parameters > div")
          .filter({ has: page.locator("dt", { hasText: /^Hmotnost$/ }) })
          .locator("dd");
        const expectedWeight = variant.sourceNetWeight
          ? `${variant.sourceNetWeight.toLocaleString("cs-CZ", { maximumFractionDigits: 6 })} kg`
          : "Neuvedena";
        assert.equal(await weight.innerText(), expectedWeight);
        await dialog.getByRole("button", { name: "Zavřít detail varianty" }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.ok(
          (await page.locator(".akros-print-sheet").textContent()).includes(fixture.description),
        );
        await page.emulateMedia({ media: "print" });
        await page.locator(".akros-print-sheet").waitFor({ state: "visible" });
        assert.equal(await delivery.isVisible(), false);
        await page.emulateMedia({ media: "screen" });
        await link.click();
        await page.waitForURL("**/doprava-a-platba");
        await page
          .getByRole("heading", { name: "Informace o dopravě a možnostech platby" })
          .waitFor();
      }
    }
  }
  const screws = products.find(
    (p) => p.slug === "srouby-s-valcovou-hlavou-s-vnitrnim-sestihranem-din-912-a2",
  );
  const noWeightProduct = products.find(
    (p) =>
      p.detail.variants.length > 1 &&
      p.detail.variants.some((v) => !v.sourceNetWeight && v.unit === "m"),
  );
  const noWeight = noWeightProduct.detail.variants.find(
    (v) => !v.sourceNetWeight && v.unit === "m",
  );
  for (const width of [1920, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const { product, variant, expected } of [
      {
        product: screws,
        variant: screws.detail.variants.find((v) => v.sourceId === "29"),
        expected: "0,00691 kg",
      },
      {
        product: screws,
        variant: screws.detail.variants.find((v) => v.sourceId === "385"),
        expected: "0,204 kg",
      },
      { product: noWeightProduct, variant: noWeight, expected: "Neuvedena" },
    ]) {
      assert.ok(variant);
      await page.goto(`${base}/produkt/${product.slug}?variantDetail=${variant.id}`, {
        waitUntil: "networkidle",
      });
      const dialog = page.locator(".akros-variant-detail");
      await dialog.waitFor();
      const weight = dialog
        .locator(".akros-variant-detail__parameters > div")
        .filter({ has: page.locator("dt", { hasText: /^Hmotnost$/ }) })
        .locator("dd");
      assert.equal(await weight.innerText(), expected);
      assert.equal(
        await page
          .locator(".akros-product-detail__overview")
          .getByText("Hmotnost", { exact: true })
          .count(),
        0,
      );
    }
  }
  assert.deepEqual(errors, []);
  await writeFile("test-results/product-information/report.json", JSON.stringify(report, null, 2));
  console.log(
    `Product information: ${report.length} layouts passed; missing, material and short descriptions, variant modal, print and delivery navigation checked.`,
  );
} finally {
  await browser.close();
}
