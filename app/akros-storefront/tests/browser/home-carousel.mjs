import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { DEFAULT_MARKET_LOCALE, localizeHref } from "../../src/ontos/market-locale.ts";

// The live banners belong to a server-only TSX brand profile. Read its literals without
// executing its page components; the home page resolves each banner's alt text by market locale.
const brandSource = ts.createSourceFile(
  "akros.tsx",
  await readFile(new URL("../../src/brand/akros.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const brand = brandSource.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "akros",
  )?.initializer;
assert.ok(brand && ts.isObjectLiteralExpression(brand), "AKROS must define its brand profile");
const carouselData = brand.properties.find(
  (property) =>
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === "carousel",
);
assert.ok(carouselData, "AKROS must define its production carousel");
const readLiteral = (node) => {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(readLiteral);
  assert.ok(ts.isObjectLiteralExpression(node), "Carousel data must contain only literal data");
  return Object.fromEntries(
    node.properties.map((property) => {
      assert.ok(ts.isPropertyAssignment(property), "Carousel data must use explicit properties");
      assert.ok(
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name),
        "Carousel data must use literal property names",
      );
      return [property.name.text, readLiteral(property.initializer)];
    }),
  );
};
const homeCarouselSlides = readLiteral(carouselData.initializer).map(({ alt, ...slide }) => ({
  ...slide,
  alt: alt[DEFAULT_MARKET_LOCALE],
}));

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
  assert.equal(await images.count(), homeCarouselSlides.length);
  for (const [index, slide] of homeCarouselSlides.entries()) {
    const image = images.nth(index);
    assert.equal(await image.getAttribute("alt"), slide.alt);
    assert.ok((await image.getAttribute("src")).includes(encodeURIComponent(slide.src)));
    assert.equal(await image.getAttribute("width"), "933");
    assert.equal(await image.getAttribute("height"), "260");
    assert.equal(await image.getAttribute("loading"), index === 0 ? "eager" : "lazy");
  }
  assert.equal(await images.first().getAttribute("fetchpriority"), "high");
  assert.deepEqual(
    await carousel
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    homeCarouselSlides.flatMap((slide) =>
      slide.href ? [localizeHref(slide.href, DEFAULT_MARKET_LOCALE)] : [],
    ),
  );
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
    ["Předchozí banner", 5],
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
  if (process.env.AKROS_HOME_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.AKROS_HOME_SCREENSHOTS}/carousel-real.png` });
  }
  console.log(
    "PASS original banners/destinations, indicator/keyboard focus, next/previous/wrap, real pointer drag",
  );
} finally {
  await tab.close();
}
