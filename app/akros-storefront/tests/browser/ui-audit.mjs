import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const widths = [
  2560, 1920, 1441, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 431, 430, 390, 360,
  320,
];
const routes = [
  "/",
  "/kategorie/srouby",
  "/kategorie/matice",
  "/vyhledavani?q=matice",
  "/produkt/vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
  "/produkt/hacek-na-popruh-48mm-an-8541-a2",
  "/kosik",
  "/kosik/doprava-platba",
  "/kosik/dodaci-udaje",
  "/kosik/shrnuti",
  "/potvrzeni-objednavky",
  "/muj-ucet",
  "/muj-ucet/prehled",
  "/historie-objednavek",
  "/detail-objednavky",
  "/oblibene",
  "/sledovani-zasilky",
  "/muj-ucet/reklamace",
  "/prihlaseni",
  "/registrace",
  "/faq",
  "/blog",
  "/novinky-a-akce",
  "/kontakty",
  "/doprava-a-platba",
  "/o-nas",
  "/partnersky-program",
  "/reklamace",
  "/gdpr",
  "/obchodni-podminky",
  "/ui-audit-missing-page",
];
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(120000);
  await page.addInitScript(
    ({ cart, checkout }) => {
      localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
      localStorage.removeItem("akros-demo-carts-v1");
      sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
    },
    { cart: cartFixture, checkout: checkoutFixture },
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async (route) => {
    const response = await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), route === "/ui-audit-missing-page" ? 404 : 200, route);
    await page.locator("main h1, main h2").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  let layouts = 0;
  for (const route of routes) {
    await visit(route);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector("main");
        return {
          viewportOverflow: root.scrollWidth - innerWidth,
          mainOverflow: main.scrollWidth - main.clientWidth,
          font: getComputedStyle(main).fontFamily,
        };
      });
      assert.ok(
        result.viewportOverflow <= 1,
        `${route} at ${width}px: document overflows by ${result.viewportOverflow}px`,
      );
      assert.ok(
        result.mainOverflow <= 1,
        `${route} at ${width}px: main overflows by ${result.mainOverflow}px`,
      );
      assert.match(result.font, /inter/i, `${route}: local app font must reach the content`);
      layouts++;
    }
  }

  await page.setViewportSize({ width: 1920, height: 1000 });
  await visit("/");
  const favorite = page.locator(".akros-product-card__favorite").first();
  await favorite.waitFor();
  const previous = await favorite.getAttribute("style");
  try {
    await favorite.evaluate((element) => {
      element.style.setProperty("--height-form-control-sm", "48px");
      element.style.setProperty("--padding-button-sm", "4px");
      element.style.setProperty("--radius-button-sm", "6px");
    });
    assert.deepEqual(
      await favorite.evaluate((element) => {
        const s = getComputedStyle(element);
        return [s.height, s.paddingTop, s.borderRadius];
      }),
      ["48px", "4px", "6px"],
    );
  } finally {
    await favorite.evaluate((element, value) => {
      if (value === null) element.removeAttribute("style");
      else element.setAttribute("style", value);
    }, previous);
  }

  // Verify purchase validation around the documented disabled-input synchronization gap.
  const radioAudit = [];
  for (const width of [1920, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit("/kosik/doprava-platba");
    const item = (value) =>
      page.locator('[data-scope="radio-group"][data-part="item"]').filter({
        has: page.locator(`input[value="${value}"]`),
      });
    const pickup = item("osobni");
    const storeCard = item("store-card");
    const dpd = item("dpd");
    await pickup.click();
    await page.waitForFunction(() => !document.querySelector('input[value="store-card"]').disabled);
    await storeCard.click();
    await page.waitForFunction(
      () =>
        JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1")).draft.paymentId ===
        "store-card",
    );
    await dpd.click();
    await page.waitForFunction(
      () => JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1")).draft.paymentId === "",
    );
    const native = storeCard.locator("input");
    assert.equal(await native.isDisabled(), true);
    assert.equal(await storeCard.getAttribute("data-state"), "unchecked");
    assert.equal(
      await storeCard.locator('[data-part="item-control"]').getAttribute("data-state"),
      "unchecked",
    );
    radioAudit.push({ width, disabledNativeChecked: await native.isChecked() });
    const next = page.getByRole("button", { name: "Dodací údaje", exact: true });
    await next.click();
    await page.getByText("Vyberte dostupný způsob platby.", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/kosik/doprava-platba");
    await item("gopay").click();
    await next.click();
    await page.waitForURL("**/kosik/dodaci-udaje");
  }
  assert.deepEqual(errors, [], "Uncaught errors in the UI-kit regression audit");
  await mkdir(new URL("../../test-results/ui-audit/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../../test-results/ui-audit/report.json", import.meta.url),
    JSON.stringify({ layouts, widths, routes, radioAudit }, null, 2),
  );
  console.log(
    `UI audit passed ${layouts} layouts on ${routes.length} routes, favorite control tokens and payment-change validation at three widths.`,
  );
  if (radioAudit.some((state) => state.disabledNativeChecked))
    console.log(
      "Known UI-kit 0.56.1 limitation reproduced: disabled native radio stays checked; visible state and checkout draft clear, and validation blocks progression.",
    );
} finally {
  await browser.close();
}
