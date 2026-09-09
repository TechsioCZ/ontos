import { defineScopedRoutine, OperationContextUnavailable } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Context, DateTime, Effect, Layer, Match, Schema } from 'effect';
import {
  COMMERCIAL_FX_ROUNDING_RULE,
  FxRateExpiredOrStale,
  FxRateUnavailable,
  FxSourceNotConfigured,
  FxSourceResultIndeterminate,
} from '../../shared/domain/commercial-fx-conversion.ts';
import type {
  CommercialFxContextPort,
  CommercialFxConversionRequest,
  CommercialFxPorts,
  FxConversionPolicy,
  FxRateExpiredOrStaleError,
  FxRateUnavailableError,
  FxRateQuote,
  FxSourceNotConfiguredError,
  FxSourceResultIndeterminateError,
} from '../../shared/domain/commercial-fx-conversion.ts';
import {
  ChangeManualFxRatePolicyResultSchema,
  ManualFxPolicyRevisionSchema,
  ManualFxRatePolicyConflict,
  ManualFxRatePolicyPersistenceUnavailable,
} from '../../shared/domain/manual-commercial-rate-policy.ts';
import type {
  ChangeManualFxRatePolicyCommand,
  ChangeManualFxRatePolicyResult,
  ManualFxPolicyRevision,
} from '../../shared/domain/manual-commercial-rate-policy.ts';

const MODULE_KEY = 'commerce.fx';
const DATABASE_SCHEMA = 'commerce_fx';
const DURABLE_VERSION_CONFLICT_REASON =
  'The manual FX policy mutation conflicts with durable version state';
const INVALID_ROUTINE_RESULT = 'invalid-result';
type ManualFxFailureCause =
  | ManualFxRatePolicyPersistenceUnavailable
  | Schema.SchemaError
  | ScopedRoutineInvocationError;

export interface ManualCommercialFxVerifiedScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly trustedStorefrontId: string;
}

export interface ManualCommercialFxPortsFactoryService {
  readonly make: (
    transaction: CommerceFxScopedRoutineInvoker,
    scope: ManualCommercialFxVerifiedScope,
    authoritativeContextPort: CommercialFxContextPort,
  ) => CommercialFxPorts;
}

export const ManualCommercialFxPortsFactoryTag =
  '@app/commerce-fx/src/persistence/manual-rate-policy-persistence/ManualCommercialFxPortsFactory';

export class ManualCommercialFxPortsFactory extends Context.Service<
  ManualCommercialFxPortsFactory,
  ManualCommercialFxPortsFactoryService
>()(ManualCommercialFxPortsFactoryTag) {}

export interface CommerceFxScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const RoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
const MutationRoutineResultSchema = Schema.Union([
  Schema.TaggedStruct('APPLIED', { current: ManualFxPolicyRevisionSchema }),
  Schema.TaggedStruct('UNCHANGED', { current: ManualFxPolicyRevisionSchema }),
  Schema.TaggedStruct('ACTION_INVOCATION_REUSED', { currentRevision: Schema.Int }),
  Schema.TaggedStruct('REVISION_CONFLICT', { currentRevision: Schema.Int }),
  Schema.TaggedStruct('SOURCE_REVISION_REUSED', { currentRevision: Schema.Int }),
]);
const ResolutionRoutineResultSchema = Schema.Union([
  Schema.TaggedStruct('RESOLVED', { current: ManualFxPolicyRevisionSchema }),
  Schema.TaggedStruct('NOT_CONFIGURED', {}),
  Schema.TaggedStruct('STALE', {}),
  Schema.TaggedStruct('INDETERMINATE', {}),
]);
type MutationRoutineResult = typeof MutationRoutineResultSchema.Type;
type ResolutionRoutineResult = typeof ResolutionRoutineResultSchema.Type;
type RoutineRow = typeof RoutineRowSchema.Type;

const changeManualRatePolicyRoutine = defineScopedRoutine({
  name: 'change_manual_rate_policy',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: RoutineRowSchema,
  routineKey: 'manual-rate-policy.change',
  schema: DATABASE_SCHEMA,
});

const resolveManualRatePolicyRoutine = defineScopedRoutine({
  name: 'resolve_manual_rate_policy',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: RoutineRowSchema,
  routineKey: 'manual-rate-policy.resolve-current',
  schema: DATABASE_SCHEMA,
});

const readManualRatePolicyRevisionRoutine = defineScopedRoutine({
  name: 'read_manual_rate_policy_revision',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: RoutineRowSchema,
  routineKey: 'manual-rate-policy.read-revision',
  schema: DATABASE_SCHEMA,
});

const unavailable = (routineKey: string, cause?: ManualFxFailureCause) => {
  const failure = new ManualFxRatePolicyPersistenceUnavailable({
    code: 'manual_fx_rate_policy_persistence_unavailable',
    reason: `The governed manual FX policy routine failed (${routineKey})`,
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const indeterminate = (
  reason: string,
  cause?: ManualFxFailureCause,
): FxSourceResultIndeterminateError => {
  const failure = FxSourceResultIndeterminate.make({ reason, retryable: true });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const encodeChange = (command: ChangeManualFxRatePolicyCommand) => ({
  change: command.change,
  context: command.context,
  expectedRevision: command.expectedRevision,
  reason: command.reason,
});

const decodeMutation = (
  rows: readonly RoutineRow[],
): Effect.Effect<MutationRoutineResult, ManualFxRatePolicyPersistenceUnavailable> => {
  const [row] = rows;
  if (row === undefined) {
    return Effect.fail(unavailable(INVALID_ROUTINE_RESULT));
  }
  return Schema.decodeUnknownEffect(MutationRoutineResultSchema)(row.payload).pipe(
    Effect.mapError((failure) => unavailable(INVALID_ROUTINE_RESULT, failure)),
  );
};

const decodeResolution = (
  rows: readonly RoutineRow[],
): Effect.Effect<ResolutionRoutineResult, ManualFxRatePolicyPersistenceUnavailable> => {
  const [row] = rows;
  if (row === undefined) {
    return Effect.fail(unavailable(INVALID_ROUTINE_RESULT));
  }
  return Schema.decodeUnknownEffect(ResolutionRoutineResultSchema)(row.payload).pipe(
    Effect.mapError((failure) => unavailable(INVALID_ROUTINE_RESULT, failure)),
  );
};

export interface ManualFxRatePolicyPersistence {
  readonly change: (
    command: ChangeManualFxRatePolicyCommand,
    attribution: {
      readonly actingPrincipalId: string;
      readonly actionInvocationId: string;
    },
  ) => Effect.Effect<
    ChangeManualFxRatePolicyResult,
    ManualFxRatePolicyConflict | ManualFxRatePolicyPersistenceUnavailable
  >;
}

export const makeManualFxRatePolicyPersistence = (
  transaction: CommerceFxScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<ManualFxRatePolicyPersistence, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Manual FX rate policy mutation requires Legal Entity scope',
      }),
    );
  }
  return Effect.succeed({
    change: (command, attribution) =>
      transaction
        .invoke(changeManualRatePolicyRoutine, [
          {
            ...encodeChange(command),
            actingPrincipalId: attribution.actingPrincipalId,
            actionInvocationId: attribution.actionInvocationId,
          },
        ])
        .pipe(
          Effect.mapError((failure) => unavailable(failure.routineKey)),
          Effect.flatMap(decodeMutation),
          Effect.flatMap((outcome) =>
            Match.value(outcome).pipe(
              Match.tag('APPLIED', ({ current }) => Effect.succeed({ changed: true, current })),
              Match.tag('UNCHANGED', ({ current }) => Effect.succeed({ changed: false, current })),
              Match.tag('REVISION_CONFLICT', ({ currentRevision }) =>
                Effect.fail(
                  new ManualFxRatePolicyConflict({
                    code: 'manual_fx_rate_policy_conflict',
                    conflict: 'REVISION',
                    currentRevision,
                    expectedRevision: command.expectedRevision,
                    reason: DURABLE_VERSION_CONFLICT_REASON,
                  }),
                ),
              ),
              Match.tag('SOURCE_REVISION_REUSED', ({ currentRevision }) =>
                Effect.fail(
                  new ManualFxRatePolicyConflict({
                    code: 'manual_fx_rate_policy_conflict',
                    conflict: 'SOURCE_REVISION_REUSED',
                    currentRevision,
                    expectedRevision: command.expectedRevision,
                    reason: DURABLE_VERSION_CONFLICT_REASON,
                  }),
                ),
              ),
              Match.tag('ACTION_INVOCATION_REUSED', ({ currentRevision }) =>
                Effect.fail(
                  new ManualFxRatePolicyConflict({
                    code: 'manual_fx_rate_policy_conflict',
                    conflict: 'ACTION_INVOCATION_REUSED',
                    currentRevision,
                    expectedRevision: command.expectedRevision,
                    reason: DURABLE_VERSION_CONFLICT_REASON,
                  }),
                ),
              ),
              Match.exhaustive,
            ),
          ),
        ),
  });
};

const conversionContextValues = (request: CommercialFxConversionRequest) =>
  [
    request.purchasingContext.channelId,
    request.purchasingContext.marketId,
    request.purchasingContext.storefrontId,
    request.purpose,
    request.sourceAmount.currencyCode,
    request.targetCurrencyCode,
  ] as const;

const resolveCurrentRevision = (
  transaction: CommerceFxScopedRoutineInvoker,
  request: CommercialFxConversionRequest,
): Effect.Effect<
  ManualFxPolicyRevision,
  FxRateExpiredOrStaleError | FxSourceNotConfiguredError | FxSourceResultIndeterminateError
> => {
  const decoded = transaction
    .invoke(resolveManualRatePolicyRoutine, [
      ...conversionContextValues(request),
      DateTime.formatIso(request.requestedAt),
    ])
    .pipe(
      Effect.mapError((failure) =>
        indeterminate('The manual FX policy store is temporarily unavailable', failure),
      ),
      Effect.flatMap((rows) =>
        decodeResolution(rows).pipe(
          Effect.mapError((failure) =>
            indeterminate('The manual FX policy store returned an invalid result', failure),
          ),
        ),
      ),
    );
  return decoded.pipe(
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.tag('RESOLVED', ({ current }) => Effect.succeed(current)),
        Match.tag('NOT_CONFIGURED', () =>
          Effect.fail(
            FxSourceNotConfigured.make({
              reason: 'No manual FX policy is configured for the exact purchasing context',
            }),
          ),
        ),
        Match.tag('STALE', () =>
          Effect.fail(
            FxRateExpiredOrStale.make({
              reason: 'The selected manual FX policy is outside its Effective Period',
            }),
          ),
        ),
        Match.tag('INDETERMINATE', () =>
          Effect.fail(
            FxSourceResultIndeterminate.make({
              reason: 'The manual FX policy history is inconsistent',
              retryable: true,
            }),
          ),
        ),
        Match.exhaustive,
      ),
    ),
  );
};

const conversionPolicy = (current: ManualFxPolicyRevision): FxConversionPolicy | undefined =>
  current.change.operation === 'SET'
    ? {
        arithmeticVersion: current.change.arithmeticVersion,
        inverseRatePermitted: current.change.inverseRatePermitted,
        maximumRateAgeSeconds: current.change.maximumRateAgeSeconds,
        policyRevision: current.policyRevisionId,
        purpose: current.context.purpose,
        rateSourceId: current.change.rateSourceId,
        roundingIncrement: current.change.roundingIncrement,
        roundingMode: current.change.roundingMode,
        roundingRule: COMMERCIAL_FX_ROUNDING_RULE,
        roundingRuleRevision: current.change.roundingRuleRevision,
        targetMinorUnits: current.change.targetMinorUnits,
      }
    : undefined;

const exactRevision = (
  transaction: CommerceFxScopedRoutineInvoker,
  request: CommercialFxConversionRequest,
  policyRevision: string,
): Effect.Effect<ManualFxPolicyRevision, FxSourceResultIndeterminateError> =>
  transaction
    .invoke(readManualRatePolicyRevisionRoutine, [
      policyRevision,
      ...conversionContextValues(request),
    ])
    .pipe(
      Effect.mapError((failure) =>
        indeterminate('The selected manual FX revision is temporarily unavailable', failure),
      ),
      Effect.flatMap((rows) =>
        decodeResolution(rows).pipe(
          Effect.mapError((failure) =>
            indeterminate('The selected manual FX revision returned invalid evidence', failure),
          ),
        ),
      ),
      Effect.flatMap((outcome) =>
        Match.value(outcome).pipe(
          Match.tag('RESOLVED', ({ current }) => Effect.succeed(current)),
          Match.tag('NOT_CONFIGURED', 'STALE', 'INDETERMINATE', () =>
            Effect.fail(
              FxSourceResultIndeterminate.make({
                reason: 'The selected manual FX revision no longer matches the decision context',
                retryable: true,
              }),
            ),
          ),
          Match.exhaustive,
        ),
      ),
    );

/** Production policy/rate source for versioned manual facts. Trusted context remains a separate port. */
// eslint-disable-next-line effect-native/no-wide-factory-signature -- This required production adapter factory receives one governed invoker plus verified scope data and its authoritative context port.
export const makeManualCommercialFxPorts = (
  transaction: CommerceFxScopedRoutineInvoker,
  scope: ManualCommercialFxVerifiedScope,
  authoritativeContextPort: CommercialFxContextPort,
): CommercialFxPorts => ({
  context: authoritativeContextPort,
  policy: {
    resolve: (
      request,
    ): Effect.Effect<
      FxConversionPolicy,
      FxRateExpiredOrStaleError | FxSourceNotConfiguredError | FxSourceResultIndeterminateError
    > => {
      if (
        request.purchasingContext.tenantId !== scope.tenantId ||
        request.purchasingContext.sellingLegalEntityId !== scope.legalEntityId ||
        request.purchasingContext.storefrontId !== scope.trustedStorefrontId
      ) {
        return Effect.fail(
          FxSourceResultIndeterminate.make({
            reason: 'The manual FX policy request is outside the verified operation scope',
            retryable: true,
          }),
        );
      }
      return resolveCurrentRevision(transaction, request).pipe(
        Effect.flatMap((current): Effect.Effect<FxConversionPolicy, FxSourceNotConfiguredError> => {
          const policy = conversionPolicy(current);
          return policy === undefined
            ? Effect.fail(
                FxSourceNotConfigured.make({
                  reason: 'The manual FX policy was explicitly withdrawn',
                }),
              )
            : Effect.succeed(policy);
        }),
      );
    },
  },
  rate: {
    quote: ({
      policy,
      request,
    }): Effect.Effect<FxRateQuote, FxRateUnavailableError | FxSourceResultIndeterminateError> =>
      exactRevision(transaction, request, policy.policyRevision).pipe(
        Effect.flatMap(
          (
            current,
          ): Effect.Effect<
            FxRateQuote,
            FxRateUnavailableError | FxSourceResultIndeterminateError
          > => {
            if (current.change.operation !== 'SET') {
              return Effect.fail(
                FxRateUnavailable.make({
                  reason: 'The selected manual FX policy is not an active rate fact',
                  retryable: true,
                }),
              );
            }
            if (
              current.change.rateSourceId !== policy.rateSourceId ||
              current.context.purpose !== policy.purpose
            ) {
              return Effect.fail(
                FxSourceResultIndeterminate.make({
                  reason: 'The selected manual FX rate disagrees with its policy decision',
                  retryable: true,
                }),
              );
            }
            const quote: FxRateQuote = {
              direction: current.change.direction,
              observedAt: DateTime.makeUnsafe(current.change.rateObservedAt),
              providerCorrelationRef: `manual:${current.policyRevisionId}:${current.change.sourceRevision}`,
              rate: current.change.rate,
              rateSourceId: current.change.rateSourceId,
              retrievedAt: request.requestedAt,
              sourceCurrencyCode: current.context.sourceCurrencyCode,
              targetCurrencyCode: current.context.targetCurrencyCode,
              validFrom: DateTime.makeUnsafe(current.change.effectiveFrom),
              validTo: DateTime.makeUnsafe(current.change.effectiveTo),
            };
            return Effect.succeed(quote);
          },
        ),
      ),
  },
});

export const ManualCommercialFxPortsFactoryLive = Layer.succeed(ManualCommercialFxPortsFactory, {
  make: makeManualCommercialFxPorts,
});

export const manualFxRatePolicyRoutineAllowlist = Object.freeze([
  changeManualRatePolicyRoutine,
  resolveManualRatePolicyRoutine,
  readManualRatePolicyRevisionRoutine,
]);

export const decodeManualFxPolicyResult = Schema.decodeUnknownEffect(
  ChangeManualFxRatePolicyResultSchema,
);
