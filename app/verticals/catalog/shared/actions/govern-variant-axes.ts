import { Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';
import { ProductRefSchema } from '../resources/product.ts';

const AxisDefinitionSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  definitionRevision: CatalogRevisionNumberSchema,
  expectedAllowanceRevision: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 })),
  ),
});

const AxisChangeClassificationSchema = Schema.Union([
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('AXIS_ADDITION'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('AXIS_REMOVAL'),
    reason: ProductReasonSchema,
  }),
]);

/** A complete replacement, in display order, of a Product's distinguishing roles. */
export const GovernVariantAxesPayloadSchema = Schema.Struct({
  axes: Schema.Array(AxisDefinitionSchema).check(Schema.isMaxLength(32)),
  classification: Schema.optionalKey(AxisChangeClassificationSchema),
  expectedAxisRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 })),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
});
export type GovernVariantAxesPayload = typeof GovernVariantAxesPayloadSchema.Type;

export const GovernVariantAxesResultSchema = Schema.Struct({
  axisRevision: CatalogRevisionNumberSchema,
  changed: Schema.Boolean,
  productRef: ProductRefSchema,
});
