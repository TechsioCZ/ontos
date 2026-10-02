import { PersistenceFailure, defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import type {
  CurrentSupportedCurrenciesRequest,
  CurrentSupportedCurrenciesSuccess,
} from '@app/pricing-contracts/current-supported-currencies';
import {
  CurrencySupportCurrentnessEvidenceSchema,
  CurrencySupportEffectivePeriodSchema,
  CurrencySupportScheduleAcknowledgementSchema,
  CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
  PricingCurrencyCodeSetSchema,
  PricingCurrencySupportGenerationSchema,
  PricingCurrencySupportRevisionIdSchema,
  PricingCurrencySupportRevisionRefSchema,
  PricingCurrencySupportRootIdSchema,
  PricingCurrencySupportRootRefSchema,
  PricingCurrencySupportScheduleRevisionSchema,
  PricingInstantSchema,
  PricingRevisionSchema,
  PricingTenantIdSchema,
  SetSupportedCurrenciesV2ResultSchema,
} from '@app/pricing-contracts/domain/currency-support';
import type {
  CurrencySupportCurrentnessEvidence,
  SetSupportedCurrenciesV2Payload,
  SetSupportedCurrenciesV2Result,
} from '@app/pricing-contracts/domain/currency-support';
import { Effect, Match, Option, Schema } from 'effect';

const MODULE_ID = 'commerce.pricing' as const;
const SUPPORT_RESOURCE_TYPE = 'commerce.pricing.currency-support' as const;
const REVISION_RESOURCE_TYPE = 'commerce.pricing.currency-support-revision' as const;
const CurrencySupportRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
const CurrencySupportActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CurrencySupportActionInvocationId'),
);
const scopeParameters = [{ source: 'tenantId', type: 'uuid' }] as const;

export const readTenantCurrencySupportRoutine = defineScopedRoutine({
  name: 'read_tenant_currency_support_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.read-tenant-currency-support-v1',
  schema: 'pricing',
});
export const revalidateTenantCurrencySupportRoutine = defineScopedRoutine({
  name: 'revalidate_tenant_currency_support_v1',
  ownerModuleKey: MODULE_ID,
  parameters: scopeParameters,
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.revalidate-tenant-currency-support-v1',
  schema: 'pricing',
});
export const setTenantCurrencySupportRoutine = defineScopedRoutine({
  name: 'set_tenant_currency_support_v2',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.set-tenant-currency-support-v2',
  schema: 'pricing',
});
export const compensateTenantCurrencySupportRecoveryRoutine = defineScopedRoutine({
  name: 'compensate_tenant_currency_support_recovery_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.compensate-tenant-currency-support-recovery-v1',
  schema: 'pricing',
});
export const lookupTenantCurrencySupportResultRoutine = defineScopedRoutine({
  name: 'lookup_tenant_currency_support_result_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.lookup-tenant-currency-support-result-v1',
  schema: 'pricing',
});
export const verifyTenantCurrencySupportGenerationRoutine = defineScopedRoutine({
  name: 'verify_tenant_currency_support_generation_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.verify-tenant-currency-support-generation-v1',
  schema: 'pricing',
});
export const issueTenantCurrencySupportProofRoutine = defineScopedRoutine({
  name: 'issue_tenant_currency_support_proof_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.issue-tenant-currency-support-proof-v1',
  schema: 'pricing',
});
export const resolveTenantCurrencySupportProofRoutine = defineScopedRoutine({
  name: 'resolve_tenant_currency_support_proof_v1',
  ownerModuleKey: MODULE_ID,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CurrencySupportRoutineRowSchema,
  routineKey: 'pricing.resolve-tenant-currency-support-proof-v1',
  schema: 'pricing',
});

const CurrencySupportEvaluationModeSchema = Schema.Literals(['CURRENT_WITH_REVALIDATION', 'HISTORICAL_AS_OF']);
const readEvidence = {
  evaluatedAt: PricingInstantSchema,
  evaluationMode: CurrencySupportEvaluationModeSchema,
  observedAt: PricingInstantSchema,
  revalidatedAt: Schema.optionalKey(PricingInstantSchema),
} as const;
const StoredRevisionSummarySchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
  generation: PricingCurrencySupportGenerationSchema,
  pricingRevision: PricingRevisionSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  supportRevisionId: PricingCurrencySupportRevisionIdSchema,
});
const StoredScheduleSchema = Schema.Struct({
  current: StoredRevisionSummarySchema,
  future: Schema.Array(StoredRevisionSummarySchema),
  revisions: Schema.Array(StoredRevisionSummarySchema).check(Schema.isMinLength(1)),
});
const storedRevisionSummaryMatches = (
  left: typeof StoredRevisionSummarySchema.Type,
  right: typeof StoredRevisionSummarySchema.Type,
) =>
  left.effectiveFrom === right.effectiveFrom &&
  left.effectiveTo === right.effectiveTo &&
  left.generation === right.generation &&
  left.pricingRevision === right.pricingRevision &&
  left.supportRevisionId === right.supportRevisionId &&
  left.supportedCurrencies.length === right.supportedCurrencies.length &&
  left.supportedCurrencies.every((currency, index) => currency === right.supportedCurrencies[index]);
const ReadCurrentPayloadSchema = Schema.Struct({
  ...readEvidence,
  activeRevisionCount: Schema.Literal(1),
  current: StoredRevisionSummarySchema,
  nextApplicabilityBoundary: Schema.NullOr(PricingInstantSchema),
  outcome: Schema.Literal('CURRENCY_SUPPORT_CURRENT'),
  schedule: StoredScheduleSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportId: PricingCurrencySupportRootIdSchema,
}).check(
  Schema.makeFilter((value) => {
    if (
      !(
        (value.evaluationMode === 'CURRENT_WITH_REVALIDATION' && value.revalidatedAt !== undefined) ||
        (value.evaluationMode === 'HISTORICAL_AS_OF' && value.revalidatedAt === undefined)
      )
    ) {
      return 'Currency Support read evidence does not match its evaluation mode';
    }
    return storedRevisionSummaryMatches(value.current, value.schedule.current) &&
      value.schedule.revisions.some(({ supportRevisionId }) => supportRevisionId === value.current.supportRevisionId)
      ? undefined
      : 'Currency Support Current must bind the complete returned schedule';
  }),
);
const ReadAbsentPayloadSchema = Schema.Struct({
  ...readEvidence,
  activeRevisionCount: Schema.Literal(0),
  outcome: Schema.Literal('CURRENCY_SUPPORT_ABSENT'),
});
const ReadConflictPayloadSchema = Schema.Struct({
  ...readEvidence,
  activeRevisionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  candidateRevisionIds: Schema.optionalKey(Schema.Array(PricingCurrencySupportRevisionIdSchema)),
  outcome: Schema.Literal('CURRENCY_SUPPORT_CONFLICT'),
});
const ReadGapPayloadSchema = Schema.Struct({
  ...readEvidence,
  activeRevisionCount: Schema.Literal(0),
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  outcome: Schema.Literal('CURRENCY_SUPPORT_GAP'),
});
const ReadCurrencySupportPayloadSchema = Schema.Union([
  ReadAbsentPayloadSchema,
  ReadConflictPayloadSchema,
  ReadCurrentPayloadSchema,
  ReadGapPayloadSchema,
]);

const StoredCurrencySupportSchema = Schema.Struct({
  currentnessEvidence: CurrencySupportCurrentnessEvidenceSchema,
  effectivePeriod: CurrencySupportEffectivePeriodSchema,
  factProofs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ factRef: Schema.String, factRevisionRef: Schema.String, verificationRef: Schema.String }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  ),
  generation: PricingCurrencySupportGenerationSchema,
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  predicateRef: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
  ),
  pricingRevision: PricingRevisionSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  supportRevisionRef: PricingCurrencySupportRevisionRefSchema,
  supportRootRef: PricingCurrencySupportRootRefSchema,
  verificationRef: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
  ),
});
export type StoredCurrencySupport = typeof StoredCurrencySupportSchema.Type;
const CurrencySupportReadOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('absent', { observedAt: PricingInstantSchema }),
  Schema.TaggedStruct('conflict', {
    candidateRevisionIds: Schema.optionalKey(Schema.Array(PricingCurrencySupportRevisionIdSchema)),
    observedAt: PricingInstantSchema,
  }),
  Schema.TaggedStruct('gap', {
    nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
    observedAt: PricingInstantSchema,
  }),
  Schema.TaggedStruct('current', { current: StoredCurrencySupportSchema }),
]);
export type CurrencySupportReadOutcome = typeof CurrencySupportReadOutcomeSchema.Type;
type CurrencySupportEvaluationMode = typeof CurrencySupportEvaluationModeSchema.Type;

export type SetCurrencySupportCommand = SetSupportedCurrenciesV2Payload & {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly tenantId: typeof PricingTenantIdSchema.Type;
  readonly trustedOperationAt: Date;
};
export const CurrencySupportConflictReasonSchema = Schema.Literals([
  'BOUNDARY_CROSSED',
  'EXPECTED_CURRENT_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'LAUNCH_CURRENCY_REJECTED',
  'OVERLAPPING_SCHEDULE',
  'SCHEDULE_ACKNOWLEDGEMENT_STALE',
  'SCHEDULE_REVISION_STALE',
]);
export type CurrencySupportConflictReason = typeof CurrencySupportConflictReasonSchema.Type;
export const SetCurrencySupportOutcomeSchema = Schema.Union([
  Schema.Struct({
    acknowledgement: CurrencySupportScheduleAcknowledgementSchema,
    outcome: Schema.Literal('ACKNOWLEDGEMENT_REQUIRED'),
  }),
  Schema.Struct({ outcome: Schema.Literal('CONFLICT'), reason: CurrencySupportConflictReasonSchema }),
  Schema.Struct({
    outcome: Schema.Literals(['CREATED', 'REVISED', 'UNCHANGED']),
    result: SetSupportedCurrenciesV2ResultSchema,
  }),
]);
export type SetCurrencySupportOutcome = typeof SetCurrencySupportOutcomeSchema.Type;

export const CurrencySupportRecoveryCompensationConflictReasonSchema = Schema.Literals([
  'ALREADY_COMPENSATED',
  'CANONICAL_STATE_CHANGED',
  'COMMITTED_INTENT_MISMATCH',
  'COMMITTED_RESULT_NOT_FOUND',
  'EFFECTIVE_TIME_INVALID',
  'IDEMPOTENCY_CONFLICT',
]);
export type CurrencySupportRecoveryCompensationConflictReason =
  typeof CurrencySupportRecoveryCompensationConflictReasonSchema.Type;

export interface CompensateCurrencySupportRecoveryCommand {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly committedActionInvocationId: string;
  readonly reason: string;
  readonly tenantId: typeof PricingTenantIdSchema.Type;
  readonly trustedOperationAt: Date;
}

export const CurrencySupportRecoveryCompensationResultSchema = Schema.Struct({
  absentFrom: PricingInstantSchema,
  committedActionInvocationId: CurrencySupportActionInvocationIdSchema,
  committedGeneration: PricingCurrencySupportGenerationSchema,
  committedScheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  committedSupportRevisionRef: PricingCurrencySupportRevisionRefSchema,
  compensationScheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  outcome: Schema.Literal('CURRENCY_SUPPORT_RECOVERY_COMPENSATED'),
  supportRootRef: PricingCurrencySupportRootRefSchema,
});
export type CurrencySupportRecoveryCompensationResult = typeof CurrencySupportRecoveryCompensationResultSchema.Type;

export type CompensateCurrencySupportRecoveryOutcome =
  | {
      readonly outcome: 'COMPENSATED';
      readonly result: CurrencySupportRecoveryCompensationResult;
    }
  | {
      readonly outcome: 'CONFLICT';
      readonly reason: CurrencySupportRecoveryCompensationConflictReason;
    };

export interface CurrencySupportRecoveryCompensationPersistence {
  readonly compensateRecovery: (
    command: CompensateCurrencySupportRecoveryCommand,
  ) => Effect.Effect<CompensateCurrencySupportRecoveryOutcome, PersistenceFailure>;
}

export interface CurrencySupportPersistence {
  readonly loadCurrent: (
    input: CurrentSupportedCurrenciesRequest,
  ) => Effect.Effect<CurrencySupportReadOutcome, PersistenceFailure>;
  readonly setCurrent: (
    command: SetCurrencySupportCommand,
  ) => Effect.Effect<SetCurrencySupportOutcome, PersistenceFailure>;
}
export interface CurrencySupportActionResultLookupQuery {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}
export interface CurrencySupportActionResultLookupPersistence {
  readonly lookupResult: (
    query: CurrencySupportActionResultLookupQuery,
  ) => Effect.Effect<CurrencySupportActionResultLookupOutcome, PersistenceFailure>;
}
export interface CurrencySupportGenerationThroughQuery {
  readonly support: CurrentSupportedCurrenciesSuccess;
  readonly through: typeof PricingInstantSchema.Type;
}
export type CurrencySupportGenerationThroughOutcome =
  | {
      readonly generation: typeof PricingCurrencySupportGenerationSchema.Type;
      readonly observedAt: typeof PricingInstantSchema.Type;
      readonly outcome: 'UNCHANGED_THROUGH';
      readonly scheduleRevision: typeof PricingCurrencySupportScheduleRevisionSchema.Type;
      readonly supportRevisionId: typeof PricingCurrencySupportRevisionIdSchema.Type;
      readonly supportRootId: typeof PricingCurrencySupportRootIdSchema.Type;
      readonly verifiedThrough: typeof PricingInstantSchema.Type;
    }
  | {
      readonly observedAt: typeof PricingInstantSchema.Type;
      readonly outcome: 'CHANGED';
      readonly verifiedThrough: typeof PricingInstantSchema.Type;
    };
export interface CurrencySupportGenerationVerificationPersistence {
  readonly verifyCurrentThrough: (
    query: CurrencySupportGenerationThroughQuery,
  ) => Effect.Effect<CurrencySupportGenerationThroughOutcome, PersistenceFailure>;
}
export interface CurrencySupportResolvedOriginalProof {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly effectivePeriod: typeof CurrencySupportEffectivePeriodSchema.Type;
  readonly factProofs: readonly {
    readonly factRef: string;
    readonly factRevisionRef: string;
    readonly verificationRef: string;
  }[];
  readonly generation: typeof PricingCurrencySupportGenerationSchema.Type;
  readonly nextApplicabilityBoundary?: typeof PricingInstantSchema.Type;
  readonly observedAt: typeof PricingInstantSchema.Type;
  readonly predicateRef: string;
  readonly pricingRevision: typeof PricingRevisionSchema.Type;
  readonly scheduleRevision: typeof PricingCurrencySupportScheduleRevisionSchema.Type;
  readonly supportedCurrencies: typeof PricingCurrencyCodeSetSchema.Type;
  readonly supportRevisionId: typeof PricingCurrencySupportRevisionIdSchema.Type;
  readonly supportRootId: typeof PricingCurrencySupportRootIdSchema.Type;
  readonly tenantId: string;
  readonly verificationRef: string;
}
export interface CurrencySupportProofResolutionPersistence {
  readonly resolveOriginalProof: (query: {
    readonly verificationRef: string;
  }) => Effect.Effect<CurrencySupportResolvedOriginalProof, PersistenceFailure>;
}
const unavailable = (cause: unknown) =>
  new PersistenceFailure({ cause, reason: 'Pricing currency support could not be verified' });

const supportRefs = (tenantId: string, supportId: string, supportRevisionId: string) => {
  const supportRootRef = {
    moduleId: MODULE_ID,
    resourceId: supportId,
    resourceType: SUPPORT_RESOURCE_TYPE,
    tenantId,
  } as const;
  const supportRevisionRef = {
    moduleId: MODULE_ID,
    resourceId: supportRevisionId,
    resourceType: REVISION_RESOURCE_TYPE,
    supportRootId: supportId,
    tenantId,
  } as const;
  return { supportRevisionRef, supportRootRef };
};
const currentnessEvidence = (
  value: typeof ReadCurrentPayloadSchema.Type,
  tenantId: string,
): Effect.Effect<CurrencySupportCurrentnessEvidence, PersistenceFailure> => {
  const refs = supportRefs(tenantId, value.supportId, value.current.supportRevisionId);
  const candidate =
    value.evaluationMode === 'CURRENT_WITH_REVALIDATION'
      ? {
          ...refs,
          evaluatedAt: value.evaluatedAt,
          evaluationMode: value.evaluationMode,
          observedAt: value.observedAt,
          revalidatedAt: value.revalidatedAt,
          scheduleRevision: value.scheduleRevision,
        }
      : {
          ...refs,
          evaluatedAt: value.evaluatedAt,
          evaluationMode: value.evaluationMode,
          observedAt: value.observedAt,
          scheduleRevision: value.scheduleRevision,
        };
  const decoded = Schema.decodeUnknownOption(CurrencySupportCurrentnessEvidenceSchema)(candidate);
  return Effect.fromOption(decoded, () =>
    unavailable('Currency Support routine returned invalid Currentness evidence'),
  );
};
export const decodeTenantCurrencySupportRead = (
  payload: unknown,
  request: CurrentSupportedCurrenciesRequest,
  expectedMode: CurrencySupportEvaluationMode,
): Effect.Effect<CurrencySupportReadOutcome, PersistenceFailure> => {
  const decoded = Schema.decodeUnknownOption(ReadCurrencySupportPayloadSchema)(payload);
  if (Option.isNone(decoded)) {
    return Effect.fail(unavailable('Currency Support routine returned an invalid read outcome'));
  }
  const { value } = decoded;
  if (value.evaluationMode !== expectedMode) {
    return Effect.fail(unavailable('Currency Support evidence did not bind the requested evaluation mode'));
  }
  if (expectedMode === 'HISTORICAL_AS_OF' && value.evaluatedAt !== request.effectiveAt) {
    return Effect.fail(unavailable('Currency Support evidence did not bind the requested evaluation instant'));
  }
  if (expectedMode === 'CURRENT_WITH_REVALIDATION' && value.evaluatedAt !== value.observedAt) {
    return Effect.fail(unavailable('Currency Support Current evidence did not bind the database observation instant'));
  }
  if (value.outcome === 'CURRENCY_SUPPORT_ABSENT') {
    return Effect.succeed({ _tag: 'absent', observedAt: value.observedAt });
  }
  if (value.outcome === 'CURRENCY_SUPPORT_CONFLICT') {
    return Effect.succeed(
      value.candidateRevisionIds === undefined
        ? { _tag: 'conflict', observedAt: value.observedAt }
        : {
            _tag: 'conflict',
            candidateRevisionIds: value.candidateRevisionIds,
            observedAt: value.observedAt,
          },
    );
  }
  if (value.outcome === 'CURRENCY_SUPPORT_GAP') {
    return Effect.succeed(
      value.nextApplicabilityBoundary === undefined
        ? { _tag: 'gap' as const, observedAt: value.observedAt }
        : {
            _tag: 'gap' as const,
            nextApplicabilityBoundary: value.nextApplicabilityBoundary,
            observedAt: value.observedAt,
          },
    );
  }
  return currentnessEvidence(value, request.tenantId).pipe(
    Effect.map((evidence) => {
      const refs = supportRefs(request.tenantId, value.supportId, value.current.supportRevisionId);
      const current = {
        ...refs,
        currentnessEvidence: evidence,
        effectivePeriod: {
          effectiveFrom: value.current.effectiveFrom,
          effectiveTo: value.current.effectiveTo,
        },
        generation: value.current.generation,
        observedAt: value.observedAt,
        pricingRevision: value.current.pricingRevision,
        scheduleRevision: value.scheduleRevision,
        supportedCurrencies: value.current.supportedCurrencies,
      } satisfies StoredCurrencySupport;
      return value.nextApplicabilityBoundary === null
        ? ({ _tag: 'current', current } as const)
        : ({
            _tag: 'current',
            current: { ...current, nextApplicabilityBoundary: value.nextApplicabilityBoundary },
          } as const);
    }),
  );
};

const sameCurrentState = (left: StoredCurrencySupport, right: StoredCurrencySupport): boolean =>
  left.supportRootRef.resourceId === right.supportRootRef.resourceId &&
  left.scheduleRevision === right.scheduleRevision &&
  left.supportRevisionRef.resourceId === right.supportRevisionRef.resourceId &&
  left.effectivePeriod.effectiveFrom === right.effectivePeriod.effectiveFrom &&
  left.effectivePeriod.effectiveTo === right.effectivePeriod.effectiveTo;

export const reconcileTenantCurrencySupportRead = (
  historical: CurrencySupportReadOutcome,
  revalidated: CurrencySupportReadOutcome,
): CurrencySupportReadOutcome =>
  Match.value(historical).pipe(
    Match.tags({
      absent: () => historical,
      conflict: () => historical,
      current: ({ current: historicalCurrent }) =>
        Match.value(revalidated).pipe(
          Match.tags({
            absent: () => historical,
            conflict: () => historical,
            current: ({ current: revalidatedCurrent }) =>
              sameCurrentState(historicalCurrent, revalidatedCurrent) ? revalidated : historical,
            gap: () => historical,
          }),
          Match.exhaustive,
        ),
      gap: () => historical,
    }),
    Match.exhaustive,
  );

const successPayload = {
  changed: Schema.Boolean,
  current: StoredRevisionSummarySchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportId: PricingCurrencySupportRootIdSchema,
} as const;
const SetCurrencySupportSuccessPayloadSchema = Schema.Union([
  Schema.Struct({ ...successPayload, outcome: Schema.Literal('APPLIED') }),
  Schema.Struct({ ...successPayload, outcome: Schema.Literal('UNCHANGED') }),
]);
const CurrencySupportActionResultLookupPayloadSchema = Schema.Union([
  Schema.Struct({
    actingPrincipalId: CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
    actionInvocationId: CurrencySupportActionInvocationIdSchema,
    intent: Schema.Literals(['ESTABLISH_CURRENT', 'VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION']),
    outcome: Schema.Literal('CURRENCY_SUPPORT_ACTION_RESULT_FOUND'),
    result: SetCurrencySupportSuccessPayloadSchema,
  }),
  Schema.Struct({
    actingPrincipalId: CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
    actionInvocationId: CurrencySupportActionInvocationIdSchema,
    outcome: Schema.Literal('CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN'),
  }),
]);
const CurrencySupportGenerationThroughPayloadSchema = Schema.Union([
  Schema.Struct({
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('CURRENCY_SUPPORT_CHANGED_BEFORE_FENCE'),
    verifiedThrough: PricingInstantSchema,
  }),
  Schema.Struct({
    generation: PricingCurrencySupportGenerationSchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('CURRENCY_SUPPORT_UNCHANGED_THROUGH'),
    scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
    supportId: PricingCurrencySupportRootIdSchema,
    supportRevisionId: PricingCurrencySupportRevisionIdSchema,
    verifiedThrough: PricingInstantSchema,
  }),
]);
const CurrencySupportProofPayloadFields = {
  effectiveAt: PricingInstantSchema,
  effectivePeriod: CurrencySupportEffectivePeriodSchema,
  factProofs: Schema.Array(
    Schema.Struct({ factRef: Schema.String, factRevisionRef: Schema.String, verificationRef: Schema.String }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  generation: PricingCurrencySupportGenerationSchema,
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  predicateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
  pricingRevision: PricingRevisionSchema,
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  supportId: PricingCurrencySupportRootIdSchema,
  supportRevisionId: PricingCurrencySupportRevisionIdSchema,
  tenantId: PricingTenantIdSchema,
  verificationRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
} as const;
const CurrencySupportProofIssuedPayloadSchema = Schema.Struct({
  ...CurrencySupportProofPayloadFields,
  outcome: Schema.Literal('CURRENCY_SUPPORT_PROOF_ISSUED'),
});
const CurrencySupportProofResolvedPayloadSchema = Schema.Struct({
  ...CurrencySupportProofPayloadFields,
  outcome: Schema.Literal('CURRENCY_SUPPORT_PROOF_RESOLVED'),
});
const currencySupportProofPayloadIsBound = (
  value: Omit<typeof CurrencySupportProofResolvedPayloadSchema.Type, 'outcome'>,
) => {
  const [fact] = value.factProofs;
  const expectedPredicate = [
    'commerce.pricing.current-supported-currencies',
    value.tenantId,
    value.supportId,
    value.supportRevisionId,
    [...value.supportedCurrencies].toSorted().join(','),
  ].join(':');
  return (
    value.verificationRef.startsWith('commerce.pricing.currency-support-proof:') &&
    value.predicateRef === expectedPredicate &&
    fact?.factRef === value.supportId &&
    fact.factRevisionRef === value.supportRevisionId &&
    fact.verificationRef === value.verificationRef &&
    value.effectivePeriod.effectiveFrom <= value.effectiveAt &&
    (value.effectivePeriod.effectiveTo === null || value.effectiveAt < value.effectivePeriod.effectiveTo) &&
    value.nextApplicabilityBoundary === (value.effectivePeriod.effectiveTo ?? undefined)
  );
};
export type CurrencySupportActionResultLookupOutcome =
  | { readonly outcome: 'FOUND'; readonly result: Extract<SetCurrencySupportOutcome, { readonly result: unknown }> }
  | { readonly outcome: 'UNKNOWN' };
const StoredAcknowledgementRevisionSummarySchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
  generation: PricingCurrencySupportGenerationSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  supportRevisionId: PricingCurrencySupportRevisionIdSchema,
});
const StoredScheduleAcknowledgementSchema = Schema.Struct({
  actingPrincipalId: CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  intendedEffectivePeriod: Schema.Struct({
    effectiveFrom: PricingInstantSchema,
    effectiveTo: Schema.NullOr(PricingInstantSchema),
  }),
  intendedSupportedCurrencies: PricingCurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  presentedFuture: Schema.Array(StoredAcknowledgementRevisionSummarySchema).check(Schema.isMinLength(1)),
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportId: PricingCurrencySupportRootIdSchema,
  targetEffectivePeriod: Schema.Struct({
    effectiveFrom: PricingInstantSchema,
    effectiveTo: Schema.NullOr(PricingInstantSchema),
  }),
  targetRevisionId: PricingCurrencySupportRevisionIdSchema,
});
const SetCurrencySupportAcknowledgementPayloadSchema = Schema.Struct({
  outcome: Schema.Literal('SCHEDULE_ACKNOWLEDGEMENT_REQUIRED'),
  scheduleAcknowledgement: StoredScheduleAcknowledgementSchema,
});
const conflictReason = { reason: Schema.optionalKey(CurrencySupportConflictReasonSchema) } as const;
const SetCurrencySupportConflictPayloadSchema = Schema.Union([
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('CURRENT_STATE_CONFLICT') }),
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('EFFECTIVE_TIME_CONFLICT') }),
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('LAUNCH_CURRENCY_REJECTED') }),
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('REVISION_CONFLICT') }),
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('SCHEDULE_ACKNOWLEDGEMENT_STALE') }),
  Schema.Struct({ ...conflictReason, outcome: Schema.Literal('SCHEDULE_CONFLICT') }),
]);
const SetCurrencySupportPayloadSchema = Schema.Union([
  SetCurrencySupportAcknowledgementPayloadSchema,
  SetCurrencySupportConflictPayloadSchema,
  SetCurrencySupportSuccessPayloadSchema,
]);
const CurrencySupportRecoveryCompensationPayloadSchema = Schema.Union([
  Schema.Struct({
    absentFrom: PricingInstantSchema,
    committedActionInvocationId: CurrencySupportActionInvocationIdSchema,
    committedGeneration: PricingCurrencySupportGenerationSchema,
    committedScheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
    committedSupportRevisionId: PricingCurrencySupportRevisionIdSchema,
    compensationScheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
    outcome: Schema.Literal('CURRENCY_SUPPORT_RECOVERY_COMPENSATED'),
    supportId: PricingCurrencySupportRootIdSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT'),
    reason: CurrencySupportRecoveryCompensationConflictReasonSchema,
  }),
]);
const defaultConflictReason = (
  outcome: typeof SetCurrencySupportConflictPayloadSchema.Type.outcome,
): CurrencySupportConflictReason =>
  Match.value(outcome).pipe(
    Match.when('CURRENT_STATE_CONFLICT', () => 'EXPECTED_CURRENT_MISMATCH' as const),
    Match.when('EFFECTIVE_TIME_CONFLICT', () => 'BOUNDARY_CROSSED' as const),
    Match.when('LAUNCH_CURRENCY_REJECTED', () => 'LAUNCH_CURRENCY_REJECTED' as const),
    Match.when('REVISION_CONFLICT', () => 'EXPECTED_CURRENT_MISMATCH' as const),
    Match.when('SCHEDULE_ACKNOWLEDGEMENT_STALE', () => 'SCHEDULE_ACKNOWLEDGEMENT_STALE' as const),
    Match.when('SCHEDULE_CONFLICT', () => 'SCHEDULE_REVISION_STALE' as const),
    Match.exhaustive,
  );
const acknowledgementMatchesCommand = (
  acknowledgement: typeof StoredScheduleAcknowledgementSchema.Type,
  command: SetCurrencySupportCommand,
): boolean => {
  if (command.intent !== 'VALUE_ONLY_CURRENT' || command.expectedState.state !== 'PRESENT') {
    return false;
  }
  const { current } = command.expectedState;
  const futureMatches =
    acknowledgement.presentedFuture.length === command.expectedState.future.length &&
    acknowledgement.presentedFuture.every((stored, index) => {
      const expected = command.expectedState.future[index];
      return (
        expected !== undefined &&
        stored.effectiveFrom === expected.effectivePeriod.effectiveFrom &&
        stored.effectiveTo === expected.effectivePeriod.effectiveTo &&
        stored.generation === expected.generation &&
        stored.supportRevisionId === expected.supportRevisionRef.resourceId &&
        stored.supportedCurrencies.length === expected.supportedCurrencies.length &&
        stored.supportedCurrencies.every(
          (currency, currencyIndex) => currency === expected.supportedCurrencies[currencyIndex],
        )
      );
    });
  return (
    acknowledgement.actingPrincipalId === command.actingPrincipalId &&
    acknowledgement.scheduleRevision === command.expectedState.scheduleRevision &&
    acknowledgement.supportId === command.expectedState.supportRootRef.resourceId &&
    acknowledgement.targetRevisionId === current.supportRevisionRef.resourceId &&
    acknowledgement.targetEffectivePeriod.effectiveFrom === current.effectivePeriod.effectiveFrom &&
    acknowledgement.targetEffectivePeriod.effectiveTo === current.effectivePeriod.effectiveTo &&
    acknowledgement.intendedEffectivePeriod.effectiveFrom === command.intendedEffectivePeriod.effectiveFrom &&
    acknowledgement.intendedEffectivePeriod.effectiveTo === command.intendedEffectivePeriod.effectiveTo &&
    acknowledgement.intendedSupportedCurrencies.length === command.supportedCurrencies.length &&
    acknowledgement.intendedSupportedCurrencies.every(
      (currency, index) => currency === command.supportedCurrencies[index],
    ) &&
    futureMatches
  );
};
const decodeAcknowledgementOutcome = (
  value: typeof SetCurrencySupportAcknowledgementPayloadSchema.Type,
  command: SetCurrencySupportCommand,
): Effect.Effect<SetCurrencySupportOutcome, PersistenceFailure> => {
  const stored = value.scheduleAcknowledgement;
  if (!acknowledgementMatchesCommand(stored, command)) {
    return Effect.fail(unavailable('Currency Support acknowledgement did not bind the exact requested edit'));
  }
  const refs = supportRefs(command.tenantId, stored.supportId, stored.targetRevisionId);
  const acknowledgement = {
    actingPrincipalId: stored.actingPrincipalId,
    expectedScheduleRevision: stored.scheduleRevision,
    fingerprint: stored.fingerprint,
    intendedEffectivePeriod: stored.intendedEffectivePeriod,
    intendedSupportedCurrencies: stored.intendedSupportedCurrencies,
    presentedFuture: stored.presentedFuture.map((future) => ({
      effectivePeriod: { effectiveFrom: future.effectiveFrom, effectiveTo: future.effectiveTo },
      generation: future.generation,
      supportedCurrencies: future.supportedCurrencies,
      supportRevisionRef: supportRefs(command.tenantId, stored.supportId, future.supportRevisionId).supportRevisionRef,
    })),
    supportRootRef: refs.supportRootRef,
    targetEffectivePeriod: stored.targetEffectivePeriod,
    targetRevisionRef: refs.supportRevisionRef,
  };
  const decoded = Schema.decodeOption(CurrencySupportScheduleAcknowledgementSchema)(acknowledgement);
  return Option.isSome(decoded)
    ? Effect.succeed({ acknowledgement: decoded.value, outcome: 'ACKNOWLEDGEMENT_REQUIRED' })
    : Effect.fail(unavailable('Currency Support routine returned an invalid acknowledgement challenge'));
};
const decodeSuccessResult = (
  value: typeof SetCurrencySupportSuccessPayloadSchema.Type,
  tenantId: string,
): Effect.Effect<SetSupportedCurrenciesV2Result, PersistenceFailure> => {
  if (value.current.supportedCurrencies.length !== 1 || value.current.supportedCurrencies[0] !== 'CZK') {
    return Effect.fail(unavailable('Currency Support routine returned a non-Launch Current set'));
  }
  const refs = supportRefs(tenantId, value.supportId, value.current.supportRevisionId);
  const result = {
    changed: value.changed,
    current: {
      effectivePeriod: {
        effectiveFrom: value.current.effectiveFrom,
        effectiveTo: value.current.effectiveTo,
      },
      generation: value.current.generation,
      supportedCurrencies: value.current.supportedCurrencies,
      supportRevisionRef: refs.supportRevisionRef,
    },
    scheduleRevision: value.scheduleRevision,
    supportRootRef: refs.supportRootRef,
  };
  const decoded = Schema.decodeOption(SetSupportedCurrenciesV2ResultSchema)(result);
  if (Option.isNone(decoded)) {
    return Effect.fail(unavailable('Currency Support routine returned an invalid success result'));
  }
  return Effect.succeed(decoded.value);
};
const successOutcome = (
  value: typeof SetCurrencySupportSuccessPayloadSchema.Type,
  intent: SetCurrencySupportCommand['intent'],
): 'CREATED' | 'REVISED' | 'UNCHANGED' => {
  if (value.outcome === 'UNCHANGED') {
    return 'UNCHANGED';
  }
  return intent === 'ESTABLISH_CURRENT' ? 'CREATED' : 'REVISED';
};
const decodeSuccessOutcome = (
  value: typeof SetCurrencySupportSuccessPayloadSchema.Type,
  command: SetCurrencySupportCommand,
): Effect.Effect<SetCurrencySupportOutcome, PersistenceFailure> => {
  const unchanged = value.outcome === 'UNCHANGED';
  if (
    value.changed === unchanged ||
    (unchanged &&
      (command.intent !== 'VALUE_ONLY_CURRENT' ||
        command.expectedState.state !== 'PRESENT' ||
        value.supportId !== command.expectedState.supportRootRef.resourceId ||
        value.scheduleRevision !== command.expectedState.scheduleRevision ||
        value.current.generation !== command.expectedState.current.generation ||
        value.current.supportRevisionId !== command.expectedState.current.supportRevisionRef.resourceId ||
        value.current.effectiveFrom !== command.expectedState.current.effectivePeriod.effectiveFrom ||
        value.current.effectiveFrom !== command.intendedEffectivePeriod.effectiveFrom ||
        value.current.effectiveTo !== command.expectedState.current.effectivePeriod.effectiveTo ||
        value.current.supportedCurrencies.length !== command.expectedState.current.supportedCurrencies.length ||
        !value.current.supportedCurrencies.every(
          (currency, index) => currency === command.expectedState.current.supportedCurrencies[index],
        ) ||
        value.current.supportedCurrencies.length !== command.supportedCurrencies.length ||
        !value.current.supportedCurrencies.every((currency, index) => currency === command.supportedCurrencies[index])))
  ) {
    return Effect.fail(unavailable('Currency Support routine returned an inconsistent success outcome'));
  }
  return decodeSuccessResult(value, command.tenantId).pipe(
    Effect.map((result) => ({
      outcome: successOutcome(value, command.intent),
      result,
    })),
  );
};
const decodeConflictOutcome = (
  value: typeof SetCurrencySupportConflictPayloadSchema.Type,
): Effect.Effect<SetCurrencySupportOutcome> =>
  Effect.succeed({ outcome: 'CONFLICT', reason: value.reason ?? defaultConflictReason(value.outcome) });

export const decodeSetCurrencySupportOutcome = (
  payload: unknown,
  command: SetCurrencySupportCommand,
): Effect.Effect<SetCurrencySupportOutcome, PersistenceFailure> => {
  const decodedPayload = Schema.decodeUnknownOption(SetCurrencySupportPayloadSchema)(payload);
  if (Option.isNone(decodedPayload)) {
    return Effect.fail(unavailable('Currency Support routine returned an invalid mutation outcome'));
  }
  return Match.value(decodedPayload.value).pipe(
    Match.discriminator('outcome')('APPLIED', (value) => decodeSuccessOutcome(value, command)),
    Match.discriminator('outcome')('CURRENT_STATE_CONFLICT', decodeConflictOutcome),
    Match.discriminator('outcome')('EFFECTIVE_TIME_CONFLICT', decodeConflictOutcome),
    Match.discriminator('outcome')('LAUNCH_CURRENCY_REJECTED', decodeConflictOutcome),
    Match.discriminator('outcome')('REVISION_CONFLICT', decodeConflictOutcome),
    Match.discriminator('outcome')('SCHEDULE_ACKNOWLEDGEMENT_REQUIRED', (value) =>
      decodeAcknowledgementOutcome(value, command),
    ),
    Match.discriminator('outcome')('SCHEDULE_ACKNOWLEDGEMENT_STALE', decodeConflictOutcome),
    Match.discriminator('outcome')('SCHEDULE_CONFLICT', decodeConflictOutcome),
    Match.discriminator('outcome')('UNCHANGED', (value) => decodeSuccessOutcome(value, command)),
    Match.exhaustive,
  );
};

export const decodeCurrencySupportRecoveryCompensationOutcome = (
  payload: unknown,
  command: CompensateCurrencySupportRecoveryCommand,
): Effect.Effect<CompensateCurrencySupportRecoveryOutcome, PersistenceFailure> => {
  const decoded = Schema.decodeUnknownOption(CurrencySupportRecoveryCompensationPayloadSchema)(payload);
  if (Option.isNone(decoded)) {
    return Effect.fail(unavailable('Currency Support recovery compensation returned an invalid outcome'));
  }
  const { value } = decoded;
  if (value.outcome === 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT') {
    return Effect.succeed({ outcome: 'CONFLICT', reason: value.reason });
  }
  if (
    value.committedActionInvocationId !== command.committedActionInvocationId ||
    value.compensationScheduleRevision <= value.committedScheduleRevision
  ) {
    return Effect.fail(unavailable('Currency Support recovery compensation did not bind the committed transition'));
  }
  const refs = supportRefs(command.tenantId, value.supportId, value.committedSupportRevisionId);
  const result = {
    absentFrom: value.absentFrom,
    committedActionInvocationId: value.committedActionInvocationId,
    committedGeneration: value.committedGeneration,
    committedScheduleRevision: value.committedScheduleRevision,
    committedSupportRevisionRef: refs.supportRevisionRef,
    compensationScheduleRevision: value.compensationScheduleRevision,
    outcome: value.outcome,
    supportRootRef: refs.supportRootRef,
  };
  const decodedResult = Schema.decodeOption(CurrencySupportRecoveryCompensationResultSchema)(result);
  return Option.isSome(decodedResult)
    ? Effect.succeed({ outcome: 'COMPENSATED', result: decodedResult.value })
    : Effect.fail(unavailable('Currency Support recovery compensation returned inconsistent references'));
};

export const decodeCurrencySupportActionResultLookup = Effect.fn('CurrencySupportPersistence.decodeActionResultLookup')(
  function* decodeResultLookup(payload: unknown, query: CurrencySupportActionResultLookupQuery, tenantId: string) {
    const decoded = Schema.decodeUnknownOption(CurrencySupportActionResultLookupPayloadSchema)(payload);
    if (Option.isNone(decoded)) {
      return yield* unavailable('Currency Support result lookup returned an invalid outcome');
    }
    const { value } = decoded;
    if (value.actionInvocationId !== query.actionInvocationId || value.actingPrincipalId !== query.actingPrincipalId) {
      return yield* unavailable('Currency Support result lookup did not bind the original Action actor');
    }
    if (value.outcome === 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN') {
      return { outcome: 'UNKNOWN' as const };
    }
    if (
      value.result.changed !== (value.result.outcome === 'APPLIED') ||
      (value.result.outcome === 'UNCHANGED' && value.intent !== 'VALUE_ONLY_CURRENT')
    ) {
      return yield* unavailable('Currency Support result lookup returned inconsistent success evidence');
    }
    const result = yield* decodeSuccessResult(value.result, tenantId);
    return {
      outcome: 'FOUND' as const,
      result: {
        outcome: successOutcome(value.result, value.intent),
        result,
      },
    };
  },
);

export const decodeCurrencySupportGenerationThrough = Effect.fn('CurrencySupportPersistence.decodeGenerationThrough')(
  function* decodeGenerationThrough(payload: unknown, query: CurrencySupportGenerationThroughQuery) {
    const decoded = Schema.decodeUnknownOption(CurrencySupportGenerationThroughPayloadSchema)(payload);
    if (Option.isNone(decoded)) {
      return yield* unavailable('Currency Support generation verification returned an invalid outcome');
    }
    const { value } = decoded;
    if (value.verifiedThrough !== query.through || value.observedAt < query.through) {
      return yield* unavailable('Currency Support generation verification did not cover the requested fence instant');
    }
    if (value.outcome === 'CURRENCY_SUPPORT_CHANGED_BEFORE_FENCE') {
      return {
        observedAt: value.observedAt,
        outcome: 'CHANGED' as const,
        verifiedThrough: value.verifiedThrough,
      };
    }
    const { support } = query;
    if (
      value.supportId !== support.supportRootRef.resourceId ||
      value.supportRevisionId !== support.supportRevisionRef.resourceId ||
      value.generation !== support.generation ||
      value.scheduleRevision !== support.scheduleRevision
    ) {
      return yield* unavailable('Currency Support generation verification did not bind the exact owner revision');
    }
    const verified = {
      generation: value.generation,
      observedAt: value.observedAt,
      outcome: 'UNCHANGED_THROUGH' as const,
      scheduleRevision: value.scheduleRevision,
      supportRevisionId: value.supportRevisionId,
      supportRootId: value.supportId,
      verifiedThrough: value.verifiedThrough,
    };
    return support.effectivePeriod.effectiveTo === null
      ? verified
      : { ...verified, nextApplicabilityBoundary: support.effectivePeriod.effectiveTo };
  },
);

const resolvedProofFromPayload = (
  value: typeof CurrencySupportProofResolvedPayloadSchema.Type,
): CurrencySupportResolvedOriginalProof => {
  const proof = {
    effectiveAt: value.effectiveAt,
    effectivePeriod: value.effectivePeriod,
    factProofs: value.factProofs,
    generation: value.generation,
    observedAt: value.observedAt,
    predicateRef: value.predicateRef,
    pricingRevision: value.pricingRevision,
    scheduleRevision: value.scheduleRevision,
    supportedCurrencies: value.supportedCurrencies,
    supportRevisionId: value.supportRevisionId,
    supportRootId: value.supportId,
    tenantId: value.tenantId,
    verificationRef: value.verificationRef,
  };
  return value.nextApplicabilityBoundary === undefined
    ? proof
    : { ...proof, nextApplicabilityBoundary: value.nextApplicabilityBoundary };
};

export const decodeIssuedCurrencySupportProof = Effect.fn('CurrencySupportPersistence.decodeIssuedProof')(
  function* decodeIssuedProof(
    payload: unknown,
    input: CurrentSupportedCurrenciesRequest,
    expected: StoredCurrencySupport,
  ) {
    const decoded = Schema.decodeUnknownOption(CurrencySupportProofIssuedPayloadSchema)(payload);
    if (Option.isNone(decoded)) {
      return yield* unavailable('Currency Support proof receipt was not issued from Current state');
    }
    const { value } = decoded;
    if (
      value.tenantId !== input.tenantId ||
      value.effectiveAt !== input.effectiveAt ||
      value.supportId !== expected.supportRootRef.resourceId ||
      value.supportRevisionId !== expected.supportRevisionRef.resourceId ||
      value.generation !== expected.generation ||
      value.scheduleRevision !== expected.scheduleRevision ||
      value.observedAt < expected.observedAt
    ) {
      return yield* unavailable('Currency Support proof receipt did not bind the revalidated owner state');
    }
    const refs = supportRefs(input.tenantId, value.supportId, value.supportRevisionId);
    const proof = resolvedProofFromPayload({ ...value, outcome: 'CURRENCY_SUPPORT_PROOF_RESOLVED' });
    const currentWithoutBoundary = {
      ...refs,
      currentnessEvidence: {
        ...refs,
        evaluatedAt: value.observedAt,
        evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
        observedAt: value.observedAt,
        revalidatedAt: value.observedAt,
        scheduleRevision: value.scheduleRevision,
      },
      effectivePeriod: value.effectivePeriod,
      factProofs: value.factProofs,
      generation: value.generation,
      observedAt: value.observedAt,
      predicateRef: value.predicateRef,
      pricingRevision: value.pricingRevision,
      scheduleRevision: value.scheduleRevision,
      supportedCurrencies: value.supportedCurrencies,
      verificationRef: value.verificationRef,
    } satisfies StoredCurrencySupport;
    const current =
      value.nextApplicabilityBoundary === undefined
        ? currentWithoutBoundary
        : { ...currentWithoutBoundary, nextApplicabilityBoundary: value.nextApplicabilityBoundary };
    return { current, proof };
  },
);

export const decodeResolvedCurrencySupportProof = Effect.fn('CurrencySupportPersistence.decodeResolvedProof')(
  function* decodeResolvedProof(payload: unknown, tenantId: string, verificationRef: string) {
    const decoded = Schema.decodeUnknownOption(CurrencySupportProofResolvedPayloadSchema)(payload);
    if (
      Option.isNone(decoded) ||
      !currencySupportProofPayloadIsBound(decoded.value) ||
      decoded.value.tenantId !== tenantId ||
      decoded.value.verificationRef !== verificationRef
    ) {
      return yield* unavailable('Original Currency Support proof receipt is absent or invalid');
    }
    return resolvedProofFromPayload(decoded.value);
  },
);

const expectedStateWire = (command: SetCurrencySupportCommand) =>
  command.expectedState.state === 'ABSENT'
    ? { expectedGeneration: 0, expectedScheduleRevision: 0 }
    : {
        expectedCurrent: {
          effectiveFrom: command.expectedState.current.effectivePeriod.effectiveFrom,
          effectiveTo: command.expectedState.current.effectivePeriod.effectiveTo,
          supportRevisionId: command.expectedState.current.supportRevisionRef.resourceId,
        },
        expectedGeneration: command.expectedState.current.generation,
        expectedScheduleRevision: command.expectedState.scheduleRevision,
      };
const acknowledgementWire = (command: SetCurrencySupportCommand) => {
  if (command.intent !== 'VALUE_ONLY_CURRENT' || command.acknowledgement === undefined) {
    return Option.none();
  }
  const { acknowledgement } = command;
  return Option.some({
    actingPrincipalId: acknowledgement.actingPrincipalId,
    fingerprint: acknowledgement.fingerprint,
    intendedEffectivePeriod: acknowledgement.intendedEffectivePeriod,
    intendedSupportedCurrencies: acknowledgement.intendedSupportedCurrencies,
    presentedFuture: acknowledgement.presentedFuture.map((future) => ({
      effectiveFrom: future.effectivePeriod.effectiveFrom,
      effectiveTo: future.effectivePeriod.effectiveTo,
      generation: future.generation,
      supportedCurrencies: future.supportedCurrencies,
      supportRevisionId: future.supportRevisionRef.resourceId,
    })),
    scheduleRevision: acknowledgement.expectedScheduleRevision,
    supportId: acknowledgement.supportRootRef.resourceId,
    targetEffectivePeriod: acknowledgement.targetEffectivePeriod,
    targetRevisionId: acknowledgement.targetRevisionRef.resourceId,
  });
};
// Keep this shape identical to the owner routine's full wire minus trustedOperationAt and scheduleAcknowledgement.
export const currencySupportCanonicalIdempotencyIntentWire = (command: SetCurrencySupportCommand) => ({
  ...expectedStateWire(command),
  actionInvocationId: command.actionInvocationId,
  actorPrincipalId: command.actingPrincipalId,
  effectiveFrom: command.intendedEffectivePeriod.effectiveFrom,
  expectedState: command.expectedState,
  intendedEffectivePeriod: command.intendedEffectivePeriod,
  intent: command.intent,
  reason: command.reason,
  supportedCurrencies: command.supportedCurrencies,
});
export const currencySupportSetCommandWire = (command: SetCurrencySupportCommand) => {
  const wire = {
    ...currencySupportCanonicalIdempotencyIntentWire(command),
    trustedOperationAt: command.trustedOperationAt,
  };
  return Option.match(acknowledgementWire(command), {
    onNone: () => wire,
    onSome: (scheduleAcknowledgement) => ({ ...wire, scheduleAcknowledgement }),
  });
};
export const currencySupportRecoveryCompensationCommandWire = (command: CompensateCurrencySupportRecoveryCommand) => ({
  actionInvocationId: command.actionInvocationId,
  actorPrincipalId: command.actingPrincipalId,
  committedActionInvocationId: command.committedActionInvocationId,
  reason: command.reason,
  trustedOperationAt: command.trustedOperationAt,
});
type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;
const decodePayload = <Value, Failure>(
  rows: readonly (typeof CurrencySupportRoutineRowSchema.Type)[],
  decode: (payload: unknown) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | PersistenceFailure> => {
  const [row] = rows;
  return row === undefined || rows.length !== 1
    ? Effect.fail(unavailable('Pricing Currency Support routine returned no outcome'))
    : decode(row.payload);
};
const readHistoricalCurrencySupport = (transaction: ScopedTransaction, input: CurrentSupportedCurrenciesRequest) =>
  transaction
    .invoke(readTenantCurrencySupportRoutine, [{ effectiveAt: input.effectiveAt, evaluationMode: 'HISTORICAL_AS_OF' }])
    .pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) =>
        decodePayload(rows, (payload) => decodeTenantCurrencySupportRead(payload, input, 'HISTORICAL_AS_OF')),
      ),
    );
const revalidateCurrentCurrencySupport = (transaction: ScopedTransaction, input: CurrentSupportedCurrenciesRequest) =>
  transaction.invoke(revalidateTenantCurrencySupportRoutine, []).pipe(
    Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
    Effect.flatMap((rows) =>
      decodePayload(rows, (payload) => decodeTenantCurrencySupportRead(payload, input, 'CURRENT_WITH_REVALIDATION')),
    ),
  );
const issueCurrentCurrencySupportProof = (
  transaction: ScopedTransaction,
  input: CurrentSupportedCurrenciesRequest,
  expected: StoredCurrencySupport,
) =>
  transaction
    .invoke(issueTenantCurrencySupportProofRoutine, [
      {
        effectiveAt: input.effectiveAt,
        generation: expected.generation,
        scheduleRevision: expected.scheduleRevision,
        supportId: expected.supportRootRef.resourceId,
        supportRevisionId: expected.supportRevisionRef.resourceId,
      },
    ])
    .pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) =>
        decodePayload(rows, (payload) => decodeIssuedCurrencySupportProof(payload, input, expected)),
      ),
      Effect.map(({ current }) => ({ _tag: 'current' as const, current })),
    );
const issueProofForReconciledCurrencySupport = (
  transaction: ScopedTransaction,
  input: CurrentSupportedCurrenciesRequest,
  reconciled: CurrencySupportReadOutcome,
) =>
  Match.value(reconciled).pipe(
    Match.tag('current', ({ current }) => issueCurrentCurrencySupportProof(transaction, input, current)),
    Match.orElse((other) => Effect.succeed(other)),
  );
export const currencySupportPersistence = (
  transaction: ScopedTransaction,
  tenantId: string,
  actingPrincipalId: string,
): CurrencySupportPersistence &
  CurrencySupportActionResultLookupPersistence &
  CurrencySupportGenerationVerificationPersistence &
  CurrencySupportProofResolutionPersistence &
  CurrencySupportRecoveryCompensationPersistence => ({
  compensateRecovery: (command) =>
    transaction
      .invoke(compensateTenantCurrencySupportRecoveryRoutine, [currencySupportRecoveryCompensationCommandWire(command)])
      .pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) =>
          decodePayload(rows, (payload) => decodeCurrencySupportRecoveryCompensationOutcome(payload, command)),
        ),
      ),
  loadCurrent: (input) =>
    readHistoricalCurrencySupport(transaction, input).pipe(
      Effect.flatMap((historical) =>
        revalidateCurrentCurrencySupport(transaction, input).pipe(
          Effect.map((revalidated) => reconcileTenantCurrencySupportRead(historical, revalidated)),
        ),
      ),
      Effect.flatMap((reconciled) => issueProofForReconciledCurrencySupport(transaction, input, reconciled)),
    ),
  lookupResult: ({ actionInvocationId }) => {
    const query = { actingPrincipalId, actionInvocationId };
    return transaction.invoke(lookupTenantCurrencySupportResultRoutine, [query]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) =>
        decodePayload(rows, (payload) => decodeCurrencySupportActionResultLookup(payload, query, tenantId)),
      ),
    );
  },
  resolveOriginalProof: ({ verificationRef }) =>
    transaction.invoke(resolveTenantCurrencySupportProofRoutine, [{ verificationRef }]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) =>
        decodePayload(rows, (payload) => decodeResolvedCurrencySupportProof(payload, tenantId, verificationRef)),
      ),
    ),
  setCurrent: (command) =>
    transaction.invoke(setTenantCurrencySupportRoutine, [currencySupportSetCommandWire(command)]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) => decodePayload(rows, (payload) => decodeSetCurrencySupportOutcome(payload, command))),
    ),
  verifyCurrentThrough: (query) => {
    if (query.support.tenantId !== tenantId || query.support.observedAt > query.through) {
      return Effect.fail(unavailable('Currency Support generation verification scope or interval is invalid'));
    }
    const input = {
      effectiveAt: query.support.effectiveAt,
      evidenceObservedAt: query.support.observedAt,
      generation: query.support.generation,
      scheduleRevision: query.support.scheduleRevision,
      supportId: query.support.supportRootRef.resourceId,
      supportRevisionId: query.support.supportRevisionRef.resourceId,
      through: query.through,
    };
    return transaction.invoke(verifyTenantCurrencySupportGenerationRoutine, [input]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap((rows) =>
        decodePayload(rows, (payload) => decodeCurrencySupportGenerationThrough(payload, query)),
      ),
    );
  },
});
export const currencySupportPersistenceForScope: ReadServiceFactory<CurrencySupportPersistence> = (
  transaction,
  scope: OperationalScope,
) => Effect.succeed(currencySupportPersistence(transaction, scope.tenantId, scope.principalId));
export const currencySupportResultLookupPersistenceForScope: ReadServiceFactory<
  CurrencySupportActionResultLookupPersistence
> = (transaction, scope: OperationalScope) =>
  Effect.succeed(currencySupportPersistence(transaction, scope.tenantId, scope.principalId));
export const currencySupportGenerationVerificationPersistenceForScope: ReadServiceFactory<
  CurrencySupportGenerationVerificationPersistence
> = (transaction, scope: OperationalScope) =>
  Effect.succeed(currencySupportPersistence(transaction, scope.tenantId, scope.principalId));
export const currencySupportProofResolutionPersistenceForScope: ReadServiceFactory<
  CurrencySupportProofResolutionPersistence
> = (transaction, scope: OperationalScope) =>
  Effect.succeed(currencySupportPersistence(transaction, scope.tenantId, scope.principalId));
export const currencySupportRecoveryCompensationPersistenceForScope: ReadServiceFactory<
  CurrencySupportRecoveryCompensationPersistence
> = (transaction, scope: OperationalScope) =>
  Effect.succeed(currencySupportPersistence(transaction, scope.tenantId, scope.principalId));
