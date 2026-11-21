import "server-only";
// The products Symmy imported into main's owners, read only through their governed reads, as the storefront workload
// (`commerce.storefront-client`): Catalog's product page (Tenant-wide, so no company is sent), Inventory's on-hand
// page and Pricing's catalogue page prices (both for this storefront's company). An import leaves its Products DRAFT
// with WORK_IN_PROGRESS Variants (Catalog's path to ACTIVE is not an import's), so the page asks for DRAFT and ACTIVE.
import { Predicate } from "effect";
import { cache } from "react";
import {
  shownVariantRefs,
  toErpProducts,
  type CatalogPagePrices,
  type CatalogProductPage,
  type CatalogVariantOnHand,
  type ErpProduct,
  type OwnerRef,
} from "@/lib/erp-catalogue";
import { getActiveMarket } from "./active-market";
import { getErpOffer, type ErpOffer } from "./erp-config";
import { readRecords } from "./gateway";

/** The owners answer at most 100 variants per stock or price read. */
const VARIANT_PAGE = 100;
/** A product detail looks its product up in Catalog's pages of 100 (the read has no product filter). */
const DETAIL_PAGE = 100;
const DETAIL_PAGES = 20;

const chunks = <T>(values: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += VARIANT_PAGE)
    out.push(values.slice(index, index + VARIANT_PAGE));
  return out;
};

const readCatalogPage = async (locale: string, offset: number, limit: number) =>
  (await readRecords(
    "catalog",
    "product-page",
    { lifecycles: ["DRAFT", "ACTIVE"], locale, limit, offset },
    { company: false },
  )) as CatalogProductPage;

const readOnHand = async (offer: ErpOffer, variantRefs: readonly OwnerRef[]) =>
  (
    await Promise.all(
      chunks(variantRefs).map(
        async (page) =>
          (
            (await readRecords("inventory", "catalog-variant-on-hand-page", {
              customerConfigurationId: offer.customerConfigurationId,
              variantRefs: page,
            })) as { items: CatalogVariantOnHand[] }
          ).items,
      ),
    )
  ).flat();

const readPrices = async (
  offer: ErpOffer,
  page: CatalogProductPage,
  variantRefs: readonly OwnerRef[],
): Promise<CatalogPagePrices | undefined> => {
  const products = new Map(
    page.items.flatMap((item) =>
      item.variants.map(({ variantRef }) => [variantRef.resourceId, item.productRef] as const),
    ),
  );
  const answers = await Promise.all(
    chunks(variantRefs).map(
      async (refs) =>
        (await readRecords("pricing", "catalog-page-prices", {
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
        })) as CatalogPagePrices,
    ),
  );
  const refused = answers.find((answer) => !Predicate.isTagged(answer, "CATALOG_PAGE_PRICED"));
  if (refused !== undefined) return refused;
  return {
    _tag: "CATALOG_PAGE_PRICED",
    prices: answers.flatMap((answer) =>
      Predicate.isTagged(answer, "CATALOG_PAGE_PRICED") ? answer.prices : [],
    ),
  };
};

const withOffers = async (offer: ErpOffer, page: CatalogProductPage): Promise<ErpProduct[]> => {
  const variantRefs = shownVariantRefs(page);
  if (variantRefs.length === 0) return toErpProducts(page, [], undefined);
  const [onHand, prices] = await Promise.all([
    readOnHand(offer, variantRefs),
    readPrices(offer, page, variantRefs),
  ]);
  return toErpProducts(page, onHand, prices);
};

const requireOffer = (): ErpOffer => {
  const offer = getErpOffer();
  if (offer === undefined)
    throw new Error("ONTOS_STOREFRONT_ERP_OFFERS has no offer for this storefront's company");
  return offer;
};

/** One page of imported (DRAFT or ACTIVE) products, in Catalog's order (by name in the market language). */
export const readErpCataloguePage = cache(
  async (offset: number, limit: number): Promise<{ count: number; products: ErpProduct[] }> => {
    const offer = requireOffer();
    const { locale } = await getActiveMarket();
    const page = await readCatalogPage(locale, offset, limit);
    return { count: page.count, products: await withOffers(offer, page) };
  },
);

/** One imported (DRAFT or ACTIVE) product, or undefined when Catalog lists none with this id. */
export const readErpProduct = cache(async (productId: string): Promise<ErpProduct | undefined> => {
  const offer = requireOffer();
  const { locale } = await getActiveMarket();
  for (let index = 0; index < DETAIL_PAGES; index += 1) {
    const page = await readCatalogPage(locale, index * DETAIL_PAGE, DETAIL_PAGE);
    const item = page.items.find(({ productRef }) => productRef.resourceId === productId);
    if (item !== undefined) return (await withOffers(offer, { count: 1, items: [item] }))[0];
    if ((index + 1) * DETAIL_PAGE >= page.count) return undefined;
  }
  return undefined;
});
