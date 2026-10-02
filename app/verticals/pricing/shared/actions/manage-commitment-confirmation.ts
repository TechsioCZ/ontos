import { PricingCommitmentConfirmationBindingSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { Schema } from 'effect';

export const ManageCommitmentConfirmationReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

const PayloadVersionSchema = Schema.Literal('1');
const CommandReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

export const ManageCommitmentConfirmationCurrentIssuancePayloadSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  kind: Schema.Literal('ISSUE_CURRENT_BACKED_CONFIRMATION'),
  reason: ManageCommitmentConfirmationReasonSchema,
  schemaVersion: PayloadVersionSchema,
});

export const ManageCommitmentConfirmationQuotationIssuancePayloadSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  kind: Schema.Literal('ISSUE_QUOTATION_BACKED_CONFIRMATION'),
  quotationRef: CommandReferenceSchema,
  reason: ManageCommitmentConfirmationReasonSchema,
  schemaVersion: PayloadVersionSchema,
});

export const ManageCommitmentConfirmationVerificationPayloadSchema = Schema.Struct({
  confirmationRef: CommandReferenceSchema,
  kind: Schema.Literal('VERIFY_COMMITMENT_CONFIRMATION'),
  reason: ManageCommitmentConfirmationReasonSchema,
  requestedBinding: PricingCommitmentConfirmationBindingSchema,
  schemaVersion: PayloadVersionSchema,
});

export const ManageCommitmentConfirmationRenewalPayloadSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  confirmationRef: CommandReferenceSchema,
  kind: Schema.Literal('RENEW_COMMITMENT_CONFIRMATION'),
  reason: ManageCommitmentConfirmationReasonSchema,
  schemaVersion: PayloadVersionSchema,
});

export const ManageCommitmentConfirmationPayloadSchema = Schema.Union([
  ManageCommitmentConfirmationCurrentIssuancePayloadSchema,
  ManageCommitmentConfirmationQuotationIssuancePayloadSchema,
  ManageCommitmentConfirmationVerificationPayloadSchema,
  ManageCommitmentConfirmationRenewalPayloadSchema,
]);
export type ManageCommitmentConfirmationPayload = typeof ManageCommitmentConfirmationPayloadSchema.Type;

const ActionOutcomeReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const ActionConfirmedOutcomeSchema = (tag: 'ISSUED' | 'VERIFIED') =>
  Schema.TaggedStruct(tag, { confirmationRef: CommandReferenceSchema });
const ActionTemporalOutcomeSchema = (tag: 'EXPIRED' | 'NOT_YET_VALID') =>
  Schema.TaggedStruct(tag, { confirmationRef: CommandReferenceSchema });
const ActionReasonedOutcomeSchema = <Tag extends string>(tag: Tag, retryable: boolean) =>
  Schema.TaggedStruct(tag, {
    reason: ActionOutcomeReasonSchema,
    retryable: Schema.Literal(retryable),
  });
const ActionConfirmationReasonedOutcomeSchema = <Tag extends string>(tag: Tag, retryable: boolean) =>
  Schema.TaggedStruct(tag, {
    confirmationRef: CommandReferenceSchema,
    reason: ActionOutcomeReasonSchema,
    retryable: Schema.Literal(retryable),
  });
const ActionBindingMismatchOutcomeSchema = Schema.TaggedStruct('BINDING_MISMATCH', {
  confirmationRef: Schema.optionalKey(CommandReferenceSchema),
  reason: ActionOutcomeReasonSchema,
  retryable: Schema.Literal(false),
});

export const ManageCommitmentConfirmationIssuanceActionOutcomeSchema = Schema.Union([
  ActionConfirmedOutcomeSchema('ISSUED'),
  ActionBindingMismatchOutcomeSchema,
  ActionReasonedOutcomeSchema('SOURCE_INVALID', false),
  Schema.TaggedStruct('SOURCE_UNVERIFIABLE', {
    reason: ActionOutcomeReasonSchema,
    retryable: Schema.Boolean,
  }),
]);

export const ManageCommitmentConfirmationRenewalActionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('RENEWED', {
    confirmationRef: CommandReferenceSchema,
    previousConfirmationRef: CommandReferenceSchema,
  }),
  ActionReasonedOutcomeSchema('REPLACEMENT_BUNDLE_REQUIRED', false),
  ActionBindingMismatchOutcomeSchema,
  ActionReasonedOutcomeSchema('SOURCE_INVALID', false),
  Schema.TaggedStruct('SOURCE_UNVERIFIABLE', {
    reason: ActionOutcomeReasonSchema,
    retryable: Schema.Boolean,
  }),
]);

export const ManageCommitmentConfirmationVerificationActionOutcomeSchema = Schema.Union([
  ActionConfirmedOutcomeSchema('VERIFIED'),
  ActionTemporalOutcomeSchema('EXPIRED'),
  ActionTemporalOutcomeSchema('NOT_YET_VALID'),
  ActionConfirmationReasonedOutcomeSchema('AUTHENTICITY_INVALID', false),
  Schema.TaggedStruct('AUTHENTICITY_UNVERIFIABLE', {
    confirmationRef: CommandReferenceSchema,
    reason: ActionOutcomeReasonSchema,
    retryable: Schema.Boolean,
  }),
  ActionBindingMismatchOutcomeSchema,
  ActionConfirmationReasonedOutcomeSchema('BINDING_UNVERIFIABLE', true),
  ActionConfirmationReasonedOutcomeSchema('VALIDITY_UNVERIFIABLE', true),
]);

export const ManageCommitmentConfirmationResultSchema = Schema.Union([
  Schema.Struct({
    kind: ManageCommitmentConfirmationCurrentIssuancePayloadSchema.fields.kind,
    outcome: ManageCommitmentConfirmationIssuanceActionOutcomeSchema,
  }),
  Schema.Struct({
    kind: ManageCommitmentConfirmationQuotationIssuancePayloadSchema.fields.kind,
    outcome: ManageCommitmentConfirmationIssuanceActionOutcomeSchema,
  }),
  Schema.Struct({
    kind: ManageCommitmentConfirmationVerificationPayloadSchema.fields.kind,
    outcome: ManageCommitmentConfirmationVerificationActionOutcomeSchema,
  }),
  Schema.Struct({
    kind: ManageCommitmentConfirmationRenewalPayloadSchema.fields.kind,
    outcome: ManageCommitmentConfirmationRenewalActionOutcomeSchema,
  }),
]);
export type ManageCommitmentConfirmationResult = typeof ManageCommitmentConfirmationResultSchema.Type;
