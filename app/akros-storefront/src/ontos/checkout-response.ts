export const checkoutSaveError =
  "Uložení DEMO objednávky se nepodařilo potvrdit. Košík zůstává zachovaný. Zkuste to znovu; opakované odeslání nevytvoří další objednávku.";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const minor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** OntOS refused the order because stock ran out after the cart check; the customer must change the cart. */
export class CheckoutStockError extends Error {}

/** Only owner-authored INSUFFICIENT_STOCK issues are shown; any other upstream text stays hidden. */
const stockMessage = (value: unknown): string | undefined => {
  if (!record(value) || !Array.isArray(value.issues)) return undefined;
  const messages = value.issues
    .filter(
      (issue): issue is { message: string } =>
        record(issue) &&
        issue.code === "INSUFFICIENT_STOCK" &&
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
    const message = stockMessage(await response.json().catch(() => undefined));
    if (message) throw new CheckoutStockError(message);
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
    typeof value.orderNumber !== "string" ||
    !value.orderNumber.trim() ||
    !minor(value.totalMinor) ||
    !minor(value.totalVatMinor) ||
    value.totalVatMinor > value.totalMinor
  )
    throw new Error(checkoutSaveError);
  return {
    ...(typeof value.orderId === "string" && value.orderId.trim()
      ? { orderId: value.orderId }
      : {}),
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
