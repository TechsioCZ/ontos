import { RecordsResponseSchema } from "@app/merchandise/contracts/records";
import { StorefrontMarketSchema } from "@app/merchandise/domain/market-offers";
import { Effect, Schema } from "effect";

/** Reuse the public owner contract; never infer offers from the shipping enum. */
export const FulfillmentSnapshotSchema = Schema.Struct({
  checkout: RecordsResponseSchema.fields.checkout,
  market: StorefrontMarketSchema,
});
class FulfillmentUnavailable extends Schema.TaggedError<FulfillmentUnavailable>()(
  "FulfillmentUnavailable",
  {},
) {}

export const projectFulfillment = (
  snapshot: typeof FulfillmentSnapshotSchema.Type,
  marketId: string,
) =>
  Effect.gen(function* projectFulfillmentProgram() {
    const { checkout, market } = snapshot;
    if (!market.configured || market.marketId !== marketId || checkout === undefined) {
      return yield* new FulfillmentUnavailable();
    }
    const ids = new Set<string>();
    for (const method of checkout.shippingMethods) {
      if (
        ids.has(method.id) ||
        method.title.trim() === "" ||
        !Number.isSafeInteger(method.priceMinor) ||
        method.priceMinor < 0
      ) {
        return yield* new FulfillmentUnavailable();
      }
      ids.add(method.id);
    }
    return {
      currency: market.currency,
      paymentAvailable: checkout.paymentAvailable,
      shippingMethods: checkout.shippingMethods,
    };
  });
export type FulfillmentInfo = Effect.Success<ReturnType<typeof projectFulfillment>>;
export type FulfillmentResult =
  | { info: FulfillmentInfo; state: "ready" }
  | { state: "unavailable" };
