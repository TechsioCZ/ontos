import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const artifactDir = process.env.AKROS_CART_SCREENSHOTS;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  const cart = {
    version: 3,
    lines: [
      {
        ...cartFixture.lines[0],
        priceMinor: 89900,
        priceExcludingVatMinor: 74298,
        minimumQuantity: 1,
        quantity: 1,
      },
    ],
  };
  await page.addInitScript(
    ({ cart, checkout }) => {
      if (!sessionStorage.getItem("typography-seeded")) {
        localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
        localStorage.removeItem("akros-demo-carts-v1");
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
        sessionStorage.setItem("typography-seeded", "1");
      }
    },
    { cart, checkout: checkoutFixture },
  );
  page.setDefaultNavigationTimeout(120000);
  const audit = [];
  async function typography(selector, size, weight, lineHeight) {
    const node = page.locator(selector).first();
    await node.waitFor();
    const actual = await node.evaluate((e) => {
      const s = getComputedStyle(e);
      return {
        text: e.textContent.trim(),
        size: parseFloat(s.fontSize),
        weight: Number(s.fontWeight),
        lineHeight: parseFloat(s.lineHeight),
        family: s.fontFamily,
        transform: s.textTransform,
        color: s.color,
      };
    });
    audit.push({ route: new URL(page.url()).pathname, selector, ...actual });
    assert.equal(actual.size, size, `${selector} font size`);
    assert.equal(actual.weight, weight, `${selector} font weight`);
    if (lineHeight)
      assert.ok(
        Math.abs(actual.lineHeight - lineHeight) < 0.2,
        `${selector} line height ${actual.lineHeight} != ${lineHeight}`,
      );
    return actual;
  }
  const widths = [1920, 1536, 1535, 1280, 768, 390, 320];
  for (const route of [
    "/kosik",
    "/kosik/doprava-platba",
    "/kosik/dodaci-udaje",
    "/kosik/shrnuti",
  ]) {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator("[data-akros-checkout] h1").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await typography("[data-akros-checkout] h1", 31, 500, 37.2);
    await typography("#cart-selector-title", 31, 500, 37.2);
    await typography(".text-steps-title-md", 20, 500, 30);
    await typography(".font-steps-number", 20, 500, 30);
    await typography('[data-akros-cart-selector] [data-part="item-text"]', 25, 700, 30);
    if (route !== "/kosik/shrnuti") await typography("#checkout-summary-title", 31, 500, 37.2);
    if (route !== "/kosik/shrnuti") {
      await typography("#checkout-recommendations", 39, 800, 46.8);
      await typography(".akros-product-card__description", 16, 500, 24);
      await typography(".akros-catalog-product-card__name", 20, 500, 24);
      await typography(".text-product-card-price-size", 20, 800, 24);
      await typography(".akros-catalog-product-card__stock", 16, 500, 24);
    }
    if (route === "/kosik") {
      await typography("[data-akros-cart-navigation] a", 20, 700, 24);
      await typography("[data-akros-cart-items] td a", 20, 500, 30);
      await typography("[data-akros-cart-items] td strong", 20, 800, 30);
      await typography("[data-akros-cart-items] input[role=spinbutton]", 25, 700, 30);
      await typography("[data-akros-free-shipping-text]", 20, 500, 30);
      await typography("[data-akros-return-title]", 20, 500, 30);
      await typography("#checkout-extended-return-description", 16, 500, 24);
      await typography("[data-akros-return-price]", 20, 500, 30);
      const client = await page.context().newCDPSession(page);
      await client.send("DOM.enable");
      await client.send("CSS.enable");
      const { root } = await client.send("DOM.getDocument");
      const { nodeId } = await client.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "[data-akros-free-shipping-text]",
      });
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.some((f) => f.isCustomFont && f.familyName === "Inter Variable"));
      await client.detach();
      const geometry = await page.locator("[data-akros-cart-services]").evaluate((e) => {
        const icons = [
          ...e.querySelectorAll('[data-slot="icon"], [class*="token-icon-akros-checkout"]'),
        ].map((i) => ({
          width: i.getBoundingClientRect().width,
          height: i.getBoundingClientRect().height,
          mask: getComputedStyle(i).maskImage,
        }));
        const progress = e.querySelector("progress");
        const control = e.querySelector('[data-part="control"]');
        return {
          icons,
          progressWidth: progress.getBoundingClientRect().width,
          progressHeight: progress.getBoundingClientRect().height,
          checkboxSize: control.getBoundingClientRect().width,
          checkboxBorder: getComputedStyle(control).borderTopWidth,
        };
      });
      assert.equal(geometry.progressWidth, 429);
      assert.ok(Math.abs(geometry.progressHeight - 6) < 0.2);
      assert.equal(geometry.checkboxSize, 24);
      assert.equal(geometry.checkboxBorder, "2px");
      for (const size of [54, 48])
        assert.ok(
          geometry.icons.some(
            (i) =>
              Math.abs(i.width - size) < 0.2 &&
              Math.abs(i.height - size) < 0.2 &&
              i.mask !== "none",
          ),
          `Original ${size}px icon missing`,
        );
    }
    if (route === "/kosik/doprava-platba") {
      await typography('[data-akros-checkout] form button[type="submit"]', 20, 700);
      await typography("#payment-title", 30, 500, 36);
      await typography('[aria-labelledby="delivery-title"] [data-part="item-text"]', 20, 500, 30);
      await typography(
        '[aria-labelledby="delivery-title"] .text-radio-group-item-description',
        16,
        500,
        24,
      );
    }
    if (route === "/kosik/dodaci-udaje") {
      await typography('[data-akros-checkout] form button[type="submit"]', 20, 700);
      await typography("[data-akros-checkout-address] h2", 25, 700, 30);
      await page.getByRole("button", { name: "Změnit fakturační údaje", exact: true }).click();
      await typography('label[for="billing-firstName"]', 20, 500, 30);
      await typography("#billing-firstName", 20, 500, 30);
      await typography("[data-akros-checkout-address] .text-select-value-sm", 20, 500, 30);
      await typography(
        '[data-akros-checkout-address] input[autocomplete="billing tel"]',
        20,
        500,
        30,
      );
    }
    if (route === "/kosik/shrnuti") {
      await typography('[data-akros-checkout] form button[type="submit"]', 20, 700);
      await typography("[data-akros-checkout-review] th", 16, 500, 24);
      await typography("[data-akros-checkout-review] dl dt", 16, 500, 24);
      await typography("#billing-review-title", 31, 500, 37.2);
      await typography("[data-akros-checkout-review] address", 16, 500, 24);
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const overflow = await page
        .locator("[data-akros-checkout]")
        .evaluate((e) => e.scrollWidth - e.clientWidth);
      assert.equal(overflow, 0, `${route} overflow at ${width}px`);
      if (artifactDir && [1920, 1280, 390].includes(width)) {
        await mkdir(artifactDir, { recursive: true });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: join(artifactDir, `${route.split("/").filter(Boolean).join("-")}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
  await page.goto(new URL("/kosik", baseUrl).href, { waitUntil: "domcontentloaded" });
  const services = page.locator("[data-akros-cart-services]");
  await page.locator("[data-akros-return-title]").waitFor();
  assert.match(await page.locator("[data-akros-free-shipping-text]").innerText(), /1 101 Kč/);
  const getTotal = () =>
    page.evaluate(
      () => JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1")).draft.extendedReturn,
    );
  await services.getByText("Prodloužená doba vrácení", { exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1")).draft.extendedReturn === true,
  );
  assert.equal(await getTotal(), true);
  assert.match(
    await page.locator('[aria-labelledby="checkout-summary-title"]').innerText(),
    /1 137 Kč/,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await services.getByRole("checkbox").waitFor({ state: "attached" });
  assert.equal(await services.getByRole("checkbox").isChecked(), true);
  const quantity = page.locator("[data-akros-cart-items]").getByRole("spinbutton").first();
  await quantity.fill("3");
  await quantity.press("Enter");
  await page.getByText("Dopravu máte zdarma", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("progressbar", { name: "Doprava zdarma" }).evaluate((e) => e.value),
    200000,
  );
  await page.goto(new URL("/kosik/shrnuti", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.locator("#review-title").waitFor();
  assert.match(
    await page.locator("[data-akros-checkout-review] dl").innerText(),
    /Prodloužená doba vrácení/,
  );
  await page.getByRole("button", { name: "Objednat s povinností platby", exact: true }).click();
  await page.waitForURL("**/potvrzeni-objednavky");
  const order = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("akros-demo-order-v1")),
  );
  assert.equal(order.draft.extendedReturn, true);
  assert.equal(order.totals.extendedReturn, 15900);
  assert.equal(order.totals.shipping, 0);
  assert.equal(order.totals.total, 285600);
  if (artifactDir)
    await writeFile(
      join(artifactDir, "typography-values.json"),
      JSON.stringify(audit, null, 2),
      "utf8",
    );
  console.log(
    `Checkout typography passed ${audit.length} style checks and ${widths.length * 4} layout checks; services, reload, shipping threshold and order snapshot passed.`,
  );
} finally {
  await browser.close();
}
