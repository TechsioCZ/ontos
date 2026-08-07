/* eslint-disable complexity, max-classes-per-file -- The governed lifecycle and its private rollback signal stay co-located and ordered. */
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayLive,
} from '../modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointGatewayShape } from '../modules/module-entrypoint-gateway.ts';
import { ContextAccess, ContextAccessLive } from '../permissions/context-access.ts';
import type { ContextAccessShape } from '../permissions/context-access.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../operations/context.ts';
import type { OperationalScopeResolverShape } from '../operations/context.ts';
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
import type { ReadRegistration, ResolvedReadPermissionTarget } from './definition.ts';
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

class ReadRollback {
  readonly error: ReadCoreError;
  readonly defectCause: Cause.Cause<unknown> | undefined;

  constructor(error: ReadCoreError, defectCause?: Cause.Cause<unknown>) {
    this.error = error;
    this.defectCause = defectCause;
  }
}

const unwrapCore = <Value>(exit: Exit.Exit<Value, ReadCoreError>): Value => {
  if (Exit.isFailure(exit)) {
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
      throw new ReadRollback(
        new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The governed read was interrupted unexpectedly',
        }),
        exit.cause,
      );
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === 'Some') {
      throw new ReadRollback(failure.value);
    }
    throw new ReadRollback(
      new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The governed read transaction was interrupted',
      }),
      exit.cause,
    );
  }
  return exit.value;
};

const stableTargetKey = (value: string): boolean => value.length > 0 && value.length <= 300;
const targetIsValid = (
  declared: 'legal_entity' | 'module' | 'resource',
  target: ResolvedReadPermissionTarget,
): boolean =>
  target.kind === declared &&
  (target.kind === 'legal_entity' ||
    (target.kind === 'module'
      ? stableTargetKey(target.moduleId)
      : stableTargetKey(target.resource.moduleId) &&
        stableTargetKey(target.resource.resourceId) &&
        stableTargetKey(target.resource.resourceType)));

const targetMetadata = (target: ResolvedReadPermissionTarget) => {
  if (target.kind === 'legal_entity') {
    return {};
  }
  if (target.kind === 'module') {
    return { targetModuleKey: target.moduleId };
  }
  return {
    targetModuleKey: target.resource.moduleId,
    targetResourceId: target.resource.resourceId,
    targetResourceType: target.resource.resourceType,
  };
};

export const makeReadRuntime = (
  database: Context.Service.Shape<typeof CoreDatabase>,
  gateway: ModuleEntrypointGatewayShape,
  scopeResolver: OperationalScopeResolverShape,
  contextAccess: ContextAccessShape,
  options: ReadRuntimeOptions = {},
) => {
  const stage = (value: ReadRuntimeStage): void => options.onStage?.(value);

  const runRead = <
    InputSchema extends Schema.ConstraintDecoder<unknown, never>,
    ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
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
      const requirements = yield* Effect.context<Requirements>();
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
      const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
        input.principal,
      ).pipe(
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
        scopeResolver.resolve({
          correlationId: transport.correlationId,
          legalEntityScope: input.registration.descriptor.legalEntityScope,
          principal,
          ...(transport.traceId === undefined ? {} : { traceId: transport.traceId }),
        }),
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
      if (!targetIsValid(input.registration.descriptor.permissionTarget, permissionTarget)) {
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

      let permissionDecision: 'allowed' | 'denied' | 'unavailable' = 'unavailable';
      if (scope.legalEntityId !== undefined) {
        if (permissionTarget.kind === 'legal_entity') {
          permissionDecision =
            (yield* contextAccess.legalEntities({
              legalEntityIds: [scope.legalEntityId],
              principalId: scope.principalId,
              tenantId: scope.tenantId,
            }))[0]?.decision ?? 'unavailable';
        } else if (permissionTarget.kind === 'module') {
          permissionDecision =
            (yield* contextAccess.modules({
              legalEntityId: scope.legalEntityId,
              moduleIds: [permissionTarget.moduleId],
              principalId: scope.principalId,
              tenantId: scope.tenantId,
            }))[0]?.decision ?? 'unavailable';
        } else {
          permissionDecision =
            (yield* contextAccess.resources({
              legalEntityId: scope.legalEntityId,
              principalId: scope.principalId,
              resources: [
                {
                  moduleId: permissionTarget.resource.moduleId,
                  resourceId: permissionTarget.resource.resourceId,
                  resourceType: permissionTarget.resource.resourceType,
                },
              ],
              tenantId: scope.tenantId,
            }))[0]?.decision ?? 'unavailable';
        }
      } else if (input.registration.descriptor.legalEntityScope === 'forbidden') {
        permissionDecision = 'allowed';
      }
      stage('permission_checked');
      if (permissionDecision === 'denied') {
        yield* persistReadEvidence(database.executor, {
          accessKind: input.registration.descriptor.accessKind,
          captureMode: input.registration.descriptor.evidencePolicy.captureMode,
          outcome: 'denied',
          outcomeCode: 'spicedb_permission_denied',
          outcomeStage: 'authz',
          policyKey: input.registration.descriptor.evidencePolicy.policyKey,
          ...(queryHash === undefined ? {} : { queryHash }),
          readKey: input.registration.descriptor.readKey,
          resultCount: 0,
          scope,
          servingModuleKey: input.registration.descriptor.owningModuleKey,
          ...permissionTargetMetadata,
        });
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
        const policyExit = yield* Effect.exit(
          policy.evaluate({
            action: {
              actionKey: input.registration.descriptor.readKey,
              owningModuleKey: input.registration.descriptor.owningModuleKey,
              schemaVersion: input.registration.descriptor.schemaVersion,
            },
            payload: decodedInput,
            principal: scope,
            target: permissionTargetMetadata,
            transport: {
              correlationId: transport.correlationId,
              ...(transport.traceId === undefined ? {} : { traceId: transport.traceId }),
            },
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
          yield* persistReadEvidence(database.executor, {
            accessKind: input.registration.descriptor.accessKind,
            captureMode: input.registration.descriptor.evidencePolicy.captureMode,
            outcome: 'denied',
            outcomeCode: failure.value.reasonCode,
            outcomeStage: 'policy',
            policyKey: input.registration.descriptor.evidencePolicy.policyKey,
            ...(queryHash === undefined ? {} : { queryHash }),
            readKey: input.registration.descriptor.readKey,
            resultCount: 0,
            scope,
            servingModuleKey: input.registration.descriptor.owningModuleKey,
          });
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

      const transactionResult = yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof ReadRollback
            ? error
            : new ReadRollback(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The governed read transaction failed',
                }),
                Cause.die(error),
              ),
        try: () =>
          database.executor.transaction(async (transaction) => {
            const scoped = unwrapCore(
              await Effect.runPromiseExit(
                installOperationalScope(transaction as CoreTransaction, scope),
              ),
            );
            stage('scope_installed');
            const serviceExit = await Effect.runPromiseExit(
              getReadServiceFactory(input.registration)(scoped, scope).pipe(
                Effect.provide(requirements),
              ),
            );
            if (Exit.isFailure(serviceExit)) {
              const serviceFailure = Cause.findErrorOption(serviceExit.cause);
              if (
                !Cause.hasDies(serviceExit.cause) &&
                !Cause.hasInterrupts(serviceExit.cause) &&
                serviceFailure._tag === 'Some' &&
                Schema.is(OperationContextUnavailable)(serviceFailure.value)
              ) {
                throw new ReadRollback(serviceFailure.value);
              }
              throw new ReadRollback(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The read service factory failed unexpectedly',
                }),
                serviceExit.cause,
              );
            }
            const services = serviceExit.value;
            const handlerExit = await Effect.runPromiseExit(
              getReadHandler(input.registration)(
                decodedInput,
                Object.freeze({ readKey: input.registration.descriptor.readKey, scope, services }),
              ).pipe(Effect.provide(requirements)),
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
                throw new ReadRollback(handlerFailure.value);
              }
              throw new ReadRollback(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The read handler failed unexpectedly',
                }),
                handlerExit.cause,
              );
            }
            stage('handler_executed');
            const result = unwrapCore(
              await Effect.runPromiseExit(
                Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(
                  handlerExit.value.result,
                ).pipe(
                  Effect.mapError(
                    () =>
                      new ReadResultValidationError({
                        code: 'read_result_invalid',
                        reason: 'The read result does not match its declared schema',
                      }),
                  ),
                ),
              ),
            );
            stage('result_decoded');
            const resultPermissionResolver = getReadResultPermissionTargetResolver(
              input.registration,
            );
            if (resultPermissionResolver !== undefined) {
              let resultTargets: readonly {
                readonly moduleId: string;
                readonly resourceId: string;
                readonly resourceType: string;
              }[];
              try {
                resultTargets = resultPermissionResolver(result, scope);
              } catch (error) {
                throw new ReadRollback(
                  new ReadHandlerExecutionError({
                    code: 'read_handler_execution_failed',
                    reason: 'The read result permission targets are invalid',
                  }),
                  Cause.die(error),
                );
              }
              if (
                scope.legalEntityId === undefined ||
                resultTargets.some(
                  (target) =>
                    !stableTargetKey(target.moduleId) ||
                    !stableTargetKey(target.resourceId) ||
                    !stableTargetKey(target.resourceType),
                )
              ) {
                throw new ReadRollback(
                  new ReadHandlerExecutionError({
                    code: 'read_handler_execution_failed',
                    reason: 'The read result permission targets are invalid',
                  }),
                );
              }
              if (resultTargets.length > 0) {
                const resultPermissionExit = await Effect.runPromiseExit(
                  contextAccess.resources({
                    legalEntityId: scope.legalEntityId,
                    principalId: scope.principalId,
                    resources: resultTargets,
                    tenantId: scope.tenantId,
                  }),
                );
                if (Exit.isFailure(resultPermissionExit)) {
                  throw new ReadRollback(
                    new ReadPermissionUnavailable({
                      code: 'read_permission_unavailable',
                      reason: 'Read result authorization is temporarily unavailable',
                    }),
                    resultPermissionExit.cause,
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
                  throw new ReadRollback(
                    new ReadPermissionUnavailable({
                      code: 'read_permission_unavailable',
                      reason: 'Read result authorization is temporarily unavailable',
                    }),
                  );
                }
                if (decisions.some(({ decision }) => decision === 'denied')) {
                  throw new ReadRollback(
                    new ReadPermissionDenied({
                      code: 'read_permission_denied',
                      reason: 'The read result contains a forbidden resource',
                    }),
                  );
                }
              }
            }
            const evidence = unwrapCore(
              await Effect.runPromiseExit(
                validateReadEvidenceMetadata(
                  input.registration.descriptor.evidencePolicy.captureMode,
                  handlerExit.value.evidence,
                ),
              ),
            );
            unwrapCore(
              await Effect.runPromiseExit(
                persistReadEvidence(transaction as CoreTransaction, {
                  accessKind: input.registration.descriptor.accessKind,
                  captureMode: input.registration.descriptor.evidencePolicy.captureMode,
                  outcome: 'allowed',
                  outcomeCode: 'read_allowed',
                  outcomeStage: 'evidence',
                  policyKey: input.registration.descriptor.evidencePolicy.policyKey,
                  ...(queryHash === undefined ? {} : { queryHash }),
                  readKey: input.registration.descriptor.readKey,
                  resultCount: evidence.resultCount,
                  ...(evidence.resultFingerprintHash === undefined
                    ? {}
                    : { resultFingerprintHash: evidence.resultFingerprintHash }),
                  ...(evidence.resultFingerprintSchema === undefined
                    ? {}
                    : {
                        resultFingerprintSchema: evidence.resultFingerprintSchema,
                      }),
                  scope,
                  servingModuleKey: input.registration.descriptor.owningModuleKey,
                  ...permissionTargetMetadata,
                }),
              ),
            );
            stage('evidence_persisted');
            return result;
          }),
      }).pipe(
        Effect.catch((error) => {
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
            ? persistReadEvidence(database.executor, {
                accessKind: input.registration.descriptor.accessKind,
                captureMode: input.registration.descriptor.evidencePolicy.captureMode,
                outcome: 'denied',
                outcomeCode: 'read_permission_denied',
                outcomeStage: 'authz',
                policyKey: input.registration.descriptor.evidencePolicy.policyKey,
                ...(queryHash === undefined ? {} : { queryHash }),
                readKey: input.registration.descriptor.readKey,
                resultCount: 0,
                scope,
                servingModuleKey: input.registration.descriptor.owningModuleKey,
                ...permissionTargetMetadata,
              })
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
    const contextAccess = yield* ContextAccess;
    return makeReadRuntime(
      database,
      gateway,
      makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess),
      contextAccess,
    );
  }),
);

export const makeReadRuntimeLive = (contextAccessLayer: Layer.Layer<ContextAccess>) =>
  readRuntimeLayer.pipe(
    Layer.provide(ModuleEntrypointGatewayLive),
    Layer.provide(contextAccessLayer),
  );

export const ReadRuntimeLive = makeReadRuntimeLive(ContextAccessLive);
