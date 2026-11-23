import "server-only";
import { Effect, Struct } from "effect";
import { productCardForVariant } from "@/features/product-selection";
import { getCatalog } from "./catalog";
import type { CardVariantsQuery, CardVariantsResult } from "./card-variants";
import type { ProductCardModel } from "./catalog-model";

const favoriteCard = (card: ProductCardModel) =>
  Struct.pick(card, [
    "currency",
    "image",
    "name",
    "priceExcludingVatMinor",
    "priceFrom",
    "priceMinor",
    "sku",
    "stock",
  ]);

/** Reuse the market-checked public full projection, bounded to one exact slug. */
export const readCardVariants = (
  query: CardVariantsQuery,
  readCatalog: typeof getCatalog = getCatalog,
): Effect.Effect<CardVariantsResult> =>
  Effect.promise(
    async () => await readCatalog(query.locale, JSON.stringify({ slug: query.slug })),
  ).pipe(
    Effect.map((result): CardVariantsResult => {
      if (result.state !== "ready" || !result.catalog.configured) {
        return { state: "unavailable" };
      }
      const product = result.catalog.details.find(
        (item) => item.id === query.productId && item.slug === query.slug,
      );
      if (product === undefined) {
        return { state: "unavailable" };
      }
      const summary = {
        productId: product.id,
        slug: product.slug,
        state: "ready" as const,
        variants: product.variants.map((variant) => {
          const reference = { id: variant.id, name: variant.name };
          return query.details === "true"
            ? { ...reference, favoriteCard: favoriteCard(productCardForVariant(product, variant)) }
            : reference;
        }),
      };
      return query.details === "true" && product.variantCount === 0
        ? { ...summary, favoriteCard: favoriteCard(product) }
        : summary;
    }),
  );
