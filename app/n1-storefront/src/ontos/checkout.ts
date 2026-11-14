import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import {
  OrderAddressSchema,
  OrderContactSchema,
  OrderStatusSchema,
  ShippingMethodSchema,
} from "@app/merchandise/domain/merchandise-model";
import { StorefrontOrderLineResultSchema } from "@app/merchandise/contracts/apply-command";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { CartQuoteRequestSchema, CartQuoteSchema, CartScopeSchema } from "./cart-quote";

const minor = Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }));
const name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const CheckoutRequestSchema = Schema.Struct({
  ...CartQuoteRequestSchema.fields,
  address: Schema.toEncoded(OrderAddressSchema),
  clientRequestId: Schema.String.check(Schema.isUUID()),
  contact: Schema.Struct({
    email: Schema.Trim.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(200),
      Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
    ),
    firstName: name,
    lastName: name,
    phone: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(40))),
  }),
  expectedShippingPriceMinor: minor,
  mode: Schema.Literals(["quote", "place"]),
  shippingMethod: ShippingMethodSchema,
});
export type CheckoutRequest = typeof CheckoutRequestSchema.Type;
const CheckoutReceiptSchema = Schema.Struct({
  contact: Schema.NullOr(Schema.toEncoded(OrderContactSchema)),
  createdAt: Schema.NullOr(Schema.String),
  deliveryAddress: Schema.NullOr(Schema.toEncoded(OrderAddressSchema)),
  shippingMethod: Schema.NullOr(ShippingMethodSchema),
});

export const CheckoutProductPresentationSchema = Schema.Array(
  Schema.Struct({
    image: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
    productId: StorefrontOrderLineResultSchema.fields.productId,
    slug: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  }),
).check(
  Schema.isMaxLength(50),
  Schema.makeFilter((items) => new Set(items.map((item) => item.productId)).size === items.length),
);

/** Amounts include the selected shipping method. Never reuse the goods-only CartQuote. */
export const CheckoutResultSchema = Schema.Struct({
  issues: CartQuoteSchema.fields.issues,
  lines: Schema.Array(
    Schema.Struct({
      ...StorefrontOrderLineResultSchema.fields,
      // The public saved-order read has owner unit prices and totals, not per-line totals.
      lineTotalMinor: Schema.NullOr(minor),
    }),
  ),
  orderId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  orderNumber: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  outcome: Schema.Literals(["VALID", "REJECTED", "PLACED", "REPLAYED"]),
  productPresentation: Schema.optionalKey(CheckoutProductPresentationSchema),
  receipt: Schema.optionalKey(Schema.NullOr(CheckoutReceiptSchema)),
  scope: CartScopeSchema,
  shippingPriceMinor: Schema.NullOr(minor),
  status: Schema.NullOr(OrderStatusSchema),
  totalMinor: Schema.NullOr(minor),
  /** Owner VAT includes both goods and shipping; it is not the goods-only tax from the Figma fixture. */
  totalVatMinor: Schema.NullOr(minor),
}).check(
  Schema.makeFilter((result) => {
    if (
      result.totalMinor !== null &&
      result.totalVatMinor !== null &&
      result.totalVatMinor > result.totalMinor
    ) {
      return false;
    }
    if (
      result.totalMinor !== null &&
      result.shippingPriceMinor !== null &&
      result.shippingPriceMinor > result.totalMinor
    ) {
      return false;
    }
    if (result.outcome === "REJECTED") {
      return result.orderId === null && result.orderNumber === null;
    }
    if (
      result.totalMinor === null ||
      result.totalVatMinor === null ||
      result.shippingPriceMinor === null ||
      result.issues.length !== 0 ||
      result.lines.length === 0
    ) {
      return false;
    }
    return result.outcome === "VALID"
      ? result.orderId === null && result.orderNumber === null
      : result.orderId !== null && result.orderNumber !== null && result.status !== null;
  }),
);
export type CheckoutResult = typeof CheckoutResultSchema.Type;
export const CheckoutRecoveryRequestSchema = Schema.Struct({
  clientRequestId: CheckoutRequestSchema.fields.clientRequestId,
  locale: CartQuoteRequestSchema.fields.locale,
  scope: CartScopeSchema,
});
export type CheckoutRecoveryRequest = typeof CheckoutRecoveryRequestSchema.Type;
export const CheckoutRecoverySchema = Schema.Union([
  Schema.Struct({ result: CheckoutResultSchema, state: Schema.Literal("confirmed") }),
  Schema.Struct({ state: Schema.Literal("unconfirmed") }),
]).check(
  Schema.makeFilter(
    (recovery) =>
      recovery.state === "unconfirmed" ||
      recovery.result.outcome === "PLACED" ||
      recovery.result.outcome === "REPLAYED",
  ),
);
export const CheckoutInvalidProblem = makeProblemDetailsSchema("CheckoutInvalidProblem", 400, {
  state: Schema.Literal("invalid"),
});
export const CheckoutForbiddenProblem = makeProblemDetailsSchema("CheckoutForbiddenProblem", 403, {
  state: Schema.Literal("forbidden"),
});
export const CheckoutScopeProblem = makeProblemDetailsSchema("CheckoutScopeProblem", 409, {
  state: Schema.Literal("scope-mismatch"),
});
export const CheckoutUnavailableProblem = makeProblemDetailsSchema(
  "CheckoutUnavailableProblem",
  503,
  { state: Schema.Literal("unavailable") },
);
export const CheckoutUncertainProblem = makeProblemDetailsSchema("CheckoutUncertainProblem", 503, {
  state: Schema.Literal("uncertain"),
});
export class CheckoutSchemaErrorMiddleware extends HttpApiMiddleware.Service<CheckoutSchemaErrorMiddleware>()(
  "n1/CheckoutSchemaErrorMiddleware",
  { error: CheckoutInvalidProblem },
) {}
export const CheckoutApi = HttpApi.make("N1Checkout")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("checkout")
      .add(
        HttpApiEndpoint.post("execute", "/api/checkout", {
          error: [
            CheckoutInvalidProblem,
            CheckoutForbiddenProblem,
            CheckoutScopeProblem,
            CheckoutUnavailableProblem,
            CheckoutUncertainProblem,
          ],
          payload: CheckoutRequestSchema,
          success: CheckoutResultSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("status", "/api/checkout/status", {
          error: [
            CheckoutInvalidProblem,
            CheckoutForbiddenProblem,
            CheckoutScopeProblem,
            CheckoutUnavailableProblem,
            CheckoutUncertainProblem,
          ],
          payload: CheckoutRecoveryRequestSchema,
          success: CheckoutRecoverySchema,
        }),
      )
      .middleware(CheckoutSchemaErrorMiddleware),
  );
