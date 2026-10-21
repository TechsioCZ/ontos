import type { MerchandiseState } from '../shared/apis/records.ts';
import type { CatalogCategory, Product } from '../shared/domain/merchandise-model.ts';

const namedEntities: Readonly<Record<string, string>> = {
  amp: '&',
  bdquo: '„',
  deg: '°',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lt: '<',
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  quot: '"',
  rdquo: '”',
  times: '×',
};
const entityPattern = /&(?:#(\d{1,6})|([a-z]+));/gu;

/** Kai's source category copy carries HTML entities (`&ndash;`); OntOS stores and the storefront shows plain text. */
export const decodeHtmlEntities = (value: string): string =>
  value.replace(entityPattern, (match, code: string | undefined, name: string | undefined) =>
    code === undefined ? (namedEntities[name ?? ''] ?? match) : String.fromCodePoint(Number(code)),
  );

const categoryTextKeys = ['name', 'heading', 'description', 'longDescription', 'imageAlt'] as const;

/** Decodes entities left in category text by an older import; returns the same object when nothing changes. */
export const decodeCategoryText = <C extends Partial<Pick<CatalogCategory, (typeof categoryTextKeys)[number]>>>(
  category: C,
): C => {
  const patch: Partial<Record<(typeof categoryTextKeys)[number], string>> = {};
  for (const key of categoryTextKeys) {
    const value = category[key];
    if (typeof value === 'string' && decodeHtmlEntities(value) !== value) patch[key] = decodeHtmlEntities(value);
  }
  return Object.keys(patch).length === 0 ? category : { ...category, ...patch };
};

/** Fills catalog content an older seed did not store; never overwrites a value that already exists. */
export const backfillProduct = (current: Product, seed: Product): Product => {
  const missing: Partial<Product> = {
    ...(current.imageSrc === undefined && seed.imageSrc !== undefined ? { imageSrc: seed.imageSrc } : {}),
    ...(current.imageAlt === undefined && seed.imageAlt !== undefined ? { imageAlt: seed.imageAlt } : {}),
    ...(current.shortDescription === undefined && seed.shortDescription !== undefined
      ? { shortDescription: seed.shortDescription }
      : {}),
  };
  const seedVariants = new Map(
    (seed.variants ?? []).flatMap((variant) => (variant.id === undefined ? [] : [[variant.id, variant] as const])),
  );
  let variantsChanged = false;
  const variants = current.variants?.map((variant) => {
    const source = variant.id === undefined ? undefined : seedVariants.get(variant.id);
    if (source === undefined) return variant;
    const flags = {
      ...(variant.isAction === undefined && source.isAction !== undefined ? { isAction: source.isAction } : {}),
      ...(variant.isRecommended === undefined && source.isRecommended !== undefined
        ? { isRecommended: source.isRecommended }
        : {}),
      ...(variant.isSale === undefined && source.isSale !== undefined ? { isSale: source.isSale } : {}),
      ...(variant.isNew === undefined && source.isNew !== undefined ? { isNew: source.isNew } : {}),
    };
    if (Object.keys(flags).length === 0) return variant;
    variantsChanged = true;
    return { ...variant, ...flags };
  });
  if (Object.keys(missing).length === 0 && !variantsChanged) return current;
  return { ...current, ...missing, ...(variantsChanged && variants !== undefined ? { variants } : {}) };
};

/** Adds missing seed records by id in source order; keeps every current record (demo edits, live orders, stock). */
export const mergeSeed = (current: MerchandiseState, seed: MerchandiseState): MerchandiseState => {
  const currentProducts = new Map(current.products.map((entry) => [entry.id, entry] as const));
  const seedProductIds = new Set(seed.products.map((entry) => entry.id));
  const movementIds = new Set(current.movements.map((entry) => entry.id));
  const orderIds = new Set(current.orders.map((entry) => entry.id));
  const orderNumbers = new Set(current.orders.map((entry) => entry.number));
  const categoryIds = new Set((current.categories ?? []).map((entry) => entry.id));
  return {
    categories: [
      ...(current.categories ?? []).map(decodeCategoryText),
      ...(seed.categories ?? []).filter((entry) => !categoryIds.has(entry.id)),
    ],
    homepageFeaturedProductIds: current.homepageFeaturedProductIds ?? seed.homepageFeaturedProductIds ?? [],
    movements: [...current.movements, ...seed.movements.filter((entry) => !movementIds.has(entry.id))],
    orders: [
      ...current.orders,
      ...seed.orders.filter((entry) => !orderIds.has(entry.id) && !orderNumbers.has(entry.number)),
    ],
    products: [
      ...seed.products.map((entry) => {
        const existing = currentProducts.get(entry.id);
        return existing === undefined ? entry : backfillProduct(existing, entry);
      }),
      ...current.products.filter((entry) => !seedProductIds.has(entry.id)),
    ],
  };
};

/** Restores seed products (prices, variants, images, flags) to their seed definition; keeps orders and extra data. */
export const restoreCatalog = (current: MerchandiseState, seed: MerchandiseState): MerchandiseState => {
  const merged = mergeSeed(current, seed);
  const seedProducts = new Map(seed.products.map((product) => [product.id, product] as const));
  return { ...merged, products: merged.products.map((product) => seedProducts.get(product.id) ?? product) };
};
