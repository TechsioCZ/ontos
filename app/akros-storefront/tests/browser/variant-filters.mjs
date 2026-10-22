import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { checkVariantFilterRecovery } from "./variant-filter-checks.mjs";

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
const fixtures = [
  [largest, "Průměr (mm)"],
  [
    products.find((p) => p.slug.startsWith("plechy-brousene-") && p.detail.variants.length > 4),
    "Tloušťka (mm)",
  ],
  [
    products.find((p) => p.slug.startsWith("trubky-ctvercove-") && p.detail.variants.length > 4),
    "Tloušťka stěny (mm)",
  ],
  [
    products.find(
      (p) =>
        p.slug.startsWith("trubky-") &&
        !/ctvercov|obdelnikov/.test(p.slug) &&
        p.detail.variants.length > 4,
    ),
    "Tloušťka stěny (mm)",
  ],
];
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
await mkdir("test-results/variant-filters", { recursive: true });
const report = [];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  for (const [product, expectedLabel] of fixtures) {
    assert.ok(product);
    await page.goto(`${base}/produkt/${product.slug}`, { waitUntil: "domcontentloaded" });
    await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
    const form = page.getByRole("form", { name: "Filtrování variant" });
    await form.waitFor();
    assert.equal(
      await form.getByRole("spinbutton", { name: `Minimum – ${expectedLabel}` }).count(),
      1,
    );
    const labels = await form
      .getByRole("spinbutton", { name: /^Minimum/ })
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute("aria-label")));
    assert.equal(await form.getByRole("checkbox").count(), 0);
    assert.equal(await form.getByRole("spinbutton", { name: /Cena/ }).count(), 0);
    if (product !== largest)
      assert.ok(labels.every((label) => !label.includes("Minimum – Průměr")));
    for (const width of [1920, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await form.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      await page.screenshot({ path: `test-results/variant-filters/${product.slug}-${width}.png` });
    }
    report.push({ slug: product.slug, labels });
  }
  await page.goto(`${base}/produkt/${largest.slug}`, { waitUntil: "domcontentloaded" });
  await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
  const form = page.getByRole("form", { name: "Filtrování variant" });
  const input = form.getByRole("spinbutton", { name: "Minimum – Průměr (mm)" });
  const id = await input.getAttribute("id");
  await input.fill("");
  assert.equal(await input.inputValue(), "");
  const begin = performance.now();
  await input.pressSequentially("3,");
  assert.equal(await input.inputValue(), "3,");
  await input.pressSequentially("5");
  await page.waitForFunction(
    () => document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") === "3.5",
  );
  assert.equal(await input.inputValue(), "3,5");
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.getAttribute("id"), id);
  const commaInputMs = Math.round(performance.now() - begin);
  await form.getByRole("button", { name: "Obnovit filtry" }).click();
  await input.fill("");
  await input.pressSequentially("3.5");
  await page.waitForFunction(
    () => document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") === "3.5",
  );
  await input.press("Tab");
  assert.equal(Number((await input.inputValue()).replace(",", ".")), 3.5);
  await form.getByRole("button", { name: "Obnovit filtry" }).click();
  const slider = form.getByRole("slider").first();
  await slider.focus();
  await slider.press("ArrowRight");
  await page.waitForFunction(
    () => Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")) > 1.6,
  );
  assert.equal(await slider.evaluate((element) => element === document.activeElement), true);
  assert.ok(Number((await input.inputValue()).replace(",", ".")) > 1.6);
  await form.getByRole("button", { name: "Obnovit filtry" }).click();
  const thumb = await slider.boundingBox();
  assert.ok(thumb);
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2 + 20, thumb.y + thumb.height / 2, { steps: 4 });
  await page.mouse.up();
  const dragged = Number(await slider.getAttribute("aria-valuenow"));
  assert.ok(dragged > 1.6, "pointer drag changes the lower bound");
  assert.equal(Number((await input.inputValue()).replace(",", ".")), dragged);
  await form.getByRole("button", { name: "Obnovit filtry" }).click();
  const recovery = await checkVariantFilterRecovery(page, largest);
  assert.equal(
    await page.locator(".akros-variant-purchase > output").innerText(),
    `Zobrazeno 386 z 386 variant`,
  );
  assert.deepEqual(errors, []);
  const result = { fixtures: report, commaInputMs, ...recovery };
  await writeFile(
    "test-results/variant-filters/report.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
