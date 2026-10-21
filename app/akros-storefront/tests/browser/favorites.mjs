import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const key = "akros-demo-favorites-v1";
const catalog = JSON.parse(
  await readFile(
    new URL("../../src/mock-storefront/generated/catalog.generated.json", import.meta.url),
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
const output = "test-results/favorites";
await mkdir(output, { recursive: true });
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
    await page.locator(".akros-product-detail__favorite").click();
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
  await page.waitForFunction(() => !document.querySelector(".akros-favorites-dialog"));
  assert.deepEqual((await read()).map((item) => item.variantId).sort(), [a.id, b.id].sort());
  await page.waitForFunction(() =>
    document.activeElement?.matches(".akros-product-detail__favorite"),
  );
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
  await page.locator("[data-account-products] .akros-product-card__favorite").first().click();
  assert.equal((await read()).length, 1);
  await page.locator("[data-account-products] .akros-product-card__favorite").click();
  await page.locator("[data-favorites-empty]").waitFor();
  assert.deepEqual(await read(), []);

  dialog = await open();
  await dialog.getByRole("checkbox", { name: `Vybrat variantu ${a.sku}`, exact: true }).check();
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === "akros-demo-favorites-v1")
        throw new DOMException("Blocked", "QuotaExceededError");
      return window.originalSetItem.call(this, storageKey, value);
    };
  });
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.deepEqual(await read(), []);
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalSetItem;
  });
  await dialog.getByRole("button", { name: "Uložit výběr" }).click();
  await page.waitForFunction(() => !document.querySelector(".akros-favorites-dialog"));

  await page.goto(`${base}/produkt/${standalone.slug}`);
  await page.locator(".akros-product-detail__favorite").click();
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

  dialog = await open();
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 390, height: 500 },
    { width: 320, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await dialog.evaluate((root) => {
      const button = [...root.querySelectorAll("button")]
        .find((item) => item.textContent === "Uložit výběr")
        .getBoundingClientRect();
      return {
        bottom: button.bottom,
        listHeight: root.querySelector(".akros-favorites-table").clientHeight,
      };
    });
    assert.ok(
      layout.bottom <= viewport.height && layout.listHeight >= 80,
      `short viewport ${JSON.stringify(viewport)}: ${JSON.stringify(layout)}`,
    );
  }
  await page.keyboard.press("Escape");

  const endpoint = `**/api/favorites/catalog/${product.slug}`;
  await page.route(endpoint, (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto(`${base}/produkt/${product.slug}`);
  await page.locator(".akros-product-detail__favorite").click();
  dialog = page.getByRole("dialog", { name: "Oblíbené varianty" });
  await dialog.getByRole("alert").waitFor();
  await page.unroute(endpoint);
  await dialog.getByRole("button", { name: "Zkusit znovu" }).click();
  await dialog.locator("tbody tr").first().waitFor();
  await page.keyboard.press("Escape");

  for (const item of [product, largest]) {
    dialog = await open(item);
    assert.equal(await dialog.locator("tbody tr").count(), item.detail.variants.length);
    for (const width of [1920, 1440, 1280, 1024, 768, 640, 639, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const failures = await dialog.evaluate((root) => {
        const result = [];
        const rect = root.getBoundingClientRect();
        if (
          rect.left < -1 ||
          rect.right > innerWidth + 1 ||
          rect.top < -1 ||
          rect.bottom > innerHeight + 1
        )
          result.push("dialog outside viewport");
        const save = [...root.querySelectorAll("button")]
          .find((button) => button.textContent === "Uložit výběr")
          .getBoundingClientRect();
        if (save.bottom > rect.bottom || save.top < rect.top) result.push("save outside dialog");
        const table = root.querySelector(".akros-favorites-table");
        if (table.scrollWidth > table.clientWidth + 1) result.push("horizontal list overflow");
        for (const sku of root.querySelectorAll(".akros-favorites-sku")) {
          const bounds = sku.getBoundingClientRect();
          if (bounds.right > rect.right - 5 || bounds.left < rect.left) result.push("SKU clipped");
        }
        return result;
      });
      assert.deepEqual(failures, [], `${item.slug} at ${width}`);
      if (item === product && [1920, 768, 390, 320].includes(width))
        await page.screenshot({ path: `${output}/selection-${width}.png`, animations: "disabled" });
    }
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((root) => root.contains(document.activeElement)), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate((root) => root.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
  }
  console.log(
    `Favorites: 18 layouts, keyboard and full ${largest.detail.variants.length}-variant group passed.`,
  );

  await page.goto(base);
  await page.locator(".akros-product-card__favorite").first().click();
  await page
    .getByRole("dialog", { name: "Oblíbené varianty" })
    .locator("tbody tr")
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  const unavailable = await page.request.get(
    `${base}/api/favorites/catalog/this-product-does-not-exist`,
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
  await page.screenshot({ path: `${output}/share-390.png` });
  await page.getByRole("button", { name: "Zavřít", exact: true }).click();
  await page.evaluate(() => {
    window.print = () => {
      window.printInvoked = true;
    };
  });
  await page.getByRole("button", { name: "Tisk", exact: true }).click();
  assert.equal(await page.evaluate(() => window.printInvoked), true);
  assert.equal(await page.locator(".akros-print-sheet").isVisible(), false);
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".akros-print-sheet").isVisible(), true);
  for (const selector of [
    ".akros-header",
    ".akros-sidebar",
    ".akros-footer",
    ".akros-product-detail",
  ])
    assert.equal(await page.locator(selector).isVisible(), false);
  assert.equal(await page.locator(".akros-print-sheet tbody").count(), 0);
  await page.waitForFunction(() => {
    const image = document.querySelector(".akros-print-sheet img");
    return image.complete && image.naturalWidth > 0;
  });
  await page.screenshot({ path: `${output}/product-sheet.png`, fullPage: true });
  await page.pdf({ path: `${output}/product-sheet.pdf`, format: "A4", printBackground: true });
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log(
    "Share: native, cancel, copy/manual fallback passed. Print action, clean output and PDF passed.",
  );
} finally {
  await browser.close();
}
