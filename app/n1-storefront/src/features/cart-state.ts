import { Effect, Schema } from "effect";
import { CartQuoteLineSchema, CartScopeSchema } from "@/ontos/cart-quote";
import type { CartScope } from "@/ontos/cart-quote";

/** Display values are an unverified draft, never monetary or inventory authority. */
const CartEntrySchema = Schema.Struct({
  ...CartQuoteLineSchema.fields,
  image: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  minimumQuantity: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  ),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  quantity: Schema.Finite.check(Schema.isBetween({ maximum: 1_000_000, minimum: 0.001 })),
  sku: Schema.String.check(Schema.isMaxLength(300)),
  slug: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  unit: Schema.String.check(Schema.isMaxLength(100)),
  variantName: Schema.String.check(Schema.isMaxLength(300)),
}).check(Schema.makeFilter((entry) => entry.quantity >= (entry.minimumQuantity ?? 0.001)));
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
      const minimumQuantity = incoming.minimumQuantity ?? existing?.minimumQuantity;
      const latest = minimumQuantity === undefined ? incoming : { ...incoming, minimumQuantity };
      const updated =
        existing === undefined
          ? [...entries, latest]
          : entries.map((line) =>
              cartLineKey(line) === key
                ? { ...latest, quantity: line.quantity + incoming.quantity }
                : line,
            );
      return Schema.decodeUnknownEffect(EntriesSchema)(updated);
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
      cartLineKey(line) === cartLineKey(entry) ? { ...line, quantity } : line,
    ),
  ).pipe(Effect.mapError(() => new CartDraftInvalid()));
