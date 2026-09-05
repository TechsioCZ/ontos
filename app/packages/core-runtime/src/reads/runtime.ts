/* oxlint-disable sonarjs/no-duplicate-string */
/* eslint-disable complexity, max-classes-per-file -- The governed lifecycle and its private failure diagnostics stay co-located and ordered. */
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../auth/system-principal-context-provenance.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { runCoreTransaction, CoreTransactionBridgeFailure } from '../db/transaction-bridge.ts';
import {
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayLive,
} from '../modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import {
  ContextAccess,
  ContextAccessLive,
  LEGAL_ENTITY_PERMISSION_KEYS,
} from '../permissions/context-access.ts';
import { OperationalScopeResolver, OperationalScopeResolverLive } from '../operations/context.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import { PolicyDenied } from '../actions/policy.ts';
import { computeCanonicalValueHash } from '../actions/repository.ts';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
  getReadPolicyImplementations,
  getReadResultPermissionTargetResolver,
  getReadServiceFactory,
} from './definition.ts';
import type {
  AtomicResolvedReadPermissionTarget,
  ReadRegistration,
  ResolvedReadPermissionTarget,
} from './definition.ts';
import { validateReadEvidenceMetadata } from './context.ts';
import { persistReadEvidence } from './repository.ts';
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
import type { ReadCoreError } from './errors.ts';

// Diagnostic data in the Effect error channel, never an exception or rollback signal.
class ReadTransactionFailure {
  readonly error: ReadCoreError;
  readonly defectCause: Cause.Cause<unknown> | undefined;

  constructor(error: ReadCoreError, defectCause?: Cause.Cause<unknown>) {
    this.error = error;
    this.defectCause = defectCause;
  }
}

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

const ReadTransportSchema = Schema.Struct({
  correlationId: Schema.String.check(Schema.isMinLength(1)),
  targetModuleKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  targetResourceId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  targetResourceType: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  traceId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
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
type PermissionDecision = 'allowed' | 'denied' | 'unavailable';
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

const checkAtomicPermissionTarget = (
  contextAccess: (typeof ContextAccess)['Service'],
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

const checkPermissionTarget = (
  contextAccess: (typeof ContextAccess)['Service'],
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
  ).pipe(
    Effect.map((decisions) => {
      if (decisions.includes('allowed')) {
        return 'allowed';
      }
      return decisions.includes('unavailable') ? 'unavailable' : 'denied';
    }),
  );
};

export const makeReadRuntime = (
  database: (typeof CoreDatabase)['Service'],
  gateway: ModuleEntrypointGatewayService,
  scopeResolver: OperationalScopeResolverService,
  contextAccess: (typeof ContextAccess)['Service'],
  options: ReadRuntimeOptions = {},
) => {
  const stage = (value: ReadRuntimeStage): void => options.onStage?.(value);

  const runRead = <
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
  }): Effect.Effect<ResultSchema['Type'], ReadCoreError, Requirements> =>
    Effect.gen(function* governedRead() {
      const decodedInput = yield* Schema.decodeUnknownEffect(
        input.registration.descriptor.inputSchema,
      )(input.input).pipe(
        Effect.mapError(
          () =>
            new ReadInputValidationError({
              code: 'read_input_invalid',
              reason: 'The read input does not match its declared schema',
            }),
        ),
      );
      const queryHash =
        input.registration.descriptor.evidencePolicy.captureMode === 'hash_only'
          ? yield* Effect.try({
              catch: () =>
                new ReadInputValidationError({
                  code: 'read_input_invalid',
                  reason: 'The read input cannot be normalized safely',
                }),
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
        Effect.mapError(
          () =>
            new ReadInputValidationError({
              code: 'read_input_invalid',
              reason: 'The trusted read identity is invalid',
            }),
        ),
      );
      const transport = yield* Schema.decodeUnknownEffect(ReadTransportSchema)(
        input.transport,
      ).pipe(
        Effect.mapError(
          () =>
            new ReadInputValidationError({
              code: 'read_input_invalid',
              reason: 'The read transport metadata is invalid',
            }),
        ),
      );
      stage('input_decoded');
      const scopeExit = yield* Effect.exit(
        scopeResolver.resolve(
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
        ),
      );
      if (Exit.isFailure(scopeExit)) {
        const failure = Cause.findErrorOption(scopeExit.cause);
        if (
          !Cause.hasDies(scopeExit.cause) &&
          !Cause.hasInterrupts(scopeExit.cause) &&
          failure._tag === 'Some'
        ) {
          return yield* failure.value;
        }
        yield* Effect.annotateLogs(
          Effect.logError('Unexpected operational scope resolution defect', scopeExit.cause),
          {
            correlationId: transport.correlationId,
            readKey: input.registration.descriptor.readKey,
          },
        );
        return yield* new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The governed read context could not be resolved',
        });
      }
      const scope = scopeExit.value;
      stage('scope_validated');
      const permissionTargetExit = yield* Effect.exit(
        Effect.sync(() => getReadPermissionTargetResolver(input.registration)(decodedInput, scope)),
      );
      if (Exit.isFailure(permissionTargetExit)) {
        yield* Effect.annotateLogs(
          Effect.logError(
            'Unexpected read permission-target resolver defect',
            permissionTargetExit.cause,
          ),
          { correlationId: scope.correlationId, readKey: input.registration.descriptor.readKey },
        );
        return yield* new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The declared read permission target could not be resolved',
        });
      }
      const permissionTarget = permissionTargetExit.value;
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
      for (const [index, policyDescriptor] of input.registration.descriptor.policies.entries()) {
        const policy = policies[index];
        if (policy === undefined) {
          return yield* new ReadPolicyEvaluationError({
            code: 'read_policy_evaluation_failed',
            reason: 'A required read Policy is unavailable',
          });
        }
        const { denialStatus } = policyDescriptor;
        const { descriptor } = input.registration;
        const policyExit = yield* Effect.exit(
          policy.evaluate({
            action: {
              actionKey: descriptor.readKey,
              owningModuleKey: descriptor.owningModuleKey,
              schemaVersion: descriptor.schemaVersion,
            },
            payload: decodedInput,
            principal: scope,
            target: permissionTargetMetadata,
            transport: withOptionalProperty(
              {
                correlationId: transport.correlationId,
              },
              transport.traceId !== undefined,
              'traceId',
              transport.traceId,
              {},
            ),
          }),
        );
        if (Exit.isSuccess(policyExit)) {
          continue;
        }
        const failure = Cause.findErrorOption(policyExit.cause);
        if (
          !Cause.hasDies(policyExit.cause) &&
          !Cause.hasInterrupts(policyExit.cause) &&
          failure._tag === 'Some' &&
          Schema.is(PolicyDenied)(failure.value)
        ) {
          yield* persistReadEvidence(
            database.executor,
            withOptionalProperty(
              {
                accessKind: input.registration.descriptor.accessKind,
                captureMode: input.registration.descriptor.evidencePolicy.captureMode,
                outcome: 'denied',
                outcomeCode: failure.value.reasonCode,
                outcomeStage: 'policy',
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
              },
            ),
          );
          return yield* new ReadPolicyDenied({
            code: 'read_policy_denied',
            httpStatus: denialStatus,
            policyReasonCode: failure.value.reasonCode,
            reason: failure.value.reason,
          });
        }
        yield* Effect.annotateLogs(
          Effect.logError('Unexpected governed read Policy evaluation failure', policyExit.cause),
          {
            correlationId: scope.correlationId,
            policyKey: policy.policyKey,
            readKey: input.registration.descriptor.readKey,
          },
        );
        return yield* new ReadPolicyEvaluationError({
          code: 'read_policy_evaluation_failed',
          reason: 'A required read Policy could not be evaluated',
        });
      }
      stage('policies_checked');

      const transactionResult = yield* runCoreTransaction(database.executor, (transaction) =>
        Effect.gen(function* readTransaction() {
          const scoped = yield* installOperationalScope(transaction, scope);
          stage('scope_installed');
          const serviceExit = yield* Effect.exit(
            Effect.suspend(() => getReadServiceFactory(input.registration)(scoped, scope)),
          );
          if (Exit.isFailure(serviceExit)) {
            const serviceFailure = Cause.findErrorOption(serviceExit.cause);
            if (
              !Cause.hasDies(serviceExit.cause) &&
              !Cause.hasInterrupts(serviceExit.cause) &&
              serviceFailure._tag === 'Some' &&
              Schema.is(OperationContextUnavailable)(serviceFailure.value)
            ) {
              return yield* Effect.fail(new ReadTransactionFailure(serviceFailure.value));
            }
            return yield* Effect.fail(
              new ReadTransactionFailure(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The read service factory failed unexpectedly',
                }),
                serviceExit.cause,
              ),
            );
          }
          const services = serviceExit.value;
          const handlerExit = yield* Effect.exit(
            Effect.suspend(() =>
              getReadHandler(input.registration)(
                decodedInput,
                Object.freeze({ readKey: input.registration.descriptor.readKey, scope, services }),
              ),
            ),
          );
          if (Exit.isFailure(handlerExit)) {
            const handlerFailure = Cause.findErrorOption(handlerExit.cause);
            if (
              !Cause.hasDies(handlerExit.cause) &&
              !Cause.hasInterrupts(handlerExit.cause) &&
              handlerFailure._tag === 'Some' &&
              (Schema.is(ReadHandlerUnavailable)(handlerFailure.value) ||
                Schema.is(ReadHandlerNotFound)(handlerFailure.value) ||
                Schema.is(ReadPermissionDenied)(handlerFailure.value))
            ) {
              return yield* Effect.fail(new ReadTransactionFailure(handlerFailure.value));
            }
            return yield* Effect.fail(
              new ReadTransactionFailure(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The read handler failed unexpectedly',
                }),
                handlerExit.cause,
              ),
            );
          }
          stage('handler_executed');
          const result = yield* Schema.decodeUnknownEffect(
            input.registration.descriptor.resultSchema,
          )(handlerExit.value.result).pipe(
            Effect.mapError(
              () =>
                new ReadResultValidationError({
                  code: 'read_result_invalid',
                  reason: 'The read result does not match its declared schema',
                }),
            ),
          );
          stage('result_decoded');
          const resultPermissionResolver = getReadResultPermissionTargetResolver(
            input.registration,
          );
          if (resultPermissionResolver !== undefined) {
            const resultTargets = yield* Effect.try({
              try: () => resultPermissionResolver(result, scope),
              catch: (error) =>
                new ReadTransactionFailure(
                  new ReadHandlerExecutionError({
                    code: 'read_handler_execution_failed',
                    reason: 'The read result permission targets are invalid',
                  }),
                  Cause.die(error),
                ),
            });
            if (
              resultTargets.some(
                (target) =>
                  !stableTargetKey(target.moduleId) ||
                  !stableTargetKey(target.resourceId) ||
                  !stableTargetKey(target.resourceType),
              )
            ) {
              return yield* Effect.fail(
                new ReadTransactionFailure(
                  new ReadHandlerExecutionError({
                    code: 'read_handler_execution_failed',
                    reason: 'The read result permission targets are invalid',
                  }),
                ),
              );
            }
            if (resultTargets.length > 0) {
              if (permissionTarget.kind === 'tenant') {
                const resultPermissionExit = yield* Effect.exit(
                  contextAccess.tenants({
                    permission: permissionTarget.permission,
                    principalId: scope.principalId,
                    tenantIds: [scope.tenantId],
                  }),
                );
                if (Exit.isFailure(resultPermissionExit)) {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionUnavailable({
                        code: 'read_permission_unavailable',
                        reason: 'Read result authorization is temporarily unavailable',
                      }),
                      resultPermissionExit.cause,
                    ),
                  );
                }
                const [decision, ...unexpected] = resultPermissionExit.value;
                if (
                  unexpected.length > 0 ||
                  decision?.key !== scope.tenantId ||
                  decision.decision === 'unavailable'
                ) {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionUnavailable({
                        code: 'read_permission_unavailable',
                        reason: 'Read result authorization is temporarily unavailable',
                      }),
                    ),
                  );
                }
                if (decision.decision === 'denied') {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionDenied({
                        code: 'read_permission_denied',
                        reason: 'The read result contains a forbidden resource',
                      }),
                    ),
                  );
                }
              } else {
                if (scope.legalEntityId === undefined) {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadHandlerExecutionError({
                        code: 'read_handler_execution_failed',
                        reason: 'The read result permission targets are invalid',
                      }),
                    ),
                  );
                }
                const resultPermissionExit = yield* Effect.exit(
                  contextAccess.resources({
                    legalEntityId: scope.legalEntityId,
                    principalId: scope.principalId,
                    resources: resultTargets,
                    tenantId: scope.tenantId,
                  }),
                );
                if (Exit.isFailure(resultPermissionExit)) {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionUnavailable({
                        code: 'read_permission_unavailable',
                        reason: 'Read result authorization is temporarily unavailable',
                      }),
                      resultPermissionExit.cause,
                    ),
                  );
                }
                const decisions = resultPermissionExit.value;
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
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionUnavailable({
                        code: 'read_permission_unavailable',
                        reason: 'Read result authorization is temporarily unavailable',
                      }),
                    ),
                  );
                }
                if (decisions.some(({ decision }) => decision === 'denied')) {
                  return yield* Effect.fail(
                    new ReadTransactionFailure(
                      new ReadPermissionDenied({
                        code: 'read_permission_denied',
                        reason: 'The read result contains a forbidden resource',
                      }),
                    ),
                  );
                }
              }
            }
          }
          const evidence = yield* validateReadEvidenceMetadata(
            input.registration.descriptor.evidencePolicy.captureMode,
            handlerExit.value.evidence,
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
      ).pipe(
        Effect.catchCause((cause) => {
          const failure = Cause.findErrorOption(cause);
          let error: ReadTransactionFailure;
          if (Cause.hasDies(cause) || Cause.hasInterrupts(cause) || failure._tag === 'None') {
            error = new ReadTransactionFailure(
              new ReadHandlerExecutionError({
                code: 'read_handler_execution_failed',
                reason: 'The governed read transaction failed',
              }),
              cause,
            );
          } else if (failure.value instanceof ReadTransactionFailure) {
            error = failure.value;
          } else if (failure.value instanceof CoreTransactionBridgeFailure) {
            error = new ReadTransactionFailure(
              new ReadHandlerExecutionError({
                code: 'read_handler_execution_failed',
                reason: 'The governed read transaction failed',
              }),
              Cause.die(failure.value.original),
            );
          } else {
            error = new ReadTransactionFailure(failure.value);
          }
          const logDefect =
            error.defectCause === undefined
              ? Effect.void
              : Effect.annotateLogs(
                  Effect.logError('Unexpected governed read defect', error.defectCause),
                  {
                    correlationId: scope.correlationId,
                    readKey: input.registration.descriptor.readKey,
                  },
                );
          const persistLateDenial = Schema.is(ReadPermissionDenied)(error.error)
            ? persistReadEvidence(
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
              )
            : Effect.void;
          return logDefect.pipe(
            Effect.andThen(persistLateDenial),
            Effect.andThen(Effect.fail(error.error)),
          );
        }),
      );
      return transactionResult;
    });

  return Object.freeze({ runRead });
};

export type ReadRuntimeService = ReturnType<typeof makeReadRuntime>;

export class ReadRuntime extends Context.Service<ReadRuntime, ReadRuntimeService>()(
  '@app/core-runtime/reads/runtime/ReadRuntime',
) {}

const readRuntimeLayer = Layer.effect(
  ReadRuntime,
  Effect.gen(function* makeReadRuntimeService() {
    const database = yield* CoreDatabase;
    const gateway = yield* ModuleEntrypointGateway;
    const scopeResolver = yield* OperationalScopeResolver;
    const contextAccess = yield* ContextAccess;
    return makeReadRuntime(database, gateway, scopeResolver, contextAccess);
  }),
);

export const makeReadRuntimeLive = (contextAccessLayer: Layer.Layer<ContextAccess>) => {
  const operationalScopeResolverLayer = OperationalScopeResolverLive.pipe(
    Layer.provide(contextAccessLayer),
    Layer.fresh,
  );
  return readRuntimeLayer.pipe(
    Layer.provide(ModuleEntrypointGatewayLive),
    Layer.provide(operationalScopeResolverLayer),
    Layer.provide(contextAccessLayer),
  );
};

export const ReadRuntimeLive = makeReadRuntimeLive(ContextAccessLive);
