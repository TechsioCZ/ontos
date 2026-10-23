import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";
const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const endpoint = /\/api\/(?:v1\/suggest|address-suggestions)\?/;
const full = {
  id: "address-1",
  displayLabel: "Václavské náměstí 846/1, Praha, 110 00",
  confidence: 1,
  kind: "address",
  source: { id: "test", kind: "owned-dataset", name: "Test" },
  address: {
    street: "Václavské náměstí",
    houseNumber: "846",
    orientationNumber: "1",
    city: "Praha",
    postalCode: "110 00",
    countryCode: "CZ",
  },
  attribution: { label: "Testovací zdroj", url: "https://example.com/attribution" },
};
const partial = {
  ...full,
  id: "partial",
  displayLabel: "Brno",
  address: { city: "Brno", countryCode: "CZ" },
};
const suggestions = [
  full,
  ...Array.from({ length: 19 }, (_, index) => ({
    ...full,
    id: `address-${index + 2}`,
    displayLabel: `Václavské náměstí ${index + 2}, Praha, 110 00`,
    address: { ...full.address, houseNumber: String(index + 2), orientationNumber: undefined },
  })),
];
await mkdir("test-results/task-17", { recursive: true });
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
      if (!sessionStorage.getItem("address-test-seeded")) {
        localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
        sessionStorage.setItem("address-test-seeded", "1");
      }
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  let mode = "full";
  const requests = [];
  await page.route(endpoint, async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    requests.push(q);
    if (mode === "failed")
      return route.fulfill({
        status: 503,
        body: "offline",
        headers: { "access-control-allow-origin": "*" },
      });
    if (q === "Old street") await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({
      json: {
        requestId: "test",
        cacheStatus: "miss",
        suggestions: mode === "empty" ? [] : mode === "partial" ? [partial] : suggestions,
      },
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.goto(`${base}/kosik/dodaci-udaje`);
  await page.getByRole("button", { name: "Změnit fakturační údaje", exact: true }).click();
  const street = page.locator('[data-address-field="billing-street"] input[role="combobox"]');
  for (const width of [
    1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320,
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await street.fill("Václavské");
    const option = page.getByRole("option", { name: full.displayLabel, exact: true });
    await option.waitFor();
    assert.equal(await page.getByRole("option").count(), 20);
    await option.scrollIntoViewIfNeeded();
    const popup = page.locator('[data-scope="combobox"][data-part="content"][data-state="open"]');
    const r = await popup.boundingBox();
    assert.ok(r.x >= -1 && r.x + r.width <= width + 1, `popup overflow at ${width}`);
    assert.ok(r.height <= 321, `popup too tall at ${width}`);
    const list = page.getByRole("listbox");
    assert.ok(
      await list.evaluate((element) => element.scrollHeight > element.clientHeight),
      "long suggestions must scroll inside the popup",
    );
    const lastOption = page.getByRole("option").last();
    await lastOption.scrollIntoViewIfNeeded();
    const lastBounds = await lastOption.boundingBox();
    const popupBounds = await popup.boundingBox();
    assert.ok(
      lastBounds.y >= popupBounds.y - 1 &&
        lastBounds.y + lastBounds.height <= popupBounds.y + popupBounds.height + 1,
      "last suggestion must remain reachable",
    );
    await option.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    assert.ok((await option.boundingBox()).height >= 44, `small touch target at ${width}`);
    if ([1920, 768, 390, 320].includes(width))
      await page.screenshot({
        path: `test-results/task-17/suggestions-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
    let selected = full;
    if (width >= 1024) {
      await street.focus();
      const beforeHighlight = await street.inputValue();
      await street.press("ArrowDown");
      assert.equal(
        await street.inputValue(),
        beforeHighlight,
        `highlight must not rewrite the query at ${width}px`,
      );
      const highlightedLabel = await page
        .locator('[role="option"][data-highlighted]')
        .getAttribute("aria-label");
      // Reopening the same query must not clear a keyboard selection after the debounce.
      await page.waitForTimeout(400);
      assert.equal(
        await page.locator('[role="option"][data-highlighted]').getAttribute("aria-label"),
        highlightedLabel,
      );
      selected = suggestions.find((item) => item.displayLabel === highlightedLabel);
      assert.ok(selected, "keyboard highlight must identify one of the returned addresses");
      await street.press("Enter");
    } else {
      await option.click();
    }
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-address-field="billing-street"] input')?.value === expected,
      [
        selected.address.street,
        [selected.address.houseNumber, selected.address.orientationNumber]
          .filter(Boolean)
          .join("/"),
      ].join(" "),
    );
    assert.equal(await page.locator("#billing-city").inputValue(), "Praha");
    assert.equal(await page.locator("#billing-postalCode").inputValue(), "110 00");
    assert.equal(await page.locator("#billing-firstName").inputValue(), "Jan");
  }
  await page
    .getByText("Zboží chci doručit na jinou adresu než fakturační", { exact: true })
    .click();
  const delivery = page.locator('[data-address-field="delivery-street"] input[role="combobox"]');
  await delivery.fill("Václavské");
  await page.getByRole("option", { name: full.displayLabel, exact: true }).click();
  assert.equal(await page.locator("#delivery-city").inputValue(), "Praha");
  assert.equal(await street.inputValue(), "Václavské náměstí 846/1");
  mode = "partial";
  await delivery.fill("Brno");
  await page.getByRole("option", { name: "Brno", exact: true }).click();
  assert.equal(await page.locator("#delivery-city").inputValue(), "Brno");
  assert.equal(
    await page.locator("#delivery-postalCode").inputValue(),
    "110 00",
    "absent postal code must not erase existing input",
  );
  mode = "empty";
  await street.fill("No address");
  await page
    .getByText("Služba nenašla návrhy. Adresu můžete zadat ručně.", { exact: true })
    .waitFor();
  mode = "failed";
  await street.fill("Unavailable street");
  await page.locator(".akros-address-status").waitFor();
  mode = "full";
  const retry = page.getByRole("button", { name: "Zkusit znovu", exact: true });
  assert.equal(await retry.getAttribute("type"), "button");
  await retry.click();
  await page.getByRole("option", { name: full.displayLabel, exact: true }).waitFor();
  assert.equal(
    new URL(page.url()).pathname,
    "/kosik/dodaci-udaje",
    "retry must not submit checkout",
  );
  mode = "failed";
  await street.press("Escape");
  await street.fill("Ruční adresa 1");
  await street.press("Tab");
  assert.equal(await street.inputValue(), "Ruční adresa 1");
  mode = "full";
  const oldRequestPromise = page.waitForRequest((r) => r.url().includes("q=Old+street"));
  await street.fill("Old street");
  await oldRequestPromise;
  mode = "empty";
  await street.fill("New street");
  await page
    .getByText("Služba nenašla návrhy. Adresu můžete zadat ručně.", { exact: true })
    .waitFor();
  await page.waitForTimeout(1100);
  assert.equal(await street.inputValue(), "New street");
  assert.equal(await page.getByRole("option").count(), 0);
  await street.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Změnit fakturační údaje", exact: true }).click();
  assert.equal(await street.inputValue(), "New street");
  assert.equal(await page.locator("#billing-city").inputValue(), "Praha");
  assert.deepEqual(errors, []);
  console.log(
    `TASK 17: 14 widths, keyboard/pointer, billing/delivery isolation, partial data, empty/outage/manual entry, stale responses and reload passed (${requests.length} test requests).`,
  );
} finally {
  await browser.close();
}
