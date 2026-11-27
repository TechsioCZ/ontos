import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import "server-only";
import { guard, jsonValue, problem, requestDictionary } from "@/ontos/http";
import { createCatalog } from "@/ontos/catalog-model";
import { getCategoryTree, readProducts } from "@/ontos/catalog-server";
import { SEARCH_QUERY_MIN_LENGTH, searchQueryText } from "@/ontos/search-query";
import {
  matchCategories,
  placeholdersLast,
  toRemoteSuggestion,
  type RemoteSearchResponse,
} from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";
import { searchErpProductsWithin } from "@/ontos/erp-catalogue-server";
import { erpCopy, erpStockSummary, type ErpProduct } from "@/lib/erp-catalogue";
import type { Dictionary } from "@/i18n";

/** One ERP product as a header suggestion: it opens its „Novinky z ERP“ page. */
const erpSuggestion = (
  product: ErpProduct,
  t: Dictionary,
): RemoteSearchResponse["items"][number] => {
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
    priceExcludesVat: true,
    priceIsFrom: product.variants.length > 1,
    ...(product.variants.length === 1 && price?.kind !== "price"
      ? { priceUnavailableReason: erpCopy.priceOnRequest }
      : {}),
    hasVariants: product.variants.length > 1,
    ...(only?.sku && product.variants.length === 1 ? { variantSku: only.sku } : {}),
    path: `/novinky-z-erp/${encodeURIComponent(product.id)}`,
    ...erpStockSummary(product, t),
  };
};

/**
 * A header search answers within this long. A part not read by then (a new term's shop catalogue page, the tree or the
 * ERP snapshot while the owners are slow) is left out and the answer says so (`partial`): the header shows it, asks
 * again, and the shared read that goes on in the background answers that ask.
 */
const SEARCH_WAIT_MS = 600;

/** `read`'s answer, or undefined when it is not ready within `ms`; a failure within `ms` fails the search. */
const answeredWithin = async <A>(read: Promise<A>, ms: number): Promise<A | undefined> => {
  // A failure after `ms` belongs to the next ask, which joins or repeats the shared read.
  read.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    // The shop catalogue, its tree and the ERP catalogue (one shared snapshot) are read side by side, never after
    // each other, and none holds the answer longer than SEARCH_WAIT_MS.
    const [page, tree, erp] = await Promise.all([
      answeredWithin(
        readProducts({ q: term, page: 1, pageSize: 6 }, "card", false, { operation: lifetime }),
        SEARCH_WAIT_MS,
      ),
      answeredWithin(getCategoryTree("", { operation: lifetime }), SEARCH_WAIT_MS),
      searchErpProductsWithin(term, 4, lifetime, SEARCH_WAIT_MS),
    ]);
    // Every card carries validated owner attribution plus at most one market-priced presentation offer.
    const products = placeholdersLast(page?.products ?? []);
    const matches = await readSearchVariantMatches(products, term);
    const items = [
      ...erp.products.map((product) => erpSuggestion(product, t)),
      ...products.map((product) => toRemoteSuggestion(product, term, t, matches.get(product.id))),
    ];
    // The request's navigation tree is matched here so the browser never needs it.
    const model =
      tree === undefined
        ? undefined
        : createCatalog({ products: [], homepageFeaturedProductIds: [] }, { categories: tree });
    const categories =
      model === undefined
        ? []
        : matchCategories(model.getCategories(), model.getCategoryTrail, term);
    return Response.json(
      {
        items,
        total: (page?.total ?? 0) + erp.count,
        categories,
        ...(page === undefined || tree === undefined || erp.partial ? { partial: true } : {}),
      } satisfies RemoteSearchResponse,
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
