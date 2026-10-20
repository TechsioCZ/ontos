import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const widths = [1920, 1536, 1280, 1101, 1100, 1024, 768, 761, 760, 640, 390, 320];
const routes = [
  ["/faq", ".akros-faq-page"],
  ["/blog", ".akros-blog-page"],
  ["/novinky-a-akce", ".akros-news-page"],
  ["/kontakty", ".akros-content-page"],
  ["/doprava-a-platba", ".akros-landing-page"],
  ["/o-nas", ".akros-content-page"],
  ["/partnersky-program", ".akros-content-page"],
  ["/reklamace", ".akros-content-page"],
  ["/gdpr", ".akros-content-page"],
  ["/obchodni-podminky", ".akros-content-page"],
];

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async (route) => {
    await page.goto(new URL(route, base).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
  };
  const style = (locator, name) =>
    locator.evaluate((element, property) => getComputedStyle(element)[property], name);
  async function probe(scope, tokens, check) {
    const previous = await scope.getAttribute("style");
    try {
      await scope.evaluate((element, values) => {
        for (const [key, value] of Object.entries(values)) element.style.setProperty(key, value);
      }, tokens);
      await check();
    } finally {
      await scope.evaluate((element, previous) => {
        if (previous === null) element.removeAttribute("style");
        else element.setAttribute("style", previous);
      }, previous);
    }
  }

  for (const [route, selector] of routes) {
    await visit(route);
    const root = page.locator(selector);
    await root.locator("h1").waitFor();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      const failures = await root.evaluate((element) => {
        const failures = [];
        if (document.documentElement.scrollWidth > innerWidth + 1)
          failures.push("Document overflows viewport");
        if (element.scrollWidth > element.clientWidth + 1) failures.push("Content overflows");
        const bounds = element.getBoundingClientRect();
        for (const control of element.querySelectorAll("input, textarea, button, a")) {
          const rect = control.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
            failures.push(`Control outside content: ${control.id || control.textContent}`);
        }
        return failures;
      });
      assert.deepEqual(failures, [], `${route} at ${width}px`);
      if (route === "/faq" || route === "/blog") {
        const columns = await style(
          root.locator(route === "/faq" ? ".akros-faq-layout" : ".akros-blog-layout"),
          "gridTemplateColumns",
        );
        assert.equal(columns.split(" ").length, width > (route === "/faq" ? 760 : 1100) ? 2 : 1);
      }
    }
  }

  for (const width of [1920, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit("/faq");
    const categories = page.locator(".akros-faq-categories");
    const shipping = categories.getByRole("button", { name: "Doprava a doručení" });
    await shipping.focus();
    await page.keyboard.press("Enter");
    assert.equal(await shipping.getAttribute("aria-current"), "page");
    assert.match(await page.locator(".akros-faq-results h2").innerText(), /Doprava a doručení/);
    const trigger = page.locator('.akros-faq-results [data-part="item-trigger"]').first();
    const summary = page.locator(".akros-faq-answer-summary").first();
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await summary.isVisible(), false);
    assert.equal(await page.locator(".akros-faq-answer-details").first().isVisible(), true);
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await summary.isVisible(), true);

    const search = page.getByRole("searchbox", { name: "Hledat v často kladených otázkách" });
    await search.fill("objednavky");
    await page.locator(".akros-faq-results h2").filter({ hasText: "Výsledky hledání" }).waitFor();
    const unaccented = await page
      .locator(".akros-faq-results [data-part=item-trigger]")
      .allTextContents();
    assert.ok(unaccented.length > 0);
    await search.fill("OBJEDNÁVKY");
    assert.deepEqual(
      await page.locator(".akros-faq-results [data-part=item-trigger]").allTextContents(),
      unaccented,
    );
    assert.equal(await categories.locator('[aria-current="page"]').count(), 0);
    await search.fill("zz-no-matching-faq-zz");
    await page.locator(".akros-empty-state").waitFor();
    assert.equal(await page.locator(".akros-faq-results [data-part=item-trigger]").count(), 0);
    await shipping.click();
    assert.equal(await search.inputValue(), "");
    assert.equal(await shipping.getAttribute("aria-current"), "page");
    await probe(
      page.locator(".akros-faq-search"),
      {
        "--height-form-control-md": "52px",
        "--padding-input-md": "7px 9px 7px 41px",
        "--text-input-md": "17px",
        "--color-input-border-base": "rgb(12, 34, 56)",
      },
      async () => {
        await page.mouse.move(0, 0);
        assert.equal(await style(search, "height"), "52px");
        assert.equal(await style(search, "paddingLeft"), "41px");
        assert.equal(await style(search, "fontSize"), "17px");
        assert.equal(await style(search, "borderTopColor"), "rgb(12, 34, 56)");
      },
    );
    await probe(
      shipping,
      {
        "--padding-button-sm": "10px",
        "--font-weight-button": "500",
        "--color-button-fg-secondary-borderless": "rgb(12, 34, 56)",
      },
      async () => {
        assert.equal(await style(shipping, "paddingTop"), "10px");
        assert.equal(await style(shipping, "fontWeight"), "500");
        assert.equal(await style(shipping, "color"), "rgb(12, 34, 56)");
      },
    );

    for (const [route, prefix] of [
      ["/faq", "faq"],
      ["/kontakty", "contact"],
    ]) {
      await visit(route);
      const form = page.locator(".akros-contact-form");
      const submit = form.getByRole("button", { name: "Odeslat dotaz", exact: true });
      const name = page.locator(`#${prefix}-name`);
      const email = page.locator(`#${prefix}-email`);
      const message = page.locator(`#${prefix}-message`);
      const submissions = [];
      const onRequest = (request) => {
        if (request.method() === "POST") submissions.push(request.url());
      };
      page.on("request", onRequest);
      try {
        await submit.click();
        assert.equal(await name.evaluate((element) => element.validity.valueMissing), true);
        await name.fill("Content Browser Test");
        await email.fill("invalid-email");
        await message.fill("Local prototype message");
        await submit.click();
        assert.equal(await email.evaluate((element) => element.validity.typeMismatch), true);
        await email.fill("content-check@example.test");
        await message.fill("");
        await submit.click();
        assert.equal(await message.evaluate((element) => element.validity.valueMissing), true);
        await message.fill("Local prototype message");
        assert.equal(await form.locator("output").count(), 0);
        await submit.click();
        await form.locator("output").waitFor();
        assert.match(await form.locator("output").innerText(), /pouze lokálně/);
        assert.deepEqual(submissions, []);
        const stored = await page.evaluate(() =>
          JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
        );
        assert.doesNotMatch(stored, /content-check@example\.test|Local prototype message/);
      } finally {
        page.off("request", onRequest);
      }
    }

    const anchors = page.locator(".akros-anchor-nav a");
    for (const link of await anchors.all()) {
      const href = await link.getAttribute("href");
      assert.ok(href.startsWith("#"));
      assert.equal(await page.locator(href).count(), 1);
      await link.focus();
      await page.keyboard.press("Enter");
      assert.equal(new URL(page.url()).hash, href);
    }
    assert.equal(await page.locator('.akros-branch a[href="tel:+420734151938"]').count(), 3);
    await probe(
      anchors.first(),
      {
        "--color-button-border-secondary": "rgb(12, 34, 56)",
        "--padding-button-sm": "9px 15px",
      },
      async () => {
        assert.equal(await style(anchors.first(), "borderTopColor"), "rgb(12, 34, 56)");
        assert.equal(await style(anchors.first(), "paddingLeft"), "15px");
      },
    );

    await visit("/blog");
    const latest = page.getByRole("link", { name: "Přečíst celý článek", exact: true });
    await latest.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/blog#nejnovejsi");
    assert.equal(new URL(page.url()).hash, "#nejnovejsi");
    const readMore = page.locator(".akros-blog-card a");
    assert.equal(await readMore.count(), 4);
    await readMore.first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/blog#featured-article-title");
    assert.equal(new URL(page.url()).hash, "#featured-article-title");
    await probe(
      readMore.first(),
      { "--color-button-fg-secondary-borderless": "rgb(12, 34, 56)" },
      async () => {
        assert.equal(await style(readMore.first(), "color"), "rgb(12, 34, 56)");
      },
    );
    await page.getByRole("searchbox", { name: "Hledat v článcích" }).fill("nerez");
    assert.equal(await readMore.count(), 4); // Existing static editorial search, without filtering.

    await visit("/novinky-a-akce");
    const offers = page.getByRole("link", { name: "Zobrazit akční nabídku", exact: true });
    await offers.click();
    await page.waitForURL("**/novinky-a-akce#action-products");
    assert.equal(new URL(page.url()).hash, "#action-products");
    assert.equal(await page.locator(".akros-news-page .akros-product-card").count(), 8);
    for (const [name, query] of [
      ["Zobrazit všechny novinky", "novinka"],
      ["Zobrazit celou akční nabídku", "akce"],
    ]) {
      const link = page.getByRole("link", { name, exact: true });
      assert.equal(await link.getAttribute("href"), `/vyhledavani?q=${query}`);
    }
  }
  assert.deepEqual(errors, [], "Content pages must not produce uncaught browser errors");
  console.log(
    `Content pages passed: ${routes.length * widths.length} layouts, FAQ/search/accordion, both local forms, keyboard anchors and component token checks at desktop/tablet/mobile.`,
  );
} finally {
  await browser.close();
}
