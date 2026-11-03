import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

const id = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const nonnegativeMinor = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
);
export const CartScopeSchema = Schema.Struct({
  currency: Schema.Literals(["CZK", "EUR", "PLN"]),
  legalEntityId: Schema.String.check(Schema.isUUID()),
  marketId: id,
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type CartScope = typeof CartScopeSchema.Type;
export const CartQuoteLineSchema = Schema.Struct({
  expectedUnitPriceMinor: Schema.Int.check(
    Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
  ),
  productId: id,
  quantity: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000_000)),
  variantId: Schema.optionalKey(id),
});
export const CartQuoteRequestSchema = Schema.Struct({
  lines: Schema.Array(CartQuoteLineSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
    Schema.makeFilter((lines) => {
      const identities = lines.map((line) =>
        JSON.stringify([line.productId, line.variantId ?? null]),
      );
      return new Set(identities).size === identities.length;
    }),
  ),
  locale: Schema.Literals(["cs", "en"]),
  scope: CartScopeSchema,
});
export type CartQuoteRequest = typeof CartQuoteRequestSchema.Type;

/** Owner-confirmed goods subtotal only, with zero pickup shipping and no payment charge. */
export const CartQuoteSchema = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      currentUnitPriceMinor: Schema.optionalKey(nonnegativeMinor),
      productId: Schema.optionalKey(id),
      variantId: Schema.optionalKey(id),
    }),
  ),
  outcome: Schema.Literals(["VALID", "REJECTED"]),
  scope: CartScopeSchema,
  totalMinor: Schema.NullOr(nonnegativeMinor),
  totalVatMinor: Schema.NullOr(nonnegativeMinor),
}).check(
  Schema.makeFilter(
    (quote) =>
      quote.outcome !== "VALID" ||
      (quote.totalMinor !== null &&
        quote.totalVatMinor !== null &&
        quote.totalVatMinor <= quote.totalMinor),
  ),
);
export type CartQuote = typeof CartQuoteSchema.Type;
export const CartQuoteInvalidProblem = makeProblemDetailsSchema("CartQuoteInvalidProblem", 400, {
  state: Schema.Literal("invalid"),
});
export const CartQuoteForbiddenProblem = makeProblemDetailsSchema(
  "CartQuoteForbiddenProblem",
  403,
  { state: Schema.Literal("forbidden") },
);
export const CartQuoteScopeProblem = makeProblemDetailsSchema("CartQuoteScopeProblem", 409, {
  state: Schema.Literal("scope-mismatch"),
});
export const CartQuoteUnavailableProblem = makeProblemDetailsSchema(
  "CartQuoteUnavailableProblem",
  503,
  { state: Schema.Literal("unavailable") },
);
export class CartQuoteSchemaErrorMiddleware extends HttpApiMiddleware.Service<CartQuoteSchemaErrorMiddleware>()(
  "n1/CartQuoteSchemaErrorMiddleware",
  { error: CartQuoteInvalidProblem },
) {}
export const CartQuoteApi = HttpApi.make("N1CartQuote")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("cartQuote")
      .add(
        HttpApiEndpoint.post("quote", "/api/cart-quote", {
          error: [
            CartQuoteInvalidProblem,
            CartQuoteForbiddenProblem,
            CartQuoteScopeProblem,
            CartQuoteUnavailableProblem,
          ],
          payload: CartQuoteRequestSchema,
          success: CartQuoteSchema,
        }),
      )
      .middleware(CartQuoteSchemaErrorMiddleware),
  );
