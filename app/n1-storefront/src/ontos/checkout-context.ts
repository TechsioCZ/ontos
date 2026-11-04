import "server-only";
import { randomUUID } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { StorefrontMarketSchema } from "@app/merchandise/domain/market-offers";
import { FulfillmentSnapshotSchema, projectFulfillment } from "./fulfillment-model";
import { readOwner } from "./gateway";
import { MarketCatalogSchema, selectMarket } from "./market";
import type { StorefrontConfiguration } from "./config";
import type { CartScope } from "./cart-quote";

export class CheckoutFailure extends Schema.TaggedError<CheckoutFailure>()("CheckoutFailure", {
  state: Schema.Literals(["invalid", "forbidden", "scope-mismatch", "unavailable", "uncertain"]),
}) {}
const reference = Schema.Struct({ resourceId: Schema.String });
const CheckoutMarketCatalogSchema = Schema.Struct({
  associations: MarketCatalogSchema.fields.associations,
  markets: Schema.Array(
    Schema.Struct({
      effectivePeriod: Schema.Struct({
        endsAt: Schema.optionalKey(Schema.String),
        startsAt: Schema.String,
      }),
      jurisdictions: Schema.Array(
        Schema.Struct({
          code: Schema.String,
          kind: Schema.Literals(["COUNTRY", "REGION", "JURISDICTION"]),
        }),
      ),
      lifecycle: Schema.String,
      marketCode: Schema.String,
      marketRef: reference,
      sellingLegalEntityRef: reference,
      supportedLocales: Schema.Array(Schema.String),
    }),
  ),
});
const CheckoutSnapshotSchema = Schema.Struct({
  checkout: FulfillmentSnapshotSchema.fields.checkout,
  market: StorefrontMarketSchema,
  revision: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
});
const GatewayContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(Schema.isPattern(/^\/shell-super-app-api\/[a-z\d/-]+$/u)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  expiresAt: Schema.Int,
  token: Schema.String.check(Schema.isMinLength(1)),
});
export const sameCheckoutScope = (left: CartScope, right: CartScope) =>
  left.tenantId === right.tenantId &&
  left.legalEntityId === right.legalEntityId &&
  left.marketId === right.marketId &&
  left.currency === right.currency;

/** Country choices are explicit market COUNTRY jurisdictions, never inferred from a language. */
export const readCheckoutContext = (config: StorefrontConfiguration, locale: string) =>
  Effect.gen(function* readCheckoutContextProgram() {
    yield* Schema.decodeUnknownEffect(Schema.Literals(["cs", "en"]))(locale).pipe(
      Effect.mapError(() => new CheckoutFailure({ state: "invalid" })),
    );
    const now = yield* Clock.currentTimeMillis;
    const catalog = yield* readOwner(
      config,
      "commerce-market-catalog",
      "current-market-catalog",
      { at: new Date(now).toISOString() },
      CheckoutMarketCatalogSchema,
    );
    const selected = yield* selectMarket(catalog, config, locale, now);
    const definition = catalog.markets.find(
      (market) => market.marketRef.resourceId === selected.marketRef.resourceId,
    );
    const countries = new Set<string>();
    if (definition !== undefined) {
      for (const jurisdiction of definition.jurisdictions) {
        if (jurisdiction.kind === "COUNTRY") {
          countries.add(jurisdiction.code);
        }
      }
    }
    const countryCodes = [...countries];
    if (countryCodes.length === 0 || countryCodes.some((code) => !/^[A-Z]{2}$/u.test(code))) {
      return yield* new CheckoutFailure({ state: "unavailable" });
    }
    const snapshot = yield* readOwner(
      config,
      "merchandise",
      "records",
      {
        view: {
          storefront: true,
          storefrontCatalog: {
            includeCategories: false,
            marketId: selected.marketRef.resourceId,
            mode: "categories",
          },
          storefrontCheckout: true,
        },
      },
      CheckoutSnapshotSchema,
    );
    const info = yield* projectFulfillment(snapshot, selected.marketRef.resourceId);
    const scope: CartScope = {
      currency: info.currency,
      legalEntityId: config.legalEntityId,
      marketId: snapshot.market.marketId,
      tenantId: config.tenantId,
    };
    return { ...info, countryCodes, revision: snapshot.revision, scope };
  }).pipe(
    Effect.catchTags({
      FulfillmentUnavailable: () => Effect.fail(new CheckoutFailure({ state: "unavailable" })),
      StorefrontMarketUnavailable: () => Effect.fail(new CheckoutFailure({ state: "unavailable" })),
      StorefrontReadUnavailable: (error) =>
        Effect.fail(
          new CheckoutFailure({
            state: error.reason === "forbidden" ? "forbidden" : "unavailable",
          }),
        ),
    }),
  );

/** An assertion redeemed by a combined read is never reused for an Action. */
export const mintCheckoutContext = (config: StorefrontConfiguration) =>
  Effect.gen(function* mintCheckoutContextProgram() {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `${config.shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
      ).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": config.apiKey,
          "x-correlation-id": randomUUID(),
        }),
      ),
      { audience: "merchandise", legalEntityId: config.legalEntityId },
    ).pipe(Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new CheckoutFailure({
        state: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable",
      });
    }
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextSchema)),
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })),
    );
  });
