import "server-only";
import { Effect } from "effect";
import { getCatalog } from "./catalog";
import type { CardVariantsQuery, CardVariantsResult } from "./card-variants";

/** Reuse the market-checked public full projection, bounded to one exact slug. */
export const readCardVariants = (query: CardVariantsQuery): Effect.Effect<CardVariantsResult> =>
  Effect.promise(
    async () => await getCatalog(query.locale, JSON.stringify({ slug: query.slug })),
  ).pipe(
    Effect.map((result): CardVariantsResult => {
      if (result.state !== "ready" || !result.catalog.configured) {
        return { state: "unavailable" };
      }
      const product = result.catalog.details.find(
        (item) => item.id === query.productId && item.slug === query.slug,
      );
      return product === undefined
        ? { state: "unavailable" }
        : {
            productId: product.id,
            slug: product.slug,
            state: "ready",
            variants: product.variants.map(({ id, name }) => ({ id, name })),
          };
    }),
  );
