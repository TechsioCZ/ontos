import { Effect } from "effect";
import type { OperationOptions } from "@ontos/storefront-runtime";
import { createOperation } from "@ontos/storefront-runtime";
import "server-only";
import type { MarketReadOperation } from "./market";
import { getActiveMarket, marketReadsFor } from "./active-market";
import { hasRenderLifetime, renderOperation } from "./render-operation";
import { readRecords } from "./gateway";
import type { DeliveryMethod } from "@/features/checkout/checkout-state";

/** Shipping methods of the request's market: merchandise converts their prices into the market currency. */
export async function readCheckoutOptions(
  options: OperationOptions = {},
  marketReads?: MarketReadOperation,
): Promise<{
  shippingMethods: DeliveryMethod[];
  paymentAvailable: boolean;
  carrierTrackingAvailable: boolean;
}> {
  const standalone = options.operation === undefined && !hasRenderLifetime();
  const base =
    options.operation ?? (standalone ? Effect.runSync(createOperation()) : renderOperation());
  const operation = options.signal
    ? Effect.runSync(
        createOperation({
          signal: AbortSignal.any([base.signal, options.signal]),
          parent: base,
        }),
      )
    : base;
  try {
    return await Effect.runPromise(
      operation.run(
        Effect.tryPromise({
          try: async () => {
            const { marketId } = await getActiveMarket(marketReads ?? marketReadsFor(operation));
            const body = (await readRecords(
              "merchandise",
              "records",
              {
                view: {
                  storefront: true,
                  storefrontCheckout: true,
                  // Without a market (none exists yet) the owner answers in CZK and carries no `market`.
                  ...(marketId === undefined
                    ? {}
                    : {
                        storefrontCatalog: {
                          marketId,
                          mode: "categories",
                          includeCategories: false,
                        },
                      }),
                },
              },
              { operation },
            )) as {
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
          },
          catch: (cause) => cause,
        }),
      ),
    );
  } finally {
    if (operation !== base) operation.dispose();
    if (standalone) base.dispose();
  }
}
