"use client";
import { Button } from "@techsio/ui-kit/atoms/button";
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
          <div className="flex flex-col gap-3">
            <Button
              disabled={invalid || quote.state === "pending" || quote.state === "scope-mismatch"}
              onClick={() => quote.verify()}
              size="md"
              theme="solid"
              variant="secondary"
            >
              {d.shopping.verify}
            </Button>
            <Button disabled size="md" theme="solid" variant="primary">
              {d.shopping.checkout}
            </Button>
            <p>{d.commerceUnavailable}</p>
          </div>
        }
        footer={d.shopping.feesNote}
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
