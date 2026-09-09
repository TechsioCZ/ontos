// oxlint-disable-next-line max-classes-per-file -- This cohesive browser-safe Action contract declares three independently tagged Effect failures that consumers decode as one explicit error union.
import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import {
  CommercialFxPurposeSchema,
  ExactDecimalSchema,
  FxArithmeticVersionSchema,
  FxCurrencyCodeSchema,
  FxRoundingModeSchema,
} from './commercial-fx-conversion.ts';

const BoundedIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const ChannelIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('ManualFxChannelId'),
  Schema.decodeTo(BoundedIdentifierSchema),
);
const MarketIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('ManualFxMarketId'),
  Schema.decodeTo(BoundedIdentifierSchema),
);
const RateSourceIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('ManualFxRateSourceId'),
  Schema.decodeTo(BoundedIdentifierSchema),
);
const StorefrontIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('ManualFxStorefrontId'),
  Schema.decodeTo(BoundedIdentifierSchema),
);
const UuidSchema = Schema.String.check(Schema.isUUID());
const PolicyRevisionIdSchema = UuidSchema.pipe(
  Schema.brand('ManualFxPolicyRevisionId'),
  Schema.decodeTo(UuidSchema),
);
const SellingLegalEntityIdSchema = UuidSchema.pipe(
  Schema.brand('ManualFxSellingLegalEntityId'),
  Schema.decodeTo(UuidSchema),
);
const TenantIdSchema = UuidSchema.pipe(
  Schema.brand('ManualFxTenantId'),
  Schema.decodeTo(UuidSchema),
);
const StableRevisionSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u),
);
const ReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const NonNegativeRevisionSchema = Schema.Int.check(
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 }),
);
const PositiveRevisionSchema = Schema.Int.check(
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);
const ManualFxInstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  }),
);

export const ManualFxContextKeySchema = Schema.Struct({
  channelId: ChannelIdSchema,
  marketId: MarketIdSchema,
  purpose: CommercialFxPurposeSchema,
  sourceCurrencyCode: FxCurrencyCodeSchema,
  storefrontId: StorefrontIdSchema,
  targetCurrencyCode: FxCurrencyCodeSchema,
});
export type ManualFxContextKey = typeof ManualFxContextKeySchema.Type;

export const ManualFxRateSchema = ExactDecimalSchema.check(
  Schema.makeFilter((value) =>
    /^0(?:\.0+)?$/u.test(value) || value.startsWith('-')
      ? 'Expected a positive non-zero manual FX rate'
      : undefined,
  ),
);

const exactDecimalScale = (value: string): number =>
  (value.split('.')[1] ?? '').replace(/0+$/u, '').length;

export const ManualFxRatePolicySetSchema = Schema.Struct({
  arithmeticVersion: FxArithmeticVersionSchema,
  direction: Schema.Literals(['SOURCE_TO_TARGET', 'TARGET_TO_SOURCE']),
  effectiveFrom: ManualFxInstantSchema,
  effectiveTo: ManualFxInstantSchema,
  inverseRatePermitted: Schema.Boolean,
  maximumRateAgeSeconds: Schema.Int.check(Schema.isBetween({ maximum: 31_536_000, minimum: 0 })),
  operation: Schema.Literal('SET'),
  rate: ManualFxRateSchema,
  rateObservedAt: ManualFxInstantSchema,
  rateSourceId: RateSourceIdSchema,
  roundingIncrement: ManualFxRateSchema,
  roundingMode: FxRoundingModeSchema,
  roundingRuleRevision: StableRevisionSchema,
  sourceRevision: StableRevisionSchema,
  targetMinorUnits: Schema.Int.check(Schema.isBetween({ maximum: 18, minimum: 0 })),
}).check(
  Schema.makeFilter((value) =>
    exactDecimalScale(value.roundingIncrement) <= value.targetMinorUnits
      ? undefined
      : 'Expected the rounding increment to be representable at the target minor-unit scale',
  ),
);
export type ManualFxRatePolicySet = typeof ManualFxRatePolicySetSchema.Type;

export const ManualFxRatePolicyWithdrawSchema = Schema.Struct({
  effectiveFrom: ManualFxInstantSchema,
  operation: Schema.Literal('WITHDRAW'),
  rateSourceId: RateSourceIdSchema,
  sourceRevision: StableRevisionSchema,
});
export type ManualFxRatePolicyWithdraw = typeof ManualFxRatePolicyWithdrawSchema.Type;

export const ManualFxRatePolicyChangeSchema = Schema.Union([
  ManualFxRatePolicySetSchema,
  ManualFxRatePolicyWithdrawSchema,
]);
export type ManualFxRatePolicyChange = typeof ManualFxRatePolicyChangeSchema.Type;

export const ChangeManualFxRatePolicyCommandSchema = Schema.Struct({
  change: ManualFxRatePolicyChangeSchema,
  context: ManualFxContextKeySchema,
  expectedRevision: NonNegativeRevisionSchema,
  reason: ReasonSchema,
});
export type ChangeManualFxRatePolicyCommand = typeof ChangeManualFxRatePolicyCommandSchema.Type;

export const ManualFxPolicyRevisionSchema = Schema.Struct({
  change: ManualFxRatePolicyChangeSchema,
  context: ManualFxContextKeySchema,
  policyRevisionId: PolicyRevisionIdSchema,
  recordedAt: ManualFxInstantSchema,
  revision: PositiveRevisionSchema,
  sellingLegalEntityId: SellingLegalEntityIdSchema,
  tenantId: TenantIdSchema,
});
export type ManualFxPolicyRevision = typeof ManualFxPolicyRevisionSchema.Type;

export const ChangeManualFxRatePolicyResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  current: ManualFxPolicyRevisionSchema,
});
export type ChangeManualFxRatePolicyResult = typeof ChangeManualFxRatePolicyResultSchema.Type;

export const ManualFxRatePolicyAuditEvidenceSchema = Schema.Union([
  Schema.Struct({
    arithmeticVersion: FxArithmeticVersionSchema,
    context: ManualFxContextKeySchema,
    operation: Schema.Literal('SET'),
    reason: ReasonSchema,
    roundingIncrement: ManualFxRateSchema,
    roundingRuleRevision: StableRevisionSchema,
    sourceRevision: StableRevisionSchema,
  }),
  Schema.Struct({
    context: ManualFxContextKeySchema,
    operation: Schema.Literal('WITHDRAW'),
    reason: ReasonSchema,
    sourceRevision: StableRevisionSchema,
  }),
]);

export class ManualFxRatePolicyConflict extends Schema.TaggedError<ManualFxRatePolicyConflict>()(
  'ManualFxRatePolicyConflict',
  {
    code: Schema.Literal('manual_fx_rate_policy_conflict'),
    conflict: Schema.Literals(['ACTION_INVOCATION_REUSED', 'REVISION', 'SOURCE_REVISION_REUSED']),
    currentRevision: NonNegativeRevisionSchema,
    expectedRevision: NonNegativeRevisionSchema,
    reason: Schema.String,
  },
) {}

export class ManualFxRatePolicyInvalid extends Schema.TaggedError<ManualFxRatePolicyInvalid>()(
  'ManualFxRatePolicyInvalid',
  {
    code: Schema.Literal('manual_fx_rate_policy_invalid'),
    reason: Schema.String,
  },
) {}

export class ManualFxRatePolicyPersistenceUnavailable extends Schema.TaggedError<ManualFxRatePolicyPersistenceUnavailable>()(
  'ManualFxRatePolicyPersistenceUnavailable',
  {
    code: Schema.Literal('manual_fx_rate_policy_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export const validateManualFxRatePolicyCommand = (
  command: ChangeManualFxRatePolicyCommand,
  recordedAt: DateTime.Utc,
): ManualFxRatePolicyInvalid | undefined => {
  if (command.context.sourceCurrencyCode === command.context.targetCurrencyCode) {
    return new ManualFxRatePolicyInvalid({
      code: 'manual_fx_rate_policy_invalid',
      reason: 'Manual FX policy requires two different currencies',
    });
  }
  if (
    command.change.operation === 'SET' &&
    !DateTime.isLessThan(
      DateTime.makeUnsafe(command.change.effectiveFrom),
      DateTime.makeUnsafe(command.change.effectiveTo),
    )
  ) {
    return new ManualFxRatePolicyInvalid({
      code: 'manual_fx_rate_policy_invalid',
      reason: 'Manual FX policy uses a half-open Effective Period with end after start',
    });
  }
  if (
    command.change.operation === 'SET' &&
    exactDecimalScale(command.change.roundingIncrement) > command.change.targetMinorUnits
  ) {
    return new ManualFxRatePolicyInvalid({
      code: 'manual_fx_rate_policy_invalid',
      reason: 'The rounding increment exceeds the target minor-unit scale',
    });
  }
  if (
    command.change.operation === 'SET' &&
    !DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(command.change.rateObservedAt), recordedAt)
  ) {
    return new ManualFxRatePolicyInvalid({
      code: 'manual_fx_rate_policy_invalid',
      reason: 'Manual FX source evidence cannot be observed in the future',
    });
  }
  if (
    command.change.operation === 'SET' &&
    command.change.direction === 'TARGET_TO_SOURCE' &&
    !command.change.inverseRatePermitted
  ) {
    return new ManualFxRatePolicyInvalid({
      code: 'manual_fx_rate_policy_invalid',
      reason: 'An inverse manual rate requires an explicit inverse-rate permission',
    });
  }
  return undefined;
};
