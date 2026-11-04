import "server-only";
import type { CatalogProduct, CatalogSearchMatch } from "@/ontos/catalog-types";
import { CatalogSearchMatchError } from "./catalog-projection";

/**
 * Complete owner attribution and singleton presentation for every hit of this search page. The catalog
 * projection validates the compact contract; routing never hydrates full groups, samples hits or re-matches
 * owner titles locally. A missing contract is an explicit outage, not an invented variant/filter link.
 */
export async function readSearchVariantMatches(
  products: readonly CatalogProduct[],
  query: string,
): Promise<Map<string, CatalogSearchMatch>> {
  const matches = new Map<string, CatalogSearchMatch>();
  if (!query.trim()) return matches;
  for (const product of products) {
    if (product.searchMatch === undefined) throw new CatalogSearchMatchError();
    matches.set(product.id, product.searchMatch);
  }
  return matches;
}
