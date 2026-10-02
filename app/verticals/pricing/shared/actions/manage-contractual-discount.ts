import {
  ExpectedPricingDiscountCurrentSchema,
  PricingDiscountEffectivePeriodSchema,
  PricingDiscountEffectSchema,
  PricingDiscountIdentityKeySchema,
  PricingDiscountRevisionIdSchema,
  PricingDiscountScheduleRevisionSchema,
} from '@app/pricing-contracts/domain/discount';
import {
  PricingContractualDiscountScheduleAcknowledgementSchema,
  PricingContractualDiscountScheduleSnapshotSchema,
} from '@app/pricing-contracts';
import { Schema } from 'effect';

export const ManageContractualDiscountReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

const ContractualDiscountIdentityKeySchema = PricingDiscountIdentityKeySchema.check(
  Schema.makeFilter(({ audience, family, scope }) => {
    if (family !== 'CONTRACTUAL_DISCOUNT') {
      return 'Management accepts only manual CONTRACTUAL_DISCOUNT facts';
    }
    if (audience.kind === 'CATALOG_PATH') {
      return 'Catalog Discount management is outside the contractual Discount Action';
    }
    return scope === 'WHOLE_PURCHASE' && audience.kind !== 'COUNTERPARTY'
      ? 'Whole-purchase contractual Discount requires an exact Counterparty audience'
      : undefined;
  }),
);

const configuredEffectMatchesIdentity = Schema.makeFilter(
  ({
    configuredEffect,
    identityKey,
  }: {
    readonly configuredEffect: typeof PricingDiscountEffectSchema.Type;
    readonly identityKey: typeof PricingDiscountIdentityKeySchema.Type;
  }) => {
    if (configuredEffect.kind !== identityKey.effectKind) {
      return 'Configured effect kind must preserve the exact logical Discount identity';
    }
    return configuredEffect.kind === 'FIXED_MONETARY_AMOUNT' &&
      configuredEffect.level.currencyCode !== identityKey.currencyCode
      ? 'Fixed contractual Discount must preserve the exact logical currency'
      : undefined;
  },
);

const targetFields = {
  identityKey: ContractualDiscountIdentityKeySchema,
  reason: ManageContractualDiscountReasonSchema,
};

const CreateContractualDiscountPayloadSchema = Schema.Struct({
  ...targetFields,
  configuredEffect: PricingDiscountEffectSchema,
  effectivePeriod: PricingDiscountEffectivePeriodSchema,
  expectedState: Schema.Struct({ state: Schema.Literal('ABSENT') }),
  intent: Schema.Literal('CREATE'),
}).check(configuredEffectMatchesIdentity);

const ValueOnlyCurrentContractualDiscountPayloadSchema = Schema.Struct({
  ...targetFields,
  acknowledgement: Schema.optionalKey(PricingContractualDiscountScheduleAcknowledgementSchema),
  configuredEffect: PricingDiscountEffectSchema,
  expectedCurrent: ExpectedPricingDiscountCurrentSchema,
  intent: Schema.Literal('VALUE_ONLY_CURRENT'),
}).check(configuredEffectMatchesIdentity);

const CorrectContractualDiscountRevisionPayloadSchema = Schema.Struct({
  ...targetFields,
  configuredEffect: PricingDiscountEffectSchema,
  expectedScheduleRevision: PricingDiscountScheduleRevisionSchema,
  intent: Schema.Literal('CORRECT_REVISION'),
  targetEffectivePeriod: PricingDiscountEffectivePeriodSchema,
  targetRevisionId: PricingDiscountRevisionIdSchema,
}).check(configuredEffectMatchesIdentity);

const ScheduleContractualDiscountRevisionPayloadSchema = Schema.Struct({
  ...targetFields,
  configuredEffect: PricingDiscountEffectSchema,
  effectivePeriod: PricingDiscountEffectivePeriodSchema,
  expectedScheduleRevision: PricingDiscountScheduleRevisionSchema,
  intent: Schema.Literal('SCHEDULE_REVISION'),
}).check(configuredEffectMatchesIdentity);

const RetireCurrentContractualDiscountPayloadSchema = Schema.Struct({
  ...targetFields,
  acknowledgement: Schema.optionalKey(PricingContractualDiscountScheduleAcknowledgementSchema),
  expectedCurrent: ExpectedPricingDiscountCurrentSchema,
  intent: Schema.Literal('RETIRE_CURRENT'),
});

export const ManageContractualDiscountPayloadSchema = Schema.Union([
  CorrectContractualDiscountRevisionPayloadSchema,
  CreateContractualDiscountPayloadSchema,
  RetireCurrentContractualDiscountPayloadSchema,
  ScheduleContractualDiscountRevisionPayloadSchema,
  ValueOnlyCurrentContractualDiscountPayloadSchema,
]);
export type ManageContractualDiscountPayload = typeof ManageContractualDiscountPayloadSchema.Type;

export const ManageContractualDiscountResultSchema = Schema.Struct({
  outcome: Schema.Literals([
    'CONTRACTUAL_DISCOUNT_CORRECTED',
    'CONTRACTUAL_DISCOUNT_CREATED',
    'CONTRACTUAL_DISCOUNT_RETIRED',
    'CONTRACTUAL_DISCOUNT_REUSED',
    'CONTRACTUAL_DISCOUNT_REVISED',
    'CONTRACTUAL_DISCOUNT_UNCHANGED',
  ]),
  schedule: PricingContractualDiscountScheduleSnapshotSchema,
});
export type ManageContractualDiscountResult = typeof ManageContractualDiscountResultSchema.Type;

export const ContractualDiscountConflictReasonSchema = Schema.Literals([
  'ACKNOWLEDGEMENT_STALE',
  'BOUNDARY_CROSSED',
  'EFFECTIVE_BOUNDARY_STALE',
  'EXPECTED_CURRENT_STALE',
  'EXPECTED_SCHEDULE_STALE',
  'IDENTITY_MISMATCH',
  'OVERLAPPING_SCHEDULE',
  'TARGET_REVISION_NOT_FOUND',
]);
export const ManageContractualDiscountPersistenceOutcomeSchema = Schema.Union([
  ManageContractualDiscountResultSchema,
  Schema.Struct({
    acknowledgement: PricingContractualDiscountScheduleAcknowledgementSchema,
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED'),
  }),
  Schema.Struct({
    identityKey: PricingDiscountIdentityKeySchema,
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_CONFLICT'),
    reason: ContractualDiscountConflictReasonSchema,
  }),
]);
export type ManageContractualDiscountPersistenceOutcome = typeof ManageContractualDiscountPersistenceOutcomeSchema.Type;

export const ContractualDiscountActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ContractualDiscountActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

export const ContractualDiscountResultLookupOutcomeSchema = Schema.Union([
  Schema.Struct({
    actionInvocationId: ContractualDiscountActionInvocationIdSchema,
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_RESULT_FOUND'),
    result: ManageContractualDiscountPersistenceOutcomeSchema,
  }),
  Schema.Struct({
    actionInvocationId: ContractualDiscountActionInvocationIdSchema,
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_RESULT_ABSENT'),
  }),
]);
export type ContractualDiscountResultLookupOutcome = typeof ContractualDiscountResultLookupOutcomeSchema.Type;

export { ContractualDiscountIdentityKeySchema };
