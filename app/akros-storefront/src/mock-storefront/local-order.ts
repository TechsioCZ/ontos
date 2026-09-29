import type { CartState } from "./cart";
import { type CheckoutDraft, getCheckoutTotals, isCheckoutDraft } from "./checkout";

export const orderStorageKey = "akros-demo-order-v1";
export interface LocalOrder {
  version: 1;
  id: string;
  createdAt: string;
  cart: CartState;
  draft: CheckoutDraft;
  deliveryTitle: string;
  paymentTitle: string;
  paymentStatus: "not-processed";
  totals: ReturnType<typeof getCheckoutTotals>;
}

export function parseLocalOrder(value: string | null): LocalOrder | null {
  try {
    const order = JSON.parse(value ?? "null") as Partial<LocalOrder> | null;
    if (
      !order ||
      order.version !== 1 ||
      typeof order.id !== "string" ||
      typeof order.createdAt !== "string" ||
      !Number.isFinite(Date.parse(order.createdAt)) ||
      order.paymentStatus !== "not-processed" ||
      typeof order.deliveryTitle !== "string" ||
      typeof order.paymentTitle !== "string" ||
      !isCheckoutDraft(order.draft) ||
      order.cart?.version !== 3 ||
      !Array.isArray(order.cart.lines) ||
      !order.cart.lines.length ||
      !order.cart.lines.every(
        (line) =>
          line &&
          typeof line.name === "string" &&
          typeof line.unit === "string" &&
          typeof line.sku === "string" &&
          (line.variantLabel === undefined || typeof line.variantLabel === "string") &&
          Number.isFinite(line.quantity) &&
          line.quantity > 0 &&
          Number.isSafeInteger(line.priceMinor) &&
          line.priceMinor >= 0,
      ) ||
      !order.totals ||
      ![order.totals.subtotal, order.totals.total, order.totals.payment].every(
        (price) => Number.isSafeInteger(price) && price >= 0,
      ) ||
      ![order.totals.shipping, order.totals.net, order.totals.vat].every(
        (price) => price === null || (Number.isSafeInteger(price) && (price ?? -1) >= 0),
      )
    )
      return null;
    return order as LocalOrder;
  } catch {
    return null;
  }
}
