import { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { ProductSchema, ProductUuidSchema } from '@app/catalog/domain/product';
import type { Product } from '@app/catalog/domain/product';
import { Schema, Struct } from 'effect';

import type { SymmyProductFieldName } from './contract.ts';
import { SymmyInternalProductsProjectionSchema, SymmyQualifiedReadIdSchema } from './read-projection-contracts.ts';
import type { SymmyInternalProductsProjection } from './read-projection-contracts.ts';

const productFields = ProductSchema.fields;
const itemFields = {
  id: SymmyQualifiedReadIdSchema,
  product: ProductSchema,
  sourceRecordId: CatalogSourceCorrelationSchema.fields.recordId,
  variantSources: Schema.Array(
    Schema.Struct({
      id: SymmyQualifiedReadIdSchema,
      sourceRecordId: CatalogSourceCorrelationSchema.fields.recordId,
      variantId: ProductUuidSchema,
    }),
  ),
};
const envelope = {
  count: SymmyInternalProductsProjectionSchema.fields.count,
  limit: SymmyInternalProductsProjectionSchema.fields.limit,
  offset: SymmyInternalProductsProjectionSchema.fields.offset,
};

/** The public body of `GET /admin/products`: camelCase, no internal markers and no nullable field. */
export const SymmyProductsResponseSchema = Schema.Struct({
  ...envelope,
  products: Schema.Array(Schema.Struct(itemFields)),
});
type SymmyProductsResponse = typeof SymmyProductsResponseSchema.Type;

/** The body with `fields`: every item key except `id` is optional. The full body is validated first. */
export const SymmyProductsSelectedResponseSchema = Schema.Struct({
  ...envelope,
  products: Schema.Array(
    Schema.Struct({
      id: itemFields.id,
      product: Schema.optionalKey(
        Schema.Struct({
          catalogReady: Schema.optionalKey(productFields.catalogReady),
          createdAt: Schema.optionalKey(productFields.createdAt),
          description: Schema.optionalKey(productFields.description),
          lifecycle: Schema.optionalKey(productFields.lifecycle),
          name: Schema.optionalKey(productFields.name),
          productRef: Schema.optionalKey(productFields.productRef),
          revision: Schema.optionalKey(productFields.revision),
          updatedAt: Schema.optionalKey(productFields.updatedAt),
          variants: Schema.optionalKey(productFields.variants),
        }),
      ),
      sourceRecordId: Schema.optionalKey(itemFields.sourceRecordId),
      variantSources: Schema.optionalKey(itemFields.variantSources),
    }),
  ),
});
type SymmyProductsSelectedResponse = typeof SymmyProductsSelectedResponseSchema.Type;

export const SymmyProductsSuccessSchema = Schema.Union([
  SymmyProductsResponseSchema,
  SymmyProductsSelectedResponseSchema,
]);

/** `unsupported_fields` is still computed by the projection and is deliberately not exposed. */
export const mapSymmyProductsProjection = (projection: SymmyInternalProductsProjection): SymmyProductsResponse => ({
  count: projection.count,
  limit: projection.limit,
  offset: projection.offset,
  products: projection.products.map((item) => ({
    id: item.id,
    product: item.product,
    sourceRecordId: item.source_record_id,
    variantSources: item.variantSources.map((variant) => ({
      id: variant.id,
      sourceRecordId: variant.source_record_id,
      variantId: variant.variantId,
    })),
  })),
});

const productKeys = [
  'catalogReady',
  'createdAt',
  'description',
  'lifecycle',
  'name',
  'productRef',
  'revision',
  'updatedAt',
  'variants',
] as const;
const itemKeys = ['sourceRecordId', 'variantSources'] as const;
/** `product` returns the whole object; otherwise only the named `product.*` keys that the product has. */
const selectProduct = (product: Product, names: ReadonlySet<SymmyProductFieldName>) => {
  if (names.has('product')) {
    return product;
  }
  const named = productKeys.filter((key) => names.has(`product.${key}`));
  return named.length === 0
    ? undefined
    : Struct.pick(
        product,
        named.filter((key) => key in product),
      );
};

/** Keeps `id` and the named paths. A repeated name, or a path under a named parent, has no further effect. */
export const selectSymmyProductFields = (
  body: SymmyProductsResponse,
  fields: readonly SymmyProductFieldName[],
): SymmyProductsSelectedResponse => {
  const names = new Set(fields);
  return {
    count: body.count,
    limit: body.limit,
    offset: body.offset,
    products: body.products.map((item) => {
      const base = Struct.pick(item, ['id', ...itemKeys.filter((key) => names.has(key))]);
      const product = selectProduct(item.product, names);
      return product === undefined ? base : { ...base, product };
    }),
  };
};
