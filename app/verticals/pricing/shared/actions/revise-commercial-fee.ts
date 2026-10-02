import {
  ExpectedPricingCommercialFeeCurrentSchema,
  PricingCommercialFeeCatalogTargetEvidenceSchema,
  PricingCommercialFeeConfiguredAmountSchema,
  PricingCommercialFeeEffectivePeriodSchema,
  PricingCommercialFeeIdentityKeySchema,
  PricingCommercialFeeRevisionIdSchema,
  PricingCommercialFeeScheduleAcknowledgementSchema,
  PricingCommercialFeeScheduleSnapshotSchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';

export const ReviseCommercialFeeReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

const ReviseCommercialFeeValueOnlyCurrentPayloadSchema = Schema.Struct({
  acknowledgement: Schema.optionalKey(PricingCommercialFeeScheduleAcknowledgementSchema),
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  configuredAmount: PricingCommercialFeeConfiguredAmountSchema,
  effectiveFrom: PricingInstantSchema,
  expectedCurrent: ExpectedPricingCommercialFeeCurrentSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  intent: Schema.Literal('VALUE_ONLY_CURRENT'),
  reason: ReviseCommercialFeeReasonSchema,
});

const ReviseCommercialFeeScheduleRevisionPayloadSchema = Schema.Struct({
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  configuredAmount: PricingCommercialFeeConfiguredAmountSchema,
  effectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  expectedScheduleRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  identityKey: PricingCommercialFeeIdentityKeySchema,
  intent: Schema.Literal('SCHEDULE_REVISION'),
  reason: ReviseCommercialFeeReasonSchema,
});

const ReviseCommercialFeeCorrectRevisionPayloadSchema = Schema.Struct({
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  configuredAmount: PricingCommercialFeeConfiguredAmountSchema,
  expectedScheduleRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  identityKey: PricingCommercialFeeIdentityKeySchema,
  intent: Schema.Literal('CORRECT_REVISION'),
  reason: ReviseCommercialFeeReasonSchema,
  targetEffectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  targetRevisionId: PricingCommercialFeeRevisionIdSchema,
});

const ReviseCommercialFeeRetireCurrentPayloadSchema = Schema.Struct({
  acknowledgement: Schema.optionalKey(PricingCommercialFeeScheduleAcknowledgementSchema),
  effectiveTo: PricingInstantSchema,
  expectedCurrent: ExpectedPricingCommercialFeeCurrentSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  intent: Schema.Literal('RETIRE_CURRENT'),
  reason: ReviseCommercialFeeReasonSchema,
});

export const ReviseCommercialFeePayloadSchema = Schema.Union([
  ReviseCommercialFeeCorrectRevisionPayloadSchema,
  ReviseCommercialFeeRetireCurrentPayloadSchema,
  ReviseCommercialFeeScheduleRevisionPayloadSchema,
  ReviseCommercialFeeValueOnlyCurrentPayloadSchema,
]);
export type ReviseCommercialFeePayload = typeof ReviseCommercialFeePayloadSchema.Type;

export const ReviseCommercialFeeResultSchema = Schema.Struct({
  outcome: Schema.Literals(['COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED']),
  schedule: PricingCommercialFeeScheduleSnapshotSchema,
});
export type ReviseCommercialFeeResult = typeof ReviseCommercialFeeResultSchema.Type;
