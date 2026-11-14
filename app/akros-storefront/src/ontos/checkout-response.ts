import type { Dictionary } from "@/i18n";
import { cs } from "@/i18n/cs";

/** Checkout errors of the current market (`useDictionary().checkout.errors`); Czech by default. */
type CheckoutErrors = Dictionary["checkout"]["errors"];

/** The Czech wording of `errors.saveUnconfirmed`. */
export const checkoutSaveError = cs.checkout.errors.saveUnconfirmed;

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
  "MARKET_UNAVAILABLE",
  "NOT_OFFERED_IN_MARKET",
]);

/** Only bounded owner-authored stock messages are shown; other upstream text stays hidden. */
const stockMessage = (value: unknown, errors: CheckoutErrors): string | undefined => {
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
  return messages.length > 0 ? errors.stockAdjust(messages.join(" ")) : undefined;
};

async function json(response: Response, errors: CheckoutErrors): Promise<unknown> {
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
        throw new CheckoutPriceError(errors.ownerPriceChanged);
      if (value.issues.some((issue) => String(issue.code) === "MARKET_UNAVAILABLE"))
        throw new CheckoutRejectionError(errors.marketClosed);
      if (value.issues.some((issue) => String(issue.code) === "NOT_OFFERED_IN_MARKET"))
        throw new CheckoutRejectionError(errors.notOfferedInMarket);
      if (
        value.issues.some((issue) =>
          ["OUT_OF_STOCK", "INSUFFICIENT_STOCK"].includes(String(issue.code)),
        )
      )
        throw new CheckoutStockError(stockMessage(value, errors) ?? errors.stockUnavailable);
      throw new CheckoutRejectionError(errors.ownerRejected);
    }
  }
  if (!response.ok) throw new Error(errors.saveUnconfirmed);
  try {
    return await response.json();
  } catch {
    throw new Error(errors.saveUnconfirmed);
  }
}

export async function readOrderResponse(
  response: Response,
  errors: CheckoutErrors = cs.checkout.errors,
) {
  const value = await json(response, errors);
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
    throw new Error(errors.saveUnconfirmed);
  return {
    orderId: value.orderId,
    orderNumber: value.orderNumber,
    totalMinor: value.totalMinor,
    totalVatMinor: value.totalVatMinor,
  };
}

export async function readCheckoutQuote(
  response: Response,
  errors: CheckoutErrors = cs.checkout.errors,
) {
  const value = await json(response, errors);
  if (
    !record(value) ||
    typeof value.canCheckout !== "boolean" ||
    typeof value.priceChanged !== "boolean" ||
    !Array.isArray(value.issues) ||
    !value.issues.every((issue) => typeof issue === "string") ||
    (value.canCheckout && (value.priceChanged || value.issues.length > 0))
  )
    throw new Error(errors.saveUnconfirmed);
  return value as { canCheckout: boolean; priceChanged: boolean; issues: string[] };
}
