import { describe, expect, it } from "effect-rstest";
import { renderToStaticMarkup } from "react-dom/server";
import { CartQuoteFeedback } from "../src/features/cart-quote-feedback";
import { verifiedCartQuote } from "../src/features/cart-quote-state";
import type { CartQuoteFeedbackState } from "../src/features/cart-quote-state";
import { getDictionary } from "../src/i18n";
import type { CartQuote } from "../src/ontos/cart-quote";
import { hasInvalidCartDraft } from "../src/features/cart-validation";
import { cartLineKey } from "../src/features/cart-state";

const result: CartQuote = {
  issues: [],
  outcome: "VALID",
  scope: {
    currency: "CZK",
    legalEntityId: "71000000-0000-4000-8000-000000000002",
    marketId: "n1-cz",
    tenantId: "71000000-0000-4000-8000-000000000001",
  },
  totalMinor: 12_100,
  totalVatMinor: 2100,
};
const d = getDictionary("cs");

describe("cart feedback without technical captions", () => {
  it("keeps idle, background refresh and successful validation silent", () => {
    for (const state of ["idle", "pending", "ready"] as const) {
      const html = renderToStaticMarkup(
        <CartQuoteFeedback dictionary={d} invalid={false} quote={{ result, state }} />,
      );
      expect(html).toBe("");
    }
  });

  it("never treats stale or contradictory results as permission to check out", () => {
    for (const state of ["idle", "pending", "unavailable", "scope-mismatch"] as const) {
      expect(verifiedCartQuote({ result, state }, false)).toBeNull();
    }
    expect(verifiedCartQuote({ result, state: "ready" }, true)).toBeNull();
    expect(
      verifiedCartQuote(
        { result: { ...result, issues: [{ code: "PRICE_CHANGED" }] }, state: "ready" },
        false,
      ),
    ).toBeNull();
  });

  it.each(["unavailable", "scope-mismatch"] as const)("keeps actionable %s feedback", (state) => {
    const html = renderToStaticMarkup(
      <CartQuoteFeedback dictionary={d} invalid={false} quote={{ result: null, state }} />,
    );
    expect(html).toContain(
      state === "unavailable" ? d.checkout.unavailable : d.shopping.marketChanged,
    );
    expect(html).toContain('aria-live="polite"');
  });

  it.each(["cs", "en"] as const)(
    "describes blocked checkout instead of a failed cart edit in %s",
    (locale) => {
      const dictionary = getDictionary(locale);
      const quote: CartQuoteFeedbackState = { result: null, state: "unavailable" };
      const html = renderToStaticMarkup(
        <CartQuoteFeedback dictionary={dictionary} invalid={false} quote={quote} />,
      );
      expect(html).toContain(dictionary.checkout.unavailable);
      expect(html).not.toContain(dictionary.shopping.addFailed);
      expect(verifiedCartQuote(quote, false)).toBeNull();
    },
  );

  it("announces duplicate global issues and repeated unknown fallbacks only once", () => {
    const html = renderToStaticMarkup(
      <CartQuoteFeedback
        dictionary={d}
        invalid={false}
        quote={{
          result: {
            ...result,
            issues: [
              { code: "MARKET_UNAVAILABLE" },
              { code: "MARKET_UNAVAILABLE" },
              { code: "FUTURE_OWNER_REASON_A" },
              { code: "FUTURE_OWNER_REASON_B" },
              { code: "OUT_OF_STOCK", productId: "p1" },
            ],
            outcome: "REJECTED",
          },
          state: "ready",
        }}
      />,
    );
    expect(html.split(d.shopping.issues.MARKET_UNAVAILABLE)).toHaveLength(2);
    expect(html.split(d.shopping.rejected)).toHaveLength(2);
    expect(html).not.toContain(d.shopping.issues.OUT_OF_STOCK);
  });

  it("preserves different actionable global issues", () => {
    const html = renderToStaticMarkup(
      <CartQuoteFeedback
        dictionary={d}
        invalid={false}
        quote={{
          result: {
            ...result,
            issues: [{ code: "MARKET_UNAVAILABLE" }, { code: "PRICE_UNAVAILABLE" }],
            outcome: "REJECTED",
          },
          state: "ready",
        }}
      />,
    );
    expect(html).toContain(d.shopping.issues.MARKET_UNAVAILABLE);
    expect(html).toContain(d.shopping.issues.PRICE_UNAVAILABLE);
  });

  it("does not announce stale global issues while a selection is invalid or unavailable", () => {
    for (const [state, invalid] of [
      ["pending", false],
      ["unavailable", false],
      ["ready", true],
    ] as const) {
      const html = renderToStaticMarkup(
        <CartQuoteFeedback
          dictionary={d}
          invalid={invalid}
          quote={{
            result: { ...result, issues: [{ code: "MARKET_UNAVAILABLE" }] },
            state,
          }}
        />,
      );
      expect(html).not.toContain(d.shopping.issues.MARKET_UNAVAILABLE);
      expect(verifiedCartQuote({ result, state }, invalid)).toBeNull();
    }
  });

  it.each([
    ["cs", "0", false],
    ["en", "0", false],
    ["cs", "3", true],
    ["en", "3", true],
  ] as const)(
    "leaves field feedback to the row and keeps checkout blocked (%s, quantity %s, save error %s)",
    (locale, value, saveError) => {
      const entry = {
        expectedUnitPriceMinor: 12_100,
        image: null,
        name: "Product",
        productId: "p1",
        quantity: 2,
        sku: "SKU",
        slug: "product",
        unit: "ks",
        variantName: "",
      };
      const drafts = { [cartLineKey(entry)]: { quantity: entry.quantity, saveError, value } };
      const invalid = hasInvalidCartDraft(drafts, [entry]);
      expect(invalid).toBe(true);
      for (const state of ["ready", "unavailable", "scope-mismatch", "pending"] as const) {
        const quote = {
          result: { ...result, issues: [{ code: "MARKET_UNAVAILABLE" }] },
          state,
        };
        expect(
          renderToStaticMarkup(
            <CartQuoteFeedback
              dictionary={getDictionary(locale)}
              invalid={invalid}
              quote={quote}
            />,
          ),
        ).toBe("");
        expect(verifiedCartQuote(quote, invalid)).toBeNull();
      }
    },
  );

  it("keeps rejected owner outcomes actionable", () => {
    const quote: CartQuoteFeedbackState = {
      result: {
        ...result,
        issues: [{ code: "PRICE_CHANGED", currentUnitPriceMinor: 15_000, productId: "p1" }],
        outcome: "REJECTED",
        totalMinor: null,
        totalVatMinor: null,
      },
      state: "ready",
    };
    expect(verifiedCartQuote(quote, false)).toBeNull();
    expect(
      renderToStaticMarkup(<CartQuoteFeedback dictionary={d} invalid={false} quote={quote} />),
    ).toContain(d.shopping.rejected);
  });
});
