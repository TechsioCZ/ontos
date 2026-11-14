import { createHash } from 'node:crypto';
import { Array as Arr, Order, Predicate, Result, Schema } from 'effect';
import type { Types } from 'effect';
import { CategoryPatchSchema, ProductPatchSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import {
  CatalogCategorySchema,
  ProductRecordSchema,
} from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import {
  isMarketingCatalogImage,
  isSourcePlaceholder,
  neutralCatalogText,
} from '../../verticals/merchandise/scripts/akros-pseudonym.ts';

export const Product = Schema.toEncoded(ProductRecordSchema);
export const Category = Schema.toEncoded(CatalogCategorySchema);
export const ProductPatch = Schema.toEncoded(ProductPatchSchema);
export const CategoryPatch = Schema.toEncoded(CategoryPatchSchema);
export type CatalogProduct = typeof Product.Type;
export type CatalogCategory = typeof Category.Type;
/** Canonical JSON over catalog values: object key order is immaterial, array order significant. */
const jsonValueEncoder = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any));
const encodeJsonValue = <Value,>(value: Value) => Result.getOrThrow(jsonValueEncoder(value));
const canonicalCatalogJson = <Value,>(value: Value): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCatalogJson).join(',')}]`;
  }
  if (Predicate.isObject(value)) {
    const members = Arr.sort(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
      Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key),
    ).map(([key, entry]) => `${encodeJsonValue(key)}:${canonicalCatalogJson(entry)}`);
    return `{${members.join(',')}}`;
  }
  return encodeJsonValue(value) ?? 'null';
};
export const digest = <Value,>(value: Value): string =>
  createHash('sha256').update(canonicalCatalogJson(value)).digest('hex');
export const bytesDigest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const parametersWithoutBrand = (parameters: NonNullable<CatalogProduct['parameters']>) =>
  parameters.map((parameter) => ({
    label: neutralCatalogText(parameter.label),
    unit: neutralCatalogText(parameter.unit),
    value: neutralCatalogText(parameter.value),
  }));

/**
 * Two imported products repeat a variant SKU (a source defect the owner refuses on any variant update). A later
 * repeat gets a numbered suffix (`…-2`), the only data change besides presentation; ids, prices and stock stay.
 */
export const uniqueVariantSkus = <Variant extends { readonly sku?: string | undefined }>(
  variants: readonly Variant[],
): readonly Variant[] => {
  const taken = new Set(variants.flatMap(({ sku }) => (sku === undefined ? [] : [sku.trim().toLowerCase()])));
  const seen = new Set<string>();
  return variants.map((variant) => {
    if (variant.sku === undefined) {
      return variant;
    }
    const key = variant.sku.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      return variant;
    }
    let suffix = 2;
    while (taken.has(`${key}-${String(suffix)}`)) {
      suffix += 1;
    }
    const sku = `${variant.sku.trim()}-${String(suffix)}`;
    taken.add(sku.toLowerCase());
    seen.add(sku.toLowerCase());
    return { ...variant, sku };
  });
};

/** Only display content changes. Preserve all IDs, prices, histories, SKU, flags, quantities and order. */
export const productTextPatch = (product: CatalogProduct): typeof ProductPatch.Type => {
  const patch: Types.Mutable<typeof ProductPatch.Type> = {
    category: neutralCatalogText(product.category),
    description: neutralCatalogText(product.description ?? ''),
    imageAlt: neutralCatalogText(product.imageAlt ?? ''),
    name: neutralCatalogText(product.name),
    shortDescription: neutralCatalogText(product.shortDescription ?? ''),
  };
  if (product.parameters !== undefined) {
    patch.parameters = parametersWithoutBrand(product.parameters);
  }
  if (product.variants !== undefined) {
    patch.variants = uniqueVariantSkus(product.variants).map((variant) => {
      const next: Types.Mutable<typeof variant> = {
        ...variant,
        attributes: neutralCatalogText(variant.attributes),
        name: neutralCatalogText(variant.name),
      };
      if (variant.parameters !== undefined) {
        next.parameters = parametersWithoutBrand(variant.parameters);
      }
      return next;
    });
  }
  return patch;
};
export const categoryTextPatch = (category: CatalogCategory): typeof CategoryPatch.Type => ({
  description: neutralCatalogText(category.description),
  heading: neutralCatalogText(category.heading),
  imageAlt: neutralCatalogText(category.imageAlt),
  longDescription: neutralCatalogText(category.longDescription),
  name: neutralCatalogText(category.name),
});
const branded = (values: readonly (string | undefined)[]) => values.some((value) => /akros/iu.test(value ?? ''));
const brandedParameters = (parameters: CatalogProduct['parameters']) =>
  (parameters ?? []).some(({ label, unit, value }) => branded([label, unit, value]));
export const variantHasBrand = (variant: NonNullable<CatalogProduct['variants']>[number]) =>
  branded([variant.name, variant.attributes, variant.imageSrc]) || brandedParameters(variant.parameters);
export const textChanges = (product: CatalogProduct) =>
  branded([product.category, product.description, product.imageAlt, product.name, product.shortDescription]) ||
  brandedParameters(product.parameters) ||
  (product.variants ?? []).some(
    (variant) => branded([variant.name, variant.attributes]) || brandedParameters(variant.parameters),
  );
export const catalogHasBrand = (product: CatalogProduct) =>
  textChanges(product) ||
  branded([product.imageSrc, product.slug, ...(product.images ?? [])]) ||
  (product.variants ?? []).some(variantHasBrand);
export const categoryHasBrand = (category: CatalogCategory) =>
  branded([
    category.description,
    category.heading,
    category.imageAlt,
    category.imageSrc,
    category.longDescription,
    category.name,
    category.slug,
  ]);

/**
 * Main/gallery first, then distinct variant photos in variant order; excess use the same item's main photo.
 * Placeholders, marketing artwork and `excluded` (source photos that could not be frozen) are never kept.
 */
export const productPhotoPlan = (product: CatalogProduct, excluded: ReadonlySet<string> = new Set()) => {
  const usable = (image: string) =>
    image !== '' && !isSourcePlaceholder(image) && !isMarketingCatalogImage(image) && !excluded.has(image);
  let gallery = product.images ?? [];
  if (gallery.length === 0 && product.imageSrc !== undefined && product.imageSrc !== '') {
    gallery = [product.imageSrc];
  }
  gallery = gallery.filter(usable);
  const variantImages = (product.variants ?? []).flatMap(({ imageSrc }) =>
    imageSrc !== undefined && usable(imageSrc) ? [imageSrc] : [],
  );
  const all = [...new Set([...gallery, ...variantImages])];
  return { fallback: Math.max(0, all.length - 20), gallery, kept: all.slice(0, 20), total: all.length };
};

/**
 * Category photo source: the first eligible product of the category itself (catalog order), otherwise the first one
 * found in its descendants ordered by category position. Only active, published products are publicly deliverable.
 */
export const categoryRepresentatives = (
  products: readonly CatalogProduct[],
  categories: readonly CatalogCategory[],
  eligible: (product: CatalogProduct) => boolean,
): ReadonlyMap<string, CatalogProduct | undefined> => {
  const own = new Map<string, CatalogProduct>();
  for (const product of products) {
    if (product.categoryId !== undefined && !own.has(product.categoryId) && eligible(product)) {
      own.set(product.categoryId, product);
    }
  }
  const children = new Map<string, CatalogCategory[]>();
  for (const category of Arr.sort(
    categories,
    Order.mapInput(Order.Number, ({ position }: CatalogCategory) => position),
  )) {
    if (category.parentId !== null) {
      children.set(category.parentId, [...(children.get(category.parentId) ?? []), category]);
    }
  }
  const resolved = new Map<string, CatalogProduct | undefined>();
  const pick = (id: string, path: ReadonlySet<string>): CatalogProduct | undefined => {
    if (resolved.has(id)) {
      return resolved.get(id);
    }
    if (path.has(id)) {
      return undefined;
    }
    const next = new Set([...path, id]);
    let found = own.get(id);
    for (const child of children.get(id) ?? []) {
      found ??= pick(child.id, next);
    }
    resolved.set(id, found);
    return found;
  };
  return new Map(categories.map(({ id }) => [id, pick(id, new Set())]));
};

/** Post-apply shape: main = first gallery photo, every variant photo is a gallery photo (or none). */
export const galleryConsistent = (product: CatalogProduct) => {
  const gallery = product.images ?? [];
  return (
    (product.imageSrc ?? '') === (gallery[0] ?? '') &&
    (product.variants ?? []).every(({ imageSrc }) => (imageSrc ?? '') === '' || gallery.includes(imageSrc ?? ''))
  );
};
export const protectedProduct = (product: CatalogProduct) => ({
  active: product.active,
  categoryId: product.categoryId,
  categoryPathIds: product.categoryPathIds,
  currentPriceMinor: product.currentPriceMinor,
  featuredPosition: product.featuredPosition,
  id: product.id,
  lowStockThreshold: product.lowStockThreshold,
  minimumQuantity: product.minimumQuantity,
  packageQuantity: product.packageQuantity,
  priceHistory: product.priceHistory,
  priceTiers: product.priceTiers,
  published: product.published,
  sku: product.sku,
  stockOnHand: product.stockOnHand,
  stockTracked: product.stockTracked,
  unit: product.unit,
  variants:
    product.variants === undefined
      ? undefined
      : uniqueVariantSkus(product.variants).map(
          ({ attributes: _attributes, imageSrc: _image, name: _name, parameters: _parameters, ...variant }) => variant,
        ),
  variantStock: product.variantRecords?.map(({ id, stockOnHand }) => ({ id, stockOnHand })),
  vatRate: product.vatRate,
});
export const displayContent = (product: CatalogProduct) => ({
  category: neutralCatalogText(product.category),
  description: neutralCatalogText(product.description ?? ''),
  imageAlt: neutralCatalogText(product.imageAlt ?? ''),
  name: neutralCatalogText(product.name),
  parameters: product.parameters === undefined ? [] : parametersWithoutBrand(product.parameters),
  shortDescription: neutralCatalogText(product.shortDescription ?? ''),
  variants: product.variants?.map((variant) => ({
    attributes: neutralCatalogText(variant.attributes),
    name: neutralCatalogText(variant.name),
    parameters: variant.parameters === undefined ? [] : parametersWithoutBrand(variant.parameters),
  })),
});

/**
 * The source publishes some photos twice under different names. Identical bytes become one gallery photo: the
 * reference an already-uploaded twin got, if any (an identical upload request would reuse its committed Action key).
 */
export const twinReference = (
  images: readonly { readonly hash: string; readonly source: string }[],
  mapping: ReadonlyMap<string, string>,
  image: { readonly hash: string },
): string | undefined => {
  const twin = images.find((other) => other.hash === image.hash && mapping.has(other.source));
  return twin === undefined ? undefined : mapping.get(twin.source);
};

/** The kept photos in gallery order, each gallery reference once (twins resolve to the same reference). */
export const galleryOrder = (kept: readonly string[], resolve: (image: string) => string): readonly string[] => [
  ...new Set(kept.map(resolve).filter((image) => image !== '')),
];
