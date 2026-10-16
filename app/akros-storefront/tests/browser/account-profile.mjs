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
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.setDefaultNavigationTimeout(120000);
  await page.goto(new URL("/muj-ucet", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#account-email").waitFor({ timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root: documentRoot } = await cdp.send("DOM.getDocument");
  for (const selector of [
    "[data-akros-account] nav a",
    "[data-akros-account] h2",
    "#account-firstName",
  ]) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: documentRoot.nodeId,
      selector,
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(
      fonts.length > 0 &&
        fonts.every((font) => font.isCustomFont && font.familyName.startsWith("Inter")),
      `Local Inter must render ${selector}`,
    );
  }
  const failures = await page.locator("[data-akros-account]").evaluate((root) => {
    const errors = [];
    const body = root.querySelector("[data-akros-account-body]").getBoundingClientRect();
    const availableWidth = document.documentElement.getBoundingClientRect().width;
    if (Math.abs(body.left - (availableWidth - 1660) / 2) > 1 || Math.abs(body.width - 1660) > 1)
      errors.push("Desktop frame differs from Figma");
    const section = root.querySelector('section[aria-label="Můj účet"]').getBoundingClientRect();
    if (Math.abs(section.width - 1660) > 1) errors.push("Main column differs from Figma 7:2085");
    if (root.querySelector("[data-akros-cart-selector]"))
      errors.push("Figma 7:2085 has no visible cart sidebar");
    const input = root.querySelector("#account-firstName"),
      style = getComputedStyle(input);
    if (
      parseFloat(style.fontSize) !== 20 ||
      style.fontWeight !== "500" ||
      style.borderTopWidth !== "2px" ||
      style.paddingLeft !== "24px" ||
      style.paddingRight !== "24px" ||
      Math.abs(input.getBoundingClientRect().height - 60) > 1
    )
      errors.push("Input typography/border/height differs from Figma");
    const title = root.querySelector('[data-scope="accordion"] button span'),
      ts = getComputedStyle(title);
    if (
      parseFloat(ts.fontSize) !== 25 ||
      ts.fontWeight !== "700" ||
      Math.abs(parseFloat(ts.lineHeight) - 30) > 0.2
    )
      errors.push(`Section title mismatch: ${ts.fontSize}/${ts.fontWeight}/${ts.lineHeight}`);
    if (
      getComputedStyle(root.querySelector('nav[aria-label="Navigace účtu"] [aria-current="page"]'))
        .fontWeight !== "800"
    )
      errors.push("Active navigation must use Inter Extra Bold from Figma 7:2085");
    const nav = root.querySelector('nav[aria-label="Navigace účtu"]');
    const tops = new Set([...nav.children].map((item) => item.getBoundingClientRect().top));
    if (tops.size !== 1) errors.push("Desktop account navigation must fit on one row");
    for (const item of nav.children) {
      const s = getComputedStyle(item);
      if (
        s.fontSize !== "20px" ||
        s.lineHeight !== "30px" ||
        Math.abs(item.getBoundingClientRect().height - 62) > 0.2
      )
        errors.push(`Navigation typography/height differs from Figma: ${item.textContent}`);
      if (s.paddingLeft !== "16px" || s.paddingRight !== "16px")
        errors.push(`Navigation padding differs from Figma 7:2085: ${item.textContent}`);
    }
    const figmaNavTextWidths = [121, 86, 114, 135, 106, 105, 142, 144];
    [...nav.children].forEach((item, i) => {
      const text = document.createRange();
      text.selectNodeContents(item);
      if (Math.abs(text.getBoundingClientRect().width - figmaNavTextWidths[i]) > 1)
        errors.push(`Inter text width differs from Figma: ${item.textContent}`);
    });
    if (getComputedStyle(root).fontOpticalSizing !== "none")
      errors.push("Automatic Inter optical sizing differs from the Figma text metrics");
    for (const selector of [
      'label[for="account-email"]',
      "#account-email",
      "#account-city",
      ".text-select-value-sm",
    ]) {
      const s = getComputedStyle(root.querySelector(selector));
      if (s.fontSize !== "20px" || s.fontWeight !== "500" || s.lineHeight !== "30px")
        errors.push(
          `Form typography differs from Figma: ${selector} ${s.fontSize}/${s.fontWeight}/${s.lineHeight}`,
        );
    }
    const textSamples = [
      ['nav[aria-label="Drobečková navigace"] a', 16, 500, 24],
      ['[data-scope="accordion"] h2', 25, 700, 30],
      ['form button[type="submit"]', 20, 700, 24],
    ];
    for (const [selector, size, weight, line] of textSamples) {
      const element = root.querySelector(selector);
      if (!element) {
        errors.push(`Missing typography sample: ${selector}`);
        continue;
      }
      const s = getComputedStyle(element);
      if (
        parseFloat(s.fontSize) !== size ||
        Number(s.fontWeight) !== weight ||
        Math.abs(parseFloat(s.lineHeight) - line) > 0.2
      )
        errors.push(
          `Account text differs from Figma: ${selector} ${s.fontSize}/${s.fontWeight}/${s.lineHeight}`,
        );
    }
    const countryLabel = [...root.querySelectorAll("label")].find(
      (label) => label.textContent === "Země",
    );
    if (
      !countryLabel ||
      getComputedStyle(countryLabel).fontSize !== "20px" ||
      getComputedStyle(countryLabel).lineHeight !== "30px"
    )
      errors.push("Country label must use the same 20/30px typography as the fields");
    const icon = root.querySelector(".token-icon-akros-account-disclosure");
    if (
      !icon ||
      getComputedStyle(icon).maskImage === "none" ||
      Math.abs(icon.getBoundingClientRect().width - 24) > 0.2
    )
      errors.push(
        `Original disclosure icon missing: ${icon ? JSON.stringify({ width: icon.getBoundingClientRect().width, font: getComputedStyle(icon).fontSize, mask: getComputedStyle(icon).maskImage }) : "no element"}`,
      );
    for (const icon of root.querySelectorAll(".token-icon-akros-account-select-chevron")) {
      if (
        getComputedStyle(icon).maskImage === "none" ||
        Math.abs(icon.getBoundingClientRect().width - 28) > 0.2
      )
        errors.push("Original Figma select arrow must render at 28px");
    }
    if (root.querySelectorAll(".token-icon-akros-account-select-chevron").length !== 3)
      errors.push("Both phone pickers and country select must use the original Figma arrow");
    const phoneTrigger = root.querySelector('[data-account-phone-control] [data-part="trigger"]');
    const phoneStyle = getComputedStyle(phoneTrigger);
    if (
      Math.abs(phoneTrigger.getBoundingClientRect().width - 164) > 0.2 ||
      phoneStyle.borderTopWidth !== "2px" ||
      phoneStyle.paddingLeft !== "24px" ||
      phoneStyle.paddingRight !== "8px"
    )
      errors.push("Phone country trigger differs from Figma width/border/padding");
    for (const button of root.querySelectorAll("[data-account-action]")) {
      if (Math.abs(button.getBoundingClientRect().height - 58) > 0.2)
        errors.push("Account action height differs from Figma 7:2085");
    }
    for (const flag of root.querySelectorAll("[data-account-phone-control] img")) {
      const rect = flag.getBoundingClientRect();
      if (
        !flag.complete ||
        !flag.naturalWidth ||
        Math.abs(rect.width - 40) > 0.2 ||
        Math.abs(rect.height - 40) > 0.2
      )
        errors.push("Original country flag must render in the Figma 40px slot");
    }
    return errors;
  });
  assert.deepEqual(failures, []);
  for (const width of [1920, 1536, 1535, 1280, 1024, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator("[data-akros-account]").evaluate((e) => e.scrollWidth - e.clientWidth),
      0,
      `Account overflow at ${width}px`,
    );
    const navigation = await page
      .getByRole("navigation", { name: "Navigace účtu", exact: true })
      .evaluate((nav) => {
        const bounds = nav.getBoundingClientRect();
        return {
          overflow: nav.scrollWidth - nav.clientWidth,
          rows: new Set([...nav.children].map((item) => item.getBoundingClientRect().top)).size,
          clipped: [...nav.children]
            .filter((item) => {
              const r = item.getBoundingClientRect();
              return (
                r.left < bounds.left - 1 ||
                r.right > bounds.right + 1 ||
                r.bottom > bounds.bottom + 1
              );
            })
            .map((item) => item.textContent),
        };
      });
    assert.equal(navigation.overflow, 0, `Account navigation scroll at ${width}px`);
    assert.deepEqual(navigation.clipped, [], `Clipped account navigation at ${width}px`);
    if ([1920, 1536, 1535].includes(width))
      assert.equal(navigation.rows, 1, `Account navigation should fit one row at ${width}px`);
    const emailWidth = await page
      .locator("#account-email")
      .evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(
      emailWidth <= 569,
      `Account fields stretch beyond Figma width at ${width}px: ${emailWidth}`,
    );
    const fieldPadding = await page
      .locator("#account-email")
      .evaluate((e) => getComputedStyle(e).paddingLeft);
    assert.equal(fieldPadding, "24px", `Field padding must match Figma at ${width}px`);
    assert.equal(
      await page.locator("[data-akros-account] [data-akros-cart-selector]").count(),
      0,
      `Account must not render the hidden cart sidebar at ${width}px`,
    );
    if (screenshots && [1920, 1280, 768, 390].includes(width)) {
      await mkdir(screenshots, { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(screenshots, `account-${width}.png`), fullPage: true });
    }
  }
  await page.locator("#account-city").fill("Brno");
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page.getByText("Údaje byly uložené v tomto prohlížeči.", { exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#account-city").waitFor();
  assert.equal(await page.locator("#account-city").inputValue(), "Brno");
  await page.locator("#account-email").fill("bad-email");
  await page.getByRole("button", { name: "Kontaktní údaje", exact: true }).click();
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page.getByText("Zadejte platný e-mail.", { exact: true }).waitFor();
  const errorStyle = await page
    .getByText("Zadejte platný e-mail.", { exact: true })
    .evaluate((e) => {
      const s = getComputedStyle(e);
      return { size: s.fontSize, line: s.lineHeight, color: s.color };
    });
  assert.deepEqual(
    errorStyle,
    { size: "20px", line: "30px", color: "rgb(255, 0, 0)" },
    "Figma field error typography",
  );
  assert.equal(
    await page.locator('label[for="account-email"]').evaluate((e) => getComputedStyle(e).color),
    "rgb(255, 0, 0)",
    "Figma error label color",
  );
  assert.equal(await page.locator("#account-email").isVisible(), true);
  await page.locator("#account-email").fill("test@example.cz");
  await page.getByText("Chci odebírat novinky", { exact: true }).click();
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page
    .getByText("Pro odběr novinek potvrďte souhlas se zpracováním osobních údajů.", { exact: true })
    .waitFor();
  await page
    .locator("label")
    .filter({ has: page.locator("#account-privacy") })
    .locator('[data-part="control"]')
    .click();
  await page.getByRole("button", { name: "Doručovací adresa", exact: true }).click();
  await page.locator("#account-deliveryStreet").fill("Lipová 1");
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page.getByText("Vyplňte město.", { exact: true }).waitFor();
  await page.locator("#account-deliveryCity").fill("Brno");
  await page.locator("#account-deliveryPostalCode").fill("60200");
  await page.locator("#account-password").fill("never-persist-me");
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  const passwordFeedback = page.getByText(
    "Změna hesla není připojena k účtu. Pro uložení ostatních údajů vymažte pole hesla.",
    { exact: true },
  );
  await passwordFeedback.waitFor().catch(async (error) => {
    console.error("Password submit state:", await page.locator("form").innerText());
    throw error;
  });
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("akros-demo-account-profile-v1").includes("never-persist-me"),
    ),
    false,
  );
  await page.locator("#account-password").fill("");
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page.getByText("Údaje byly uložené v tomto prohlížeči.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Načíst data z ARES", exact: true }).click();
  await page
    .getByText("ARES není v této ukázce připojený. Firemní údaje můžete vyplnit ručně.", {
      exact: true,
    })
    .waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };
  });
  await page.getByRole("button", { name: "Změnit údaje", exact: true }).click();
  await page
    .getByText("Údaje se nepodařilo uložit. Povolte úložiště prohlížeče a zkuste to znovu.", {
      exact: true,
    })
    .waitFor();
  const sibling = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  for (const route of [
    "/muj-ucet/prehled",
    "/historie-objednavek",
    "/oblibene",
    "/sledovani-zasilky",
  ]) {
    const response = await sibling.goto(new URL(route, base).href, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response.status(), 200, `Existing account route ${route}`);
    await sibling.locator("h1").first().waitFor();
  }
  await sibling.close();
  console.log(
    "Account passed 9 widths with complete navigation and no local horizontal scroll, local Inter/Figma typography and field widths, save/reload, error expansion, consent and optional delivery validation; credentials are not persisted.",
  );
} finally {
  await browser.close();
}
