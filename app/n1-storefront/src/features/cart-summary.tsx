"use client";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import NextLink from "next/link";
import { TotalsSummary } from "@techsio/ui-kit/molecules/totals-summary";
import type { Dictionary } from "@/i18n";
import type { CartQuote } from "@/ontos/cart-quote";
import type { useCartQuote } from "./use-cart-quote";

const formatMoney = (amount: number, locale: string, currency: string) =>
  new Intl.NumberFormat(locale, { currency, style: "currency" }).format(amount / 100);

export const CartSummary = ({
  currency,
  dictionary: d,
  invalid,
  locale,
  quote,
  verified,
}: {
  currency: string;
  dictionary: Dictionary;
  invalid: boolean;
  locale: string;
  quote: ReturnType<typeof useCartQuote>;
  verified: CartQuote | null;
}) => {
  const money = (amount: number) => formatMoney(amount, locale, currency);
  const canContinue = verified !== null && !invalid && quote.state === "ready";
  let net = d.shopping.unresolved;
  let vat = d.shopping.unresolved;
  let total = d.shopping.unresolved;
  if (verified !== null && verified.totalMinor !== null && verified.totalVatMinor !== null) {
    net = money(verified.totalMinor - verified.totalVatMinor);
    vat = money(verified.totalVatMinor);
    total = money(verified.totalMinor);
  }
  return (
    <section aria-label={d.shopping.summary} className="min-w-0">
      <h2 className="mb-4 text-lg font-semibold">{d.shopping.summary}</h2>
      <TotalsSummary
        actions={
          // ui-kit Button sets its own aria-busy from isLoading, so the pending validation is announced on the actions.
          <div aria-busy={quote.state === "pending" || undefined} className="flex flex-col gap-3">
            {verified === null && quote.state === "unavailable" && (
              <Button
                disabled={invalid}
                onClick={() => quote.verify()}
                size="md"
                theme="solid"
                variant="secondary"
              >
                {d.retry}
              </Button>
            )}
            {canContinue ? (
              <LinkButton
                as={NextLink}
                href={`/${locale}/pokladna`}
                size="md"
                theme="solid"
                variant="secondary"
              >
                {d.shopping.checkout}
              </LinkButton>
            ) : (
              <Button disabled size="md" theme="solid" type="button" variant="secondary">
                {d.shopping.checkout}
              </Button>
            )}
          </div>
        }
        rows={[
          { id: "net", label: d.shopping.net, value: net },
          { id: "vat", label: d.shopping.vat, value: vat },
          { id: "shipping", label: d.shopping.shipping, value: d.shopping.chooseShipping },
        ]}
        totalLabel={d.shopping.subtotal}
        totalValue={total}
      />
    </section>
  );
};
