// Catalog projection for the storefront. Source of truth: the merchandise owner read (records) of the
// Kavárna Doma legal entity. Only published, active products leave this module, and only customer-facing
// fields: no stock values, price history, orders, principals or other staff data reach the browser.
import type {
  Availability,
  CatalogResponse,
  HomeResponse,
  StoreCategory,
  StoreProduct,
  StoreProductSummary,
  StoreVariant,
} from '../src/shared/types.ts';
import { categoryArtKey, slugify } from '../src/shared/text.ts';
import { readRecords } from './ontos.ts';
import { loadFixtureRecords } from './dev-fixture.ts';

type Raw = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const arr = (value: unknown): Raw[] => (Array.isArray(value) ? (value.filter((item) => item !== null && typeof item === 'object') as Raw[]) : []);

const AVAILABILITIES: readonly Availability[] = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN'];
const availabilityOf = (value: unknown): Availability | undefined =>
  AVAILABILITIES.includes(value as Availability) ? (value as Availability) : undefined;

export interface RecordsSnapshot {
  readonly products: readonly Raw[];
  readonly orders: readonly Raw[];
  readonly revision: number;
  readonly fetchedAt: string;
}

let cache: { readonly at: number; readonly value: RecordsSnapshot } | undefined;
let inflight: Promise<RecordsSnapshot> | undefined;
const CACHE_MS = 1500;

export const useFixture = (): boolean => process.env.ESHOP_FIXTURE === '1';

/** One governed read of the merchandise aggregate; bursts within 1.5 s share it. `fresh` bypasses the cache. */
export const loadRecords = async (fresh = false): Promise<RecordsSnapshot> => {
  if (!fresh && cache !== undefined && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (!fresh && inflight !== undefined) return await inflight;
  const run = (async () => {
    const body = (useFixture() ? loadFixtureRecords() : await readRecords('merchandise', 'records', { view: { storefront: true } })) as Raw;
    const value: RecordsSnapshot = {
      fetchedAt: new Date().toISOString(),
      orders: arr(body.orders),
      products: arr(body.products),
      revision: num(body.revision) ?? 0,
    };
    cache = { at: Date.now(), value };
    return value;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = undefined;
  }
};

/** Storefront lookup of the one guest order stored under `clientRequestId` (owner-side filter). */
export const loadStoredOrder = async (clientRequestId: string): Promise<Raw | undefined> => {
  if (useFixture()) return arr(loadFixtureRecords().orders).find((order) => order.clientRequestId === clientRequestId);
  const body = (await readRecords('merchandise', 'records', { view: { orderClientRequestId: clientRequestId, storefront: true } })) as Raw;
  return arr(body.orders).find((order) => order.clientRequestId === clientRequestId);
};

export const invalidateRecords = (): void => {
  if (cache !== undefined) cache = { at: 0, value: cache.value };
};

/** Last successful snapshot regardless of age (artwork labels only; never used for prices). */
export const lastSnapshot = (): RecordsSnapshot | undefined => cache?.value;

const WEIGHT = /^\d+(?:[.,]\d+)?\s?(?:g|kg|ml|l|ks)$/iu;
const GRIND = /(zrn|mlet|espresso|filtr|french|turk|moka|hrub|jemn)/iu;

/** Splits „250 g / zrnková“ or „Hmotnost: 250 g; Mletí: zrnková“ into named options. */
const optionsOf = (name: string, attributes: string | undefined): Record<string, string> => {
  const pairs = (attributes ?? '')
    .split(/[;\n]/u)
    .map((part) => part.split(':'))
    .filter((part) => part.length === 2 && part[0].trim() !== '' && part[1].trim() !== '');
  if (pairs.length > 0) return Object.fromEntries(pairs.map(([key, value]) => [key.trim(), value.trim()]));
  const parts = name.split(/\s+[/·|]\s+|,\s+/u).map((part) => part.trim()).filter(Boolean);
  const options: Record<string, string> = {};
  parts.forEach((part, index) => {
    let key = WEIGHT.test(part) ? 'Balení' : GRIND.test(part) ? 'Mletí' : parts.length === 1 ? 'Varianta' : `Možnost ${index + 1}`;
    if (key in options) key = `${key} ${index + 1}`;
    options[key] = part;
  });
  return options;
};

/** Relative storefront paths and bare keys resolve to the storefront artwork; absolute URLs pass through. */
const imageUrl = (value: string): string => {
  if (/^https?:\/\//u.test(value) || value.startsWith('/')) return value;
  return `/img/${slugify(value.replace(/\.svg$/u, ''))}.svg`;
};

const imagesOf = (raw: Raw, slug: string): string[] => {
  const values = Array.isArray(raw.images) ? raw.images : [];
  const urls = values
    .map((item) => (typeof item === 'string' ? item : str((item as Raw | null)?.url) ?? str((item as Raw | null)?.src)))
    .filter((item): item is string => item !== undefined)
    .map(imageUrl);
  if (urls.length > 0) return urls;
  // An explicit empty list is the owner's „bez obrázku“; a missing list (legacy product) gets generated artwork.
  return Array.isArray(raw.images) ? [] : [`/img/${slug}.svg`];
};

const variantsOf = (raw: Raw, productId: string): StoreVariant[] => {
  const records = arr(raw.variantRecords).filter((variant) => variant.active !== false);
  if (records.length > 0) {
    return records.map((variant) => {
      const label = str(variant.name) ?? str(variant.sku) ?? 'Varianta';
      const availability = availabilityOf(variant.availability) ?? 'UNKNOWN';
      const stock = num(variant.stockOnHand);
      return {
        availability,
        availableQuantity: availability === 'UNKNOWN' || stock === undefined ? null : Math.max(0, stock),
        id: str(variant.id) ?? label,
        label,
        options: optionsOf(label, str(variant.attributes)),
        priceMinor: num(variant.grossPriceMinor) ?? null,
        sku: str(variant.sku) ?? '',
      };
    });
  }
  // Product without real variants: one implicit variant carrying the product's own identity.
  const stockTracked = raw.stockTracked !== false;
  const stock = num(raw.stockOnHand);
  const availability =
    availabilityOf(raw.availability) ??
    (!stockTracked || stock === undefined ? 'UNKNOWN' : stock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK');
  return [
    {
      availability,
      availableQuantity: availability === 'UNKNOWN' || stock === undefined ? null : Math.max(0, stock),
      id: productId,
      label: 'Standard',
      options: {},
      priceMinor: num(raw.grossPriceMinor) ?? null,
      sku: str(raw.sku) ?? '',
    },
  ];
};

const rollupAvailability = (variants: readonly StoreVariant[]): Availability => {
  if (variants.some((variant) => variant.availability === 'IN_STOCK')) return 'IN_STOCK';
  if (variants.some((variant) => variant.availability === 'LOW_STOCK')) return 'LOW_STOCK';
  if (variants.some((variant) => variant.availability === 'UNKNOWN')) return 'UNKNOWN';
  return 'OUT_OF_STOCK';
};

const UNIT_LABEL: Record<string, string> = { bal: 'balení', hod: 'hodina', ks: 'ks', lic: 'licence' };

const factsOf = (raw: Raw, variantCount: number): { label: string; value: string }[] => {
  const facts: { label: string; value: string }[] = [];
  const weight = num(raw.weightGrams);
  if (weight !== undefined && variantCount <= 1) facts.push({ label: 'Hmotnost', value: weight >= 1000 ? `${(weight / 1000).toLocaleString('cs-CZ')} kg` : `${weight} g` });
  const [l, w, h] = [num(raw.lengthMm), num(raw.widthMm), num(raw.heightMm)];
  if (l !== undefined && w !== undefined && h !== undefined) facts.push({ label: 'Rozměry', value: `${l / 10} × ${w / 10} × ${h / 10} cm` });
  const vat = num(raw.vatRate);
  if (vat !== undefined) facts.push({ label: 'DPH', value: `${vat} % (v ceně)` });
  return facts;
};

const CATEGORY_ORDER = ['kategorie-kava', 'kategorie-mleta', 'kategorie-caj', 'kategorie-vybaveni', 'kategorie-darky'];

const isPublished = (raw: Raw): boolean => raw.active !== false && raw.published !== false;

export interface ProjectedCatalog {
  readonly products: readonly StoreProduct[];
  readonly categories: readonly StoreCategory[];
  readonly snapshot: RecordsSnapshot;
}

export const projectCatalog = (snapshot: RecordsSnapshot): ProjectedCatalog => {
  const seen = new Set<string>();
  const products: StoreProduct[] = [];
  for (const raw of snapshot.products) {
    if (!isPublished(raw)) continue;
    const id = str(raw.id);
    const name = str(raw.name);
    if (id === undefined || name === undefined) continue;
    let slug = slugify(str(raw.slug) ?? name);
    if (seen.has(slug)) slug = `${slug}-${slugify(id).slice(-6)}`;
    seen.add(slug);
    const categoryName = str(raw.category) ?? 'Ostatní';
    const variants = variantsOf(raw, id);
    const prices = variants.map((variant) => variant.priceMinor).filter((price): price is number => price !== null);
    const images = imagesOf(raw, slug);
    products.push({
      availability: rollupAvailability(variants),
      category: { name: categoryName, slug: slugify(categoryName) },
      description: str(raw.description) ?? null,
      facts: factsOf(raw, variants.length),
      id,
      image: images[0] ?? '/img/bez-obrazku.svg',
      images,
      name,
      priceFromMinor: prices.length > 0 ? Math.min(...prices) : null,
      priceVaries: new Set(prices).size > 1,
      shortDescription: str(raw.shortDescription) ?? null,
      slug,
      unit: UNIT_LABEL[str(raw.unit) ?? 'ks'] ?? 'ks',
      variantCount: variants.length,
      variants,
      vatRate: num(raw.vatRate) ?? 21,
    });
  }
  const byCategory = new Map<string, StoreCategory>();
  for (const product of products) {
    const existing = byCategory.get(product.category.slug);
    byCategory.set(product.category.slug, {
      art: categoryArtKey(product.category.name),
      name: product.category.name,
      productCount: (existing?.productCount ?? 0) + 1,
      slug: product.category.slug,
    });
  }
  const rank = (category: StoreCategory) => CATEGORY_ORDER.indexOf(category.art);
  const categories = [...byCategory.values()].sort((a, b) => rank(a) - rank(b) || b.productCount - a.productCount || a.name.localeCompare(b.name, 'cs'));
  return { categories, products, snapshot };
};

export const summaryOf = (product: StoreProduct): StoreProductSummary => ({
  availability: product.availability,
  category: product.category,
  id: product.id,
  image: product.image,
  name: product.name,
  priceFromMinor: product.priceFromMinor,
  priceVaries: product.priceVaries,
  shortDescription: product.shortDescription,
  slug: product.slug,
  variantCount: product.variantCount,
  vatRate: product.vatRate,
});

/** Lower-case, diacritics-free text for deterministic matching. */
const fold = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export interface CatalogQuery {
  readonly q?: string;
  readonly category?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly availability?: string;
  readonly sort?: string;
}

const inStock = (availability: Availability): boolean => availability === 'IN_STOCK' || availability === 'LOW_STOCK';

export const queryCatalog = (catalog: ProjectedCatalog, query: CatalogQuery): CatalogResponse => {
  const needle = fold(query.q?.trim() ?? '');
  const minMinor = query.minPrice === undefined ? undefined : Math.round(query.minPrice * 100);
  const maxMinor = query.maxPrice === undefined ? undefined : Math.round(query.maxPrice * 100);
  const matches = catalog.products.filter((product) => {
    if (query.category !== undefined && query.category !== '' && product.category.slug !== query.category) return false;
    if (needle !== '') {
      const haystack = fold([product.name, product.shortDescription ?? '', product.category.name, ...product.variants.flatMap((variant) => [variant.sku, variant.label])].join(' '));
      if (!needle.split(/\s+/u).every((token) => haystack.includes(token))) return false;
    }
    if (minMinor !== undefined || maxMinor !== undefined) {
      const priced = product.variants.filter((variant) => variant.priceMinor !== null);
      const fits = priced.some(
        (variant) => (minMinor === undefined || (variant.priceMinor ?? 0) >= minMinor) && (maxMinor === undefined || (variant.priceMinor ?? 0) <= maxMinor),
      );
      if (!fits) return false;
    }
    if (query.availability === 'skladem' && !product.variants.some((variant) => inStock(variant.availability))) return false;
    return true;
  });
  const byName = (a: StoreProduct, b: StoreProduct) => a.name.localeCompare(b.name, 'cs');
  const priceKey = (product: StoreProduct, fallback: number) => product.priceFromMinor ?? fallback;
  const sorted = [...matches].sort((a, b) => {
    if (query.sort === 'cena-vzestupne') return priceKey(a, Number.MAX_SAFE_INTEGER) - priceKey(b, Number.MAX_SAFE_INTEGER) || byName(a, b);
    if (query.sort === 'cena-sestupne') return priceKey(b, -1) - priceKey(a, -1) || byName(a, b);
    return byName(a, b);
  });
  const allPrices = catalog.products.flatMap((product) => product.variants.map((variant) => variant.priceMinor)).filter((price): price is number => price !== null);
  return {
    categories: catalog.categories,
    fetchedAt: catalog.snapshot.fetchedAt,
    priceBounds: allPrices.length > 0 ? { maxMinor: Math.max(...allPrices), minMinor: Math.min(...allPrices) } : null,
    products: sorted.map(summaryOf),
    total: sorted.length,
  };
};

export const homeOf = (catalog: ProjectedCatalog): HomeResponse => {
  const sold = new Map<string, number>();
  for (const order of catalog.snapshot.orders) {
    if (order.status === 'CANCELLED') continue;
    for (const line of arr(order.lines)) {
      const productId = str(line.productId);
      if (productId !== undefined) sold.set(productId, (sold.get(productId) ?? 0) + (num(line.quantity) ?? 0));
    }
  }
  const purchasable = catalog.products.filter((product) => product.priceFromMinor !== null);
  const bestsellers = [...purchasable]
    .sort((a, b) => (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0) || Number(inStock(b.availability)) - Number(inStock(a.availability)) || b.variantCount - a.variantCount || a.name.localeCompare(b.name, 'cs'))
    .slice(0, 8);
  const created = new Map(catalog.snapshot.products.map((raw) => [str(raw.id) ?? '', str(raw.createdAt) ?? '']));
  const newest = [...purchasable]
    .filter((product) => !bestsellers.slice(0, 4).includes(product))
    .sort((a, b) => (created.get(b.id) ?? '').localeCompare(created.get(a.id) ?? ''))
    .slice(0, 4);
  return {
    bestsellers: bestsellers.map(summaryOf),
    categories: catalog.categories,
    fetchedAt: catalog.snapshot.fetchedAt,
    newest: newest.map(summaryOf),
    productCount: catalog.products.length,
  };
};
