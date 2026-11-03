import { Effect, Schema } from "effect";
import type { StorefrontConfiguration } from "./config";

const reference = Schema.Struct({ resourceId: Schema.String });
const period = Schema.Struct({
  endsAt: Schema.optionalKey(Schema.String),
  startsAt: Schema.String,
});
export const MarketCatalogSchema = Schema.Struct({
  associations: Schema.Array(
    Schema.Struct({
      channel: Schema.String,
      effectivePeriod: period,
      marketRef: reference,
      sellingLegalEntityRef: reference,
      storefrontRef: Schema.Struct({ appId: Schema.String, tenantId: Schema.String }),
    }),
  ),
  markets: Schema.Array(
    Schema.Struct({
      effectivePeriod: period,
      lifecycle: Schema.String,
      marketCode: Schema.String,
      marketRef: reference,
      sellingLegalEntityRef: reference,
      supportedLocales: Schema.Array(Schema.String),
    }),
  ),
});

export class StorefrontMarketUnavailable extends Schema.TaggedError<StorefrontMarketUnavailable>()(
  "StorefrontMarketUnavailable",
  { reason: Schema.Literals(["missing", "inactive", "ambiguous"]) },
) {}

const effective = (value: typeof period.Type, now: number) =>
  Date.parse(value.startsAt) <= now &&
  (value.endsAt === undefined || now < Date.parse(value.endsAt));

/** Resolve only an explicitly associated N1 market. Never reopen an unfiltered catalogue. */
export const selectMarket = (
  catalog: typeof MarketCatalogSchema.Type,
  config: Pick<StorefrontConfiguration, "appId" | "legalEntityId" | "tenantId">,
  locale: string,
  now: number,
) =>
  Effect.gen(function* selectMarketProgram() {
    const associations = catalog.associations.filter(
      (item) =>
        item.storefrontRef.appId === config.appId &&
        item.storefrontRef.tenantId === config.tenantId &&
        item.sellingLegalEntityRef.resourceId === config.legalEntityId &&
        item.channel === "B2C" &&
        effective(item.effectivePeriod, now),
    );
    const markets = catalog.markets.filter(
      (market) =>
        market.sellingLegalEntityRef.resourceId === config.legalEntityId &&
        market.supportedLocales[0]?.split("-")[0] === locale &&
        associations.some((item) => item.marketRef.resourceId === market.marketRef.resourceId),
    );
    if (markets.length === 0) {
      return yield* new StorefrontMarketUnavailable({ reason: "missing" });
    }
    const active = markets.filter(
      (market) => market.lifecycle === "ACTIVE" && effective(market.effectivePeriod, now),
    );
    if (active.length === 0) {
      return yield* new StorefrontMarketUnavailable({ reason: "inactive" });
    }
    if (active.length !== 1) {
      return yield* new StorefrontMarketUnavailable({ reason: "ambiguous" });
    }
    return active[0];
  });
