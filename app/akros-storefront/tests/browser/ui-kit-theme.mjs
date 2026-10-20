import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);

try {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ cart, checkout }) => {
      localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
      localStorage.removeItem("akros-demo-carts-v1");
      sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  const style = (locator, property) =>
    locator.evaluate((element, name) => getComputedStyle(element)[name], property);

  // Probe actual token consumption: fixed appearance utilities must not win over the kit token.
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

  await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
  const carousel = page.locator("[data-akros-home-carousel]");
  const dot = carousel.locator('[data-part="indicator"] span').first();
  const previous = carousel.locator('[data-part="prev-trigger"]');
  for (const [width, size] of [
    [1920, "16px"],
    [390, "8px"],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await style(dot, "width"), size);
    assert.equal(await style(dot, "height"), size);
    await probe(
      carousel,
      { "--size-carousel-indicator-dot": "12px", "--text-icon-control-lg": "30px" },
      async () => {
        assert.equal(await style(dot, "width"), "12px");
        assert.equal(await style(previous, "fontSize"), "30px");
      },
    );
  }

  await page.setViewportSize({ width: 1920, height: 1000 });
  const cardActions = page.locator("[data-akros-product-actions]").first();
  const cardAction = cardActions.locator("a, button").first();
  assert.equal(await style(cardAction, "fontWeight"), "700");
  await probe(cardActions, { "--font-weight-button": "600" }, async () => {
    assert.equal(await style(cardAction, "fontWeight"), "600");
  });
  const card = page.locator(".akros-product-card").first();
  assert.match(await style(card, "boxShadow"), /0px 2px 6px/);
  const favorite = card.locator(".akros-product-card__favorite");
  await probe(
    favorite,
    { "--color-button-fg-secondary-borderless": "rgb(12, 34, 56)" },
    async () => {
      assert.equal(await style(favorite, "color"), "rgb(12, 34, 56)");
    },
  );
  const stockRow = page
    .locator(".akros-product-card__stock-row")
    .filter({ has: page.locator("span") })
    .first();
  const variantBadge = stockRow.locator("span");
  await probe(
    stockRow,
    {
      "--color-badge-bg-secondary": "rgb(12, 34, 56)",
      "--color-badge-border-secondary": "rgb(23, 45, 67)",
      "--color-badge-fg-secondary": "rgb(234, 245, 250)",
    },
    async () => {
      assert.equal(await style(variantBadge, "backgroundColor"), "rgb(12, 34, 56)");
      assert.equal(await style(variantBadge, "borderColor"), "rgb(23, 45, 67)");
      assert.equal(await style(variantBadge, "color"), "rgb(234, 245, 250)");
    },
  );

  const trigger = page.locator(".akros-header__cart-trigger");
  const personalNavigation = page.locator(".akros-header__personal-navigation");
  await probe(
    personalNavigation,
    {
      "--height-form-control-md": "52px",
      "--padding-button-md": "6px",
      "--radius-button-md": "3px",
      "--text-button-md": "18px",
    },
    async () => {
      for (const control of await personalNavigation.locator("a").all()) {
        assert.equal(await style(control, "height"), "52px");
        assert.equal(await style(control, "padding"), "6px");
        assert.equal(await style(control, "borderRadius"), "3px");
        assert.equal(await style(control, "fontSize"), "18px");
      }
      assert.equal(await style(trigger, "height"), "64px");
    },
  );
  const cartCount = trigger.locator('[aria-live="polite"]');
  assert.equal(await cartCount.textContent(), "3");
  await probe(
    cartCount,
    {
      "--border-width-badge": "2px",
      "--color-badge-bg-secondary": "rgb(12, 34, 56)",
      "--color-badge-fg-secondary": "rgb(234, 245, 250)",
      "--font-weight-badge-sm": "600",
      "--padding-badge-sm": "0px 6px",
      "--radius-badge": "3px",
      "--text-badge-sm": "12px",
    },
    async () => {
      assert.equal(await style(cartCount, "borderWidth"), "2px");
      assert.equal(await style(cartCount, "backgroundColor"), "rgb(12, 34, 56)");
      assert.equal(await style(cartCount, "color"), "rgb(234, 245, 250)");
      assert.equal(await style(cartCount, "fontWeight"), "600");
      assert.equal(await style(cartCount, "padding"), "0px 6px");
      assert.equal(await style(cartCount, "borderRadius"), "3px");
      assert.equal(await style(cartCount, "fontSize"), "12px");
    },
  );
  await probe(trigger, { "--color-button-bg-primary-base": "rgb(12, 34, 56)" }, async () => {
    assert.equal(await style(trigger, "backgroundColor"), "rgb(12, 34, 56)");
  });
  await trigger.hover();
  const preview = page.locator("[data-akros-mini-cart]");
  await preview.waitFor({ state: "visible" });
  await probe(
    preview,
    {
      "--color-popover-bg": "rgb(12, 34, 56)",
      "--padding-popover-md": "10px",
    },
    async () => {
      assert.equal(await style(preview, "backgroundColor"), "rgb(12, 34, 56)");
      assert.equal(await style(preview, "paddingTop"), "10px");
    },
  );
  await page.keyboard.press("Escape");

  await page.goto(new URL("/kosik/doprava-platba", baseUrl).href, { waitUntil: "networkidle" });
  const action = page.locator("[data-akros-checkout-action]").first();
  await action.waitFor({ state: "visible" });
  assert.equal(await style(action, "fontWeight"), "700");
  assert.equal(await style(action, "lineHeight"), "24px");
  await probe(action, { "--font-weight-button": "600" }, async () => {
    assert.equal(await style(action, "fontWeight"), "600");
  });

  await page.goto(new URL("/kosik", baseUrl).href, { waitUntil: "networkidle" });
  const quantity = page.locator("[data-akros-cart-quantity]").first();
  const input = quantity.locator("input");
  await input.waitFor({ state: "visible" });
  assert.equal(await style(input, "fontWeight"), "700");
  const inputBackground = await style(input, "backgroundColor");
  for (const state of ["hover", "focus"]) {
    if (state === "hover") await input.hover();
    else await input.focus();
    assert.match(await style(quantity, "backgroundColor"), /(?:,\s*0|\/\s*0)\)$/);
    assert.equal(await style(input, "backgroundColor"), inputBackground);
  }
  await probe(
    input,
    { "--font-weight-input": "600", "--color-numeric-input-input-bg-focus": "rgb(12, 34, 56)" },
    async () => {
      assert.equal(await style(input, "fontWeight"), "600");
      assert.equal(await style(input, "backgroundColor"), "rgb(12, 34, 56)");
    },
  );

  console.log(
    "UI-kit theme checks passed: carousel, product cards, header, mini-cart and checkout tokens.",
  );
} finally {
  await browser.close();
}
