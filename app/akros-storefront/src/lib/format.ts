import { cs } from "@/i18n/cs";

/** Currencies a storefront market can sell in (merchandise `MarketSettings.currency`). */
export type StoreCurrency = "CZK" | "EUR" | "PLN";
const STORE_CURRENCIES: ReadonlySet<string> = new Set<StoreCurrency>(["CZK", "EUR", "PLN"]);
export const isStoreCurrency = (value: unknown): value is StoreCurrency =>
  typeof value === "string" && STORE_CURRENCIES.has(value);

/** How a market shows money: its currency and its primary locale (`cs`, `sk`, `en`, …). */
export interface MoneyFormat {
  currency: StoreCurrency;
  locale: string;
}
/** The Czech market (and every surface rendered outside a market, e.g. isolated component tests). */
export const CZK_MONEY: MoneyFormat = { currency: "CZK", locale: "cs-CZ" };

export const formatPrice = (priceMinor: number, money: MoneyFormat = CZK_MONEY) =>
  new Intl.NumberFormat(money.locale, {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: 2,
  }).format(priceMinor / 100);

/** Narrow currency symbol of a market (`Kč`, `€`, `zł`) for labels such as „Cena od (Kč)“. */
export const currencySymbol = (money: MoneyFormat = CZK_MONEY) =>
  new Intl.NumberFormat(money.locale, {
    style: "currency",
    currency: money.currency,
    currencyDisplay: "narrowSymbol",
  })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? money.currency;

/** Same no-price wording as the product card and detail. */
export const PRICE_UNAVAILABLE_LABEL = "Cena není dostupná";

export interface OfferPriceInput {
  priceMinor: unknown;
  currency: unknown;
  priceIsFrom?: boolean;
  priceUnavailableReason?: string;
}

export type OfferPrice =
  | { available: true; label: string }
  | { available: false; label: typeof PRICE_UNAVAILABLE_LABEL; reason: string };

/**
 * Display price of one offer (e.g. a header-search suggestion). A missing, zero or non-integer price, or one in
 * another currency than the market's, is never formatted as „0,00 Kč“ or a foreign amount: it becomes
 * „Cena není dostupná“ with the reason.
 */
export function describeOfferPrice(
  { priceMinor, currency, priceIsFrom = false, priceUnavailableReason }: OfferPriceInput,
  money: MoneyFormat = CZK_MONEY,
  from: string = cs.product.from,
): OfferPrice {
  const unavailable = (reason: string): OfferPrice => ({
    available: false,
    label: PRICE_UNAVAILABLE_LABEL,
    reason,
  });
  if (priceUnavailableReason?.trim()) return unavailable(priceUnavailableReason.trim());
  if (currency !== money.currency)
    return unavailable(
      typeof currency === "string" && currency.trim()
        ? `Cena je v nepodporované měně (${currency.trim().toUpperCase()}); e-shop prodává jen v ${currencySymbol(money)}.`
        : "OntOS pro tuto položku nevrátil měnu ceny.",
    );
  if (typeof priceMinor !== "number" || !Number.isSafeInteger(priceMinor))
    return unavailable("OntOS pro tuto položku nevrátil cenu.");
  if (priceMinor <= 0) return unavailable("Cena v OntOS je nulová, položku proto nelze objednat.");
  return {
    available: true,
    label: `${priceIsFrom ? `${from} ` : ""}${formatPrice(priceMinor, money)}`,
  };
}
