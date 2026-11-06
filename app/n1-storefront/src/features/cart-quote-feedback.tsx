"use client";

import type { Dictionary } from "@/i18n";
import type { CartQuoteFeedbackState } from "./cart-quote-state";

const quoteNotice = (quote: CartQuoteFeedbackState, invalid: boolean, d: Dictionary) => {
  if (invalid) {
    return d.shopping.invalidDraft;
  }
  if (quote.state === "scope-mismatch") {
    return d.shopping.marketChanged;
  }
  if (quote.state === "unavailable") {
    return d.shopping.unavailable;
  }
  if (quote.state === "ready" && quote.result?.outcome === "REJECTED") {
    return d.shopping.rejected;
  }
  return null;
};

export const CartQuoteFeedback = ({
  dictionary,
  invalid,
  quote,
}: {
  dictionary: Dictionary;
  invalid: boolean;
  quote: CartQuoteFeedbackState;
}) => {
  const notice = quoteNotice(quote, invalid, dictionary);
  return notice === null ? null : <output aria-live="polite">{notice}</output>;
};
