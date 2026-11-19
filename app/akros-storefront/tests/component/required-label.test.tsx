import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormInput, FormTextarea } from "@/components/form-controls";
import { MarketProvider } from "@/ontos/market-context";

afterEach(cleanup);

describe.each([
  ["cs", "(povinné)"],
  ["sk", "(povinné)"],
  ["en", "(required)"],
])("required labels in the %s market", (locale, requiredLabel) => {
  it("announces a required field in the market language but not an optional field", () => {
    render(
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
        <FormInput id="name" label="Name" required />
        <FormTextarea id="message" label="Message" required />
        <FormInput id="optional" label="Optional" />
      </MarketProvider>,
    );
    const requiredName = (label: string) => (name: string) =>
      name.replaceAll(/\s/gu, "") === `${label}${requiredLabel}`;
    expect(screen.getByRole("textbox", { name: requiredName("Name") })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: requiredName("Message") })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Optional" })).toBeTruthy();
  });
});
