import {
  ExpectedQuantityTierCurrentSchema,
  QuantityTierDefinitionSchema,
  QuantityTierEffectivePeriodSchema,
  QuantityTierIdentityKeySchema,
  QuantityTierResultingUnitPriceSchema,
  QuantityTierRevisionIdSchema,
  QuantityTierScheduleAcknowledgementSchema,
  QuantityTierScheduleRevisionSchema,
  QuantityTierScheduleSnapshotSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';

export const ManageQuantityTierReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

const target = {
  identityKey: QuantityTierIdentityKeySchema,
  reason: ManageQuantityTierReasonSchema,
};

const valuedTarget = {
  ...target,
  resultingUnitPrice: QuantityTierResultingUnitPriceSchema,
};

export const ManageQuantityTierPayloadSchema = Schema.Union([
  Schema.Struct({
    ...valuedTarget,
    effectivePeriod: QuantityTierEffectivePeriodSchema,
    expectedState: Schema.Struct({ state: Schema.Literal('ABSENT') }),
    intent: Schema.Literal('DEFINE'),
  }),
  Schema.Struct({
    ...valuedTarget,
    acknowledgement: Schema.optionalKey(QuantityTierScheduleAcknowledgementSchema),
    effectiveFrom: PricingInstantSchema,
    expectedCurrent: ExpectedQuantityTierCurrentSchema,
    intent: Schema.Literal('VALUE_ONLY_CURRENT'),
  }),
  Schema.Struct({
    ...valuedTarget,
    effectivePeriod: QuantityTierEffectivePeriodSchema,
    expectedScheduleRevision: QuantityTierScheduleRevisionSchema,
    intent: Schema.Literal('SCHEDULE_REVISION'),
  }),
  Schema.Struct({
    ...target,
    acknowledgement: Schema.optionalKey(QuantityTierScheduleAcknowledgementSchema),
    effectiveTo: PricingInstantSchema,
    expectedCurrent: ExpectedQuantityTierCurrentSchema,
    intent: Schema.Literal('RETIRE_CURRENT'),
  }),
  Schema.Struct({
    ...valuedTarget,
    expectedScheduleRevision: QuantityTierScheduleRevisionSchema,
    intent: Schema.Literal('CORRECT_REVISION'),
    targetEffectivePeriod: QuantityTierEffectivePeriodSchema,
    targetRevisionId: QuantityTierRevisionIdSchema,
  }),
]);
export type ManageQuantityTierPayload = typeof ManageQuantityTierPayloadSchema.Type;

export const ManageQuantityTierResultSchema = Schema.Union([
  Schema.Struct({
    definition: QuantityTierDefinitionSchema,
    outcome: Schema.Literals(['QUANTITY_TIER_CREATED', 'QUANTITY_TIER_REUSED']),
  }),
  Schema.Struct({
    outcome: Schema.Literals(['QUANTITY_TIER_REVISED', 'QUANTITY_TIER_UNCHANGED']),
    schedule: QuantityTierScheduleSnapshotSchema,
  }),
]);
export type ManageQuantityTierResult = typeof ManageQuantityTierResultSchema.Type;

export const RecoverableManageQuantityTierOutcomeSchema = Schema.Union([
  ManageQuantityTierResultSchema,
  Schema.Struct({
    acknowledgement: QuantityTierScheduleAcknowledgementSchema,
    outcome: Schema.Literal('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED'),
  }),
]);
export const QuantityTierActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('QuantityTierActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

export const QuantityTierActionResultLookupOutcomeSchema = Schema.Union([
  Schema.Struct({
    actionInvocationId: QuantityTierActionInvocationIdSchema,
    outcome: Schema.Literal('QUANTITY_TIER_RESULT_FOUND'),
    result: RecoverableManageQuantityTierOutcomeSchema,
  }),
  Schema.Struct({
    actionInvocationId: QuantityTierActionInvocationIdSchema,
    outcome: Schema.Literal('QUANTITY_TIER_RESULT_ABSENT'),
  }),
]);
export type QuantityTierActionResultLookupOutcome = typeof QuantityTierActionResultLookupOutcomeSchema.Type;
