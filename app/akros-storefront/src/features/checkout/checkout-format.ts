import { CZK_MONEY, type MoneyFormat } from "@/lib/format";

/** Match the design's whole-unit prices while keeping non-zero minor units and allowing line wraps. */
export const formatCheckoutPrice = (priceMinor: number, money: MoneyFormat = CZK_MONEY) =>
  new Intl.NumberFormat(money.locale, {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: priceMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .format(priceMinor / 100)
    .replace(/[\u00a0\u202f]/g, " ");
