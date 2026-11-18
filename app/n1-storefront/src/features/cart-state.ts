import { Effect, Schema, Struct } from "effect";
import { CartQuoteLineSchema, CartScopeSchema } from "@/ontos/cart-quote";
import type { CartScope } from "@/ontos/cart-quote";

/** A package affects the stepper only when the owner declares a positive size. */
export const cartQuantityStep = (packageQuantity?: number | null) =>
  packageQuantity !== undefined &&
  packageQuantity !== null &&
  Number.isFinite(packageQuantity) &&
  packageQuantity > 0
    ? packageQuantity
    : 1;

/** Match the native minimum/package checks; never round a customer's draft. */
export const validCartQuantity = (
  quantity: number,
  minimum = 0.001,
  packageQuantity?: number | null,
  maximum = 1_000_000,
) =>
  Number.isFinite(quantity) &&
  quantity >= Math.max(0.001, minimum) &&
  quantity <= Math.min(1_000_000, maximum) &&
  (packageQuantity === undefined ||
    packageQuantity === null ||
    (Number.isFinite(packageQuantity) &&
      (packageQuantity <= 0 ||
        Math.abs(quantity / packageQuantity - Math.round(quantity / packageQuantity)) <=
          0.000001)));

/** Catalog stock is a UX bound only; the owner still validates every quote/order. */
export const cartQuantityMaximum = (
  stockQuantity?: number | null,
  packageQuantity?: number | null,
) => {
  const maximum = Math.min(1_000_000, stockQuantity ?? 1_000_000);
  return packageQuantity !== undefined && packageQuantity !== null && packageQuantity > 0
    ? Number((Math.floor((maximum + 0.000000001) / packageQuantity) * packageQuantity).toFixed(12))
    : maximum;
};

/** Display values are an unverified draft, never monetary or inventory authority. */
const CartEntrySchema = Schema.Struct({
  ...CartQuoteLineSchema.fields,
  image: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  minimumQuantity: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  ),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  // Missing means legacy unknown; null is a fresh owner read with no package rule.
  packageQuantity: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  quantity: Schema.Finite.check(Schema.isBetween({ maximum: 1_000_000, minimum: 0.001 })),
  sku: Schema.String.check(Schema.isMaxLength(300)),
  slug: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  stockQuantity: Schema.optionalKey(
    Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  unit: Schema.String.check(Schema.isMaxLength(100)),
  variantName: Schema.String.check(Schema.isMaxLength(300)),
}).check(
  Schema.makeFilter((entry) =>
    validCartQuantity(entry.quantity, entry.minimumQuantity, entry.packageQuantity),
  ),
);
export type CartEntry = typeof CartEntrySchema.Type;
export const cartLineKey = (line: { productId: string; variantId?: string }) =>
  JSON.stringify([line.productId, line.variantId ?? null]);
const EntriesSchema = Schema.Array(CartEntrySchema).check(
  Schema.isMaxLength(50),
  Schema.makeFilter((entries) => new Set(entries.map(cartLineKey)).size === entries.length),
);
const CartDraftSchema = Schema.Struct({
  entries: EntriesSchema,
  scope: CartScopeSchema,
  version: Schema.Literal(1),
});
export class CartDraftInvalid extends Schema.TaggedError<CartDraftInvalid>()(
  "CartDraftInvalid",
  {},
) {}
export const cartStorageKey = (scope: CartScope) =>
  `n1-cart-v1:${JSON.stringify([scope.tenantId, scope.legalEntityId, scope.marketId, scope.currency])}`;
const sameCartScope = (left: CartScope, right: CartScope) =>
  cartStorageKey(left) === cartStorageKey(right);
export const decodeStoredCart = (raw: string, scope: CartScope) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(CartDraftSchema))(raw).pipe(
    Effect.flatMap((cart) =>
      sameCartScope(cart.scope, scope) ? Effect.succeed(cart) : Effect.fail(new CartDraftInvalid()),
    ),
    Effect.mapError(() => new CartDraftInvalid()),
  );
export const addCartEntry = (entries: readonly CartEntry[], entry: CartEntry) =>
  Schema.decodeUnknownEffect(CartEntrySchema)(entry).pipe(
    Effect.flatMap((incoming) => {
      const key = cartLineKey(incoming);
      const existing = entries.find((line) => cartLineKey(line) === key);
      const latest = { ...existing, ...incoming };
      const updated =
        existing === undefined
          ? [...entries, latest]
          : entries.map((line) =>
              cartLineKey(line) === key
                ? { ...latest, quantity: line.quantity + incoming.quantity }
                : line,
            );
      return Schema.decodeUnknownEffect(EntriesSchema)(updated).pipe(
        Effect.filterOrFail(
          (decoded) =>
            decoded.every(
              (line) =>
                cartLineKey(line) !== key ||
                validCartQuantity(
                  line.quantity,
                  line.minimumQuantity,
                  line.packageQuantity,
                  cartQuantityMaximum(line.stockQuantity, line.packageQuantity),
                ),
            ),
          () => new CartDraftInvalid(),
        ),
      );
    }),
    Effect.mapError(() => new CartDraftInvalid()),
  );
export const replaceCartQuantity = (
  entries: readonly CartEntry[],
  entry: CartEntry,
  quantity: number,
) =>
  Schema.decodeUnknownEffect(EntriesSchema)(
    entries.map((line) =>
      cartLineKey(line) === cartLineKey(entry)
        ? {
            ...line,
            ...Struct.pick(entry, ["stockQuantity"]),
            quantity,
          }
        : line,
    ),
  ).pipe(
    Effect.filterOrFail(
      (updated) =>
        updated.every(
          (line) =>
            cartLineKey(line) !== cartLineKey(entry) ||
            validCartQuantity(
              line.quantity,
              line.minimumQuantity,
              line.packageQuantity,
              cartQuantityMaximum(line.stockQuantity, line.packageQuantity),
            ),
        ),
      () => new CartDraftInvalid(),
    ),
    Effect.mapError(() => new CartDraftInvalid()),
  );
