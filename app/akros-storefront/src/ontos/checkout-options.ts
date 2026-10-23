import "server-only";
import { readRecords } from "./gateway";
import type { DeliveryMethod } from "@/features/checkout/checkout-state";

export async function readCheckoutOptions(): Promise<{
  shippingMethods: DeliveryMethod[];
  paymentAvailable: boolean;
  carrierTrackingAvailable: boolean;
}> {
  const body = (await readRecords("merchandise", "records", {
    view: { storefront: true, storefrontCheckout: true },
  })) as {
    checkout?: {
      shippingMethods: DeliveryMethod[];
      paymentAvailable: boolean;
      carrierTrackingAvailable: boolean;
    };
  };
  const value = body.checkout;
  if (
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
