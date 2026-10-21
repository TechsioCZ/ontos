import { purchaseConstraints } from "./purchase-constraints";
import type {
  CatalogData,
  CategoryData,
  CatalogCategory,
  CatalogParameter,
  CatalogProduct,
  CatalogProductVariant,
} from "@/mock-storefront/types";

type Raw = Record<string, unknown>;
const rows = (v: unknown): Raw[] =>
  Array.isArray(v) ? v.filter((x): x is Raw => Boolean(x) && typeof x === "object") : [];
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const parameters = (v: unknown): CatalogParameter[] =>
  rows(v)
    .map((p) => ({ label: text(p.label), value: text(p.value), unit: text(p.unit) }))
    .filter((p) => p.label.trim() !== "");

export const imagePlaceholder = "/akros/products/image-unavailable.svg";
const imageHosts = (): Set<string> =>
  new Set([
    "www.akros.cz",
    ...(process.env.STOREFRONT_IMAGE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  ]);
/** Only images next/image can serve: same-origin "/…" paths or https on a configured host. */
export const safeImage = (v: unknown): string | undefined => {
  const src = text(v).trim();
  if (!src) return undefined;
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

export interface CatalogSnapshot {
  catalog: CatalogData;
  categories: CategoryData;
  mode: "mock" | "ontos";
  revision: number;
  total?: number;
  page?: number;
  pageSize?: number;
}

/** Project ONLY owner data. No prototype catalog/template lookup, including unknown/new identities. */
export function project(body: Raw): CatalogSnapshot {
  const products: CatalogProduct[] = [];
  for (const p of rows(body.products)) {
    if (p.active === false || p.published === false || !text(p.id) || !text(p.slug)) continue;
    const convert = (v: Raw): CatalogProductVariant | null => {
      const gross = number(v.grossPriceMinor);
      const net = number(v.priceMinor);
      const stock = number(v.stockOnHand);
      // Same default as the owner order rules (merchandise order-quantity: minimumQuantity ?? 1).
      const minimum = number(v.minimumQuantity) ?? number(p.minimumQuantity) ?? 1;
      if (
        gross === undefined ||
        net === undefined ||
        stock === undefined ||
        minimum === undefined ||
        !text(v.id)
      )
        return null;
      const tiers = rows(v.priceTiers)
        .map((t) => ({
          minimumQuantity: number(t.minimumQuantity)!,
          priceMinor: number(t.priceMinor)!,
          priceExcludingVatMinor: number(t.priceExcludingVatMinor)!,
        }))
        .filter((t) => Object.values(t).every(Number.isFinite));
      const packageQuantity = number(v.packageQuantity) ?? number(p.packageQuantity);
      return {
        id: text(v.id),
        sourceId: text(v.sourceId, text(v.id)),
        sku: text(v.sku),
        label: text(v.name, text(v.label, text(v.sku))),
        unit: text(v.sourceUnit, text(v.unit, text(p.sourceUnit, text(p.unit, "ks")))),
        vatRate: number(p.vatRate),
        priceMinor: gross,
        stockCount: stock,
        ...purchaseConstraints(minimum, packageQuantity),
        packageQuantity,
        priceTiers: [
          { minimumQuantity: minimum, priceMinor: gross, priceExcludingVatMinor: net },
          ...tiers,
        ].sort((a, b) => a.minimumQuantity - b.minimumQuantity),
        parameters: parameters(v.parameters),
        imageSrc: safeImage(v.imageSrc),
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
    const stock = number(p.stockOnHand);
    // Products created in OntOS (not imported) carry no minimumQuantity; the owner then sells from 1 unit.
    const minimum = number(p.minimumQuantity) ?? 1;
    if (
      !variants.length &&
      (gross === undefined || net === undefined || stock === undefined || minimum === undefined)
    )
      continue;
    const first = variants.reduce<CatalogProductVariant | undefined>(
      (a, b) => (!a || b.priceMinor < a.priceMinor ? b : a),
      undefined,
    );
    const gallery = strings(p.gallery).flatMap((src) => safeImage(src) ?? []);
    // Staff edit the ordered gallery in OntOS ("Hlavní" = first image); imageSrc is only the import-time copy.
    const primaryImage = gallery[0] ?? safeImage(p.imageSrc) ?? imagePlaceholder;
    const paragraphs = paragraphsOf(p);
    const detail = p.detail && typeof p.detail === "object" ? (p.detail as Raw) : {};
    products.push({
      id: text(p.id),
      slug: text(p.slug),
      sku: text(p.sku),
      name: text(p.name),
      categoryId: text(p.categoryId),
      description: paragraphs[0] ?? text(p.shortDescription),
      currency: "CZK",
      unit: text(p.sourceUnit, text(p.unit, "ks")),
      vatRate: number(p.vatRate),
      priceMinor: first?.priceMinor ?? gross!,
      ...purchaseConstraints(
        first?.minimumQuantity ?? minimum!,
        first?.packageQuantity ?? number(p.packageQuantity),
      ),
      packageQuantity: first?.packageQuantity ?? number(p.packageQuantity),
      stockCount: variants.length ? variants.reduce((sum, v) => sum + v.stockCount, 0) : stock!,
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
        priceTiers: first?.priceTiers ?? [
          { minimumQuantity: minimum!, priceMinor: gross!, priceExcludingVatMinor: net! },
        ],
      },
    });
  }
  const categories: CatalogCategory[] = rows(body.categories)
    .filter((c) => text(c.id) && text(c.slug) && c.active !== false && c.published !== false)
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
  const total = number(body.total) ?? products.length;
  const metadata = {
    sourceCategoryCount: categories.length,
    sourceItemCount: total,
    productGroupCount: total,
  };
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
    mode: "ontos",
    revision: number(body.revision) ?? 0,
    total,
    page: number(body.page) ?? 1,
    pageSize: number(body.pageSize) ?? products.length,
    catalog: { metadata, products, homepageFeaturedProductIds },
    categories: { metadata, categories },
  };
}
