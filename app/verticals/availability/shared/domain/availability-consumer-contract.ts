import { Schema } from 'effect';
import { AvailabilityDecisionOutcomeSchema } from './availability-owner-ports.ts';
import { AvailabilityDecisionReasonSchema } from './availability-decision.ts';
import { AvailabilityMaterialEvidenceSchema } from './availability-currentness.ts';
import { AvailabilityDeliveryBoundarySchema } from './availability-delivery-boundary.ts';
import { AvailabilitySubjectSchema, AvailabilityUseBoundarySchema } from './availability-subject.ts';

const reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
/** Identifiers request owner resolution; no client proof, context scope or timestamp is trusted. */
export const AvailabilityConsumerRequestSchema = Schema.Struct({
  contextResolutionRef: reference,
  previousResultRef: Schema.optionalKey(reference),
  quantity: AvailabilitySubjectSchema.fields.quantity.check(
    Schema.makeFilter((quantity) =>
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(quantity.amount) && /[1-9]/u.test(quantity.amount)
        ? undefined
        : 'Requested quantity must be a positive exact decimal',
    ),
  ),
  representedInBundle: Schema.Boolean,
  requestedUse: AvailabilityUseBoundarySchema.fields.kind,
  selection: AvailabilitySubjectSchema.fields.selection,
});
export type AvailabilityConsumerRequest = typeof AvailabilityConsumerRequestSchema.Type;
const context = AvailabilitySubjectSchema.fields.purchasingContext.fields.contextVerification;
export const AvailabilityConsumerDecisionSchema = Schema.Struct({
  authority: Schema.Literals(['INFORMATIONAL_ONLY', 'CURRENT_EXACT_USE', 'HISTORICAL_ONLY', 'UNPROVEN']),
  currentness: Schema.Literals(['OWNER_VERIFIED_CURRENT', 'INDETERMINATE']),
  deliveryBoundary: AvailabilityDeliveryBoundarySchema,
  evaluatedAt: AvailabilityUseBoundarySchema.fields.requiredAt,
  materialEvidence: Schema.Array(AvailabilityMaterialEvidenceSchema),
  outcome: AvailabilityDecisionOutcomeSchema,
  purchasingContext: Schema.Struct({
    contextRef: context.fields.request.fields.purchasingContext.fields.contextRef,
    contextRevision: context.fields.request.fields.purchasingContext.fields.contextRevision,
    dimensions: AvailabilitySubjectSchema.fields.purchasingContext.fields.dimensions,
    scope: context.fields.evidence.fields.verifiedScope,
    verificationRef: context.fields.evidence.fields.verificationRef,
  }),
  quantity: AvailabilitySubjectSchema.fields.quantity,
  reasons: Schema.Array(AvailabilityDecisionReasonSchema),
  reservationProof: Schema.Literal('NOT_PROVIDED'),
  selection: AvailabilitySubjectSchema.fields.selection,
  useBoundary: AvailabilityUseBoundarySchema,
});
export const AvailabilityConsumerResponseSchema = Schema.Struct({
  bundleDisposition: Schema.Literals(['NOT_REPRESENTED', 'UNCHANGED', 'REPLACEMENT_REQUIRED']),
  currentDecision: AvailabilityConsumerDecisionSchema,
  originalDecision: Schema.optional(AvailabilityConsumerDecisionSchema),
});
export type AvailabilityConsumerResponse = typeof AvailabilityConsumerResponseSchema.Type;
