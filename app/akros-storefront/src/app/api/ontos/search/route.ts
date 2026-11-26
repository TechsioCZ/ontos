import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import "server-only";
import { guard, jsonValue, problem, requestDictionary } from "@/ontos/http";
import { getCatalogPage } from "@/ontos/catalog-server";
import { SEARCH_QUERY_MIN_LENGTH, searchQueryText } from "@/ontos/search-query";
import {
  matchCategories,
  placeholdersLast,
  toRemoteSuggestion,
  type RemoteSearchResponse,
} from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";
import { searchErpProductsWithin } from "@/ontos/erp-catalogue-server";
import { erpCopy, type ErpProduct } from "@/lib/erp-catalogue";

/** One ERP product as a header suggestion: it opens its „Novinky z ERP“ page. */
const erpSuggestion = (product: ErpProduct): RemoteSearchResponse["items"][number] => {
  const [only] = product.variants;
  const price = product.variants.length === 1 ? only?.price : undefined;
  return {
    productId: product.id,
    slug: product.id,
    name: product.name,
    imageSrc: product.imageSrc,
    currency: (price?.kind === "price"
      ? price.currencyCode
      : "CZK") as RemoteSearchResponse["items"][number]["currency"],
    priceMinor: price?.kind === "price" ? Math.round(Number(price.amount) * 100) : 0,
    priceIsFrom: product.variants.length > 1,
    ...(product.variants.length === 1 && price?.kind !== "price"
      ? { priceUnavailableReason: erpCopy.priceOnRequest }
      : {}),
    hasVariants: product.variants.length > 1,
    ...(only?.sku && product.variants.length === 1 ? { variantSku: only.sku } : {}),
    path: `/novinky-z-erp/${encodeURIComponent(product.id)}`,
  };
};

/** Every search POST and its owner fetches are request-time reads, never framework-cached answers. */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  const t = requestDictionary(request);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    guard(request, t);
    const body = await jsonValue(request, t, lifetime);
    const term = searchQueryText(
      body !== null && typeof body === "object" && "q" in body ? body.q : undefined,
    );
    if (term.length < SEARCH_QUERY_MIN_LENGTH)
      return Response.json({ items: [], total: 0, categories: [] } satisfies RemoteSearchResponse, {
        headers: noStore,
      });
    // The ERP catalogue is searched beside the shop catalogue (shared, cached reads), never after it.
    const [listing, erp] = await Promise.all([
      getCatalogPage({ q: term, page: 1, pageSize: 6 }, { operation: lifetime }),
      searchErpProductsWithin(term, 4, lifetime, 700),
    ]);
    // Every card carries validated owner attribution plus at most one market-priced presentation offer.
    const products = placeholdersLast(listing.products);
    const matches = await readSearchVariantMatches(products, term);
    const items = [
      ...erp.products.map(erpSuggestion),
      ...products.map((product) => toRemoteSuggestion(product, term, matches.get(product.id))),
    ];
    // The request's navigation tree is matched here so the browser never needs it.
    const categories = matchCategories(
      listing.model.getCategories(),
      listing.model.getCategoryTrail,
      term,
    );
    return Response.json(
      { items, total: listing.total + erp.count, categories } satisfies RemoteSearchResponse,
      {
        headers: noStore,
      },
    );
  } catch (e) {
    return problem(e, t.server.outage.search);
  } finally {
    lifetime.dispose();
  }
}
