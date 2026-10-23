import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { cartFixture, checkoutFixture } from "./cart-layout-fixtures.mjs";

const base = process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3000";
const widths = [
  1920, 1440, 1280, 1101, 1100, 1024, 1023, 768, 761, 760, 640, 639, 390, 385, 384, 383, 320,
];
const directory = "test-results/select-appearance";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
let page;
let currentCase = "";
try {
  const errors = [];
  const report = [];

  const cases = [
    {
      route: "/kosik/dodaci-udaje",
      name: "checkout",
      ids: ["billing-country", "delivery-country"],
    },
    {
      route: "/historie-objednavek",
      name: "orders",
      ids: ["account-order-month", "account-order-status"],
    },
    { route: "/muj-ucet", name: "account", ids: ["account-country"] },
    { route: "/kosik/doprava-platba", name: "pickup", ids: ["checkout-pickup"] },
  ];
  for (const surface of cases) {
    for (const width of widths) {
      await page?.close();
      page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(
        ({ cart, checkout }) => {
          if (sessionStorage.getItem("select-test-seeded")) return;
          localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
          sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(checkout));
          sessionStorage.setItem("select-test-seeded", "1");
        },
        {
          cart: {
            ...cartFixture,
            lines: [{ ...cartFixture.lines[0], minimumQuantity: 1, quantity: 1 }],
          },
          checkout:
            surface.name === "pickup"
              ? {
                  ...checkoutFixture,
                  draft: { ...checkoutFixture.draft, deliveryId: "zasilkovna", pickupPointId: "" },
                }
              : checkoutFixture,
        },
      );
      await page.goto(`${base}${surface.route}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      if (surface.name === "checkout") {
        await page.getByRole("button", { name: "Změnit fakturační údaje", exact: true }).click();
        const differentAddress = page.getByRole("checkbox", {
          name: "Zboží chci doručit na jinou adresu než fakturační",
          exact: true,
        });
        if (!(await differentAddress.isChecked()))
          await page
            .getByText("Zboží chci doručit na jinou adresu než fakturační", { exact: true })
            .click();
      }
      if (surface.name === "account") {
        const billing = page
          .locator('[data-scope="accordion"][data-part="item-trigger"]')
          .filter({ hasText: "Fakturační údaje" });
        if ((await billing.getAttribute("aria-expanded")) === "false") await billing.click();
      }
      for (const id of surface.ids) {
        currentCase = `${surface.name}/${id}/${width}`;
        const root = page.locator(`[id="select:${id}"]`);
        const trigger = page.locator(`[id="select:${id}:trigger"]`);
        const popup = page.locator(`[id="select:${id}:content"]`);
        await root.evaluate((element) =>
          element.scrollIntoView({ block: "center", behavior: "instant" }),
        );
        await trigger.evaluate((element) => element.blur());
        await page.mouse.move(0, 0);
        const actual = await trigger.evaluate((element) => {
          const style = getComputedStyle(element);
          const value = getComputedStyle(element.querySelector(".text-select-value-sm"));
          const icon = element.querySelector(".token-icon-select-indicator");
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          context.fillStyle = style.backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return {
            height: element.getBoundingClientRect().height,
            left: style.paddingLeft,
            right: style.paddingRight,
            border: style.borderTopWidth,
            borderColor: style.borderTopColor,
            radius: style.borderTopLeftRadius,
            background: [...context.getImageData(0, 0, 1, 1).data],
            fontSize: value.fontSize,
            fontWeight: value.fontWeight,
            lineHeight: value.lineHeight,
            iconWidth: icon.getBoundingClientRect().width,
            mask: getComputedStyle(icon).maskImage,
            glyphs: element.querySelectorAll('[class*="token-icon-"]').length,
          };
        });
        assert.equal(actual.height, 60, `${id}/${width}: height`);
        assert.equal(actual.left, "24px");
        assert.equal(actual.right, "8px");
        assert.equal(actual.border, "2px");
        assert.equal(actual.borderColor, "rgb(28, 28, 26)");
        assert.equal(actual.radius, "8px");
        assert.deepEqual(actual.background, [255, 255, 255, 255]);
        assert.equal(actual.fontSize, "20px");
        assert.equal(actual.fontWeight, "500");
        assert.equal(actual.lineHeight, "30px");
        assert.equal(actual.iconWidth, 28);
        assert.notEqual(actual.mask, "none");
        assert.equal(actual.glyphs, 1, "one visible kit indicator per select");
        report.push({ surface: surface.name, width, id, ...actual });
        if (surface.name === "account") {
          const phoneArrow = page
            .locator("[data-account-phone-control] .token-icon-akros-account-select-chevron")
            .first();
          assert.equal(
            await phoneArrow.evaluate((element) => getComputedStyle(element).maskImage),
            actual.mask,
            "reuse the original Figma SVG",
          );
          assert.equal(
            await phoneArrow.evaluate((element) => element.getBoundingClientRect().width),
            28,
          );
        }
        if ([1920, 390, 320].includes(width))
          await root.screenshot({ path: `${directory}/${surface.name}-${id}-${width}.png` });
        await trigger.hover();
        assert.equal(
          await trigger.evaluate((element) => getComputedStyle(element).backgroundColor),
          "lab(100 0 0)",
        );
        if (width >= 1024) await trigger.press("Enter");
        else await trigger.click();
        await page.waitForFunction(
          (id) =>
            document.getElementById(`select:${id}:trigger`)?.getAttribute("aria-expanded") ===
            "true",
          id,
        );
        await popup.getByRole("option").first().waitFor();
        await popup.evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => animation.finished.catch(() => {})),
          ),
        );
        await page.waitForFunction((id) => {
          const icon = document
            .getElementById(`select:${id}:trigger`)
            ?.querySelector(".token-icon-select-indicator");
          return icon && getComputedStyle(icon).rotate === "180deg";
        }, id);
        assert.equal(
          await trigger
            .locator(".token-icon-select-indicator")
            .evaluate((element) => getComputedStyle(element).rotate),
          "180deg",
        );
        const bounds = await popup.boundingBox();
        assert.ok(
          bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
          `${id}/${width}: popup overflow`,
        );
        if (width >= 1024) {
          await page.waitForFunction(
            (id) => document.getElementById(`select:${id}:content`) === document.activeElement,
            id,
            { timeout: 5000 },
          );
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
        } else {
          await popup.getByRole("option").first().click();
        }
        await page.waitForFunction(
          (id) =>
            document.getElementById(`select:${id}:trigger`)?.getAttribute("aria-expanded") ===
            "false",
          id,
        );
        await popup.waitFor({ state: "hidden" });
        await page.waitForFunction(
          (id) => document.getElementById(`select:${id}:trigger`) === document.activeElement,
          id,
        );
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${surface.name}/${width}: page overflow`,
      );
      if (surface.name === "checkout") {
        const phone = page.getByLabel("Telefonní předvolba", { exact: true }).first();
        assert.equal(
          await phone
            .locator(".token-icon-select-indicator")
            .evaluate((element) => element.getBoundingClientRect().width),
          16,
          "checkout phone picker keeps its own glyph size",
        );
      }
      if (surface.name === "pickup") {
        const overlappingMethods = await page
          .locator('[data-akros-checkout-methods] [data-scope="radio-group"][data-part="item"]')
          .evaluateAll((items) =>
            items
              .filter((item) => {
                const content = item.querySelector(".col-start-3");
                const range = document.createRange();
                range.selectNodeContents(content);
                const text = range.getBoundingClientRect();
                const price = item.lastElementChild.getBoundingClientRect();
                return (
                  Math.min(text.right, price.right) - Math.max(text.left, price.left) > 1 &&
                  Math.min(text.bottom, price.bottom) - Math.max(text.top, price.top) > 1
                );
              })
              .map((item) => item.innerText),
          );
        assert.deepEqual(
          overlappingMethods,
          [],
          `method names and prices do not overlap at ${width}`,
        );
      }
    }
    if (surface.name === "orders") {
      await page.locator('[id="select:account-order-status:trigger"]').click();
      await page.getByRole("option", { name: "Odesláno", exact: true }).click();
      await page.getByText("Zobrazeno 1 z 5 objednávek", { exact: true }).waitFor();
    }
    if (surface.name === "pickup") {
      await page.evaluate(() => {
        const stored = JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1"));
        stored.draft.pickupPointId = "";
        sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify(stored));
      });
      await page.reload();
      await page.getByRole("button", { name: /dodac/i }).click();
      const trigger = page.locator('[id="select:checkout-pickup:trigger"]');
      assert.equal(await trigger.getAttribute("data-validation"), "error");
      assert.equal(
        await trigger.evaluate((element) => getComputedStyle(element).paddingLeft),
        "24px",
      );
      assert.notEqual(
        await trigger.evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(28, 28, 26)",
      );
      await trigger.click();
      await page.getByRole("option").last().click();
      assert.equal(
        await page.evaluate(
          () => JSON.parse(sessionStorage.getItem("akros-demo-checkout-v1")).draft.pickupPointId,
        ),
        "zasilkovna-brno",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        "long selected pickup point fits the narrowest viewport",
      );
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    `Selects: ${report.length} Figma appearance checks across ${widths.length} widths, keyboard/pointer selection, indicator rotation, original SVG, phone isolation, order filtering and pickup validation passed.`,
  );
} catch (error) {
  await page.screenshot({ path: `${directory}/failure.png` });
  console.error(
    currentCase,
    await page.evaluate(() => ({
      active: document.activeElement.id,
      selects: [...document.querySelectorAll('.akros-select [data-part="trigger"]')].map(
        (element) => ({
          id: element.id,
          expanded: element.getAttribute("aria-expanded"),
          rect: element.getBoundingClientRect().toJSON(),
        }),
      ),
    })),
  );
  throw error;
} finally {
  await browser.close();
}
