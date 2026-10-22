import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const { products } = JSON.parse(
  await readFile(
    new URL("../../src/mock-storefront/generated/catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const product = products.find(
  (item) => item.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
);
const path = `${base}/produkt/${product.slug}`;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
await mkdir("test-results/variant-detail", { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.locator(".akros-product-actions__watch:not(:disabled)").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const links = page.locator(".akros-variant-table__name [data-variant-detail-link]");
  const ids = await links.evaluateAll((items) =>
    items.map((item) => item.dataset.variantDetailLink),
  );
  const [a, b] = ids.map((id) => product.detail.variants.find((item) => item.id === id));
  assert.ok(a && b);
  const trigger = page.locator(`[data-variant-detail-link="${a.id}"]`);
  await trigger.hover();
  await page.locator(".akros-variant-preview img").waitFor();
  await page.mouse.move(0, 0);
  await page.locator(".akros-variant-preview").waitFor({ state: "hidden" });
  await trigger.focus();
  const tooltip = page.locator(".akros-variant-preview");
  await tooltip.waitFor();
  await tooltip.locator("img").waitFor();
  await page.keyboard.press("Escape");
  await trigger.click();
  console.log("Variant detail: preview opened; checking modal and direct actions.");
  let dialog = page.locator(".akros-variant-detail");
  await dialog.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("variantDetail"), a.id);
  assert.equal(await dialog.locator("[data-variant-detail-sku]").innerText(), a.sku);
  assert.match(a.description, /^Limity množstevních slev:.*do košíku\.?$/);
  assert.equal(
    await dialog.getByRole("region", { name: "Popis varianty" }).locator("p").innerText(),
    "Popis není k dispozici.",
  );
  assert.equal(
    await dialog.getByRole("button", { name: "Koupit", exact: true }).isDisabled(),
    a.stockCount < a.minimumQuantity || a.priceMinor <= 0,
  );
  await dialog.getByRole("button", { name: "Hlídat variantu", exact: true }).click();
  await dialog.getByRole("button", { name: /^Uložit .* do oblíbených$/ }).click();
  assert.equal(await page.getByRole("dialog").count(), 1, "direct actions must not open a chooser");
  await page.goBack();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(
      (id) => document.activeElement?.getAttribute("data-variant-detail-link") === id,
      a.id,
    ),
    true,
  );
  await page.goForward();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await trigger.click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Zavřít detail varianty" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(`[data-variant-detail-link="${b.id}"]`).click();
  await dialog.waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Hlídat variantu", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await dialog.getByRole("button", { name: "Hlídat variantu", exact: true }).click();
  await dialog.getByRole("button", { name: /^Uložit .* do oblíbených$/ }).click();
  for (const key of ["akros-demo-watched-variants-v1", "akros-demo-favorites-v1"]) {
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
    assert.deepEqual(saved.map((item) => item.variantId).sort(), [a.id, b.id].sort());
  }
  assert.ok(b.stockCount >= b.minimumQuantity && b.priceMinor > 0);
  await dialog.getByRole("button", { name: "Koupit", exact: true }).click();
  await page.waitForFunction(
    ({ id, quantity }) =>
      JSON.parse(localStorage.getItem("akros-demo-cart-v3"))?.lines.some(
        (line) => line.variantId === id && line.quantity === quantity,
      ),
    { id: b.id, quantity: b.minimumQuantity },
  );
  await page.reload();
  console.log(
    "Variant detail: history and independent actions passed; checking reload and layouts.",
  );
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Zrušit hlídání varianty" }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: /^Odebrat .* z oblíbených$/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  await dialog.evaluate((root) => {
    root.style.setProperty("--container-dialog-center-h-max", "400px");
    root.style.setProperty("--container-dialog-center-w-max", "800px");
  });
  const tokenSize = await dialog.boundingBox();
  assert.ok(tokenSize.height <= 401 && Math.abs(tokenSize.width - 800) < 1);
  await dialog.evaluate((root) => {
    root.style.removeProperty("--container-dialog-center-h-max");
    root.style.removeProperty("--container-dialog-center-w-max");
  });
  for (const width of [1920, 1440, 1280, 1024, 768, 767, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 480 : 900 });
    const layout = await dialog.evaluate((root) => {
      const r = root.getBoundingClientRect();
      const body = root.querySelector(".akros-variant-detail__body");
      const sku = root.querySelector("[data-variant-detail-sku]");
      return {
        inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        overflow: body.scrollWidth > body.clientWidth + 1,
        sku:
          sku.scrollWidth <= sku.clientWidth + 1 &&
          sku.getBoundingClientRect().height <= parseFloat(getComputedStyle(sku).lineHeight) + 1,
        close:
          root.querySelector("button[aria-label='Zavřít detail varianty']").getBoundingClientRect()
            .bottom <= innerHeight,
      };
    });
    assert.deepEqual(
      layout,
      { inView: true, overflow: false, sku: true, close: true },
      JSON.stringify({ width, layout }),
    );
    if ([1920, 390, 320].includes(width))
      await page.screenshot({ path: `test-results/variant-detail/detail-${width}.png` });
  }
  await page.setViewportSize({ width: 1920, height: 1000 });
  console.log("Variant detail: responsive layouts passed; checking sharing and questions.");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (value) => {
        window.akrosDetailShare = value;
      },
    }),
  );
  await dialog.getByRole("button", { name: "Sdílet", exact: true }).click();
  const shared = await page.evaluate(() => window.akrosDetailShare);
  assert.equal(new URL(shared.url).searchParams.get("variantDetail"), b.id);
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.akrosDetailCopy = value;
        },
      },
    });
  });
  for (const width of [1920, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 480 : 900 });
    await dialog.getByRole("button", { name: "Sdílet", exact: true }).click();
    await dialog.getByText("Sdílet variantu", { exact: true }).waitFor();
    const copy = dialog.getByRole("button", { name: "Kopírovat odkaz" });
    await copy.click();
    const usable = await copy.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const visible = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        (visible === element || element.contains(visible))
      );
    });
    assert.equal(usable, true, `share fallback ${width}`);
    assert.equal(await page.evaluate(() => window.akrosDetailCopy), shared.url);
    await dialog.getByRole("button", { name: "Zavřít", exact: true }).first().click();
  }
  await page.setViewportSize({ width: 1920, height: 1000 });
  await dialog.getByRole("button", { name: "Dotaz na variantu" }).click();
  await page.waitForURL("**/kontakty?**");
  assert.equal(new URL(page.url()).searchParams.get("variantIds"), b.id);
  assert.ok((await page.locator("#contact-message").inputValue()).includes(b.sku));
  assert.ok(!(await page.locator("#contact-message").inputValue()).includes(a.sku));
  await page.goto(`${path}?variantIds=${a.id}%2C${b.id}&variantDetail=${a.id}`, {
    waitUntil: "domcontentloaded",
  });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Zrušit hlídání varianty" }).click();
  await dialog.getByRole("button", { name: /^Odebrat .* z oblíbených$/ }).click();
  for (const key of ["akros-demo-watched-variants-v1", "akros-demo-favorites-v1"]) {
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
    assert.deepEqual(
      saved.map((item) => item.variantId),
      [b.id],
    );
  }
  await dialog.getByRole("button", { name: "Zavřít detail varianty" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("variantIds"), `${a.id},${b.id}`);
  assert.equal(await page.locator(".akros-variant-data-table tbody tr").count(), 2);
  const packageVariant = product.detail.variants.find(
    (item) =>
      item.id !== b.id &&
      item.packageQuantity > item.minimumQuantity &&
      item.stockCount >= item.packageQuantity,
  );
  assert.ok(packageVariant);
  await page.goto(`${path}?variantDetail=${packageVariant.id}`, { waitUntil: "domcontentloaded" });
  await dialog.waitFor();
  const quantityInput = dialog.getByRole("spinbutton", { name: "Množství", exact: true });
  await quantityInput.fill(String(packageVariant.packageQuantity));
  await quantityInput.press("Tab");
  await dialog.getByRole("button", { name: "Koupit", exact: true }).click();
  await page.waitForFunction(
    ({ id, quantity }) =>
      JSON.parse(localStorage.getItem("akros-demo-cart-v3"))?.lines.some(
        (line) => line.variantId === id && line.quantity === quantity,
      ),
    { id: packageVariant.id, quantity: packageVariant.packageQuantity },
  );
  await page.goto(`${path}?variantDetail=not-in-this-product`, { waitUntil: "domcontentloaded" });
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.locator(".akros-purchase-form").count(), 0);
  const noContentProduct = products.find(
    (p) =>
      p.detail.variants.length > 1 && p.detail.variants.some((v) => !v.description && !v.imageSrc),
  );
  const noContent = noContentProduct.detail.variants.find((v) => !v.description && !v.imageSrc);
  await page.route("**/_next/image?**", (route) => route.abort());
  await page.goto(`${base}/produkt/${noContentProduct.slug}?variantDetail=${noContent.id}`, {
    waitUntil: "domcontentloaded",
  });
  await dialog.getByRole("heading", { name: "Společný popis produktu" }).waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".akros-variant-detail__image")
      ?.getAttribute("src")
      ?.includes("image-unavailable.svg"),
  );
  await page.waitForFunction(
    () => document.querySelector(".akros-variant-detail__image")?.naturalWidth > 0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Variant detail passed: 8 layouts, keyboard preview, history/focus/reload, independent direct favorites/watch, share/fallback, selected question, missing data and invalid IDs.",
  );
} finally {
  await browser.close();
}
