import "server-only";
import type { CatalogProduct } from "@/ontos/catalog-types";
import { readProducts } from "./catalog-server";
import { matchSearchVariants, type SearchVariantMatch } from "./search-suggestions";

/** Merchandise returns at most two `full` products per read unless `variantIds` narrows the variants. */
const FULL_PAGE_LIMIT = 2;

/**
 * At most this many variant groups of one search page are read in full (stage runs on one CPU); later hits keep
 * the query filter link, which opens the same variant table pre-filtered.
 */
const SEARCH_PAGE_VARIANT_GROUPS = 8;
export const SUGGESTION_VARIANT_GROUPS = 2;

/**
 * Exact variant hits of one search page. OntOS search answers with listing cards (no variant records), so the
 * variant groups of the page are read in full (two per owner read, in parallel, sharing the ten-second product
 * cache) and matched against the query. A failed read only drops that routing: those hits keep the query filter.
 */
export async function readSearchVariantMatches(
  products: readonly CatalogProduct[],
  query: string,
  maxGroups: number = SEARCH_PAGE_VARIANT_GROUPS,
): Promise<Map<string, SearchVariantMatch>> {
  const groupIds = [
    ...new Set(products.filter((product) => product.variantSummary.count > 0).map(({ id }) => id)),
  ].slice(0, maxGroups);
  const chunks: string[][] = [];
  for (let start = 0; start < groupIds.length; start += FULL_PAGE_LIMIT)
    chunks.push(groupIds.slice(start, start + FULL_PAGE_LIMIT));
  const pages = await Promise.all(
    chunks.map((productIds) =>
      readProducts({ productIds, pageSize: productIds.length }, "full").then(
        (page) => page.products,
        () => [],
      ),
    ),
  );
  const matches = new Map<string, SearchVariantMatch>();
  for (const product of pages.flat())
    if (groupIds.includes(product.id)) matches.set(product.id, matchSearchVariants(product, query));
  return matches;
}
