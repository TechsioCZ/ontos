import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";
const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
await mkdir("test-results/task-17-live", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes('unique "key"'))
      errors.push(message.text());
  });
  await page.addInitScript(
    ({ cart, checkout }) => {
      if (!sessionStorage.getItem("address-live-seeded")) {
        localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
        sessionStorage.setItem("address-live-seeded", "1");
      }
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  await page.goto(`${base}/kosik/dodaci-udaje`);
  await page.getByRole("button", { name: "Změnit fakturační údaje", exact: true }).click();
  const report = [];
  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const street = page.locator('[data-address-field="billing-street"] input[role="combobox"]');
    const query = width === 1920 ? "Bakalovo nábřeží Brno" : "Bakalovo nábřeží";
    const responsePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/address-suggestions" &&
        new URL(r.url()).searchParams.get("q") === query,
      { timeout: 15000 },
    );
    await street.fill(query);
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(new URL(response.url()).searchParams.get("limit"), "20");
    const first = result.suggestions.find(
      (s) =>
        s.address?.countryCode === "CZ" &&
        s.address.city === "Brno" &&
        s.address.houseNumber === "8",
    );
    assert.ok(first, "Live service did not return the reported Bakalovo nábřeží 8 address");
    const option = page.getByRole("option", { name: first.displayLabel, exact: true });
    await option.waitFor();
    await option.click();
    const a = first.address;
    const expectedStreet =
      a.line1 ||
      [a.street, [a.houseNumber, a.orientationNumber].filter(Boolean).join("/")]
        .filter(Boolean)
        .join(" ");
    assert.equal(await street.inputValue(), expectedStreet);
    assert.equal(await page.locator("#billing-city").inputValue(), a.city);
    assert.equal(await page.locator("#billing-postalCode").inputValue(), a.postalCode);
    await page.screenshot({
      path: `test-results/task-17-live/selected-${width}.png`,
      animations: "disabled",
    });
    report.push({
      width,
      status: response.status(),
      source: first.source?.name,
      address: first.displayLabel,
      query,
      suggestionCount: result.suggestions.length,
    });
  }
  assert.deepEqual(errors, []);
  await writeFile("test-results/task-17-live/report.json", JSON.stringify(report, null, 2));
  console.log(
    "Live Smart Address: same-origin rewrite, 20-result request and actual Bakalovo nábřeží 8 completion passed at desktop/mobile (no interception).",
  );
} finally {
  await browser.close();
}
