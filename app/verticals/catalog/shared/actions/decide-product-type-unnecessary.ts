import { Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductRevisionSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';

const NonnegativeRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 }),
);
const DecisionStateSchema = Schema.Literals(['CONFIRMED', 'REVOKED']);

/** A decision records explicit owner intent against an exact Current inventory, not Catalog readiness. */
export const DecideProductTypeUnnecessaryPayloadSchema = Schema.Struct({
  decisionState: DecisionStateSchema,
  evidenceRefs: Schema.Array(ProductEvidenceReferenceSchema).check(Schema.isMinLength(1)),
  expectedAxisRevision: NonnegativeRevisionSchema,
  expectedDecisionRevision: NonnegativeRevisionSchema,
  expectedProductRevision: ProductRevisionSchema,
  expectedValueRevisionTokens: Schema.Array(Schema.String),
  expectedVariantRevisionTokens: Schema.Array(Schema.String),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  structuredAttributesRequired: Schema.Literal(false),
  variantAxesRequired: Schema.Literal(false),
});
export type DecideProductTypeUnnecessaryPayload = typeof DecideProductTypeUnnecessaryPayloadSchema.Type;

export const DecideProductTypeUnnecessaryResultSchema = Schema.Struct({
  decisionRevision: ProductRevisionSchema,
  decisionState: DecisionStateSchema,
  productRef: ProductRefSchema,
});
export type DecideProductTypeUnnecessaryResult = typeof DecideProductTypeUnnecessaryResultSchema.Type;
