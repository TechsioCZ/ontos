import { Schema } from 'effect';
import { AvailabilityEvaluatedDecisionSchema, AvailabilityEvaluationInputSchema } from './availability-decision.ts';
import { AvailabilitySubjectSchema, AvailabilityUseBoundarySchema } from './availability-subject.ts';

const reference = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const instant = AvailabilityUseBoundarySchema.fields.requiredAt;
export const availabilityMaterialOwners = [
  'CATALOG',
  'COMMERCE_PURCHASING_CONTEXT',
  'ASSORTMENT',
  'INVENTORY',
  'AVAILABILITY_POLICY',
] as const;

/** Revisions are provenance; the issuing owner decides whether the represented facts remain usable. */
export const AvailabilityMaterialEvidenceSchema = Schema.Struct({
  businessAt: instant,
  contractRef: reference,
  evidenceRef: reference,
  invalidationConditions: Schema.Array(reference).check(Schema.isMinLength(1)),
  observedAt: instant,
  owner: Schema.Literals(availabilityMaterialOwners),
  sourceRevisionRefs: Schema.Array(reference).check(Schema.isMinLength(1)),
  validFrom: instant,
  validUntil: Schema.optionalKey(instant),
});

/** This response comes only from trusted owner composition, never public payload assertions.
 * COHERENT includes verification of required Inventory set completeness and all material constraints. */
export const AvailabilityOwnerValiditySchema = Schema.Union([
  Schema.TaggedStruct('VALID', {
    coherence: Schema.Literal('OWNER_VERIFIED_COHERENT'),
    evidence: AvailabilityEvaluationInputSchema,
    materialEvidence: Schema.Array(AvailabilityMaterialEvidenceSchema),
    subject: AvailabilitySubjectSchema,
    useBoundary: AvailabilityUseBoundarySchema,
  }),
  Schema.TaggedStruct('INVALID', { reason: reference }),
  Schema.TaggedStruct('UNPROVEN', { reason: reference }),
]);
export type AvailabilityOwnerValidity = typeof AvailabilityOwnerValiditySchema.Type;

export const AvailabilityCurrentDecisionSchema = Schema.Struct({
  currentness: Schema.Literals(['OWNER_VERIFIED_CURRENT', 'INDETERMINATE']),
  currentnessReasons: Schema.Array(reference),
  decision: AvailabilityEvaluatedDecisionSchema,
  evaluatedAt: instant,
  materialEvidence: Schema.Array(AvailabilityMaterialEvidenceSchema),
});
export type AvailabilityCurrentDecision = typeof AvailabilityCurrentDecisionSchema.Type;

export const AvailabilityRevalidationResultSchema = Schema.Struct({
  bundleDisposition: Schema.Literals(['NOT_REPRESENTED', 'UNCHANGED', 'REPLACEMENT_REQUIRED']),
  currentDecision: AvailabilityCurrentDecisionSchema,
  originalDecision: Schema.optionalKey(AvailabilityCurrentDecisionSchema),
});
export type AvailabilityRevalidationResult = typeof AvailabilityRevalidationResultSchema.Type;
