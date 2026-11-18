import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Manual integration proof: use the live catalog, quote and shipping methods, never an old demo draft.
// Adds to a fresh browser cart only; it never submits an order or creates an account.
const base = new URL(process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000");
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  await page.goto(new URL("/cs", base).href, { waitUntil: "networkidle" });
  await page.locator(".sf-catalog-product-card__image-link").first().click();
  // At least one in-stock, priced item is required on the first featured product.
  const available = page.getByRole("button", { name: /^Koupit/, disabled: false });
  await available.first().click();
  await page.getByText("Přidáno do košíku", { exact: true }).waitFor();
  await page.goto(new URL("/cs/kosik", base).href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Objednat bez registrace", exact: true }).click();
  const shipping = page.locator('[data-scope="radio-group"][data-part="item"]').first();
  await shipping.waitFor();
  await shipping.click();
  await page.getByRole("button", { name: "Dodací údaje", exact: true }).click();
  const street = page.locator('[data-address-field="billing-street"] input[role="combobox"]');
  await street.waitFor();
  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const query = width === 1920 ? "Bakalovo nábřeží Brno" : "Bakalovo nábřeží";
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/address-suggestions" &&
        new URL(response.url()).searchParams.get("q") === query,
    );
    await street.fill(query);
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(new URL(response.url()).searchParams.get("limit"), "20");
    const result = await response.json();
    const suggestion = result.suggestions.find(
      (item) =>
        item.address?.countryCode === "CZ" &&
        item.address.city === "Brno" &&
        item.address.houseNumber === "8",
    );
    assert.ok(suggestion, "The live provider must return Bakalovo nábřeží 8, Brno");
    await page.getByRole("option", { name: suggestion.displayLabel, exact: true }).click();
    assert.match(await street.inputValue(), /Bakalovo nábřeží.*8/);
    assert.equal(await page.locator("#billing-city").inputValue(), "Brno");
    assert.equal(
      await page.locator("#billing-postalCode").inputValue(),
      suggestion.address.postalCode,
    );
  }
  console.log(
    "Live address provider and checkout completion passed with no interception or order submission.",
  );
} finally {
  await browser.close();
}
