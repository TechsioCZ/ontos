import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { DateTime, Effect, Match, Schema, Struct } from "effect";
import { executeApplyCommandWithAuthorization } from "@app/merchandise/clients/apply-command";
import {
  StorefrontOrderLineRequestSchema,
  StorefrontOrderResultSchema,
} from "@app/merchandise/contracts/apply-command";
import type {
  ApplyCommandPayloadEncoded,
  ApplyCommandResult,
} from "@app/merchandise/contracts/apply-command";
import { OrderContactSchema, OrderSchema } from "@app/merchandise/domain/merchandise-model";
import {
  CheckoutRecoveryRequestSchema,
  CheckoutRequestSchema,
  CheckoutResultSchema,
} from "./checkout";
import type { CheckoutRecoveryRequest, CheckoutRequest } from "./checkout";
import type { CartScope } from "./cart-quote";
import { readConfiguration } from "./config";
import type { StorefrontConfiguration } from "./config";
import { readOwner } from "./gateway";
import { storefrontRuntime } from "./runtime";
import {
  CheckoutFailure,
  mintCheckoutContext,
  readCheckoutContext,
  sameCheckoutScope,
} from "./checkout-context";
import type { FulfillmentInfo } from "./fulfillment-model";

export { CheckoutFailure } from "./checkout-context";

export type CheckoutOptions =
  | {
      countryCodes: readonly string[];
      paymentAvailable: boolean;
      scope: CartScope;
      shippingMethods: FulfillmentInfo["shippingMethods"];
      state: "ready";
    }
  | { state: "unavailable" };

const configuration = () =>
  readConfiguration(process.env).pipe(
    Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })),
  );

/** Request-local SSR options; no server revision or credential is exposed to the browser. */
export const getCheckoutOptions = cache(
  async (locale: string): Promise<CheckoutOptions> =>
    await storefrontRuntime.runPromise(
      configuration().pipe(
        Effect.flatMap((config) => readCheckoutContext(config, locale)),
        Effect.match({
          onFailure: () => ({ state: "unavailable" as const }),
          onSuccess: (context) => ({
            countryCodes: context.countryCodes,
            paymentAvailable: context.paymentAvailable,
            scope: context.scope,
            shippingMethods: context.shippingMethods,
            state: "ready" as const,
          }),
        }),
      ),
    ),
);

const scopedContext = (config: StorefrontConfiguration, locale: string, scope: CartScope) =>
  Effect.gen(function* scopedCheckoutContext() {
    if (scope.tenantId !== config.tenantId || scope.legalEntityId !== config.legalEntityId) {
      return yield* new CheckoutFailure({ state: "scope-mismatch" });
    }
    const context = yield* readCheckoutContext(config, locale);
    if (!sameCheckoutScope(context.scope, scope)) {
      return yield* new CheckoutFailure({ state: "scope-mismatch" });
    }
    return context;
  });

type NativeCheckoutOrder = typeof StorefrontOrderResultSchema.Type;
type GuestCommand = Extract<
  ApplyCommandPayloadEncoded["command"],
  { readonly _tag: "PlaceStorefrontOrder" }
>;
type MutableGuestCommand = { -readonly [Key in keyof GuestCommand]: GuestCommand[Key] };

const correctOutcomeEvidence = (
  request: CheckoutRequest,
  order: NativeCheckoutOrder,
  entityIds: readonly string[],
) => {
  const placed = order.outcome === "PLACED" || order.outcome === "REPLAYED";
  if (
    (request.mode === "quote" && placed) ||
    (request.mode === "place" && order.outcome === "VALID")
  ) {
    return false;
  }
  return placed
    ? order.orderId !== undefined &&
        order.orderNumber !== undefined &&
        entityIds.some((id) => id === order.orderId)
    : entityIds.length === 0 && order.orderId === undefined && order.orderNumber === undefined;
};
const correctMarketEvidence = (request: CheckoutRequest, order: NativeCheckoutOrder) => {
  if (
    order.market !== undefined &&
    (order.market.marketId !== request.scope.marketId ||
      order.market.currency !== request.scope.currency)
  ) {
    return false;
  }
  return (
    order.outcome === "REJECTED" ||
    (order.market?.configured === true &&
      order.shippingPriceMinor === request.expectedShippingPriceMinor)
  );
};
const correctLineEvidence = (request: CheckoutRequest, order: NativeCheckoutOrder) => {
  const seen = new Set<string>();
  for (const line of order.lines) {
    const identity = JSON.stringify([line.productId, line.variantId ?? null]);
    const input = request.lines.find(
      (entry) => entry.productId === line.productId && entry.variantId === line.variantId,
    );
    if (
      seen.has(identity) ||
      input === undefined ||
      input.quantity !== line.quantity ||
      (order.outcome !== "REJECTED" && input.expectedUnitPriceMinor !== line.unitPriceMinor)
    ) {
      return false;
    }
    seen.add(identity);
  }
  return order.outcome === "REJECTED" || order.lines.length === request.lines.length;
};

/** A malformed placement reply can conceal a committed order, so it must keep the submission guard. */
const confirmCheckoutResult = (request: CheckoutRequest, result: ApplyCommandResult) =>
  Effect.gen(function* confirmCheckoutResultProgram() {
    const failure = () =>
      new CheckoutFailure({ state: request.mode === "place" ? "uncertain" : "unavailable" });
    const order = yield* Schema.decodeUnknownEffect(StorefrontOrderResultSchema)(
      result.storefrontOrder,
    ).pipe(Effect.mapError(failure));
    if (!correctOutcomeEvidence(request, order, result.entityIds)) {
      return yield* failure();
    }
    if (!correctMarketEvidence(request, order)) {
      return yield* failure();
    }
    if (!correctLineEvidence(request, order)) {
      return yield* failure();
    }
    return yield* Schema.decodeUnknownEffect(CheckoutResultSchema)({
      issues: order.issues.map((issue) =>
        Struct.pick(issue, ["code", "currentUnitPriceMinor", "productId", "variantId"]),
      ),
      lines: order.lines,
      orderId: order.orderId ?? null,
      orderNumber: order.orderNumber ?? null,
      outcome: order.outcome,
      receipt: null,
      scope: request.scope,
      shippingPriceMinor: order.shippingPriceMinor ?? null,
      status: order.status ?? null,
      totalMinor: order.totalMinor ?? null,
      totalVatMinor: order.totalVatMinor ?? null,
    }).pipe(Effect.mapError(failure));
  });

const GuestOrderSnapshotSchema = Schema.Struct({ orders: Schema.Array(OrderSchema) });

/** Public guest nonce lookup returns no catalog rows. Catalog-mode reads do not implement this owner capability. */
const readGuestReceipt = (config: StorefrontConfiguration, request: CheckoutRecoveryRequest) =>
  Effect.gen(function* readGuestReceiptProgram() {
    const snapshot = yield* readOwner(
      config,
      "merchandise",
      "records",
      {
        view: {
          includeCategories: false,
          limit: 0,
          orderClientRequestId: request.clientRequestId,
          ordersLimit: 1,
          storefront: true,
        },
      },
      GuestOrderSnapshotSchema,
    ).pipe(Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })));
    if (snapshot.orders.length === 0) {
      return { state: "unconfirmed" as const };
    }
    const [order] = snapshot.orders;
    if (
      snapshot.orders.length !== 1 ||
      order === undefined ||
      order.clientRequestId !== request.clientRequestId ||
      order.channel !== "STOREFRONT" ||
      order.customerAccountId !== undefined ||
      order.market?.marketId !== request.scope.marketId ||
      order.market.currency !== request.scope.currency ||
      order.pricesIncludeVat !== true ||
      order.shipping === undefined
    ) {
      return yield* new CheckoutFailure({ state: "unavailable" });
    }
    const result = yield* Schema.decodeUnknownEffect(CheckoutResultSchema)({
      issues: [],
      lines: order.lines.map((line) => ({
        lineTotalMinor: null,
        name: line.productName,
        productId: line.productId,
        quantity: line.quantity,
        sku: line.sku,
        unitPriceMinor: line.unitPriceMinor,
        ...Struct.pick(line, ["variantId", "variantName"]),
      })),
      orderId: order.id,
      orderNumber: order.number,
      outcome: "REPLAYED",
      receipt: {
        contact: order.contact ?? null,
        createdAt: DateTime.formatIso(order.createdAt),
        deliveryAddress: order.deliveryAddress ?? null,
        shippingMethod: order.shipping.method,
      },
      scope: request.scope,
      shippingPriceMinor: order.shipping.priceMinor,
      status: order.status,
      totalMinor: order.totalMinor,
      totalVatMinor: order.totalVatMinor,
    }).pipe(Effect.mapError(() => new CheckoutFailure({ state: "unavailable" })));
    return { result, state: "confirmed" as const };
  });

export const recoverCheckoutWithConfiguration = (
  config: StorefrontConfiguration,
  input: CheckoutRecoveryRequest,
) =>
  Effect.gen(function* recoverCheckoutProgram() {
    const request = yield* Schema.decodeUnknownEffect(CheckoutRecoveryRequestSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new CheckoutFailure({ state: "invalid" })));
    yield* scopedContext(config, request.locale, request.scope);
    return yield* readGuestReceipt(config, request);
  });

export const recoverCheckout = (input: CheckoutRecoveryRequest) =>
  configuration().pipe(Effect.flatMap((config) => recoverCheckoutWithConfiguration(config, input)));

export const submitCheckoutWithConfiguration = (
  config: StorefrontConfiguration,
  input: CheckoutRequest,
) =>
  Effect.gen(function* submitCheckoutProgram() {
    const request = yield* Schema.decodeUnknownEffect(CheckoutRequestSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new CheckoutFailure({ state: "invalid" })));
    yield* Schema.decodeUnknownEffect(Schema.Array(StorefrontOrderLineRequestSchema))(
      request.lines,
    ).pipe(Effect.mapError(() => new CheckoutFailure({ state: "invalid" })));
    const contact = yield* Schema.decodeUnknownEffect(OrderContactSchema)({
      email: request.contact.email,
      name: `${request.contact.firstName} ${request.contact.lastName}`,
      ...Struct.pick(request.contact, ["phone"]),
    }).pipe(Effect.mapError(() => new CheckoutFailure({ state: "invalid" })));
    const context = yield* scopedContext(config, request.locale, request.scope);
    if (request.mode === "place") {
      const existing = yield* readGuestReceipt(config, request);
      if (existing.state === "confirmed") {
        return existing.result;
      }
    }
    if (
      request.address.country === undefined ||
      !context.countryCodes.includes(request.address.country)
    ) {
      return yield* new CheckoutFailure({ state: "invalid" });
    }
    const method = context.shippingMethods.find((entry) => entry.id === request.shippingMethod);
    if (method === undefined || method.priceMinor !== request.expectedShippingPriceMinor) {
      return yield* new CheckoutFailure({ state: "invalid" });
    }
    const assertion = yield* mintCheckoutContext(config);
    const quoteId = `n1-checkout-quote-${randomUUID()}`;
    const command: MutableGuestCommand = {
      _tag: "PlaceStorefrontOrder",
      billingAddress: request.address,
      clientRequestId: request.mode === "place" ? request.clientRequestId : quoteId,
      contact,
      deliveryAddress: request.address,
      dryRun: request.mode === "quote",
      expectedShippingPriceMinor: request.expectedShippingPriceMinor,
      lines: request.lines,
      marketId: context.scope.marketId,
      shippingMethod: method.id,
    };
    if (request.contact.phone !== undefined && request.contact.phone !== "") {
      command.deliveryRecipient = {
        firstName: request.contact.firstName,
        lastName: request.contact.lastName,
        phone: request.contact.phone,
      };
    }
    const payload: ApplyCommandPayloadEncoded = {
      command,
      // This native command explicitly ignores the aggregate revision under the head lock.
      // Keep the Core request hash stable across duplicate submissions; no browser revision is trusted.
      expectedRevision: request.mode === "place" ? 0 : context.revision,
    };
    const result = yield* executeApplyCommandWithAuthorization(
      payload,
      `Bearer ${assertion.token}`,
      randomUUID(),
      {
        baseUrl: `${config.shellUrl}${assertion.apiBaseUrl}`,
        compositionRevision: assertion.compositionRevision,
        idempotencyKey:
          request.mode === "place" ? `n1-checkout-place-${request.clientRequestId}` : quoteId,
      },
    ).pipe(
      Effect.timeout("20 seconds"),
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("ApplyCommandActionForbiddenProblem", () =>
            Effect.fail(new CheckoutFailure({ state: "forbidden" })),
          ),
          Match.tag("ApplyCommandActionInvalidProblem", () =>
            Effect.fail(new CheckoutFailure({ state: "invalid" })),
          ),
          Match.orElse(() =>
            Effect.fail(
              new CheckoutFailure({
                state: request.mode === "place" ? "uncertain" : "unavailable",
              }),
            ),
          ),
        ),
      ),
    );
    // Return commit evidence immediately. Canonical receipt enrichment is a separate read-only status call,
    // so its timeout cannot turn an already confirmed placement into an uncertain submission.
    return yield* confirmCheckoutResult(request, result);
  });

export const submitCheckout = (input: CheckoutRequest) =>
  configuration().pipe(Effect.flatMap((config) => submitCheckoutWithConfiguration(config, input)));
