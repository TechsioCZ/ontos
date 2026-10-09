import { DateTime, Option, Schema, SchemaGetter } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

const brandedReference = <Brand extends string>(brand: Brand) =>
  stableReference.pipe(Schema.brand(brand), Schema.decodeTo(Schema.String));

export const PricingTenantIdSchema = brandedReference('PricingTenantId');
export const PricingRevisionSchema = brandedReference('PricingRevision');
export const PricingCurrencySupportRootIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCurrencySupportRootId'),
  Schema.decodeTo(checkedUuid),
);
export const PricingCurrencySupportRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCurrencySupportRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export const PricingCurrencySupportScheduleRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const PricingCurrencySupportGenerationSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const PricingInstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'Expected a canonical UTC timestamp with milliseconds';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
  }),
  Schema.toEncoded,
);

const recognizedCurrencyCodes = new Set(Intl.supportedValuesOf('currency'));
export const PricingCurrencyCodeSchema = Schema.String.check(
  Schema.isPattern(/^[A-Z]{3}$/u),
  Schema.makeFilter((code) =>
    recognizedCurrencyCodes.has(code) ? undefined : 'Expected a recognized ISO 4217 currency code',
  ),
);
export const PricingCurrencyCodeSetSchema = Schema.Array(PricingCurrencyCodeSchema).check(
  Schema.makeFilter((codes) => (new Set(codes).size === codes.length ? undefined : 'Currency codes must be unique')),
);
export const PricingNonEmptyCurrencyCodeSetSchema = PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1));

export const CurrencySupportEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Currency Support effective period must be a non-empty half-open interval',
  ),
);
export type CurrencySupportEffectivePeriod = typeof CurrencySupportEffectivePeriodSchema.Type;

export const PricingCurrencySupportRootRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.pricing'),
  resourceId: PricingCurrencySupportRootIdSchema,
  resourceType: Schema.Literal('commerce.pricing.currency-support'),
  tenantId: PricingTenantIdSchema,
});
export type PricingCurrencySupportRootRef = typeof PricingCurrencySupportRootRefSchema.Type;

export const PricingCurrencySupportRevisionRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.pricing'),
  resourceId: PricingCurrencySupportRevisionIdSchema,
  resourceType: Schema.Literal('commerce.pricing.currency-support-revision'),
  supportRootId: PricingCurrencySupportRootIdSchema,
  tenantId: PricingTenantIdSchema,
});
export type PricingCurrencySupportRevisionRef = typeof PricingCurrencySupportRevisionRefSchema.Type;

export const CurrencySupportRevisionSummarySchema = Schema.Struct({
  effectivePeriod: CurrencySupportEffectivePeriodSchema,
  generation: PricingCurrencySupportGenerationSchema,
  supportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
  supportRevisionRef: PricingCurrencySupportRevisionRefSchema,
});
export type CurrencySupportRevisionSummary = typeof CurrencySupportRevisionSummarySchema.Type;

const CurrentOwnerEvaluationEvidenceSchema = Schema.Struct({
  evaluatedAt: PricingInstantSchema,
  evaluationMode: Schema.Literal('CURRENT_WITH_REVALIDATION'),
  observedAt: PricingInstantSchema,
  revalidatedAt: PricingInstantSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportRevisionRef: PricingCurrencySupportRevisionRefSchema,
  supportRootRef: PricingCurrencySupportRootRefSchema,
}).check(
  Schema.makeFilter(({ evaluatedAt, observedAt, revalidatedAt }) =>
    evaluatedAt <= observedAt && observedAt <= revalidatedAt
      ? undefined
      : 'Current Currency Support evidence must preserve evaluation, observation, and revalidation order',
  ),
);

const HistoricalAsOfEvidenceSchema = Schema.Struct({
  evaluatedAt: PricingInstantSchema,
  evaluationMode: Schema.Literal('HISTORICAL_AS_OF'),
  observedAt: PricingInstantSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportRevisionRef: PricingCurrencySupportRevisionRefSchema,
  supportRootRef: PricingCurrencySupportRootRefSchema,
});

export const CurrencySupportCurrentnessEvidenceSchema = Schema.Union([
  CurrentOwnerEvaluationEvidenceSchema,
  HistoricalAsOfEvidenceSchema,
]).check(
  Schema.makeFilter(({ supportRevisionRef, supportRootRef }) =>
    supportRevisionRef.supportRootId === supportRootRef.resourceId &&
    supportRevisionRef.tenantId === supportRootRef.tenantId
      ? undefined
      : 'Currency Support Currentness evidence must bind one Tenant-qualified support root',
  ),
);
export type CurrencySupportCurrentnessEvidence = typeof CurrencySupportCurrentnessEvidenceSchema.Type;

export const ExpectedCurrencySupportAbsentSchema = Schema.Struct({
  state: Schema.Literal('ABSENT'),
});

export const ExpectedCurrencySupportPresentSchema = Schema.Struct({
  current: CurrencySupportRevisionSummarySchema,
  future: Schema.Array(CurrencySupportRevisionSummarySchema),
  observedAt: PricingInstantSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  state: Schema.Literal('PRESENT'),
  supportRootRef: PricingCurrencySupportRootRefSchema,
}).check(
  Schema.makeFilter(({ current, future, observedAt, supportRootRef }) => {
    const revisions = [current, ...future];
    const oneRoot = revisions.every(
      ({ supportRevisionRef }) =>
        supportRevisionRef.supportRootId === supportRootRef.resourceId &&
        supportRevisionRef.tenantId === supportRootRef.tenantId,
    );
    if (!oneRoot) {
      return 'Expected Currency Support state must belong to one Tenant-qualified support root';
    }
    const currentContainsObservation =
      current.effectivePeriod.effectiveFrom <= observedAt &&
      (current.effectivePeriod.effectiveTo === null || observedAt < current.effectivePeriod.effectiveTo);
    if (!currentContainsObservation) {
      return 'Expected Current Currency Support must contain the observation instant';
    }
    if (current.effectivePeriod.effectiveTo === null && future.length > 0) {
      return 'An open Current Currency Support interval cannot overlap a future Revision';
    }
    const orderedFuture = future.toSorted((left, right) =>
      left.effectivePeriod.effectiveFrom.localeCompare(right.effectivePeriod.effectiveFrom),
    );
    const futureIsCompleteSchedule = future.every((revision, index) => {
      const ordered = orderedFuture[index];
      const previous = future[index - 1] ?? current;
      return (
        ordered?.supportRevisionRef.resourceId === revision.supportRevisionRef.resourceId &&
        revision.effectivePeriod.effectiveFrom > observedAt &&
        previous.effectivePeriod.effectiveTo !== null &&
        previous.effectivePeriod.effectiveTo <= revision.effectivePeriod.effectiveFrom
      );
    });
    return futureIsCompleteSchedule
      ? undefined
      : 'Expected future Currency Support must be complete, ordered, and non-overlapping';
  }),
);

export const ExpectedCurrencySupportStateSchema = Schema.Union([
  ExpectedCurrencySupportAbsentSchema,
  ExpectedCurrencySupportPresentSchema,
]);
export type ExpectedCurrencySupportState = typeof ExpectedCurrencySupportStateSchema.Type;

export const CurrencySupportScheduleAcknowledgementPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCurrencySupportScheduleAcknowledgementPrincipalId'),
  Schema.decodeTo(checkedUuid),
);
export const CurrencySupportScheduleFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const CurrencySupportScheduleAcknowledgementSchema = Schema.Struct({
  actingPrincipalId: CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
  expectedScheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  fingerprint: CurrencySupportScheduleFingerprintSchema,
  intendedEffectivePeriod: CurrencySupportEffectivePeriodSchema,
  intendedSupportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
  presentedFuture: Schema.Array(CurrencySupportRevisionSummarySchema).check(Schema.isMinLength(1)),
  supportRootRef: PricingCurrencySupportRootRefSchema,
  targetEffectivePeriod: CurrencySupportEffectivePeriodSchema,
  targetRevisionRef: PricingCurrencySupportRevisionRefSchema,
}).check(
  Schema.makeFilter(({ presentedFuture, supportRootRef, targetRevisionRef }) =>
    targetRevisionRef.supportRootId === supportRootRef.resourceId &&
    targetRevisionRef.tenantId === supportRootRef.tenantId &&
    presentedFuture.every(
      ({ supportRevisionRef }) =>
        supportRevisionRef.supportRootId === supportRootRef.resourceId &&
        supportRevisionRef.tenantId === supportRootRef.tenantId,
    )
      ? undefined
      : 'Currency Support acknowledgement must bind one Tenant-qualified support root',
  ),
);
export type CurrencySupportScheduleAcknowledgement = typeof CurrencySupportScheduleAcknowledgementSchema.Type;

const periodsMatch = (left: CurrencySupportEffectivePeriod, right: CurrencySupportEffectivePeriod) =>
  left.effectiveFrom === right.effectiveFrom && left.effectiveTo === right.effectiveTo;
const currenciesMatch = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((currency, index) => currency === right[index]);
const revisionSummariesMatch = (left: CurrencySupportRevisionSummary, right: CurrencySupportRevisionSummary) =>
  left.generation === right.generation &&
  periodsMatch(left.effectivePeriod, right.effectivePeriod) &&
  currenciesMatch(left.supportedCurrencies, right.supportedCurrencies) &&
  left.supportRevisionRef.resourceId === right.supportRevisionRef.resourceId;

const supportManagementBase = {
  intendedEffectivePeriod: CurrencySupportEffectivePeriodSchema,
  reason: boundedReason,
  schemaVersion: Schema.Literal('2'),
  supportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
} as const;

const EstablishCurrencySupportPayloadSchema = Schema.Struct({
  ...supportManagementBase,
  expectedState: ExpectedCurrencySupportAbsentSchema,
  intent: Schema.Literal('ESTABLISH_CURRENT'),
});

const ValueOnlyCurrencySupportPayloadSchema = Schema.Struct({
  ...supportManagementBase,
  acknowledgement: Schema.optionalKey(CurrencySupportScheduleAcknowledgementSchema),
  expectedState: ExpectedCurrencySupportPresentSchema,
  intent: Schema.Literal('VALUE_ONLY_CURRENT'),
}).check(
  Schema.makeFilter((payload) => {
    const { acknowledgement, expectedState, intendedEffectivePeriod, supportedCurrencies } = payload;
    if (intendedEffectivePeriod.effectiveTo !== expectedState.current.effectivePeriod.effectiveTo) {
      return 'A value-only Currency Support edit must preserve the Current interval end';
    }
    if (acknowledgement === undefined) {
      return acknowledgement;
    }
    if (expectedState.future.length === 0) {
      return 'Currency Support acknowledgement is accepted only when a future schedule exists';
    }
    const futureMatches =
      acknowledgement.presentedFuture.length === expectedState.future.length &&
      acknowledgement.presentedFuture.every((revision, index) => {
        const expectedRevision = expectedState.future[index];
        return expectedRevision !== undefined && revisionSummariesMatch(revision, expectedRevision);
      });
    const intendedCurrenciesMatch = currenciesMatch(acknowledgement.intendedSupportedCurrencies, supportedCurrencies);
    return acknowledgement.supportRootRef.resourceId === expectedState.supportRootRef.resourceId &&
      acknowledgement.targetRevisionRef.resourceId === expectedState.current.supportRevisionRef.resourceId &&
      acknowledgement.expectedScheduleRevision === expectedState.scheduleRevision &&
      periodsMatch(acknowledgement.targetEffectivePeriod, expectedState.current.effectivePeriod) &&
      periodsMatch(acknowledgement.intendedEffectivePeriod, intendedEffectivePeriod) &&
      intendedCurrenciesMatch &&
      futureMatches
      ? undefined
      : 'Currency Support acknowledgement must bind the exact target, schedule, intended change, and future state';
  }),
);

const ScheduleCurrencySupportPayloadSchema = Schema.Struct({
  ...supportManagementBase,
  expectedState: ExpectedCurrencySupportPresentSchema,
  intent: Schema.Literal('SCHEDULE_REVISION'),
});

export const SetSupportedCurrenciesV2PayloadSchema = Schema.Union([
  EstablishCurrencySupportPayloadSchema,
  ValueOnlyCurrencySupportPayloadSchema,
  ScheduleCurrencySupportPayloadSchema,
]);
export type SetSupportedCurrenciesV2Payload = typeof SetSupportedCurrenciesV2PayloadSchema.Type;

export const SetSupportedCurrenciesV2ResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  current: CurrencySupportRevisionSummarySchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportRootRef: PricingCurrencySupportRootRefSchema,
}).check(
  Schema.makeFilter(({ current, supportRootRef }) =>
    current.supportRevisionRef.supportRootId === supportRootRef.resourceId &&
    current.supportRevisionRef.tenantId === supportRootRef.tenantId
      ? undefined
      : 'Currency Support result must bind the Current Revision to its Tenant-qualified support root',
  ),
);
export type SetSupportedCurrenciesV2Result = typeof SetSupportedCurrenciesV2ResultSchema.Type;
