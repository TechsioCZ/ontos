import assert from "node:assert/strict";
// Snap points, scrolling and pointer drags require a layout engine, not jsdom geometry shims.
// Shared browser client module (exports `openTab`); machine-specific, so it is configured, never hard-coded.
assert.ok(
  process.env.AKROS_SHARED_BROWSER_CLIENT,
  "Set AKROS_SHARED_BROWSER_CLIENT to the shared browser client module (exports openTab)",
);
const { openTab } = await import(process.env.AKROS_SHARED_BROWSER_CLIENT);
const tab = await openTab({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
try {
  const page = tab.page;
  const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3070";
  await page.goto(new URL("/", baseUrl).href, {
    waitUntil: "networkidle",
    timeout: 120000,
  });
  const carousel = page.locator("[data-sf-home-carousel]");
  const images = carousel.locator("img");
  const lastIndex = (await carousel.locator("[data-part=indicator]").count()) - 1;
  assert.ok(lastIndex >= 2, "The manual fixture needs at least three banners");
  const active = (index) =>
    carousel.locator(`[data-part=indicator][data-index="${index}"][data-current]`).waitFor();
  const select = async (index) => {
    await carousel
      .getByRole("button", { name: `Zobrazit banner ${index + 1}`, exact: true })
      .click();
    await active(index);
  };
  await select(1);
  assert.equal(await carousel.locator("a").nth(0).getAttribute("tabindex"), "0");
  await page.keyboard.press("ArrowRight");
  await active(2);
  assert.equal(await carousel.locator("a").nth(0).getAttribute("tabindex"), "-1");
  assert.equal(await carousel.locator("a").nth(1).getAttribute("tabindex"), "0");
  await select(0);
  for (const [button, index] of [
    ["Další banner", 1],
    ["Předchozí banner", 0],
    ["Předchozí banner", lastIndex],
    ["Další banner", 0],
  ]) {
    await carousel.getByRole("button", { name: button, exact: true }).click();
    await active(index);
  }
  await select(1);
  const image = images.nth(1);
  await image.scrollIntoViewIfNeeded();
  const bounds = await image.boundingBox();
  assert.ok(bounds);
  const start = { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height / 2 };
  const originalUrl = page.url();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - bounds.width * 0.35, start.y, { steps: 12 });
  await page.mouse.up();
  assert.equal(page.url(), originalUrl, "dragging a linked banner must not follow its destination");
  console.log("PASS indicator/keyboard focus, next/previous/wrap, real pointer drag");
} finally {
  await tab.close();
}
