import type { MerchandiseState } from '../shared/apis/records.ts';
import { Option, Predicate } from 'effect';
import type { CatalogCategory, Product, ProductVariant } from '../shared/domain/merchandise-model.ts';
import { normalizeCategoryName } from '../shared/domain/category-search.ts';
import { applyDemoPriceTiers } from './akros-price-tiers.ts';

const namedEntities = new Map(
  Object.entries({
    amp: '&',
    bdquo: '„',
    deg: '°',
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lt: '<',
    mdash: '—',
    nbsp: '\u00A0',
    ndash: '–',
    quot: '"',
    rdquo: '”',
    times: '×',
  }),
);
const entityPattern = /&(?:#(?<code>\d{1,6})|(?<name>[a-z]+));/gu;

/** Kai's source category copy carries HTML entities (`&ndash;`); OntOS stores and the storefront shows plain text. */
export const decodeHtmlEntities = (value: string): string =>
  value.replace(entityPattern, (match, code: string | undefined, name: string | undefined) =>
    code === undefined ? (namedEntities.get(name ?? '') ?? match) : String.fromCodePoint(Number(code)),
  );

const categoryTextKeys = ['name', 'heading', 'description', 'longDescription', 'imageAlt'] as const;

/** Decodes entities and "NULL" placeholders left in category text; returns the same object when nothing changes. */
export const decodeCategoryText = <C extends Partial<Pick<CatalogCategory, (typeof categoryTextKeys)[number]>>>(
  category: C,
): C => {
  const patch: Partial<Record<(typeof categoryTextKeys)[number], string>> = {};
  for (const key of categoryTextKeys) {
    const value = category[key];
    if (!Predicate.isString(value)) {
      continue;
    }
    // Kai's export writes a missing description as the literal text "NULL"; OntOS stores it as empty.
    if (key !== 'name' && /^\s*(?:null|undefined)\s*$/iu.test(value)) {
      patch[key] = '';
    } else {
      const decoded = decodeHtmlEntities(value);
      const normalized =
        key === 'name' || key === 'heading' || key === 'imageAlt' ? normalizeCategoryName(decoded) : decoded;
      if (normalized !== value) {
        patch[key] = normalized;
      }
    }
  }
  return Object.keys(patch).length === 0 ? category : { ...category, ...patch };
};

// Kai's copy promises quantity discounts ("Limity množstevních slev: … Snížená cena se projeví po vložení zboží do
// košíku"), but his catalog has one price tier per item, so the cart can never give them. OntOS does not show them.
const unbackedDiscountPattern = /Limity množstevních slev[\s\S]*?vložení zboží do košíku\.?/gu;

/** Removes the quantity-discount promise that no price tier backs; returns the same string when absent. */
export const stripUnbackedDiscount = (value: string): string =>
  value.includes('Limity množstevních slev')
    ? value
        .replace(unbackedDiscountPattern, '')
        .split(/\n\s*\n/u)
        .map((part) => part.replaceAll(/[ \t]{2,}/gu, ' ').trim())
        .filter((part) => part !== '')
        .join('\n\n')
    : value;

const hasTieredPrice = (product: Product) =>
  (product.priceTiers?.length ?? 0) > 1 ||
  (product.variants ?? []).some((variant) => (variant.priceTiers?.length ?? 0) > 1);

/** Strips the unbacked discount promise from a product an older import stored; same object when nothing changes. */
export const repairDiscountPromise = (product: Product): Product => {
  if (hasTieredPrice(product)) {
    return product;
  }
  const description = product.description === undefined ? undefined : stripUnbackedDiscount(product.description);
  const shortDescription =
    product.shortDescription === undefined ? undefined : stripUnbackedDiscount(product.shortDescription);
  if (description === product.description && shortDescription === product.shortDescription) {
    return product;
  }
  const repaired = { ...product };
  if (description !== undefined) {
    repaired.description = description;
  }
  if (shortDescription !== undefined) {
    repaired.shortDescription = shortDescription;
  }
  return repaired;
};

/**
 * Kai's tree has no order (every position is 0), so the storefront sorts siblings by name. Gives siblings
 * positions 10, 20, 30… in that same name order, so staff can move a category first, last or between two others.
 * Leaves a sibling group alone once any of its members has a non-zero position (a staff choice).
 */
export const orderCategoryPositions = <
  C extends {
    readonly name: string;
    readonly parentId: string | null | Option.Option<string>;
    readonly position: number;
  },
>(
  categories: readonly C[],
): C[] => {
  const groups = new Map<string | null, C[]>();
  for (const category of categories) {
    const parentId = Option.isOption(category.parentId) ? Option.getOrNull(category.parentId) : category.parentId;
    groups.set(parentId, [...(groups.get(parentId) ?? []), category]);
  }
  const positions = new Map<C, number>();
  for (const siblings of groups.values()) {
    if (siblings.some((category) => category.position !== 0)) {
      continue;
    }
    for (const [index, category] of siblings.toSorted((a, b) => a.name.localeCompare(b.name, 'cs')).entries()) {
      positions.set(category, (index + 1) * 10);
    }
  }
  return categories.map((category) => {
    const position = positions.get(category);
    return position === undefined ? category : { ...category, position };
  });
};

type ProductPatch = { -readonly [Key in keyof Product]?: Product[Key] };
type VariantFlags = { -readonly [Key in 'isAction' | 'isRecommended' | 'isSale' | 'isNew']?: ProductVariant[Key] };

/** Fills catalog content an older seed did not store; never overwrites a value that already exists. */
export const backfillProduct = (current: Product, seed: Product): Product => {
  const missing: ProductPatch = {};
  if (current.imageSrc === undefined && seed.imageSrc !== undefined) {
    missing.imageSrc = seed.imageSrc;
  }
  if (current.imageAlt === undefined && seed.imageAlt !== undefined) {
    missing.imageAlt = seed.imageAlt;
  }
  if (current.shortDescription === undefined && seed.shortDescription !== undefined) {
    missing.shortDescription = seed.shortDescription;
  }
  const seedVariants = new Map(
    (seed.variants ?? []).flatMap((variant) => (variant.id === undefined ? [] : [[variant.id, variant] as const])),
  );
  let variantsChanged = false;
  const variants = current.variants?.map((variant) => {
    const source = variant.id === undefined ? undefined : seedVariants.get(variant.id);
    if (source === undefined) {
      return variant;
    }
    const flags: VariantFlags = {};
    if (variant.isAction === undefined && source.isAction !== undefined) {
      flags.isAction = source.isAction;
    }
    if (variant.isRecommended === undefined && source.isRecommended !== undefined) {
      flags.isRecommended = source.isRecommended;
    }
    if (variant.isSale === undefined && source.isSale !== undefined) {
      flags.isSale = source.isSale;
    }
    if (variant.isNew === undefined && source.isNew !== undefined) {
      flags.isNew = source.isNew;
    }
    if (Object.keys(flags).length === 0) {
      return variant;
    }
    variantsChanged = true;
    return { ...variant, ...flags };
  });
  if (Object.keys(missing).length === 0 && !variantsChanged) {
    return current;
  }
  const product = { ...current, ...missing };
  if (variantsChanged && variants !== undefined) {
    product.variants = variants;
  }
  return product;
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
    categories: orderCategoryPositions([
      ...(current.categories ?? []).map(decodeCategoryText),
      ...(seed.categories ?? []).filter((entry) => !categoryIds.has(entry.id)),
    ]),
    homepageFeaturedProductIds: current.homepageFeaturedProductIds ?? seed.homepageFeaturedProductIds ?? [],
    movements: [...current.movements, ...seed.movements.filter((entry) => !movementIds.has(entry.id))],
    orders: [
      ...current.orders,
      ...seed.orders.filter((entry) => !orderIds.has(entry.id) && !orderNumbers.has(entry.number)),
    ],
    products: [
      ...seed.products.map((entry) => {
        const existing = currentProducts.get(entry.id);
        return existing === undefined
          ? entry
          : applyDemoPriceTiers(repairDiscountPromise(backfillProduct(existing, entry)));
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
