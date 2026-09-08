import { SqlError, isSqlError } from 'effect/unstable/sql/SqlError';
/* oxlint-disable sonarjs/no-duplicate-string -- Existing compatibility boundary; expires: 2026-12-31. */
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import { computeCanonicalValueHash } from '../actions/repository.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import { ContextAccess, LEGAL_ENTITY_PERMISSION_KEYS } from '../permissions/context-access.ts';
import { validateReadEvidenceMetadata } from './context.ts';
import type {
  AtomicResolvedReadPermissionTarget,
  ReadRegistration,
  ResolvedReadPermissionTarget,
} from './definition.ts';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
  getReadPolicyImplementations,
  getReadResultPermissionTargetResolver,
  getReadServiceFactory,
} from './definition.ts';
import type { ReadCoreError } from './errors.ts';
import {
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadPolicyEvaluationError,
  ReadResultValidationError,
} from './errors.ts';
import { persistReadEvidence } from './repository.ts';

const withOptionalProperty = <
  const Base extends object,
  const Key extends PropertyKey,
  const Value,
  const Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const CorrelationIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadCorrelationId'),
);
const TargetModuleKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadTargetModuleKey'),
);
const TargetResourceIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadTargetResourceId'),
);
const TargetResourceTypeSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadTargetResourceType'),
);
const TraceIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTraceId'));

const ReadTransportSchema = Schema.Struct({
  correlationId: CorrelationIdSchema,
  targetModuleKey: Schema.optionalKey(TargetModuleKeySchema),
  targetResourceId: Schema.optionalKey(TargetResourceIdSchema),
  targetResourceType: Schema.optionalKey(TargetResourceTypeSchema),
  traceId: Schema.optionalKey(TraceIdSchema),
});

export const READ_RUNTIME_STAGES = [
  'input_decoded',
  'scope_validated',
  'module_state_checked',
  'permission_checked',
  'policies_checked',
  'scope_installed',
  'handler_executed',
  'result_decoded',
  'evidence_persisted',
] as const;
export type ReadRuntimeStage = (typeof READ_RUNTIME_STAGES)[number];

export interface ReadRuntimeOptions {
  readonly onStage?: (stage: ReadRuntimeStage) => void;
}

const stableTargetKey = (value: string): boolean => value.length > 0 && value.length <= 300;
const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;
const atomicTargetIsValid = (target: AtomicResolvedReadPermissionTarget): boolean => {
  if (target.kind === 'tenant') {
    return true;
  }
  if (target.kind === 'legal_entity') {
    return (
      target.permission === undefined ||
      LEGAL_ENTITY_PERMISSION_KEYS.some((permission) => permission === target.permission)
    );
  }
  if (target.kind === 'module') {
    return stableTargetKey(target.moduleId);
  }
  return (
    stableTargetKey(target.resource.moduleId) &&
    stableTargetKey(target.resource.resourceId) &&
    stableTargetKey(target.resource.resourceType)
  );
};

const usesForbiddenAlternativeTenantPermission = (
  target: AtomicResolvedReadPermissionTarget,
): boolean =>
  target.kind === 'tenant' &&
  (target.permission === 'access' || target.permission === 'impersonate');

const canonicalPermissionTarget = (
  target: ResolvedReadPermissionTarget,
): AtomicResolvedReadPermissionTarget => (target.kind === 'any_of' ? target.targets[0] : target);

const targetIsValid = (
  declared: 'legal_entity' | 'module' | 'resource' | 'tenant',
  target: ResolvedReadPermissionTarget,
): boolean => {
  const canonical = canonicalPermissionTarget(target);
  if (canonical.kind !== declared || !atomicTargetIsValid(canonical)) {
    return false;
  }
  if (target.kind !== 'any_of') {
    return true;
  }
  return (
    target.targets.length >= 2 &&
    target.targets.length <= 5 &&
    target.targets.every(
      (candidate) =>
        atomicTargetIsValid(candidate) && !usesForbiddenAlternativeTenantPermission(candidate),
    )
  );
};

const targetMetadata = (target: ResolvedReadPermissionTarget) => {
  const canonical = canonicalPermissionTarget(target);
  if (canonical.kind === 'legal_entity' || canonical.kind === 'tenant') {
    return {};
  }
  if (canonical.kind === 'module') {
    return { targetModuleKey: canonical.moduleId };
  }
  return {
    targetModuleKey: canonical.resource.moduleId,
    targetResourceId: canonical.resource.resourceId,
    targetResourceType: canonical.resource.resourceType,
  };
};

const decisionFor = (
  decisions: readonly { readonly decision: PermissionDecision; readonly key: string }[],
  expectedKey: string,
): PermissionDecision => {
  const [decision, ...unexpected] = decisions;
  return unexpected.length === 0 && decision?.key === expectedKey
    ? decision.decision
    : 'unavailable';
};

const checkAtomicPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: AtomicResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  if (target.kind === 'tenant') {
    return contextAccess
      .tenants({
        permission: target.permission,
        principalId: scope.principalId,
        tenantIds: [scope.tenantId],
      })
      .pipe(Effect.map((decisions) => decisionFor(decisions, scope.tenantId)));
  }
  if (scope.legalEntityId === undefined) {
    return Effect.succeed(allowMissingLegalEntity ? 'allowed' : 'unavailable');
  }
  const { legalEntityId } = scope;
  if (target.kind === 'legal_entity') {
    const decision =
      target.permission === undefined
        ? contextAccess.legalEntities({
            legalEntityIds: [legalEntityId],
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          })
        : contextAccess.legalEntities({
            legalEntityIds: [legalEntityId],
            permission: target.permission,
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          });
    return decision.pipe(Effect.map((decisions) => decisionFor(decisions, legalEntityId)));
  }
  if (target.kind === 'module') {
    return contextAccess
      .modules({
        legalEntityId,
        moduleIds: [target.moduleId],
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      })
      .pipe(Effect.map((decisions) => decisionFor(decisions, target.moduleId)));
  }
  const expectedKey = `${target.resource.moduleId}:${target.resource.resourceType}:${target.resource.resourceId}`;
  return contextAccess
    .resources({
      legalEntityId,
      principalId: scope.principalId,
      resources: [target.resource],
      tenantId: scope.tenantId,
    })
    .pipe(Effect.map((decisions) => decisionFor(decisions, expectedKey)));
};

const checkPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: ResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  const targets = target.kind === 'any_of' ? target.targets : [target];
  const mayAuthorizeWithoutLegalEntity = allowMissingLegalEntity && target.kind !== 'any_of';
  return Effect.all(
    targets.map((candidate) =>
      checkAtomicPermissionTarget(contextAccess, scope, candidate, mayAuthorizeWithoutLegalEntity),
    ),
    { concurrency: 5 },
  ).pipe(
    Effect.map((decisions) => {
      if (decisions.includes('allowed')) {
        return 'allowed';
      }
      return decisions.includes('unavailable') ? 'unavailable' : 'denied';
    }),
  );
};

const sanitizeReadHandlerFailure = <Failure>(failure: Failure) =>
  Schema.is(ReadHandlerUnavailable)(failure) ||
  Schema.is(ReadHandlerNotFound)(failure) ||
  Schema.is(ReadPermissionDenied)(failure)
    ? failure
    : new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The read handler failed unexpectedly',
      });

const preserveFailureCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });

const checkTenantResultPermission = Effect.fnUntraced(function* checkTenantResultPermission<
  AccessValue extends (typeof ContextAccess)['Service'],
>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  permissionTarget: Extract<ResolvedReadPermissionTarget, { kind: 'tenant' }>,
) {
  const decisions = yield* contextAccess.tenants({
    permission: permissionTarget.permission,
    principalId: scope.principalId,
    tenantIds: [scope.tenantId],
  });
  const decision = decisionFor(decisions, scope.tenantId);
  if (decision === 'unavailable') {
    return yield* new ReadPermissionUnavailable({
      code: 'read_permission_unavailable',
      reason: 'Read result authorization is temporarily unavailable',
    });
  }
  if (decision === 'denied') {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'The read result contains a forbidden resource',
    });
  }
  return yield* Effect.void;
});

const checkResultPermissions = Effect.fn('ReadRuntime.checkResultPermissions')(
  function* checkResultPermissionsEffect<
    Result,
    AccessValue extends (typeof ContextAccess)['Service'],
  >(
    contextAccess: AccessValue,
    result: Result,
    scope: OperationalScope,
    permissionTarget: ResolvedReadPermissionTarget,
    resolver: (
      result: Result,
      scope: OperationalScope,
    ) => readonly {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }[],
  ) {
    const resultTargets = yield* Effect.try({
      catch: (resolverDefect) =>
        preserveFailureCause(
          new ReadHandlerExecutionError({
            code: 'read_handler_execution_failed',
            reason: 'The read result permission targets are invalid',
          }),
          resolverDefect,
        ),
      try: () => resolver(result, scope),
    });
    if (
      resultTargets.some(
        (target) =>
          !stableTargetKey(target.moduleId) ||
          !stableTargetKey(target.resourceId) ||
          !stableTargetKey(target.resourceType),
      )
    ) {
      return yield* new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The read result permission targets are invalid',
      });
    }
    if (resultTargets.length === 0) {
      return yield* Effect.void;
    }
    if (permissionTarget.kind === 'tenant') {
      return yield* checkTenantResultPermission(contextAccess, scope, permissionTarget);
    }
    if (scope.legalEntityId === undefined) {
      return yield* new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The read result permission targets are invalid',
      });
    }
    const decisions = yield* contextAccess.resources({
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      resources: resultTargets,
      tenantId: scope.tenantId,
    });
    const malformed =
      decisions.length !== resultTargets.length ||
      decisions.some(({ key }, index) => {
        const target = resultTargets[index];
        return (
          target === undefined ||
          key !== `${target.moduleId}:${target.resourceType}:${target.resourceId}`
        );
      });
    if (malformed || decisions.some(({ decision }) => decision === 'unavailable')) {
      return yield* new ReadPermissionUnavailable({
        code: 'read_permission_unavailable',
        reason: 'Read result authorization is temporarily unavailable',
      });
    }
    if (decisions.some(({ decision }) => decision === 'denied')) {
      return yield* new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The read result contains a forbidden resource',
      });
    }
    return yield* Effect.void;
  },
);

const readRuntimeFromDependencies = <
  DatabaseValue extends (typeof CoreDatabase)['Service'],
  GatewayValue extends ModuleEntrypointGatewayService,
  ScopeValue extends OperationalScopeResolverService,
  AccessValue extends (typeof ContextAccess)['Service'],
>(
  database: DatabaseValue,
  gateway: GatewayValue,
  scopeResolver: ScopeValue,
  contextAccess: AccessValue,
  options: ReadRuntimeOptions = {},
) => {
  const stage = (value: ReadRuntimeStage): void => options.onStage?.(value);

  const runRead = Effect.fn('ReadRuntime.runRead')(function* runReadEffect<
    InputSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    Owner extends string,
    Services,
    HandlerError,
    Requirements,
  >(input: {
    readonly input: unknown;
    readonly principal: unknown;
    readonly registration: ReadRegistration<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      Requirements
    >;
    readonly transport: unknown;
  }) {
    const decodedInput = yield* Schema.decodeUnknownEffect(
      input.registration.descriptor.inputSchema,
    )(input.input).pipe(
      Effect.mapError((parseIssue) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The read input does not match its declared schema',
          }),
          parseIssue,
        ),
      ),
    );
    const queryHash =
      input.registration.descriptor.evidencePolicy.captureMode === 'hash_only'
        ? yield* Effect.try({
            catch: (normalizationDefect) =>
              preserveFailureCause(
                new ReadInputValidationError({
                  code: 'read_input_invalid',
                  reason: 'The read input cannot be normalized safely',
                }),
                normalizationDefect,
              ),
            try: () => computeCanonicalValueHash(decodedInput),
          })
        : undefined;
    const principal = yield* decodeTrustedPrincipalContext(input.principal).pipe(
      Effect.filterOrFail(
        (context) => !isTrustedSupportRecoveryPrincipalContext(context),
        () =>
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'Support recovery context is not valid for Reads',
          }),
      ),
      Effect.mapError((principalFailure) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The trusted read identity is invalid',
          }),
          principalFailure,
        ),
      ),
    );
    const transport = yield* Schema.decodeUnknownEffect(ReadTransportSchema)(input.transport).pipe(
      Effect.mapError((parseIssue) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The read transport metadata is invalid',
          }),
          parseIssue,
        ),
      ),
    );
    stage('input_decoded');
    const scope = yield* scopeResolver.resolve(
      withOptionalProperty(
        {
          correlationId: transport.correlationId,
          legalEntityScope: input.registration.descriptor.legalEntityScope,
          principal,
        },
        transport.traceId !== undefined,
        'traceId',
        transport.traceId,
        {},
      ),
    );
    stage('scope_validated');
    const permissionTarget = yield* Effect.try({
      catch: (resolverDefect) =>
        preserveFailureCause(
          new ReadHandlerExecutionError({
            code: 'read_handler_execution_failed',
            reason: 'The declared read permission target could not be resolved',
          }),
          resolverDefect,
        ),
      try: () => getReadPermissionTargetResolver(input.registration)(decodedInput, scope),
    });
    if (
      !targetIsValid(input.registration.descriptor.permissionTarget, permissionTarget) ||
      (getReadResultPermissionTargetResolver(input.registration) !== undefined &&
        permissionTarget.kind === 'any_of')
    ) {
      return yield* new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The declared read permission target is invalid',
      });
    }
    const permissionTargetMetadata = targetMetadata(permissionTarget);
    const snapshot = yield* gateway.prepareSnapshot(scope, [
      input.registration.descriptor.entrypoint,
    ]);
    yield* gateway.check(snapshot, input.registration.descriptor.entrypoint);
    stage('module_state_checked');

    const permissionDecision = yield* checkPermissionTarget(
      contextAccess,
      scope,
      permissionTarget,
      input.registration.descriptor.legalEntityScope === 'forbidden',
    );
    stage('permission_checked');
    if (permissionDecision === 'denied') {
      yield* persistReadEvidence(
        database.executor,
        withOptionalProperty(
          {
            accessKind: input.registration.descriptor.accessKind,
            captureMode: input.registration.descriptor.evidencePolicy.captureMode,
            outcome: 'denied',
            outcomeCode: 'spicedb_permission_denied',
            outcomeStage: 'authz',
            policyKey: input.registration.descriptor.evidencePolicy.policyKey,
          },
          queryHash !== undefined,
          'queryHash',
          queryHash,
          {
            readKey: input.registration.descriptor.readKey,
            resultCount: 0,
            scope,
            servingModuleKey: input.registration.descriptor.owningModuleKey,
            ...permissionTargetMetadata,
          },
        ),
      );
      return yield* new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The principal is not permitted to perform this read',
      });
    }
    if (permissionDecision !== 'allowed') {
      return yield* new ReadPermissionUnavailable({
        code: 'read_permission_unavailable',
        reason: 'Read authorization is temporarily unavailable',
      });
    }

    const policies = getReadPolicyImplementations(input.registration);
    yield* Effect.forEach(
      input.registration.descriptor.policies.entries(),
      ([index, policyDescriptor]): Effect.Effect<void, ReadCoreError> => {
        const policy = policies[index];
        if (policy === undefined) {
          return Effect.fail(
            new ReadPolicyEvaluationError({
              code: 'read_policy_evaluation_failed',
              reason: 'A required read Policy is unavailable',
            }),
          );
        }
        const { descriptor } = input.registration;
        return policy
          .evaluate({
            action: {
              actionKey: descriptor.readKey,
              owningModuleKey: descriptor.owningModuleKey,
              schemaVersion: descriptor.schemaVersion,
            },
            payload: decodedInput,
            principal: scope,
            target: permissionTargetMetadata,
            transport: withOptionalProperty(
              { correlationId: transport.correlationId },
              transport.traceId !== undefined,
              'traceId',
              transport.traceId,
              {},
            ),
          })
          .pipe(
            Effect.catchTag('PolicyDenied', (failure) =>
              persistReadEvidence(
                database.executor,
                withOptionalProperty(
                  {
                    accessKind: descriptor.accessKind,
                    captureMode: descriptor.evidencePolicy.captureMode,
                    outcome: 'denied',
                    outcomeCode: failure.reasonCode,
                    outcomeStage: 'policy',
                    policyKey: descriptor.evidencePolicy.policyKey,
                  },
                  queryHash !== undefined,
                  'queryHash',
                  queryHash,
                  {
                    readKey: descriptor.readKey,
                    resultCount: 0,
                    scope,
                    servingModuleKey: descriptor.owningModuleKey,
                  },
                ),
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ReadPolicyDenied({
                      code: 'read_policy_denied',
                      httpStatus: policyDescriptor.denialStatus,
                      policyReasonCode: failure.reasonCode,
                      reason: failure.reason,
                    }),
                  ),
                ),
              ),
            ),
          );
      },
      { concurrency: 1, discard: true },
    );
    stage('policies_checked');

    const transactionResult = database.executor
      .transaction(
        Effect.fn('ReadRuntime.readTransactionBody')(function* readTransactionBody(
          transaction: CoreTransaction,
        ) {
          const scoped = yield* installOperationalScope(transaction, scope);
          stage('scope_installed');
          const services = yield* getReadServiceFactory(input.registration)(scoped, scope);
          const handlerResult = yield* Effect.suspend(() =>
            getReadHandler(input.registration)(
              decodedInput,
              Object.freeze({
                readKey: input.registration.descriptor.readKey,
                scope,
                services,
              }),
            ),
          ).pipe(Effect.mapError(sanitizeReadHandlerFailure));
          stage('handler_executed');
          const result = yield* Schema.decodeUnknownEffect(
            Schema.toType(input.registration.descriptor.resultSchema),
          )(handlerResult.result).pipe(
            Effect.mapError((parseIssue) =>
              preserveFailureCause(
                new ReadResultValidationError({
                  code: 'read_result_invalid',
                  reason: 'The read result does not match its declared schema',
                }),
                parseIssue,
              ),
            ),
          );
          stage('result_decoded');
          const resultPermissionResolver = getReadResultPermissionTargetResolver(
            input.registration,
          );
          if (resultPermissionResolver !== undefined) {
            yield* checkResultPermissions(
              contextAccess,
              result,
              scope,
              permissionTarget,
              resultPermissionResolver,
            );
          }
          const evidence = yield* validateReadEvidenceMetadata(
            input.registration.descriptor.evidencePolicy.captureMode,
            handlerResult.evidence,
          );
          yield* persistReadEvidence(
            transaction,
            withOptionalProperty(
              withOptionalProperty(
                withOptionalProperty(
                  {
                    accessKind: input.registration.descriptor.accessKind,
                    captureMode: input.registration.descriptor.evidencePolicy.captureMode,
                    outcome: 'allowed',
                    outcomeCode: 'read_allowed',
                    outcomeStage: 'evidence',
                    policyKey: input.registration.descriptor.evidencePolicy.policyKey,
                  },
                  queryHash !== undefined,
                  'queryHash',
                  queryHash,
                  {
                    readKey: input.registration.descriptor.readKey,
                    resultCount: evidence.resultCount,
                  },
                ),
                evidence.resultFingerprintHash !== undefined,
                'resultFingerprintHash',
                evidence.resultFingerprintHash,
                {},
              ),
              evidence.resultFingerprintSchema !== undefined,
              'resultFingerprintSchema',
              evidence.resultFingerprintSchema,
              {
                scope,
                servingModuleKey: input.registration.descriptor.owningModuleKey,
                ...permissionTargetMetadata,
              },
            ),
          );
          stage('evidence_persisted');
          return result;
        }),
      )
      .pipe(
        Effect.catchDefect((defect) =>
          isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect),
        ),
        Effect.tapError((failure) =>
          Schema.is(SqlError)(failure)
            ? Effect.logError('Unexpected governed read transaction failure', failure)
            : Effect.void,
        ),
        Effect.mapError((transactionFailure) =>
          Schema.is(SqlError)(transactionFailure)
            ? preserveFailureCause(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The governed read transaction failed',
                }),
                transactionFailure,
              )
            : transactionFailure,
        ),
      );
    const transactionExit = yield* Effect.exit(transactionResult);
    if (Exit.isSuccess(transactionExit)) {
      return transactionExit.value;
    }
    const { cause } = transactionExit;
    if (
      !cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && Schema.is(ReadPermissionDenied)(reason.error),
      )
    ) {
      return yield* Effect.failCause(cause);
    }
    const evidenceExit = yield* Effect.exit(
      persistReadEvidence(
        database.executor,
        withOptionalProperty(
          {
            accessKind: input.registration.descriptor.accessKind,
            captureMode: input.registration.descriptor.evidencePolicy.captureMode,
            outcome: 'denied',
            outcomeCode: 'read_permission_denied',
            outcomeStage: 'authz',
            policyKey: input.registration.descriptor.evidencePolicy.policyKey,
          },
          queryHash !== undefined,
          'queryHash',
          queryHash,
          {
            readKey: input.registration.descriptor.readKey,
            resultCount: 0,
            scope,
            servingModuleKey: input.registration.descriptor.owningModuleKey,
            ...permissionTargetMetadata,
          },
        ),
      ),
    );
    return yield* Effect.failCause(
      Exit.isFailure(evidenceExit) ? Cause.combine(evidenceExit.cause, cause) : cause,
    );
  });

  return Object.freeze({ runRead });
};

export { readRuntimeFromDependencies as makeReadRuntime };

export type ReadRuntimeService = ReturnType<typeof readRuntimeFromDependencies>;

export class ReadRuntime extends Context.Service<ReadRuntime, ReadRuntimeService>()(
  '@app/core-runtime/reads/runtime/ReadRuntime',
) {}

export const ReadRuntimeLive = Layer.effect(
  ReadRuntime,
  Effect.gen(function* makeReadRuntimeService() {
    const database = yield* CoreDatabase;
    const gateway = yield* ModuleEntrypointGateway;
    const scopeResolver = yield* OperationalScopeResolver;
    const contextAccess = yield* ContextAccess;
    return readRuntimeFromDependencies(database, gateway, scopeResolver, contextAccess);
  }),
);
