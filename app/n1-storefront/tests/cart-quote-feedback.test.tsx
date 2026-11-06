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
      state === "unavailable" ? d.shopping.unavailable : d.shopping.marketChanged,
    );
    expect(html).toContain('aria-live="polite"');
  });

  it("shows quantity corrections without a warning about internal draft prices", () => {
    const html = renderToStaticMarkup(
      <CartQuoteFeedback dictionary={d} invalid quote={{ result, state: "ready" }} />,
    );
    expect(html).toContain(d.shopping.invalidDraft);
    expect(html).not.toContain("neověřen");
  });

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
