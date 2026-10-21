import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { inspectTableLayout } from "./table-layout-checks.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browserPath = process.env.AKROS_CHROMIUM_PATH;
const widths = [
  1920, 1680, 1600, 1536, 1440, 1366, 1336, 1335, 1280, 1100, 1024, 1023, 900, 800, 769, 768, 767,
  704, 672, 671, 390, 320,
];
const products = [
  "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
  "plechy-brousene-povrch-k-240-s-folii-k-240-f-mat-1-4571-product-29129",
  "kohouty-kulove-typ-300-f-mat-1-4404",
  "plechy-zihane-morene-hladky-matny-povrch-iiic-mat-1-4016",
];

function inspectVariantControls(root) {
  const failures = [];
  const desktop = root.getBoundingClientRect().width >= 1000;
  if (desktop) {
    for (const order of root.querySelectorAll(".akros-variant-table__order")) {
      const quantity = order.querySelector(".akros-variant-table__quantity-control");
      const buy = order.querySelector(".akros-variant-table__buy-button");
      const gap = buy.getBoundingClientRect().left - quantity.getBoundingClientRect().right;
      if (gap < 0 || gap > 8)
        failures.push("Purchase quantity and button are separated by excess whitespace");
    }
  }
  for (const button of root.querySelectorAll(".akros-variant-table__buy-button--package")) {
    const bounds = button.getBoundingClientRect();
    if (bounds.width > 129 || (desktop && Math.abs(bounds.width - 128) > 1))
      failures.push("Whole-package button is wider than its compact design");
    if (desktop ? Math.abs(bounds.height - 38) > 1 : bounds.height < 44)
      failures.push("Whole-package button height does not fit the layout mode");
    const label = button.querySelector("span").getBoundingClientRect();
    const style = getComputedStyle(button);
    if (
      label.left < bounds.left + parseFloat(style.paddingLeft) - 1 ||
      label.right > bounds.right - parseFloat(style.paddingRight) + 1 ||
      label.top < bounds.top - 1 ||
      label.bottom > bounds.bottom + 1
    )
      failures.push("Whole-package button label is clipped");
  }

  for (const element of root.querySelectorAll(
    ".akros-variant-table__sku > span:last-child, .akros-variant-table__name > p",
  )) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (!lines.length) continue;
    const bounds = element.closest("td").getBoundingClientRect();
    if (
      new Set(lines.map((rect) => Math.round(rect.top))).size > 1 ||
      lines.some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
    )
      failures.push(`Variant SKU wraps or is clipped: ${element.textContent.trim()}`);
  }
  return failures;
}

const browser = await chromium.launch(
  browserPath ? { executablePath: browserPath } : { channel: "chrome" },
);

try {
  const page = await browser.newPage({ viewport: { width: widths[0], height: 1000 } });
  page.setDefaultNavigationTimeout(120000);
  let checks = 0;

  for (const slug of products) {
    await page.goto(new URL(`/produkt/${slug}`, baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(".akros-variant-data-table__table tbody tr")
      .first()
      .waitFor({ timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      // UI-kit controls animate their dimensions when the container mode changes.
      await page.waitForTimeout(350);

      const result = await page
        .locator(".akros-variant-data-table__table")
        .evaluate(inspectTableLayout);

      assert.equal(
        result.horizontalOverflow,
        0,
        `${slug} at ${width}px: horizontal table overflow`,
      );
      assert.deepEqual(
        result.failures,
        [],
        `${slug} at ${width}px: ${JSON.stringify(result.failures)}`,
      );
      const filterFailures = await page
        .getByRole("form", { name: "Filtrování variant" })
        .evaluate((form) => {
          const errors = [];
          const bounds = form.getBoundingClientRect();
          const submit = form.querySelector('button[type="submit"]').getBoundingClientRect();
          if (
            form.scrollWidth > form.clientWidth + 1 ||
            submit.right > bounds.right + 1 ||
            submit.left < bounds.left - 1
          )
            errors.push("Filter/submit overflow");
          const price = form.querySelector(".akros-variant-filter-range--price");
          if (
            price &&
            innerWidth >= 768 &&
            Math.abs(price.getBoundingClientRect().top - submit.top) > 16
          )
            errors.push("Price and submit are on different lines");
          const context = document.createElement("canvas").getContext("2d");
          if (price && price.querySelectorAll("input[role=spinbutton]").length !== 2)
            errors.push("Price filter must have two editable endpoints");
          for (const input of form.querySelectorAll(
            ".akros-variant-filter-range--price input[role=spinbutton]",
          )) {
            const style = getComputedStyle(input);
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            if (
              context.measureText(input.value).width >
              input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1
            )
              errors.push(`Price input clipped: ${input.value}`);
          }
          return errors;
        });
      assert.deepEqual(filterFailures, [], `${slug} at ${width}px: filter layout`);
      const controlFailures = await page
        .locator(".akros-variant-purchase")
        .evaluate(inspectVariantControls);
      assert.deepEqual(controlFailures, [], `${slug} at ${width}px: compact controls and SKU`);
      const mode = await page.locator(".akros-variant-purchase").evaluate((root) => {
        const row = root.querySelector("tbody tr");
        const order = row.querySelector("td:last-child");
        const name = row.querySelector("td");
        return {
          width: root.getBoundingClientRect().width,
          order: order.getBoundingClientRect().toJSON(),
          name: name.getBoundingClientRect().toJSON(),
        };
      });
      if (mode.width >= 640 && mode.width < 1000)
        assert.ok(
          mode.order.left >= mode.name.right - 1,
          `${slug} at ${width}px: purchases must use the space beside product information`,
        );
      checks += 1;
    }
  }

  // These real catalog codes are 18 characters long and are not necessarily on page one.
  for (const [slug, sku] of [
    [products[1], "3pb24f440001512525"],
    [products[2], "3kk300280000000210"],
  ]) {
    const url = new URL(`/produkt/${slug}`, baseUrl);
    url.searchParams.set("variant", sku);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.locator(".akros-variant-data-table__table tbody tr").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1920, 1336, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(350);
      assert.equal(
        await page.locator(".akros-variant-table__sku > span:last-child").first().textContent(),
        sku,
      );
      const failures = await page
        .locator(".akros-variant-purchase")
        .evaluate(inspectVariantControls);
      assert.deepEqual(failures, [], `${sku} at ${width}px: long SKU and compact controls`);
    }
  }

  console.log(
    `Variant table layout passed ${checks} checks across ${widths.length} widths (320–1920px), plus 12 long-SKU checks.`,
  );
} finally {
  await browser.close();
}
