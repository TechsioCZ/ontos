import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ReactNode } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  PathParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import LocaleLayout from "../src/app/[locale]/layout";
import { CheckoutShipping } from "../src/features/checkout-panels";
import { FormInput, FormInputRaw, FormTextarea } from "../src/features/form-controls";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import { getDictionary } from "../src/i18n";

const serverNavigation = () => {
  throw new Error("Navigation must not run during server rendering");
};
const router = {
  back: serverNavigation,
  bfcacheId: "required-label",
  forward: serverNavigation,
  prefetch: serverNavigation,
  push: serverNavigation,
  refresh: serverNavigation,
  replace: serverNavigation,
} satisfies AppRouterInstance;

beforeEach(() => {
  // Missing service configuration is a real fail-closed bootstrap, with no owner IO.
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "");
});
afterEach(() => {
  rs.unstubAllEnvs();
});

const labelText = (html: string) =>
  [...html.matchAll(/<label\b[^>]*>(?<text>[\s\S]*?)<\/label>/gu)].map((match) =>
    (match.groups?.text ?? "")
      .replaceAll(/<[^>]+>/gu, "")
      .replaceAll(/\s+/gu, " ")
      .trim(),
  );
const localeParams = { cs: { locale: "cs" }, en: { locale: "en" } };
const inLayout = async (locale: keyof typeof localeParams, children: ReactNode) => {
  const pathname = `/${locale}/zapomenute-heslo`;
  const layout = await LocaleLayout({ children, params: Promise.resolve({ locale }) });
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <PathParamsContext.Provider value={localeParams[locale]}>
          {layout}
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
};
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

    expect(labelText(html)).toContain(`${d.auth.fields.email}* ${text}`);
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

    expect(labelText(html)).toContain(`${d.checkout.shipping}* ${text}`);
    expect(html.includes("(required)")).toBe(locale === "en");
  });

  it("gives every shared control the same text", async () => {
    const html = await inLayout(locale, controls);

    expect(labelText(html).filter((label) => label.endsWith(`* ${text}`))).toEqual([
      `Input* ${text}`,
      `Raw* ${text}`,
      `Textarea* ${text}`,
    ]);
    expect(html.includes("(required)")).toBe(locale === "en");
  });
});
