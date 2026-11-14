import { PhoneInput } from "@techsio/ui-kit/molecules/phone-input";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContactForm } from "@/components/contact-form";
import {
  Combobox,
  FormInput,
  FormTextarea,
  PhoneInputLabel,
  RadioGroupLabel,
} from "@/components/form-controls";
import { MarketProvider } from "@/ontos/market-context";

const html = (locale: string, children: ReactNode) =>
  renderToString(
    <MarketProvider
      market={{
        locale,
        marketCode: `TEST-${locale}`,
        currency: "EUR",
        formatLocale: locale,
        configured: true,
        live: [],
      }}
    >
      {children}
    </MarketProvider>,
  );

/** Inner HTML of the `<label>` that names the control with `id`. */
const labelOf = (markup: string, id: string) => {
  const label = new RegExp(`<label[^>]*\\sfor="${id}"[^>]*>(.*?)</label>`, "su").exec(markup);
  if (!label) throw new Error(`No label for ${id}`);
  return label[1];
};
const marker = (text: string) =>
  `<span aria-hidden="true" class="ms-label-required text-label-fg-required">*</span><span class="sr-only"> ${text}</span>`;

describe.each([
  ["cs", "(povinné)"],
  ["sk", "(povinné)"],
  ["en", "(required)"],
] as const)("required fields in the %s market", (locale, text) => {
  it("reads the market-language text after the marker of a required contact field", () => {
    const markup = html(locale, <ContactForm />);

    for (const id of ["contact-name", "contact-email", "contact-message"]) {
      expect(labelOf(markup, id)).toContain(marker(text));
    }
    expect(markup.includes("(required)")).toBe(locale === "en");
  });

  it("gives every shared control the same text", () => {
    const markup = html(
      locale,
      <>
        <FormInput id="input" label="Input" required />
        <FormTextarea id="textarea" label="Textarea" required />
        <Combobox id="combobox" items={[]} label="Combobox" portalled={false} required />
        <PhoneInput id="phone" required>
          <PhoneInputLabel>Phone</PhoneInputLabel>
        </PhoneInput>
        <RadioGroup id="radio" required>
          <RadioGroupLabel>Radio</RadioGroupLabel>
        </RadioGroup>
      </>,
    );

    expect(markup.split(marker(text))).toHaveLength(6);
    expect(markup.includes("(required)")).toBe(locale === "en");
  });

  it("leaves an optional field without the marker", () => {
    expect(html(locale, <FormInput id="optional" label="Optional" />)).not.toContain("sr-only");
  });
});
