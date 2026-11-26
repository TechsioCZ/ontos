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

/** Display the owner amount in the Figma price slot; variant count is not proof of a price range. */
export const priceProps = (
  product: Pick<ProductCardModel, "currency" | "originalPriceMinor" | "priceFrom" | "priceMinor">,
  d: Pick<Dictionary, "priceExcludingVat" | "priceUnavailable"> &
    Partial<Pick<Dictionary, "originalPrice">>,
  locale: string,
  priceExcludingVatMinor: number | null = null,
): PriceBlockProps => {
  if (product.priceMinor === null) {
    return { label: d.priceUnavailable, state: "on-request" };
  }
  const amountLabel = formatMarketAmount(product.priceMinor, locale, product.currency);
  const original =
    product.originalPriceMinor !== undefined && product.originalPriceMinor > product.priceMinor
      ? {
          originalLabel: formatMarketAmount(product.originalPriceMinor, locale, product.currency),
          originalSrLabel: d.originalPrice ?? "",
          state: "discounted" as const,
        }
      : { state: "known" as const };
  if (priceExcludingVatMinor !== null && !product.priceFrom) {
    return {
      amountLabel,
      ...original,
      taxLabel: d.priceExcludingVat.replace("{amount}", () =>
        formatMarketAmount(priceExcludingVatMinor, locale, product.currency),
      ),
    };
  }
  return { amountLabel, ...original };
};
