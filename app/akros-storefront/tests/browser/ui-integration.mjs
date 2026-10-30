// Run against ui-integration-preview.mjs only. This verifies real UI with isolated fixtures,
// not authentication, persistence or order placement against a live OntOS deployment.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { inspectTableLayout } from "./table-layout-checks.mjs";

const base = process.env.AKROS_PREVIEW_URL ?? "http://127.0.0.1:3097";
const out = new URL("../../test-results/ui-integration/browser/", import.meta.url);
await mkdir(out, { recursive: true });
const fixture = await (await fetch(`${base}/fixture-data`)).json();
const { product, large } = fixture;
const variant = product.detail.variants.find(
  (v) => v.stockCount >= v.minimumQuantity && v.priceMinor > 0,
);
const item = {
  productId: product.id,
  variantId: variant.id,
  slug: product.slug,
  name: product.name,
  sku: variant.sku,
  variantLabel: variant.label,
  imageSrc: variant.imageSrc ?? product.imageSrc,
  imageAlt: product.imageAlt,
  unit: variant.unit,
  minimumQuantity: variant.minimumQuantity,
  quantityStep: variant.quantityStep,
  stockCount: variant.stockCount,
  priceMinor: variant.priceMinor,
  quantity: variant.minimumQuantity,
};
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const context = await browser.newContext();
await context.addInitScript(
  ({ product, variant, item }) => {
    localStorage.setItem(
      "akros-demo-favorites-v1",
      JSON.stringify([{ productId: product.id, productSlug: product.slug, variantId: variant.id }]),
    );
    if (!localStorage.getItem("akros-demo-cart-v3"))
      localStorage.setItem("akros-demo-cart-v3", JSON.stringify({ version: 3, lines: [item] }));
  },
  { product, variant, item },
);
const profileWrites = [];
const requests = [];
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  requests.push(path);
  let value = {};
  let status = 200;
  if (path.startsWith("/api/favorites/catalog/")) {
    const p = path.endsWith(large.slug) ? large : product;
    value = {
      product: { ...p, hasVariants: true, priceIsFrom: true },
      variants: p.detail.variants,
    };
  } else if (path === "/api/ontos/account/consent") {
    value = { message: "Testovací stav nedostupného souhlasu." };
    status = 503;
  } else if (path === "/api/ontos/account/profile") {
    profileWrites.push(request.postDataJSON());
    value = { outcome: "PROFILE_SAVED", profile: profileWrites.at(-1) };
  } else if (path === "/api/ontos/orders/reorder")
    value = {
      items: [{ item, quantity: variant.minimumQuantity, priceTiers: variant.priceTiers }],
      skipped: 1,
      adjusted: 0,
    };
  else if (path === "/api/ontos/cart")
    value = {
      cart: request.postDataJSON().cart,
      priceChanged: false,
      issues: [],
      lineIssues: [],
      canCheckout: true,
    };
  else if (path === "/api/address-suggestions")
    value = {
      suggestions: [1, 2].map((n) => ({
        id: `address-${n}`,
        displayLabel: `Bakalovo nábřeží ${n}, Brno`,
        address: {
          street: "Bakalovo nábřeží",
          houseNumber: String(n),
          city: "Brno",
          postalCode: "63900",
          countryCode: "CZ",
        },
      })),
    };
  else {
    status = 404;
    value = { message: "No test handler" };
  }
  await route.fulfill({ status, json: value });
});
const page = await context.newPage();
async function openView(view) {
  await page.goto(`${base}/?view=${view}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.dataset.previewReady === "true");
}
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(120_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && /unique.*key|hydration|Minified React/i.test(message.text()))
    errors.push(message.text());
});
const measurements = [];
const failures = [];
const widths = [320, 360, 390, 640, 760, 761, 768, 1024, 1100, 1101, 1280, 1440, 1920];
const flowsOnly = process.env.AKROS_PREVIEW_FLOWS_ONLY === "1";
try {
  for (const view of flowsOnly
    ? []
    : ["variants", "large", "cards", "profile", "orders", "address", "favorites", "cart"]) {
    await openView(view);
    await page.evaluate(() => document.fonts.ready);
    if (["variants", "large"].includes(view)) await page.locator("tbody tr").first().waitFor();
    if (view === "favorites") await page.getByRole("article").first().waitFor();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        mainWidth: document.querySelector("main")?.getBoundingClientRect().width,
      }));
      const entry = { view, width, ...geometry };
      if (geometry.overflow > 1) failures.push({ ...entry, problem: "page overflow" });
      if (["variants", "large"].includes(view)) {
        const table = page.locator(".akros-variant-data-table__table");
        const result = await table.evaluate(inspectTableLayout);
        entry.rows = await table.locator("tbody tr").count();
        assert.equal(entry.rows, (view === "large" ? large : product).detail.variants.length);
        if (result.horizontalOverflow > 1 || result.failures.length)
          failures.push({ ...entry, problem: "table", ...result });
      }
      measurements.push(entry);
      if ([320, 390, 1024, 1920].includes(width) && view !== "large")
        await page.screenshot({
          caret: "initial",
          path: new URL(`${view}-${width}.png`, out).pathname.replace(/^\/(\w:)/, "$1"),
        });
    }
    console.log(`Checked ${view} at ${widths.length} widths`);
  }
  for (const width of [390, 768, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await openView("variants");
    await page.getByRole("button", { name: /^Vybrat oblíbené varianty/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox").fill(variant.sku);
    await page.waitForTimeout(200);
    assert.equal(await dialog.locator("tbody tr").count(), 1);
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `dialog overflow at ${width}`);
    await page.screenshot({
      caret: "initial",
      path: new URL(`dialog-${width}.png`, out).pathname.replace(/^\/(\w:)/, "$1"),
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page
      .locator("[data-variant-detail-link]")
      .filter({ hasText: variant.label })
      .first()
      .click();
    await page.getByRole("dialog").getByText("Hmotnost", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Zavřít detail varianty" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  await openView("address");
  await page.getByRole("combobox", { name: /Ulice/ }).fill("Bakalovo");
  await page.getByRole("option", { name: "Bakalovo nábřeží 2, Brno" }).click();
  assert.equal(await page.getByRole("textbox", { name: /^Město/ }).inputValue(), "Brno");
  assert.equal(await page.getByRole("textbox", { name: /^PSČ/ }).inputValue(), "63900");
  await openView("profile");
  await page.getByRole("textbox", { name: "Jméno a příjmení" }).fill("Jan Test");
  await page.getByRole("button", { name: /Uložit/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes("uloženy"));
  assert.equal(profileWrites.at(-1).displayName, "Jan Test");
  assert.deepEqual(Object.keys(profileWrites.at(-1)).sort(), [
    "contactEmail",
    "displayName",
    "phone",
    "version",
  ]);
  await openView("orders");
  await page.getByRole("button", { name: "Objednat znovu", exact: true }).first().click();
  await page.getByText(/Přidáno položek: 1/).waitFor();
  assert(requests.includes("/api/ontos/cart"));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
} finally {
  await writeFile(
    new URL(flowsOnly ? "flows.json" : "report.json", out),
    JSON.stringify(
      { isolatedFixtures: true, measurements, failures, errors, profileWrites, requests },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(
  `${measurements.length} responsive layouts plus dialog, address, profile and reorder flows checked.`,
);
