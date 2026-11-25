import { StorefrontOrderLineResultSchema } from "@app/merchandise/contracts/apply-command";
import { Schema } from "effect";

export const OrderedProductPresentationSchema = Schema.Array(
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
