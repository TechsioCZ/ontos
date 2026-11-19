import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000/cs";
const key = "akros-demo-favorites-v1";
const catalog = JSON.parse(
  await readFile(
    new URL("../../src/catalog-import/generated/catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const product = catalog.products.find(
  (item) => item.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const largest = [...catalog.products].sort(
  (a, b) => b.detail.variants.length - a.detail.variants.length,
)[0];
const standalone = catalog.products.find(
  (item) => item.detail.variants.length === 0 && item.priceMinor > 0,
);
const [a, b] = product.detail.variants;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = () =>
    page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "[]"), key);
  async function open(item = product) {
    await page.goto(`${base}/produkt/${item.slug}`, { waitUntil: "domcontentloaded" });
    await page.locator(".sf-product-detail__favorite").click();
    const dialog = page.getByRole("dialog", { name: "Oblíbené varianty" });
    try {
      await dialog.locator("tbody tr").first().waitFor();
    } catch (error) {
      console.log({ dialog: await dialog.textContent().catch(() => "No dialog"), errors });
      throw error;
    }
    return dialog;
  }
  let dialog = await open();
  assert.equal(await dialog.locator("tbody tr").count(), product.detail.variants.length);
  assert.equal(
    await dialog
      .locator('tbody input[type="checkbox"]')
      .evaluateAll((inputs) => inputs.every((input) => !input.disabled)),
    true,
    "all variants, including out-of-stock ones, can be saved",
  );
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Oblíbené varianty");
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).check();
  assert.deepEqual(await read(), [], "draft must not write before save");
  const search = dialog.getByLabel("Hledat variantu");
  await search.fill(b.sku);
  await dialog.getByText(/^Vybrat všechny výsledky \(/).click();
  assert.equal(
    await dialog.getByRole("checkbox", { name: /Vybrat všechny výsledky/ }).isChecked(),
    true,
  );
  await dialog.getByText("Vybráno 2, z toho 1 mimo filtr", { exact: true }).waitFor();
  await dialog.getByText(/^Vybrat všechny výsledky \(/).click();
  await dialog.getByText("Vybráno 1, z toho 1 mimo filtr", { exact: true }).waitFor();
  await dialog.getByText(/^Vybrat všechny výsledky \(/).click();
  await search.fill("this-query-has-no-variant");
  await dialog.getByText("Žádná varianta neodpovídá hledání.").waitFor();
  assert.equal(
    await dialog.getByRole("checkbox", { name: /Vybrat všechny výsledky/ }).isDisabled(),
    true,
  );
  await search.fill(b.sku);
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  await page.waitForFunction(() => !document.querySelector(".sf-favorites-dialog"));
  assert.deepEqual(
    (await read()).map((item) => item.variantId).sort((left, right) => left.localeCompare(right)),
    [a.id, b.id].sort((left, right) => left.localeCompare(right)),
  );
  await page.waitForFunction(() => document.activeElement?.matches(".sf-product-detail__favorite"));
  console.log("Favorites: draft, filtered bulk selection, persistence and return focus passed.");

  dialog = await open();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true })
      .isChecked(),
    true,
  );
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).uncheck();
  await page.keyboard.press("Escape");
  assert.equal((await read()).length, 2, "Escape discards draft");
  await page.goto(`${base}/oblibene`);
  await page.locator("[data-account-products] article").first().waitFor();
  assert.equal(await page.locator("[data-account-products] article").count(), 2);
  assert.match(await page.locator("[data-account-products]").innerText(), new RegExp(a.sku));
  await page.locator("[data-account-products] .sf-product-card__favorite").first().click();
  assert.equal((await read()).length, 1);
  await page.locator("[data-account-products] .sf-product-card__favorite").click();
  await page.locator("[data-favorites-empty]").waitFor();
  assert.deepEqual(await read(), []);

  dialog = await open();
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).check();
  await page.evaluate(() => {
    window.originalStorageDescriptor = Object.getOwnPropertyDescriptor(
      Storage.prototype,
      "setItem",
    );
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === "akros-demo-favorites-v1")
        throw new DOMException("Blocked", "QuotaExceededError");
      return window.originalStorageDescriptor.value.call(this, storageKey, value);
    };
  });
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.deepEqual(await read(), []);
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, "setItem", window.originalStorageDescriptor);
  });
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  await page.waitForFunction(() => !document.querySelector(".sf-favorites-dialog"));

  await page.goto(`${base}/produkt/${standalone.slug}`);
  await page.locator(".sf-product-detail__favorite").click();
  assert.equal(
    (await read()).some((item) => item.productId === standalone.id && item.variantId === null),
    true,
  );
  dialog = await open();
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  assert.deepEqual(
    (await read()).map((item) => item.productId),
    [standalone.id],
  );
  console.log(
    "Favorites: reload, cancellation, real list, removal, storage error and independent product states passed.",
  );

  const endpoint = `**/api/ontos/product-variants/${product.slug}`;
  await page.route(endpoint, (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto(`${base}/produkt/${product.slug}`);
  await page.locator(".sf-product-detail__favorite").click();
  dialog = page.getByRole("dialog", { name: "Oblíbené varianty" });
  await dialog.getByRole("alert").waitFor();
  await page.unroute(endpoint);
  await dialog.getByRole("button", { name: "Zkusit znovu" }).click();
  await dialog.locator("tbody tr").first().waitFor();
  await page.keyboard.press("Escape");

  for (const item of [product, largest]) {
    dialog = await open(item);
    assert.equal(await dialog.locator("tbody tr").count(), item.detail.variants.length);
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((root) => root.contains(document.activeElement)), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate((root) => root.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
  }
  console.log(
    `Favorites: keyboard and full ${largest.detail.variants.length}-variant group passed.`,
  );

  await page.goto(base);
  await page.locator(".sf-product-card__favorite").first().click();
  await page
    .getByRole("dialog", { name: "Oblíbené varianty" })
    .locator("tbody tr")
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  const unavailable = await page.request.get(
    `${new URL(base).origin}/api/ontos/product-variants/this-product-does-not-exist`,
  );
  assert.equal(unavailable.status(), 404);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${base}/produkt/${product.slug}?variant=${a.sku}`);
  const sharedUrl = `${base}/produkt/${product.slug}?${new URLSearchParams({ variantIds: [a.id, b.id].join(",") })}#product-variants`;
  async function shareSelection() {
    await page.getByRole("button", { name: "Sdílet", exact: true }).click();
    const selectionDialog = page.getByRole("dialog", { name: "Sdílet varianty" });
    for (const item of [a, b])
      await selectionDialog
        .getByRole("checkbox", { name: `Vybrat variantu ${item.sku}`, exact: true })
        .check();
    await selectionDialog.getByRole("button", { name: "Sdílet výběr" }).click();
    await selectionDialog.waitFor({ state: "hidden" });
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        window.sharedData = data;
      },
    });
  });
  await shareSelection();
  assert.equal((await page.evaluate(() => window.sharedData)).url, sharedUrl);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Cancelled", "AbortError");
      },
    });
  });
  await shareSelection();
  assert.equal(await page.getByRole("button", { name: "Kopírovat odkaz" }).count(), 0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await shareSelection();
  await page.getByRole("button", { name: "Kopírovat odkaz" }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.getByRole("button", { name: "Kopírovat odkaz" }).click();
  await page.getByRole("textbox", { name: "Odkaz ke zkopírování" }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedText = text;
        },
      },
    });
  });
  await page.getByRole("button", { name: "Kopírovat odkaz" }).click();
  assert.equal(await page.evaluate(() => window.copiedText), sharedUrl);
  await page.getByRole("button", { name: "Zavřít", exact: true }).click();
  await page.evaluate(() => {
    window.print = () => {
      window.printInvoked = true;
    };
  });
  await page.getByRole("button", { name: "Tisk", exact: true }).click();
  assert.equal(await page.evaluate(() => window.printInvoked), true);
  assert.equal(await page.locator(".sf-print-sheet").isVisible(), false);
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".sf-print-sheet").isVisible(), true);
  for (const selector of [".sf-header", ".sf-sidebar", ".sf-footer", ".sf-product-detail"])
    assert.equal(await page.locator(selector).isVisible(), false);
  assert.equal(await page.locator(".sf-print-sheet tbody").count(), 0);
  await page.waitForFunction(() => {
    const image = document.querySelector(".sf-print-sheet img");
    return image.complete && image.naturalWidth > 0;
  });
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log(
    "Share: native, cancel, copy/manual fallback passed. Print action and screen/print visibility passed.",
  );
} finally {
  await browser.close();
}
