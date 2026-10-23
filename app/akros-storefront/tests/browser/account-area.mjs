import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const screenshots = process.env.AKROS_CART_SCREENSHOTS;
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const routes = [
  ["/muj-ucet/prehled", "overview", "Přehled účtu"],
  ["/historie-objednavek", "orders", "Objednávky"],
  ["/detail-objednavky", "detail", "Objednávky"],
  ["/oblibene", "favorites", "Přehled účtu"],
  ["/sledovani-zasilky", "tracking", "Objednávky"],
  ["/muj-ucet/reklamace", "claims", "Reklamace"],
];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(30000);
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const [route, key, active] of routes) {
    const response = await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200, route);
    await page.locator("[data-akros-account] h1").waitFor({ timeout: 120000 });
    if (key === "orders") await page.locator("#account-order-search").fill("");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.locator('[data-account-navigation] [aria-current="page"]').innerText(),
      active,
    );
    assert.equal(
      await page.locator(".akros-account-sidebar, [data-akros-cart-selector]").count(),
      0,
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "[data-akros-account] h1",
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(
      fonts.length &&
        fonts.every((font) => font.isCustomFont && font.familyName.startsWith("Inter")),
      `${route} uses local Inter`,
    );
    await cdp.detach();
    for (const width of [1920, 1536, 1280, 1024, 768, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const errors = await page.locator("[data-akros-account]").evaluate((main) => {
        const failures = [];
        const box = main.getBoundingClientRect();
        const nav = main.querySelector("[data-account-navigation]");
        const heading = getComputedStyle(main.querySelector("h1"));
        if (
          heading.fontSize !== "25px" ||
          heading.lineHeight !== "30px" ||
          heading.fontWeight !== "700"
        )
          failures.push("Heading differs from shared 25/30/700 typography");
        if (getComputedStyle(main).fontSize !== "20px")
          failures.push("Body differs from shared 20px typography");
        if (main.scrollWidth > main.clientWidth + 1)
          failures.push(`Content overflow ${main.scrollWidth}/${main.clientWidth}`);
        if (nav.scrollWidth > nav.clientWidth + 1) failures.push("Navigation overflow");
        for (const el of main.querySelectorAll("a, button, input, img, table")) {
          if (!el.getClientRects().length) continue;
          const rect = el.getBoundingClientRect();
          if (rect.right > box.right + 1 || rect.left < box.left - 1)
            failures.push(`Clipped ${el.tagName}: ${el.textContent?.slice(0, 45)}`);
        }
        if (
          window.innerWidth >= 1536 &&
          new Set([...nav.children].map((child) => child.getBoundingClientRect().top)).size !== 1
        )
          failures.push("Desktop navigation wraps");
        return failures;
      });
      assert.deepEqual(errors, [], `${route} at ${width}px`);
      if (key === "orders") {
        assert.equal(await page.locator("[data-account-table]").isVisible(), width >= 1280);
        assert.equal(await page.locator("[data-account-order-cards]").isVisible(), width < 1280);
      }
      if (screenshots && [1920, 768, 390].includes(width)) {
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
        await page.screenshot({
          path: join(screenshots, `account-${key}-${width}.png`),
          fullPage: true,
        });
      }
    }
    console.log(`${route}: Inter, common navigation and 8 widths passed`);
  }
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(new URL("/historie-objednavek", base).href);
  await page.locator("#account-order-search").fill("00812");
  await page.getByText("Zobrazeno 1 z 5 objednávek", { exact: true }).waitFor();
  await page
    .locator("[data-account-table]")
    .getByRole("link", { name: "#2024-00812", exact: true })
    .click();
  await page.getByRole("heading", { level: 1, name: "Objednávka #2024-00812" }).waitFor();
  assert.ok(
    await page.locator("[data-akros-account]").getByText("164,80 Kč", { exact: true }).isVisible(),
  );
  assert.equal(
    await page.getByText("Kód: 10799700040030", { exact: true }).count(),
    0,
    "Another order must not show the first order's products",
  );
  await page.getByRole("link", { name: "Zpět na objednávky", exact: true }).click();
  await page.locator("#account-order-search").fill("no-results");
  await page.getByRole("heading", { name: "Žádné objednávky neodpovídají filtrům" }).waitFor();
  await page.getByRole("button", { name: "Zrušit filtry", exact: true }).click();
  await page.getByText("Zobrazeno 5 z 5 objednávek", { exact: true }).waitFor();
  await page.locator('[data-scope="select"][data-part="trigger"]').last().click();
  await page.getByRole("option", { name: "Odesláno", exact: true }).click();
  await page.getByText("Zobrazeno 1 z 5 objednávek", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Zrušit filtry", exact: true }).click();
  await page.locator('[data-scope="select"][data-part="trigger"]').first().click();
  await page.getByRole("option", { name: "Září 2026", exact: true }).click();
  await page.getByText("Zobrazeno 1 z 5 objednávek", { exact: true }).waitFor();
  await page.goto(new URL("/muj-ucet", base).href);
  await page.locator("#account-email").waitFor({ timeout: 120000 });
  await page
    .getByRole("navigation", { name: "Navigace účtu", exact: true })
    .getByRole("link", { name: "Přehled účtu", exact: true })
    .click();
  await page.getByRole("link", { name: "Otevřít produkty", exact: true }).click();
  await page.getByRole("heading", { name: "Oblíbené produkty", level: 1 }).waitFor();
  await page.getByRole("link", { name: "Zpět na přehled", exact: true }).click();
  await page.getByRole("link", { name: "Sledovat zásilku", exact: true }).click();
  await page.getByRole("heading", { name: "Sledování zásilky", level: 1 }).waitFor();
  await page
    .getByRole("navigation", { name: "Navigace účtu", exact: true })
    .getByRole("link", { name: "Můj účet", exact: true })
    .click();
  await page.locator("#account-email").waitFor();
  console.log(
    "Account area passed 48 layouts, actual Inter, shared navigation, order search/status/month/empty states, matching detail and links between profile, overview, favorites and tracking.",
  );
} finally {
  await browser.close();
}
