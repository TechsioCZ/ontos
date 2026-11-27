import "server-only";
// The signed-in customer's own Price Group prices of the products imported or linked through the ERP connector Symmy
// (a product or variant carrying `catalogVariantId`). Merchandise holds only the no-group price every shopper sees;
// the customer's group price is in Pricing, which names a customer only for Commerce's portal. So the price is read
// per request through the portal route `/catalog-page-prices` with the visitor's own portal session (the same governed
// read the ERP section used), and laid over a copy of the shared catalogue answer, never into it. A guest (no portal
// session) makes no call. The prices are those of the Price key Symmy imports under (`ONTOS_STOREFRONT_ERP_OFFERS` of
// this storefront's company); a company without an entry has no group prices.
import { isOperationError, type Operation } from "@ontos/storefront-runtime";
import { portalCookie, portalRequest, readAccount, requestPortal } from "./account";
import type { ProductPage } from "./catalog-projection";
import type {
  CatalogCustomerPrice,
  CatalogProduct,
  CatalogProductVariant,
  CatalogSearchVariantOffer,
} from "./catalog-types";
import { getConfig } from "./config";

/** What a storefront order line sends merchandise for a unit priced at the customer's group price. */
export interface CustomerGroupPriceClaim {
  readonly catalogVariantId: string;
  readonly netMinor: number;
  readonly priceGroupId: string;
}

/** The Price key scope of this company's ERP prices: Channel, Commerce Market, currency and Unit basis. */
interface PriceScope {
  readonly channelId: "B2C" | "B2B";
  readonly marketId: string;
  readonly currencyCode: string;
  readonly unitId: string;
  readonly unitQuantity: string;
}

const VARIABLE = "ONTOS_STOREFRONT_ERP_OFFERS";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
/** Pricing answers at most 100 variants per page. */
const PAGE = 100;

const scopes = new Map<string, PriceScope | undefined>();
/** This company's entry of the JSON object keyed by Legal Entity id; a malformed entry fails loudly. */
const priceScope = (): PriceScope | undefined => {
  const raw = process.env[VARIABLE]?.trim() ?? "";
  if (scopes.has(raw)) return scopes.get(raw);
  const entry =
    raw === ""
      ? undefined
      : Object.entries(JSON.parse(raw) as Record<string, unknown>).find(
          ([key]) => key.toLowerCase() === getConfig().legalEntityId.toLowerCase(),
        )?.[1];
  let scope: PriceScope | undefined;
  if (entry !== undefined) {
    const value = (entry ?? {}) as Record<string, unknown>;
    const { channelId, marketId, currencyCode, unitId, unitQuantity } = value;
    if (
      (channelId !== "B2C" && channelId !== "B2B") ||
      typeof marketId !== "string" ||
      !marketId ||
      typeof currencyCode !== "string" ||
      !/^[A-Z]{3}$/u.test(currencyCode) ||
      typeof unitId !== "string" ||
      !UUID.test(unitId) ||
      typeof unitQuantity !== "string" ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(unitQuantity)
    )
      throw new Error(`${VARIABLE} of this company needs channelId, marketId, currencyCode, unitId and unitQuantity`);
    scope = { channelId, marketId, currencyCode, unitId, unitQuantity };
  }
  scopes.set(raw, scope);
  return scope;
};

/** Decimal text of a PRE_TAX amount in the currency's major unit (`4.69`) to minor units (469), as the Symmy copy reads it. */
const minorOf = (amount: unknown): number | undefined => {
  const match = typeof amount === "string" ? /^(\d+)(?:\.(\d+))?$/u.exec(amount.trim()) : null;
  if (match === null) return undefined;
  const minor = Math.round(Number(`${match[1] ?? "0"}.${match[2] ?? "0"}`) * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : undefined;
};

/** Gross per unit, rounded half-up per unit: merchandise's `grossUnitPriceMinor`, the price its checkout charges. */
const grossOf = (netMinor: number, vatRate: number) =>
  netMinor + Math.floor((netMinor * vatRate + 50) / 100);

// Every customer of this storefront belongs to its one Tenant: learned from the first admitted account.
let storefrontTenant: string | undefined;

/** One item of Pricing's `CATALOG_PAGE_PRICED` answer (only the fields read here). */
interface PagePrice {
  readonly _tag?: string;
  readonly reason?: unknown;
  readonly catalogSelection?: { readonly variantRef?: { readonly resourceId?: unknown } };
  readonly priceGroupSelector?: {
    readonly kind?: string;
    readonly priceGroupRef?: { readonly resourceId?: unknown };
  };
  readonly priceRevision?: {
    readonly monetaryAmount?: { readonly amount?: unknown; readonly currencyCode?: unknown };
  };
}

interface CatalogRefs {
  readonly catalogProductId: string;
  readonly catalogVariantId: string;
}

/** The Symmy-linked units of a page: a product without variants by its own ids, a variant under its product's. */
const refsOf = (products: readonly CatalogProduct[]): CatalogRefs[] => {
  const refs = new Map<string, CatalogRefs>();
  for (const product of products) {
    const catalogProductId = product.catalogProductId;
    if (catalogProductId === undefined) continue;
    if (product.variantSummary.count === 0 && product.detail.variants.length === 0) {
      if (product.catalogVariantId !== undefined)
        refs.set(product.catalogVariantId, {
          catalogProductId,
          catalogVariantId: product.catalogVariantId,
        });
      continue;
    }
    for (const variant of product.detail.variants)
      if (variant.catalogVariantId !== undefined)
        refs.set(variant.catalogVariantId, {
          catalogProductId,
          catalogVariantId: variant.catalogVariantId,
        });
  }
  return [...refs.values()];
};

/**
 * The customer's group price of each unit, by Catalog Variant id: only Prices Pricing found in the customer's own Price
 * Group. A unit priced from the no-group Price, a guest and a session the portal does not admit get none (the shared
 * price stays). `charged` (cart quote and order): a read that fails or that Pricing could not decide fails the call,
 * so a customer is never charged a guest price in place of their own; otherwise the shared price is shown.
 */
const readGroupPrices = async (
  refs: readonly CatalogRefs[],
  scope: PriceScope,
  operation: Operation,
  charged: boolean,
): Promise<Map<string, CustomerGroupPriceClaim>> => {
  const found = new Map<string, CustomerGroupPriceClaim>();
  // The visitor's own request (its headers make the render dynamic: a personal price is never prerendered).
  const portal = await requestPortal();
  if (portalCookie(portal.cookie) === "") return found;
  const fail = (reason: string) => {
    if (charged) throw new Error(`Customer group prices unavailable: ${reason}`);
    console.error(`[ontos] customer group prices: ${reason}; shown at the shared price`);
  };
  try {
    const tenantId =
      storefrontTenant ??
      (await readAccount(portal.origin, portal.cookie, { operation }))?.tenantId;
    if (tenantId === undefined) return found;
    storefrontTenant = tenantId;
    for (let index = 0; index < refs.length; index += PAGE) {
      operation.check();
      const page = {
        channelId: scope.channelId,
        currencyCode: scope.currencyCode,
        marketId: scope.marketId,
        items: refs.slice(index, index + PAGE).map((ref) => ({
          catalogSelection: {
            productRef: {
              moduleId: "commerce.catalog",
              resourceType: "commerce.catalog.product",
              resourceId: ref.catalogProductId,
              tenantId,
            },
            variantRef: {
              moduleId: "commerce.catalog",
              resourceType: "commerce.catalog.variant",
              resourceId: ref.catalogVariantId,
              tenantId,
            },
          },
          unitBasis: {
            quantity: scope.unitQuantity,
            unitRef: {
              moduleId: "commerce.catalog",
              resourceType: "commerce.catalog.product-unit",
              resourceId: scope.unitId,
              tenantId,
            },
          },
        })),
      };
      const response = await portalRequest(
        "/catalog-page-prices",
        portal.origin,
        portal.cookie,
        page,
        undefined,
        { operation },
      );
      // The portal no longer admits the session: the visitor is a guest.
      if (response.status === 401 || response.status === 403) return new Map();
      if (!response.ok) {
        fail(`HTTP ${response.status} ${/"code":"([\w.-]+)"/u.exec(await response.text())?.[1] ?? ""}`);
        return found;
      }
      const body = (await response.json()) as { _tag?: unknown; prices?: unknown };
      if (body._tag !== "CATALOG_PAGE_PRICED" || !Array.isArray(body.prices)) {
        fail(String(body._tag));
        return found;
      }
      for (const price of body.prices as (PagePrice | null)[]) {
        if (price?._tag === "PRICING_INDETERMINATE") {
          fail(`${String(price.reason)} for ${String(price.catalogSelection?.variantRef?.resourceId)}`);
          continue;
        }
        if (price?._tag !== "PRICE_FOUND" || price.priceGroupSelector?.kind !== "PRICE_GROUP") continue;
        const catalogVariantId = price.catalogSelection?.variantRef?.resourceId;
        const priceGroupId = price.priceGroupSelector.priceGroupRef?.resourceId;
        const netMinor = minorOf(price.priceRevision?.monetaryAmount?.amount);
        if (
          typeof catalogVariantId !== "string" ||
          typeof priceGroupId !== "string" ||
          netMinor === undefined ||
          price.priceRevision?.monetaryAmount?.currencyCode !== scope.currencyCode
        )
          continue;
        found.set(catalogVariantId, { catalogVariantId, netMinor, priceGroupId });
      }
    }
    return found;
  } catch (error) {
    operation.check();
    if (isOperationError(error) || charged) throw error;
    console.error(`[ontos] customer group prices failed (${String(error)}); shown at the shared price`);
    return new Map();
  }
};

const customerPriceOf = (
  claim: CustomerGroupPriceClaim,
  basePriceMinor: number,
  baseTiers: readonly { priceMinor: number; priceExcludingVatMinor: number }[],
): CatalogCustomerPrice => {
  const baseNet = baseTiers.find((tier) => tier.priceMinor === basePriceMinor)?.priceExcludingVatMinor;
  return {
    ...claim,
    basePriceMinor,
    ...(baseNet === undefined ? {} : { basePriceExcludingVatMinor: baseNet }),
  };
};

/** The product (or its variants) at the customer's group prices; units without one are returned as they are. */
const personalized = (
  product: CatalogProduct,
  prices: ReadonlyMap<string, CustomerGroupPriceClaim>,
): CatalogProduct => {
  if (product.catalogProductId === undefined) return product;
  if (product.variantSummary.count === 0 && product.detail.variants.length === 0) {
    const claim =
      product.catalogVariantId === undefined ? undefined : prices.get(product.catalogVariantId);
    if (
      claim === undefined ||
      product.vatRate === undefined ||
      product.priceUnavailableReason ||
      product.priceMinor <= 0
    )
      return product;
    const gross = grossOf(claim.netMinor, product.vatRate);
    const { originalPriceMinor: _original, ...rest } = product;
    void _original;
    return {
      ...rest,
      priceMinor: gross,
      customerPrice: customerPriceOf(claim, product.priceMinor, product.detail.priceTiers),
      detail: {
        ...product.detail,
        priceTiers: [
          {
            minimumQuantity: product.minimumQuantity,
            priceMinor: gross,
            priceExcludingVatMinor: claim.netMinor,
          },
        ],
      },
    };
  }
  let changed = false;
  const variants = product.detail.variants.map((variant) => {
    const claim =
      variant.catalogVariantId === undefined ? undefined : prices.get(variant.catalogVariantId);
    const vatRate = variant.vatRate ?? product.vatRate;
    if (
      claim === undefined ||
      vatRate === undefined ||
      variant.priceUnavailableReason ||
      variant.priceMinor <= 0
    )
      return variant;
    changed = true;
    const gross = grossOf(claim.netMinor, vatRate);
    const { originalPriceMinor: _original, ...rest } = variant;
    void _original;
    return {
      ...rest,
      priceMinor: gross,
      customerPrice: customerPriceOf(claim, variant.priceMinor, variant.priceTiers),
      priceTiers: [
        {
          minimumQuantity: variant.minimumQuantity,
          priceMinor: gross,
          priceExcludingVatMinor: claim.netMinor,
        },
      ],
    };
  });
  if (!changed) return product;
  // The group's own price, its card and the variant its search hit stands for are the customer's prices too: the
  // cheapest priced variant after repricing, and the matched offer repriced by its exact variant.
  const cheapest = variants
    .filter((variant) => !variant.priceUnavailableReason && variant.priceMinor > 0)
    .reduce<CatalogProductVariant | undefined>(
      (best, variant) => (best === undefined || variant.priceMinor < best.priceMinor ? variant : best),
      undefined,
    );
  const repriced = (offer: CatalogSearchVariantOffer): CatalogSearchVariantOffer => {
    const variant = variants.find((entry) => entry.id === offer.id);
    if (variant?.customerPrice === undefined) return offer;
    const { originalPriceMinor: _original, ...rest } = offer;
    void _original;
    return { ...rest, priceMinor: variant.priceMinor, priceExcludingVatMinor: variant.customerPrice.netMinor };
  };
  const match = product.searchMatch;
  const searchMatch =
    match?.kind === "single"
      ? { ...match, variant: repriced(match.variant) }
      : match?.kind !== "multiple" && match?.onlyVariant !== undefined
        ? { ...match, onlyVariant: repriced(match.onlyVariant) }
        : match;
  // „Vaše cena“ of a card is the price of the one variant it stands for; a group card shows the price per variant.
  const shown =
    match?.kind === "single"
      ? variants.find((variant) => variant.id === match.variant.id)
      : variants.length === 1
        ? variants[0]
        : undefined;
  const { originalPriceMinor: _original, customerPrice: _customer, searchMatch: _match, ...rest } = product;
  void _original;
  void _customer;
  void _match;
  return {
    ...rest,
    ...(cheapest === undefined
      ? {}
      : {
          priceMinor: cheapest.priceMinor,
          variantSummary: { ...product.variantSummary, minGrossPriceMinor: cheapest.priceMinor },
        }),
    ...(shown?.customerPrice === undefined ? {} : { customerPrice: shown.customerPrice }),
    ...(searchMatch === undefined ? {} : { searchMatch }),
    detail: {
      ...product.detail,
      variants,
      priceTiers: cheapest?.priceTiers ?? product.detail.priceTiers,
    },
  };
};

/**
 * Listing cards carry no variant records, so a Symmy-linked group's variants (and their Catalog variants) are read
 * in full for a signed-in visitor before Pricing is asked: the shared answer (`shared`: no customer prices, never
 * personalised itself). A guest reads nothing more; a failed read leaves the cards at the shared price.
 */
const withVariantRecords = async (
  products: readonly CatalogProduct[],
  operation: Operation,
): Promise<readonly CatalogProduct[]> => {
  const groups = products.filter(
    (product) =>
      product.catalogProductId !== undefined &&
      product.variantSummary.count > 0 &&
      product.detail.variants.length === 0,
  );
  if (groups.length === 0) return products;
  if (portalCookie((await requestPortal()).cookie) === "") return products;
  try {
    // catalog-server lays these prices over its reads: imported here, when a page needs it.
    const { readProducts } = await import("./catalog-server");
    const full = await readProducts(
      { productIds: groups.map((product) => product.id), pageSize: groups.length },
      "full",
      false,
      { operation, shared: true },
    );
    const details = new Map(full.products.map((product) => [product.id, product.detail]));
    return products.map((product) => {
      const detail = groups.includes(product) ? details.get(product.id) : undefined;
      return detail === undefined
        ? product
        : { ...product, detail: { ...product.detail, variants: detail.variants, priceTiers: detail.priceTiers } };
    });
  } catch (error) {
    operation.check();
    if (isOperationError(error)) throw error;
    console.error(`[ontos] customer group prices: variants unread (${String(error)}); shown at the shared price`);
    return products;
  }
};

/**
 * The page with the signed-in customer's own group prices on its Symmy-linked units (a new page; the shared answer is
 * never changed). Only a page in the currency of the company's ERP prices is repriced.
 */
export const withCustomerPrices = async (
  page: ProductPage,
  operation: Operation,
  charged = false,
): Promise<ProductPage> => {
  if (!page.products.some((product) => product.catalogProductId !== undefined)) return page;
  const scope = priceScope();
  if (scope === undefined || (page.market?.currency ?? "CZK") !== scope.currencyCode) return page;
  const products = await withVariantRecords(page.products, operation);
  const refs = refsOf(products);
  if (refs.length === 0) return page;
  const prices = await readGroupPrices(refs, scope, operation, charged);
  if (prices.size === 0) return page;
  // A card without a price of its own stays the shared card, without the variants read for it.
  return {
    ...page,
    products: products.map((product, index) => {
      const priced = personalized(product, prices);
      return priced === product ? (page.products[index] ?? product) : priced;
    }),
  };
};

/** The group price claim of one cart line, from a page read with `withCustomerPrices` (charged). */
export const groupPriceClaimOf = (
  page: ProductPage,
  line: { productId: string; variantId?: string },
): CustomerGroupPriceClaim | undefined => {
  const product = page.products.find((candidate) => candidate.id === line.productId);
  const unit = line.variantId
    ? product?.detail.variants.find((variant) => variant.id === line.variantId)
    : product;
  const price = unit?.customerPrice;
  return price === undefined
    ? undefined
    : {
        catalogVariantId: price.catalogVariantId,
        netMinor: price.netMinor,
        priceGroupId: price.priceGroupId,
      };
};
