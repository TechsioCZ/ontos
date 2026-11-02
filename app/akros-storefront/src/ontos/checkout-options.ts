import "server-only";
import { getActiveMarket } from "./active-market";
import { readRecords } from "./gateway";
import type { DeliveryMethod } from "@/features/checkout/checkout-state";

/** Shipping methods of the request's market: merchandise converts their prices into the market currency. */
export async function readCheckoutOptions(): Promise<{
  shippingMethods: DeliveryMethod[];
  paymentAvailable: boolean;
  carrierTrackingAvailable: boolean;
}> {
  const { marketId } = await getActiveMarket();
  const body = (await readRecords("merchandise", "records", {
    view: {
      storefront: true,
      storefrontCheckout: true,
      // Without a market (none exists yet) the owner answers in CZK and carries no `market`.
      ...(marketId === undefined
        ? {}
        : { storefrontCatalog: { marketId, mode: "categories", includeCategories: false } }),
    },
  })) as {
    market?: { marketId?: unknown };
    checkout?: {
      shippingMethods: DeliveryMethod[];
      paymentAvailable: boolean;
      carrierTrackingAvailable: boolean;
    };
  };
  const value = body.checkout;
  if (
    body.market?.marketId !== marketId ||
    !value ||
    !Array.isArray(value.shippingMethods) ||
    !value.shippingMethods.every(
      (method) =>
        typeof method.id === "string" &&
        typeof method.title === "string" &&
        Number.isSafeInteger(method.priceMinor) &&
        method.priceMinor >= 0,
    )
  )
    throw new Error("OntOS checkout options response is malformed");
  return value;
}
