import "server-only";
import { randomUUID } from "node:crypto";
import { executePlaceStorefrontOrderWithAuthorization } from "@app/merchandise/clients/place-storefront-order";
import { PlaceStorefrontOrderPayloadSchema } from "@app/merchandise/contracts/place-storefront-order";
import {
  StorefrontOrderLineRequestSchema,
  StorefrontOrderResultSchema,
} from "@app/merchandise/contracts/apply-command";
import type { ApplyCommandResult } from "@app/merchandise/contracts/apply-command";
import { StorefrontMarketSchema } from "@app/merchandise/domain/market-offers";
import { Effect, Match, Predicate, Schema, Struct } from "effect";
import type { Cause } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CartQuoteDiagnosticSchema, CartQuoteRequestSchema, CartQuoteSchema } from "./cart-quote";
import type { CartQuoteRequest, CartScope } from "./cart-quote";
import { readConfiguration } from "./config";
import type { StorefrontConfiguration } from "./config";
import { readOwner } from "./gateway";
import { selectMarket } from "./market";
import { readCurrentMarketCatalog } from "./market-catalog-read";

export class CartQuoteFailure extends Schema.TaggedError<CartQuoteFailure>()("CartQuoteFailure", {
  diagnostic: Schema.optionalKey(CartQuoteDiagnosticSchema),
  state: Schema.Literals(["unavailable", "invalid", "forbidden", "scope-mismatch"]),
}) {}
const scopeMismatchState = "scope-mismatch";
const readDeadline = "10 seconds";
const gatewayContextUnavailableDiagnostic = "gateway-context-unavailable";
const DryRunEvidenceSchema = Schema.Struct({
  entityIds: Schema.Array(Schema.Never),
  storefrontOrder: Schema.Struct({
    ...StorefrontOrderResultSchema.fields,
    orderId: Schema.optionalKey(Schema.Never),
    orderNumber: Schema.optionalKey(Schema.Never),
    outcome: Schema.Literals(["VALID", "REJECTED"]),
  }),
});
const OwnerSnapshotSchema = Schema.Struct({
  market: StorefrontMarketSchema,
  revision: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
});
const ContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(Schema.isPattern(/^\/shell-super-app-api\/[a-z\d/-]+$/u)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  expiresAt: Schema.Int,
  token: Schema.String.check(Schema.isMinLength(1)),
});
const sameScope = (left: CartScope, right: CartScope) =>
  left.tenantId === right.tenantId &&
  left.legalEntityId === right.legalEntityId &&
  left.marketId === right.marketId &&
  left.currency === right.currency;
const readQuoteContext = (config: StorefrontConfiguration, locale: string) =>
  Effect.gen(function* readQuoteContextProgram() {
    const { markets, now } = yield* readCurrentMarketCatalog(config);
    const market = yield* selectMarket(markets, config, locale, now);
    const snapshot = yield* readOwner(
      config,
      "merchandise",
      "records",
      {
        view: {
          storefront: true,
          storefrontCatalog: {
            fields: "card",
            includeCategories: false,
            marketId: market.marketRef.resourceId,
            pageSize: 1,
          },
        },
      },
      OwnerSnapshotSchema,
    );
    if (!snapshot.market.configured || snapshot.market.marketId !== market.marketRef.resourceId) {
      return yield* new CartQuoteFailure({ state: "unavailable" });
    }
    const scope: CartScope = {
      currency: snapshot.market.currency,
      legalEntityId: config.legalEntityId,
      marketId: snapshot.market.marketId,
      tenantId: config.tenantId,
    };
    return { revision: snapshot.revision, scope };
  }).pipe(
    Effect.catchTags({
      StorefrontMarketUnavailable: () =>
        Effect.fail(
          new CartQuoteFailure({ diagnostic: "context-read-unavailable", state: "unavailable" }),
        ),
      StorefrontReadUnavailable: (error) =>
        Effect.fail(
          new CartQuoteFailure({
            diagnostic:
              error.reason === "forbidden" ? "context-read-forbidden" : "context-read-unavailable",
            state: error.reason === "forbidden" ? "forbidden" : "unavailable",
          }),
        ),
    }),
  );

/** Fresh server-only scope for SSR. No browser identity, catalog fallback or cached market is accepted. */
export const getCartScope = (locale: string) =>
  Effect.gen(function* getCartScopeProgram() {
    yield* Schema.decodeUnknownEffect(Schema.Literals(["cs", "en"]))(locale).pipe(
      Effect.mapError(() => new CartQuoteFailure({ state: "invalid" })),
    );
    const config = yield* readConfiguration(process.env).pipe(
      Effect.mapError(() => new CartQuoteFailure({ state: "unavailable" })),
    );
    return (yield* readQuoteContext(config, locale)).scope;
  });

const mintQuoteContext = (config: StorefrontConfiguration) =>
  Effect.gen(function* mintQuoteContextProgram() {
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
    ).pipe(
      Effect.mapError(
        () =>
          new CartQuoteFailure({
            diagnostic: gatewayContextUnavailableDiagnostic,
            state: "unavailable",
          }),
      ),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.timeout(readDeadline),
      Effect.mapError(
        () =>
          new CartQuoteFailure({
            diagnostic: gatewayContextUnavailableDiagnostic,
            state: "unavailable",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new CartQuoteFailure({
        diagnostic:
          response.status === 401 || response.status === 403
            ? "gateway-context-forbidden"
            : gatewayContextUnavailableDiagnostic,
        state: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable",
      });
    }
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ContextSchema)),
      Effect.timeout(readDeadline),
      Effect.mapError(
        () =>
          new CartQuoteFailure({
            diagnostic: gatewayContextUnavailableDiagnostic,
            state: "unavailable",
          }),
      ),
    );
  });

/** Require owner evidence of a dry run; never turn PLACED/REPLAYED or a shipping-inclusive amount into goods totals. */
export const confirmCartQuote = (scope: CartScope, result: ApplyCommandResult) =>
  Effect.gen(function* confirmCartQuoteProgram() {
    const { storefrontOrder: order } = yield* Schema.decodeUnknownEffect(DryRunEvidenceSchema)(
      result,
    ).pipe(Effect.mapError(() => new CartQuoteFailure({ state: "unavailable" })));
    if (
      order.market !== undefined &&
      (order.market.marketId !== scope.marketId || order.market.currency !== scope.currency)
    ) {
      return yield* new CartQuoteFailure({ state: scopeMismatchState });
    }
    const goodsConfirmed = order.shippingPriceMinor === 0 && order.market?.configured !== false;
    if (
      order.outcome === "VALID" &&
      (!goodsConfirmed ||
        order.totalMinor === undefined ||
        order.totalVatMinor === undefined ||
        order.issues.length !== 0)
    ) {
      return yield* new CartQuoteFailure({ state: "unavailable" });
    }
    return yield* Schema.decodeUnknownEffect(CartQuoteSchema)({
      issues: order.issues.map((issue) =>
        Struct.pick(issue, ["code", "currentUnitPriceMinor", "productId", "variantId"]),
      ),
      outcome: order.outcome,
      scope,
      totalMinor: goodsConfirmed ? (order.totalMinor ?? null) : null,
      totalVatMinor: goodsConfirmed ? (order.totalVatMinor ?? null) : null,
    }).pipe(Effect.mapError(() => new CartQuoteFailure({ state: "unavailable" })));
  });

type NativeQuoteFailure =
  | Effect.Error<ReturnType<typeof executePlaceStorefrontOrderWithAuthorization>>
  | Cause.TimeoutError;
/** Only closed contract tags/codes enter logs, never the error, HTTP request, body or cause. */
const logNativeQuoteFailure = (error: NativeQuoteFailure) =>
  Effect.logWarning("N1 cart quote native request failed").pipe(
    Effect.annotateLogs({
      nativeCode: Match.value(error).pipe(
        Match.tags({
          PlaceStorefrontOrderActionAlreadyCommittedProblem: (problem) => problem.code,
          PlaceStorefrontOrderActionConflictProblem: (problem) => problem.code,
          PlaceStorefrontOrderActionForbiddenProblem: (problem) => problem.code,
          PlaceStorefrontOrderActionIneligibleProblem: (problem) => problem.code,
          PlaceStorefrontOrderActionNotFoundProblem: (problem) => problem.code,
          PlaceStorefrontOrderActionUnavailableProblem: (problem) => problem.code,
        }),
        Match.orElse(() => "other"),
      ),
      nativeTag: Match.value(error).pipe(
        Match.tags({
          HttpClientError: () => "HttpClientError",
          PlaceStorefrontOrderActionAlreadyCommittedProblem: () =>
            "PlaceStorefrontOrderActionAlreadyCommittedProblem",
          PlaceStorefrontOrderActionAuthenticationProblem: () =>
            "PlaceStorefrontOrderActionAuthenticationProblem",
          PlaceStorefrontOrderActionCommitIndeterminateProblem: () =>
            "PlaceStorefrontOrderActionCommitIndeterminateProblem",
          PlaceStorefrontOrderActionConflictProblem: () =>
            "PlaceStorefrontOrderActionConflictProblem",
          PlaceStorefrontOrderActionForbiddenProblem: () =>
            "PlaceStorefrontOrderActionForbiddenProblem",
          PlaceStorefrontOrderActionIneligibleProblem: () =>
            "PlaceStorefrontOrderActionIneligibleProblem",
          PlaceStorefrontOrderActionInternalProblem: () =>
            "PlaceStorefrontOrderActionInternalProblem",
          PlaceStorefrontOrderActionInvalidProblem: () =>
            "PlaceStorefrontOrderActionInvalidProblem",
          PlaceStorefrontOrderActionNotFoundProblem: () =>
            "PlaceStorefrontOrderActionNotFoundProblem",
          PlaceStorefrontOrderActionPreconditionProblem: () =>
            "PlaceStorefrontOrderActionPreconditionProblem",
          PlaceStorefrontOrderActionUnavailableProblem: () =>
            "PlaceStorefrontOrderActionUnavailableProblem",
          SchemaError: () => "SchemaError",
          TimeoutError: () => "TimeoutError",
        }),
        Match.orElse(() => "other"),
      ),
      operation: "cart-quote",
      transportReason: Match.value(error).pipe(
        Match.tag("HttpClientError", (problem) => problem.reason._tag),
        Match.orElse(() => "none"),
      ),
      upstreamStatus: Match.value(error).pipe(
        Match.tag("HttpClientError", (problem) => {
          const status = problem.response?.status;
          return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
            ? status
            : "none";
        }),
        Match.orElse(() => "none"),
      ),
    }),
  );

export const quoteCart = (input: CartQuoteRequest) =>
  Effect.gen(function* quoteCartProgram() {
    const request = yield* Schema.decodeUnknownEffect(CartQuoteRequestSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new CartQuoteFailure({ state: "invalid" })));
    // The public owner has tighter quantity bounds than the cart's storage envelope. Refuse them before any HTTP.
    yield* Schema.decodeUnknownEffect(Schema.Array(StorefrontOrderLineRequestSchema))(
      request.lines,
    ).pipe(Effect.mapError(() => new CartQuoteFailure({ state: "invalid" })));
    const config = yield* readConfiguration(process.env).pipe(
      Effect.mapError(() => new CartQuoteFailure({ state: "unavailable" })),
    );
    if (
      request.scope.tenantId !== config.tenantId ||
      request.scope.legalEntityId !== config.legalEntityId
    ) {
      return yield* new CartQuoteFailure({ state: scopeMismatchState });
    }
    const snapshot = yield* readQuoteContext(config, request.locale);
    if (!sameScope(snapshot.scope, request.scope)) {
      return yield* new CartQuoteFailure({ state: scopeMismatchState });
    }
    // Both combined reads redeemed their assertions. The command always mints a new one.
    const context = yield* mintQuoteContext(config);
    const requestId = `n1-quote-${randomUUID()}`;
    const payload = yield* Schema.decodeUnknownEffect(PlaceStorefrontOrderPayloadSchema)({
      command: {
        _tag: "PlaceStorefrontOrder",
        clientRequestId: requestId,
        dryRun: true,
        expectedShippingPriceMinor: 0,
        lines: request.lines,
        marketId: snapshot.scope.marketId,
        shippingMethod: "OSOBNI_ODBER",
      },
      expectedRevision: snapshot.revision,
    }).pipe(Effect.mapError(() => new CartQuoteFailure({ state: "invalid" })));
    const result = yield* executePlaceStorefrontOrderWithAuthorization(
      payload,
      `Bearer ${context.token}`,
      randomUUID(),
      {
        baseUrl: `${config.shellUrl}${context.apiBaseUrl}`,
        compositionRevision: context.compositionRevision,
        idempotencyKey: requestId,
      },
    ).pipe(
      Effect.timeout("20 seconds"),
      Effect.tapError(logNativeQuoteFailure),
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("PlaceStorefrontOrderActionForbiddenProblem", () =>
            Effect.fail(
              new CartQuoteFailure({ diagnostic: "native-action-forbidden", state: "forbidden" }),
            ),
          ),
          Match.orElse(() =>
            Effect.fail(
              new CartQuoteFailure({
                diagnostic: "native-action-unavailable",
                state: "unavailable",
              }),
            ),
          ),
        ),
      ),
    );
    if (Predicate.isTagged(result, "ActionProposalAccepted")) {
      return yield* new CartQuoteFailure({
        diagnostic: "native-action-unavailable",
        state: "unavailable",
      });
    }
    return yield* confirmCartQuote(snapshot.scope, result);
  });
