import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const task = process.argv[2] ?? process.env.AKROS_TASK ?? "12";
const widths = [1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 320];
const output = `test-results/task-${task}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const routes = task === "12" ? ["/historie-objednavek", "/detail-objednavky"] : ["/muj-ucet"];
  for (const route of routes) {
    await page.goto(base + route);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      if (task === "12") {
        const buttons = page
          .getByRole("button", { name: /^Objednat znovu/ })
          .filter({ visible: true });
        assert.equal(await buttons.count(), route.includes("historie") ? 5 : 1);
        assert.equal(await buttons.first().isDisabled(), false);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      assert.equal(overflow, false, `${route} at ${width} overflows`);
      if ([1920, 1024, 768, 390, 320].includes(width)) {
        await page.screenshot({
          path: `${output}/${route.slice(1)}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`TASK ${task}: ${routes.length} routes at ${widths.length} widths passed.`);
} finally {
  await browser.close();
}
