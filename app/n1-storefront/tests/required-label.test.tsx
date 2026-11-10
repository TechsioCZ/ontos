import { describe, expect, it, rs } from "@rstest/core";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LocaleLayout from "../src/app/[locale]/layout";
import { CheckoutShipping } from "../src/features/checkout-panels";
import { FormInput, FormInputRaw, FormTextarea } from "../src/features/form-controls";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import { getDictionary } from "../src/i18n";

// The layout's owner reads and chrome are not part of this suite; its providers and the forms are real.
rs.mock("../src/ontos/catalog", () => ({ getCatalog: async () => ({ state: "unavailable" }) }));
rs.mock("../src/ontos/cart-quote-server", () => ({ getCartScope: () => Effect.succeed(null) }));
rs.mock("../src/features/cart-provider", () => ({
  CartProvider: ({ children }: { children: ReactNode }) => children,
}));
rs.mock("../src/features/shell", () => ({
  StorefrontShell: ({ children }: { children: ReactNode }) => children,
}));

const marker = (text: string) =>
  `<span aria-hidden="true" class="ms-label-required text-label-fg-required">*</span><span class="sr-only"> ${text}</span>`;
const inLayout = async (locale: string, children: ReactNode) =>
  renderToStaticMarkup(await LocaleLayout({ children, params: Promise.resolve({ locale }) }));
const controls = (
  <>
    <FormInput id="input" label="Input" required />
    <FormInputRaw id="raw" label="Raw" required />
    <FormTextarea id="textarea" label="Textarea" required />
  </>
);

describe.each([
  ["cs", "(povinné)"],
  ["en", "(required)"],
] as const)("required fields under the %s locale layout", (locale, text) => {
  const d = getDictionary(locale);

  it("reads the page-language text after the marker of a required form field", async () => {
    const html = await inLayout(
      locale,
      <PasswordRecoveryView dictionary={d} locale={locale} mode="request" />,
    );

    expect(html).toContain(`${d.auth.fields.email}${marker(text)}</label>`);
    expect(html.includes("(required)")).toBe(locale === "en");
  });

  it("reads it after the marker of the required shipping choice", async () => {
    const html = await inLayout(
      locale,
      <CheckoutShipping
        dictionary={d}
        disabled={false}
        locale={locale}
        onChange={() => {}}
        options={{
          countryCodes: ["CZ"],
          paymentAvailable: false,
          scope: {
            currency: "CZK",
            legalEntityId: "71000000-0000-4000-8000-000000000099",
            marketId: "market-1",
            tenantId: "71000000-0000-4000-8000-000000000098",
          },
          shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL" }],
          state: "ready",
        }}
        value="PPL"
      />,
    );

    expect(html).toContain(`${d.checkout.shipping}${marker(text)}</label>`);
    expect(html.includes("(required)")).toBe(locale === "en");
  });

  it("gives every shared control the same text", async () => {
    const html = await inLayout(locale, controls);

    expect(html.split(marker(text))).toHaveLength(4);
    expect(html.includes("(required)")).toBe(locale === "en");
  });
});

it("keeps the UI-kit text outside the locale layout", () => {
  expect(renderToStaticMarkup(controls).split(marker("(required)"))).toHaveLength(4);
});
