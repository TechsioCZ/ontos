"use client";

import { Effect, Exit, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { CartQuoteRequestSchema, CartScopeSchema } from "@/ontos/cart-quote";
import type { CartQuoteRequest, CartScope } from "@/ontos/cart-quote";
import { clientRuntime } from "@/ontos/client-runtime";
import { cartStorageKey, decodeStoredCart } from "./cart-state";
import type { CartEntry } from "./cart-state";

/** Only the submission identity and cart snapshot survive a page reload, never contact/address data. */
export const CheckoutGuardSchema = Schema.Struct({
  clientRequestId: Schema.String.check(Schema.isUUID()),
  lines: CartQuoteRequestSchema.fields.lines,
  scope: CartScopeSchema,
  version: Schema.Literal(1),
});
export type CheckoutGuard = typeof CheckoutGuardSchema.Type;

export class CheckoutGuardFailure extends Schema.TaggedError<CheckoutGuardFailure>()(
  "CheckoutGuardFailure",
  {
    reason: Schema.Literals([
      "invalid",
      "storage",
      "exists",
      "scope-mismatch",
      "busy",
      "unsupported",
    ]),
  },
) {}

/** Narrow browser seams allow storage failure and competing tabs to be exercised without HTTP. */
export type CheckoutGuardStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
export interface CheckoutLockManager {
  request: <A>(
    name: string,
    options: { ifAvailable: true; mode: "exclusive" },
    callback: (lock: Lock | null) => Promise<A>,
  ) => Promise<A>;
}

export const checkoutGuardKey = (scope: CartScope) =>
  `n1-checkout-guard-v1:${JSON.stringify([
    scope.tenantId,
    scope.legalEntityId,
    scope.marketId,
    scope.currency,
  ])}`;

export const cartLineSnapshot = (entries: readonly CartEntry[]): CartQuoteRequest["lines"] =>
  entries.map((entry) => {
    const line = {
      expectedUnitPriceMinor: entry.expectedUnitPriceMinor,
      productId: entry.productId,
      quantity: entry.quantity,
    };
    if (entry.variantId === undefined) {
      return line;
    }
    return { ...line, variantId: entry.variantId };
  });

/** A changed price, quantity, variant or product invalidates the submitted snapshot. */
export const sameCheckoutLines = (
  left: CartQuoteRequest["lines"],
  right: CartQuoteRequest["lines"],
) =>
  left.length === right.length &&
  left.every((line, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      line.productId === other.productId &&
      line.variantId === other.variantId &&
      line.quantity === other.quantity &&
      line.expectedUnitPriceMinor === other.expectedUnitPriceMinor
    );
  });

const resolveStorage = (storage: CheckoutGuardStorage | undefined) =>
  Effect.try({
    catch: () => new CheckoutGuardFailure({ reason: "storage" }),
    try: () => storage ?? window.localStorage,
  });

const validateGuard = (guard: CheckoutGuard) =>
  Schema.decodeEffect(CheckoutGuardSchema, { onExcessProperty: "error" })(guard).pipe(
    Effect.mapError(() => new CheckoutGuardFailure({ reason: "invalid" })),
  );

/** Clear a confirmed submission only while its exact lines still occupy the scoped stored cart. */
export const clearSubmittedCart = (
  scope: CartScope,
  lines: CartQuoteRequest["lines"],
  storage?: CheckoutGuardStorage,
): Effect.Effect<boolean, CheckoutGuardFailure> =>
  Effect.gen(function* clearSubmittedCartProgram() {
    const submitted = yield* Schema.decodeEffect(CartQuoteRequestSchema.fields.lines, {
      onExcessProperty: "error",
    })(lines).pipe(Effect.mapError(() => new CheckoutGuardFailure({ reason: "invalid" })));
    const store = yield* resolveStorage(storage);
    const key = cartStorageKey(scope);
    const raw = yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.getItem(key),
    });
    if (raw === null) {
      return false;
    }
    const current = yield* decodeStoredCart(raw, scope).pipe(
      Effect.mapError(() => new CheckoutGuardFailure({ reason: "invalid" })),
    );
    if (!sameCheckoutLines(cartLineSnapshot(current.entries), submitted)) {
      return false;
    }
    yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.removeItem(key),
    });
    return true;
  });

export const readCheckoutGuard = (scope: CartScope, storage?: CheckoutGuardStorage) =>
  Effect.gen(function* readGuardProgram() {
    const store = yield* resolveStorage(storage);
    const raw = yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.getItem(checkoutGuardKey(scope)),
    });
    if (raw === null) {
      return null;
    }
    const guard = yield* Schema.decodeEffect(Schema.fromJsonString(CheckoutGuardSchema), {
      onExcessProperty: "error",
    })(raw).pipe(Effect.mapError(() => new CheckoutGuardFailure({ reason: "invalid" })));
    if (checkoutGuardKey(guard.scope) !== checkoutGuardKey(scope)) {
      return yield* new CheckoutGuardFailure({ reason: "scope-mismatch" });
    }
    return guard;
  });

/** Call inside withCheckoutLock, before sending the first placement request. Existing guards fail closed. */
export const saveCheckoutGuard = (input: CheckoutGuard, storage?: CheckoutGuardStorage) =>
  Effect.gen(function* saveGuardProgram() {
    const guard = yield* validateGuard(input);
    const store = yield* resolveStorage(storage);
    const key = checkoutGuardKey(guard.scope);
    const existing = yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.getItem(key),
    });
    if (existing !== null) {
      yield* new CheckoutGuardFailure({ reason: "exists" });
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CheckoutGuardSchema))(
      guard,
    ).pipe(Effect.mapError(() => new CheckoutGuardFailure({ reason: "invalid" })));
    yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.setItem(key, encoded),
    });
  });

/** Call inside the same lock only after confirmed receipt or an explicitly known refusal. */
export const removeCheckoutGuard = (input: CheckoutGuard, storage?: CheckoutGuardStorage) =>
  Effect.gen(function* removeGuardProgram() {
    const expected = yield* validateGuard(input);
    const store = yield* resolveStorage(storage);
    const current = yield* readCheckoutGuard(expected.scope, store);
    if (current === null) {
      return;
    }
    if (
      current.clientRequestId !== expected.clientRequestId ||
      !sameCheckoutLines(current.lines, expected.lines)
    ) {
      yield* new CheckoutGuardFailure({ reason: "exists" });
    }
    yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: () => store.removeItem(checkoutGuardKey(expected.scope)),
    });
  });

/**
 * Browser integration edge. The inner runtime finishes the mutation and cleanup while the Web Lock
 * remains held, even if the rendering component disappears. Its Exit retains typed failures and defects.
 */
export const withCheckoutLock = <A, E>(
  scope: CartScope,
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  locks?: CheckoutLockManager | null,
): Effect.Effect<A, E | CheckoutGuardFailure> =>
  Effect.gen(function* checkoutLockProgram() {
    const manager: CheckoutLockManager | null | undefined = yield* Effect.try({
      catch: () => new CheckoutGuardFailure({ reason: "unsupported" }),
      try: () => (locks === undefined ? navigator.locks : locks),
    });
    if (manager === undefined || manager === null) {
      return yield* new CheckoutGuardFailure({ reason: "unsupported" });
    }
    const outcome = yield* Effect.tryPromise({
      catch: () => new CheckoutGuardFailure({ reason: "storage" }),
      try: async () =>
        await manager.request<Exit.Exit<A, E | CheckoutGuardFailure>>(
          checkoutGuardKey(scope),
          { ifAvailable: true, mode: "exclusive" },
          async (lock) =>
            lock === null
              ? Exit.fail(new CheckoutGuardFailure({ reason: "busy" }))
              : await clientRuntime.runPromiseExit(program),
        ),
    });
    return yield* outcome;
  }).pipe(Effect.uninterruptible);
