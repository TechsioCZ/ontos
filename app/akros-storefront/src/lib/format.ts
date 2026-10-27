export const formatPrice = (priceMinor: number, currency: "CZK" = "CZK") =>
  new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(priceMinor / 100);

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
 * Display price of one offer (e.g. a header-search suggestion). A missing, zero, non-integer or non-CZK price is
 * never formatted as „0,00 Kč“ or a foreign amount: it becomes „Cena není dostupná“ with the reason.
 */
export function describeOfferPrice({
  priceMinor,
  currency,
  priceIsFrom = false,
  priceUnavailableReason,
}: OfferPriceInput): OfferPrice {
  const unavailable = (reason: string): OfferPrice => ({
    available: false,
    label: PRICE_UNAVAILABLE_LABEL,
    reason,
  });
  if (priceUnavailableReason?.trim()) return unavailable(priceUnavailableReason.trim());
  if (currency !== "CZK")
    return unavailable(
      typeof currency === "string" && currency.trim()
        ? `Cena je v nepodporované měně (${currency.trim().toUpperCase()}); e-shop prodává jen v Kč.`
        : "OntOS pro tuto položku nevrátil měnu ceny.",
    );
  if (typeof priceMinor !== "number" || !Number.isSafeInteger(priceMinor))
    return unavailable("OntOS pro tuto položku nevrátil cenu.");
  if (priceMinor <= 0) return unavailable("Cena v OntOS je nulová, položku proto nelze objednat.");
  return {
    available: true,
    label: priceIsFrom ? "Cena podle zvolené varianty" : formatPrice(priceMinor, "CZK"),
  };
}
