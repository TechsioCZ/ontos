import { Schema } from 'effect'; // oxlint-disable-line eslint/max-classes-per-file -- Product domain failures share one exported error vocabulary so Actions and Reads expose a single closed contract. expires: 2027-03-31.

import { ProductRefSchema } from '../resources/product.ts';

export class ProductNotFound extends Schema.TaggedError<ProductNotFound>()('ProductNotFound', {
  code: Schema.Literal('product_not_found'),
  productRef: ProductRefSchema,
  reason: Schema.String,
}) {}

export class ProductRevisionConflict extends Schema.TaggedError<ProductRevisionConflict>()('ProductRevisionConflict', {
  actualRevision: Schema.Finite,
  code: Schema.Literal('product_revision_conflict'),
  expectedRevision: Schema.Finite,
  productRef: ProductRefSchema,
  reason: Schema.String,
}) {}

export class ProductLifecycleConflict extends Schema.TaggedError<ProductLifecycleConflict>()(
  'ProductLifecycleConflict',
  {
    code: Schema.Literal('product_lifecycle_conflict'),
    productRef: ProductRefSchema,
    reason: Schema.String,
  },
) {}

export class ProductNotCatalogReady extends Schema.TaggedError<ProductNotCatalogReady>()('ProductNotCatalogReady', {
  code: Schema.Literal('product_not_catalog_ready'),
  productRef: ProductRefSchema,
  reason: Schema.String,
  reasons: Schema.Array(Schema.String),
}) {}

export class ProductCorrectionRequired extends Schema.TaggedError<ProductCorrectionRequired>()(
  'ProductCorrectionRequired',
  {
    code: Schema.Literal('product_correction_required'),
    productRef: ProductRefSchema,
    reason: Schema.String,
  },
) {}

export class ProductPersistenceConflict extends Schema.TaggedError<ProductPersistenceConflict>()(
  'ProductPersistenceConflict',
  {
    code: Schema.Literal('product_persistence_conflict'),
    conflict: Schema.Literals(['PRODUCT_ID', 'VARIANT_ID', 'ACTION_INVOCATION_ID', 'REVISION']),
    reason: Schema.String,
  },
) {}
