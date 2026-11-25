import "server-only";
import { Effect, Schema } from "effect";
import type { CartScope } from "./cart-quote";
import { CatalogResponseSchema, projectCatalog } from "./catalog-model";
import type { StorefrontConfiguration } from "./config";
import { readOwner, StorefrontReadUnavailable } from "./gateway";
import { OrderedProductPresentationSchema } from "./ordered-product";

/** Optional current catalog media never replaces the saved order's names, prices or quantities. */
export const readOrderedProducts = (
  config: StorefrontConfiguration,
  scope: Pick<CartScope, "marketId" | "currency">,
  selectedIds: readonly string[],
) =>
  Effect.gen(function* readOrderedProductsProgram() {
    const productIds = [...new Set(selectedIds)];
    if (productIds.length > 50) {
      return [];
    }
    const hosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    const presentation: (typeof OrderedProductPresentationSchema.Encoded)[number][] = [];
    for (let offset = 0; offset < productIds.length; offset += 24) {
      const chunk = productIds.slice(offset, offset + 24);
      const requestedIds = new Set<string>(chunk);
      const body = yield* readOwner(
        config,
        "merchandise",
        "records",
        {
          view: {
            storefront: true,
            storefrontCatalog: {
              fields: "card",
              includeCategories: false,
              marketId: scope.marketId,
              pageSize: chunk.length,
              productIds: chunk,
            },
          },
        },
        CatalogResponseSchema,
      );
      if (
        !body.market.configured ||
        body.market.marketId !== scope.marketId ||
        body.market.currency !== scope.currency ||
        body.products.some((product) => !requestedIds.has(product.id)) ||
        new Set(body.products.map((product) => product.id)).size !== body.products.length
      ) {
        return yield* new StorefrontReadUnavailable({ reason: "contract" });
      }
      for (const product of projectCatalog(body, hosts).products) {
        presentation.push({ image: product.image, productId: product.id, slug: product.slug });
      }
    }
    return yield* Schema.decodeUnknownEffect(OrderedProductPresentationSchema)(presentation);
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.match({ onFailure: () => [], onSuccess: (presentation) => presentation }),
  );
