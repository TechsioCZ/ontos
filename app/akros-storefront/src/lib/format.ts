import type { Dictionary } from "@/i18n";
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

/** Same no-price wording as the product card and detail (Czech; markets word it with `t.product.priceUnavailable`). */
export const PRICE_UNAVAILABLE_LABEL = cs.product.priceUnavailable;

/**
 * Why an offer has no price, as a language-neutral code (the catalog projection runs once per market and is
 * cached across languages): `missing-price`, `zero-price`, `missing-currency` or `currency:<ISO code>`.
 * Render it with `priceUnavailableText` in the request's language.
 */
export type PriceUnavailableReason =
  | "missing-price"
  | "zero-price"
  | "missing-currency"
  | `currency:${string}`;

/** Reason code of an owner price (`undefined` = sellable in the market currency). */
export function priceUnavailableCode(
  gross: number | undefined,
  net: number | undefined,
  currency: unknown,
  money: MoneyFormat,
): PriceUnavailableReason | undefined {
  if (
    typeof currency === "string" &&
    currency.trim() &&
    currency.trim().toUpperCase() !== money.currency
  )
    return `currency:${currency.trim().toUpperCase()}`;
  if (gross === undefined || net === undefined) return "missing-price";
  if (gross <= 0 || net <= 0) return "zero-price";
  return undefined;
}

/** The reason in the dictionary's language; any non-code text is shown as it is. */
export function priceUnavailableText(
  reason: string,
  t: Dictionary = cs,
  money: MoneyFormat = CZK_MONEY,
): string {
  const words = t.product.priceReason;
  const value = reason.trim();
  if (value === "missing-price") return words.missingPrice;
  if (value === "zero-price") return words.zeroPrice;
  if (value === "missing-currency") return words.missingCurrency;
  if (value.startsWith("currency:"))
    return words.unsupportedCurrency(value.slice("currency:".length), currencySymbol(money));
  return value;
}

export interface OfferPriceInput {
  priceMinor: unknown;
  currency: unknown;
  priceIsFrom?: boolean;
  priceUnavailableReason?: string;
}

export type OfferPrice =
  | { available: true; label: string }
  | { available: false; label: string; reason: string };

/**
 * Display price of one offer (e.g. a header-search suggestion). A missing, zero or non-integer price, or one in
 * another currency than the market's, is never formatted as „0,00 Kč“ or a foreign amount: it becomes
 * „Cena není dostupná“ (in the dictionary's language) with the reason.
 */
export function describeOfferPrice(
  { priceMinor, currency, priceIsFrom = false, priceUnavailableReason }: OfferPriceInput,
  money: MoneyFormat = CZK_MONEY,
  t: Dictionary = cs,
): OfferPrice {
  const unavailable = (reason: string): OfferPrice => ({
    available: false,
    label: t.product.priceUnavailable,
    reason: priceUnavailableText(reason, t, money),
  });
  if (priceUnavailableReason?.trim()) return unavailable(priceUnavailableReason);
  if (currency !== money.currency)
    return unavailable(
      typeof currency === "string" && currency.trim()
        ? `currency:${currency.trim().toUpperCase()}`
        : "missing-currency",
    );
  if (typeof priceMinor !== "number" || !Number.isSafeInteger(priceMinor))
    return unavailable("missing-price");
  if (priceMinor <= 0) return unavailable("zero-price");
  return {
    available: true,
    label: `${priceIsFrom ? `${t.product.from} ` : ""}${formatPrice(priceMinor, money)}`,
  };
}

/**
 * Kilograms with the source precision (up to six decimals), e.g. „0,0034 kg“. Unknown, zero or invalid weights
 * return `null` so callers never show them as a zero weight. `locale` follows the market (`money.locale`).
 */
export const formatWeight = (weightKg?: number, locale = "cs-CZ") =>
  weightKg !== undefined && Number.isFinite(weightKg) && weightKg > 0
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(weightKg)} kg`
    : null;
