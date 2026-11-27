import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
// The products Symmy imported into main's owners, read only through their governed reads, as the storefront workload
// (`commerce.storefront-client`): Catalog's product page (Tenant-wide, so no company is sent), Inventory's on-hand
// page and Pricing's catalogue page prices (both for this storefront's company). A visitor with a portal session has
// the prices read through Commerce's portal for that signed-in customer, with the customer's own Price Group (an item
// Pricing could not decide for the customer takes the guest price of the same page); a guest, a session Commerce no
// longer admits, or a portal price call that fails is priced as before. Only ACTIVE Products are sold: an import
// leaves its Products DRAFT („Koncept“) until staff activate them in the ERP product editor.
import { Effect, Predicate } from "effect";
import { cache } from "react";
import { isOperationError } from "@ontos/storefront-runtime";
import {
  erpItemMatches,
  hasUndecidedPrice,
  isErpProductShown,
  shownVariantRefs,
  toErpProducts,
  withGuestPricesWhereUndecided,
  type CatalogPagePrices,
  type CatalogProductPage,
  type CatalogVariantOnHand,
  type ErpProduct,
} from "@/lib/erp-catalogue";
import { portalCookie, portalRequest, requestPortal } from "./account";
import { getActiveMarket, marketReadsFor } from "./active-market";
import { getErpOffer, type ErpOffer } from "./erp-config";
import { createOperation, OntosError, readRecords } from "./gateway";
import type { Operation, OperationOptions } from "./gateway";
import { freshRead, latestFreshRead } from "./fresh-read";

/** The owners answer at most 100 variants per stock or price read. */
const VARIANT_PAGE = 100;
/** A product detail looks its product up in Catalog's pages of 100 (the read has no product filter). */
const DETAIL_PAGE = 100;
const DETAIL_PAGES = 20;

/** Stock and pricing share this worker count, not one pool each. */
export const ERP_JOIN_CONCURRENCY = 4;
/** A bounded page cannot expand into an unbounded number of owner joins. */
export const ERP_VARIANT_LIMIT = 2_000;

const readCatalogPage = async (
  locale: string,
  offset: number,
  limit: number,
  operation: Operation,
): Promise<CatalogProductPage> => {
  operation.check();
  const page = (await readRecords(
    "catalog",
    "product-page",
    { lifecycles: ["ACTIVE"], locale, limit, offset },
    { company: false, operation },
  )) as CatalogProductPage;
  if (page.items.length > limit)
    throw new OntosError("Catalog exceeded its product page bound", 502, "erp_page_oversize");
  return page;
};

/**
 * The page priced for the signed-in customer through Commerce's portal, or undefined when the visitor is priced as a
 * guest: no portal session, a session the portal does not admit (401/403), or any other failure of the customer call.
 * A signed-in customer never loses the page to their own price call; only a Shell that cannot be reached at all fails
 * it, as it fails every other read of the page.
 */
const customerPricePage = async (
  page: unknown,
  operation: Operation,
): Promise<CatalogPagePrices | undefined> => {
  operation.check();
  const { origin, cookie } = await requestPortal();
  if (portalCookie(cookie) === "") return undefined;
  try {
    const response = await portalRequest("/catalog-page-prices", origin, cookie, page, undefined, {
      operation,
    });
    if (response.ok) return (await response.json()) as CatalogPagePrices;
    const text = await response.text();
    if (response.status !== 401 && response.status !== 403)
      console.error(
        `[ontos] customer catalogue page prices -> HTTP ${response.status} ${/"code":"([\w.-]+)"/u.exec(text)?.[1] ?? ""}; priced as a guest`,
      );
  } catch (error) {
    operation.check();
    if (isOperationError(error)) throw error;
    if (OntosError.is(error) && error.code === "backend_unreachable") throw error;
    console.error(
      `[ontos] customer catalogue page prices failed (${String(error)}); priced as a guest`,
    );
  }
  return undefined;
};

const guestPricePage = async (page: unknown, operation: Operation): Promise<CatalogPagePrices> =>
  (await readRecords("pricing", "catalog-page-prices", page, { operation })) as CatalogPagePrices;

/**
 * The page priced for the signed-in customer, else as a guest. When Pricing could not decide some item of the
 * customer's page, the page is read once more as a guest and those items show the guest price, so a signed-in customer
 * never sees „Cena na dotaz“ where a guest sees a price.
 */
const pricePage = async (page: unknown, operation: Operation): Promise<CatalogPagePrices> => {
  const customer = await customerPricePage(page, operation);
  operation.check();
  if (customer === undefined) return await guestPricePage(page, operation);
  if (!hasUndecidedPrice(customer)) return customer;
  return withGuestPricesWhereUndecided(customer, await guestPricePage(page, operation));
};

const withOffers = async (
  offer: ErpOffer,
  page: CatalogProductPage,
  operation: Operation,
  guest = false,
): Promise<ErpProduct[]> => {
  operation.check();
  const variantRefs = shownVariantRefs(page);
  if (variantRefs.length > ERP_VARIANT_LIMIT)
    throw new OntosError("Catalog exceeded its variant bound", 502, "erp_variants_oversize");
  if (variantRefs.length === 0) return toErpProducts(page, [], undefined);
  const products = new Map(
    page.items.flatMap((item) =>
      item.variants.map(({ variantRef }) => [variantRef.resourceId, item.productRef] as const),
    ),
  );
  const pages = Math.ceil(variantRefs.length / VARIANT_PAGE);
  const stock: CatalogVariantOnHand[][] = [];
  const prices: CatalogPagePrices[] = [];
  let next = 0;
  const work = async () => {
    while (next < pages * 2) {
      operation.check();
      // Claim only when a worker is free. Stock and price jobs alternate in the same lazy queue.
      const job = next++;
      const index = Math.floor(job / 2);
      const refs = variantRefs.slice(index * VARIANT_PAGE, (index + 1) * VARIANT_PAGE);
      if (job % 2 === 0) {
        const answer = (await readRecords(
          "inventory",
          "catalog-variant-on-hand-page",
          {
            customerConfigurationId: offer.customerConfigurationId,
            variantRefs: refs,
          },
          { operation },
        )) as { items: CatalogVariantOnHand[] };
        if (answer.items.length > refs.length)
          throw new OntosError("Inventory exceeded its reference bound", 502, "erp_stock_oversize");
        stock[index] = answer.items;
      } else {
        const answer = await (guest ? guestPricePage : pricePage)(
          {
            channelId: offer.channelId,
            currencyCode: offer.currencyCode,
            marketId: offer.marketId,
            items: refs.flatMap((variantRef) => {
              const productRef = products.get(variantRef.resourceId);
              return productRef === undefined
                ? []
                : [
                    {
                      catalogSelection: { productRef, variantRef },
                      unitBasis: {
                        quantity: offer.unitQuantity,
                        unitRef: {
                          moduleId: "commerce.catalog",
                          resourceId: offer.unitId,
                          resourceType: "commerce.catalog.product-unit",
                          tenantId: productRef.tenantId,
                        },
                      },
                    },
                  ];
            }),
          },
          operation,
        );
        if (Predicate.isTagged(answer, "CATALOG_PAGE_PRICED") && answer.prices.length > refs.length)
          throw new OntosError("Pricing exceeded its reference bound", 502, "erp_prices_oversize");
        prices[index] = answer;
      }
    }
  };
  // Only the fixed workers are created eagerly, never one Promise per reference chunk.
  await Promise.all(Array.from({ length: Math.min(ERP_JOIN_CONCURRENCY, pages * 2) }, work));
  operation.check();
  const refused = prices.find((answer) => !Predicate.isTagged(answer, "CATALOG_PAGE_PRICED"));
  return toErpProducts(
    page,
    stock.flat(),
    refused ?? {
      _tag: "CATALOG_PAGE_PRICED",
      prices: prices.flatMap((answer) =>
        Predicate.isTagged(answer, "CATALOG_PAGE_PRICED") ? answer.prices : [],
      ),
    },
  );
};

const requireOffer = (): ErpOffer => {
  const offer = getErpOffer();
  if (offer === undefined)
    throw new Error("ONTOS_STOREFRONT_ERP_OFFERS has no offer for this storefront's company");
  return offer;
};

/** One page of imported products. One deadline and caller signal cover market, Catalog and both joins. */
export const readErpCataloguePage = cache(
  async (
    offset: number,
    limit: number,
    options: OperationOptions = {},
  ): Promise<{ count: number; products: ErpProduct[] }> => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DETAIL_PAGE
    )
      throw new RangeError("Invalid ERP product page bounds");
    const standalone = options.operation === undefined && !hasRenderLifetime();
    const base =
      options.operation ?? (standalone ? Effect.runSync(createOperation()) : renderOperation());
    const operation = Effect.runSync(
      createOperation({
        signal: AbortSignal.any([base.signal, ...(options.signal ? [options.signal] : [])]),
        parent: base,
      }),
    );
    try {
      const offer = requireOffer();
      const { locale } = await getActiveMarket(
        marketReadsFor(
          options.signal === undefined || options.signal === base.signal ? base : operation,
        ),
      );
      const page = await readCatalogPage(locale, offset, limit, operation);
      return { count: page.count, products: await withOffers(offer, page, operation) };
    } catch (error) {
      operation.abort(isOperationError(error) ? error.kind : "cancelled");
      throw error;
    } finally {
      operation.dispose();
      if (standalone) base.dispose();
    }
  },
);

/** One imported product, with a bounded catalog scan and the same cancellation through its joins. */
export const readErpProduct = cache(
  async (productId: string, options: OperationOptions = {}): Promise<ErpProduct | undefined> => {
    const standalone = options.operation === undefined && !hasRenderLifetime();
    const base =
      options.operation ?? (standalone ? Effect.runSync(createOperation()) : renderOperation());
    const operation = Effect.runSync(
      createOperation({
        signal: AbortSignal.any([base.signal, ...(options.signal ? [options.signal] : [])]),
        parent: base,
      }),
    );
    try {
      const offer = requireOffer();
      const { locale } = await getActiveMarket(
        marketReadsFor(
          options.signal === undefined || options.signal === base.signal ? base : operation,
        ),
      );
      for (let index = 0; index < DETAIL_PAGES; index += 1) {
        const page = await readCatalogPage(locale, index * DETAIL_PAGE, DETAIL_PAGE, operation);
        const item = page.items.find(({ productRef }) => productRef.resourceId === productId);
        if (item !== undefined)
          return (await withOffers(offer, { count: 1, items: [item] }, operation))[0];
        if ((index + 1) * DETAIL_PAGE >= page.count) return undefined;
      }
      return undefined;
    } catch (error) {
      operation.abort(isOperationError(error) ? error.kind : "cancelled");
      throw error;
    } finally {
      operation.dispose();
      if (standalone) base.dispose();
    }
  },
);

/**
 * Search answers come from one snapshot of every ERP product Catalog answers the storefront (up to the detail scan
 * bound), priced as a guest with its stock, that every shopper shares. Catalog and Pricing have no revision to check,
 * so a search takes a snapshot whose reads started at most ERP_SNAPSHOT_TIMING.maxAgeMs ago: a product state or price
 * saved in the ERP editor is in every search that long after the save. While shoppers search, the snapshot is read
 * again in the background, so a search does not wait for the owners; when that read is slower than its interval (the
 * stage owners take 1-5 s under load), a search waits at most 300 ms for it and otherwise takes the newest snapshot.
 */
const ERP_SNAPSHOT_TIMING = {
  maxAgeMs: 1_800,
  intervalMs: 500,
  keepAliveMs: 10 * 60_000,
  waitMs: 300,
};
type ErpPageItem = CatalogProductPage["items"][number];
interface ErpSnapshot {
  readonly items: readonly ErpPageItem[];
  readonly products: ReadonlyMap<string, ErpProduct>;
}

const erpSnapshotKey = (locale: string) => `erp-snapshot:${locale}`;
const erpSnapshot = (offer: ErpOffer, locale: string, caller: Operation) =>
  freshRead(
    erpSnapshotKey(locale),
    ERP_SNAPSHOT_TIMING,
    async (operation): Promise<ErpSnapshot> => {
      const items: ErpPageItem[] = [];
      for (let index = 0; index < DETAIL_PAGES; index += 1) {
        const page = await readCatalogPage(locale, index * DETAIL_PAGE, DETAIL_PAGE, operation);
        items.push(...page.items.filter(isErpProductShown));
        if ((index + 1) * DETAIL_PAGE >= page.count) break;
      }
      const products = await withOffers(offer, { count: items.length, items }, operation, true);
      return { items, products: new Map(products.map((product) => [product.id, product])) };
    },
    caller,
  );

/** The ERP products of a snapshot that a search query finds (the same products „Novinky z ERP“ shows). */
const snapshotMatches = (snapshot: ErpSnapshot, term: string, limit: number) => {
  const matched = snapshot.items.filter((item) => erpItemMatches(item, term));
  return {
    count: matched.length,
    products: matched.slice(0, limit).flatMap((item) => {
      const product = snapshot.products.get(item.productRef.resourceId);
      return product === undefined ? [] : [product];
    }),
  };
};

/**
 * The ERP products a search query finds, priced as a guest, within `ms` (search never waits longer on the ERP read).
 * A snapshot read slower than that answers from the newest snapshot an owner outage would still serve, while the read
 * goes on for the next search. Only a search before any snapshot was read (or one that cannot learn its market in
 * time) answers without ERP products, and says so (`partial`) so the header asks again instead of keeping it.
 */
export const searchErpProductsWithin = async (
  query: string,
  limit: number,
  operation: Operation,
  ms: number,
): Promise<{ count: number; products: ErpProduct[]; partial: boolean }> => {
  const offer = getErpOffer();
  const term = query.trim();
  if (offer === undefined || term === "") return { count: 0, products: [], partial: false };
  const market: { locale?: string } = {};
  const read = (async () => {
    market.locale = (await getActiveMarket(marketReadsFor(operation))).locale;
    return snapshotMatches(await erpSnapshot(offer, market.locale, operation), term, limit);
  })().catch((error: unknown) => {
    if (!operation.signal.aborted) console.error(`[ontos] ERP search failed (${String(error)})`);
    return undefined;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
    if (answer !== undefined) return { ...answer, partial: false };
  } finally {
    clearTimeout(timer);
  }
  const kept =
    market.locale === undefined
      ? undefined
      : latestFreshRead<ErpSnapshot>(erpSnapshotKey(market.locale));
  if (kept !== undefined) return { ...snapshotMatches(kept, term, limit), partial: false };
  if (!operation.signal.aborted)
    console.error(
      `[ontos] ERP search had no snapshot within ${ms} ms; searched without ERP products`,
    );
  return { count: 0, products: [], partial: true };
};
