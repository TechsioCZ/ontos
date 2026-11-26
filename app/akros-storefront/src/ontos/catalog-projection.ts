import {
  CZK_MONEY,
  priceUnavailableCode,
  isStoreCurrency,
  type MoneyFormat,
  type StoreCurrency,
} from "@/lib/format";
import { imagePlaceholder, isImagePlaceholder, productMediaPath } from "./media-path";
import { purchaseConstraints } from "./purchase-constraints";
import { sourceUnitWeightKg } from "./variant-weights";
import { assertCategoryForest } from "@app/merchandise/domain/category-forest";
import type {
  CatalogVariantSummary,
  CatalogData,
  CategoryData,
  CatalogCategory,
  CatalogParameter,
  CatalogPriceTier,
  CatalogProduct,
  CatalogProductVariant,
  CatalogPurchaseProduct,
  CatalogPurchaseVariant,
  CatalogSearchMatch,
  CatalogSearchVariantOffer,
} from "@/ontos/catalog-types";

/** The market a storefront catalog read was answered for. */
export interface CatalogMarket {
  marketId: string;
  marketCode: string;
  currency: StoreCurrency;
  /** false: the market has no offer yet, so the read carries no products. */
  configured: boolean;
}
const marketOf = (value: unknown): CatalogMarket | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Raw;
  if (typeof raw.marketId !== "string" || !isStoreCurrency(raw.currency)) return undefined;
  return {
    marketId: raw.marketId,
    marketCode: typeof raw.marketCode === "string" ? raw.marketCode : "",
    currency: raw.currency,
    configured: raw.configured !== false,
  };
};

/** A bounded client payload: do not serialize product.detail.variants through the product prop too. */
export const purchaseProductOf = (product: CatalogProduct): CatalogPurchaseProduct => ({
  vatRate: product.vatRate,
  id: product.id,
  slug: product.slug,
  name: product.name,
  sku: product.sku,
  imageSrc: product.imageSrc,
  imageAlt: product.imageAlt,
  unit: product.unit,
  minimumQuantity: product.minimumQuantity,
  packageQuantity: product.packageQuantity,
  quantityStep: product.quantityStep,
  stockCount: product.stockCount,
  priceMinor: product.priceMinor,
  availabilityUnknown: product.availabilityUnknown,
  priceUnavailableReason: product.priceUnavailableReason,
  netWeight: product.netWeight,
  detail: { priceTiers: product.detail.priceTiers },
});

export const purchaseVariantOf = ({
  sourceId: _sourceId,
  vatRate: _vatRate,
  isAction: _isAction,
  isRecommended: _isRecommended,
  isSale: _isSale,
  isNew: _isNew,
  ...purchase
}: CatalogProductVariant): CatalogPurchaseVariant => purchase;

type Raw = Record<string, unknown>;
const rows = (v: unknown): Raw[] =>
  Array.isArray(v) ? v.filter((x): x is Raw => Boolean(x) && typeof x === "object") : [];
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
/** Trimmed non-empty text, else undefined (blank owner fields fall through). */
const filled = (v: unknown): string | undefined => {
  const value = typeof v === "string" ? v.trim() : "";
  return value || undefined;
};
const documentsOf = (v: unknown): { label: string; url: string }[] =>
  rows(v).flatMap((d) => {
    const url = text(d.url).trim();
    if (!url.startsWith("https://") && !(url.startsWith("/") && !url.startsWith("//"))) return [];
    return [{ label: filled(d.label) ?? filled(d.name) ?? filled(d.title) ?? url, url }];
  });
const parameters = (v: unknown): CatalogParameter[] =>
  rows(v)
    .map((p) => ({ label: text(p.label), value: text(p.value), unit: text(p.unit) }))
    .filter((p) => p.label.trim() !== "");

const imageHosts = (): Set<string> =>
  new Set([
    "www.akros.cz",
    ...(process.env.STOREFRONT_IMAGE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  ]);
/** Only images next/image can serve: same-origin "/…" paths or https on a configured host. */
const safeImage = (v: unknown): string | undefined => {
  const src = text(v).trim();
  if (!src) return undefined;
  // Product data may still store the placeholder's original path; serve the brand-neutral one.
  if (isImagePlaceholder(src)) return imagePlaceholder;
  if (src.startsWith("/") && !src.startsWith("//")) return src;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || !imageHosts().has(url.hostname)) return undefined;
    if (url.hostname === "www.akros.cz" && !url.pathname.startsWith("/data/")) return undefined;
    return src;
  } catch {
    return undefined;
  }
};
const flags = (record: Raw) => {
  const nested = record.flags && typeof record.flags === "object" ? (record.flags as Raw) : {};
  const p: Raw = { ...record, ...nested };
  const labels = strings(p.labels);
  return {
    isAction: p.isAction === true || labels.includes("action"),
    isRecommended: p.isRecommended === true || labels.includes("recommended"),
    isSale: p.isSale === true || labels.includes("sale"),
    isNew: p.isNew === true || labels.includes("new"),
  };
};
/** `description` is the owner's authoritative text; paragraphs are only a fallback when it is empty. */
const paragraphsOf = (record: Raw): string[] => {
  const description = text(record.description).trim();
  if (description)
    return description
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  const detail = record.detail && typeof record.detail === "object" ? (record.detail as Raw) : {};
  return strings(record.descriptionParagraphs ?? detail.descriptionParagraphs)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
};

/**
 * Prices are sold only in the market currency (`storefrontCatalog.market.currency`, CZK without a market);
 * a product priced in anything else is shown as „cena není dostupná“. The reason is a language-neutral code
 * (`priceUnavailableCode`), worded at render time in the request's language (`priceUnavailableText`).
 */
const priceUnavailableReason = priceUnavailableCode;
/** Owner availability: UNKNOWN, untracked stock or a missing value is never shown as „skladem“. */
const isAvailabilityUnknown = (availability: unknown, stockTracked: unknown): boolean =>
  stockTracked === false || !["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(text(availability));
/** Sellable quantity from the owner ledger; OUT_OF_STOCK is 0 whatever the raw count says. */
const stockOf = (stockOnHand: unknown, availability: unknown): number =>
  text(availability) === "OUT_OF_STOCK" ? 0 : Math.max(0, number(stockOnHand) ?? 0);
const dedupeTiers = (tiers: CatalogPriceTier[]): CatalogPriceTier[] =>
  [...new Map(tiers.map((tier) => [tier.minimumQuantity, tier] as const)).values()].sort(
    (a, b) => a.minimumQuantity - b.minimumQuantity,
  );

/** A broken search contract must become an outage, never a guessed identity or market price. */
export class CatalogSearchMatchError extends Error {
  readonly code = "catalog_search_match_malformed";
  constructor() {
    super("OntOS search match evidence is missing or malformed");
    this.name = "CatalogSearchMatchError";
  }
}
const invalidSearchMatch = (): never => {
  throw new CatalogSearchMatchError();
};
const searchRecord = (value: unknown, keys: readonly string[]): Raw => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchMatch();
  const raw = value as Raw;
  if (Object.keys(raw).some((key) => !keys.includes(key))) return invalidSearchMatch();
  return raw;
};
const searchText = (value: unknown): string =>
  typeof value === "string" ? value : invalidSearchMatch();
const searchNumber = (value: unknown): number => number(value) ?? invalidSearchMatch();
const searchMinor = (value: unknown): number => {
  const minor = searchNumber(value);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : invalidSearchMatch();
};

/** Project only the approved singleton fields, with the same presentation rules as full variants. */
const searchOfferOf = (
  value: unknown,
  product: Raw,
  money: MoneyFormat,
): CatalogSearchVariantOffer => {
  const raw = searchRecord(value, [
    "id",
    "name",
    "sku",
    "currency",
    "grossPriceMinor",
    "priceMinor",
    "displayPriceExcludingVatMinor",
    "availability",
    "stockOnHand",
    "unit",
    "sourceUnit",
    "minimumQuantity",
    "packageQuantity",
    "imageSrc",
    "originalPriceMinor",
  ]);
  const id = searchText(raw.id);
  if (!id.trim() || !isStoreCurrency(raw.currency) || raw.currency !== money.currency)
    return invalidSearchMatch();
  const label = searchText(raw.name);
  const sku = searchText(raw.sku);
  const gross = searchMinor(raw.grossPriceMinor);
  const net = searchMinor(raw.priceMinor);
  const displayNet =
    raw.displayPriceExcludingVatMinor === undefined
      ? undefined
      : searchMinor(raw.displayPriceExcludingVatMinor);
  const availability = searchText(raw.availability);
  if (!["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "UNKNOWN"].includes(availability))
    return invalidSearchMatch();
  const stock = searchNumber(raw.stockOnHand);
  const minimum = raw.minimumQuantity === undefined ? 1 : searchNumber(raw.minimumQuantity);
  const rawPackage =
    raw.packageQuantity === undefined ? undefined : searchNumber(raw.packageQuantity);
  // The owner stores 0 for a cleared package: only a positive package is one.
  const packageQuantity = rawPackage !== undefined && rawPackage > 0 ? rawPackage : undefined;
  const ownerUnit = searchText(raw.unit);
  const unit = raw.sourceUnit === undefined ? ownerUnit : searchText(raw.sourceUnit);
  const image = raw.imageSrc === undefined ? undefined : searchText(raw.imageSrc);
  const original =
    raw.originalPriceMinor === undefined ? undefined : searchMinor(raw.originalPriceMinor);
  const priceIssue = priceUnavailableReason(gross, net, raw.currency, money);
  const availabilityUnknown = isAvailabilityUnknown(availability, product.stockTracked);
  return {
    id,
    sku,
    label,
    currency: raw.currency,
    unit,
    priceMinor: priceIssue ? 0 : gross,
    ...(!priceIssue && displayNet !== undefined ? { priceExcludingVatMinor: displayNet } : {}),
    ...(!priceIssue && original !== undefined && original > gross
      ? { originalPriceMinor: original }
      : {}),
    ...(priceIssue ? { priceUnavailableReason: priceIssue } : {}),
    stockCount: availabilityUnknown ? 0 : stockOf(stock, availability),
    ...(availabilityUnknown ? { availabilityUnknown: true } : {}),
    ...purchaseConstraints(minimum),
    packageQuantity,
    imageSrc: productMediaPath(text(product.id), image ?? "") ?? safeImage(image),
  };
};

const searchMatchOf = (
  value: unknown,
  product: Raw,
  money: MoneyFormat,
  count: number,
): CatalogSearchMatch => {
  const raw = searchRecord(value, ["kind", "variant", "count", "onlyVariant"]);
  if (!Number.isSafeInteger(count) || count < 0) return invalidSearchMatch();
  switch (raw.kind) {
    case "single":
      if (count < 1 || raw.count !== undefined || raw.onlyVariant !== undefined)
        return invalidSearchMatch();
      return { kind: "single", variant: searchOfferOf(raw.variant, product, money) };
    case "multiple": {
      const matching = searchNumber(raw.count);
      if (
        !Number.isSafeInteger(matching) ||
        matching < 2 ||
        matching > count ||
        raw.variant !== undefined ||
        raw.onlyVariant !== undefined
      )
        return invalidSearchMatch();
      return { kind: "multiple", count: matching };
    }
    case "product":
    case "unattributed":
      if (
        raw.variant !== undefined ||
        raw.count !== undefined ||
        (raw.onlyVariant !== undefined && count !== 1) ||
        (count === 1 && raw.onlyVariant === undefined)
      )
        return invalidSearchMatch();
      return {
        kind: raw.kind,
        ...(raw.onlyVariant === undefined
          ? {}
          : { onlyVariant: searchOfferOf(raw.onlyVariant, product, money) }),
      };
    default:
      return invalidSearchMatch();
  }
};

/** One owner product read (`includeCategories: false`): one page of products plus the catalog revision. */
export interface ProductPage {
  /** merchandise `storefrontCatalog.market` (absent only for reads without a market). */
  market?: CatalogMarket;
  revision: number;
  total: number;
  page: number;
  pageSize: number;
  products: CatalogProduct[];
  homepageFeaturedProductIds: string[];
}

/** Products and navigation merged for Kai's model (`createCatalog`). */
export interface CatalogSnapshot {
  catalog: CatalogData;
  categories: CategoryData;
}

const variantSummaryOf = (value: unknown): CatalogVariantSummary => {
  const raw = value && typeof value === "object" ? (value as Raw) : {};
  const minGross = number(raw.minGrossPriceMinor);
  return {
    count: Math.max(0, number(raw.count) ?? 0),
    minGrossPriceMinor: minGross ?? null,
    stockOnHand: Math.max(0, number(raw.stockOnHand) ?? 0),
    units: strings(raw.units),
  };
};

/**
 * Project ONLY owner product data. No prototype catalog/template lookup, including unknown/new identities.
 * Listing cards carry no variant records; every product carries the owner's `variantSummary`.
 */
export function projectProducts(body: Raw): ProductPage {
  const market = marketOf(body.market);
  const money: MoneyFormat = { currency: market?.currency ?? "CZK", locale: CZK_MONEY.locale };
  const products: CatalogProduct[] = [];
  for (const p of rows(body.products)) {
    if (p.active === false || p.published === false || !text(p.id) || !text(p.slug)) continue;
    const convert = (v: Raw): CatalogProductVariant | null => {
      const gross = number(v.grossPriceMinor);
      const net = number(v.priceMinor);
      // Same default as the owner order rules (merchandise order-quantity: minimumQuantity ?? 1).
      const minimum = number(v.minimumQuantity) ?? 1;
      if (!text(v.id)) return null;
      const priceIssue = priceUnavailableReason(gross, net, p.currency, money);
      const availabilityUnknown = isAvailabilityUnknown(v.availability, p.stockTracked);
      const tiers = priceIssue
        ? []
        : rows(v.priceTiers)
            .map((t) => ({
              minimumQuantity: number(t.minimumQuantity)!,
              priceMinor: number(t.priceMinor)!,
              priceExcludingVatMinor: number(t.priceExcludingVatMinor)!,
            }))
            .filter((t) => Object.values(t).every(Number.isFinite) && t.priceMinor > 0);
      const rawPackage = number(v.packageQuantity);
      const packageQuantity = rawPackage !== undefined && rawPackage > 0 ? rawPackage : undefined;
      const unit =
        filled(v.sourceUnit) ?? filled(v.unit) ?? filled(p.sourceUnit) ?? filled(p.unit) ?? "ks";
      const variantWeightGrams = number(v.weightGrams);
      const sourceNetWeight =
        variantWeightGrams !== undefined && variantWeightGrams > 0
          ? variantWeightGrams / 1000
          : sourceUnitWeightKg(text(v.sku), unit);
      const variantOriginal = number(v.originalPriceMinor);
      const variantDescription = text(v.description).trim() || undefined;
      return {
        id: text(v.id),
        sourceId: text(v.sourceId, text(v.id)),
        sku: text(v.sku),
        label: text(v.name, text(v.label, text(v.sku))),
        ...(variantDescription ? { description: variantDescription } : {}),
        unit,
        ...(sourceNetWeight === undefined ? {} : { sourceNetWeight }),
        vatRate: number(p.vatRate),
        // An unpriced variant is shown (with the reason) but can never be bought: price 0 disables buying.
        priceMinor: priceIssue ? 0 : gross!,
        ...(!priceIssue && variantOriginal !== undefined && variantOriginal > gross!
          ? { originalPriceMinor: variantOriginal }
          : {}),
        // Unknown availability is never sold from the raw ledger count.
        stockCount: availabilityUnknown ? 0 : stockOf(v.stockOnHand, v.availability),
        ...(availabilityUnknown ? { availabilityUnknown: true } : {}),
        ...(priceIssue ? { priceUnavailableReason: priceIssue } : {}),
        ...purchaseConstraints(minimum),
        packageQuantity,
        priceTiers: priceIssue
          ? []
          : dedupeTiers([
              { minimumQuantity: minimum, priceMinor: gross!, priceExcludingVatMinor: net! },
              ...tiers,
            ]),
        parameters: parameters(v.parameters),
        // Variant photos reference the parent product's gallery (`media:<asset>`), served like the gallery.
        imageSrc: productMediaPath(text(p.id), text(v.imageSrc)) ?? safeImage(v.imageSrc),
        ...flags(v),
      };
    };
    const variantRecords = rows(p.variantRecords);
    const variants = variantRecords
      .filter((v) => v.active !== false)
      .flatMap((v) => {
        const converted = convert(v);
        return converted ? [converted] : [];
      });
    if (variantRecords.length && !variants.length) continue;
    const gross = number(p.grossPriceMinor);
    const net = number(p.currentPriceMinor);
    // Products created in OntOS (not imported) carry no minimumQuantity; the owner then sells from 1 unit.
    const minimum = number(p.minimumQuantity) ?? 1;
    const variantSummary = variantSummaryOf(p.variantSummary);
    if (
      p.searchMatch !== undefined &&
      ((body.market !== undefined && !market) || market?.configured === false)
    )
      invalidSearchMatch();
    const searchMatch =
      p.searchMatch === undefined
        ? undefined
        : searchMatchOf(p.searchMatch, p, money, variantSummary.count);
    // A variant group is sold per variant: its card price is the owner's lowest sellable variant price.
    const isGroup = variantSummary.count > 0;
    const groupGross = variantSummary.minGrossPriceMinor ?? undefined;
    // A group has no net price of its own (each variant carries one), so only its gross price is checked.
    const productPriceIssue = isGroup
      ? priceUnavailableReason(groupGross, groupGross, p.currency, money)
      : priceUnavailableReason(gross, net, p.currency, money);
    const productAvailabilityUnknown = isAvailabilityUnknown(p.availability, p.stockTracked);
    const priced = variants.filter((v) => !v.priceUnavailableReason);
    const first = priced.reduce<CatalogProductVariant | undefined>(
      (a, b) => (!a || b.priceMinor < a.priceMinor ? b : a),
      undefined,
    );
    const productTiers =
      isGroup || productPriceIssue
        ? []
        : dedupeTiers([
            { minimumQuantity: minimum, priceMinor: gross!, priceExcludingVatMinor: net! },
            ...rows(p.priceTiers)
              .map((t) => ({
                minimumQuantity: number(t.minimumQuantity)!,
                priceMinor: number(t.priceMinor)!,
                priceExcludingVatMinor: number(t.priceExcludingVatMinor)!,
              }))
              .filter((t) => Object.values(t).every(Number.isFinite) && t.priceMinor > 0),
          ]);
    // Photos uploaded in OntOS are served by this storefront through the governed media read.
    const gallery = strings(p.gallery).flatMap(
      (src) => productMediaPath(text(p.id), src) ?? safeImage(src) ?? [],
    );
    // Staff edit the ordered gallery in OntOS ("Hlavní" = first image); imageSrc is only the import-time copy.
    const primaryImage = gallery[0] ?? safeImage(p.imageSrc) ?? imagePlaceholder;
    const paragraphs = paragraphsOf(p);
    const productUnit = filled(p.sourceUnit) ?? filled(p.unit) ?? "ks";
    const productWeightGrams = number(p.weightGrams);
    // A variant group has no weight of its own; each variant carries its own (never inherited).
    const netWeight =
      isGroup || variants.length
        ? undefined
        : productWeightGrams !== undefined && productWeightGrams > 0
          ? productWeightGrams / 1000
          : sourceUnitWeightKg(text(p.sku), productUnit);
    const productGross = productPriceIssue ? 0 : isGroup ? groupGross! : gross!;
    const ownOriginal = number(p.originalPriceMinor);
    const productOriginal = productPriceIssue
      ? undefined
      : isGroup
        ? (first?.originalPriceMinor ??
          (ownOriginal !== undefined && ownOriginal > productGross ? ownOriginal : undefined))
        : ownOriginal !== undefined && ownOriginal > productGross
          ? ownOriginal
          : undefined;
    const dimensions = [p.lengthMm, p.widthMm, p.heightMm].flatMap((value) => {
      const mm = number(value);
      return mm !== undefined && mm > 0 ? [mm.toLocaleString("cs-CZ")] : [];
    });
    const brandName = filled(p.brand);
    const seoTitle = filled(p.seoTitle);
    const seoDescription = filled(p.seoDescription);
    const detail = p.detail && typeof p.detail === "object" ? (p.detail as Raw) : {};
    products.push({
      id: text(p.id),
      slug: text(p.slug),
      sku: text(p.sku),
      name: text(p.name),
      categoryId: text(p.categoryId),
      description: paragraphs[0] ?? text(p.shortDescription),
      currency: money.currency,
      unit: productUnit,
      ...(netWeight === undefined ? {} : { netWeight }),
      ...(dimensions.length ? { dimensionsText: `${dimensions.join(" × ")} mm` } : {}),
      vatRate: number(p.vatRate),
      priceMinor: productGross,
      ...(productOriginal === undefined ? {} : { originalPriceMinor: productOriginal }),
      ...(brandName ? { brand: brandName } : {}),
      ...(seoTitle ? { seoTitle } : {}),
      ...(seoDescription ? { seoDescription } : {}),
      documents: documentsOf(p.documents),
      relatedProductIds: strings(p.relatedProductIds).filter((id) => id.trim() !== ""),
      ...(productAvailabilityUnknown ? { availabilityUnknown: true } : {}),
      ...(productPriceIssue ? { priceUnavailableReason: productPriceIssue } : {}),
      ...purchaseConstraints(first?.minimumQuantity ?? minimum),
      // The owner stores 0 for a cleared package: only a positive package is one.
      packageQuantity: first
        ? first.packageQuantity
        : (number(p.packageQuantity) ?? 0) > 0
          ? number(p.packageQuantity)
          : undefined,
      stockCount: productAvailabilityUnknown
        ? 0
        : isGroup
          ? variantSummary.stockOnHand
          : stockOf(p.stockOnHand, p.availability),
      variantSummary,
      ...(searchMatch === undefined ? {} : { searchMatch }),
      imageSrc: primaryImage,
      imageAlt: text(p.imageAlt, text(p.name)),
      secondaryImageSrc: gallery.find((src) => src !== primaryImage),
      additionalImageSrcs: [...new Set(gallery.filter((src) => src !== primaryImage))],
      featuredPosition: number(p.featuredPosition) ?? null,
      ...flags(p),
      detail: {
        descriptionParagraphs: paragraphs,
        parameters: parameters(p.parameters ?? detail.parameters),
        variants,
        priceTiers: first?.priceTiers ?? productTiers,
      },
    });
  }
  const homepageFeaturedProductIds = Array.isArray(body.homepageFeaturedProductIds)
    ? strings(body.homepageFeaturedProductIds)
    : products
        .filter((product) => product.featuredPosition !== null || product.isRecommended)
        .sort(
          (a, b) =>
            (a.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
            (b.featuredPosition ?? Number.MAX_SAFE_INTEGER),
        )
        .map((product) => product.id);
  return {
    ...(market ? { market } : {}),
    revision: number(body.revision) ?? 0,
    total: number(body.total) ?? products.length,
    page: number(body.page) ?? 1,
    pageSize: number(body.pageSize) ?? products.length,
    products,
    homepageFeaturedProductIds,
  };
}

/**
 * Project the owner's navigation tree. Content fields (heading, descriptions, image) are present only for
 * root categories and for the category a read asks about in detail plus its direct children.
 */
export function projectCategories(body: Raw): CatalogCategory[] {
  const categories: CatalogCategory[] = rows(body.categories)
    .filter((c) => text(c.id) && text(c.slug) && c.published !== false)
    .map((c) => ({
      id: text(c.id),
      parentId: text(c.parentId) || null,
      slug: text(c.slug),
      name: text(c.name),
      position: number(c.position) ?? 0,
      hasChildren: false,
      heading: text(c.heading) || undefined,
      description: text(c.description) || undefined,
      longDescription: text(c.longDescription) || undefined,
      imageSrc: safeImage(c.imageSrc),
      imageAlt: text(c.imageAlt, text(c.name)),
    }));
  const parentIds = new Set(categories.map((category) => category.parentId));
  for (const category of categories) category.hasChildren = parentIds.has(category.id);
  assertCategoryForest(categories, "projection");
  return categories;
}
