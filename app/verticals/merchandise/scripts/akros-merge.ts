import type { MerchandiseState } from '../shared/apis/records.ts';
import type { Product } from '../shared/domain/merchandise-model.ts';

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
    categories: [...(current.categories ?? []), ...(seed.categories ?? []).filter((entry) => !categoryIds.has(entry.id))],
    homepageFeaturedProductIds: current.homepageFeaturedProductIds ?? seed.homepageFeaturedProductIds ?? [],
    movements: [...current.movements, ...seed.movements.filter((entry) => !movementIds.has(entry.id))],
    orders: [...current.orders, ...seed.orders.filter((entry) => !orderIds.has(entry.id) && !orderNumbers.has(entry.number))],
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
