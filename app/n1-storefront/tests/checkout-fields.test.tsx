import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { checkoutFieldError } from "../src/features/checkout-field-validation";
import { CheckoutFields } from "../src/features/checkout-fields";
import { getDictionary } from "../src/i18n";
import { CheckoutRequestSchema } from "../src/ontos/checkout";

const render = (locale: string, countryCodes: readonly string[]) =>
  renderToStaticMarkup(
    <CheckoutFields
      countryCodes={countryCodes}
      dictionary={getDictionary(locale)}
      disabled={false}
      locale={locale}
      onEdit={() => {}}
    />,
  );

describe("checkout field validation", () => {
  it.effect("requires a dotted email domain before the native checkout request", () =>
    Effect.sync(() => {
      const html = render("cs", ["CZ"]);
      const email = /<input[^>]*name="email"[^>]*>/u.exec(html)?.[0];
      const pattern = /pattern="(?<pattern>[^"]+)"/u.exec(email ?? "")?.groups?.pattern;
      expect(pattern).toBeDefined();
      const accepts = new RegExp(`^(?:${pattern})$`, "u");
      expect(accepts.test("customer@example.cz")).toBe(true);
      expect(accepts.test("customer@example")).toBe(false);
      expect(accepts.test("customer example@shop.cz")).toBe(false);
      const nativeAccepts = Schema.is(CheckoutRequestSchema.fields.contact.fields.email);
      for (const value of ["customer@example.cz", "customer@example", "customer example@shop.cz"]) {
        expect(accepts.test(value)).toBe(nativeAccepts(value));
      }
    }),
  );

  it.effect(
    "does not show errors before interaction or impose Czech postal rules on a market",
    () =>
      Effect.sync(() => {
        const html = render("en", ["GB"]);
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('aria-invalid="true"');
        const postal = /<input[^>]*name="postalCode"[^>]*>/u.exec(html)?.[0];
        expect(postal).toContain('minLength="3"');
        expect(postal).toContain('maxLength="12"');
        const pattern = /pattern="(?<pattern>[^"]+)"/u.exec(postal ?? "")?.groups?.pattern;
        const accepts = new RegExp(`^(?:${pattern})$`, "u");
        expect(accepts.test("SW1A 1AA")).toBe(true);
        expect(accepts.test("123")).toBe(true);
      }),
  );

  it.effect("uses the Figma required-name message only for a missing or blank first name", () =>
    Effect.sync(() => {
      const d = getDictionary("cs");
      expect(
        checkoutFieldError(
          "firstName",
          { patternMismatch: false, valid: false, valueMissing: true },
          d,
        ),
      ).toBe("Jméno je povinné");
      expect(
        checkoutFieldError(
          "firstName",
          { patternMismatch: true, valid: false, valueMissing: false },
          d,
        ),
      ).toBe("Jméno je povinné");
      expect(
        checkoutFieldError(
          "firstName",
          { patternMismatch: false, valid: false, valueMissing: false },
          d,
        ),
      ).toBe(d.checkout.invalidField);
    }),
  );

  it.effect("uses field-specific email guidance and clears valid fields in both languages", () =>
    Effect.sync(() => {
      for (const locale of ["cs", "en"]) {
        const d = getDictionary(locale);
        expect(
          checkoutFieldError(
            "email",
            { patternMismatch: true, valid: false, valueMissing: false },
            d,
          ),
        ).toBe(d.checkout.errors.email);
        expect(
          checkoutFieldError(
            "email",
            { patternMismatch: false, valid: true, valueMissing: false },
            d,
          ),
        ).toBeUndefined();
        expect(
          checkoutFieldError(
            "postalCode",
            { patternMismatch: false, valid: false, valueMissing: true },
            d,
          ),
        ).toBe(d.checkout.invalidField);
      }
    }),
  );
});
