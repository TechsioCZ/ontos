import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseUrl = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const widths = [320, 390, 760, 761, 768, 1023, 1024, 1100, 1101, 1280, 1440, 1920];
const informationPaths = [
  "/obchodni-podminky",
  "/o-nas",
  "/blog",
  "/partnersky-program",
  "/reklamace",
  "/kontakty",
];
const catalogPaths = [
  "/kategorie/nerezovy-spojovaci-material",
  "/kategorie/nerezovy-hutni-material",
];
const hrefs = (locator) =>
  locator.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
const style = (locator, property) =>
  locator.evaluate((element, name) => getComputedStyle(element)[name], property);

async function probe(scope, tokens, assertions) {
  const previous = await scope.getAttribute("style");
  try {
    await scope.evaluate((element, values) => {
      for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value);
    }, tokens);
    await assertions();
  } finally {
    await scope.evaluate((element, value) => {
      if (value === null) element.removeAttribute("style");
      else element.setAttribute("style", value);
    }, previous);
  }
}

try {
  await mkdir("test-results/shared-ui", { recursive: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
  await page.evaluate(async () => document.fonts.ready);
  const search = page.getByRole("combobox", { name: "Vyhledat v katalogu" });

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    const footer = page.locator(".akros-footer");
    // Fixed desktop columns allow logos to use the surrounding gap; check visible footer bounds.
    assert.deepEqual(
      await footer.locator(".akros-footer__asset-row img").evaluateAll((images) =>
        images
          .filter((image) => {
            const bounds = image.closest("footer").getBoundingClientRect();
            const rect = image.getBoundingClientRect();
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
          })
          .map((image) => image.getAttribute("alt")),
      ),
      [],
      `${width}px footer logos stay inside the footer`,
    );
    assert.equal(await footer.locator('a[href="tel:+420737591849"]').count(), 1);
    assert.equal(await footer.locator('a[href="mailto:akros@akros.cz"]').count(), 1);
    for (const social of await footer.locator(".akros-footer__social-icon").all()) {
      assert.equal(await social.getAttribute("target"), "_blank");
      assert.match(await social.getAttribute("rel"), /noopener/);
    }

    if (width >= 1024) {
      const nav = page.locator(".akros-header__utility-links");
      assert.deepEqual(await hrefs(nav), informationPaths);
      assert.equal(
        await page.locator("[data-akros-header-login]").getAttribute("href"),
        "/prihlaseni",
      );
      const terms = nav.locator('a[href="/obchodni-podminky"]');
      await probe(
        nav,
        {
          "--padding-button-sm": "0px 6px",
          "--font-weight-button": "600",
          "--text-button-sm": "18px",
        },
        async () => {
          assert.equal(await style(terms, "padding"), "0px 6px");
          assert.equal(await style(terms, "fontWeight"), "600");
          assert.equal(await style(terms, "fontSize"), "18px");
        },
      );
      for (const href of catalogPaths)
        assert.equal(await page.locator(`.akros-sidebar a[href="${href}"]`).isVisible(), true);
      assert.equal(
        await page.locator('.akros-sidebar a[href="https://www.akroscz.cz/"]').isVisible(),
        true,
      );
      if (width === 1920)
        await page
          .locator(".akros-header")
          .screenshot({ path: "test-results/shared-ui/header-1920.png" });
    }
    await probe(
      page.locator(".akros-header__search"),
      { "--radius-combobox-md": "9px 7px 5px 3px" },
      async () => {
        assert.equal(
          await style(page.locator('.akros-header__search [data-part="control"]'), "borderRadius"),
          "9px 7px 5px 3px",
        );
      },
    );
    const top = footer.locator(".akros-footer__top");
    const commerce = footer.locator(".akros-footer__commerce");
    const commerceColumns = await style(commerce, "gridTemplateColumns");
    await probe(top, { "--footer-cols": "1fr" }, async () => {
      assert.equal((await style(top, "gridTemplateColumns")).split(" ").length, 1);
      assert.equal(await style(commerce, "gridTemplateColumns"), commerceColumns);
    });

    await search.fill("retez");
    const popup = page.locator('.akros-header__search [data-part="content"]');
    await page.getByRole("listbox").waitFor();
    // Wait for the kit's discrete opening/scale transition before checking bounds.
    await page.waitForTimeout(250);
    const bounds = await popup.boundingBox();
    assert.ok(
      bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
      `${width}px search popup stays in the viewport`,
    );
    assert.ok((await page.locator("[data-akros-search-result]").count()) > 0);
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "retez");
    await search.fill("");

    if (width < 1024) {
      const trigger = page.getByRole("button", { name: "Otevřít navigaci" });
      await trigger.click();
      const menu = page.getByRole("dialog", { name: "Menu" });
      await menu.waitFor();
      const links = menu.locator(".akros-mobile-menu__links").first();
      const account = links.locator('a[href="/muj-ucet"]');
      assert.equal(await style(account, "height"), "44px");
      await probe(
        links,
        {
          "--padding-button-sm": "2px 6px",
          "--font-weight-button": "600",
          "--color-button-fg-secondary-borderless": "rgb(12, 34, 56)",
        },
        async () => {
          assert.equal(await style(account, "padding"), "2px 6px");
          assert.equal(await style(account, "fontWeight"), "600");
          assert.equal(await style(account, "color"), "rgb(12, 34, 56)");
        },
      );
      const current = menu.locator('.akros-mobile-menu__links a[aria-current="page"]');
      assert.equal(await current.count(), 0);
      assert.deepEqual(
        await hrefs(menu.getByRole("navigation", { name: "Mobilní navigace" })),
        informationPaths,
      );
      const catalog = menu.locator("[data-akros-catalog]");
      for (const href of catalogPaths)
        assert.equal(await catalog.locator(`a[href="${href}"]`).isVisible(), true);
      if (!(await catalog.locator('a[href="https://www.akroscz.cz/"]').isVisible())) {
        await catalog.getByRole("button", { name: "Speciální kategorie", exact: true }).click();
      }
      assert.equal(await catalog.locator('a[href="https://www.akroscz.cz/"]').isVisible(), true);
      if ([320, 390].includes(width)) {
        await menu.getByRole("navigation", { name: "Mobilní navigace" }).scrollIntoViewIfNeeded();
        await menu.screenshot({ path: `test-results/shared-ui/menu-${width}.png` });
      }
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Otevřít navigaci",
      );
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    }
  }

  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const destination of [...informationPaths, ...catalogPaths]) {
      await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
      let scope;
      if (width < 1024) {
        await page.getByRole("button", { name: "Otevřít navigaci" }).click();
        scope = page.getByRole("dialog", { name: "Menu" });
      } else
        scope = destination.startsWith("/kategorie/")
          ? page.locator(".akros-sidebar")
          : page.locator(".akros-header__utility-links");
      const link = scope.locator(`a[href="${destination}"]`);
      await link.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === destination);
      if (width < 1024)
        await page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "hidden" });
      if (informationPaths.includes(destination)) {
        if (width < 1024) await page.getByRole("button", { name: "Otevřít navigaci" }).click();
        const nav =
          width < 1024
            ? page.getByRole("navigation", { name: "Mobilní navigace" })
            : page.locator(".akros-header__utility-links");
        assert.equal(await nav.locator('a[aria-current="page"]').getAttribute("href"), destination);
        if (width < 1024) await page.keyboard.press("Escape");
      }
      const brand = page
        .getByRole("link", { name: "AKROS – domovská stránka", exact: true })
        .first();
      await brand.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === "/");
    }
  }

  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const group of ["Kategorie", "Produkty"]) {
      await search.fill("retez");
      await page.getByRole("listbox").waitFor();
      const option = page
        .getByRole("group", { name: group, exact: true })
        .getByRole("option")
        .first();
      const optionId = await option.getAttribute("id");
      for (
        let index = 0;
        index < 12 && (await search.getAttribute("aria-activedescendant")) !== optionId;
        index++
      ) {
        await search.press("ArrowDown");
      }
      assert.equal(await search.getAttribute("aria-activedescendant"), optionId);
      const destination = await option.getAttribute("href");
      assert.ok(destination);
      await search.press("Enter");
      await page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === destination);
      await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
    }
    await search.fill("retez");
    await page.getByRole("link", { name: /Zobrazit všechny produkty/ }).click();
    await page.waitForURL(
      (url) => url.pathname === "/vyhledavani" && url.searchParams.get("q") === "retez",
    );
    await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });
  }

  await page.getByRole("button", { name: "Otevřít navigaci" }).click();
  await page
    .getByRole("dialog", { name: "Menu" })
    .getByRole("link", { name: "Kontakty", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === "/kontakty");
  await page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1920, height: 1000 });
  assert.equal(
    await page
      .locator('.akros-header__utility-links a[href="/kontakty"]')
      .getAttribute("aria-current"),
    "page",
  );
  await page.locator('.akros-footer__bottom-links a[href="/gdpr"]').click();
  await page.waitForURL((url) => url.pathname === "/gdpr");
  assert.deepEqual(errors, []);
  console.log(
    `Shared UI passed ${widths.length} widths: navigation/footer/search tokens, suggestions, keyboard navigation, menu close and footer links.`,
  );
} finally {
  await browser.close();
}
