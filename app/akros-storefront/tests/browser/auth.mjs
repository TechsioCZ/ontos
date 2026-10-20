import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch(
  process.env.AKROS_CHROMIUM_PATH
    ? { executablePath: process.env.AKROS_CHROMIUM_PATH }
    : { channel: "chrome" },
);
const widths = [1920, 1536, 1280, 1024, 961, 960, 768, 761, 760, 640, 639, 390, 320];
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1000 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  for (const [route, selector] of [
    ["/prihlaseni", ".akros-auth-page"],
    ["/registrace", ".akros-registration-page"],
  ]) {
    await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
    const root = page.locator(selector);
    await root.locator("h1").waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      const failures = await root.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        const failures = [];
        if (root.scrollWidth > root.clientWidth + 1) failures.push("Form content overflows");
        for (const element of root.querySelectorAll("input, button, a")) {
          if (element.matches('input[type="checkbox"]')) continue;
          const rect = element.getBoundingClientRect();
          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
            failures.push(`Control outside page: ${element.id || element.textContent}`);
        }
        return failures;
      });
      assert.deepEqual(failures, [], `${route} at ${width}px`);
      for (const link of await root.locator("[data-akros-auth-link]").all()) {
        const previous = await link.getAttribute("style");
        try {
          await link.evaluate((element) => {
            element.style.setProperty("--font-weight-button", "500");
            element.style.setProperty("--color-button-fg-secondary-borderless", "rgb(12, 34, 56)");
          });
          const style = await link.evaluate((element) => {
            const s = getComputedStyle(element);
            return { weight: s.fontWeight, color: s.color };
          });
          assert.deepEqual(style, { weight: "500", color: "rgb(12, 34, 56)" });
        } finally {
          await link.evaluate((element, previous) => {
            if (previous === null) element.removeAttribute("style");
            else element.setAttribute("style", previous);
          }, previous);
        }
      }
    }
  }

  for (const width of [1920, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(new URL("/prihlaseni", base).href, { waitUntil: "domcontentloaded" });
    const email = page.locator("#login-email");
    const password = page.locator("#login-password");
    const submit = page.getByRole("button", { name: "Přihlásit se", exact: true });
    await submit.click();
    assert.equal(await email.evaluate((element) => element.validity.valueMissing), true);
    assert.equal(await email.evaluate((element) => element === document.activeElement), true);
    await email.fill("invalid-email");
    await password.fill("demo-password-only");
    await submit.click();
    assert.equal(await email.evaluate((element) => element.validity.typeMismatch), true);
    assert.equal(new URL(page.url()).pathname, "/prihlaseni");
    const recovery = page.getByRole("link", { name: "Zapomenuté heslo?", exact: true });
    await recovery.focus();
    await page.keyboard.press("Enter");
    assert.equal(await password.evaluate((element) => element === document.activeElement), true);
    await email.fill("auth-check@example.test");
    await submit.click();
    await page.waitForURL("**/muj-ucet");
    await page.locator("#account-email").waitFor();

    await page.goto(new URL("/prihlaseni", base).href, { waitUntil: "domcontentloaded" });
    const registration = page.getByRole("link", { name: "Vytvořte si ho zde", exact: true });
    await registration.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/registrace");
    const create = page.getByRole("button", { name: "Vytvořit účet", exact: true });
    await create.click();
    assert.equal(
      await page.locator("#register-first-name").evaluate((e) => e.validity.valueMissing),
      true,
    );
    for (const [id, value] of [
      ["first-name", "Browser"],
      ["last-name", "Test"],
      ["email", "auth-check@example.test"],
      ["phone", "+420777123456"],
      ["password", "demo-password-only"],
      ["password-confirm", "demo-password-only"],
    ])
      await page.locator(`#register-${id}`).fill(value);
    await create.click();
    assert.equal(await page.locator(".akros-form-success").count(), 0);
    assert.equal(
      await page
        .locator('input[type="checkbox"][required]')
        .evaluate((e) => e.validity.valueMissing),
      true,
    );
    await page
      .getByRole("checkbox", { name: /^Souhlasím s obchodními podmínkami/ })
      .locator("..")
      .locator('[data-part="control"]')
      .click();
    await create.click();
    await page
      .getByText("Ukázkový účet byl vytvořen pouze pro tuto stránku.", { exact: true })
      .waitFor();
    const storage = await page.evaluate(() => [
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
    ]);
    assert.doesNotMatch(JSON.stringify(storage), /demo-password-only|auth-check@example\.test/);
    await page.getByRole("link", { name: "Přihlaste se zde", exact: true }).click();
    await page.waitForURL("**/prihlaseni");
    assert.equal(await page.locator("#login-password").inputValue(), "");
    console.log(
      `Auth passed ${width}px: native validation, keyboard links, demo login/registration and credential isolation.`,
    );
  }
  assert.deepEqual(errors, [], "Auth flows must not produce browser runtime errors");
  console.log(
    `Auth layout/token checks passed ${widths.length * 2} layouts at ${widths.length} widths.`,
  );
} finally {
  await browser.close();
}
