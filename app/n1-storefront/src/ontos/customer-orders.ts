import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import {
  OrderAddressSchema,
  OrderContactSchema,
  OrderDeliveryRecipientSchema,
  OrderIdSchema,
  OrderLineSchema,
  OrderShippingSchema,
  OrderStatusSchema,
  VariantIdSchema,
} from "@app/merchandise/domain/merchandise-model";
import { MarketCurrencySchema, OrderMarketSchema } from "@app/merchandise/domain/market-offers";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

const offset = Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }));
const minor = Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }));
const validSelection = (value: { offset?: number; orderId?: string }) =>
  value.orderId === undefined || value.offset === undefined || value.offset === 0;

/** A browser selects a page or order, never the customer identity used to authorize it. */
export const CustomerOrdersInputSchema = Schema.Struct({
  locale: Schema.Literals(["cs", "en"]),
  offset: Schema.optionalKey(offset),
  orderId: Schema.optionalKey(Schema.toEncoded(OrderIdSchema)),
}).check(Schema.makeFilter(validSelection));
export type CustomerOrdersInput = typeof CustomerOrdersInputSchema.Type;

const CustomerOrdersQuerySchema = Schema.Struct({
  locale: CustomerOrdersInputSchema.fields.locale,
  offset: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    ),
  ),
  orderId: CustomerOrdersInputSchema.fields.orderId,
}).check(Schema.makeFilter(validSelection));

const CustomerOrderDetailSchema = Schema.Struct({
  billingAddress: Schema.NullOr(Schema.toEncoded(OrderAddressSchema)),
  contact: Schema.NullOr(Schema.toEncoded(OrderContactSchema)),
  deliveryAddress: Schema.NullOr(Schema.toEncoded(OrderAddressSchema)),
  deliveryRecipient: Schema.NullOr(Schema.toEncoded(OrderDeliveryRecipientSchema)),
  lines: Schema.Array(Schema.toEncoded(OrderLineSchema)),
  note: Schema.NullOr(Schema.String),
});
export const CustomerOrderSchema = Schema.Struct({
  createdAt: Schema.String,
  currency: MarketCurrencySchema,
  detail: Schema.NullOr(CustomerOrderDetailSchema),
  id: Schema.toEncoded(OrderIdSchema),
  market: Schema.NullOr(Schema.toEncoded(OrderMarketSchema)),
  number: Schema.String,
  preview: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      productId: Schema.toEncoded(OrderLineSchema.fields.productId),
      quantity: Schema.Finite.check(Schema.isGreaterThan(0)),
      sku: Schema.toEncoded(OrderLineSchema.fields.sku),
      variantId: Schema.NullOr(Schema.toEncoded(VariantIdSchema)),
      variantName: Schema.NullOr(Schema.String),
    }),
  ).check(Schema.isMaxLength(200)),
  pricesIncludeVat: Schema.NullOr(Schema.Boolean),
  shipping: Schema.NullOr(Schema.toEncoded(OrderShippingSchema)),
  status: OrderStatusSchema,
  totalMinor: minor,
  totalVatMinor: minor,
  updatedAt: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter(
    (order) =>
      order.totalVatMinor <= order.totalMinor &&
      (order.shipping === null || order.shipping.priceMinor <= order.totalMinor),
  ),
);
export type CustomerOrder = typeof CustomerOrderSchema.Type;
export const CustomerOrdersResultSchema = Schema.Struct({
  offset,
  orders: Schema.Array(CustomerOrderSchema).check(Schema.isMaxLength(50)),
  pageSize: Schema.Literal(50),
  total: offset,
});
export type CustomerOrdersResult = typeof CustomerOrdersResultSchema.Type;
export type CustomerOrdersView =
  | { data: CustomerOrdersResult; state: "ready"; viewerEmail: string }
  | { state: "anonymous" | "forbidden" | "unavailable" };

export const CustomerOrdersInvalidProblem = makeProblemDetailsSchema(
  "CustomerOrdersInvalidProblem",
  400,
  { state: Schema.Literal("invalid") },
);
export const CustomerOrdersAnonymousProblem = makeProblemDetailsSchema(
  "CustomerOrdersAnonymousProblem",
  401,
  { state: Schema.Literal("anonymous") },
);
export const CustomerOrdersForbiddenProblem = makeProblemDetailsSchema(
  "CustomerOrdersForbiddenProblem",
  403,
  { state: Schema.Literal("forbidden") },
);
export const CustomerOrdersUnavailableProblem = makeProblemDetailsSchema(
  "CustomerOrdersUnavailableProblem",
  503,
  { state: Schema.Literal("unavailable") },
);
export const CustomerOrdersProblemSchema = Schema.Union([
  CustomerOrdersInvalidProblem,
  CustomerOrdersAnonymousProblem,
  CustomerOrdersForbiddenProblem,
  CustomerOrdersUnavailableProblem,
]);
export class CustomerOrdersSchemaErrorMiddleware extends HttpApiMiddleware.Service<CustomerOrdersSchemaErrorMiddleware>()(
  "n1/CustomerOrdersSchemaErrorMiddleware",
  { error: CustomerOrdersInvalidProblem },
) {}
export const CustomerOrdersApi = HttpApi.make("N1CustomerOrders")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("customerOrders")
      .add(
        HttpApiEndpoint.get("list", "/api/customer-orders", {
          error: [
            CustomerOrdersInvalidProblem,
            CustomerOrdersAnonymousProblem,
            CustomerOrdersForbiddenProblem,
            CustomerOrdersUnavailableProblem,
          ],
          query: CustomerOrdersQuerySchema,
          success: CustomerOrdersResultSchema,
        }),
      )
      .middleware(CustomerOrdersSchemaErrorMiddleware),
  );
