import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const artifacts = process.env.AKROS_FONT_SCREENSHOTS;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const results = { pages: [], samples: [], failures: [] };

try {
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext();
  await context.addInitScript(
    ({ cart, checkout }) => {
      if (!sessionStorage.getItem("global-font-seeded")) {
        localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
        sessionStorage.setItem("global-font-seeded", "1");
      }
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  async function inspectFont(locator, label) {
    await locator.waitFor({ state: "visible" });
    const styles = await locator.evaluate((element) => {
      element.setAttribute("data-akros-font-probe", "");
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim().slice(0, 90),
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
        opticalSizing: style.fontOpticalSizing,
        rect: element.getBoundingClientRect().toJSON(),
      };
    });
    try {
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "[data-akros-font-probe]",
      });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const rendered = fonts.filter((font) => font.glyphCount > 0);
      results.samples.push({ label, ...styles, fonts: rendered });
      if (
        !rendered.length ||
        !rendered.every((font) => font.isCustomFont && font.familyName.startsWith("Inter"))
      )
        results.failures.push(
          `${label}: expected actual Inter, got ${rendered.map((font) => font.familyName).join(", ")}`,
        );
    } finally {
      await locator.evaluate((element) => element.removeAttribute("data-akros-font-probe"));
    }
  }

  for (const [name, route] of [
    ["home", "/"],
    ["account", "/muj-ucet"],
    ["cart", "/kosik"],
    ["login", "/prihlaseni"],
    ["registration", "/registrace"],
    ["faq", "/faq"],
    ["contacts", "/kontakty"],
    ["blog", "/blog"],
    ["shipping", "/doprava-a-platba"],
    ["product", "/produkt/vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2"],
    ["not-found", "/__typography-missing-page__"],
  ]) {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const response = await page.goto(new URL(route, baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response.status(), name === "not-found" ? 404 : 200, route);
    if (name === "account") await page.locator("#account-firstName").waitFor();
    if (name === "cart") await page.locator("[data-akros-cart-items] tbody tr").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const sample = page
        .locator(
          "main h1:not(.sr-only), main h2:not(.sr-only), [data-akros-checkout] h1:not(.sr-only), .akros-catalog-product-card__name",
        )
        .filter({ visible: true })
        .first();
      await inspectFont(sample, `${name}-${width}-content`);
      if (name === "not-found") {
        const number = page.locator(".akros-not-found__code > span").first();
        await inspectFont(number, `not-found-${width}-black`);
        assert.equal(
          await number.evaluate((element) => getComputedStyle(element).fontWeight),
          "900",
        );
      }
      if (width === 1920)
        await inspectFont(page.locator(".akros-header__utility-links a").first(), `${name}-header`);
      const metrics = await page.evaluate(() => ({
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        font: getComputedStyle(document.documentElement).getPropertyValue("--font-akros").trim(),
      }));
      results.pages.push({ name, width, ...metrics });
      if (metrics.overflow)
        results.failures.push(`${name}-${width}: horizontal overflow ${metrics.overflow}`);
      if (!metrics.font) results.failures.push(`${name}-${width}: root font variable is missing`);
      if (artifacts)
        await page.screenshot({
          path: join(artifacts, `${name}-${width}.png`),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
    }
    if (name === "account") {
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.locator('[id="select:account-country:trigger"]').click();
      const popup = page.locator('[id="select:account-country:content"]');
      await inspectFont(
        popup.getByText("Česká republika", { exact: true }),
        "account-country-portal",
      );
      if (artifacts) await page.screenshot({ path: join(artifacts, "account-country-portal.png") });
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
      const phoneTrigger = page
        .locator('[data-account-phone-control] [data-part="trigger"]')
        .first();
      await phoneTrigger.click();
      const phonePopupId = await phoneTrigger.getAttribute("aria-controls");
      assert.ok(phonePopupId);
      const phonePopup = page.locator(`[id="${phonePopupId}"]`);
      await inspectFont(
        phonePopup.getByText("Česká republika", { exact: true }),
        "account-phone-portal",
      );
      if (artifacts) await page.screenshot({ path: join(artifacts, "account-phone-portal.png") });
      await page.keyboard.press("Escape");
      await phonePopup.waitFor({ state: "hidden" });
    }
    if (name === "cart") {
      await page.getByRole("button", { name: "Přidat košík", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await inspectFont(
        dialog.getByRole("button").filter({ hasText: "Přidat" }).first(),
        "cart-dialog-portal",
      );
      if (artifacts) await page.screenshot({ path: join(artifacts, "cart-dialog-portal.png") });
      await page.keyboard.press("Escape");
    }
    console.log(`Global typography: ${name}, desktop and mobile inspected.`);
  }
  await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.evaluate(() => document.fonts.ready);
  const search = page.getByRole("combobox");
  await search.fill("vruty");
  await page.waitForFunction(
    () => document.querySelector('input[name="q"][type="hidden"]')?.value === "vruty",
  );
  await inspectFont(
    page.locator("[data-akros-search-result-label]").first(),
    "mobile-search-result",
  );
  if (artifacts) await page.screenshot({ path: join(artifacts, "mobile-search.png") });
  assert.deepEqual(results.failures, []);
  console.log(
    `Actual Inter passed ${results.samples.length} text samples across ${results.pages.length} layouts and opened popup/dialog/search states.`,
  );
} finally {
  if (artifacts)
    await writeFile(join(artifacts, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await browser.close();
}
