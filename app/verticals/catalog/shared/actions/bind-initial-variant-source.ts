import { Schema } from 'effect';
import { CatalogSourceCorrelationSchema } from '../domain/catalog-source-correlation.ts';
import { ProductEvidenceReferenceSchema, ProductUuidSchema } from '../domain/product.ts';

export const BindInitialVariantSourcePayloadSchema = Schema.Struct({
  evidenceRef: ProductEvidenceReferenceSchema,
  expectedCreateInvocationId: ProductUuidSchema,
  initialVariantRecordId: CatalogSourceCorrelationSchema.fields.recordId,
  productSource: CatalogSourceCorrelationSchema,
});
export const BindInitialVariantSourceResultSchema = Schema.Struct({
  originalCreateInvocationId: ProductUuidSchema,
  productId: ProductUuidSchema,
  variantId: ProductUuidSchema,
});
export type BindInitialVariantSourcePayload = typeof BindInitialVariantSourcePayloadSchema.Type;
