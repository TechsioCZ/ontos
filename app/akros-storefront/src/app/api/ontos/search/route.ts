import "server-only";
import { guard, jsonBody, outageMessage, problem } from "@/ontos/http";
import { getCatalogPage } from "@/ontos/catalog-server";
import {
  matchCategories,
  placeholdersLast,
  toRemoteSuggestion,
  type RemoteSearchResponse,
} from "@/ontos/search-suggestions";
import { readSearchVariantMatches, SUGGESTION_VARIANT_GROUPS } from "@/ontos/search-variants";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  try {
    guard(request);
    const { q } = (await jsonBody(request)) as { q?: unknown };
    const term = typeof q === "string" ? q.trim().slice(0, 200) : "";
    if (term.length < 2)
      return Response.json({ items: [], total: 0, categories: [] } satisfies RemoteSearchResponse, {
        headers: noStore,
      });
    const listing = await getCatalogPage({ q: term, page: 1, pageSize: 6 });
    // Exact SKU / variant hits open that variant: the page's variant groups are read in full and matched.
    const products = placeholdersLast(listing.products);
    const matches = await readSearchVariantMatches(products, term, SUGGESTION_VARIANT_GROUPS);
    const items = products.map((product) =>
      toRemoteSuggestion(product, term, matches.get(product.id)),
    );
    // The cached navigation tree is matched here so the browser never needs it.
    const categories = matchCategories(
      listing.model.getCategories(),
      listing.model.getCategoryTrail,
      term,
    );
    return Response.json(
      { items, total: listing.total, categories } satisfies RemoteSearchResponse,
      {
        headers: noStore,
      },
    );
  } catch (e) {
    return problem(e, outageMessage.search);
  }
}
