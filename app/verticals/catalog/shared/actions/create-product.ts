import { Schema } from 'effect';

import {
  ProductDescriptionSchema,
  ProductNameSchema,
  ProductReasonSchema,
  ProductSchema,
  ProductUuidSchema,
} from '../domain/product.ts';
import {
  CompletedProductCreationClassificationSchema,
  IndependentProductCreationSchema,
  NewProductCreationClassificationSchema,
} from '../domain/product-change-classification.ts';

const createProductFields = {
  description: Schema.optionalKey(ProductDescriptionSchema),
  name: Schema.optionalKey(ProductNameSchema),
  variantId: Schema.optionalKey(ProductUuidSchema),
};
export const CreateProductPayloadSchema = Schema.Union([
  Schema.Struct({
    ...createProductFields,
    classification: Schema.optionalKey(
      Schema.Struct({
        ...IndependentProductCreationSchema.fields,
        affectsOpenSelection: Schema.optionalKey(Schema.Never),
        evidenceRefs: Schema.optionalKey(Schema.Never),
        previousProductRef: Schema.optionalKey(Schema.Never),
        reason: Schema.optionalKey(Schema.Never),
      }),
    ),
    reason: Schema.optionalKey(ProductReasonSchema),
  }),
  Schema.Struct({
    ...createProductFields,
    classification: NewProductCreationClassificationSchema.annotate({ parseOptions: { onExcessProperty: 'error' } }),
    reason: ProductReasonSchema,
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CreateProductPayload = typeof CreateProductPayloadSchema.Type;

export const CreateProductResultSchema = Schema.Struct({
  classification: Schema.optionalKey(CompletedProductCreationClassificationSchema),
  product: ProductSchema,
  variantId: ProductUuidSchema,
});
export type CreateProductResult = typeof CreateProductResultSchema.Type;
