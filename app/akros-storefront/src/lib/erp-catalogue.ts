// Page model of the ERP-imported products: Catalog's product page, Inventory's on-hand page and Pricing's catalogue
// page prices, read as they answer. A Price of the signed-in customer's own Price Group carries the quiet „Vaše cena“;
// every other found Price is the no-group Price. A variant whose customer Price Pricing could not decide shows the guest
// Price of the same page, without „Vaše cena“. Nothing is invented: a variant without a found Price is „Cena na
// dotaz“, a figure that is not an exact ON_HAND total is „Dostupnost ověřujeme“, a variant without SKU has an empty
// SKU, and the image is the shop's no-image placeholder. Imported Products stay DRAFT with WORK_IN_PROGRESS Variants, so
// every Variant that is not RETIRED is shown.
import { Predicate } from "effect";
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
    readonly media: readonly unknown[];
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
export type ErpStock =
  | { readonly kind: "in-stock"; readonly quantity: string }
  | { readonly kind: "out-of-stock" }
  | { readonly kind: "unknown" };

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
  inStock: (quantity: string, locale: string) =>
    `Skladem: ${Number(quantity).toLocaleString(locale, { maximumFractionDigits: 3 })} ks`,
  outOfStock: "Není skladem",
  stockUnknown: "Dostupnost ověřujeme",
  inStockShort: "Skladem",
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

const optionText = (value: AttributeValue): string | undefined =>
  value.kind === "TEXT"
    ? value.text
    : value.kind === "MEASUREMENT"
      ? `${value.amount} ${value.unit}`
      : undefined;

const nameOf = (localized: Localized): string | undefined =>
  localized.kind === "PRESENT" ? localized.name : undefined;

/** A Variant the pages show: WORK_IN_PROGRESS (every import's) or ACTIVE, never RETIRED. */
const shown = (variant: { readonly lifecycle: string }) => variant.lifecycle !== "RETIRED";

/** Variant refs of every shown variant of the page, in page order: the stock and price reads ask for exactly these. */
export const shownVariantRefs = (page: CatalogProductPage): OwnerRef[] =>
  page.items.flatMap((item) => item.variants.filter(shown).map(({ variantRef }) => variantRef));

export const toErpStock = (item: CatalogVariantOnHand | undefined): ErpStock => {
  if (item?.outcome !== "ON_HAND") return { kind: "unknown" };
  return Number(item.total.amount) > 0
    ? { kind: "in-stock", quantity: item.total.amount }
    : { kind: "out-of-stock" };
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
        // The Catalog media assignments name Core Media assets no admitted storefront read serves yet.
        imageSrc: imagePlaceholder,
        imageAlt: erpCopy.noImage(name),
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

export const erpStockLabel = (stock: ErpStock, locale: string): string =>
  stock.kind === "in-stock"
    ? erpCopy.inStock(stock.quantity, locale)
    : stock.kind === "out-of-stock"
      ? erpCopy.outOfStock
      : erpCopy.stockUnknown;

/** The ui-kit stock tones; an unconfirmed figure uses the cautionary one, as the shop's „nelze ověřit“. */
export const erpStockTone = (stock: ErpStock): "in-stock" | "limited-stock" | "out-of-stock" =>
  stock.kind === "in-stock"
    ? "in-stock"
    : stock.kind === "out-of-stock"
      ? "out-of-stock"
      : "limited-stock";

/** The ui-kit AvailabilityStatus of a variant; an unconfirmed figure is „unknown“, as the shop's „nelze ověřit“. */
export const erpAvailabilityStatus = (stock: ErpStock): "available" | "unavailable" | "unknown" =>
  stock.kind === "in-stock"
    ? "available"
    : stock.kind === "out-of-stock"
      ? "unavailable"
      : "unknown";

/** Whether a price is the signed-in customer's own (shown with the quiet `erpCopy.yourPrice`). */
export const isYourPrice = (price: ErpPrice | undefined): boolean =>
  price?.kind === "price" && price.yours;

/**
 * One card: a single variant shows its own price and stock; several show the lowest found price „od“. `yourPrice`
 * says whether the shown price is the signed-in customer's own Price Group's.
 */
export function erpCardSummary(product: ErpProduct, locale: string) {
  const [only] = product.variants;
  if (product.variants.length === 1 && only !== undefined)
    return {
      priceLabel: erpPriceLabel(only.price, locale),
      stockLabel: erpStockLabel(only.stock, locale),
      stockTone: erpStockTone(only.stock),
      yourPrice: isYourPrice(only.price),
    };
  const priced = product.variants.flatMap((variant) =>
    variant.price.kind === "price" ? [variant.price] : [],
  );
  const lowest = priced.toSorted((left, right) => Number(left.amount) - Number(right.amount))[0];
  const stock: ErpStock = product.variants.some((variant) => variant.stock.kind === "in-stock")
    ? { kind: "in-stock", quantity: "0" }
    : product.variants.every((variant) => variant.stock.kind === "out-of-stock")
      ? { kind: "out-of-stock" }
      : { kind: "unknown" };
  return {
    priceLabel:
      lowest === undefined
        ? erpCopy.priceOnRequest
        : `${erpCopy.from} ${erpPriceLabel(lowest, locale)}`,
    stockLabel: stock.kind === "in-stock" ? erpCopy.inStockShort : erpStockLabel(stock, locale),
    stockTone: erpStockTone(stock),
    yourPrice: isYourPrice(lowest),
  };
}
