import { Schema, Struct } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ProductCardModelSchema } from "./catalog-model";

export const CardVariantsQuerySchema = Schema.Struct({
  details: Schema.optionalKey(Schema.Literal("true")),
  locale: Schema.Literals(["cs", "en"]),
  productId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  slug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type CardVariantsQuery = typeof CardVariantsQuerySchema.Type;
const FavoriteCardSchema = Schema.Struct(
  Struct.pick(ProductCardModelSchema.fields, [
    "currency",
    "image",
    "name",
    "priceExcludingVatMinor",
    "priceFrom",
    "priceMinor",
    "sku",
    "stock",
  ]),
);
export type FavoriteCard = typeof FavoriteCardSchema.Type;
export const CardVariantsResultSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({
    favoriteCard: Schema.optionalKey(FavoriteCardSchema),
    productId: Schema.String,
    slug: Schema.String,
    state: Schema.Literal("ready"),
    variants: Schema.Array(
      Schema.Struct({
        favoriteCard: Schema.optionalKey(FavoriteCardSchema),
        id: Schema.String,
        name: Schema.String,
      }),
    ),
  }),
]);
export type CardVariantsResult = typeof CardVariantsResultSchema.Type;

/** A single requested product; card previews never trigger this read on mount. */
export const CardVariantsApi = HttpApi.make("N1CardVariants").add(
  HttpApiGroup.make("cardVariants").add(
    HttpApiEndpoint.get("read", "/api/card-variants", {
      query: CardVariantsQuerySchema,
      success: CardVariantsResultSchema,
    }),
  ),
);
