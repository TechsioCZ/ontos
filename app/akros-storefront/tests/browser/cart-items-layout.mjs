import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";
import { inspectTableLayout } from "./table-layout-checks.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browserPath = process.env.AKROS_CHROMIUM_PATH;
const screenshotDir = process.env.AKROS_CART_SCREENSHOTS;
const widths = [
  1920, 1440, 1366, 1336, 1280, 1279, 1024, 977, 976, 975, 913, 912, 911, 801, 800, 799, 768, 767,
  640, 480, 390, 360, 320,
];
const browser = await chromium.launch(
  browserPath ? { executablePath: browserPath } : { channel: "chrome" },
);

try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  await context.addInitScript(
    ({ cart, checkout }) => {
      localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
      localStorage.removeItem("akros-demo-carts-v1");
      sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  let checks = 0;

  for (const route of ["/kosik", "/kosik/shrnuti"]) {
    await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded" });
    const table = page.getByRole("table", { name: "Položky objednávky" });
    await table.locator("tbody tr").last().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      new URL(page.url()).pathname,
      route,
      "Checkout fixture must reach the requested step",
    );
    assert.equal(await table.locator("tbody tr").count(), cartFixture.lines.length);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(350);
      const result = await table.evaluate(inspectTableLayout);
      assert.equal(result.horizontalOverflow, 0, `${route} at ${width}px: table overflow`);
      assert.deepEqual(
        result.failures,
        [],
        `${route} at ${width}px: ${JSON.stringify(result.failures)}`,
      );

      const controlFailures = await table.evaluate((element) => {
        const failures = [];
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        for (const input of element.querySelectorAll('input:not([type="hidden"])')) {
          const style = getComputedStyle(input);
          ctx.font = style.font;
          const available =
            input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          if (ctx.measureText(input.value).width > available + 1)
            failures.push(`Clipped quantity: ${input.value}`);
        }
        for (const button of element.querySelectorAll("button")) {
          const rect = button.getBoundingClientRect();
          // Triggers sit inside the existing 44px control's borders (40px inner height).
          if (rect.width < 43 || rect.height < 39) failures.push("Quantity/action target shrank");
        }
        // The existing carrier logos in the footer overflow at ~800px, including on an
        // empty cart. Check the entire checkout here without masking that separate bug.
        const checkout = element.closest("[data-akros-checkout]");
        if (checkout.scrollWidth > checkout.clientWidth)
          failures.push("Checkout horizontal overflow");
        const headBounds = element.querySelector("thead")?.getBoundingClientRect();
        if (
          getComputedStyle(element).display !== "block" &&
          headBounds?.height > 1 &&
          headBounds?.width > 1
        ) {
          const headers = [...element.querySelectorAll("thead th")];
          for (const row of element.querySelectorAll("tbody tr")) {
            for (const [index, cell] of [...row.cells].entries()) {
              const header = headers[index]?.getBoundingClientRect();
              const rect = cell.getBoundingClientRect();
              if (
                header &&
                header.width > 1 &&
                header.height > 1 &&
                (Math.abs(header.left - rect.left) > 1 || Math.abs(header.width - rect.width) > 1)
              ) {
                failures.push(`Header misaligned in column ${index}`);
              }
            }
          }
        }
        return failures;
      });
      assert.deepEqual(
        controlFailures,
        [],
        `${route} at ${width}px: ${controlFailures.join(", ")}`,
      );
      checks++;

      if (screenshotDir && [1920, 1280, 768, 390].includes(width)) {
        await mkdir(screenshotDir, { recursive: true });
        await table.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            screenshotDir,
            `${route.endsWith("shrnuti") ? "review" : "cart"}-${width}.png`,
          ),
          fullPage: true,
        });
      }
    }

    // Exercise the controls in the narrowest layout after the geometry checks.
    const quantity = table.getByRole("spinbutton").first();
    await quantity.fill("60");
    await quantity.press("Enter");
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("akros-demo-cart-v3")).lines[0].quantity === 60,
    );
    assert.match(await table.locator("tbody tr").first().locator("strong").innerText(), /58,20/);
    await table
      .getByRole("button", { name: `Snížit množství: ${cartFixture.lines[0].variantLabel}` })
      .click();
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("akros-demo-cart-v3")).lines[0].quantity === 40,
    );
    await table.getByRole("button", { name: `Odebrat ${cartFixture.lines[0].name}` }).click();
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("akros-demo-cart-v3")).lines.length === 2,
    );
    assert.equal(await table.locator("tbody tr").count(), 2);
  }
  console.log(
    `Cart and review layout passed ${checks} checks across ${widths.length} widths (320–1920px).`,
  );
} finally {
  await browser.close();
}
