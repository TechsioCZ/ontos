import { Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';
import { ProductRefSchema } from '../resources/product.ts';

const impactTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const affectedOpenSelectionIdSchema = impactTextSchema.pipe(
  Schema.brand('AttributeApplicabilityAffectedOpenSelectionId'),
);

/**
 * Owner-verifiable #429/#479 evidence for changing applicability after the Product or attribute
 * has entered use. The Action rereads Cart's complete population and requires this exact revision
 * and affected selection set before it accepts the remediation evidence.
 */
export const AttributeApplicabilityImpactConfirmationSchema = Schema.Struct({
  affectedOpenSelectionIds: Schema.Array(affectedOpenSelectionIdSchema),
  expectedPopulationRevisionToken: impactTextSchema,
  remediationEvidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
}).check(
  Schema.makeFilter(({ affectedOpenSelectionIds, remediationEvidenceRefs }) => {
    if (new Set(affectedOpenSelectionIds).size !== affectedOpenSelectionIds.length) {
      return 'Affected open selections must be unique';
    }
    if (new Set(remediationEvidenceRefs).size !== remediationEvidenceRefs.length) {
      return 'Remediation evidence references must be unique';
    }
    return true;
  }),
);
export type AttributeApplicabilityImpactConfirmation = typeof AttributeApplicabilityImpactConfirmationSchema.Type;

export const GovernProductAttributeApplicabilityPayloadSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  evidenceRefs: Schema.optionalKey(Schema.Array(ProductEvidenceReferenceSchema)),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the explicit wire token for no existing revision on initial declaration. expires: 2027-03-31.
  expectedRevision: Schema.NullOr(CatalogRevisionNumberSchema),
  impactConfirmation: Schema.optionalKey(AttributeApplicabilityImpactConfirmationSchema),
  productLevel: Schema.Boolean,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  variantLevel: Schema.Boolean,
});
export type GovernProductAttributeApplicabilityPayload = typeof GovernProductAttributeApplicabilityPayloadSchema.Type;

export const GovernProductAttributeApplicabilityResultSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  productLevel: Schema.Boolean,
  productRef: ProductRefSchema,
  revision: CatalogRevisionNumberSchema,
  variantLevel: Schema.Boolean,
});
