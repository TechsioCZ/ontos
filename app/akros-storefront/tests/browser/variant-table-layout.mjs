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

  console.log(
    `Variant table layout passed ${checks} checks across ${widths.length} widths (320–1920px).`,
  );
} finally {
  await browser.close();
}
