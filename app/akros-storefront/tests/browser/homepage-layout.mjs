import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const screenshotDirectory = process.env.AKROS_HOME_SCREENSHOTS;
const widths = [
  320, 340, 341, 359, 360, 375, 390, 414, 430, 431, 640, 760, 761, 767, 768, 796, 797, 820, 912,
  1023, 1024, 1100, 1101, 1115, 1119, 1120, 1280, 1366, 1440, 1441, 1536, 1663, 1920, 2560,
];
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);

try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1000 },
    reducedMotion: "reduce",
    hasTouch: true,
  });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(120000);
  await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const failures = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const issues = await page.evaluate(() => {
      const errors = [];
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
        errors.push("Page scrolls horizontally");
      }
      const carriers = [...document.querySelectorAll(".akros-footer__asset-row--carriers img")];
      if (
        innerWidth > 1100 &&
        carriers.some(
          (image) =>
            Math.abs(image.getBoundingClientRect().top - carriers[0].getBoundingClientRect().top) >
            0.5,
        )
      ) {
        errors.push("Desktop carrier logos unexpectedly wrap");
      }
      for (const row of document.querySelectorAll(".akros-product-card__stock-row")) {
        const card = row.closest(".akros-product-card").getBoundingClientRect();
        for (const child of row.children) {
          const bounds = child.getBoundingClientRect();
          if (bounds.left < card.left - 0.5 || bounds.right > card.right + 0.5) {
            errors.push("Stock label or variant badge extends outside its card");
          }
        }
      }
      const carousel = document.querySelector("[data-akros-home-carousel]");
      const buttons = carousel.querySelectorAll("button");
      for (const button of buttons) {
        const bounds = button.getBoundingClientRect();
        const top = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        if (!button.contains(top)) errors.push(`${button.getAttribute("aria-label")} is covered`);
        const minimum = button.dataset.part === "indicator" ? 44 : 40;
        if (bounds.width < minimum || bounds.height < minimum) {
          errors.push("Carousel target was shrunk to avoid overlap");
        }
      }
      return [...new Set(errors)];
    });
    failures.push(...issues.map((issue) => `${width}px: ${issue}`));
  }

  await page.setViewportSize({ width: 320, height: 1000 });
  const carousel = page.locator("[data-akros-home-carousel]");
  try {
    for (let index = 0; index < 6; index++) {
      const indicator = carousel.locator(`[data-part="indicator"][data-index="${index}"]`);
      await indicator.tap({ timeout: 3000 });
      await carousel
        .locator(`[data-part="indicator"][data-index="${index}"][data-current]`)
        .waitFor({ timeout: 3000 });
    }
    await carousel.locator('[data-part="next-trigger"]').tap({ timeout: 3000 });
    await carousel.locator('[data-part="indicator"][data-index="0"][data-current]').waitFor();
    await carousel.locator('[data-part="prev-trigger"]').tap({ timeout: 3000 });
    await carousel.locator('[data-part="indicator"][data-index="5"][data-current]').waitFor();
    await carousel.locator('[data-part="indicator"][data-index="0"]').click();
    await page.keyboard.press("ArrowRight");
    await carousel.locator('[data-part="indicator"][data-index="1"][data-current]').waitFor();
  } catch (error) {
    failures.push(`320px carousel interaction: ${error.message.split("\n")[0]}`);
  }

  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await carousel.locator('[data-part="indicator"][data-index="0"]').click();
    await page.mouse.click(1, 1);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.evaluate(() => {
      for (const image of document.images) image.loading = "eager";
    });
    for (const width of [320, 390, 430, 431, 768, 1101, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      });
      await page.screenshot({
        path: join(screenshotDirectory, `homepage-${width}.png`),
        fullPage: true,
      });
    }
  }
  assert.deepEqual(failures, [], `Homepage responsive failures:\n${failures.join("\n")}`);
  console.log(`Homepage layout passed at ${widths.length} widths; mobile carousel controls work.`);
} finally {
  await browser.close();
}
