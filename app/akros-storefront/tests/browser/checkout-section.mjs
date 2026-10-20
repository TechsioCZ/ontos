import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const browserPath = process.env.AKROS_CHROMIUM_PATH;
const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch(
  browserPath ? { executablePath: browserPath } : { channel: "chrome" },
);
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  await page.addInitScript(
    ({ cart, checkout }) => {
      if (!sessionStorage.getItem("checkout-layout-seeded")) {
        localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
        sessionStorage.setItem("checkout-layout-seeded", "1");
      }
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  await page.goto(new URL("/kosik", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.locator("table tbody tr").last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const selector = page.locator("[data-akros-cart-selector]");
  const initialCount = await page.locator("table tbody tr").count();
  assert.equal(initialCount, 3);
  assert.equal(await page.locator("table").getByText("Kód produktu:", { exact: false }).count(), 0);

  for (const width of [1920, 1692, 1660, 1536, 1535, 1440, 1280, 1024, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(350);
    const failures = await page.evaluate(() => {
      const failures = [];
      for (const surface of document.querySelectorAll(
        "[data-akros-cart-selector], [data-akros-cart-navigation]",
      )) {
        const bounds = surface.getBoundingClientRect();
        for (const control of surface.querySelectorAll('button, a, [data-part="item-text"]')) {
          const rect = control.getBoundingClientRect();
          if (rect.width > 1 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))
            failures.push("Sidebar/navigation overflow");
        }
      }
      for (const link of document.querySelectorAll("[data-akros-cart-navigation] a")) {
        if (Math.abs(link.getBoundingClientRect().height - 60) > 1)
          failures.push("CTA height differs from Figma");
        if (parseFloat(getComputedStyle(link).fontSize) !== 20)
          failures.push("CTA font size differs from Figma");
      }
      const cart = document.querySelector('[aria-labelledby="cart-title"]').getBoundingClientRect();
      const summary = document
        .querySelector('[aria-labelledby="checkout-summary-title"]')
        .getBoundingClientRect();
      const navigation = document
        .querySelector("[data-akros-cart-navigation]")
        .getBoundingClientRect();
      const checkout = document.querySelector("[data-akros-checkout]");
      const body = document.querySelector("[data-akros-checkout-body]").getBoundingClientRect();
      const root = checkout.getBoundingClientRect();
      const availableWidth = document.documentElement.getBoundingClientRect().width;
      if (Math.abs(root.width - availableWidth) > 1)
        failures.push("Checkout background must span the viewport");
      if (innerWidth === 1920) {
        if (
          Math.abs(body.left - (availableWidth - 1660) / 2) > 1 ||
          Math.abs(body.width - 1660) > 1
        )
          failures.push("Desktop checkout content width/gutter differs from Figma");
        if (Math.abs(cart.width - 1228) > 1)
          failures.push("Desktop cart column width differs from Figma");
      }
      if (Math.abs(body.top - root.top - 40) > 1)
        failures.push("Checkout top padding differs from Figma");
      if (innerWidth < 1536) {
        if (summary.top < cart.bottom - 1 || navigation.top < summary.bottom - 1)
          failures.push("Mobile summary must precede the continue action");
      } else if (navigation.top - cart.bottom > 64)
        failures.push("Sidebar pushes navigation away from cart items");
      return failures;
    });
    assert.deepEqual(failures, [], `Checkout section at ${width}px: ${failures}`);
  }

  await selector.getByText("Komisní košík", { exact: true }).click();
  await page.getByText("Košík je zatím prázdný.", { exact: true }).waitFor();
  await selector.getByText("Výchozí košík", { exact: true }).click();
  await page.locator("table tbody tr").last().waitFor();
  assert.equal(await page.locator("table tbody tr").count(), initialCount);

  await selector.getByRole("button", { name: "Přidat košík", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Přidat košík" });
  await createDialog.getByRole("textbox", { name: "Název košíku" }).fill("Browser test cart");
  await createDialog.getByRole("button", { name: "Přidat košík", exact: true }).click();
  await selector.getByRole("radio", { name: "Browser test cart" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Košík je zatím prázdný.", { exact: true }).waitFor();
  assert.equal(await selector.getByRole("radio", { name: "Browser test cart" }).isChecked(), true);
  await selector.getByRole("button", { name: "Odstranit košík Browser test cart" }).click();
  const removeDialog = page.getByRole("alertdialog", { name: "Odstranit košík?" });
  await removeDialog.getByRole("button", { name: "Odstranit košík", exact: true }).click();
  await page.locator("table tbody tr").last().waitFor();
  assert.equal(await page.locator("table tbody tr").count(), initialCount);

  await page.goto(new URL("/kosik/dodaci-udaje", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Dodací údaje", exact: true }).waitFor();
  const changeButton = page.getByRole("button", { name: "Změnit fakturační údaje", exact: true });
  if (await changeButton.count()) await changeButton.click();
  const addressInput = page.locator("#billing-firstName");
  await addressInput.waitFor();
  const geometry = await addressInput.evaluate((input) => ({
    height: input.getBoundingClientRect().height,
    borderWidth: getComputedStyle(input).borderTopWidth,
    borderColor: getComputedStyle(input).borderTopColor,
    fontSize: getComputedStyle(input).fontSize,
  }));
  assert.equal(geometry.height, 60);
  assert.equal(geometry.borderWidth, "2px");
  assert.equal(geometry.borderColor, "rgb(28, 28, 26)");
  assert.equal(geometry.fontSize, "20px");
  console.log(
    "Checkout section passed 12 widths, named-cart persistence/deletion and Figma input token checks.",
  );
} finally {
  await browser.close();
}
