export const checkoutSaveError =
  "Uložení objednávky se nepodařilo potvrdit. Košík zůstává zachovaný. Zkuste to znovu; opakované odeslání nevytvoří další objednávku.";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const minor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A recognized owner rejection confirms that this attempt did not place an order. */
export class CheckoutRejectionError extends Error {}
export class CheckoutStockError extends CheckoutRejectionError {}
export class CheckoutPriceError extends CheckoutRejectionError {}

const rejectionCodes = new Set([
  "NOT_FOUND",
  "NOT_AVAILABLE",
  "VARIANT_REQUIRED",
  "OUT_OF_STOCK",
  "INSUFFICIENT_STOCK",
  "AVAILABILITY_UNKNOWN",
  "MINIMUM_QUANTITY",
  "PACKAGE_QUANTITY",
  "PRICE_CHANGED",
  "PRICE_UNAVAILABLE",
  "SHIPPING_PRICE_CHANGED",
]);

/** Only bounded owner-authored stock messages are shown; other upstream text stays hidden. */
const stockMessage = (value: unknown): string | undefined => {
  if (!record(value) || !Array.isArray(value.issues)) return undefined;
  const messages = value.issues
    .filter(
      (issue): issue is { message: string } =>
        record(issue) &&
        ["OUT_OF_STOCK", "INSUFFICIENT_STOCK"].includes(String(issue.code)) &&
        typeof issue.message === "string" &&
        issue.message.length > 0 &&
        issue.message.length <= 300,
    )
    .map((issue) => issue.message);
  return messages.length > 0
    ? `${messages.join(" ")} Upravte množství v košíku a objednávku odešlete znovu.`
    : undefined;
};

async function json(response: Response): Promise<unknown> {
  // Never display an arbitrary upstream body, JSON parser or browser/network exception.
  if (response.status === 409) {
    const value = await response.json().catch(() => undefined);
    if (
      record(value) &&
      Array.isArray(value.issues) &&
      value.issues.length > 0 &&
      value.issues.every((issue) => record(issue) && rejectionCodes.has(String(issue.code)))
    ) {
      if (
        value.issues.some((issue) =>
          ["PRICE_CHANGED", "SHIPPING_PRICE_CHANGED"].includes(String(issue.code)),
        )
      )
        throw new CheckoutPriceError(
          "Cena zboží nebo dopravy se změnila. Vraťte se do košíku, ověřte aktuální ceny a odešlete objednávku znovu.",
        );
      if (
        value.issues.some((issue) =>
          ["OUT_OF_STOCK", "INSUFFICIENT_STOCK"].includes(String(issue.code)),
        )
      )
        throw new CheckoutStockError(
          stockMessage(value) ??
            "Zboží již není dostupné v požadovaném množství. Upravte košík a objednávku odešlete znovu.",
        );
      throw new CheckoutRejectionError(
        "OntOS objednávku odmítl. Zkontrolujte položky, množství a aktuální ceny v košíku a odešlete objednávku znovu.",
      );
    }
  }
  if (!response.ok) throw new Error(checkoutSaveError);
  try {
    return await response.json();
  } catch {
    throw new Error(checkoutSaveError);
  }
}

export async function readOrderResponse(response: Response) {
  const value = await json(response);
  if (
    !record(value) ||
    !["PLACED", "REPLAYED"].includes(String(value.outcome)) ||
    typeof value.orderId !== "string" ||
    !value.orderId.trim() ||
    typeof value.orderNumber !== "string" ||
    !value.orderNumber.trim() ||
    !minor(value.totalMinor) ||
    !minor(value.totalVatMinor) ||
    value.totalVatMinor > value.totalMinor
  )
    throw new Error(checkoutSaveError);
  return {
    orderId: value.orderId,
    orderNumber: value.orderNumber,
    totalMinor: value.totalMinor,
    totalVatMinor: value.totalVatMinor,
  };
}

export async function readCheckoutQuote(response: Response) {
  const value = await json(response);
  if (
    !record(value) ||
    typeof value.canCheckout !== "boolean" ||
    typeof value.priceChanged !== "boolean" ||
    !Array.isArray(value.issues) ||
    !value.issues.every((issue) => typeof issue === "string") ||
    (value.canCheckout && (value.priceChanged || value.issues.length > 0))
  )
    throw new Error(checkoutSaveError);
  return value as { canCheckout: boolean; priceChanged: boolean; issues: string[] };
}
