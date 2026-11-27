// Page model of the ERP-imported products: Catalog's product page, Inventory's on-hand page and Pricing's catalogue
// page prices, read as they answer. A Price of the signed-in customer's own Price Group carries the quiet „Vaše cena“;
// every other found Price is the no-group Price. A variant whose customer Price Pricing could not decide shows the guest
// Price of the same page, without „Vaše cena“. Nothing is invented: a variant without a found Price is „Cena na
// dotaz“, its stock is read by the shop's one stock rule (`lib/product-stock`, a figure that is not an exact ON_HAND
// total is „Dostupnost nelze ověřit“), a variant without SKU has an empty SKU, and the image is the shop's no-image
// placeholder. Imported Products stay DRAFT with WORK_IN_PROGRESS Variants, so every Variant that is not RETIRED is
// shown.
import { Predicate } from "effect";
import type { Dictionary } from "@/i18n";
import { getProductStockStatus, productStockTone, stockStatusLabel } from "@/lib/product-stock";
import { imagePlaceholder } from "@/ontos/media-path";

/** An owner resource reference (`{moduleId, resourceType, resourceId, tenantId}`). */
export interface OwnerRef {
  readonly moduleId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly tenantId: string;
}

type Localized =
  | {
      readonly kind: "PRESENT";
      readonly locale: string;
      readonly name: string;
      readonly description?: string;
    }
  | { readonly kind: "MISSING_TRANSLATION"; readonly requestedLocale: string };

type AttributeValue =
  | { readonly kind: "TEXT"; readonly text: string }
  | { readonly kind: "MEASUREMENT"; readonly amount: number; readonly unit: string }
  | { readonly kind: "CONTROLLED" | "SPECIAL" };

/** `commerce.catalog.api.product-page` (only the fields this page shows). */
export interface CatalogProductPage {
  readonly count: number;
  readonly items: readonly {
    readonly productRef: OwnerRef;
    readonly lifecycle: string;
    readonly localized: Localized;
    readonly categories: readonly { readonly name?: unknown }[];
    /** Current Catalog media assignments, main first; a `core.media` resource is an uploaded image. */
    readonly media: readonly {
      readonly assignment?: { readonly resourceRef?: Partial<OwnerRef> };
      readonly ownerAvailability?: string;
    }[];
    readonly variants: readonly {
      readonly variantRef: OwnerRef;
      readonly lifecycle: string;
      readonly sku?: string;
      readonly localized: Localized;
      readonly options: readonly { readonly values: readonly AttributeValue[] }[];
    }[];
  }[];
}

/** `commerce.inventory.api.catalog-variant-on-hand-page` item. */
export type CatalogVariantOnHand =
  | {
      readonly outcome:
        | "NO_STOCK_ITEM"
        | "CONFLICTING_BINDINGS"
        | "NO_POSITION"
        | "ON_HAND_UNKNOWN";
      readonly variantRef: OwnerRef;
    }
  | {
      readonly outcome: "ON_HAND";
      readonly variantRef: OwnerRef;
      readonly total: { readonly amount: string };
    };

/** `commerce.pricing.api.catalog-page-prices` response. */
export type CatalogPagePrices =
  | {
      readonly _tag: "CATALOG_PAGE_PRICED";
      readonly prices: readonly (
        | {
            readonly _tag: "PRICE_FOUND";
            readonly catalogSelection: { readonly variantRef: OwnerRef };
            /** `PRICE_GROUP` when the signed-in customer's own Price Group priced the variant. */
            readonly priceGroupSelector: { readonly kind: string };
            readonly priceRevision: {
              readonly monetaryAmount: { readonly amount: string; readonly currencyCode: string };
            };
          }
        | { readonly _tag: string; readonly catalogSelection: { readonly variantRef: OwnerRef } }
      )[];
    }
  | { readonly _tag: "CURRENCY_SUPPORT_NOT_CURRENT" };

export type ErpPrice =
  | {
      readonly kind: "price";
      readonly amount: string;
      readonly currencyCode: string;
      /** The signed-in customer's own Price Group priced it (`erpCopy.yourPrice`). */
      readonly yours: boolean;
    }
  | { readonly kind: "on-request" };
/** One ERP variant's stock as the shop's one stock rule reads it (`lib/product-stock`), in its unit. */
export type ErpStock = Parameters<typeof getProductStockStatus>[0] & { readonly unit: string };

export interface ErpVariant {
  readonly id: string;
  readonly name: string;
  readonly sku?: string;
  readonly options: readonly string[];
  readonly price: ErpPrice;
  readonly stock: ErpStock;
}

export interface ErpProduct {
  readonly id: string;
  readonly name: string;
  readonly descriptionParagraphs: readonly string[];
  readonly categories: readonly string[];
  readonly imageSrc: string;
  readonly imageAlt: string;
  readonly variants: readonly ErpVariant[];
}

export const erpCopy = {
  title: "Novinky z ERP",
  intro:
    "Produkty, které do e-shopu právě poslal náš podnikový systém, s jeho cenou a skladovou zásobou.",
  empty: "Z podnikového systému zatím nepřišly žádné produkty.",
  showAll: "Zobrazit vše",
  orderNote: "Objednání této položky připravujeme.",
  priceOnRequest: "Cena na dotaz",
  yourPrice: "Vaše cena",
  excludingVat: "bez DPH",
  from: "od",
  variants: "Varianty",
  variantCount: "Počet variant",
  variant: "Varianta",
  sku: "Kód varianty",
  options: "Parametry",
  price: "Cena bez DPH",
  availability: "Dostupnost",
  description: "Popis",
  descriptionUnavailable: "Popis zatím není k dispozici.",
  categories: "Kategorie",
  untranslatedName: "Název zatím není přeložen",
  noImage: (name: string) => `${name} – obrázek zatím není k dispozici`,
} as const;

const keyOf = (ref: OwnerRef) => ref.resourceId;

function optionText(value: AttributeValue): string | undefined {
  return value.kind === "TEXT"
    ? value.text
    : value.kind === "MEASUREMENT"
      ? `${value.amount} ${value.unit}`
      : undefined;
}

function nameOf(localized: Localized): string | undefined {
  return localized.kind === "PRESENT" ? localized.name : undefined;
}

/** A Variant the pages show: WORK_IN_PROGRESS (every import's) or ACTIVE, never RETIRED. */
const shown = (variant: { readonly lifecycle: string }) => variant.lifecycle !== "RETIRED";

/**
 * The storefront rule of an ERP product: it is ACTIVE (a DRAFT „Koncept“ is never sold; the storefront's page read
 * asks Catalog for ACTIVE only) and it has a Variant that is not RETIRED. Such a product is on „Novinky z ERP“, has its own page and is
 * found by the header search and the search results page. A missing price shows „Cena na dotaz“, it does not hide it.
 */
export const isErpProductShown = (item: {
  readonly lifecycle: string;
  readonly variants: readonly { readonly lifecycle: string }[];
}): boolean => item.lifecycle === "ACTIVE" && item.variants.some(shown);

const foldSearch = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("cs-CZ");

/** Whether every word of the query occurs in the product's name, a Variant's name, SKU or option values. */
export const erpItemMatches = (
  item: CatalogProductPage["items"][number],
  query: string,
): boolean => {
  const words = foldSearch(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return false;
  const text = foldSearch(
    [
      nameOf(item.localized) ?? "",
      ...item.variants.flatMap((variant) => [
        nameOf(variant.localized) ?? "",
        variant.sku ?? "",
        ...variant.options.flatMap(({ values }) =>
          values.flatMap((value) => optionText(value) ?? []),
        ),
      ]),
    ].join(" "),
  );
  return words.every((word) => text.includes(word));
};

/** Variant refs of every shown variant of the page, in page order: the stock and price reads ask for exactly these. */
export const shownVariantRefs = (page: CatalogProductPage): OwnerRef[] =>
  page.items.flatMap((item) => item.variants.filter(shown).map(({ variantRef }) => variantRef));

/** Inventory counts an ERP variant in pieces. */
const ERP_UNIT = "ks";
/**
 * Catalog states no minimum or package for an ERP variant, so its first order is the owner order rules' default of one
 * piece (Merchandise `firstOrderableQuantity`: minimum 1 without a package). A constant here: this module reaches the
 * browser, which cannot load the owner's TypeScript source.
 */
const ERP_FIRST_ORDER = 1;

/**
 * Inventory's ON_HAND total by the shop's one stock rule: a unit is in stock only when the total covers its first
 * order (`ERP_FIRST_ORDER`); less is held, not sold („Skladem 0,5 ks, prodej po 1 ks“). Any other outcome is unknown.
 */
export const toErpStock = (item: CatalogVariantOnHand | undefined): ErpStock => {
  if (item?.outcome !== "ON_HAND")
    return { availabilityUnknown: true, stockCount: 0, unit: ERP_UNIT };
  const onHand = Number(item.total.amount);
  if (onHand >= ERP_FIRST_ORDER) return { stockCount: onHand, unit: ERP_UNIT };
  return onHand > 0
    ? {
        belowPackage: { stockOnHand: onHand, firstOrderableQuantity: ERP_FIRST_ORDER },
        stockCount: 0,
        unit: ERP_UNIT,
      }
    : { stockCount: 0, unit: ERP_UNIT };
};

type PagePrice = Extract<
  CatalogPagePrices,
  { readonly _tag: "CATALOG_PAGE_PRICED" }
>["prices"][number];

/** Pricing could not decide this item for the customer (an owner state it could not read or prove): not „no price“. */
const undecided = (price: PagePrice): boolean => Predicate.isTagged(price, "PRICING_INDETERMINATE");

/** Whether the signed-in customer's page has an item Pricing could not decide, so the page is also read as a guest. */
export const hasUndecidedPrice = (prices: CatalogPagePrices): boolean =>
  Predicate.isTagged(prices, "CATALOG_PAGE_PRICED") && prices.prices.some(undecided);

/**
 * The signed-in customer's page with the guest Price of the same page wherever the customer's own Price could not be
 * decided, because such an item would otherwise read „Cena na dotaz“ where a guest sees a price. A guest Price is the
 * no-group Price, so it never carries „Vaše cena“. An explicit no-price answer stays „Cena na dotaz“, and so does an
 * item the guest page cannot price either.
 */
export const withGuestPricesWhereUndecided = (
  customer: CatalogPagePrices,
  guest: CatalogPagePrices,
): CatalogPagePrices => {
  if (
    !Predicate.isTagged(customer, "CATALOG_PAGE_PRICED") ||
    !Predicate.isTagged(guest, "CATALOG_PAGE_PRICED")
  )
    return customer;
  const guestFound = new Map(
    guest.prices.flatMap((price) =>
      Predicate.isTagged(price, "PRICE_FOUND") && "priceRevision" in price
        ? [[keyOf(price.catalogSelection.variantRef), price] as const]
        : [],
    ),
  );
  return {
    _tag: "CATALOG_PAGE_PRICED",
    prices: customer.prices.map((price) => {
      const fallback = undecided(price)
        ? guestFound.get(keyOf(price.catalogSelection.variantRef))
        : undefined;
      return fallback === undefined
        ? price
        : { ...fallback, priceGroupSelector: { kind: "NO_GROUP" } };
    }),
  };
};

const pricesByVariant = (prices: CatalogPagePrices | undefined): Map<string, ErpPrice> => {
  const found = new Map<string, ErpPrice>();
  if (!Predicate.isTagged(prices, "CATALOG_PAGE_PRICED")) return found;
  for (const price of prices.prices) {
    if (Predicate.isTagged(price, "PRICE_FOUND") && "priceRevision" in price) {
      const { amount, currencyCode } = price.priceRevision.monetaryAmount;
      found.set(keyOf(price.catalogSelection.variantRef), {
        kind: "price",
        amount,
        currencyCode,
        yours: price.priceGroupSelector.kind === "PRICE_GROUP",
      });
    }
  }
  return found;
};

const ASSET_ID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

/** The main uploaded image (served by /novinky-z-erp/obrazky through Catalog's image read), else the placeholder. */
const erpImageOf = (
  productRef: OwnerRef,
  media: CatalogProductPage["items"][number]["media"],
  name: string,
): { imageSrc: string; imageAlt: string } => {
  const asset = media
    .map(({ assignment }) => assignment?.resourceRef)
    .find((ref) => ref?.moduleId === "core.media" && ASSET_ID.test(ref.resourceId ?? ""));
  if (asset?.resourceId === undefined || !ASSET_ID.test(productRef.resourceId))
    return { imageSrc: imagePlaceholder, imageAlt: erpCopy.noImage(name) };
  return {
    imageSrc: `/novinky-z-erp/obrazky/${productRef.resourceId}/${asset.resourceId}?tenant=${encodeURIComponent(productRef.tenantId)}`,
    imageAlt: name,
  };
};

/** The products of one Catalog page with each shown variant's ERP price and stock. */
export function toErpProducts(
  page: CatalogProductPage,
  onHand: readonly CatalogVariantOnHand[],
  prices: CatalogPagePrices | undefined,
): ErpProduct[] {
  const stockById = new Map(onHand.map((item) => [keyOf(item.variantRef), item]));
  const priceById = pricesByVariant(prices);
  return page.items.flatMap((item) => {
    const variants = item.variants.filter(shown).map((variant): ErpVariant => {
      const id = keyOf(variant.variantRef);
      const options = variant.options.flatMap(({ values }) =>
        values.flatMap((value) => optionText(value) ?? []),
      );
      return {
        id,
        name:
          nameOf(variant.localized) ??
          (options.length > 0 ? options.join(", ") : (variant.sku ?? id)),
        ...(variant.sku === undefined ? {} : { sku: variant.sku }),
        options,
        price: priceById.get(id) ?? { kind: "on-request" },
        stock: toErpStock(stockById.get(id)),
      };
    });
    if (variants.length === 0) return [];
    // A DRAFT import often has no product text in the market language yet: its first Variant's name stands in.
    const [first] = item.variants.filter(shown);
    const name =
      nameOf(item.localized) ??
      (first === undefined ? undefined : nameOf(first.localized)) ??
      erpCopy.untranslatedName;
    const description = item.localized.kind === "PRESENT" ? (item.localized.description ?? "") : "";
    return [
      {
        id: keyOf(item.productRef),
        name,
        descriptionParagraphs: description
          .split(/\n\s*\n|\r?\n/u)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean),
        categories: item.categories.flatMap(({ name: category }) =>
          typeof category === "string" ? [category] : [],
        ),
        ...erpImageOf(item.productRef, item.media, name),
        variants,
      },
    ];
  });
}

/** Money as the rest of the shop shows it (`formatPrice`): the market locale, two fraction digits. */
export const formatErpAmount = (amount: string, currencyCode: string, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: 2,
  }).format(Number(amount));

export const erpPriceLabel = (price: ErpPrice, locale: string): string =>
  price.kind === "price"
    ? `${formatErpAmount(price.amount, price.currencyCode, locale)} ${erpCopy.excludingVat}`
    : erpCopy.priceOnRequest;

/** One ERP variant's stock line on its detail page, in the words of the shop's product page for one unit. */
export const erpStockLabel = (cs: Dictionary, stock: ErpStock): string => {
  const status = getProductStockStatus(stock);
  return status === "unknown"
    ? cs.product.availabilityNowUnknown
    : status === "in-stock"
      ? cs.product.inStockCount(stock.stockCount, stock.unit)
      : status === "below-package"
        ? stockStatusLabel(cs, status, stock.belowPackage, stock.unit)
        : cs.product.outOfStock;
};

/** The stock line of an ERP detail page, in the words of the shop's product page (one unit, or a variant group). */
export function erpDetailStockLabel(product: ErpProduct, cs: Dictionary): string {
  const [only] = product.variants;
  if (product.variants.length === 1 && only !== undefined) return erpStockLabel(cs, only.stock);
  const statuses = product.variants.map(({ stock }) => getProductStockStatus(stock));
  const available = statuses.filter((status) => status === "in-stock").length;
  return available > 0
    ? cs.product.variantsInStock(available, statuses.length)
    : statuses.includes("unknown")
      ? cs.product.variantsUnknown
      : statuses.includes("below-package")
        ? cs.product.stockStatus["below-package"]
        : cs.product.variantsOutOfStock;
}

/**
 * Several variants, as the shop words a variant group: in stock when one is, unknown when one cannot be verified,
 * else held below one first order or not in stock.
 */
const groupStock = (variants: readonly ErpVariant[]): ErpStock => {
  const stocks = variants.map(({ stock }) => stock);
  const total = (amount: (stock: ErpStock) => number) =>
    stocks.reduce((sum, stock) => sum + amount(stock), 0);
  if (stocks.some((stock) => getProductStockStatus(stock) === "in-stock"))
    return { stockCount: total(({ stockCount }) => stockCount), unit: ERP_UNIT };
  if (stocks.some(({ availabilityUnknown }) => availabilityUnknown))
    return { availabilityUnknown: true, stockCount: 0, unit: ERP_UNIT };
  const held = total(({ belowPackage }) => belowPackage?.stockOnHand ?? 0);
  return held > 0
    ? { belowPackage: { stockOnHand: held }, stockCount: 0, unit: ERP_UNIT }
    : { stockCount: 0, unit: ERP_UNIT };
};

/** The stock line of an ERP card or header suggestion, as a shop card words it: one variant's own, else the group's. */
export function erpStockSummary(product: ErpProduct, cs: Dictionary) {
  const [only] = product.variants;
  const stock =
    product.variants.length === 1 && only !== undefined ? only.stock : groupStock(product.variants);
  const status = getProductStockStatus(stock);
  return {
    stockLabel: stockStatusLabel(cs, status, stock.belowPackage, stock.unit),
    stockTone: productStockTone(status),
  };
}

/** Whether a price is the signed-in customer's own (shown with the quiet `erpCopy.yourPrice`). */
export const isYourPrice = (price: ErpPrice | undefined): boolean =>
  price?.kind === "price" && price.yours;

/**
 * One card: a single variant shows its own price and stock; several show the lowest found price „od“. `yourPrice`
 * says whether the shown price is the signed-in customer's own Price Group's.
 */
export function erpCardSummary(product: ErpProduct, cs: Dictionary, locale: string) {
  const [only] = product.variants;
  if (product.variants.length === 1 && only !== undefined)
    return {
      priceLabel: erpPriceLabel(only.price, locale),
      ...erpStockSummary(product, cs),
      yourPrice: isYourPrice(only.price),
    };
  const priced = product.variants.flatMap((variant) =>
    variant.price.kind === "price" ? [variant.price] : [],
  );
  const lowest = priced.toSorted((left, right) => Number(left.amount) - Number(right.amount))[0];
  return {
    priceLabel:
      lowest === undefined
        ? erpCopy.priceOnRequest
        : `${erpCopy.from} ${erpPriceLabel(lowest, locale)}`,
    ...erpStockSummary(product, cs),
    yourPrice: isYourPrice(lowest),
  };
}
