"use client";

import type { Dictionary } from "@/i18n";
import type { CartQuoteFeedbackState } from "./cart-quote-state";
import { cartIssueText, globalCartIssues } from "./cart-validation";

const quoteNotice = (quote: CartQuoteFeedbackState, invalid: boolean, d: Dictionary) => {
  if (invalid) {
    return null;
  }
  if (quote.state === "scope-mismatch") {
    return d.shopping.marketChanged;
  }
  if (quote.state === "unavailable") {
    return d.checkout.unavailable;
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
  const issues =
    !invalid && quote.state === "ready"
      ? globalCartIssues(quote.result?.issues ?? []).map((issue) =>
          cartIssueText(issue.code, dictionary.shopping.issues, dictionary.shopping.rejected),
        )
      : [];
  const messages = [...new Set([...(notice === null ? [] : [notice]), ...issues])];
  return messages.map((message) => (
    <output aria-live="polite" className="block" key={message}>
      {message}
    </output>
  ));
};
