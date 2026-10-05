import { StockPositionRefSchema } from '@app/inventory/resources/stock-position';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import { AvailabilityDeliveryBoundarySchema } from './availability-delivery-boundary.ts';
import { AvailabilityLaunchPromisePolicySchema } from './availability-promise-policy.ts';
import { AvailabilityDecisionOutcomeSchema } from './availability-owner-ports.ts';
import { AvailabilityStockInputSchema } from './availability-source-authority.ts';
import { AvailabilitySubjectSchema, AvailabilityUseBoundarySchema } from './availability-subject.ts';

const reference = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const reusableQuantity = Schema.Struct({
  amount: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u)),
  unitRef: AvailabilitySubjectSchema.fields.quantity.fields.unitRef,
});

/** RESOLVED proves reusable quantity accounts for obligations, Source Coverage, sharing and exact constraints.
 * Verified owner qualification is supplied by trusted composition, never by a purchase request. */
export const AvailabilityOwnerQualificationSchema = Schema.Struct({
  currentness: Schema.Literals(['CURRENT', 'STALE', 'INDETERMINATE']),
  positions: Schema.Array(
    Schema.Struct({
      constraintSupport: Schema.Literals(['RESOLVED', 'INDEPENDENTLY_PROVEN', 'INDETERMINATE']),
      positionRef: StockPositionRefSchema,
      reusableQuantity: Schema.Union([
        Schema.TaggedStruct('PROVEN', { quantity: reusableQuantity }),
        Schema.TaggedStruct('UNPROVEN', {}),
      ]),
      uncertaintyReasons: Schema.optionalKey(
        Schema.Array(Schema.Literals(['CONFLICT', 'SOURCE_COVERAGE_UNCERTAIN', 'UNRESOLVED_RESERVATION_EFFECT'])),
      ),
      usability: Schema.Literals(['USABLE', 'UNUSABLE', 'INDETERMINATE']),
    }),
  ),
  set: Schema.Union([
    Schema.TaggedStruct('COMPLETE', {
      evidence: OwnerVerifiableSetCompletenessEvidenceSchema,
      predicateRef: reference,
    }),
    Schema.TaggedStruct('UNPROVEN', {}),
  ]),
  stockInput: AvailabilityStockInputSchema,
  subject: AvailabilitySubjectSchema,
  useBoundary: AvailabilityUseBoundarySchema,
});
export type AvailabilityOwnerQualification = typeof AvailabilityOwnerQualificationSchema.Type;

export const AvailabilityEvaluationInputSchema = Schema.Struct({
  ownerQualification: AvailabilityOwnerQualificationSchema,
  policy: AvailabilityLaunchPromisePolicySchema,
  stockInput: AvailabilityStockInputSchema,
  subject: AvailabilitySubjectSchema,
  useBoundary: AvailabilityUseBoundarySchema,
});
export type AvailabilityEvaluationInput = typeof AvailabilityEvaluationInputSchema.Type;

export const AvailabilityDecisionReasonSchema = Schema.Literals([
  'WHOLE_REQUEST_SUPPORTED',
  'INSUFFICIENT_REUSABLE_QUANTITY',
  'INDEPENDENT_SUPPORT_INSUFFICIENT',
  'CURRENT_ZERO',
  'COMPLETE_EMPTY_SET',
  'OWNER_QUALIFICATION_MISMATCH',
  'SET_COMPLETENESS_UNPROVEN',
  'SET_SCOPE_MISMATCH',
  'STALE',
  'INDETERMINATE',
  'UNKNOWN',
  'MISSING',
  'CONFLICT',
  'SOURCE_UNAVAILABLE',
  'SOURCE_COVERAGE_UNCERTAIN',
  'UNRESOLVED_RESERVATION_EFFECT',
  'REUSABLE_QUANTITY_UNPROVEN',
  'POSITION_USABILITY_UNCERTAIN',
  'DUPLICATE_POSITION',
  'POSITION_SCOPE_MISMATCH',
  'POLICY_DENIED',
  'POLICY_INDETERMINATE',
]);
export type AvailabilityDecisionReason = typeof AvailabilityDecisionReasonSchema.Type;

export const AvailabilityEvaluatedDecisionSchema = Schema.Struct({
  deliveryBoundary: AvailabilityDeliveryBoundarySchema,
  evidence: AvailabilityEvaluationInputSchema,
  outcome: AvailabilityDecisionOutcomeSchema,
  reasons: Schema.Array(AvailabilityDecisionReasonSchema),
  subject: AvailabilitySubjectSchema,
  useBoundary: AvailabilityUseBoundarySchema,
});
export type AvailabilityEvaluatedDecision = typeof AvailabilityEvaluatedDecisionSchema.Type;

export class AvailabilityEvaluationInputRejected extends Schema.TaggedError<AvailabilityEvaluationInputRejected>()(
  'AvailabilityEvaluationInputRejected',
  { cause: Schema.Defect() },
) {}
