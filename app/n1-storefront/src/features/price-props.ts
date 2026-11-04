import type { PriceBlockProps } from "@techsio/ui-kit/molecules/price-block";
import type { Dictionary } from "@/i18n";
import type { ProductCardModel } from "@/ontos/catalog-model";

const formatters = {
  cs: {
    CZK: new Intl.NumberFormat("cs-CZ", {
      currency: "CZK",
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
      style: "currency",
    }),
    EUR: new Intl.NumberFormat("cs-CZ", { currency: "EUR", style: "currency" }),
    PLN: new Intl.NumberFormat("cs-CZ", { currency: "PLN", style: "currency" }),
  },
  en: {
    CZK: new Intl.NumberFormat("en-GB", {
      currency: "CZK",
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
      style: "currency",
    }),
    EUR: new Intl.NumberFormat("en-GB", { currency: "EUR", style: "currency" }),
    PLN: new Intl.NumberFormat("en-GB", { currency: "PLN", style: "currency" }),
  },
};

export const formatMarketAmount = (
  amountMinor: number,
  locale: string,
  currency: ProductCardModel["currency"],
) => formatters[locale === "en" ? "en" : "cs"][currency].format(amountMinor / 100);

/** Both card and detail use the same price state and the market's currency. */
export const priceProps = (
  product: ProductCardModel,
  d: Pick<Dictionary, "from" | "priceUnavailable">,
  locale: string,
): PriceBlockProps => {
  if (product.priceMinor === null) {
    return { label: d.priceUnavailable, state: "on-request" };
  }
  const amountLabel = formatMarketAmount(product.priceMinor, locale, product.currency);
  if (product.priceFrom) {
    return { amountLabel, prefix: d.from, state: "from" };
  }
  return { amountLabel, state: "known" };
};
