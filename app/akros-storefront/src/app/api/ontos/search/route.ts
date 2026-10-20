import "server-only";
import { guard, jsonBody, problem } from "@/ontos/http";
import { getCatalogPage } from "@/ontos/catalog-server";
import { toRemoteSuggestion, type RemoteSearchResponse } from "@/ontos/search-suggestions";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  try {
    guard(request);
    const { q } = (await jsonBody(request)) as { q?: unknown };
    const term = typeof q === "string" ? q.trim().slice(0, 200) : "";
    if (term.length < 2)
      return Response.json({ items: [], total: 0 } satisfies RemoteSearchResponse, {
        headers: noStore,
      });
    const listing = await getCatalogPage({ q: term, page: 1, pageSize: 6 });
    const matches = new Map(
      listing.model.searchCatalog(term).map((result) => [result.product.id, result] as const),
    );
    const items = listing.products.map((product) =>
      toRemoteSuggestion(matches.get(product.id) ?? { product, matchingVariants: [] }),
    );
    return Response.json({ items, total: listing.total } satisfies RemoteSearchResponse, {
      headers: noStore,
    });
  } catch (e) {
    return problem(e);
  }
}
