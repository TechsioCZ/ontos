import { Schema } from "effect";
import { ProductCardModelSchema } from "./catalog-model";

export const SearchSuggestionsResponse = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({
    products: Schema.Array(ProductCardModelSchema).check(Schema.isMaxLength(8)),
    state: Schema.Literal("ready"),
  }),
]);

export type SearchSuggestionsResult = typeof SearchSuggestionsResponse.Type;
