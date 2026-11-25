import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
// The products Symmy imported into main's owners, read only through their governed reads, as the storefront workload
// (`commerce.storefront-client`): Catalog's product page (Tenant-wide, so no company is sent), Inventory's on-hand
// page and Pricing's catalogue page prices (both for this storefront's company). A visitor with a portal session has
// the prices read through Commerce's portal for that signed-in customer, with the customer's own Price Group (an item
// Pricing could not decide for the customer takes the guest price of the same page); a guest, a session Commerce no
// longer admits, or a portal price call that fails is priced as before. An import leaves its Products DRAFT with
// WORK_IN_PROGRESS Variants (Catalog's path to ACTIVE is not an import's), so the page asks for DRAFT and ACTIVE.
import { Effect, Predicate } from "effect";
import { cache } from "react";
import {
  hasUndecidedPrice,
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
import { createOperation, OntosError, OperationError, readRecords } from "./gateway";
import type { Operation, OperationOptions } from "./gateway";

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
    { lifecycles: ["DRAFT", "ACTIVE"], locale, limit, offset },
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
    if (error instanceof OperationError) throw error;
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
        const answer = await pricePage(
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
      operation.abort(error instanceof OperationError ? error.kind : "cancelled");
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
      operation.abort(error instanceof OperationError ? error.kind : "cancelled");
      throw error;
    } finally {
      operation.dispose();
      if (standalone) base.dispose();
    }
  },
);
