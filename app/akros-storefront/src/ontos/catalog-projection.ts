import rawCatalog from "@/mock-storefront/generated/catalog.generated.json";
import rawCategories from "@/mock-storefront/generated/categories.generated.json";
import type {
  CatalogData,
  CategoryData,
  CatalogProduct,
  CatalogProductVariant,
} from "@/mock-storefront/types";

type Raw = Record<string, unknown>;
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export interface CatalogSnapshot {
  catalog: CatalogData;
  categories: CategoryData;
  mode: "mock" | "ontos";
  revision: number;
}

/** Static content is presentation only. Identity, visibility, prices and stock ALWAYS come from the owner. */
export function project(body: Raw): CatalogSnapshot {
  const prototype = rawCatalog as CatalogData;
  const products: CatalogProduct[] = [];
  for (const p of rows(body.products)) {
    if (p.active === false || p.published === false) continue;
    const template = prototype.products.find(
      (t) => t.slug === p.slug || t.id === p.id || t.sku === p.sku,
    );
    if (!template) continue;
    const liveVariants = rows(p.variantRecords).filter((v) => v.active !== false);
    const convert = (v: Raw, original: CatalogProductVariant): CatalogProductVariant | null => {
      const gross = number(v.grossPriceMinor);
      const net = number(v.priceMinor);
      const stock = number(v.stockOnHand);
      const minimum = number(v.minimumQuantity) ?? number(p.minimumQuantity);
      if (
        gross === undefined ||
        net === undefined ||
        stock === undefined ||
        minimum === undefined ||
        typeof v.id !== "string"
      )
        return null;
      const tiers = rows(v.priceTiers)
        .map((t) => ({
          minimumQuantity: number(t.minimumQuantity)!,
          priceMinor: number(t.priceMinor)!,
          priceExcludingVatMinor: number(t.priceExcludingVatMinor)!,
        }))
        .filter((t) => Object.values(t).every(Number.isFinite));
      return {
        ...original,
        id: v.id,
        sku: String(v.sku),
        label: typeof v.name === "string" ? v.name : original.label,
        unit: String(v.sourceUnit ?? v.unit ?? p.sourceUnit ?? p.unit ?? original.unit),
        vatRate: number(p.vatRate),
        priceMinor: gross,
        originalPriceMinor: undefined,
        stockCount: stock,
        minimumQuantity: minimum,
        packageQuantity: number(v.packageQuantity) ?? number(p.packageQuantity),
        priceTiers: [
          { minimumQuantity: minimum, priceMinor: gross, priceExcludingVatMinor: net },
          ...tiers,
        ].sort((a, b) => a.minimumQuantity - b.minimumQuantity),
      };
    };
    const variants = liveVariants.flatMap((v) => {
      const original = template.detail.variants.find((t) => t.id === v.id || t.sku === v.sku);
      if (!original) return [];
      const converted = convert(v, original);
      return converted ? [converted] : [];
    });
    if (template.detail.variants.length && !variants.length) continue;
    const gross = number(p.grossPriceMinor);
    const net = number(p.currentPriceMinor);
    const stock = number(p.stockOnHand);
    const minimum = number(p.minimumQuantity);
    if (
      !variants.length &&
      (gross === undefined || net === undefined || stock === undefined || minimum === undefined)
    )
      continue;
    const first = variants.reduce<CatalogProductVariant | undefined>(
      (a, b) => (!a || b.priceMinor < a.priceMinor ? b : a),
      undefined,
    );
    products.push({
      ...template,
      id: String(p.id),
      name: String(p.name),
      categoryId: typeof p.categoryId === "string" ? p.categoryId : template.categoryId,
      unit: String(p.sourceUnit ?? p.unit ?? template.unit),
      vatRate: number(p.vatRate),
      priceMinor: first?.priceMinor ?? gross!,
      originalPriceMinor: undefined,
      minimumQuantity: first?.minimumQuantity ?? minimum!,
      packageQuantity: first?.packageQuantity ?? number(p.packageQuantity),
      stockCount: variants.length ? variants.reduce((s, v) => s + v.stockCount, 0) : stock!,
      detail: {
        ...template.detail,
        variants,
        priceTiers: first?.priceTiers ?? [
          { minimumQuantity: minimum!, priceMinor: gross!, priceExcludingVatMinor: net! },
        ],
      },
    });
  }
  const allCategories = (rawCategories as CategoryData).categories;
  const ids = new Set(products.map((p) => p.categoryId));
  for (let i = 0; i < allCategories.length; i++)
    for (const c of allCategories) if (ids.has(c.id) && c.parentId) ids.add(c.parentId);
  const categories = allCategories
    .filter((c) => ids.has(c.id))
    .map((c) => ({
      ...c,
      hasChildren: allCategories.some((child) => ids.has(child.id) && child.parentId === c.id),
    }));
  const metadata = {
    sourceCategoryCount: categories.length,
    sourceItemCount: products.length,
    productGroupCount: products.length,
  };
  return {
    mode: "ontos",
    revision: Number(body.revision),
    catalog: {
      metadata,
      products,
      homepageFeaturedProductIds: [
        ...prototype.homepageFeaturedProductIds.filter((id) => products.some((p) => p.id === id)),
        ...products.map((p) => p.id),
      ].slice(0, 16),
    },
    categories: { metadata, categories },
  };
}
