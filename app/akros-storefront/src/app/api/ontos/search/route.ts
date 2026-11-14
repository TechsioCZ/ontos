import "server-only";
import { guard, jsonBody, problem, requestDictionary } from "@/ontos/http";
import { getCatalogPage } from "@/ontos/catalog-server";
import { SEARCH_QUERY_MIN_LENGTH, searchQueryText } from "@/ontos/search-query";
import {
  matchCategories,
  placeholdersLast,
  toRemoteSuggestion,
  type RemoteSearchResponse,
} from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";

/** Every search POST and its owner fetches are request-time reads, never framework-cached answers. */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const { q } = (await jsonBody(request, t)) as { q?: unknown };
    const term = searchQueryText(q);
    if (term.length < SEARCH_QUERY_MIN_LENGTH)
      return Response.json({ items: [], total: 0, categories: [] } satisfies RemoteSearchResponse, {
        headers: noStore,
      });
    const listing = await getCatalogPage({ q: term, page: 1, pageSize: 6 });
    // Every card carries validated owner attribution plus at most one market-priced presentation offer.
    const products = placeholdersLast(listing.products);
    const matches = await readSearchVariantMatches(products, term);
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
    return problem(e, t.server.outage.search);
  }
}
