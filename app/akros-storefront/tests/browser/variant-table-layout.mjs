import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { inspectTableLayout } from "./table-layout-checks.mjs";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browserPath = process.env.AKROS_CHROMIUM_PATH;
const widths = [1920, 1680, 1600, 1536, 1440, 1366, 1336, 1335, 1280, 1100, 1024, 768, 390, 320];
const products = [
  "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
  "plechy-brousene-povrch-k-240-s-folii-k-240-f-mat-1-4571-product-29129",
  "kohouty-kulove-typ-300-f-mat-1-4404",
];

const browser = await chromium.launch(
  browserPath ? { executablePath: browserPath } : { channel: "chrome" },
);

try {
  const page = await browser.newPage({ viewport: { width: widths[0], height: 1000 } });
  let checks = 0;

  for (const slug of products) {
    await page.goto(new URL(`/produkt/${slug}`, baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(".akros-variant-data-table__table tbody tr").first().waitFor();
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
      checks += 1;
    }
  }

  console.log(
    `Variant table layout passed ${checks} checks across ${widths.length} widths (320–1920px).`,
  );
} finally {
  await browser.close();
}
