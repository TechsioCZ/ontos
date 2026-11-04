"use client";

import type { Dictionary } from "@/i18n";
import { verifiedCartQuote } from "./cart-quote-state";
import type { CartQuoteFeedbackState } from "./cart-quote-state";

const quoteNotice = (quote: CartQuoteFeedbackState, invalid: boolean, d: Dictionary) => {
  if (invalid) {
    return d.shopping.invalidDraft;
  }
  if (quote.state === "pending") {
    return d.shopping.checking;
  }
  if (quote.state === "scope-mismatch") {
    return d.shopping.marketChanged;
  }
  if (quote.state === "unavailable") {
    return d.shopping.unavailable;
  }
  if (verifiedCartQuote(quote, invalid) !== null) {
    return d.shopping.verified;
  }
  if (quote.state === "ready" && quote.result?.outcome === "REJECTED") {
    return d.shopping.rejected;
  }
  return d.shopping.unverified;
};

export const CartQuoteFeedback = ({
  dictionary,
  invalid,
  quote,
}: {
  dictionary: Dictionary;
  invalid: boolean;
  quote: CartQuoteFeedbackState;
}) => (
  <output
    aria-live="polite"
    className={verifiedCartQuote(quote, invalid) === null ? undefined : "sr-only"}
  >
    {quoteNotice(quote, invalid, dictionary)}
  </output>
);
