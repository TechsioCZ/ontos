import { Effect, Schema } from 'effect';

import { AttributeValueSchema } from '../domain/attribute-values.ts';
import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import { VariantAttributeChangeConflict } from './variant-attribute-change-conflict.ts';

export { VariantAttributeChangeConflict } from './variant-attribute-change-conflict.ts';

// oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the explicit optimistic-create marker, distinct from an omitted revision. expires: 2027-03-31.
const revision = Schema.NullOr(CatalogRevisionNumberSchema);
const evidenceRefs = Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed())));
const conversion = Schema.Struct({
  denominator: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  from: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
  numerator: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  quantity: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
  to: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
});

/** A changed Product attribute may correct the record, but cannot silently replace an atomic realization. */
export const ProductAttributeChangeClassificationSchema = Schema.Union([
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('EVIDENCED_CORRECTION'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('NEW_REALIZATION'),
    newVariantRef: VariantRefSchema,
    previousVariantRef: VariantRefSchema,
    reason: ProductReasonSchema,
  }),
]);
export type ProductAttributeChangeClassification = typeof ProductAttributeChangeClassificationSchema.Type;

/** Classify the change in the selected Variant's meaning, not by the attribute's name. */
export const VariantAttributeChangeClassificationSchema = Schema.Union([
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('NON_MATERIAL'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('EVIDENCED_CORRECTION'),
    originalDataErrorEvidenceRef: ProductEvidenceReferenceSchema,
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('NEW_REALIZATION'),
    newVariantRef: VariantRefSchema,
    reason: ProductReasonSchema,
  }),
]);
export type VariantAttributeChangeClassification = typeof VariantAttributeChangeClassificationSchema.Type;

export const requireVariantAttributeChange = (
  classification: VariantAttributeChangeClassification,
): Effect.Effect<'NON_MATERIAL' | 'REVALIDATION_REQUIRED', VariantAttributeChangeConflict> => {
  if (classification.kind === 'NEW_REALIZATION') {
    return Effect.fail(
      new VariantAttributeChangeConflict({
        code: 'variant_attribute_change_conflict',
        reason: 'A new atomic realization requires a distinct Variant identity, not an in-place override',
      }),
    );
  }
  if (
    classification.kind === 'EVIDENCED_CORRECTION' &&
    !classification.evidenceRefs.includes(classification.originalDataErrorEvidenceRef)
  ) {
    return Effect.fail(
      new VariantAttributeChangeConflict({
        code: 'variant_attribute_change_conflict',
        reason: 'Correction evidence must identify the original data error',
      }),
    );
  }
  return Effect.succeed(classification.kind === 'NON_MATERIAL' ? 'NON_MATERIAL' : 'REVALIDATION_REQUIRED');
};

export class ProductAttributeChangeConflict extends Schema.TaggedError<ProductAttributeChangeConflict>()(
  'ProductAttributeChangeConflict',
  { code: Schema.Literal('product_attribute_change_conflict'), reason: Schema.String },
) {}

/** #479 must re-evaluate Current selections even when correction preserves the Product ResourceRef. */
export const requireProductAttributeCorrection = (
  classification: ProductAttributeChangeClassification,
  productRef: typeof ProductRefSchema.Type,
): Effect.Effect<
  { readonly kind: 'REVALIDATION_REQUIRED'; readonly productRef: typeof ProductRefSchema.Type },
  ProductAttributeChangeConflict
> => {
  if (classification.kind === 'NEW_REALIZATION') {
    return Effect.fail(
      new ProductAttributeChangeConflict({
        code: 'product_attribute_change_conflict',
        reason:
          'A new atomic realization requires a distinct Variant or Product identity, not an in-place Product attribute write',
      }),
    );
  }
  return Effect.succeed({ kind: 'REVALIDATION_REQUIRED', productRef });
};
const base = {
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  evidenceRefs,
  expectedRevision: revision,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
};
const values = Schema.Array(AttributeValueSchema).check(Schema.isNonEmpty());
const productFields = { ...base, classification: ProductAttributeChangeClassificationSchema };
const setFields = { ...base, conversions: Schema.optionalKey(Schema.Array(conversion)), values };
const variantFields = { ...base, variantRef: VariantRefSchema };

export const SetProductAttributeValuesPayloadSchema = Schema.Struct({
  ...setFields,
  classification: ProductAttributeChangeClassificationSchema,
});
export type SetProductAttributeValuesPayload = typeof SetProductAttributeValuesPayloadSchema.Type;
export const RemoveProductAttributeValuesPayloadSchema = Schema.Struct(productFields);
export type RemoveProductAttributeValuesPayload = typeof RemoveProductAttributeValuesPayloadSchema.Type;
export const SetVariantAttributeOverridePayloadSchema = Schema.Struct({
  ...setFields,
  classification: VariantAttributeChangeClassificationSchema,
  variantRef: VariantRefSchema,
});
export type SetVariantAttributeOverridePayload = typeof SetVariantAttributeOverridePayloadSchema.Type;
export const RemoveVariantAttributeOverridePayloadSchema = Schema.Struct({
  ...variantFields,
  classification: VariantAttributeChangeClassificationSchema,
  expectedProductValueRevision: revision,
});
export type RemoveVariantAttributeOverridePayload = typeof RemoveVariantAttributeOverridePayloadSchema.Type;

const result = Schema.Struct({
  attributeValueSetId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('CatalogAttributeValueSetId'),
    Schema.decodeTo(Schema.String.check(Schema.isUUID())),
  ),
  revision: CatalogRevisionNumberSchema,
  state: Schema.Literals(['SET', 'REMOVED']),
});
export const SetProductAttributeValuesResultSchema = result;
export const RemoveProductAttributeValuesResultSchema = result;
export const SetVariantAttributeOverrideResultSchema = result;
export const RemoveVariantAttributeOverrideResultSchema = result;
