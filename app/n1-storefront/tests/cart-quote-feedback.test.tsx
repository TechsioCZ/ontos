import { describe, expect, it } from "effect-rstest";
import { renderToStaticMarkup } from "react-dom/server";
import { CartQuoteFeedback } from "../src/features/cart-quote-feedback";
import { verifiedCartQuote } from "../src/features/cart-quote-state";
import type { CartQuoteFeedbackState } from "../src/features/cart-quote-state";
import { getDictionary } from "../src/i18n";
import type { CartQuote } from "../src/ontos/cart-quote";

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

describe("current cart price feedback", () => {
  it("does not confirm a contradictory success result carrying owner issues", () => {
    expect(
      verifiedCartQuote(
        { result: { ...result, issues: [{ code: "PRICE_CHANGED" }] }, state: "ready" },
        false,
      ),
    ).toBeNull();
  });

  it("announces a current verified quote without adding a visible success paragraph", () => {
    const quote: CartQuoteFeedbackState = { result, state: "ready" };
    expect(verifiedCartQuote(quote, false)).toBe(result);
    const html = renderToStaticMarkup(
      <CartQuoteFeedback dictionary={d} invalid={false} quote={quote} />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain(d.shopping.verified);
  });

  it("never reuses a successful result during pending, unavailable or foreign-scope states", () => {
    const states: CartQuoteFeedbackState["state"][] = [
      "idle",
      "pending",
      "unavailable",
      "scope-mismatch",
    ];
    for (const state of states) {
      const quote: CartQuoteFeedbackState = { result, state };
      expect(verifiedCartQuote(quote, false)).toBeNull();
      const html = renderToStaticMarkup(
        <CartQuoteFeedback dictionary={d} invalid={false} quote={quote} />,
      );
      expect(html).not.toContain('class="sr-only"');
      expect(html).not.toContain(d.shopping.verified);
    }
  });

  it("shows invalid quantity feedback even with an earlier successful quote", () => {
    const quote: CartQuoteFeedbackState = { result, state: "ready" };
    expect(verifiedCartQuote(quote, true)).toBeNull();
    const html = renderToStaticMarkup(<CartQuoteFeedback dictionary={d} invalid quote={quote} />);
    expect(html).toContain(d.shopping.invalidDraft);
    expect(html).not.toContain('class="sr-only"');
  });

  it("keeps a rejected price visible instead of presenting it as verified", () => {
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
    const html = renderToStaticMarkup(
      <CartQuoteFeedback dictionary={d} invalid={false} quote={quote} />,
    );
    expect(html).toContain(d.shopping.rejected);
    expect(html).not.toContain('class="sr-only"');
  });
});
