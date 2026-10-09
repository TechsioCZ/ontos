import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://127.0.0.1:3000";
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

      const result = await page.locator(".akros-variant-data-table__table").evaluate((table) => {
        const failures = [];
        const compact = getComputedStyle(table).display === "block";
        const cells = table.querySelectorAll(compact ? "tbody td" : "thead th, tbody td");
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas color inspection is unavailable");

        const rgba = (color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };

        const backgroundOf = (element) => {
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const color = rgba(getComputedStyle(ancestor).backgroundColor);
            if (color[3] === 255) return color;
          }
          return [255, 255, 255, 255];
        };

        for (const cell of cells) {
          const bounds = cell.getBoundingClientRect();
          if (!bounds.width || !bounds.height) continue;
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          let textNode;

          while ((textNode = walker.nextNode())) {
            const text = textNode.textContent.trim();
            if (!text) continue;
            const parent = textNode.parentElement;
            if (!parent || getComputedStyle(parent).visibility !== "visible") continue;
            const range = document.createRange();
            range.selectNodeContents(textNode);

            for (const rect of range.getClientRects()) {
              if (!rect.width || !rect.height) continue;
              let { left, right, top, bottom } = rect;

              // Account for intentionally clipped product titles and control contents.
              for (
                let ancestor = parent;
                ancestor && ancestor !== cell;
                ancestor = ancestor.parentElement
              ) {
                const style = getComputedStyle(ancestor);
                const clip = ancestor.getBoundingClientRect();
                if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
                  left = Math.max(left, clip.left);
                  right = Math.min(right, clip.right);
                }
                if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
                  top = Math.max(top, clip.top);
                  bottom = Math.min(bottom, clip.bottom);
                }
              }

              if (right <= left || bottom <= top) continue;
              if (
                left < bounds.left - 1 ||
                right > bounds.right + 1 ||
                top < bounds.top - 1 ||
                bottom > bounds.bottom + 1
              ) {
                failures.push({
                  column: cell.cellIndex,
                  text,
                  problem: "text crosses cell bounds",
                });
              }

              const foreground = rgba(getComputedStyle(parent).color);
              const background = backgroundOf(parent);
              if (
                foreground[3] === 0 ||
                foreground.every((value, index) => value === background[index])
              ) {
                failures.push({ column: cell.cellIndex, text, problem: "text is invisible" });
              }
            }
          }

          for (const control of cell.querySelectorAll("button, input:not([type=hidden]), a")) {
            const rect = control.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) continue;
            if (
              rect.left < bounds.left - 1 ||
              rect.right > bounds.right + 1 ||
              rect.top < bounds.top - 1 ||
              rect.bottom > bounds.bottom + 1
            ) {
              failures.push({ column: cell.cellIndex, problem: "control crosses cell bounds" });
            }
          }
        }

        return {
          failures,
          horizontalOverflow: table.parentElement.scrollWidth - table.parentElement.clientWidth,
        };
      });

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
